/**
 * The `mobile.*` namespace (§9): pair a phone, list and revoke paired phones,
 * read and change the bridge settings, and serve the bridge.
 *
 * `pair`, `devices`, `revoke` and `settings` are reads and writes of this
 * laptop's own SQLite — no AWS — so they answer whether or not a bridge is
 * running, and from either head. `serve` starts the bridge (`server.ts`) and
 * streams `OpEvent`s until its signal aborts; it is a server, not an op, so it
 * is not in `STREAMING_METHODS` and leaves no run record.
 *
 * The desktop head hosts the bridge without iterating a generator: it reaches
 * `mobileBridgeHost(hermetic)` — a side door, like `terminalNotices`, because
 * it is not a command and has no place on the surface the parity test walks.
 */
import { HermeticError } from "../errors.ts";
import { evt } from "../events.ts";
import {
  MobileDevicesInput,
  MobilePairInput,
  MobileRevokeInput,
  MobileServeInput,
  MobileSettingsInput,
} from "../schema/index.ts";
import type {
  MobileDevicesResult,
  MobilePairResult,
  MobileRevokeResult,
  MobileSettings,
  MobileSettingsResult,
  OpEvent,
  TailscalePreflight,
} from "../schema/index.ts";
import type { ZodType } from "zod";
import type { MobileCore } from "./core.ts";
import { deviceView, type MobileStore } from "./device-store.ts";
import { issuePairCode } from "./pairing.ts";
import { MOBILE_PROTOCOL } from "./protocol.ts";
import { memoryPushSender, expoPushSender, type PushSender } from "./push.ts";
import { expoReceiptFetcher, type ReceiptFetcher } from "./push-receipts.ts";
import { startMobileBridge, type MobileBridge, type MobileBridgeEvent } from "./server.ts";

export { MOBILE_PROTOCOL } from "./protocol.ts";
export { startMobileBridge, bridgeUrl } from "./server.ts";
export type { MobileBridge, MobileBridgeEvent, StartMobileBridgeOptions } from "./server.ts";

export interface MobileDeps {
  store: MobileStore;
  core: () => MobileCore;
  fixture: boolean;
  version: string;
  /** The §4.7 probe, read for the laptop's Tailscale IPv4 (the default host). */
  localTailscale: () => Promise<TailscalePreflight>;
  /** Absent: Expo in real mode, a recording sender in fixture mode. */
  push?: PushSender | undefined;
  /** Absent: Expo's receipts when `push` is absent in real mode, none otherwise. */
  receipts?: ReceiptFetcher | undefined;
  clock?: () => number;
}

export interface MobileHostStart {
  host?: string | undefined;
  port?: number | undefined;
  app: "desktop" | "cli";
  tickSwarms?: boolean | undefined;
}

/** What a head that hosts the bridge itself is handed (`mobileBridgeHost`). */
export interface MobileBridgeHost {
  start(opts: MobileHostStart): Promise<MobileBridge>;
  active(): MobileBridge | null;
  settings(): MobileSettings;
}

const LOOPBACK = "127.0.0.1";
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const WILDCARD = new Set(["0.0.0.0", "::", "[::]"]);

/** Is this a bind-every-interface host rather than an address? */
export function isWildcardHost(host: string | null | undefined): boolean {
  return host !== null && host !== undefined && WILDCARD.has(host);
}

/** What `mobile.settings` says about a wildcard host, in every head. */
export const WILDCARD_HOST_WARNING =
  "the bridge binds every interface: anything that can reach this laptop can try a token, " +
  "and pair URLs advertise the Tailscale IPv4 (or 127.0.0.1) instead";

function parse<T>(schema: ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new HermeticError("VALIDATION", `${what} input does not validate: ${issues.join("; ")}`, {
    issues,
  });
}

export function createMobile(deps: MobileDeps) {
  const clock = deps.clock ?? (() => Date.now());
  const push: PushSender =
    deps.push ??
    (deps.fixture ? memoryPushSender() : expoPushSender((input, init) => fetch(input, init)));
  const receipts: ReceiptFetcher | undefined =
    deps.receipts ??
    (deps.push === undefined && !deps.fixture
      ? expoReceiptFetcher((input, init) => fetch(input, init))
      : undefined);
  let active: MobileBridge | null = null;

  /** Settings, then the tailnet IPv4, then loopback. Fixture mode has no tailnet to bind. */
  async function defaultHost(): Promise<string> {
    const configured = deps.store.settings().host;
    if (configured !== null) return configured;
    return await reachableHost();
  }

  /** The tailnet IPv4, else loopback: an address, never a wildcard. */
  async function reachableHost(): Promise<string> {
    if (deps.fixture) return LOOPBACK;
    try {
      const probe = await deps.localTailscale();
      const v4 = probe.addresses.find((a) => IPV4.test(a));
      if (probe.running && v4 !== undefined) return v4;
    } catch {
      /* no tailnet: loopback */
    }
    return LOOPBACK;
  }

  function defaultPort(): number {
    return deps.store.settings().port ?? MOBILE_PROTOCOL.DEFAULT_PORT;
  }

  async function start(opts: MobileHostStart): Promise<MobileBridge> {
    if (active !== null) {
      throw new HermeticError("CONFLICT", "the mobile bridge is already running in this process", {
        url: active.url,
      });
    }
    const host = opts.host ?? (await defaultHost());
    const port = opts.port ?? defaultPort();
    const bridge = await startMobileBridge({
      core: deps.core,
      store: deps.store,
      push,
      ...(receipts !== undefined ? { receipts } : {}),
      host,
      port,
      app: opts.app,
      version: deps.version,
      fixture: deps.fixture,
      tickSwarms: opts.tickSwarms === true,
      clock,
    });
    active = bridge;
    void bridge.closed.then(() => {
      if (active === bridge) active = null;
    });
    return bridge;
  }

  async function pair(input: unknown = {}): Promise<MobilePairResult> {
    const req = parse(MobilePairInput, input, "mobile pair");
    const target = deps.core().target;
    if (target === null) throw new HermeticError("NOT_INITIALIZED", "no fleet to pair a phone with");
    if (isWildcardHost(req.host)) {
      throw new HermeticError(
        "VALIDATION",
        "a wildcard is where a bridge listens, not an address a phone can reach; name an address",
        { host: req.host },
      );
    }
    // A wildcard bind (running, or in settings) is where the bridge listens,
    // not where a phone can reach it: the URL names the tailnet or loopback.
    const running = active !== null && !isWildcardHost(active.host) ? active : null;
    const fallback = await defaultHost();
    const host =
      req.host ?? running?.host ?? (isWildcardHost(fallback) ? await reachableHost() : fallback);
    const port = req.port ?? running?.port ?? defaultPort();
    const issued = issuePairCode(deps.store, { now: clock(), ttlMs: req.ttl_ms, name: req.name });
    const params = new URLSearchParams({
      host,
      port: String(port),
      code: issued.code,
      fleet: target.fleet_id,
      name: target.fleet_name ?? target.fleet_id,
    });
    return {
      code: issued.code,
      expires_at: issued.expires_at,
      url: `${MOBILE_PROTOCOL.PAIR_URL_PREFIX}?${params.toString()}`,
      host,
      port,
    };
  }

  async function devices(input: unknown = {}): Promise<MobileDevicesResult> {
    parse(MobileDevicesInput, input, "mobile devices");
    return {
      devices: deps.store.listDevices().map(deviceView),
      serving: active?.status() ?? null,
    };
  }

  async function revoke(input: unknown): Promise<MobileRevokeResult> {
    const req = parse(MobileRevokeInput, input, "mobile revoke");
    const revoked = deps.store.revoke(req.device_id, new Date(clock()).toISOString());
    if (revoked) active?.dropDevice(req.device_id);
    return { revoked };
  }

  async function settings(input: unknown = {}): Promise<MobileSettingsResult> {
    const req = parse(MobileSettingsInput, input, "mobile settings");
    const patch: Partial<MobileSettings> = {};
    if (req.enabled !== undefined) patch.enabled = req.enabled;
    if (req.host !== undefined) patch.host = req.host;
    if (req.port !== undefined) patch.port = req.port;
    const stored =
      Object.keys(patch).length === 0 ? deps.store.settings() : deps.store.setSettings(patch);
    return isWildcardHost(stored.host) ? { ...stored, warning: WILDCARD_HOST_WARNING } : stored;
  }

  /**
   * Serve until `signal` aborts. Validated before the stream opens, like
   * `chat.send`; a port already taken is a thrown error on the first read.
   */
  function serve(input: unknown = {}, opts: { signal?: AbortSignal } = {}): AsyncIterable<OpEvent> {
    const req = parse(MobileServeInput, input, "mobile serve");
    const at = () => new Date(clock()).toISOString();
    return (async function* () {
      if (opts.signal?.aborted) return;
      const bridge = await start({
        host: req.host,
        port: req.port,
        app: "cli",
        tickSwarms: req.tick_swarms ?? true,
      });
      const queue: MobileBridgeEvent[] = [];
      let wake: (() => void) | null = null;
      const off = bridge.on((event) => {
        queue.push(event);
        wake?.();
      });
      const onAbort = () => void bridge.close("aborted");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        yield evt("listening", 0, `listening on ${bridge.url}`, at(), "info", "start");
        for (;;) {
          while (queue.length > 0) {
            const event = queue.shift() as MobileBridgeEvent;
            yield opEventFor(event, at());
            if (event.type === "stopped") return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      } finally {
        off();
        opts.signal?.removeEventListener("abort", onAbort);
        await bridge.close("ended");
      }
    })();
  }

  const host: MobileBridgeHost = {
    start,
    active: () => active,
    settings: () => deps.store.settings(),
  };

  return { pair, devices, revoke, settings, serve, host };
}

/** A bridge event as an `OpEvent`: ids and outcomes, never a token, a code or text. */
function opEventFor(event: MobileBridgeEvent, at: string): OpEvent {
  switch (event.type) {
    case "listening":
      return evt("listening", 0, `listening on ${event.url}`, at, "info", "start");
    case "paired":
      return evt("paired", 0, `paired device ${event.device_id}`, at, "info");
    case "device":
      return evt("device", 0, `device ${event.device_id} ${event.action}`, at, "info");
    case "stopped":
      return evt("stopped", 1, `bridge stopped (${event.reason})`, at, "info", "done");
  }
}

export type Mobile = ReturnType<typeof createMobile>;

const HOSTS = new WeakMap<object, MobileBridgeHost>();

/** Called once by `createHermetic`. */
export function registerMobileBridgeHost(hermetic: object, host: MobileBridgeHost): void {
  HOSTS.set(hermetic, host);
}

/** The bridge host of one `Hermetic`, for a head that runs the bridge itself. */
export function mobileBridgeHost(hermetic: object): MobileBridgeHost {
  const host = HOSTS.get(hermetic);
  if (host === undefined) throw new HermeticError("UNSUPPORTED", "this instance has no mobile bridge");
  return host;
}
