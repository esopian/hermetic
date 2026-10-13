/**
 * The mobile bridge end to end, over real loopback sockets against a fixture
 * `Hermetic`: health, pairing, `Hello`, allowlisted `rpc`, a WebSocket turn
 * that parks on an approval, a disconnect mid-turn, the approval answered over
 * HTTP, a resume that replays only what was missed, the refusals (allowlist,
 * token, fleet, protocol), inbox frames, and the pushes a phone without a live
 * socket is sent. Nothing leaves 127.0.0.1.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHermetic } from "../src/index.ts";
import type { Hermetic } from "../src/hermetic.ts";
import { MemoryMobileStore } from "../src/mobile/device-store.ts";
import { issuePairCode } from "../src/mobile/pairing.ts";
import { MOBILE_PROTOCOL, MOBILE_ROUTES } from "../src/mobile/protocol.ts";
import { memoryPushSender, type MemoryPushSender } from "../src/mobile/push.ts";
import { startMobileBridge, type MobileBridge } from "../src/mobile/server.ts";
import type { MobileHello } from "../src/schema/index.ts";

const INSTANCE = "atlas";
const BOT = "default";
const HEADER = { [MOBILE_PROTOCOL.VERSION_HEADER]: "1", "content-type": "application/json" };

let hermetic: Hermetic;
let store: MemoryMobileStore;
let sender: MemoryPushSender;
let bridge: MobileBridge;

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "hermetic-mobile-server-"));
  hermetic = await openHermetic({ fixture: true, home });
  store = new MemoryMobileStore();
  sender = memoryPushSender();
  bridge = await startMobileBridge({
    core: () => hermetic,
    store,
    push: sender,
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
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${bridge.url}${path}`, {
    method,
    headers: {
      ...(opts.headers ?? HEADER),
      ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function pair(name: string): Promise<{ token: string; device_id: string; hello: MobileHello }> {
  const { code } = issuePairCode(store, { now: Date.now() });
  const res = await http("POST", MOBILE_ROUTES.pair, {
    body: { code, device_name: name, platform: "ios" },
  });
  expect(res.status).toBe(200);
  return res.body as unknown as { token: string; device_id: string; hello: MobileHello };
}

type Frame = Record<string, unknown> & { type: string };

/** A phone socket that keeps every frame and can wait for one. */
class Phone {
  readonly frames: Frame[] = [];
  closeCode: number | null = null;
  private readonly ws: WebSocket;
  private readonly opened: Promise<void>;
  private readonly waiters: Array<() => void> = [];
  readonly closed: Promise<number>;

  constructor() {
    this.ws = new WebSocket(`${bridge.url.replace("http", "ws")}${MOBILE_ROUTES.ws}`);
    this.opened = new Promise((resolve) => this.ws.addEventListener("open", () => resolve()));
    this.ws.addEventListener("message", (e) => {
      this.frames.push(JSON.parse(String(e.data)) as Frame);
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = new Promise((resolve) =>
      this.ws.addEventListener("close", (e) => {
        this.closeCode = e.code;
        resolve(e.code);
        for (const w of this.waiters.splice(0)) w();
      }),
    );
  }

  async send(frame: Record<string, unknown>): Promise<void> {
    await this.opened;
    this.ws.send(JSON.stringify(frame));
  }

  async waitFor(pred: (f: Frame) => boolean, ms = 5_000): Promise<Frame> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit !== undefined) return hit;
      if (Date.now() > deadline || this.closeCode !== null) {
        throw new Error(`no matching frame; saw ${this.frames.map((f) => f.type).join(",")}`);
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

async function until(pred: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("the mobile bridge over loopback", () => {
  test("the whole flow", async () => {
    // Health, and the version header every request must carry.
    const health = await http("GET", MOBILE_ROUTES.health);
    expect(health).toEqual({ status: 200, body: { ok: true, protocol: 1, fixture: true } });
    const noHeader = await http("GET", MOBILE_ROUTES.health, { headers: {} });
    expect(noHeader.status).toBe(426);
    expect(noHeader.body["code"]).toBe("PROTOCOL_MISMATCH");

    // Pair; the same code a second time is spent.
    const { code } = issuePairCode(store, { now: Date.now() });
    const paired = await http("POST", MOBILE_ROUTES.pair, {
      body: { code, device_name: "FIXTURE phone A", platform: "ios" },
    });
    expect(paired.status).toBe(200);
    const token = paired.body["token"] as string;
    const hello = paired.body["hello"] as MobileHello;
    expect(token.startsWith("hmt_")).toBe(true);
    expect(hello.fleet.fleet_id).toBe(hermetic.target?.fleet_id as string);
    expect(hello.host).toEqual({ app: "cli", version: "0.0.0-test", fixture: true });
    const again = await http("POST", MOBILE_ROUTES.pair, {
      body: { code, device_name: "FIXTURE phone A", platform: "ios" },
    });
    expect(again.status).toBe(409);
    expect(again.body["code"]).toBe("PAIR_CODE_INVALID");
    expect(JSON.stringify(again.body)).not.toContain(code);

    const target = {
      account_id: hello.fleet.account_id,
      region: hello.fleet.region,
      fleet_id: hello.fleet.fleet_id,
    };

    // Hello by bearer; a bad token is 401.
    expect((await http("GET", MOBILE_ROUTES.hello, { token })).status).toBe(200);
    const bad = await http("GET", MOBILE_ROUTES.hello, { token: "hmt_FIXTURE-not-a-token" });
    expect(bad.status).toBe(401);
    expect(bad.body["code"]).toBe("UNAUTHORIZED");

    // A second phone that never opens a socket, so it is the one pushed to.
    const phoneB = await pair("FIXTURE phone B");
    const registered = await http("POST", MOBILE_ROUTES.pushRegister, {
      token: phoneB.token,
      body: { expo_push_token: "ExponentPushToken[FIXTURE-b]" },
    });
    expect(registered).toEqual({ status: 200, body: { ok: true } });
    const settings = await http("POST", MOBILE_ROUTES.pushSettings, {
      token: phoneB.token,
      body: { previews: true },
    });
    expect(settings.body).toEqual({ ok: true, previews: true, enabled: true });

    // Allowlisted rpc: listen, read the roster, open the conversation.
    const rpc = (method: string, params: unknown, t = target) =>
      http("POST", MOBILE_ROUTES.rpc, { token, body: { method, params, target: t } });
    const listened = await rpc("chat.listen", { instance: INSTANCE, listening: true });
    expect(listened.status).toBe(200);
    expect((listened.body["result"] as { instances: string[] }).instances).toContain(INSTANCE);
    const swarms = await rpc("chat.swarms", {});
    expect(swarms.status).toBe(200);
    expect(Array.isArray((swarms.body["result"] as { swarms: unknown[] }).swarms)).toBe(true);
    const opened = await rpc("chat.open", { instance: INSTANCE, bot: BOT });
    const session = (opened.body["result"] as { session: string }).session;
    expect(typeof session).toBe("string");

    // The refusals.
    const forbidden = await rpc("agents.create", { name: "x" });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "method not reachable from a phone" },
    });
    for (const sneaky of ["constructor", "__proto__", "chat.send", "chat.observe"]) {
      expect((await rpc(sneaky, {})).status).toBe(403);
    }
    const otherFleet = await rpc("chat.listening", {}, { ...target, fleet_id: "zzzz9999" });
    expect(otherFleet.status).toBe(403);
    expect((otherFleet.body["error"] as { code: string }).code).toBe("FLEET_MISMATCH");
    const invalid = await rpc("chat.history", { instance: INSTANCE });
    expect(invalid.status).toBe(400);
    expect((invalid.body["error"] as { code: string }).code).toBe("VALIDATION");

    // A socket: auth, then a turn that parks on an approval.
    const a = new Phone();
    await a.send({ type: "auth", token, protocol: 1 });
    const ok = await a.waitFor((f) => f.type === "auth.ok");
    expect((ok["hello"] as MobileHello).listening).toContain(INSTANCE);
    await a.send({
      type: "turn.start",
      id: "t-1",
      target,
      turn: { instance: INSTANCE, bot: BOT, session, message: "E2E_APPROVAL please", client_ref: "c1" },
    });
    const started = await a.waitFor((f) => f.type === "res" && f["id"] === "t-1");
    expect(started["ok"]).toBe(true);
    const turnId = (started["result"] as { turn_id: string }).turn_id;
    await a.waitFor((f) => f.type === "turn.started");
    const approval = await a.waitFor(
      (f) =>
        f.type === "turn.frame" &&
        (f["frame"] as { type: string; block?: { kind: string } }).block?.kind === "approval",
    );
    const requestId = (approval["frame"] as { block: { request_id: string } }).block.request_id;
    const seenN = a.frames.filter((f) => f.type === "turn.frame").map((f) => f["n"] as number);
    expect(seenN[0]).toBe(1);
    expect(seenN).toEqual([...seenN].sort((x, y) => x - y));
    expect(new Set(seenN).size).toBe(seenN.length);
    const lastSeen = Math.max(...seenN);

    // The phone without a socket hears about the approval.
    await until(() => sender.sent.some((m) => m.data["kind"] === "needs_action"));
    const needs = sender.sent.find((m) => m.data["kind"] === "needs_action");
    expect(needs?.to).toBe("ExponentPushToken[FIXTURE-b]");
    expect(needs?.categoryId).toBe("hermetic.approval");
    expect(needs?.data["request_id"]).toBe(requestId);

    // Drop the socket mid-turn; answer the approval over HTTP.
    a.close();
    await a.closed;
    const answered = await rpc("chat.respond", {
      instance: INSTANCE,
      bot: BOT,
      session,
      request_id: requestId,
      kind: "approval",
      choice: "once",
    });
    expect(answered.status).toBe(200);

    // The turn finished with nobody attached; phone B is pushed the reply.
    await until(() => sender.sent.some((m) => m.data["kind"] === "turn.done"));
    expect(sender.sent.find((m) => m.data["kind"] === "turn.done")?.data["turn_id"]).toBe(turnId);

    // Reconnect and resume: only n > lastSeen, then the end.
    const a2 = new Phone();
    await a2.send({ type: "auth", token, protocol: 1 });
    const ok2 = await a2.waitFor((f) => f.type === "auth.ok");
    expect((ok2["hello"] as MobileHello).active_turns.map((t) => t.turn_id)).toContain(turnId);
    await a2.send({ type: "turn.resume", id: "r-1", turn_id: turnId, after: lastSeen });
    const resumed = await a2.waitFor((f) => f.type === "res" && f["id"] === "r-1");
    expect(resumed["result"]).toMatchObject({ turn_id: turnId, state: "done", truncated: false });
    const end = await a2.waitFor((f) => f.type === "turn.end");
    expect(end["state"]).toBe("done");
    const replayed = a2.frames.filter((f) => f.type === "turn.frame").map((f) => f["n"] as number);
    expect(replayed.length).toBeGreaterThan(0);
    expect(Math.min(...replayed)).toBe(lastSeen + 1);
    expect(end["n"]).toBe(Math.max(...replayed));
    expect(
      a2.frames.some(
        (f) => f.type === "turn.frame" && (f["frame"] as { type: string }).type === "done",
      ),
    ).toBe(true);

    // An unknown turn is gone.
    await a2.send({ type: "turn.resume", id: "r-2", turn_id: "nope", after: 0 });
    const gone = await a2.waitFor((f) => f.type === "res" && f["id"] === "r-2");
    expect(gone).toMatchObject({ ok: false, error: { code: "TURN_GONE" } });

    // Allowlist and fleet guard over the socket too.
    await a2.send({ type: "rpc", id: "x-1", method: "agents.create", params: {}, target });
    expect(await a2.waitFor((f) => f.type === "res" && f["id"] === "x-1")).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    await a2.send({
      type: "observe.open",
      id: "o-1",
      target: { ...target, fleet_id: "zzzz9999" },
      instance: INSTANCE,
      bot: BOT,
    });
    expect(await a2.waitFor((f) => f.type === "res" && f["id"] === "o-1")).toMatchObject({
      ok: false,
      error: { code: "FLEET_MISMATCH" },
    });

    // An observation: the snapshot arrives as an event, and closing it answers.
    await a2.send({ type: "observe.open", id: "o-2", target, instance: INSTANCE, bot: BOT, session });
    const sub = await a2.waitFor((f) => f.type === "res" && f["id"] === "o-2");
    const subId = (sub["result"] as { sub_id: string }).sub_id;
    const snap = await a2.waitFor((f) => f.type === "observe.event" && f["sub_id"] === subId);
    expect((snap["event"] as { type: string }).type).toBe("snapshot");
    await a2.send({ type: "observe.close", id: "o-3", sub_id: subId });
    expect((await a2.waitFor((f) => f.type === "res" && f["id"] === "o-3"))["result"]).toEqual({
      closed: true,
    });

    // A failed turn raises an inbox row; the poll forwards it and pushes it.
    await a2.send({
      type: "turn.start",
      id: "t-2",
      target,
      turn: { instance: INSTANCE, bot: BOT, session, message: "E2E_ERROR_RATE_LIMITED" },
    });
    const failedId = (
      (await a2.waitFor((f) => f.type === "res" && f["id"] === "t-2"))["result"] as {
        turn_id: string;
      }
    ).turn_id;
    const failedEnd = await a2.waitFor((f) => f.type === "turn.end" && f["turn_id"] === failedId);
    expect(failedEnd["state"]).toBe("error");
    await until(() => sender.sent.some((m) => m.data["kind"] === "turn.error"));
    await bridge.pollNotifications();
    const note = await a2.waitFor((f) => f.type === "notification");
    expect((note["row"] as { kind: string }).kind).toBe("chat.error");
    expect(note["counts"]).toMatchObject({ unread: expect.any(Number) });
    await until(() => sender.sent.some((m) => m.data["kind"] === "notification"));

    // The live phone was never pushed to.
    expect(sender.sent.every((m) => m.to === "ExponentPushToken[FIXTURE-b]")).toBe(true);

    // Revoking B: its token stops working.
    store.revoke(phoneB.device_id, new Date().toISOString());
    expect((await http("GET", MOBILE_ROUTES.hello, { token: phoneB.token })).status).toBe(401);

    a2.close();
    await a2.closed;
  }, 30_000);

  test("a bad token, a wrong protocol and a frame before auth close the socket", async () => {
    const bad = new Phone();
    await bad.send({ type: "auth", token: "hmt_FIXTURE-nope", protocol: 1 });
    expect(await bad.closed).toBe(4401);
    expect(bad.frames[0]).toMatchObject({ type: "auth.error", error: { code: "UNAUTHORIZED" } });

    const { token } = await pair("FIXTURE phone C");
    const old = new Phone();
    await old.send({ type: "auth", token, protocol: 2 });
    expect(await old.closed).toBe(4426);

    const early = new Phone();
    await early.send({ type: "pong" });
    expect(await early.closed).toBe(4401);

    const junk = new Phone();
    await junk.send({ type: "auth", token, protocol: 1 });
    await junk.waitFor((f) => f.type === "auth.ok");
    await junk.send({ type: "nonsense" });
    expect(await junk.closed).toBe(4400);
  });

  test("closing the bridge closes live sockets with 1001", async () => {
    const own = await startMobileBridge({
      core: () => hermetic,
      store,
      push: sender,
      host: "127.0.0.1",
      port: 0,
      app: "cli",
      version: "0.0.0-test",
      fixture: true,
    });
    const { code } = issuePairCode(store, { now: Date.now() });
    const res = await fetch(`${own.url}${MOBILE_ROUTES.pair}`, {
      method: "POST",
      headers: HEADER,
      body: JSON.stringify({ code, device_name: "FIXTURE phone D", platform: "android" }),
    });
    const { token } = (await res.json()) as { token: string };
    const ws = new WebSocket(`${own.url.replace("http", "ws")}${MOBILE_ROUTES.ws}`);
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener("close", (e) => resolve(e.code)),
    );
    const authed = new Promise<void>((resolve) =>
      ws.addEventListener("message", (e) => {
        if (String(e.data).includes("auth.ok")) resolve();
      }),
    );
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", token, protocol: 1 })));
    await authed;
    expect(own.status().connected).toBe(1);
    const events: string[] = [];
    own.on((e) => events.push(e.type));
    await own.close("test");
    // The bridge sends 1001; Bun's own client WebSocket reports a server's
    // 1001 as 1000 (it passes 44xx through untouched, as the test above shows).
    expect([1000, 1001]).toContain(await closed);
    expect(own.status().connected).toBe(0);
    const refused = await fetch(`${own.url}${MOBILE_ROUTES.health}`, { headers: HEADER }).then(
      () => false,
      () => true,
    );
    expect(refused).toBe(true);
    expect(events).toContain("stopped");
  });
});
