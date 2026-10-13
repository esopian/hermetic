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
import {
  PUSH_DEVICE_TTL_MS,
  deviceTag,
  pushDeviceStore,
  type PushDeviceStore,
} from "../src/push/devices.ts";
import { NEEDS_ACTION_CATEGORY, RECEIPT_DELAY_MS, contentFreeBody } from "../src/push/notify.ts";
import {
  EVENT_COUNTER_MEMORY,
  TAILNET_PRUNE_MS,
  UNKNOWN_BOT,
  WATCH_BACKOFF_MAX_MS,
  WATCH_POLL_MS,
  createWatcher,
  parseActiveList,
  tailVerdict,
  type WatchDeps,
} from "../src/push/watch.ts";
import { redactValue } from "../src/redact.ts";
import { bunChatSocket, chatSocketFailed } from "../src/push/socket.ts";
import { tailnetLogins, type TailnetMembers } from "../src/tailscale.ts";
import { FakeHost } from "./fake-host.ts";

const INSTANCE = "atlas";
const FLEET = "fxtr0001";
const TOKEN_A = "ExponentPushToken[FIXTURE-watch-a]";
const TOKEN_B = "ExponentPushToken[FIXTURE-watch-b]";

type Live = {
  id: string;
  status: string;
  message_count: number;
  preview?: string;
  /** Upstream's epoch seconds; long ago unless a test says otherwise. */
  last_active?: number;
};

function snapshot(...sessions: Live[]): unknown {
  return {
    sessions: sessions.map((s) => ({
      id: `live-${s.id}`,
      session_key: s.id,
      status: s.status,
      message_count: s.message_count,
      preview: s.preview ?? "",
      last_active: s.last_active ?? 1,
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
  /** The store's host: its clock is what registrations expire against. */
  host: FakeHost;
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
  for (const d of devices) await store.upsert(d, OWNER);
  const r: Rig = {
    host,
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

const OWNER = "evan@example.com";

function device(
  id: string,
  token: string,
  listening: MobilePushDevice["listening"] = "all",
  previews = false,
): MobilePushDevice {
  return { device_id: id, token, platform: "ios", app_version: "1.0.0", listening, previews };
}

/** A phone that opted into previews. */
function previewing(id: string, token: string): MobilePushDevice {
  return device(id, token, "all", true);
}

/** Advance the clock one poll and tick. */
async function step(r: Rig, watcher: ReturnType<typeof createWatcher>) {
  r.clock.now += WATCH_POLL_MS;
  return watcher.tick();
}

/**
 * The `<n>` of the k-th event a session raises under a watcher created at the
 * rig's current clock: its counters start at that moment, in seconds.
 */
function nth(r: Rig, k: number): number {
  return Math.floor(r.clock.now / 1000) + k;
}

/** The rig's clock moved by `offsetMs`, as a tail row's `at`. */
function isoAt(r: Rig, offsetMs: number): string {
  return new Date(r.clock.now + offsetMs).toISOString();
}

/** The rig's clock in upstream's `last_active` unit, epoch seconds. */
function nowSeconds(r: Rig): number {
  return r.clock.now / 1000;
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
    const r = await rig([previewing("a", TOKEN_A)]);
    const n = nth(r, 1);
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
          dedupe: `atlas:s1:${n}:turn.done`,
        },
        sound: "default",
      },
    ]);
    expect(MobilePushData.safeParse(r.sent[0]?.data).success).toBe(true);
    expect(r.chat.historyCalls).toEqual([{ bot: "granite", session: "s1" }]);
  });

  test("a tail row with a failure is turn.error, its text redacted and cut to 140", async () => {
    const r = await rig([previewing("a", TOKEN_A)]);
    const n = nth(r, 1);
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
    expect(data.dedupe).toBe(`atlas:s1:${n}:turn.error`);
    expect(push?.body).not.toContain(secret);
    expect(push?.body).toContain("«redacted»");
    expect(push?.body?.length).toBe(140);
    expect(push?.body?.endsWith("…")).toBe(true);
  });

  test("→ waiting is needs_action: high priority, its category, once per waiting spell", async () => {
    const r = await rig();
    const base = nth(r, 0);
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
    // Two waiting spells in one turn are two events, at the same message count;
    // still waiting at 5 is not a new arrival.
    const spell = (k: number): ExpoPushMessage => ({
      to: TOKEN_A,
      title: "atlas",
      body: "atlas is waiting on you",
      data: {
        fleet_id: FLEET,
        instance: INSTANCE,
        bot: "atlas",
        session: "s1",
        kind: "needs_action",
        dedupe: `atlas:s1:${base + k}:needs_action`,
      },
      sound: "default",
      priority: "high",
      categoryId: NEEDS_ACTION_CATEGORY,
    });
    expect(r.sent).toEqual([spell(1), spell(2)]);
  });

  test("a session first seen idle with a reply since the last poll is a message; empty is nothing", async () => {
    const r = await rig([previewing("a", TOKEN_A)]);
    const n = nth(r, 1);
    r.chat.bots.set("cron-1", "granite");
    // The list's own preview is the session's opening line; the push quotes
    // the reply, read off the tail like a settled turn's.
    r.chat.tails.set("cron-1", [
      message("user", "Run the daily digest"),
      message("bot", "Daily digest: 3 new tickets", { at: isoAt(r, 1_000) }),
    ]);
    // Active a second after the baseline poll, and before the next.
    const since = nowSeconds(r) + 1;
    r.chat.snapshots.push(
      snapshot(),
      snapshot(
        {
          id: "cron-1",
          status: "idle",
          message_count: 2,
          preview: "Run the daily digest",
          last_active: since,
        },
        { id: "fresh", status: "idle", message_count: 0, last_active: since },
      ),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    expect(r.sent.map((m) => [m.body, (m.data as MobilePushData).dedupe])).toEqual([
      ["Daily digest: 3 new tickets", `atlas:cron-1:${n}:message`],
    ]);
    expect(r.chat.historyCalls).toEqual([{ bot: "granite", session: "cron-1" }]);
  });

  test("a session resumed into the list is news only if its tail says something new", async () => {
    // `respond`, `compact` and a subagent reconcile resume a session into the
    // list without anything new having been said in it; upstream stamps the
    // live record's `last_active` with the moment it built it, so the list
    // alone always calls it fresh.
    for (const [said, pushes] of [
      [-60_000, []],
      [1_000, [["message", "the reply"]]],
    ] satisfies Array<[number, string[][]]>) {
      const r = await rig([previewing("a", TOKEN_A)]);
      r.chat.bots.set("old", "granite");
      r.chat.tails.set("old", [message("bot", "the reply", { at: isoAt(r, said) })]);
      const w = createWatcher(r.deps);
      r.chat.snapshots.push(
        snapshot(),
        snapshot({
          id: "old",
          status: "idle",
          message_count: 8,
          last_active: nowSeconds(r) + WATCH_POLL_MS / 1000 - 0.5,
        }),
      );
      await w.tick();
      await step(r, w);
      expect(r.sent.map((m) => [(m.data as MobilePushData).kind, m.body])).toEqual(pushes);
    }
  });

  test("a cold resume hydrating 0 → N is no turn; a fresh tail row makes it one", async () => {
    // Upstream lists a deferred record before its history is hydrated, so the
    // count climbs with nothing said — through `starting` (the agent build,
    // which waits on that hydration) or straight from `idle`.
    for (const middle of ["idle", "starting"]) {
      for (const [said, pushes] of [
        [-60_000, []],
        // Polls at +3 s, +6 s and +9 s: written between the last two.
        [7_000, [["turn.done", "the reply"]]],
      ] satisfies Array<[number, string[][]]>) {
        const r = await rig([previewing("a", TOKEN_A)]);
        r.chat.bots.set("old", "granite");
        r.chat.tails.set("old", [
          message("user", "earlier"),
          message("bot", "the reply", { at: isoAt(r, said) }),
        ]);
        const fresh = nowSeconds(r) + 2;
        r.chat.snapshots.push(
          snapshot(),
          snapshot({ id: "old", status: "idle", message_count: 0, last_active: fresh }),
          snapshot({ id: "old", status: middle, message_count: 0, last_active: fresh }),
          snapshot({ id: "old", status: "idle", message_count: 8, last_active: fresh }),
        );
        const w = createWatcher(r.deps);
        await w.tick();
        for (let i = 0; i < 3; i++) await step(r, w);
        expect(r.sent.map((m) => [(m.data as MobilePushData).kind, m.body])).toEqual(pushes);
      }
    }
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

  test("a tail that cannot be read still says the turn finished, content-free", async () => {
    const r = await rig([previewing("a", TOKEN_A)]);
    r.chat.bots.set("s1", "granite");
    r.chat.tails.set("s1", new Error("history unavailable"));
    r.chat.snapshots.push(
      snapshot({ id: "s1", status: "working", message_count: 1 }),
      snapshot({ id: "s1", status: "idle", message_count: 2, preview: "the opening line" }),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    // Never the list's preview, which is the opening line, not the reply.
    expect(r.sent.map((m) => [(m.data as MobilePushData).kind, m.body])).toEqual([
      ["turn.done", "granite replied"],
    ]);
  });

  test("an unknown session forces one map refresh, then pushes as `unknown`, message only", async () => {
    const r = await rig();
    const base = nth(r, 0);
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
        // The waiting spell that could not be pushed still counted as an event.
        dedupe: `atlas:ghost:${base + 2}:message`,
      },
    ]);
    expect(r.sent.map((m) => m.body)).toEqual([`New message from ${UNKNOWN_BOT}`]);
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
    expect(r.logs.join("\n")).toContain(`${deviceTag("a")} reached 30 pushes a minute`);
    expect(r.logs.join("\n")).not.toContain("FIXTURE-watch-a");
  });
});

describe("expiry", () => {
  test(`a registration unrenewed for ${PUSH_DEVICE_TTL_MS / 3_600_000} hours is skipped by the notifier`, async () => {
    const r = await rig([device("a", TOKEN_A), device("b", TOKEN_B)]);
    // Renew only b, an hour before the TTL runs out for a.
    r.host.advance(PUSH_DEVICE_TTL_MS - 3_600_000);
    await r.devices.upsert(device("b", TOKEN_B), OWNER);
    r.host.advance(3_600_000);
    r.chat.bots.set("s1", "granite");
    r.chat.snapshots.push(snapshot(), snapshot({ id: "s1", status: "waiting", message_count: 1 }));
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    expect(r.sent.map((m) => m.to)).toEqual([TOKEN_B]);
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
    expect(r.logs.join("\n")).toContain(`push device ${deviceTag("a")} removed: DeviceNotRegistered`);
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
    await r.devices.upsert(device("a", "ExponentPushToken[FIXTURE-watch-new]"), OWNER);
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
      upsert: async () => ({ ok: true, evicted: null }),
      unregister: async () => ({ ok: true, removed: false }),
      remove: async () => false,
      pruneOwners: async () => 0,
    };
    const w = createWatcher({ ...r.deps, devices: broken });
    await w.tick();
    const outcome = await step(r, w);
    expect(outcome.kind).toBe("ok");
    expect(r.logs.join("\n")).toContain("could not notify (disk gone)");
  });
});

describe("previews are opt-in", () => {
  test("a phone that did not opt in gets a content-free body; one that did gets the excerpt", async () => {
    const r = await rig([device("a", TOKEN_A), previewing("b", TOKEN_B)]);
    r.chat.bots.set("s1", "granite");
    r.chat.tails.set("s1", [message("user", "hi"), message("bot", "The secret plan is ready.")]);
    r.chat.snapshots.push(
      snapshot({ id: "s1", status: "working", message_count: 1 }),
      snapshot({ id: "s1", status: "idle", message_count: 2 }),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    expect(r.sent.map((m) => [m.to, m.body])).toEqual([
      [TOKEN_A, "granite replied"],
      [TOKEN_B, "The secret plan is ready."],
    ]);
    // The data is the same for both: the session id is routing, not a preview.
    expect(r.sent[0]?.data).toEqual(r.sent[1]?.data);
    expect(MobilePushData.parse(r.sent[0]?.data).session).toBe("s1");
  });

  test("the content-free body of each kind names the bot and nothing else", () => {
    expect(contentFreeBody("turn.done", "granite")).toBe("granite replied");
    expect(contentFreeBody("turn.error", "granite")).toBe("granite hit an error");
    expect(contentFreeBody("needs_action", "granite")).toBe("granite is waiting on you");
    expect(contentFreeBody("message", "granite")).toBe("New message from granite");
  });

  test("a failed turn is content-free too unless the phone opted in", async () => {
    const r = await rig();
    r.chat.bots.set("s1", "granite");
    r.chat.tails.set("s1", [message("bot", "", { failure: { code: "AUTH", message: "key refused" } })]);
    r.chat.snapshots.push(
      snapshot({ id: "s1", status: "working", message_count: 1 }),
      snapshot({ id: "s1", status: "idle", message_count: 2 }),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    await step(r, w);
    expect(r.sent.map((m) => m.body)).toEqual(["granite hit an error"]);
  });
});

describe("a failed poll", () => {
  for (const [label, failure] of [
    ["a throw", new Error("timed out")],
    ["an answer without a list", {}],
  ] as const) {
    test(`${label} keeps what was seen: idle → working → (fails) → idle still pushes turn.done`, async () => {
      const r = await rig();
      r.chat.bots.set("s1", "granite");
      r.chat.tails.set("s1", [message("user", "go"), message("bot", "done")]);
      r.chat.snapshots.push(
        snapshot({ id: "s1", status: "idle", message_count: 2 }),
        snapshot({ id: "s1", status: "working", message_count: 3 }),
        failure,
        snapshot({ id: "s1", status: "idle", message_count: 4 }),
      );
      const w = createWatcher(r.deps);
      await w.tick();
      await step(r, w);
      expect((await step(r, w)).kind).toBe("down");
      await step(r, w);
      expect(r.sent.map((m) => (m.data as MobilePushData).kind)).toEqual(["turn.done"]);
    });
  }

  test("a Hermes unit that was down re-baselines: what settled meanwhile pushes nothing", async () => {
    let up = true;
    const r = await rig([device("a", TOKEN_A)], { gatewayUp: async () => up });
    r.chat.bots.set("s1", "granite");
    r.chat.tails.set("s1", [message("bot", "done")]);
    r.chat.snapshots.push(
      snapshot({ id: "s1", status: "working", message_count: 3 }),
      snapshot({ id: "s1", status: "idle", message_count: 4 }),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    up = false;
    expect((await step(r, w)).kind).toBe("idle");
    up = true;
    await step(r, w);
    expect(r.sent).toEqual([]);
  });
});

describe("the event counter", () => {
  test("a message_count that drops mid-turn (compaction) still settles it; at rest it is no event", async () => {
    const r = await rig();
    const base = nth(r, 0);
    r.chat.bots.set("s1", "granite");
    r.chat.tails.set("s1", [message("user", "go"), message("bot", "compacted and done")]);
    r.chat.snapshots.push(
      snapshot({ id: "s1", status: "working", message_count: 40 }),
      snapshot({ id: "s1", status: "idle", message_count: 6 }),
      snapshot({ id: "s1", status: "idle", message_count: 5 }),
      snapshot({ id: "s1", status: "working", message_count: 6 }),
      snapshot({ id: "s1", status: "idle", message_count: 6 }),
      snapshot({ id: "s1", status: "idle", message_count: 7 }),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    for (let i = 0; i < 5; i++) await step(r, w);
    // The compacted turn, then the next one: two events with two keys, though
    // the second settles at a count the session has had before.
    expect(r.sent.map((m) => (m.data as MobilePushData).dedupe)).toEqual([
      `atlas:s1:${base + 1}:turn.done`,
      `atlas:s1:${base + 2}:turn.done`,
    ]);
  });

  test("a session that leaves the list and returns never reuses an event number", async () => {
    const r = await rig();
    const base = nth(r, 0);
    r.chat.bots.set("s1", "granite");
    r.chat.snapshots.push(
      snapshot({ id: "s1", status: "working", message_count: 1 }),
      snapshot({ id: "s1", status: "waiting", message_count: 1 }),
      snapshot(),
      snapshot({ id: "s1", status: "waiting", message_count: 1 }),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    for (let i = 0; i < 3; i++) await step(r, w);
    expect(r.sent.map((m) => (m.data as MobilePushData).dedupe)).toEqual([
      `atlas:s1:${base + 1}:needs_action`,
      `atlas:s1:${base + 2}:needs_action`,
    ]);
  });

  test("a session whose counter was forgotten starts past the number it last used", async () => {
    const r = await rig();
    r.chat.bots.set("s0", "granite");
    const crowd = Array.from({ length: EVENT_COUNTER_MEMORY }, (_, i) => ({
      id: `other-${i}`,
      status: "waiting",
      message_count: 1,
    }));
    r.chat.snapshots.push(
      snapshot({ id: "s0", status: "working", message_count: 1 }),
      snapshot({ id: "s0", status: "waiting", message_count: 1 }),
      // Every other session's first event: s0's counter is the stalest, and forgotten.
      snapshot({ id: "s0", status: "waiting", message_count: 1 }, ...crowd),
      snapshot({ id: "s0", status: "working", message_count: 1 }),
      snapshot({ id: "s0", status: "waiting", message_count: 1 }),
    );
    const w = createWatcher(r.deps);
    await w.tick();
    for (let i = 0; i < 4; i++) await step(r, w);
    const keys = r.sent.map((m) => (m.data as MobilePushData).dedupe);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  test("a restarted watcher starts its counters past any the last one reached", async () => {
    const r = await rig();
    r.chat.bots.set("s1", "granite");
    r.chat.snapshots.push(
      snapshot({ id: "s1", status: "working", message_count: 1 }),
      snapshot({ id: "s1", status: "waiting", message_count: 1 }),
    );
    const first = createWatcher(r.deps);
    await first.tick();
    await step(r, first);
    r.chat.snapshots.splice(0, r.chat.snapshots.length);
    r.chat.snapshots.push(
      snapshot({ id: "s1", status: "working", message_count: 1 }),
      snapshot({ id: "s1", status: "waiting", message_count: 1 }),
    );
    r.clock.now += WATCH_POLL_MS;
    const second = createWatcher(r.deps);
    await second.tick();
    await step(r, second);
    const keys = r.sent.map((m) => (m.data as MobilePushData).dedupe);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("tailnet prune", () => {
  const STATUS = {
    Self: { DNSName: "atlas.tail1234.ts.net.", HostName: "atlas" },
    Peer: {
      "nodekey:1": { DNSName: "phone.tail1234.ts.net.", HostName: "phone", UserID: 1 },
      "nodekey:2": { DNSName: "bravo.tail1234.ts.net.", HostName: "bravo", UserID: 2 },
    },
    User: {
      "1": { ID: 1, LoginName: OWNER, DisplayName: "Evan" },
      "2": { ID: 2, LoginName: "tagged-devices", DisplayName: "tagged devices" },
    },
  };

  test("tailnetLogins reads User logins and every node's name from tailscale status --json", async () => {
    const host = new FakeHost();
    host.when("tailscale status --json", { stdout: JSON.stringify(STATUS) });
    const members = await tailnetLogins(host);
    expect([...(members?.logins ?? [])].sort()).toEqual([OWNER, "tagged-devices"].sort());
    expect(members?.nodes.has("phone.tail1234.ts.net")).toBe(true);
    expect(members?.nodes.has("bravo.tail1234.ts.net")).toBe(true);
    expect(members?.nodes.has("atlas.tail1234.ts.net")).toBe(true);

    host.when("tailscale status --json", { code: 1, stdout: "" });
    expect(await tailnetLogins(host)).toBeNull();
    host.when("tailscale status --json", { stdout: "{not json" });
    expect(await tailnetLogins(host)).toBeNull();
    host.when("tailscale status --json", { stdout: JSON.stringify({ ...STATUS, User: {} }) });
    expect(await tailnetLogins(host)).toBeNull();
  });

  test("owners no longer on the tailnet lose their registrations, at most every ten minutes", async () => {
    const members: { current: TailnetMembers | null } = {
      current: {
        logins: new Set([OWNER]),
        nodes: new Set(["phone.tail1234.ts.net", "bravo.tail1234.ts.net"]),
      },
    };
    let asked = 0;
    const r = await rig([device("a", TOKEN_A)], {
      tailnetLogins: async () => {
        asked += 1;
        return members.current;
      },
    });
    await r.devices.upsert(device("gone", TOKEN_B), "former@example.com");
    await r.devices.upsert(
      device("ci", "ExponentPushToken[FIXTURE-watch-ci]"),
      "node:bravo.tail1234.ts.net.",
    );
    await r.devices.upsert(
      device("old-ci", "ExponentPushToken[FIXTURE-watch-oc]"),
      "node:charlie.tail1234.ts.net",
    );
    r.chat.snapshots.push(snapshot());
    const w = createWatcher(r.deps);
    await w.tick();
    expect(asked).toBe(1);
    expect((await r.devices.list()).map((d) => d.device_id)).toEqual(["a", "ci"]);
    expect(r.logs.join("\n")).toContain("dropped 2 registrations whose owner left the tailnet");

    // Within ten minutes it does not ask again.
    await r.devices.upsert(device("gone", TOKEN_B), "former@example.com");
    await step(r, w);
    expect(asked).toBe(1);
    expect((await r.devices.list()).map((d) => d.device_id)).toContain("gone");

    // No answer is no evidence: nothing is pruned.
    r.clock.now += TAILNET_PRUNE_MS;
    members.current = null;
    await w.tick();
    expect(asked).toBe(2);
    expect((await r.devices.list()).map((d) => d.device_id)).toContain("gone");

    r.clock.now += TAILNET_PRUNE_MS;
    members.current = { logins: new Set([OWNER]), nodes: new Set() };
    await w.tick();
    expect((await r.devices.list()).map((d) => d.device_id)).toEqual(["a"]);
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
      { key: "stored-1", status: "idle", message_count: 2, last_active: null },
      { key: "live-2", status: "working", message_count: 0, last_active: null },
    ]);
    // `last_active` in upstream's epoch seconds, in milliseconds, or ISO.
    const at = (value: unknown) =>
      parseActiveList({
        sessions: [{ id: "x", status: "idle", message_count: 1, last_active: value }],
      })?.[0]?.last_active;
    expect(at(1789663313.5)).toBe(1789663313500);
    expect(at(1789663313500)).toBe(1789663313500);
    expect(at("2026-09-01T12:00:00.000Z")).toBe(Date.parse("2026-09-01T12:00:00.000Z"));
    expect(at("soon")).toBeNull();
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

describe("the chat socket", () => {
  test("a socket that fails to open says where, never the URL's query (it holds the token)", async () => {
    const url = "ws://127.0.0.1:9119/api/ws?token=FIXTURE-dashboard-token";
    expect(chatSocketFailed(url)).toBe("chat socket failed: ws://127.0.0.1:9119/api/ws");
    expect(chatSocketFailed("not a url ?token=FIXTURE-dashboard-token")).toBe("chat socket failed");

    // Bun's WebSocket, replaced for the one call by one that fails at once.
    class FailingSocket extends EventTarget {
      constructor(_url: string, _opts?: unknown) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("error")));
      }
      send(): void {}
      close(): void {}
    }
    const real = globalThis.WebSocket;
    globalThis.WebSocket = FailingSocket as unknown as typeof WebSocket;
    try {
      const socket = bunChatSocket(url, {});
      const error = await socket.opened.then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error?.message).toBe("chat socket failed: ws://127.0.0.1:9119/api/ws");
      expect(error?.message).not.toContain("FIXTURE-dashboard-token");
    } finally {
      globalThis.WebSocket = real;
    }
  });
});
