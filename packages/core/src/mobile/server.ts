/**
 * `startMobileBridge`: one `Bun.serve` with the HTTP routes and the WebSocket
 * hub, the turn registry, a shared observe pool, the inbox poll and the push
 * notifier, started together and stopped together.
 *
 * Bound where it is told. The default host (the laptop's Tailscale IPv4, else
 * loopback) is chosen by the caller (`mobile/index.ts`); nothing here ever
 * picks `0.0.0.0` on its own.
 *
 * Core never logs (§3.2 rule 1): the bridge reports what happens through
 * `MobileBridgeEvent`s, and those never carry a token, a code, a message or a
 * request's params.
 */
import { createObservePool } from "../chat/observe-pool.ts";
import type { ChatBlock, MobileServeStatus } from "../schema/index.ts";
import type { BridgeCtx, MobileBridgeEvent } from "./bridge-ctx.ts";
import { notificationFrame } from "./bridge-ctx.ts";
import type { MobileCore } from "./core.ts";
import type { MobileStore } from "./device-store.ts";
import { handleHttp } from "./http.ts";
import { createNotifyLoop } from "./notify-loop.ts";
import { createPairLimiter } from "./pairing.ts";
import { MOBILE_CLOSE_CODES, MOBILE_PROTOCOL, MOBILE_ROUTES } from "./protocol.ts";
import { createPushNotifier, type PushSender } from "./push.ts";
import { createTurnRegistry } from "./turns.ts";
import {
  DEFAULT_SOCKET_LIMITS,
  type SocketHubLimits,
  createSocketHub,
  newSocketData,
  type SocketData,
} from "./ws.ts";

export type { MobileBridgeEvent } from "./bridge-ctx.ts";

export interface StartMobileBridgeOptions {
  core: () => MobileCore;
  store: MobileStore;
  push: PushSender;
  host: string;
  /** 0 picks a free port; read the bound one off the result. */
  port: number;
  app: "desktop" | "cli";
  version: string;
  fixture: boolean;
  /** Tick `chat.swarms` so core raises `chat.message` rows (a headless bridge). */
  tickSwarms?: boolean;
  clock?: () => number;
  heartbeatMs?: number;
  authDeadlineMs?: number;
  notifyPollMs?: number;
  turnRetentionMs?: number;
  /** Socket caps; default 64 in all and 8 unauthenticated per source address. */
  limits?: Partial<SocketHubLimits>;
}

/** An HTTP connection idle this long is closed. WebSockets keep their own (none: the heartbeat decides). */
export const HTTP_IDLE_TIMEOUT_S = 60;

export interface MobileBridge {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly started_at: string;
  status(): MobileServeStatus;
  on(listener: (event: MobileBridgeEvent) => void): () => void;
  /** One inbox read now, instead of on the next tick. */
  pollNotifications(): Promise<void>;
  /** Close a revoked device's sockets now. */
  dropDevice(deviceId: string): void;
  /** Close every socket (1001), abort running turns, stop listening. Idempotent. */
  close(reason?: string): Promise<void>;
  readonly closed: Promise<void>;
}

/** `http://host:port`, with an IPv6 literal bracketed. */
export function bridgeUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

type ApprovalOrQuestion = Extract<ChatBlock, { kind: "approval" | "question" }>;

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Does a request's `Host` name this bridge? A defence against DNS rebinding,
 * where a page on some other origin resolves its own name to the bridge's
 * address: such a request carries a multi-label name the attacker controls. So
 * an IP literal, `localhost`, a single-label (MagicDNS short) name, any
 * `*.ts.net` name and the bound host pass, and every other dotted name is
 * refused. A missing header (HTTP/1.0) is let through.
 */
export function hostAllowed(header: string | null, bound: string): boolean {
  if (header === null || header === "") return true;
  let name = header.toLowerCase();
  if (name.startsWith("[")) return true; // a bracketed IPv6 literal, port or not
  const colon = name.lastIndexOf(":");
  if (colon !== -1) name = name.slice(0, colon);
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (name === bound.toLowerCase() || name === "localhost") return true;
  if (IPV4_LITERAL.test(name)) return true;
  if (!name.includes(".")) return true;
  return name.endsWith(".ts.net");
}

export async function startMobileBridge(opts: StartMobileBridgeOptions): Promise<MobileBridge> {
  const clock = opts.clock ?? (() => Date.now());
  const listeners = new Set<(event: MobileBridgeEvent) => void>();
  const emit = (event: MobileBridgeEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        /* a listener's failure is its own */
      }
    }
  };

  let tailnet: string | null = null;
  // Hub-bound, assigned below once the hub exists.
  let broadcast: (frame: Record<string, unknown>) => void = () => {};
  let isLive: (deviceId: string) => boolean = () => false;

  const push = createPushNotifier({
    store: opts.store,
    sender: opts.push,
    isLive: (id) => isLive(id),
    fleetId: () => {
      try {
        return opts.core().target?.fleet_id ?? null;
      } catch {
        return null;
      }
    },
  });

  const turns = createTurnRegistry({
    open: (input, o) => opts.core().chat.open(input, o),
    send: (input, o) => opts.core().chat.send(input, o),
    abort: (input) => opts.core().chat.abort(input),
    clock,
    ...(opts.turnRetentionMs !== undefined ? { retentionMs: opts.turnRetentionMs } : {}),
    onFrame: (turn, frame) => {
      if (frame.type !== "block") return;
      if (frame.block.kind !== "approval" && frame.block.kind !== "question") return;
      void push.notify({
        kind: "needs_action",
        instance: turn.instance,
        bot: turn.bot,
        session: turn.session,
        block: frame.block as ApprovalOrQuestion,
      });
    },
    onEnd: (turn, info) => {
      if (turn.state === "done") void push.notify({ kind: "turn.done", turn, reply: info.reply });
      else if (turn.state === "error") {
        void push.notify({ kind: "turn.error", turn, code: info.error?.code ?? "INTERNAL" });
      }
    },
  });

  const pool = createObservePool({
    observe: (input, o) => opts.core().chat.observe(input, o),
  });

  const ctx: BridgeCtx = {
    core: opts.core,
    store: opts.store,
    turns,
    pool,
    push,
    limiter: createPairLimiter(),
    clock,
    app: opts.app,
    version: opts.version,
    fixture: opts.fixture,
    tailnet: () => tailnet,
    emit,
    broadcast: (frame) => broadcast(frame),
    isLive: (id) => isLive(id),
    heartbeatMs: opts.heartbeatMs ?? MOBILE_PROTOCOL.HEARTBEAT_MS,
    authDeadlineMs: opts.authDeadlineMs ?? MOBILE_PROTOCOL.AUTH_DEADLINE_MS,
  };
  const hub = createSocketHub(ctx, { ...DEFAULT_SOCKET_LIMITS, ...opts.limits });
  broadcast = hub.broadcast;
  isLive = hub.isLive;

  const notify = createNotifyLoop({
    list: (since) => opts.core().notifications.list({ since }),
    swarms: opts.tickSwarms === true ? () => opts.core().chat.swarms({}) : undefined,
    onRow: (row, counts) => {
      hub.broadcast(notificationFrame(row, counts));
      void push.notify({ kind: "notification", row });
    },
    clock,
    ...(opts.notifyPollMs !== undefined ? { pollMs: opts.notifyPollMs } : {}),
  });

  const server = Bun.serve<SocketData>({
    hostname: opts.host,
    port: opts.port,
    // HTTP only: a connection that sends nothing for a minute goes. Turns and
    // observations live on the WebSocket, whose own timeout is off below.
    idleTimeout: HTTP_IDLE_TIMEOUT_S,
    // The transport refuses an oversized body before a route reads it.
    maxRequestBodySize: MOBILE_PROTOCOL.MAX_PAYLOAD_BYTES,
    async fetch(req, srv) {
      const source = srv.requestIP(req)?.address ?? "";
      if (!hostAllowed(req.headers.get("host"), opts.host)) {
        return new Response(
          JSON.stringify({ code: "FORBIDDEN", message: "this bridge does not answer to that host" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      const url = new URL(req.url);
      if (url.pathname === MOBILE_ROUTES.ws) {
        if (!hub.admits(source)) {
          return new Response(
            JSON.stringify({ code: "RATE_LIMITED", message: "too many open sockets" }),
            { status: 429, headers: { "content-type": "application/json" } },
          );
        }
        if (srv.upgrade(req, { data: newSocketData(source, clock()) })) return undefined;
        return new Response(
          JSON.stringify({ code: "VALIDATION", message: "expected a WebSocket upgrade" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }
      // A forwarded call (a compaction, a slow history read) may outlast the
      // HTTP idle timeout; only an authenticated one is let off it.
      return await handleHttp(ctx, req, source, () => srv.timeout(req, 0));
    },
    websocket: {
      maxPayloadLength: MOBILE_PROTOCOL.MAX_PAYLOAD_BYTES,
      idleTimeout: 0,
      // A phone that stops reading is closed rather than buffered without end;
      // it reconnects and resumes from its last `n`.
      closeOnBackpressureLimit: true,
      open: (ws) => hub.open(ws),
      message: (ws, raw) => hub.message(ws, raw),
      close: (ws) => hub.close(ws),
      // A replay paced on backpressure resumes here.
      drain: (ws) => hub.drain(ws),
    },
  });

  const port = server.port ?? opts.port;
  const url = bridgeUrl(opts.host, port);
  const started_at = new Date(clock()).toISOString();

  const heartbeat = setInterval(() => {
    try {
      hub.heartbeat();
    } catch {
      /* one bad tick costs a ping, never the process */
    }
  }, ctx.heartbeatMs);
  const sweep = setInterval(() => turns.sweep(), 60_000);
  notify.start();
  // The tailnet names the noVNC host on the phone; read once, never fatal.
  void opts
    .core()
    .config.show()
    .then((c) => {
      tailnet = c.tailnet;
    })
    .catch(() => {});

  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closing: Promise<void> | null = null;

  const bridge: MobileBridge = {
    host: opts.host,
    port,
    url,
    started_at,
    status: () => ({
      host: opts.host,
      port,
      url,
      started_at,
      connected: hub.connected(),
      app: opts.app,
    }),
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pollNotifications: () => notify.poll(),
    dropDevice(deviceId) {
      hub.dropDevice(deviceId);
      emit({ type: "device", device_id: deviceId, action: "revoked" });
    },
    close(reason = "stopped") {
      closing ??= (async () => {
        clearInterval(heartbeat);
        clearInterval(sweep);
        notify.stop();
        // Turns first, sockets second: a `turn.start` the stop refuses, and the
        // `turn.end` of every turn it ends, can still reach a socket that is
        // open. Best effort — a refusal that settles after the sockets close
        // is lost, and the phone's retry is refused the same way.
        await turns.stopAll();
        hub.closeAll(MOBILE_CLOSE_CODES.GOING_AWAY, "bridge shutting down");
        await pool.stop();
        // Let the 1001s reach their sockets before the listener goes.
        const deadline = Date.now() + 1_000;
        while (hub.size() > 0 && Date.now() < deadline) await Bun.sleep(10);
        // Bounded: under Bun 1.3 `stop()` stops listening at once but its
        // promise never settles once the server has closed a socket itself.
        await Promise.race([server.stop(true), Bun.sleep(250)]);
        emit({ type: "stopped", reason });
        listeners.clear();
        resolveClosed();
      })();
      return closing;
    },
    closed,
  };
  // No `listening` event: the caller holds `host`, `port` and `url` the moment
  // this resolves, and an event fired before it could subscribe would be lost.
  return bridge;
}
