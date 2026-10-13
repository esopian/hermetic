/**
 * The gateway watcher (`push/watch.ts`) and its notifier (`push/notify.ts`),
 * against a scripted chat client: each `session.active_list` call answers the
 * next snapshot, so a test is a sequence of gateway states and the exact pushes
 * they must raise. No network, no socket, no clock but the test's.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage, HermesChatClient, Session, Swarm } from "@hermetic/core/chat-client";
import type { MobilePushDevice } from "@hermetic/core/schema";
import { MobilePushData } from "@hermetic/core/schema";
import type { ExpoPushMessage, ExpoPushTicket } from "@hermetic/core/shared";
import { pushDeviceStore, type PushDeviceStore } from "../src/push/devices.ts";
import { NEEDS_ACTION_CATEGORY, RECEIPT_DELAY_MS } from "../src/push/notify.ts";
import {
  UNKNOWN_BOT,
  WATCH_BACKOFF_MAX_MS,
  WATCH_POLL_MS,
  createWatcher,
  parseActiveList,
  tailVerdict,
  type WatchDeps,
} from "../src/push/watch.ts";
import { redactValue } from "../src/redact.ts";
import { FakeHost } from "./fake-host.ts";

const INSTANCE = "atlas";
const FLEET = "fxtr0001";
const TOKEN_A = "ExponentPushToken[FIXTURE-watch-a]";
const TOKEN_B = "ExponentPushToken[FIXTURE-watch-b]";

type Live = { id: string; status: string; message_count: number; preview?: string };

function snapshot(...sessions: Live[]): unknown {
  return {
    sessions: sessions.map((s) => ({
      id: `live-${s.id}`,
      session_key: s.id,
      status: s.status,
      message_count: s.message_count,
      preview: s.preview ?? "",
      last_active: 1,
      started_at: 1,
      model: "m",
      current: false,
      title: "t",
    })),
  };
}

function message(
  role: ChatMessage["role"],
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: `m-${role}-${text.length}`,
    session: "s",
    role,
    at: "2026-09-01T12:00:00.000Z",
    blocks: [{ kind: "text", markdown: text }],
    ...extra,
  };
}

interface ScriptedChat {
  client: HermesChatClient;
  /** Each `session.active_list` answers the next of these; an Error is thrown. */
  snapshots: Array<unknown | Error>;
  /** session → bot, what `swarm` + `sessions` report. */
  bots: Map<string, string>;
  /** session → the tail `history` returns; an Error is thrown. */
  tails: Map<string, ChatMessage[] | Error>;
  rpcCalls: number;
  swarmCalls: number;
  historyCalls: Array<{ bot: string; session: string | undefined }>;
}

function scriptedChat(): ScriptedChat {
  const state: ScriptedChat = {
    snapshots: [],
    bots: new Map(),
    tails: new Map(),
    rpcCalls: 0,
    swarmCalls: 0,
    historyCalls: [],
    client: undefined as unknown as HermesChatClient,
  };
  const botNames = (): string[] => [...new Set(state.bots.values())];
  state.client = {
    async botModeRpc(_box, method) {
      if (method !== "session.active_list") throw new Error(`unexpected ${method}`);
      state.rpcCalls += 1;
      const next = state.snapshots.length > 1 ? state.snapshots.shift() : state.snapshots[0];
      if (next instanceof Error) throw next;
      return next ?? { sessions: [] };
    },
    async swarm(box): Promise<Swarm> {
      state.swarmCalls += 1;
      return {
        instance: box.instance,
        reachable: true,
        bots: botNames().map((name) => ({
          instance: box.instance,
          name,
          title: name,
          is_default: name === "default",
          avatar_seed: `${FLEET}/${box.instance}/${name}`,
          unread: 0,
          needs_action: false,
          muted: false,
          warm: false,
        })),
        rooms: [],
        warm_slots: { used: 0, total: null },
        sections: [],
      };
    },
    async sessions(box, bot): Promise<Session[]> {
      return [...state.bots.entries()]
        .filter(([, b]) => b === bot)
        .map(
          ([id]): Session => ({
            id,
            instance: box.instance,
            bot,
            kind: "canonical",
            origin: "portal",
            title: id,
            unread: 0,
            turn_count: 1,
          }),
        );
    },
    async history(_box, bot, opts) {
      state.historyCalls.push({ bot, session: opts?.session });
      const tail = state.tails.get(opts?.session ?? "");
      if (tail instanceof Error) throw tail;
      return tail ?? [];
    },
    async token() {
      return "unused";
    },
    send() {
      throw new Error("the watcher never sends");
    },
    async abort() {
      return false;
    },
  };
  return state;
}

interface Rig {
  chat: ScriptedChat;
  devices: PushDeviceStore;
  sent: ExpoPushMessage[];
  /** Tickets the next send answers, by message index; default ok with an id. */
  ticket: (message: ExpoPushMessage, i: number) => ExpoPushTicket;
  receipts: Map<string, ExpoPushTicket>;
  receiptAsks: string[][];
  logs: string[];
  clock: { now: number };
  deps: WatchDeps;
}

async function rig(
  devices: MobilePushDevice[] = [device("a", TOKEN_A)],
  over: Partial<WatchDeps> = {},
): Promise<Rig> {
  const host = new FakeHost();
  const store = pushDeviceStore(host);
  for (const d of devices) await store.upsert(d);
  const r: Rig = {
    chat: scriptedChat(),
    devices: store,
    sent: [],
    ticket: (_m, i) => ({ status: "ok", id: `ticket-${i}` }),
    receipts: new Map(),
    receiptAsks: [],
    logs: [],
    clock: { now: Date.parse("2026-09-01T12:00:00.000Z") },
    deps: undefined as unknown as WatchDeps,
  };
  let sends = 0;
  r.deps = {
    chat: r.chat.client,
    devices: store,
    send: async (messages) => {
      r.sent.push(...messages);
      return messages.map((m) => r.ticket(m, sends++));
    },
    fetchReceipts: async (ids) => {
      r.receiptAsks.push([...ids]);
      return new Map(
        ids.flatMap((id) => (r.receipts.has(id) ? [[id, r.receipts.get(id)!] as const] : [])),
      );
    },
    now: () => r.clock.now,
    sleep: async (ms) => {
      r.clock.now += ms;
    },
    log: (m) => void r.logs.push(m),
    instance: INSTANCE,
    fleet_id: FLEET,
    redact: redactValue,
    ...over,
  };
  return r;
}

function device(
  id: string,
  token: string,
  listening: MobilePushDevice["listening"] = "all",
): MobilePushDevice {
  return { device_id: id, token, platform: "ios", app_version: "1.0.0", listening };
}

/** Advance the clock one poll and tick. */
async function step(r: Rig, watcher: ReturnType<typeof createWatcher>) {
  r.clock.now += WATCH_POLL_MS;
  return watcher.tick();
}

describe("transitions", () => {
  test("the first answer is a baseline: live sessions push nothing", async () => {
    const r = await rig();
    r.chat.bots.set("s1", "granite");
    r.chat.snapshots.push(
      snapshot({ id: "s1", status: "idle", message_count: 4, preview: "old" }),
      snapshot({ id: "s1", status: "waiting", message_count: 4 }),
    );
    const w = createWatcher(r.deps);
    expect(await w.tick()).toEqual({ kind: "ok", pushes: [] });
    expect(r.sent).toEqual([]);
    // From the second answer on, transitions count.
    await step(r, w);
    expect(r.sent.map((m) => (m.data as MobilePushData).kind)).toEqual(["needs_action"]);
  });

  test("working → idle with a bot reply is turn.done: exact message, dedupe and data", async () => {
    const r = await rig();
    r.chat.bots.set("s1", "granite");
    r.chat.tails.set("s1", [
      message("user", "hi"),
      message("bot", "Here is   the\nsummary you asked for."),
    ]);
    r.chat.snapshots.push(
      snapshot({ id: "s1", status: "working", message_count: 1 }),
      snapshot({ id: "s1", status: "idle", message_count: 2 }),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    expect(r.sent).toEqual([
      {
        to: TOKEN_A,
        title: "granite · atlas",
        body: "Here is the summary you asked for.",
        data: {
          fleet_id: FLEET,
          instance: INSTANCE,
          bot: "granite",
          session: "s1",
          kind: "turn.done",
          dedupe: "atlas:s1:2:turn.done",
        },
        sound: "default",
      },
    ]);
    expect(MobilePushData.safeParse(r.sent[0]?.data).success).toBe(true);
    expect(r.chat.historyCalls).toEqual([{ bot: "granite", session: "s1" }]);
  });

  test("a tail row with a failure is turn.error, its text redacted and cut to 140", async () => {
    const r = await rig();
    r.chat.bots.set("s1", "granite");
    const secret = "sk-ant-FIXTUREfixtureFIXTUREfixture0123";
    r.chat.tails.set("s1", [
      message("user", "go"),
      message("bot", "", {
        blocks: [],
        failure: { code: "AUTH", message: `provider refused key ${secret} ${"x".repeat(200)}` },
      }),
    ]);
    r.chat.snapshots.push(
      snapshot({ id: "s1", status: "working", message_count: 1 }),
      snapshot({ id: "s1", status: "idle", message_count: 2 }),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    const [push] = r.sent;
    const data = MobilePushData.parse(push?.data);
    expect(data.kind).toBe("turn.error");
    expect(data.dedupe).toBe("atlas:s1:2:turn.error");
    expect(push?.body).not.toContain(secret);
    expect(push?.body).toContain("«redacted»");
    expect(push?.body?.length).toBe(140);
    expect(push?.body?.endsWith("…")).toBe(true);
  });

  test("→ waiting is needs_action: high priority, its category, once per message count", async () => {
    const r = await rig();
    r.chat.bots.set("s1", "atlas");
    r.chat.snapshots.push(
      snapshot({ id: "s1", status: "working", message_count: 3 }),
      snapshot({ id: "s1", status: "waiting", message_count: 3 }),
      snapshot({ id: "s1", status: "working", message_count: 3 }),
      snapshot({ id: "s1", status: "waiting", message_count: 3 }),
      snapshot({ id: "s1", status: "waiting", message_count: 5 }),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    for (let i = 0; i < 4; i++) await step(r, w);
    // The flap at count 3 is one push; still waiting at 5 is not a new arrival.
    expect(r.sent).toEqual([
      {
        to: TOKEN_A,
        title: "atlas",
        body: "atlas is waiting on you",
        data: {
          fleet_id: FLEET,
          instance: INSTANCE,
          bot: "atlas",
          session: "s1",
          kind: "needs_action",
          dedupe: "atlas:s1:3:needs_action",
        },
        sound: "default",
        priority: "high",
        categoryId: NEEDS_ACTION_CATEGORY,
      },
    ]);
  });

  test("a session first seen idle with messages is a message (routine/channel); empty is nothing", async () => {
    const r = await rig();
    r.chat.bots.set("cron-1", "granite");
    r.chat.snapshots.push(
      snapshot(),
      snapshot(
        { id: "cron-1", status: "idle", message_count: 2, preview: "Daily digest: 3 new tickets" },
        { id: "fresh", status: "idle", message_count: 0 },
      ),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    expect(r.sent.map((m) => [m.body, (m.data as MobilePushData).dedupe])).toEqual([
      ["Daily digest: 3 new tickets", "atlas:cron-1:2:message"],
    ]);
    expect(r.chat.historyCalls).toEqual([]);
  });

  test("a turn whose tail ends on the user row (interrupted, no output) pushes nothing", async () => {
    const r = await rig();
    r.chat.bots.set("s1", "granite");
    r.chat.tails.set("s1", [message("bot", "earlier"), message("user", "stop")]);
    r.chat.snapshots.push(
      snapshot({ id: "s1", status: "working", message_count: 1 }),
      snapshot({ id: "s1", status: "idle", message_count: 2 }),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    expect(r.sent).toEqual([]);
  });

  test("a tail that cannot be read still says the turn finished, from the gateway's preview", async () => {
    const r = await rig();
    r.chat.bots.set("s1", "granite");
    r.chat.tails.set("s1", new Error("history unavailable"));
    r.chat.snapshots.push(
      snapshot({ id: "s1", status: "working", message_count: 1 }),
      snapshot({ id: "s1", status: "idle", message_count: 2, preview: "Done: deployed" }),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    expect(r.sent.map((m) => [(m.data as MobilePushData).kind, m.body])).toEqual([
      ["turn.done", "Done: deployed"],
    ]);
  });

  test("an unknown session forces one map refresh, then pushes as `unknown`, message only", async () => {
    const r = await rig();
    r.chat.snapshots.push(
      snapshot({ id: "ghost", status: "working", message_count: 1 }),
      snapshot({ id: "ghost", status: "waiting", message_count: 1 }),
      snapshot({ id: "ghost", status: "idle", message_count: 2, preview: "ghost reply" }),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    expect(r.chat.swarmCalls).toBe(1);
    r.clock.now += 10_000;
    await w.tick();
    // The waiting transition asked again (once) and still found no bot: no push.
    expect(r.chat.swarmCalls).toBe(2);
    expect(r.sent).toEqual([]);
    r.clock.now += 10_000;
    await w.tick();
    expect(r.chat.historyCalls).toEqual([]);
    expect(r.sent.map((m) => m.data)).toEqual([
      {
        fleet_id: FLEET,
        instance: INSTANCE,
        bot: UNKNOWN_BOT,
        session: "ghost",
        kind: "message",
        dedupe: "atlas:ghost:2:message",
      },
    ]);
  });

  test("the session map is refreshed every 60 s, not every poll", async () => {
    const r = await rig();
    r.chat.snapshots.push(snapshot());
    const w = createWatcher(r.deps);
    await w.tick();
    for (let i = 0; i < 19; i++) await step(r, w);
    expect(r.chat.swarmCalls).toBe(1);
    await step(r, w);
    expect(r.chat.swarmCalls).toBe(2);
  });
});

describe("who is pushed to", () => {
  test("only phones listening to the bot, or to all", async () => {
    const r = await rig([
      device("a", TOKEN_A, ["basalt"]),
      device("b", TOKEN_B, "all"),
      device("c", "ExponentPushToken[FIXTURE-watch-c]", ["granite"]),
    ]);
    r.chat.bots.set("s1", "granite");
    r.chat.snapshots.push(snapshot(), snapshot({ id: "s1", status: "waiting", message_count: 1 }));
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    expect(r.sent.map((m) => m.to)).toEqual([TOKEN_B, "ExponentPushToken[FIXTURE-watch-c]"]);
  });

  test("at most 30 pushes a minute per phone; the rest are dropped and counted", async () => {
    const r = await rig();
    r.chat.bots.set("s0", "granite");
    const sessions = Array.from({ length: 31 }, (_, i) => ({
      id: `s${i}`,
      status: "waiting",
      message_count: 1,
    }));
    for (const s of sessions) r.chat.bots.set(s.id, "granite");
    r.chat.snapshots.push(snapshot(), snapshot(...sessions));
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    expect(r.sent).toHaveLength(30);
    expect(w.notifier.droppedTotal()).toBe(1);
    expect(r.logs.join("\n")).toContain("a reached 30 pushes a minute");
    expect(r.logs.join("\n")).not.toContain("FIXTURE-watch-a");
  });
});

describe("receipts", () => {
  test("a DeviceNotRegistered ticket removes the phone at once", async () => {
    const r = await rig([device("a", TOKEN_A), device("b", TOKEN_B)]);
    r.ticket = (m) =>
      m.to === TOKEN_A
        ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
        : { status: "ok", id: "t-b" };
    r.chat.bots.set("s1", "granite");
    r.chat.snapshots.push(snapshot(), snapshot({ id: "s1", status: "waiting", message_count: 1 }));
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    expect((await r.devices.list()).map((d) => d.device_id)).toEqual(["b"]);
    expect(r.logs.join("\n")).toContain("push device a removed: DeviceNotRegistered");
  });

  test("ok tickets are asked about after 15 minutes; DeviceNotRegistered receipts prune", async () => {
    const r = await rig([device("a", TOKEN_A), device("b", TOKEN_B)]);
    r.chat.bots.set("s1", "granite");
    r.chat.snapshots.push(snapshot(), snapshot({ id: "s1", status: "waiting", message_count: 1 }));
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    expect(w.notifier.pendingReceipts()).toBe(2);

    await w.notifier.pollReceipts();
    expect(r.receiptAsks).toEqual([]);

    r.receipts.set("ticket-0", {
      status: "error",
      message: "gone",
      details: { error: "DeviceNotRegistered" },
    });
    r.receipts.set("ticket-1", { status: "ok" });
    r.clock.now += RECEIPT_DELAY_MS;
    await w.notifier.pollReceipts();
    expect(r.receiptAsks).toEqual([["ticket-0", "ticket-1"]]);
    expect((await r.devices.list()).map((d) => d.device_id)).toEqual(["b"]);
    expect(w.notifier.pendingReceipts()).toBe(0);
  });

  test("a receipt for a token the phone has since replaced does not unregister it", async () => {
    const r = await rig();
    r.chat.bots.set("s1", "granite");
    r.chat.snapshots.push(snapshot(), snapshot({ id: "s1", status: "waiting", message_count: 1 }));
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    await r.devices.upsert(device("a", "ExponentPushToken[FIXTURE-watch-new]"));
    r.receipts.set("ticket-0", {
      status: "error",
      message: "gone",
      details: { error: "DeviceNotRegistered" },
    });
    r.clock.now += RECEIPT_DELAY_MS;
    await w.notifier.pollReceipts();
    expect((await r.devices.list()).map((d) => d.device_id)).toEqual(["a"]);
  });
});

describe("the loop", () => {
  test("a gateway that does not answer backs off 3 s → 30 s, recovers to 3 s, and re-baselines", async () => {
    const waits: number[] = [];
    const stop = new AbortController();
    const r = await rig([device("a", TOKEN_A)], {
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length >= 10) stop.abort();
      },
    });
    r.chat.bots.set("s1", "granite");
    const down = new Error("chat socket failed: ws://127.0.0.1:9119/api/ws");
    r.chat.snapshots.push(
      snapshot(),
      down,
      down,
      down,
      down,
      down,
      down,
      snapshot({ id: "s1", status: "waiting", message_count: 1 }),
      snapshot({ id: "s1", status: "waiting", message_count: 1 }),
      snapshot({ id: "s1", status: "waiting", message_count: 1 }),
    );
    await createWatcher(r.deps).run(stop.signal);
    expect(waits).toEqual([
      3_000,
      3_000,
      6_000,
      12_000,
      24_000,
      WATCH_BACKOFF_MAX_MS,
      WATCH_BACKOFF_MAX_MS,
      3_000,
      3_000,
      3_000,
    ]);
    // The first answer after the outage was a baseline: a gateway that came back
    // is a new process whose sessions were not watched across the gap, so the
    // one already waiting raises nothing rather than a stale alert.
    expect(r.sent).toEqual([]);
    expect(r.logs.filter((l) => l.includes("backing off"))).toHaveLength(1);
    expect(r.logs.filter((l) => l.includes("answering again"))).toHaveLength(1);
  });

  test("a box whose Hermes unit is down idles without asking the gateway", async () => {
    const waits: number[] = [];
    const stop = new AbortController();
    const r = await rig([device("a", TOKEN_A)], {
      gatewayUp: async () => false,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length >= 2) stop.abort();
      },
    });
    await createWatcher(r.deps).run(stop.signal);
    expect(waits).toEqual([WATCH_BACKOFF_MAX_MS, WATCH_BACKOFF_MAX_MS]);
    expect(r.chat.rpcCalls).toBe(0);
  });

  test("tick never throws, even when the device store does", async () => {
    const r = await rig();
    r.chat.bots.set("s1", "granite");
    r.chat.snapshots.push(snapshot(), snapshot({ id: "s1", status: "waiting", message_count: 1 }));
    const broken: PushDeviceStore = {
      list: async () => {
        throw new Error("disk gone");
      },
      upsert: async () => ({ evicted: null }),
      remove: async () => false,
    };
    const w = createWatcher({ ...r.deps, devices: broken });
    await w.tick();
    const outcome = await step(r, w);
    expect(outcome.kind).toBe("ok");
    expect(r.logs.join("\n")).toContain("could not notify (disk gone)");
  });
});

describe("parsing", () => {
  test("parseActiveList keys on session_key, falls back to id, skips malformed rows", () => {
    expect(
      parseActiveList({
        sessions: [
          { id: "live-1", session_key: "stored-1", status: "idle", message_count: 2, preview: "p" },
          { id: "live-2", session_key: "", status: "working", message_count: 0 },
          { id: "live-3", status: "idle" },
          "junk",
        ],
      }),
    ).toEqual([
      { key: "stored-1", status: "idle", message_count: 2, preview: "p" },
      { key: "live-2", status: "working", message_count: 0, preview: "" },
    ]);
    expect(parseActiveList({})).toBeNull();
    expect(parseActiveList(null)).toBeNull();
  });

  test("tailVerdict: newest failure wins, then newest bot row; a user row first is nothing", () => {
    expect(tailVerdict([message("bot", "a"), message("bot", "b")])).toEqual({
      kind: "turn.done",
      text: "b",
    });
    expect(tailVerdict([message("bot", "", { error: "boom" })])).toEqual({
      kind: "turn.error",
      text: "boom",
    });
    expect(tailVerdict([message("bot", "a"), message("system", "note")])).toEqual({
      kind: "turn.done",
      text: "a",
    });
    expect(tailVerdict([message("user", "q")])).toBeNull();
    expect(tailVerdict([])).toBeNull();
  });
});
