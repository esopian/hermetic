/**
 * The phone against the laptop, end to end: the phone's own client layer
 * (`mobile/src/client/`: `pairDevice`, `createHermeticClient`, its
 * `BridgeSocket` and the conversation, roster and inbox stores) driven against
 * the real mobile bridge (`startMobileBridge`) over loopback HTTP and
 * WebSocket, with a fixture `Hermetic` behind it.
 *
 * `packages/core/test/mobile-server.test.ts` checks the bridge with hand-rolled
 * frames. This file checks the join: that what the phone sends is what the
 * bridge accepts, and that what the bridge sends folds into what a phone screen
 * reads — a paired phone, the refusals, a streamed reply, both human-in-the-loop
 * requests, a dropped socket resumed mid-turn, an expired turn, an observation,
 * an inbox row, the pushes a phone without a socket is sent, a revoke and a
 * shutdown. It lives at the root because it imports core and the phone
 * together, which no package may do.
 *
 * Nothing leaves 127.0.0.1: the phone's `fetch` refuses any other origin, and
 * pushes go to a recording sender. The bridge reads the same fixture database
 * `hermetic.mobile.*` writes, through a second handle on it (as a desktop
 * portal holds several), so a code from `mobile.pair` pairs and a
 * `mobile.revoke` refuses.
 *
 * The steps share one bridge and run in order; every bit of state lives inside
 * the `describe`, and every client, socket and server is closed after.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hermetic } from "../packages/core/src/hermetic.ts";
import { openLocalDb, type LocalDb } from "../packages/core/src/local/db/index.ts";
import { SqliteMobileStore } from "../packages/core/src/mobile/device-store.ts";
import { MOBILE_PROTOCOL } from "../packages/core/src/mobile/protocol.ts";
import { memoryPushSender, type MemoryPushSender } from "../packages/core/src/mobile/push.ts";
import { startMobileBridge, type MobileBridge } from "../packages/core/src/mobile/server.ts";
import { openHermetic } from "../packages/core/src/open.ts";
import {
  type Alert,
  type BridgeError,
  type ConversationTarget,
  type ConversationView,
  type Credentials,
  type FetchLike,
  type HermeticClient,
  type Timers,
  type WebSocketLike,
  baseUrlFor,
  createBridgeHttp,
  createHermeticClient,
  isBridgeError,
  isUnpaired,
  pairDevice,
  parsePairLink,
  realTimers,
} from "../mobile/src/client/index.ts";
import type { ChatBlock, ChatMessage, ObserveOpenResult } from "../mobile/src/protocol/types.ts";

const INSTANCE = "atlas";
const BOT = "scribe";
/** The prompt the plain turn and the resumed turn both send, so their replies compare. */
const PLAIN = "FIXTURE hello there";
/** Fixture frames are paced this far apart: a plain reply is ~80 frames, ~0.5 s. */
const CHAT_DELAY_MS = 5;
/**
 * Per step. Most take well under a second; the observation waits for the
 * fixture's observe poll (~5 s). `until`'s own default (10 s) names what it
 * was waiting for before this fires.
 */
const STEP_MS = 30_000;

type Frame = Record<string, unknown> & { type: string };

/** The phone's `fetch`, refusing anything but loopback. */
const loopbackFetch: FetchLike = (url, init) => {
  if (!url.startsWith("http://127.0.0.1:")) throw new Error(`refusing non-loopback ${url}`);
  return fetch(url, init);
};

/**
 * Bun's own `WebSocket` behind the phone's `WebSocketLike`, keeping every frame
 * in each direction and the close code, so a test can read the wire and drop
 * the link the way a network does (without the client asking).
 */
class RecordingSocket implements WebSocketLike {
  readonly raw: WebSocket;
  readonly received: Frame[] = [];
  readonly sent: Frame[] = [];
  closeCode: number | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    if (!url.startsWith("ws://127.0.0.1:")) throw new Error(`refusing non-loopback ${url}`);
    this.raw = new WebSocket(url);
    this.raw.onopen = (event) => this.onopen?.(event);
    this.raw.onmessage = (event) => {
      this.received.push(JSON.parse(String(event.data)) as Frame);
      this.onmessage?.({ data: event.data });
    };
    this.raw.onclose = (event) => {
      this.closeCode = event.code;
      this.onclose?.({ code: event.code, reason: event.reason });
    };
    this.raw.onerror = (event) => this.onerror?.(event);
  }

  get readyState(): number {
    return this.raw.readyState;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Frame);
    this.raw.send(data);
  }

  close(code?: number, reason?: string): void {
    this.raw.close(code, reason);
  }

  /** `turn.frame` numbers this socket received for one turn, in arrival order. */
  frameNs(turnId: string): number[] {
    return this.received
      .filter((f) => f.type === "turn.frame" && f["turn_id"] === turnId)
      .map((f) => f["n"] as number);
  }
}

/** One phone: the client under test plus what it was seen to do. */
interface Phone {
  client: HermeticClient;
  credentials: Credentials;
  sockets: RecordingSocket[];
  alerts: Alert[];
  /** Every `live` the conversation store showed, latest last. */
  lives: ChatMessage[];
  /** `turn.end` events the socket emitted. */
  ends: Array<{ turn_id: string; state: string }>;
}

async function until(what: string, pred: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** The error a promise rejects with, which must be a `BridgeError`. */
async function refusal(promise: Promise<unknown>): Promise<BridgeError> {
  try {
    await promise;
  } catch (error) {
    if (isBridgeError(error)) return error;
    throw error;
  }
  throw new Error("expected a refusal, got an answer");
}

function textOf(message: ChatMessage | null): string {
  return (message?.blocks ?? []).map((b) => (b.kind === "text" ? b.markdown : "")).join("");
}

function blockOf<K extends ChatBlock["kind"]>(
  message: ChatMessage | null,
  kind: K,
): Extract<ChatBlock, { kind: K }> | undefined {
  return message?.blocks.find((b): b is Extract<ChatBlock, { kind: K }> => b.kind === kind);
}

describe("the phone's client layer against a real bridge", () => {
  let home = "";
  let hermetic: Hermetic;
  let local: LocalDb | null = null;
  let sender: MemoryPushSender;
  let bridge: MobileBridge | null = null;
  /** Added to the bridge's clock, to age a finished turn out of retention. */
  let skewMs = 0;
  /** Phones that live for the whole file. */
  const kept: Phone[] = [];
  /** Phones one step makes and the next must not inherit. */
  let transient: Phone[] = [];

  let phoneA: Phone;
  let phoneB: Phone;
  let phoneC: Phone;
  let target: ConversationTarget;
  /** What steps later read from steps earlier. */
  const seen = {
    plainTurn: "",
    plainBlocks: [] as ChatBlock[],
    approvalTurn: "",
    approvalRequest: "",
    clarifyTurn: "",
    clarifyRequest: "",
    errorTurn: "",
  };

  function phone(credentials: Credentials, opts: { keep?: boolean; timers?: Timers } = {}): Phone {
    const sockets: RecordingSocket[] = [];
    const alerts: Alert[] = [];
    const client = createHermeticClient({
      credentials,
      fetch: loopbackFetch,
      createSocket: (url) => {
        const socket = new RecordingSocket(url);
        sockets.push(socket);
        return socket;
      },
      random: () => 0,
      ...(opts.timers ? { timers: opts.timers } : {}),
      onAlert: (alert) => alerts.push(alert),
    });
    const made: Phone = { client, credentials, sockets, alerts, lives: [], ends: [] };
    client.conversations.subscribe(() => {
      const live = target ? client.conversations.view(target).live : null;
      if (live !== null && made.lives.at(-1) !== live) made.lives.push(live);
    });
    client.socket.on("turn.end", (e) => made.ends.push({ turn_id: e.turn_id, state: e.state }));
    (opts.keep === true ? kept : transient).push(made);
    return made;
  }

  function closePhone(p: Phone): void {
    p.client.dispose();
    for (const s of p.sockets) if (s.readyState < 2) s.raw.close();
  }

  /** A fresh pairing, by the phone's own path: `mobile.pair`'s link, parsed, then `pairDevice`. */
  async function pairNew(name: string): Promise<Credentials> {
    if (bridge === null) throw new Error("no bridge");
    const issued = await hermetic.mobile.pair({ host: "127.0.0.1", port: bridge.port });
    const link = parsePairLink(issued.url);
    if (link === null) throw new Error("mobile.pair minted a link the phone cannot parse");
    expect(link.code).toBe(issued.code);
    const { credentials } = await pairDevice({
      baseUrl: baseUrlFor(link.host, link.port),
      code: link.code,
      device_name: name,
      platform: "ios",
      fetch: loopbackFetch,
    });
    return credentials;
  }

  function view(p: Phone): ConversationView {
    return p.client.conversations.view(target);
  }

  /** Send through the conversation store and wait for the turn to settle. */
  async function sendAndSettle(p: Phone, text: string): Promise<string> {
    p.lives.length = 0;
    expect(p.client.conversations.send(target, text)).toBe(true);
    await until("the turn id", () => view(p).turnId !== null);
    const turnId = view(p).turnId as string;
    await until(`turn ${text} to settle`, () => !view(p).sending);
    return turnId;
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "hermetic-mobile-e2e-"));
    hermetic = await openHermetic({
      fixture: true,
      home,
      fixtureOptions: { chatDelayMs: CHAT_DELAY_MS },
    });
    // A second handle on the fixture database `hermetic.mobile.*` writes.
    local = openLocalDb({ home, fixture: true });
    sender = memoryPushSender();
    bridge = await startMobileBridge({
      core: () => hermetic,
      store: new SqliteMobileStore(local.db),
      push: sender,
      host: "127.0.0.1",
      port: 0,
      app: "cli",
      version: "0.0.0-e2e",
      fixture: true,
      heartbeatMs: 60_000,
      clock: () => Date.now() + skewMs,
    });
  });

  afterEach(() => {
    for (const p of transient) closePhone(p);
    transient = [];
  });

  afterAll(async () => {
    for (const p of kept) closePhone(p);
    await bridge?.close("test over");
    local?.db.close();
    if (home !== "") rmSync(home, { recursive: true, force: true });
  });

  test(
    "pairs with a code from mobile.pair, and the code is spent",
    async () => {
      if (bridge === null) throw new Error("no bridge");
      const health = await createBridgeHttp({ baseUrl: bridge.url, fetch: loopbackFetch }).health();
      expect(health).toEqual({ ok: true, protocol: MOBILE_PROTOCOL.PROTOCOL_VERSION, fixture: true });

      const issued = await hermetic.mobile.pair({ host: "127.0.0.1", port: bridge.port });
      const link = parsePairLink(issued.url);
      expect(link).toMatchObject({ host: "127.0.0.1", port: bridge.port, code: issued.code });
      const paired = await pairDevice({
        baseUrl: bridge.url,
        code: issued.code,
        device_name: "FIXTURE phone A",
        platform: "ios",
        fetch: loopbackFetch,
      });
      expect(paired.credentials.token.startsWith(MOBILE_PROTOCOL.TOKEN_PREFIX)).toBe(true);
      expect(paired.credentials.baseUrl).toBe(bridge.url);
      expect(paired.hello.fleet.fleet_id).toBe(hermetic.target?.fleet_id as string);
      expect(paired.hello.host).toEqual({ app: "cli", version: "0.0.0-e2e", fixture: true });

      const again = await refusal(
        pairDevice({
          baseUrl: bridge.url,
          code: issued.code,
          device_name: "FIXTURE phone A",
          platform: "ios",
          fetch: loopbackFetch,
        }),
      );
      expect({ code: again.code, status: again.status }).toEqual({
        code: "PAIR_CODE_INVALID",
        status: 409,
      });

      phoneA = phone(paired.credentials, { keep: true });
      const hello = await phoneA.client.http.hello();
      expect(hello.device.device_id).toBe(paired.credentials.device_id);
      const devices = await hermetic.mobile.devices({});
      expect(devices.devices.map((d) => d.name)).toContain("FIXTURE phone A");

      // Two phones that never open a socket, so they are the ones pushed to:
      // B with previews off, C with them on. A registers too, and stays live.
      phoneB = phone(await pairNew("FIXTURE phone B"), { keep: true });
      phoneC = phone(await pairNew("FIXTURE phone C"), { keep: true });
      expect(
        await phoneB.client.http.pushRegister({
          expo_push_token: "ExponentPushToken[FIXTURE-b]",
          previews: false,
        }),
      ).toEqual({ ok: true });
      await phoneC.client.http.pushRegister({ expo_push_token: "ExponentPushToken[FIXTURE-c]" });
      expect(await phoneC.client.http.pushSettings({ previews: true })).toMatchObject({
        ok: true,
        previews: true,
        enabled: true,
      });
      await phoneA.client.http.pushRegister({ expo_push_token: "ExponentPushToken[FIXTURE-a]" });
    },
    STEP_MS,
  );

  test(
    "a bad token is refused over HTTP (401) and over the socket (auth.error, 4401)",
    async () => {
      const bad = phone({ ...phoneA.credentials, token: "hmt_FIXTURE-not-a-token" });
      const err = await refusal(bad.client.http.hello());
      expect({ code: err.code, status: err.status }).toEqual({ code: "UNAUTHORIZED", status: 401 });
      expect(isUnpaired(err)).toBe(true);

      const authErrors: string[] = [];
      bad.client.socket.on("auth.error", (e) => authErrors.push(e.code));
      bad.client.connect();
      await until("the socket to give up", () => bad.client.socket.state === "unauthorized");
      await until("the close", () => bad.sockets[0]?.closeCode !== null);
      expect(bad.sockets[0]?.closeCode).toBe(4401);
      expect(authErrors).toEqual(["UNAUTHORIZED"]);
      // Unauthorized is final: no reconnect.
      await Bun.sleep(50);
      expect(bad.sockets).toHaveLength(1);
    },
    STEP_MS,
  );

  test(
    "the allowlist and the fleet guard refuse, over HTTP and over the socket",
    async () => {
      for (const method of ["agents.create", "mobile.devices", "chat.send"]) {
        const err = await refusal(phoneA.client.http.rpc(method, { name: "x" }));
        expect({ method, code: err.code, status: err.status }).toEqual({
          method,
          code: "FORBIDDEN",
          status: 403,
        });
      }

      const elsewhere = phone({
        ...phoneA.credentials,
        fleet: { ...phoneA.credentials.fleet, fleet_id: "zzzz9999" },
      });
      const mismatch = await refusal(elsewhere.client.http.rpc("chat.listening", {}));
      expect({ code: mismatch.code, status: mismatch.status }).toEqual({
        code: "FLEET_MISMATCH",
        status: 403,
      });

      phoneA.client.connect();
      await until("phone A's socket", () => phoneA.client.socket.state === "open");
      const overSocket = await refusal(phoneA.client.socket.rpc("agents.create", {}));
      expect(overSocket.code).toBe("FORBIDDEN");

      // Over the socket the phone checks `auth.ok`'s fleet itself and stops
      // before it could send a request naming the wrong one; the bridge's own
      // socket guard is covered in `mobile-server.test.ts`.
      elsewhere.client.connect();
      await until("the other fleet's socket", () => elsewhere.client.socket.state === "wrong_fleet");
    },
    STEP_MS,
  );

  test(
    "listen, then the roster shows the bot",
    async () => {
      const listening: string[][] = [];
      const off = phoneA.client.socket.on("listening", (e) => listening.push(e.instances));
      await phoneA.client.roster.listen(INSTANCE, true);
      expect(phoneA.client.roster.getState().listening).toContain(INSTANCE);
      // Every live socket hears it, this one included, after its `res`.
      await until("the listening frame", () => listening.some((i) => i.includes(INSTANCE)));
      off();

      expect(await phoneA.client.roster.refresh()).toBe(true);
      const atlas = phoneA.client.roster.getState().swarms.find((s) => s.instance === INSTANCE);
      expect(atlas?.bots.map((b) => b.name)).toContain(BOT);

      const opened = await phoneA.client.rpc<{ session: string }>("chat.open", {
        instance: INSTANCE,
        bot: BOT,
      });
      expect(typeof opened.session).toBe("string");
      target = { instance: INSTANCE, bot: BOT, session: opened.session };
    },
    STEP_MS,
  );

  test(
    "a plain turn streams into the conversation store and ends done",
    async () => {
      const turnId = await sendAndSettle(phoneA, PLAIN);
      seen.plainTurn = turnId;
      const v = view(phoneA);
      expect(v.turnError).toBeNull();
      expect(v.dropped).toBe(false);
      expect(phoneA.ends).toContainEqual({ turn_id: turnId, state: "done" });

      // Deltas folded into one growing text block, not a block per delta.
      const lengths = phoneA.lives.map((m) => textOf(m).length);
      expect(new Set(lengths).size).toBeGreaterThan(5);
      const final = phoneA.lives.at(-1) as ChatMessage;
      expect(lengths.at(-1)).toBe(Math.max(...lengths));
      const kinds = final.blocks.map((b) => b.kind);
      for (const kind of ["reasoning", "text", "tool"] as const) expect(kinds).toContain(kind);
      expect(kinds.filter((k) => k === "text").length).toBeLessThan(5);
      seen.plainBlocks = final.blocks;

      // Every frame once, numbered 1..N, then the end at N.
      const socket = phoneA.sockets.at(-1) as RecordingSocket;
      const ns = socket.frameNs(turnId);
      expect(ns).toEqual(ns.map((_, i) => i + 1));
      const end = socket.received.find((f) => f.type === "turn.end" && f["turn_id"] === turnId);
      expect(end).toMatchObject({ state: "done", n: ns.length });
    },
    STEP_MS,
  );

  test(
    "an approval parks the turn; answering once through the client releases it",
    async () => {
      phoneA.lives.length = 0;
      expect(phoneA.client.conversations.send(target, "FIXTURE E2E_APPROVAL please")).toBe(true);
      await until("the approval", () => view(phoneA).openRequests.length === 1);
      const v = view(phoneA);
      const approval = blockOf(v.live, "approval");
      expect(approval?.choices).toEqual(["once", "session", "always", "deny"]);
      const requestId = approval?.request_id as string;
      expect(v.openRequests).toEqual([requestId]);
      expect(v.sending).toBe(true);
      seen.approvalTurn = v.turnId as string;
      seen.approvalRequest = requestId;

      // The phone raises its own alert for it, once.
      await until("the needs-you alert", () =>
        phoneA.alerts.some((a) => a.data.kind === "needs_action"),
      );
      const alert = phoneA.alerts.find((a) => a.data.kind === "needs_action");
      expect(alert?.category).toBe("hermetic.approval");
      expect(alert?.data).toMatchObject({ request_id: requestId, dedupe: `req:${requestId}` });

      const answered = await phoneA.client.conversations.respond(target, {
        request_id: requestId,
        kind: "approval",
        choice: "once",
      });
      expect(answered).toMatchObject({ status: "ok" });
      await until("the approved turn to settle", () => !view(phoneA).sending);
      expect(view(phoneA).turnError).toBeNull();
      expect(view(phoneA).openRequests).toEqual([]);
      expect(phoneA.ends).toContainEqual({ turn_id: seen.approvalTurn, state: "done" });
    },
    STEP_MS,
  );

  test(
    "a batch clarify is answered with answers and the turn goes on to done",
    async () => {
      phoneA.lives.length = 0;
      expect(phoneA.client.conversations.send(target, "FIXTURE E2E_BATCH_CLARIFY now")).toBe(true);
      await until("the question", () => view(phoneA).openRequests.length === 1);
      const question = blockOf(view(phoneA).live, "question");
      const questions = question?.questions ?? [];
      expect(questions.length).toBe(2);
      const requestId = question?.request_id as string;
      seen.clarifyTurn = view(phoneA).turnId as string;
      seen.clarifyRequest = requestId;

      const answers = Object.fromEntries(questions.map((q) => [q.id, q.choices.at(-1) ?? "x"]));
      const answered = await phoneA.client.conversations.respond(target, {
        request_id: requestId,
        kind: "question",
        answers,
      });
      expect(answered).toMatchObject({ status: "ok", remaining: [] });
      await until("the answered turn to settle", () => !view(phoneA).sending);
      expect(view(phoneA).turnError).toBeNull();
      expect(phoneA.ends).toContainEqual({ turn_id: seen.clarifyTurn, state: "done" });
    },
    STEP_MS,
  );

  test(
    "a socket dropped mid-turn resumes from the last frame seen, and the reply is whole",
    async () => {
      phoneA.lives.length = 0;
      const before = phoneA.sockets.length;
      expect(phoneA.client.conversations.send(target, PLAIN)).toBe(true);
      await until("the turn id", () => view(phoneA).turnId !== null);
      const turnId = view(phoneA).turnId as string;
      const dropped = phoneA.sockets.at(-1) as RecordingSocket;
      await until("a few frames", () => dropped.frameNs(turnId).length >= 10);

      // The network drops: the client did not ask, so it reconnects on its own.
      dropped.raw.close();
      await until("the drop", () => dropped.closeCode !== null);
      const lastSeen = Math.max(...dropped.frameNs(turnId));
      // It really was mid-turn: the dropped socket never saw the end.
      expect(dropped.received.some((f) => f.type === "turn.end" && f["turn_id"] === turnId)).toBe(
        false,
      );
      await until("a new socket", () => phoneA.sockets.length > before);
      await until("the resumed turn to settle", () => !view(phoneA).sending);

      const resumed = phoneA.sockets.at(-1) as RecordingSocket;
      expect(resumed).not.toBe(dropped);
      // The reconnect's auth asked for exactly what was missed.
      const auth = resumed.sent.find((f) => f.type === "auth");
      expect(auth?.["resume"]).toEqual({ turns: [{ turn_id: turnId, after: lastSeen }] });

      const replayed = resumed.frameNs(turnId);
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed[0]).toBe(lastSeen + 1);
      expect(replayed).toEqual(replayed.map((_, i) => lastSeen + 1 + i));
      const all = [...dropped.frameNs(turnId), ...replayed];
      expect(new Set(all).size).toBe(all.length);
      expect(all).toEqual(all.map((_, i) => i + 1));
      const end = resumed.received.find((f) => f.type === "turn.end" && f["turn_id"] === turnId);
      expect(end).toMatchObject({ state: "done", n: all.length });

      const v = view(phoneA);
      expect(v.turnError).toBeNull();
      expect(v.dropped).toBe(false);
      // The same reply an uninterrupted turn folded, block for block.
      expect((phoneA.lives.at(-1) as ChatMessage).blocks).toEqual(seen.plainBlocks);
    },
    STEP_MS,
  );

  test(
    "a turn the registry has forgotten is TURN_GONE",
    async () => {
      const goneEvents: string[] = [];
      const off = phoneA.client.socket.on("turn.gone", (e) => goneEvents.push(e.turn_id));
      skewMs = MOBILE_PROTOCOL.TURN_RETENTION_MS + 60_000;
      try {
        // `hello` lists the turns, which sweeps the expired ones.
        const hello = await phoneA.client.http.hello();
        expect(hello.active_turns.map((t) => t.turn_id)).not.toContain(seen.approvalTurn);
        const gone = await refusal(phoneA.client.socket.resumeTurn(seen.approvalTurn, 0));
        expect(gone.code).toBe("TURN_GONE");
      } finally {
        skewMs = 0;
        off();
      }
      expect(goneEvents).toEqual([seen.approvalTurn]);
      expect(phoneA.client.socket.trackedTurns().map((t) => t.turn_id)).not.toContain(
        seen.approvalTurn,
      );
    },
    STEP_MS,
  );

  test(
    "observing the conversation yields a snapshot, then a message after a turn",
    async () => {
      const events: Array<{ type: string; id?: string }> = [];
      const off = phoneA.client.socket.on("observe.event", (e) =>
        events.push({
          type: e.event.type,
          ...(e.event.type === "message" ? { id: e.event.message.id } : {}),
        }),
      );
      try {
        phoneA.client.conversations.open(target);
        await until("the snapshot", () => events.length > 0);
        expect(events[0]?.type).toBe("snapshot");
        expect(view(phoneA).observe).toBe("live");
        const opened = phoneA.sockets
          .at(-1)
          ?.received.filter((f) => f.type === "res")
          .map((f) => f["result"] as ObserveOpenResult | undefined)
          .filter((r) => typeof r?.sub_id === "string");
        expect(opened?.length).toBeGreaterThan(0);

        const count = events.length;
        await sendAndSettle(phoneA, "FIXTURE observed turn");
        await until("an observed message", () => events.slice(count).some((e) => e.type === "message"));
        const ids = events.filter((e) => e.type === "message").map((e) => e.id);
        await until("the observed message in the transcript", () =>
          view(phoneA).messages.some((m) => ids.includes(m.id)),
        );
      } finally {
        phoneA.client.conversations.leave(target);
        off();
      }
      expect(view(phoneA).observe).toBe("off");
    },
    STEP_MS,
  );

  test(
    "a failed turn's inbox row reaches the phone as a notification frame",
    async () => {
      if (bridge === null) throw new Error("no bridge");
      const turnId = await sendAndSettle(phoneA, "FIXTURE E2E_ERROR_RATE_LIMITED");
      seen.errorTurn = turnId;
      expect(view(phoneA).turnError).not.toBeNull();
      expect(phoneA.ends).toContainEqual({ turn_id: turnId, state: "error" });

      const frames: string[] = [];
      const off = phoneA.client.socket.on("notification", (e) => frames.push(e.row.kind));
      try {
        await until("the error row in the inbox", () => {
          void bridge?.pollNotifications();
          return frames.includes("chat.error");
        });
      } finally {
        off();
      }
      const inbox = phoneA.client.inbox.getState();
      expect(inbox.rows.some((r) => r.kind === "chat.error")).toBe(true);
      expect(inbox.counts.unread).toBeGreaterThan(0);
      const errorRow = inbox.rows.find((r) => r.kind === "chat.error");
      const alert = phoneA.alerts.find((a) => {
        const data = a.data;
        return data.kind === "notification" && data.id === errorRow?.id;
      });
      expect(alert?.decision).toBe("banner");
    },
    STEP_MS,
  );

  test(
    "phones without a socket were pushed each event once; previews off strips the text",
    async () => {
      const b = "ExponentPushToken[FIXTURE-b]";
      const c = "ExponentPushToken[FIXTURE-c]";
      const a = "ExponentPushToken[FIXTURE-a]";
      const wanted = [
        `turn:${seen.plainTurn}:done`,
        `req:${seen.approvalRequest}`,
        `turn:${seen.approvalTurn}:done`,
        `req:${seen.clarifyRequest}`,
        `turn:${seen.clarifyTurn}:done`,
        `turn:${seen.errorTurn}:error`,
      ];
      await until("every push", () =>
        [b, c].every((to) =>
          wanted.every((key) => sender.sent.some((m) => m.to === to && m.data["dedupe"] === key)),
        ),
      );
      await until("a notification push", () =>
        [b, c].every((to) => sender.sent.some((m) => m.to === to && m.data["kind"] === "notification")),
      );

      // Every push carries a dedupe key, and no device got one key twice.
      const pairs = sender.sent.map((m) => `${m.to}|${String(m.data["dedupe"])}`);
      for (const m of sender.sent) expect(typeof m.data["dedupe"]).toBe("string");
      expect(new Set(pairs).size).toBe(pairs.length);

      // Phone A was live for all of these, so it got frames, not pushes.
      expect(
        sender.sent.filter((m) => m.to === a && wanted.includes(String(m.data["dedupe"]))),
      ).toEqual([]);

      const find = (to: string, key: string) =>
        sender.sent.find((m) => m.to === to && m.data["dedupe"] === key);
      // B: previews off — fixed bodies, no reply text, no row detail.
      expect(find(b, `turn:${seen.plainTurn}:done`)?.body).toBe("Reply ready");
      expect(find(b, `req:${seen.approvalRequest}`)?.body).toBe("Needs you");
      for (const m of sender.sent.filter((m) => m.to === b && m.data["kind"] === "notification")) {
        expect(m.body).toBeUndefined();
      }
      // C: previews on — the reply's opening words, capped.
      const preview = find(c, `turn:${seen.plainTurn}:done`)?.body ?? "";
      expect(preview).not.toBe("Reply ready");
      expect(preview.length).toBeGreaterThan(0);
      expect(preview.length).toBeLessThanOrEqual(MOBILE_PROTOCOL.PREVIEW_MAX_CHARS);
      expect(find(c, `req:${seen.approvalRequest}`)?.body?.startsWith("Approval needed")).toBe(true);

      // The request pushes are actionable, under the categories the phone registers.
      expect(find(b, `req:${seen.approvalRequest}`)).toMatchObject({
        categoryId: "hermetic.approval",
        data: { kind: "needs_action", request_kind: "approval", request_id: seen.approvalRequest },
      });
      expect(find(b, `req:${seen.clarifyRequest}`)).toMatchObject({
        categoryId: "hermetic.question",
        data: { kind: "needs_action", request_kind: "question" },
      });
    },
    STEP_MS,
  );

  test(
    "mobile.revoke ends a pairing: the next request is 401 and the socket is refused",
    async () => {
      const result = await hermetic.mobile.revoke({ device_id: phoneB.credentials.device_id });
      expect(result).toEqual({ revoked: true });

      const err = await refusal(phoneB.client.http.hello());
      expect({ code: err.code, status: err.status }).toEqual({ code: "UNAUTHORIZED", status: 401 });
      expect(isUnpaired(err)).toBe(true);
      const viaRpc = await refusal(phoneB.client.rpc("chat.listening", {}));
      expect(viaRpc.status).toBe(401);

      phoneB.client.connect();
      await until("B's socket to be refused", () => phoneB.client.socket.state === "unauthorized");
      await until("B's close", () => phoneB.sockets[0]?.closeCode !== null);
      expect(phoneB.sockets[0]?.closeCode).toBe(4401);

      // Phone C is untouched.
      expect((await phoneC.client.http.hello()).device.device_id).toBe(phoneC.credentials.device_id);
    },
    STEP_MS,
  );

  test(
    "shutdown closes live sockets (1001), and the phone backs off, then stops when told",
    async () => {
      if (bridge === null) throw new Error("no bridge");
      // A phone whose timers the test can see: backoff waits are recorded, and
      // shortened once the bridge is gone so the ladder is walked in real time.
      const delays: number[] = [];
      let recording = false;
      const timers: Timers = {
        setTimeout: (fn, ms) => {
          if (!recording) return realTimers.setTimeout(fn, ms);
          delays.push(ms);
          return realTimers.setTimeout(fn, Math.min(ms, 10));
        },
        clearTimeout: (handle) => realTimers.clearTimeout(handle),
        now: () => realTimers.now(),
      };
      const e = phone(await pairNew("FIXTURE phone E"), { timers });
      e.client.connect();
      await until("phone E's socket", () => e.client.socket.state === "open");
      const states: string[] = [];
      e.client.socket.on("state", (s) => states.push(s));

      const aLive = phoneA.sockets.at(-1) as RecordingSocket;
      expect(phoneA.client.socket.state).toBe("open");
      recording = true;
      await bridge.close("test shutdown");
      // The bridge sends 1001; Bun's client reports a server's 1001 as 1000.
      await until("E's close", () => e.sockets[0]?.closeCode !== null);
      expect([1000, 1001]).toContain(e.sockets[0]?.closeCode as number);
      await until("A's close", () => aLive.closeCode !== null);
      expect([1000, 1001]).toContain(aLive.closeCode as number);
      phoneA.client.disconnect();

      await until("three reconnect attempts", () => e.sockets.length >= 4);
      expect(states).toContain("reconnecting");
      // 0, then 1 s, then doubling (jitter pinned to zero): the desktop's ladder.
      expect(delays.slice(0, 3)).toEqual([0, 1_000, 2_000]);
      for (const s of e.sockets.slice(1)) {
        await until("a refused attempt to close", () => s.closeCode !== null);
        expect(s.closeCode).not.toBe(1000);
      }

      e.client.disconnect();
      expect(e.client.socket.state).toBe("idle");
      const made = e.sockets.length;
      await Bun.sleep(100);
      expect(e.sockets.length).toBe(made);
    },
    STEP_MS,
  );
});
