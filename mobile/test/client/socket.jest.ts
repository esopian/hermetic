import { BridgeError } from "../../src/client/errors.ts";
import { BridgeSocket, backoffDelay, type SocketEvents } from "../../src/client/socket.ts";
import { MOBILE_CLOSE_CODES } from "../../src/protocol/constants.ts";
import type { FleetTarget } from "../../src/protocol/types.ts";
import { FakeTimers, flush, socketFactory } from "../helpers/fakes.ts";
import { delta, done, hello } from "../helpers/fixtures.ts";

const target: FleetTarget = { account_id: "123456789012", region: "us-west-2", fleet_id: "fxtr0001" };

function setup(token: string | null = "hmt_FIXTURE") {
  const timers = new FakeTimers();
  const factory = socketFactory();
  const socket = new BridgeSocket({
    url: "ws://127.0.0.1:7877/mobile/v1/ws",
    token: () => token,
    target: () => target,
    createSocket: factory.create,
    timers,
    random: () => 0,
  });
  const events: { [K in keyof SocketEvents]?: SocketEvents[K][] } = {};
  const record = <K extends keyof SocketEvents>(k: K) =>
    socket.on(k, (p) => {
      const list = (events[k] ?? []) as SocketEvents[K][];
      list.push(p);
      (events as Record<string, unknown>)[k] = list;
    });
  for (const k of [
    "state",
    "hello",
    "turn.frame",
    "turn.end",
    "turn.gone",
    "turn.truncated",
    "observe.event",
    "observe.end",
    "notification",
    "listening",
    "auth.error",
  ] as const)
    record(k);
  return { socket, timers, factory, events };
}

/** Connect and complete the auth handshake. */
function authed(s: ReturnType<typeof setup>, over: Parameters<typeof hello>[0] = {}) {
  s.socket.connect();
  const ws = s.factory.current();
  ws.open();
  ws.push({ type: "auth.ok", hello: hello(over) });
  return ws;
}

describe("backoffDelay", () => {
  test("0, 1, 2, 4, 8, 16, then capped at 30 s", () => {
    const none = () => 0;
    expect([1, 2, 3, 4, 5, 6, 7, 12].map((a) => backoffDelay(a, none))).toEqual([
      0, 1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });

  test("jitter adds at most 20% and never passes the cap", () => {
    expect(backoffDelay(3, () => 0.999)).toBe(2399);
    expect(backoffDelay(10, () => 0.999)).toBe(30000);
    expect(backoffDelay(1, () => 0.999)).toBe(0);
  });
});

describe("BridgeSocket — handshake", () => {
  test("sends auth with the token and protocol on open; open after auth.ok", () => {
    const s = setup();
    s.socket.connect();
    const ws = s.factory.current();
    expect(ws.url).toBe("ws://127.0.0.1:7877/mobile/v1/ws");
    expect(s.socket.state).toBe("connecting");
    ws.open();
    expect(s.socket.state).toBe("authenticating");
    expect(ws.last("auth")).toEqual({ type: "auth", token: "hmt_FIXTURE", protocol: 1 });
    ws.push({ type: "auth.ok", hello: hello() });
    expect(s.socket.state).toBe("open");
    expect(s.events.hello).toHaveLength(1);
    expect(s.socket.hello?.fleet.fleet_id).toBe("fxtr0001");
  });

  test("answers ping with pong", () => {
    const s = setup();
    const ws = authed(s);
    ws.push({ type: "ping" });
    expect(ws.sent.at(-1)).toEqual({ type: "pong" });
  });

  test("no token: unauthorized without opening a socket", () => {
    const s = setup(null);
    s.socket.connect();
    expect(s.factory.sockets).toHaveLength(0);
    expect(s.socket.state).toBe("unauthorized");
  });

  test("auth.error UNAUTHORIZED stops reconnecting", () => {
    const s = setup();
    s.socket.connect();
    const ws = s.factory.current();
    ws.open();
    ws.push({ type: "auth.error", error: { code: "UNAUTHORIZED", message: "revoked" } });
    ws.drop(MOBILE_CLOSE_CODES.UNAUTHORIZED);
    expect(s.socket.state).toBe("unauthorized");
    s.timers.advance(60_000);
    expect(s.factory.sockets).toHaveLength(1);
    expect(s.events["auth.error"]?.[0]?.code).toBe("UNAUTHORIZED");
  });

  test("close 4426 is a protocol mismatch and is final", () => {
    const s = setup();
    s.socket.connect();
    s.factory.current().drop(MOBILE_CLOSE_CODES.PROTOCOL_MISMATCH);
    expect(s.socket.state).toBe("mismatch");
    s.timers.advance(60_000);
    expect(s.factory.sockets).toHaveLength(1);
  });
});

describe("BridgeSocket — requests", () => {
  test("rpc correlates by id and carries the fleet target", async () => {
    const s = setup();
    const ws = authed(s);
    const p = s.socket.rpc("chat.swarms", {});
    const frame = ws.last("rpc");
    expect(frame).toMatchObject({ method: "chat.swarms", params: {}, target });
    ws.push({ type: "res", id: frame.id, ok: true, result: { swarms: [] } });
    await expect(p).resolves.toEqual({ swarms: [] });
  });

  test("a refusal rejects with the bridge's code", async () => {
    const s = setup();
    const ws = authed(s);
    const p = s.socket.rpc("agents.destroy", {});
    ws.push({
      type: "res",
      id: ws.last("rpc").id,
      ok: false,
      error: { code: "FORBIDDEN", message: "method not reachable from a phone" },
    });
    await expect(p).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("a request made while connecting waits for auth.ok, then goes", async () => {
    const s = setup();
    s.socket.connect();
    const p = s.socket.rpc("chat.listening");
    const ws = s.factory.current();
    ws.open();
    expect(ws.sent.map((f) => f.type)).toEqual(["auth"]);
    ws.push({ type: "auth.ok", hello: hello() });
    const frame = ws.last("rpc");
    ws.push({ type: "res", id: frame.id, ok: true, result: { instances: ["atlas"] } });
    await expect(p).resolves.toEqual({ instances: ["atlas"] });
  });

  test("a request on the wire when the socket drops fails DISCONNECTED and is never re-sent", async () => {
    const s = setup();
    const ws = authed(s);
    const p = s.socket.startTurn({ instance: "atlas", bot: "scribe", message: "hi" });
    ws.drop();
    await expect(p).rejects.toMatchObject({ code: "DISCONNECTED" });
    s.timers.advance(0);
    const ws2 = s.factory.current();
    ws2.open();
    ws2.push({ type: "auth.ok", hello: hello() });
    expect(ws2.sent.some((f) => f.type === "turn.start")).toBe(false);
  });

  test("a request times out", async () => {
    const s = setup();
    authed(s);
    const p = s.socket.rpc("chat.swarms");
    s.timers.advance(30_000);
    await expect(p).rejects.toBeInstanceOf(BridgeError);
    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  test("a request while stopped fails at once", async () => {
    const s = setup();
    await expect(s.socket.rpc("chat.swarms")).rejects.toMatchObject({ code: "DISCONNECTED" });
  });
});

describe("BridgeSocket — turns and resume", () => {
  test("turn.start tracks the turn; frames advance n; replayed n is dropped", async () => {
    const s = setup();
    const ws = authed(s);
    const p = s.socket.startTurn({ instance: "atlas", bot: "scribe", message: "hi" });
    ws.push({ type: "res", id: ws.last("turn.start").id, ok: true, result: { turn_id: "T1" } });
    await p;
    ws.push({ type: "turn.frame", turn_id: "T1", n: 1, frame: delta(0, "a") });
    ws.push({ type: "turn.frame", turn_id: "T1", n: 2, frame: delta(1, "b") });
    ws.push({ type: "turn.frame", turn_id: "T1", n: 2, frame: delta(1, "b") });
    expect(s.events["turn.frame"]?.map((e) => e.n)).toEqual([1, 2]);
    expect(s.socket.trackedTurns()).toEqual([{ turn_id: "T1", after: 2, ended: false }]);
  });

  test("reconnect resumes every unfinished turn from its last n, with backoff", async () => {
    const s = setup();
    const ws = authed(s);
    const p = s.socket.startTurn({ instance: "atlas", bot: "scribe", message: "hi" });
    ws.push({ type: "res", id: ws.last("turn.start").id, ok: true, result: { turn_id: "T1" } });
    await p;
    ws.push({ type: "turn.frame", turn_id: "T1", n: 1, frame: delta(0, "a") });
    ws.push({ type: "turn.frame", turn_id: "T1", n: 2, frame: delta(1, "b") });

    ws.drop();
    expect(s.socket.state).toBe("reconnecting");
    s.timers.advance(0); // attempt 1 is immediate
    const ws2 = s.factory.current();
    ws2.drop();
    s.timers.advance(999);
    expect(s.factory.sockets).toHaveLength(2); // attempt 2 waits 1 s
    s.timers.advance(1);
    expect(s.factory.sockets).toHaveLength(3);
    const ws3 = s.factory.current();
    ws3.open();
    expect(ws3.last("auth").resume).toEqual({ turns: [{ turn_id: "T1", after: 2 }] });
    ws3.push({
      type: "auth.ok",
      hello: hello({
        active_turns: [
          {
            turn_id: "T1",
            instance: "atlas",
            bot: "scribe",
            session: null,
            started_at: "2026-10-13T10:00:00.000Z",
            state: "running",
            last_n: 4,
            truncated: false,
            device_id: "dev1",
          },
        ],
      }),
    });
    // The replay overlaps what was already seen: n=2 is dropped, 3 and 4 delivered.
    ws3.push({ type: "turn.frame", turn_id: "T1", n: 2, frame: delta(1, "b") });
    ws3.push({ type: "turn.frame", turn_id: "T1", n: 3, frame: delta(2, "c") });
    ws3.push({ type: "turn.frame", turn_id: "T1", n: 4, frame: done(3) });
    ws3.push({ type: "turn.end", turn_id: "T1", n: 4, state: "done" });
    expect(s.events["turn.frame"]?.map((e) => e.n)).toEqual([1, 2, 3, 4]);
    expect(s.events["turn.end"]).toEqual([{ turn_id: "T1", n: 4, state: "done" }]);
    // A finished turn is not resumed again.
    ws3.drop();
    s.timers.advance(0);
    const ws4 = s.factory.current();
    ws4.open();
    expect(ws4.last("auth").resume).toBeUndefined();
  });

  test("a tracked turn missing from hello.active_turns is gone", async () => {
    const s = setup();
    const ws = authed(s);
    const p = s.socket.startTurn({ instance: "atlas", bot: "scribe", message: "hi" });
    ws.push({ type: "res", id: ws.last("turn.start").id, ok: true, result: { turn_id: "T9" } });
    await p;
    ws.drop();
    s.timers.advance(0);
    const ws2 = s.factory.current();
    ws2.open();
    ws2.push({ type: "auth.ok", hello: hello({ active_turns: [] }) });
    expect(s.events["turn.gone"]).toEqual([{ turn_id: "T9" }]);
    expect(s.socket.trackedTurns()).toEqual([]);
  });

  test("a batched resume answered TURN_GONE under resume:<id> is gone, once", async () => {
    const s = setup();
    const ws = authed(s);
    const p = s.socket.startTurn({ instance: "atlas", bot: "scribe", message: "hi" });
    ws.push({ type: "res", id: ws.last("turn.start").id, ok: true, result: { turn_id: "T5" } });
    await p;
    ws.drop();
    s.timers.advance(0);
    const ws2 = s.factory.current();
    ws2.open();
    const listed = {
      turn_id: "T5",
      instance: "atlas",
      bot: "scribe",
      session: null,
      started_at: "2026-10-13T10:00:00.000Z",
      state: "running" as const,
      last_n: 0,
      truncated: false,
      device_id: "dev1",
    };
    ws2.push({ type: "auth.ok", hello: hello({ active_turns: [listed] }) });
    const gone = { code: "TURN_GONE", message: "that turn is no longer held" };
    ws2.push({ type: "res", id: "resume:T5", ok: false, error: gone });
    ws2.push({ type: "res", id: "resume:T5", ok: false, error: gone });
    expect(s.events["turn.gone"]).toEqual([{ turn_id: "T5" }]);
  });

  test("turn.resume TURN_GONE fires turn.gone", async () => {
    const s = setup();
    const ws = authed(s);
    const p = s.socket.resumeTurn("OLD", 3);
    const frame = ws.last("turn.resume");
    expect(frame.after).toBe(3);
    ws.push({ type: "res", id: frame.id, ok: false, error: { code: "TURN_GONE", message: "expired" } });
    await expect(p).rejects.toMatchObject({ code: "TURN_GONE" });
    expect(s.events["turn.gone"]).toEqual([{ turn_id: "OLD" }]);
  });

  test("a truncated resume is reported", async () => {
    const s = setup();
    const ws = authed(s);
    const p = s.socket.resumeTurn("T2", 0);
    ws.push({
      type: "res",
      id: ws.last("turn.resume").id,
      ok: true,
      result: { turn_id: "T2", state: "running", last_n: 30000, truncated: true },
    });
    await p;
    expect(s.events["turn.truncated"]).toEqual([{ turn_id: "T2" }]);
  });

  test("silence past the watchdog drops and reconnects", () => {
    const s = setup();
    authed(s);
    s.timers.advance(44_999);
    expect(s.socket.state).toBe("open");
    s.timers.advance(1); // dropped, and attempt 1 is immediate
    expect(s.factory.sockets[0]!.closedWith?.code).toBe(4000);
    expect(s.factory.sockets).toHaveLength(2);
    expect(s.socket.state).toBe("connecting");
  });

  test("close() stops without reconnecting and keeps turns for the next connect", async () => {
    const s = setup();
    const ws = authed(s);
    const p = s.socket.startTurn({ instance: "atlas", bot: "scribe", message: "hi" });
    ws.push({ type: "res", id: ws.last("turn.start").id, ok: true, result: { turn_id: "T1" } });
    await p;
    ws.push({ type: "turn.frame", turn_id: "T1", n: 1, frame: delta(0, "a") });
    s.socket.close();
    expect(s.socket.state).toBe("idle");
    s.timers.advance(60_000);
    expect(s.factory.sockets).toHaveLength(1);
    s.socket.connect();
    s.factory.current().open();
    expect(s.factory.current().last("auth").resume).toEqual({ turns: [{ turn_id: "T1", after: 1 }] });
  });
});

describe("BridgeSocket — observations", () => {
  test("observe opens on auth, routes events by sub_id, and re-opens after a reconnect", async () => {
    const s = setup();
    const id = s.socket.observe("atlas", "scribe", null);
    const ws = authed(s);
    const open = ws.last("observe.open");
    expect(open).toMatchObject({ instance: "atlas", bot: "scribe", session: null, target });
    ws.push({ type: "res", id: open.id, ok: true, result: { sub_id: "S1" } });
    await flush();
    ws.push({
      type: "observe.event",
      sub_id: "S1",
      event: { type: "error", instance: "atlas", bot: "scribe", code: "X", message: "y" },
    });
    expect(s.events["observe.event"]?.[0]).toMatchObject({ observation: id, sub_id: "S1" });

    ws.drop();
    s.timers.advance(0);
    const ws2 = s.factory.current();
    ws2.open();
    ws2.push({ type: "auth.ok", hello: hello() });
    expect(ws2.last("observe.open")).toMatchObject({ instance: "atlas", bot: "scribe" });
  });

  test("observe.end with an error re-opens with backoff", async () => {
    const s = setup();
    s.socket.observe("atlas", "scribe");
    const ws = authed(s);
    ws.push({ type: "res", id: ws.last("observe.open").id, ok: true, result: { sub_id: "S1" } });
    await flush();
    const before = ws.sent.filter((f) => f.type === "observe.open").length;
    ws.push({ type: "observe.end", sub_id: "S1", error: { code: "UPSTREAM", message: "gone" } });
    expect(s.events["observe.end"]?.[0]?.error?.code).toBe("UPSTREAM");
    s.timers.advance(999);
    expect(ws.sent.filter((f) => f.type === "observe.open").length).toBe(before);
    s.timers.advance(1);
    expect(ws.sent.filter((f) => f.type === "observe.open").length).toBe(before + 1);
  });

  test("unobserve sends observe.close", async () => {
    const s = setup();
    const id = s.socket.observe("atlas", "scribe");
    const ws = authed(s);
    ws.push({ type: "res", id: ws.last("observe.open").id, ok: true, result: { sub_id: "S1" } });
    await flush();
    s.socket.unobserve(id);
    expect(ws.last("observe.close").sub_id).toBe("S1");
  });
});

describe("BridgeSocket — push frames", () => {
  test("notification and listening frames are emitted", () => {
    const s = setup();
    const ws = authed(s);
    ws.push({ type: "listening", instances: ["atlas", "kestrel"] });
    expect(s.events.listening).toEqual([{ instances: ["atlas", "kestrel"] }]);
  });
});

/** A started turn `T1`, with frames 1..`upTo` already seen. */
async function following(s: ReturnType<typeof setup>, upTo = 2) {
  const ws = authed(s);
  const p = s.socket.startTurn({ instance: "atlas", bot: "scribe", message: "hi" });
  ws.push({ type: "res", id: ws.last("turn.start").id, ok: true, result: { turn_id: "T1" } });
  await p;
  for (let n = 1; n <= upTo; n++)
    ws.push({ type: "turn.frame", turn_id: "T1", n, frame: delta(n - 1, "x") });
  return ws;
}

describe("BridgeSocket — frame gaps", () => {
  test("a skipped frame asks turn.resume once, holds the gap, and the replay fills it in order", async () => {
    const s = setup();
    const ws = await following(s, 2);
    ws.push({ type: "turn.frame", turn_id: "T1", n: 5, frame: delta(4, "e") });
    ws.push({ type: "turn.frame", turn_id: "T1", n: 6, frame: delta(5, "f") });
    const resumes = ws.sent.filter((f) => f.type === "turn.resume");
    expect(resumes).toEqual([{ type: "turn.resume", id: expect.any(String), turn_id: "T1", after: 2 }]);
    expect(s.events["turn.frame"]?.map((e) => e.n)).toEqual([1, 2]);

    ws.push({
      type: "res",
      id: resumes[0]!.id,
      ok: true,
      result: { turn_id: "T1", state: "running", last_n: 6, truncated: false },
    });
    for (const n of [3, 4, 5, 6])
      ws.push({ type: "turn.frame", turn_id: "T1", n, frame: delta(n - 1, "r") });
    await flush();
    expect(s.events["turn.frame"]?.map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.socket.trackedTurns()).toEqual([{ turn_id: "T1", after: 6, ended: false }]);

    // A later gap is a new gap: one more resume.
    ws.push({ type: "turn.frame", turn_id: "T1", n: 9, frame: delta(8, "i") });
    expect(
      ws.sent.filter((f) => f.type === "turn.resume").map((f) => (f as { after: number }).after),
    ).toEqual([2, 6]);
  });

  test("a turn.end past the last frame seen waits for the replay", async () => {
    const s = setup();
    const ws = await following(s, 1);
    ws.push({ type: "turn.end", turn_id: "T1", n: 3, state: "done" });
    expect(s.events["turn.end"]).toBeUndefined();
    const resume = ws.last("turn.resume");
    expect(resume.after).toBe(1);
    ws.push({
      type: "res",
      id: resume.id,
      ok: true,
      result: { turn_id: "T1", state: "done", last_n: 3, truncated: false },
    });
    ws.push({ type: "turn.frame", turn_id: "T1", n: 2, frame: delta(1, "b") });
    ws.push({ type: "turn.frame", turn_id: "T1", n: 3, frame: done(2) });
    ws.push({ type: "turn.end", turn_id: "T1", n: 3, state: "done" });
    expect(s.events["turn.frame"]?.map((e) => e.n)).toEqual([1, 2, 3]);
    expect(s.events["turn.end"]).toEqual([{ turn_id: "T1", n: 3, state: "done" }]);
  });

  test("a truncated replay may jump once, and says so", async () => {
    const s = setup();
    const ws = await following(s, 1);
    ws.push({ type: "turn.frame", turn_id: "T1", n: 50, frame: delta(49, "x") });
    const resume = ws.last("turn.resume");
    ws.push({
      type: "res",
      id: resume.id,
      ok: true,
      result: { turn_id: "T1", state: "running", last_n: 50, truncated: true },
    });
    ws.push({ type: "turn.frame", turn_id: "T1", n: 40, frame: delta(39, "x") });
    ws.push({ type: "turn.frame", turn_id: "T1", n: 41, frame: delta(40, "y") });
    expect(s.events["turn.truncated"]).toEqual([{ turn_id: "T1" }]);
    expect(s.events["turn.frame"]?.map((e) => e.n)).toEqual([1, 40, 41]);
    expect(ws.sent.filter((f) => f.type === "turn.resume")).toHaveLength(1);
  });

  test("a gap resume that finds the turn gone forgets it", async () => {
    const s = setup();
    const ws = await following(s, 1);
    ws.push({ type: "turn.frame", turn_id: "T1", n: 3, frame: delta(2, "c") });
    ws.push({
      type: "res",
      id: ws.last("turn.resume").id,
      ok: false,
      error: { code: "TURN_GONE", message: "that turn is no longer held" },
    });
    await flush();
    expect(s.events["turn.gone"]).toEqual([{ turn_id: "T1" }]);
  });

  test("a socket dropped mid-gap resumes from the last frame seen on the next auth", async () => {
    const s = setup();
    const ws = await following(s, 2);
    ws.push({ type: "turn.frame", turn_id: "T1", n: 4, frame: delta(3, "d") });
    ws.drop(MOBILE_CLOSE_CODES.SLOW_CONSUMER);
    expect(s.socket.state).toBe("reconnecting");
    s.timers.advance(0);
    s.factory.current().open();
    expect(s.factory.current().last("auth").resume).toEqual({ turns: [{ turn_id: "T1", after: 2 }] });
  });
});

describe("BridgeSocket — app phase", () => {
  test("the phase goes out after every auth.ok and on each change while open", () => {
    const s = setup();
    s.socket.setPhase("background");
    const ws = authed(s);
    expect(ws.sent.filter((f) => f.type === "phase")).toEqual([{ type: "phase", phase: "background" }]);
    s.socket.setPhase("background");
    s.socket.setPhase("foreground");
    expect(
      ws.sent.filter((f) => f.type === "phase").map((f) => (f as { phase: string }).phase),
    ).toEqual(["background", "foreground"]);
    ws.drop();
    s.timers.advance(0);
    const ws2 = s.factory.current();
    ws2.open();
    expect(ws2.sent.some((f) => f.type === "phase")).toBe(false); // not before auth.ok
    ws2.push({ type: "auth.ok", hello: hello() });
    expect(ws2.last("phase")).toEqual({ type: "phase", phase: "foreground" });
  });
});

describe("BridgeSocket — bridge unavailable (4503)", () => {
  test("is retried on the normal backoff, keeps its state until auth.ok, and is not revocation", () => {
    const s = setup();
    s.socket.connect();
    const ws = s.factory.current();
    ws.open();
    ws.push({ type: "auth.error", error: { code: "NOT_INITIALIZED", message: "no fleet" } });
    ws.drop(MOBILE_CLOSE_CODES.UNAVAILABLE);
    expect(s.socket.state).toBe("unavailable");
    s.timers.advance(0);
    expect(s.factory.sockets).toHaveLength(2);
    // Still "unavailable" while the next attempt dials, so the banner does not flicker.
    expect(s.socket.state).toBe("unavailable");
    s.factory.current().open();
    expect(s.socket.state).toBe("unavailable");
    s.factory.current().drop(MOBILE_CLOSE_CODES.UNAVAILABLE);
    s.timers.advance(999);
    expect(s.factory.sockets).toHaveLength(2);
    s.timers.advance(1);
    expect(s.factory.sockets).toHaveLength(3);
    const ws3 = s.factory.current();
    ws3.open();
    ws3.push({ type: "auth.ok", hello: hello() });
    expect(s.socket.state).toBe("open");
    expect(s.events.state).not.toContain("unauthorized");
  });

  test("a different drop after 4503 reads as reconnecting again", () => {
    const s = setup();
    s.socket.connect();
    s.factory.current().drop(MOBILE_CLOSE_CODES.UNAVAILABLE);
    expect(s.socket.state).toBe("unavailable");
    s.timers.advance(0);
    s.factory.current().drop(1006);
    expect(s.socket.state).toBe("reconnecting");
  });
});

describe("BridgeSocket — retiring a socket", () => {
  test("close() mid-handshake waits for the open to close it, and nothing it says afterwards counts", () => {
    const s = setup();
    s.socket.connect();
    const ws = s.factory.current();
    s.socket.close();
    expect(ws.closedWith).toBeNull();
    expect(ws.onclose).toBeNull();
    expect(ws.onmessage).toBeNull();
    ws.open();
    expect(ws.closedWith).toEqual({ code: 1000, reason: "client closing" });
    expect(ws.sent).toEqual([]); // no auth on a socket being retired
    expect(s.socket.state).toBe("idle");
  });

  test("a socket that already closed is not closed again", () => {
    const s = setup();
    const ws = authed(s);
    ws.readyState = 3;
    s.socket.close();
    expect(ws.closedWith).toBeNull();
  });
});
