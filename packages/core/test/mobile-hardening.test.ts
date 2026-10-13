/**
 * The bridge's failure paths and limits: what it does when the transport, the
 * store or core misbehaves, when there is no fleet to serve, and when a phone
 * sends more than it should. The socket hub is driven directly with fake
 * sockets where a real one cannot misbehave on cue; everything else runs over
 * loopback against a fixture `Hermetic`, like `mobile-server.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservePool } from "../src/chat/observe-pool.ts";
import { openHermetic } from "../src/index.ts";
import type { Hermetic } from "../src/hermetic.ts";
import type { BridgeCtx } from "../src/mobile/bridge-ctx.ts";
import type { MobileCore } from "../src/mobile/core.ts";
import { MemoryMobileStore, type MobileDeviceRow } from "../src/mobile/device-store.ts";
import { createNotifyLoop } from "../src/mobile/notify-loop.ts";
import { createPairLimiter, issuePairCode, redeemPairCode } from "../src/mobile/pairing.ts";
import { MOBILE_CLOSE_CODES, MOBILE_PROTOCOL, MOBILE_ROUTES } from "../src/mobile/protocol.ts";
import { expoPushSender, memoryPushSender } from "../src/mobile/push.ts";
import { hostAllowed, startMobileBridge, type MobileBridge } from "../src/mobile/server.ts";
import { createTurnRegistry } from "../src/mobile/turns.ts";
import {
  createSocketHub,
  newSocketData,
  type MobileSocket,
  type SocketHub,
  type SocketHubLimits,
} from "../src/mobile/ws.ts";
import type { MobileHello, Notification } from "../src/schema/index.ts";

const TARGET = { account_id: "123456789012", region: "us-east-1", fleet_id: "fxtr0001" };
const CORE_TARGET = { ...TARGET, fleet_name: "main" };

/* ── the hub, with fake sockets ───────────────────────────────────────────── */

function hubCtx(over: Partial<BridgeCtx> = {}): BridgeCtx {
  return {
    core: () => {
      throw new Error("this test has no core");
    },
    store: new MemoryMobileStore(),
    turns: createTurnRegistry({
      open: async () => ({ session: "s" }),
      send: () => (async function* () {})(),
      abort: async () => ({}),
    }),
    pool: { join: () => (async function* () {})() } as unknown as ObservePool,
    push: { notify: async () => {} },
    limiter: createPairLimiter(),
    clock: () => Date.now(),
    app: "cli",
    version: "0.0.0-test",
    fixture: true,
    tailnet: () => null,
    emit: () => {},
    broadcast: () => {},
    isLive: () => false,
    heartbeatMs: 60_000,
    authDeadlineMs: 60_000,
    ...over,
  };
}

interface FakeSocket {
  ws: MobileSocket;
  sent: Array<Record<string, unknown>>;
  closes: number[];
}

/** A socket whose `send` answers what `result` says, and whose close reaches the hub like Bun's. */
function fakeSocket(
  hub: SocketHub,
  source = "100.64.0.9",
  result: () => unknown = () => 1,
): FakeSocket {
  const sent: Array<Record<string, unknown>> = [];
  const closes: number[] = [];
  const ws: MobileSocket = {
    data: newSocketData(source, Date.now()),
    send(text) {
      sent.push(JSON.parse(text) as Record<string, unknown>);
      return result();
    },
    close(code) {
      closes.push(code ?? 1000);
      hub.close(ws);
    },
  };
  return { ws, sent, closes };
}

function mint(
  store: MemoryMobileStore,
  name = "FIXTURE phone",
): { token: string; device: MobileDeviceRow } {
  const { code } = issuePairCode(store, { now: Date.now() });
  return redeemPairCode(
    store,
    { code, device_name: name, platform: "ios" },
    { now: Date.now(), source: "test", limiter: createPairLimiter() },
  );
}

function authFrame(token: string, resume?: Array<{ turn_id: string; after: number }>): string {
  return JSON.stringify({
    type: "auth",
    token,
    protocol: 1,
    ...(resume !== undefined ? { resume: { turns: resume } } : {}),
  });
}

describe("the socket hub under failure", () => {
  test("a frame the transport drops closes the socket 1013; a queued one does not", async () => {
    const hub = createSocketHub(hubCtx());
    const dropped = fakeSocket(hub, "100.64.0.9", () => 0);
    hub.open(dropped.ws);
    await hub.message(dropped.ws, "not json");
    expect(dropped.closes).toEqual([MOBILE_CLOSE_CODES.SLOW_CONSUMER]);

    const queued = fakeSocket(hub, "100.64.0.9", () => -1);
    hub.open(queued.ws);
    await hub.message(queued.ws, "not json");
    expect(queued.closes).toEqual([MOBILE_CLOSE_CODES.BAD_FRAME]);
    expect(hub.size()).toBe(0);
  });

  test("a store that throws closes that socket 1011, and nothing escapes", async () => {
    const store = new MemoryMobileStore();
    const { device } = mint(store);
    const broken = Object.assign(Object.create(store) as MemoryMobileStore, {
      deviceByTokenHash: () => {
        throw new Error("database is locked");
      },
      device: () => {
        throw new Error("database is locked");
      },
    });
    const hub = createSocketHub(hubCtx({ store: broken }));

    const authing = fakeSocket(hub);
    hub.open(authing.ws);
    await hub.message(authing.ws, authFrame("hmt_FIXTURE-whatever"));
    expect(authing.closes).toEqual([MOBILE_CLOSE_CODES.INTERNAL]);

    const live = fakeSocket(hub);
    hub.open(live.ws);
    live.ws.data.device = device;
    expect(() => hub.heartbeat()).not.toThrow();
    expect(live.closes).toEqual([MOBILE_CLOSE_CODES.INTERNAL]);
  });

  test("no fleet to serve is 4503, not 4401: the token is still good", async () => {
    const store = new MemoryMobileStore();
    const { token } = mint(store);
    const core = { target: null } as unknown as MobileCore;
    const hub = createSocketHub(hubCtx({ store, core: () => core }));
    const s = fakeSocket(hub);
    hub.open(s.ws);
    await hub.message(s.ws, authFrame(token));
    expect(s.sent[0]).toMatchObject({ type: "auth.error", error: { code: "NOT_INITIALIZED" } });
    expect(s.closes).toEqual([MOBILE_CLOSE_CODES.UNAVAILABLE]);
  });

  test("a socket that closed while Hello was built is not attached to its resumed turns", async () => {
    const store = new MemoryMobileStore();
    const { token } = mint(store);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const core = {
      target: CORE_TARGET,
      chat: {
        listening: async () => {
          await gate;
          return { instances: [] };
        },
      },
    } as unknown as MobileCore;
    const attached: string[] = [];
    const turns = {
      ...hubCtx().turns,
      list: () => [],
      attach: (turnId: string) => {
        attached.push(turnId);
        return null;
      },
    };
    const hub = createSocketHub(hubCtx({ store, core: () => core, turns }));
    const s = fakeSocket(hub);
    hub.open(s.ws);
    const authing = hub.message(s.ws, authFrame(token, [{ turn_id: "t-1", after: 0 }]));
    await Bun.sleep(5);
    hub.close(s.ws);
    release();
    await authing;
    expect(attached).toEqual([]);
    expect(s.sent.some((f) => f["type"] === "auth.ok")).toBe(false);
  });

  test("an rpc in flight is aborted when its socket closes", async () => {
    let seen: AbortSignal | null = null;
    const core = {
      target: CORE_TARGET,
      chat: {
        swarms: (_input: unknown, opts: { signal: AbortSignal }) => {
          seen = opts.signal;
          return new Promise((resolve) =>
            opts.signal.addEventListener("abort", () => resolve({ swarms: [] }), { once: true }),
          );
        },
      },
    } as unknown as MobileCore;
    const store = new MemoryMobileStore();
    const { device } = mint(store);
    const hub = createSocketHub(hubCtx({ store, core: () => core }));
    const s = fakeSocket(hub);
    hub.open(s.ws);
    s.ws.data.device = device;
    const call = hub.message(
      s.ws,
      JSON.stringify({ type: "rpc", id: "r1", method: "chat.swarms", params: {}, target: TARGET }),
    );
    await Bun.sleep(5);
    expect(s.ws.data.rpcs.size).toBe(1);
    hub.close(s.ws);
    await call;
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    expect(s.ws.data.rpcs.size).toBe(0);
  });

  test("only a foreground socket makes its device live", async () => {
    const store = new MemoryMobileStore();
    const { device } = mint(store);
    const hub = createSocketHub(hubCtx({ store }));
    const phone = fakeSocket(hub);
    hub.open(phone.ws);
    phone.ws.data.device = device;
    expect(hub.isLive(device.device_id)).toBe(true);
    await hub.message(phone.ws, JSON.stringify({ type: "phase", phase: "background" }));
    expect(hub.isLive(device.device_id)).toBe(false);
    // A second socket of the same phone, in the foreground, makes it live again.
    const other = fakeSocket(hub);
    hub.open(other.ws);
    other.ws.data.device = device;
    expect(hub.isLive(device.device_id)).toBe(true);
    hub.close(other.ws);
    await hub.message(phone.ws, JSON.stringify({ type: "phase", phase: "foreground" }));
    expect(hub.isLive(device.device_id)).toBe(true);
    await hub.message(phone.ws, JSON.stringify({ type: "phase", phase: "asleep" }));
    expect(phone.closes).toEqual([MOBILE_CLOSE_CODES.BAD_FRAME]);
    expect(hub.isLive(device.device_id)).toBe(false);
  });

  test("socket caps: per source before auth, and in all", () => {
    const limits: SocketHubLimits = { maxSockets: 3, maxPreAuthPerSource: 2 };
    const hub = createSocketHub(hubCtx(), limits);
    const a1 = fakeSocket(hub, "100.64.0.1");
    const a2 = fakeSocket(hub, "100.64.0.1");
    hub.open(a1.ws);
    hub.open(a2.ws);
    expect(hub.admits("100.64.0.1")).toBe(false);
    expect(hub.admits("100.64.0.2")).toBe(true);
    const a3 = fakeSocket(hub, "100.64.0.1");
    hub.open(a3.ws);
    expect(a3.closes).toEqual([MOBILE_CLOSE_CODES.TOO_MANY_SOCKETS]);
    const b1 = fakeSocket(hub, "100.64.0.2");
    hub.open(b1.ws);
    expect(hub.size()).toBe(3);
    expect(hub.admits("100.64.0.3")).toBe(false);
    hub.closeAll(1001, "done");
  });
});

/* ── the notify loop and the push sender ─────────────────────────────────── */

function row(id: string, at: string): Notification {
  return {
    id,
    at,
    kind: "chat.error",
    title: `row ${id}`,
    muted: false,
    actions: [],
  } as unknown as Notification;
}

describe("the inbox poll", () => {
  test("a row raised in the watermark's own millisecond after a read is still delivered, once", async () => {
    const start = Date.parse("2026-10-13T10:00:00.000Z");
    const T = "2026-10-13T10:00:01.000Z";
    let rows: Notification[] = [];
    const sinces: string[] = [];
    const delivered: string[] = [];
    const loop = createNotifyLoop({
      list: async (since) => {
        sinces.push(since);
        // Core's `since` is strictly newer.
        const fresh = rows.filter((r) => r.at > since);
        return { notifications: [...fresh].reverse(), unread: 0, needs_action: 0 } as never;
      },
      onRow: (r) => delivered.push(r.id),
      clock: () => start,
    });
    rows = [row("a", T)];
    await loop.poll();
    rows = [row("a", T), row("b", T)];
    await loop.poll();
    await loop.poll();
    expect(delivered).toEqual(["a", "b"]);
    expect(sinces.at(-1)).toBe("2026-10-13T10:00:00.999Z");
    loop.stop();
  });
});

describe("the Expo sender", () => {
  test("a push service that never answers is a failed receipt after the timeout", async () => {
    let signalled = false;
    const sender = expoPushSender(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signalled = signal !== undefined && signal !== null;
          signal?.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
        }),
      { timeoutMs: 30 },
    );
    const receipts = await sender([{ to: "ExponentPushToken[FIXTURE]", title: "t", data: {} }]);
    expect(signalled).toBe(true);
    expect(receipts).toEqual([{ status: "error", message: "push service unreachable" }]);
  });
});

/* ── the Host header ─────────────────────────────────────────────────────── */

describe("the Host header", () => {
  test("addresses, short names, tailnet names and the bound host pass; other names do not", () => {
    for (const ok of [
      "127.0.0.1:7877",
      "100.64.0.7:7877",
      "[::1]:7877",
      "localhost:7877",
      "laptop:7877",
      "laptop.tail1234.ts.net:7877",
      "bridge.example.lan:7877",
      null,
    ]) {
      expect({ ok, allowed: hostAllowed(ok, "bridge.example.lan") }).toEqual({ ok, allowed: true });
    }
    for (const bad of ["evil.example.com:7877", "127.0.0.1.nip.io", "ts.net.evil.com:7877"]) {
      expect({ bad, allowed: hostAllowed(bad, "0.0.0.0") }).toEqual({ bad, allowed: false });
    }
  });
});

/* ── a wildcard host ─────────────────────────────────────────────────────── */

describe("a wildcard host", () => {
  test("settings warn about it, and pair advertises an address instead", async () => {
    const h = await openHermetic({
      fixture: true,
      home: mkdtempSync(join(tmpdir(), "hermetic-mobile-wildcard-")),
    });
    const set = await h.mobile.settings({ host: "0.0.0.0" });
    expect(set.host).toBe("0.0.0.0");
    expect(set.warning).toContain("every interface");
    expect((await h.mobile.settings({})).warning).toBeDefined();

    const paired = await h.mobile.pair({});
    expect(paired.host).toBe("127.0.0.1");
    expect(new URL(paired.url).searchParams.get("host")).toBe("127.0.0.1");
    await expect(h.mobile.pair({ host: "::" })).rejects.toMatchObject({ code: "VALIDATION" });

    const cleared = await h.mobile.settings({ host: null });
    expect(cleared).toEqual({ enabled: false, host: null, port: null });
  });
});

/* ── over loopback ───────────────────────────────────────────────────────── */

const HEADER = { [MOBILE_PROTOCOL.VERSION_HEADER]: "1", "content-type": "application/json" };

let hermetic: Hermetic;
let store: MemoryMobileStore;
let bridge: MobileBridge;
let fleetless = false;

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "hermetic-mobile-hardening-"));
  hermetic = await openHermetic({ fixture: true, home });
  store = new MemoryMobileStore();
  bridge = await startMobileBridge({
    core: () => (fleetless ? ({ ...hermetic, target: null } as unknown as MobileCore) : hermetic),
    store,
    push: memoryPushSender(),
    host: "127.0.0.1",
    port: 0,
    app: "cli",
    version: "0.0.0-test",
    fixture: true,
    heartbeatMs: 60_000,
  });
});

afterAll(async () => {
  await bridge.close();
});

async function http(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${bridge.url}${path}`, {
    method,
    headers: {
      ...HEADER,
      ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function pairOver(
  device_name: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { code } = issuePairCode(store, { now: Date.now() });
  return await http("POST", MOBILE_ROUTES.pair, { body: { code, device_name, platform: "ios" } });
}

/** One socket: send `auth` (and anything after), collect frames until it closes or `until` matches. */
async function socket(
  frames: Array<Record<string, unknown>>,
  until: (f: Record<string, unknown>) => boolean,
): Promise<{ frames: Array<Record<string, unknown>>; code: number | null; ws: WebSocket }> {
  const ws = new WebSocket(`${bridge.url.replace("http", "ws")}${MOBILE_ROUTES.ws}`);
  const seen: Array<Record<string, unknown>> = [];
  let code: number | null = null;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no match; saw ${JSON.stringify(seen)}`)), 5_000);
    ws.addEventListener("open", () => {
      for (const f of frames) ws.send(JSON.stringify(f));
    });
    ws.addEventListener("message", (e) => {
      const f = JSON.parse(String(e.data)) as Record<string, unknown>;
      seen.push(f);
      if (until(f)) {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.addEventListener("close", (e) => {
      code = e.code;
      clearTimeout(timer);
      resolve();
    });
  });
  return { frames: seen, code, ws };
}

describe("the bridge over loopback", () => {
  test("a request naming some other host is refused before any route", async () => {
    const res = await fetch(`${bridge.url}${MOBILE_ROUTES.health}`, {
      headers: { ...HEADER, host: "rebound.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("no fleet: pair refuses 503 without spending the code, and a socket closes 4503", async () => {
    const paired = await pairOver("FIXTURE phone before");
    expect(paired.status).toBe(200);
    const token = paired.body["token"] as string;

    fleetless = true;
    try {
      const { code } = issuePairCode(store, { now: Date.now() });
      const body = { code, device_name: "FIXTURE phone later", platform: "ios" };
      const refused = await http("POST", MOBILE_ROUTES.pair, { body });
      expect(refused.status).toBe(503);
      expect(refused.body["code"]).toBe("NOT_INITIALIZED");

      const ws = await socket([{ type: "auth", token, protocol: 1 }], () => false);
      expect(ws.code).toBe(MOBILE_CLOSE_CODES.UNAVAILABLE);

      fleetless = false;
      // The same code still redeems once the bridge has a fleet again.
      expect((await http("POST", MOBILE_ROUTES.pair, { body })).status).toBe(200);
    } finally {
      fleetless = false;
    }
  });

  test("a device name is trimmed, and control or bidi characters are refused", async () => {
    const ok = await pairOver("  FIXTURE phone E  ");
    expect(ok.status).toBe(200);
    expect(store.device(ok.body["device_id"] as string)?.name).toBe("FIXTURE phone E");
    for (const name of ["FIXTURE‮enohp", "FIXTURE\u0007phone", "FIXTURE⁦phone", "   "]) {
      const refused = await pairOver(name);
      expect({ name, status: refused.status }).toEqual({ name, status: 400 });
      expect(refused.body["code"]).toBe("VALIDATION");
    }
  });

  test("config.show is off the list, chat.settings is read-only, agents.get takes {name}", async () => {
    const paired = await pairOver("FIXTURE phone F");
    const token = paired.body["token"] as string;
    const rpc = (method: string, params: unknown) =>
      http("POST", MOBILE_ROUTES.rpc, {
        token,
        body: { method, params, target: TARGET_OF(paired.body["hello"] as MobileHello) },
      });

    expect((await rpc("config.show", {})).status).toBe(403);

    const before = await hermetic.chat.settings({});
    const flipped = await rpc("chat.settings", {
      redact: !(before as { redact: boolean }).redact,
    });
    expect(flipped.status).toBe(200);
    expect(flipped.body["result"]).toEqual(before);
    expect(await hermetic.chat.settings({})).toEqual(before);

    const agent = await rpc("agents.get", { name: "atlas" });
    expect(agent.status).toBe(200);
    expect((agent.body["result"] as { name: string }).name).toBe("atlas");
    expect((await rpc("agents.get", {})).status).toBe(400);
  });

  test("a phone-started turn knows its session from the start", async () => {
    const paired = await pairOver("FIXTURE phone G");
    const token = paired.body["token"] as string;
    const target = TARGET_OF(paired.body["hello"] as MobileHello);
    const listened = await http("POST", MOBILE_ROUTES.rpc, {
      token,
      body: { method: "chat.listen", params: { instance: "atlas", listening: true }, target },
    });
    expect(listened.status).toBe(200);
    const canonical = await hermetic.chat.open({ instance: "atlas", bot: "default" });

    const s = await socket(
      [
        { type: "auth", token, protocol: 1 },
        {
          type: "turn.start",
          id: "t-1",
          target,
          turn: { instance: "atlas", bot: "default", message: "hello from the phone" },
        },
      ],
      (f) => f["type"] === "turn.started",
    );
    const started = s.frames.find((f) => f["type"] === "turn.started") as
      | { turn: { session: string | null } }
      | undefined;
    expect(started?.turn.session).toBe(canonical.session);
    s.ws.close();
  });
});

function TARGET_OF(hello: MobileHello): { account_id: string; region: string; fleet_id: string } {
  return {
    account_id: hello.fleet.account_id,
    region: hello.fleet.region,
    fleet_id: hello.fleet.fleet_id,
  };
}
