/**
 * The bridge's WebSocket side: one hub for every phone socket.
 *
 * A socket is nobody until it sends `auth` within `AUTH_DEADLINE_MS`; until
 * then any other frame, or one that does not validate, closes it 4400. After
 * `auth.ok` it may call allowlisted methods (`rpc`), start, resume and abort
 * turns, and open observations. A good token paired for another fleet closes
 * 4403; a bridge that cannot build `Hello` (no fleet, a teardown or the
 * wizard) closes 4503: 4401 is only ever a token the bridge does not honour.
 *
 * A socket also says whether its app is in the foreground (`phase`). Only a
 * foreground socket makes its device "live" for push suppression: a
 * backgrounded app gets both the frame and the push, and dedupes them.
 *
 * Nothing a handler throws reaches the process: a store or core failure
 * outside a request's own error path closes that one socket 1011. A frame the
 * transport would not take closes it 1013, so the phone reconnects and resumes
 * from its last `n` rather than missing a frame silently. A socket the hub
 * closes is torn down at once — no more frames, no turn listeners — without
 * waiting for the transport's `close`.
 *
 * A replay (a resume, or a turn's opening frames) goes out `REPLAY_CHUNK`
 * frames at a time, yielding to the event loop between slices and waiting for
 * the transport to drain when a send reported backpressure, so a 20,000-frame
 * buffer cannot push the socket past Bun's backpressure limit. Live frames that
 * arrive meanwhile are held and sent after it, in order — up to
 * `REPLAY_HELD_MAX`, past which the socket closes 1013 and the phone resumes.
 *
 * Turns outlive sockets (`turns.ts`): a socket only *attaches* to a turn, and
 * closing it detaches. Observations do not: each is a guest of the shared
 * observe pool, ended when its socket goes. Every authenticated socket also
 * gets the bridge-wide frames — `turn.started`, `notification`, `listening`.
 *
 * The hub works against `MobileSocket`, the slice of Bun's `ServerWebSocket`
 * it uses, so nothing here depends on how the socket was accepted.
 */
import { randomUUID } from "node:crypto";
import type { ChatObserveEvent, MobileAppPhase } from "../schema/index.ts";
import { ChatObserveInput, MobileClientFrame } from "../schema/index.ts";
import { HermeticError, isHermeticError } from "../errors.ts";
import {
  type BridgeCtx,
  buildHello,
  guardDeviceFleet,
  guardFleet,
  serving,
  wireError,
} from "./bridge-ctx.ts";
import { forwardRpc } from "./core.ts";
import type { MobileDeviceRow } from "./device-store.ts";
import { verifyToken } from "./pairing.ts";
import { MOBILE_CLOSE_CODES, MOBILE_PROTOCOL } from "./protocol.ts";
import type { TurnAttach, TurnEvent } from "./turns.ts";

export interface SocketData {
  id: string;
  source: string;
  device: MobileDeviceRow | null;
  deadline: ReturnType<typeof setTimeout> | null;
  lastSeen: number;
  /** Observations this socket opened: `sub_id` → its abort. */
  subs: Map<string, AbortController>;
  /** Turns this socket is attached to: `turn_id` → detach. */
  turns: Map<string, () => void>;
  /** In-flight `rpc` calls, aborted when the socket closes. */
  rpcs: Set<AbortController>;
  /** The app's phase as the phone last reported it; foreground from `auth` until told otherwise. */
  phase: MobileAppPhase;
  closed: boolean;
  /** The last send was queued under backpressure and no `drain` has come since. */
  pressured: boolean;
  /** Replays waiting on `drain`; woken by it, or by the socket closing. */
  drainWaiters: Set<() => void>;
}

export interface MobileSocket {
  data: SocketData;
  /** Bun's answer: bytes sent, `-1` queued under backpressure, `0` dropped. */
  send(text: string): unknown;
  close(code?: number, reason?: string): void;
}

export function newSocketData(source: string, now: number): SocketData {
  return {
    id: randomUUID(),
    source,
    device: null,
    deadline: null,
    lastSeen: now,
    subs: new Map(),
    turns: new Map(),
    rpcs: new Set(),
    phase: "foreground",
    closed: false,
    pressured: false,
    drainWaiters: new Set(),
  };
}

export interface SocketHubLimits {
  /** Sockets of any kind, across every source. */
  maxSockets: number;
  /** Not-yet-authenticated sockets from one source address. */
  maxPreAuthPerSource: number;
}

export const DEFAULT_SOCKET_LIMITS: SocketHubLimits = { maxSockets: 64, maxPreAuthPerSource: 8 };

/** Replayed frames sent per slice before the hub yields to the event loop. */
export const REPLAY_CHUNK = 200;
/** The longest a replay waits for a `drain` before sending its next slice anyway. */
export const REPLAY_DRAIN_WAIT_MS = 2_000;
/**
 * Live frames one attachment may hold while its replay is still going out.
 * Past it the socket closes 1013: a phone that cannot keep up resumes from its
 * last `n`, and the bridge does not buffer a second copy of the turn for it.
 */
export const REPLAY_HELD_MAX = 2_000;

export interface SocketHub {
  /** Would one more socket from `source` fit under the caps? */
  admits(source: string): boolean;
  open(ws: MobileSocket): void;
  message(ws: MobileSocket, raw: string | Buffer): Promise<void>;
  close(ws: MobileSocket): void;
  /** The transport's send buffer emptied (Bun's `drain`). */
  drain(ws: MobileSocket): void;
  broadcast(frame: Record<string, unknown>): void;
  /** Does this device have an open socket whose app is in the foreground? */
  isLive(deviceId: string): boolean;
  /** Ping every socket, drop the silent and the revoked. */
  heartbeat(): void;
  /** Close every socket of one device now (a revoke in this process). */
  dropDevice(deviceId: string): void;
  closeAll(code: number, reason: string): void;
  /** Authenticated sockets. */
  connected(): number;
  /** Every socket the transport has not yet reported closed, authenticated or not. */
  size(): number;
}

type ClientFrame = MobileClientFrame;

/** Live frames held while a replay is still going out; `null` once it has. */
interface ReplayGate {
  held: TurnEvent[] | null;
  /** A newer attach to the same turn, or a close, took over. */
  cancelled: boolean;
}

type Attachment = TurnAttach & { gate: ReplayGate };

export function createSocketHub(
  ctx: BridgeCtx,
  limits: SocketHubLimits = DEFAULT_SOCKET_LIMITS,
): SocketHub {
  const sockets = new Set<MobileSocket>();
  /** Torn down by the hub, not yet reported closed by the transport. */
  const closing = new Set<MobileSocket>();

  /**
   * One frame to one socket. A frame the transport dropped (`0`) or refused
   * (a throw) closes the socket 1013: a turn frame lost in silence would leave
   * the phone's `n` with a gap it cannot see, while a reconnect resumes it.
   */
  function send(ws: MobileSocket, frame: Record<string, unknown>): void {
    if (ws.data.closed) return;
    let sent: unknown;
    try {
      sent = ws.send(JSON.stringify(frame));
    } catch {
      sent = 0;
    }
    if (sent === 0) shut(ws, MOBILE_CLOSE_CODES.SLOW_CONSUMER, "send failed");
    else if (sent === -1) ws.data.pressured = true;
  }

  /**
   * Close a socket and tear it down now. The transport's `close` comes later
   * (or, for a fake, at once); until it does the socket is in `closing`, so it
   * still counts in `size()` for a shutdown waiting on its 1001s.
   */
  function shut(ws: MobileSocket, code: number, reason: string): void {
    if (ws.data.closed) return;
    try {
      ws.close(code, reason);
    } catch {
      /* already gone */
    }
    if (ws.data.closed) return;
    teardown(ws);
    closing.add(ws);
  }

  /** Everything `close` does, once: no more frames, no listeners, no work in flight. */
  function teardown(ws: MobileSocket): void {
    if (ws.data.closed) return;
    ws.data.closed = true;
    sockets.delete(ws);
    if (ws.data.deadline !== null) clearTimeout(ws.data.deadline);
    for (const detach of ws.data.turns.values()) detach();
    ws.data.turns.clear();
    for (const controller of ws.data.subs.values()) controller.abort();
    ws.data.subs.clear();
    for (const controller of ws.data.rpcs) controller.abort();
    ws.data.rpcs.clear();
    wakeDrainWaiters(ws);
    const device = ws.data.device;
    if (device !== null) {
      ctx.emit({ type: "device", device_id: device.device_id, action: "disconnected" });
    }
  }

  function protocolError(ws: MobileSocket, message: string): void {
    send(ws, { type: "error", error: { code: "VALIDATION", message } });
    shut(ws, MOBILE_CLOSE_CODES.BAD_FRAME, "bad frame");
  }

  /**
   * Before `auth.ok`, a frame that does not validate or is not `auth` is a bad
   * frame, not a bad token: 4400, so the phone keeps its pairing. 4401 is only
   * ever `verifyToken` refusing.
   */
  function preAuthRefusal(ws: MobileSocket, message: string): void {
    send(ws, { type: "auth.error", error: { code: "VALIDATION", message } });
    shut(ws, MOBILE_CLOSE_CODES.BAD_FRAME, "bad frame");
  }

  function res(ws: MobileSocket, id: string, result: unknown): void {
    send(ws, { type: "res", id, ok: true, result });
  }

  function resError(ws: MobileSocket, id: string, e: unknown): void {
    send(ws, { type: "res", id, ok: false, error: wireError(e).body });
  }

  function turnFrame(ws: MobileSocket, event: TurnEvent): void {
    if (event.type === "frame") {
      send(ws, { type: "turn.frame", turn_id: event.turn_id, n: event.n, frame: event.frame });
      return;
    }
    ws.data.turns.delete(event.turn_id);
    send(ws, { type: "turn.end", turn_id: event.turn_id, n: event.n, state: event.state });
  }

  /**
   * Attach a socket to a turn; the caller sends `res`, then `replay`. Live
   * frames are held until the replay has gone out, so `n` stays in order.
   */
  function attachTurn(ws: MobileSocket, turnId: string, after: number): Attachment | null {
    ws.data.turns.get(turnId)?.();
    const gate: ReplayGate = { held: [], cancelled: false };
    const attached = ctx.turns.attach(turnId, after, (event) => {
      if (gate.held === null) {
        turnFrame(ws, event);
        return;
      }
      gate.held.push(event);
      if (gate.held.length > REPLAY_HELD_MAX) {
        shut(ws, MOBILE_CLOSE_CODES.SLOW_CONSUMER, "replay backlog");
      }
    });
    if (attached === null) return null;
    if (attached.summary.state === "running") {
      ws.data.turns.set(turnId, () => {
        gate.cancelled = true;
        attached.detach();
      });
    } else ws.data.turns.delete(turnId);
    return { ...attached, gate };
  }

  /**
   * Let the transport breathe between slices: wait for `drain` under
   * backpressure, else one tick. A wait that times out forgets the pressure:
   * the next send says afresh whether the transport is still behind, rather
   * than every later slice waiting out the full timeout on a stale flag.
   */
  async function pace(ws: MobileSocket): Promise<void> {
    if (!ws.data.pressured) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: () => void = () => {};
    let timedOut = false;
    await new Promise<void>((resolve) => {
      wake = resolve;
      ws.data.drainWaiters.add(resolve);
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, REPLAY_DRAIN_WAIT_MS);
    });
    clearTimeout(timer);
    ws.data.drainWaiters.delete(wake);
    if (timedOut) ws.data.pressured = false;
  }

  function wakeDrainWaiters(ws: MobileSocket): void {
    for (const wake of [...ws.data.drainWaiters]) wake();
    ws.data.drainWaiters.clear();
  }

  /**
   * The buffered frames, `REPLAY_CHUNK` at a time, then whatever arrived live
   * meanwhile; after that the listener sends straight through. Stops when the
   * socket closes or a newer attach to the same turn replaces this one.
   */
  async function replay(ws: MobileSocket, attached: Attachment): Promise<void> {
    const { gate } = attached;
    const stale = (): boolean => ws.data.closed || gate.cancelled;
    try {
      const events = attached.replay;
      for (let i = 0; i < events.length; i += REPLAY_CHUNK) {
        if (i > 0) await pace(ws);
        if (stale()) return;
        for (const event of events.slice(i, i + REPLAY_CHUNK)) turnFrame(ws, event);
      }
      while (gate.held !== null && gate.held.length > 0) {
        if (stale()) return;
        for (const event of gate.held.splice(0, REPLAY_CHUNK)) turnFrame(ws, event);
        if (gate.held.length > 0) await pace(ws);
      }
    } finally {
      gate.held = null;
    }
  }

  function preAuthFrom(source: string): number {
    let n = 0;
    for (const ws of sockets) if (ws.data.device === null && ws.data.source === source) n++;
    return n;
  }

  function admits(source: string): boolean {
    // A socket still closing holds its transport until the close lands.
    return (
      sockets.size + closing.size < limits.maxSockets &&
      preAuthFrom(source) < limits.maxPreAuthPerSource
    );
  }

  async function onAuth(ws: MobileSocket, frame: Extract<ClientFrame, { type: "auth" }>) {
    if (frame.protocol !== MOBILE_PROTOCOL.PROTOCOL_VERSION) {
      send(ws, {
        type: "auth.error",
        error: { code: "PROTOCOL_MISMATCH", message: "this bridge speaks mobile protocol 1" },
      });
      shut(ws, MOBILE_CLOSE_CODES.PROTOCOL_MISMATCH, "protocol mismatch");
      return;
    }
    // A store that throws here escapes to `message`, which closes the socket 1011.
    const device = verifyToken(ctx.store, frame.token);
    if (device === null) {
      send(ws, {
        type: "auth.error",
        error: { code: "UNAUTHORIZED", message: "unknown or revoked device token" },
      });
      shut(ws, MOBILE_CLOSE_CODES.UNAUTHORIZED, "unauthorized");
      return;
    }
    // A pairing is per fleet: refused before the socket counts as connected.
    try {
      guardDeviceFleet(serving(ctx), device);
    } catch (e) {
      send(ws, { type: "auth.error", error: wireError(e).body });
      if (isHermeticError(e) && e.code === "WRONG_FLEET") {
        shut(ws, MOBILE_CLOSE_CODES.WRONG_FLEET, "wrong fleet");
      } else if (isHermeticError(e) && e.code === "UNAUTHORIZED") {
        shut(ws, MOBILE_CLOSE_CODES.UNAUTHORIZED, "unauthorized");
      } else {
        // No core to ask right now: the token may well be good.
        shut(ws, MOBILE_CLOSE_CODES.UNAVAILABLE, "unavailable");
      }
      return;
    }
    if (ws.data.deadline !== null) clearTimeout(ws.data.deadline);
    ws.data.deadline = null;
    ws.data.device = device;
    ws.data.phase = "foreground";
    ctx.store.touch(device.device_id, new Date(ctx.clock()).toISOString());
    ctx.emit({ type: "device", device_id: device.device_id, action: "connected" });
    let hello: Awaited<ReturnType<typeof buildHello>>;
    try {
      hello = await buildHello(ctx, device);
    } catch (e) {
      // The token is good; the bridge has no fleet to answer for right now.
      send(ws, { type: "auth.error", error: wireError(e).body });
      shut(ws, MOBILE_CLOSE_CODES.UNAVAILABLE, "unavailable");
      return;
    }
    // The socket may have gone while `Hello` was built; attaching a dead one
    // to a turn would leave a listener nobody detaches.
    if (ws.data.closed) return;
    send(ws, { type: "auth.ok", hello });
    for (const resume of frame.resume?.turns ?? []) {
      // A replay above may have outlived the socket.
      if (ws.data.closed) return;
      const attached = attachTurn(ws, resume.turn_id, resume.after);
      if (attached === null) {
        resError(
          ws,
          `resume:${resume.turn_id}`,
          new HermeticError("TURN_GONE", "that turn is no longer held", { turn_id: resume.turn_id }),
        );
        continue;
      }
      await replay(ws, attached);
    }
  }

  function scanForRequests(event: ChatObserveEvent): void {
    if (event.type !== "message") return;
    for (const block of event.message.blocks) {
      if (block.kind !== "approval" && block.kind !== "question") continue;
      void ctx.push.notify({
        kind: "needs_action",
        instance: event.instance,
        bot: event.bot,
        session: event.session,
        block,
      });
    }
  }

  async function runObservation(
    ws: MobileSocket,
    subId: string,
    input: ChatObserveInput,
    controller: AbortController,
  ): Promise<void> {
    let failure: { code: string; message: string } | null = null;
    try {
      for await (const event of ctx.pool.join(input, controller.signal)) {
        if (controller.signal.aborted) break;
        send(ws, { type: "observe.event", sub_id: subId, event });
        scanForRequests(event);
        if (event.type === "error") failure = { code: event.code, message: event.message };
      }
    } catch (e) {
      failure = wireError(e).body;
    } finally {
      ws.data.subs.delete(subId);
      if (!controller.signal.aborted) {
        send(ws, {
          type: "observe.end",
          sub_id: subId,
          ...(failure !== null ? { error: failure } : {}),
        });
      }
    }
  }

  async function onFrame(ws: MobileSocket, device: MobileDeviceRow, frame: ClientFrame) {
    switch (frame.type) {
      case "auth":
        protocolError(ws, "already authenticated");
        return;
      case "pong":
        return;
      case "phase":
        ws.data.phase = frame.phase;
        return;
      case "rpc": {
        const controller = new AbortController();
        ws.data.rpcs.add(controller);
        try {
          const core = serving(ctx);
          guardFleet(core, frame.target);
          const result = await forwardRpc(core, frame.method, frame.params, controller.signal);
          res(ws, frame.id, result);
          if (frame.method === "chat.listen") {
            broadcast({ type: "listening", instances: (result as { instances: string[] }).instances });
          }
        } catch (e) {
          resError(ws, frame.id, e);
        } finally {
          ws.data.rpcs.delete(controller);
        }
        return;
      }
      case "turn.start": {
        let summary: Awaited<ReturnType<typeof ctx.turns.start>>;
        try {
          guardFleet(serving(ctx), frame.target);
          summary = await ctx.turns.start({
            device_id: device.device_id,
            instance: frame.turn.instance,
            bot: frame.turn.bot,
            session: frame.turn.session,
            new_session: frame.turn.new_session,
            message: frame.turn.message,
          });
        } catch (e) {
          resError(ws, frame.id, e);
          return;
        }
        // The turn runs whether or not this socket is still here to see it.
        if (ws.data.closed) {
          broadcast({ type: "turn.started", turn: summary });
          return;
        }
        const attached = attachTurn(ws, summary.turn_id, 0);
        res(ws, frame.id, { turn_id: summary.turn_id });
        if (attached !== null) await replay(ws, attached);
        broadcast({ type: "turn.started", turn: summary });
        return;
      }
      case "turn.resume": {
        const attached = attachTurn(ws, frame.turn_id, frame.after);
        if (attached === null) {
          resError(ws, frame.id, new HermeticError("TURN_GONE", "that turn is no longer held"));
          return;
        }
        res(ws, frame.id, {
          turn_id: frame.turn_id,
          state: attached.summary.state,
          last_n: attached.summary.last_n,
          truncated: attached.truncated,
        });
        await replay(ws, attached);
        return;
      }
      case "turn.abort": {
        const known = ctx.turns.summary(frame.turn_id);
        if (known === null) {
          resError(ws, frame.id, new HermeticError("TURN_GONE", "that turn is no longer held"));
          return;
        }
        try {
          res(ws, frame.id, { aborted: await ctx.turns.abort(frame.turn_id) });
        } catch (e) {
          resError(ws, frame.id, e);
        }
        return;
      }
      case "observe.open": {
        try {
          guardFleet(serving(ctx), frame.target);
          const parsed = ChatObserveInput.safeParse({
            instance: frame.instance,
            bot: frame.bot,
            ...(typeof frame.session === "string" ? { session: frame.session } : {}),
          });
          if (!parsed.success) {
            const issues = parsed.error.issues.map(
              (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
            );
            throw new HermeticError("VALIDATION", "observe.open does not validate", { issues });
          }
          const input = parsed.data;
          const subId = randomUUID();
          const controller = new AbortController();
          ws.data.subs.set(subId, controller);
          res(ws, frame.id, { sub_id: subId });
          void runObservation(ws, subId, input, controller);
        } catch (e) {
          resError(ws, frame.id, e);
        }
        return;
      }
      case "observe.close": {
        const controller = ws.data.subs.get(frame.sub_id);
        ws.data.subs.delete(frame.sub_id);
        controller?.abort();
        res(ws, frame.id, { closed: controller !== undefined });
        return;
      }
    }
  }

  function broadcast(frame: Record<string, unknown>): void {
    for (const ws of sockets) if (ws.data.device !== null) send(ws, frame);
  }

  /**
   * One frame, start to finish. Throws only what a handler did not expect.
   *
   * A frame the transport delivers after the hub has shut the socket (one
   * pipelined behind a refusal, a deadline or a revoke) is dropped unread: it
   * must not authenticate a socket that is already gone, announce a device
   * nobody will see disconnect, or run a call whose answer cannot be sent.
   */
  async function handle(ws: MobileSocket, raw: string | Buffer): Promise<void> {
    if (ws.data.closed) return;
    ws.data.lastSeen = ctx.clock();
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      protocolError(ws, "frame is not JSON");
      return;
    }
    const parsed = MobileClientFrame.safeParse(value);
    if (!parsed.success) {
      if (ws.data.device === null) preAuthRefusal(ws, "frame does not validate");
      else protocolError(ws, "frame does not validate");
      return;
    }
    const frame = parsed.data;
    const device = ws.data.device;
    if (device === null) {
      if (frame.type !== "auth") {
        preAuthRefusal(ws, "authenticate first");
        return;
      }
      await onAuth(ws, frame);
      return;
    }
    await onFrame(ws, device, frame);
  }

  return {
    admits,

    open(ws) {
      // Counted before this socket joins: at the cap, it is the one refused.
      if (!admits(ws.data.source)) {
        shut(ws, MOBILE_CLOSE_CODES.TOO_MANY_SOCKETS, "too many sockets");
        return;
      }
      sockets.add(ws);
      ws.data.deadline = setTimeout(() => {
        if (ws.data.device === null) shut(ws, MOBILE_CLOSE_CODES.AUTH_DEADLINE, "auth deadline");
      }, ctx.authDeadlineMs);
    },

    async message(ws, raw) {
      try {
        await handle(ws, raw);
      } catch {
        // A store or core failure outside a request's own error path: this
        // socket goes, the process and every other socket stay.
        shut(ws, MOBILE_CLOSE_CODES.INTERNAL, "internal error");
      }
    },

    close(ws) {
      closing.delete(ws);
      teardown(ws);
    },

    drain(ws) {
      ws.data.pressured = false;
      wakeDrainWaiters(ws);
    },

    broadcast,

    isLive(deviceId) {
      for (const ws of sockets) {
        if (ws.data.closed || ws.data.phase !== "foreground") continue;
        if (ws.data.device?.device_id === deviceId) return true;
      }
      return false;
    },

    heartbeat() {
      const now = ctx.clock();
      for (const ws of [...sockets]) {
        const device = ws.data.device;
        if (device === null) continue;
        let current: ReturnType<typeof ctx.store.device>;
        try {
          current = ctx.store.device(device.device_id);
        } catch {
          shut(ws, MOBILE_CLOSE_CODES.INTERNAL, "internal error");
          continue;
        }
        if (current === null || current.revoked_at !== null) {
          shut(ws, MOBILE_CLOSE_CODES.UNAUTHORIZED, "revoked");
          continue;
        }
        if (now - ws.data.lastSeen > ctx.heartbeatMs * 2) {
          shut(ws, MOBILE_CLOSE_CODES.GOING_AWAY, "no pong");
          continue;
        }
        send(ws, { type: "ping" });
      }
    },

    dropDevice(deviceId) {
      for (const ws of [...sockets]) {
        if (ws.data.device?.device_id === deviceId)
          shut(ws, MOBILE_CLOSE_CODES.UNAUTHORIZED, "revoked");
      }
    },

    closeAll(code, reason) {
      for (const ws of [...sockets]) shut(ws, code, reason);
    },

    size() {
      return sockets.size + closing.size;
    },

    connected() {
      let n = 0;
      for (const ws of sockets) if (ws.data.device !== null) n++;
      return n;
    },
  };
}
