/**
 * Chat as a notification source (§4.9, §9.2).
 *
 * Two properties are under test here, and they are the two the design argues
 * about rather than the two that are easy to assert.
 *
 * **A reply hermetic streamed to somebody raises nothing.** `chat.message`
 * comes from the roster read and never from a turn, because a turn's answer is
 * already in the hands of whoever asked for it. The tests below therefore drive
 * `chat.send` to completion and assert the inbox stayed empty, which is the
 * assertion that fails if a later change "helpfully" notifies from the stream.
 *
 * **A failure that keeps holding writes one row, not one per attempt.** That is
 * the `key` rule the advisories already use, applied to a laptop that has
 * fallen off the tailnet and is retrying — the case where an inbox that wrote
 * an event per attempt would bury everything else in it.
 *
 * Each rule is tested twice: once against the observer in `notifications.ts`,
 * where it lives, and once through `createChat`, which is the seam that would
 * silently stop delivering if somebody moved the call.
 */
import { describe, expect, test } from "bun:test";
import { MemoryInstanceListeningStore } from "../src/chat/instance-listening.ts";
import { Database } from "bun:sqlite";
import { createChat } from "../src/chat/chat.ts";
import type { ChatDeps } from "../src/chat/chat.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import {
  CHAT_ERROR_PREFIX,
  CHAT_EVENT_PREFIX,
  CHAT_MESSAGE_PREFIX,
  MemoryNotificationStore,
  chatSeenSubject,
  notificationsList,
  notifyChatError,
  notifyProcessEvent,
  observeChatActivity,
  resolveChatErrors,
} from "../src/chat/notifications.ts";
import type { NotificationDeps, NotificationStore } from "../src/chat/notifications.ts";
import { SqliteChatFenceStore, SqliteNotificationStore, migrate } from "../src/local/db/index.ts";
import {
  CHAT_FENCE_TTL_MS,
  MemoryChatFenceStore,
  acquireChatFence,
  chatFenced,
} from "../src/chat/chat-fence.ts";
import { mapSwarm } from "../src/chat/hermes/hermes-chat.ts";
import { PROFILES_LIST_RESULT, SESSION_LIST_POPULATED } from "./fixtures/hermes-frames.ts";
import type { BoxAddress, HermesChatClient } from "../src/chat/hermes/hermes-chat.ts";
import type { StackInfo } from "../src/backend/types.ts";
import type {
  Agent,
  ChatFrame,
  ChatMessage,
  Notification,
  ProcessEventBlock,
  Session,
  Swarm,
} from "../src/schema/index.ts";

const FLEET = FIXTURE_CONFIG.fleet_id;
const AT = "2026-09-17T09:00:00.000Z";
const LATER = "2026-09-17T09:31:40.000Z";

const backend = seedFixtureFleet(new MemoryBackend());
const agents = await backend.store.agents.scan();
const seeded = await backend.store.fleet.get();
if (seeded === null) throw new Error("the fixture seed writes a fleet item");
const fleetItem = seeded;

function depsFor(store: NotificationStore, fleet: string | null = FLEET): NotificationDeps {
  return { store, fleet: () => fleet };
}

function rows(store: NotificationStore, fleet: string | null = FLEET): Notification[] {
  return notificationsList(depsFor(store, fleet)).notifications;
}

function bot(over: Partial<Swarm["bots"][number]> = {}): Swarm["bots"][number] {
  return {
    instance: "atlas",
    name: "default",
    title: "Bot Chat",
    description: null,
    is_default: true,
    model: "claude-sonnet-4-6",
    section: null,
    avatar_seed: `${FLEET}/atlas/default`,
    last_message_at: AT,
    unread: 0,
    needs_action: false,
    muted: false,
    warm: true,
    ...over,
  };
}

function swarm(instance: string, over: Partial<Swarm> = {}): Swarm {
  return {
    instance,
    reachable: true,
    unreachable_reason: null,
    bots: [bot({ instance })],
    rooms: [],
    warm_slots: { used: 1, total: 3 },
    sections: [],
    ...over,
  };
}

/** The session this file's turns speak into, and the box's coordinate for it. */
const SESSION = "s-turn";
/**
 * What the *box* stamps the reply with, on the box's clock.
 *
 * Deliberately not `LATER`, which is what the tests below hand the surface as
 * the *laptop's* clock. The two are different numbers because they are
 * different clocks, and a test in which they agree cannot see the defect this
 * file is about.
 */
const REPLY = "2026-09-17T10:15:00.000Z";

function sessionRow(over: Partial<Session> = {}): Session {
  return {
    id: SESSION,
    instance: "atlas",
    bot: "default",
    kind: "canonical",
    origin: "cli",
    origin_detail: null,
    title: "a thread",
    preview: null,
    last_message_at: AT,
    unread: 0,
    turn_count: 1,
    ...over,
  };
}

/** When the conversation *opened*, which is not when it was last spoken in. */
const OPENED = "2026-09-17T08:00:00.000Z";

/** Unix seconds, the float a real box sends. */
function epoch(at: string): number {
  return Date.parse(at) / 1000;
}

/**
 * A box whose transcript actually moves, mapped by the **real** roster mapper.
 *
 * The two reads are deliberately built from different upstream shapes, because
 * on a real box they *are* different shapes: `profiles.list` carries a
 * `last_session` with `last_active`, and `session.list` carries `started_at`
 * and nothing else. A double that fed both reads one timestamp made an
 * attribution rule of "the session list agrees with the roster" look correct
 * while it could never hold on a real 0.21.3 box — so the double's session read
 * answers `OPENED` and its roster read answers the coordinate, and the only
 * thing that can tie them together is the session id the mapper carries.
 */
function movingBox(
  state: { at: string; session?: string },
  over: Partial<HermesChatClient> = {},
): Partial<HermesChatClient> {
  const profiles = (): unknown => ({
    profiles: [
      {
        name: "default",
        display_name: "Bot Chat",
        is_default: true,
        last_session: {
          id: state.session ?? SESSION,
          title: "a thread",
          started_at: epoch(OPENED),
          last_active: epoch(state.at),
          message_count: 2,
        },
      },
    ],
  });
  return {
    swarm: (box: BoxAddress) => Promise.resolve(mapSwarm(box, profiles(), null, null, null)),
    // `started_at`, as a real `session.list` row sends it: the same
    // conversation, a different number.
    sessions: () =>
      Promise.resolve([sessionRow({ id: state.session ?? SESSION, last_message_at: OPENED })]),
    ...over,
  };
}

/** A turn that says one thing, records it on the box's clock, and finishes. */
function replyingTurn(state: { at: string }, at: string = REPLY): () => AsyncIterable<ChatFrame> {
  return () =>
    (async function* () {
      yield { type: "delta", seq: 0, message: "m1", text: "the answer" } as ChatFrame;
      // The box writes the reply down before it reports `done`, which is the
      // order the real gateway uses and the order attribution depends on.
      state.at = at;
      yield { type: "done", seq: 0, message: "m1" } as ChatFrame;
    })();
}

function agentNamed(name: string): Agent {
  const found = agents.find((a) => a.name === name);
  if (found === undefined) throw new Error(`the fixture has no agent ${name}`);
  return found;
}

/** A chat surface over a hand-written adapter and a real inbox. */
function harness(
  client: Partial<HermesChatClient>,
  store: NotificationStore,
  deps: Partial<ChatDeps> = {},
): ReturnType<typeof createChat> {
  const instanceListening = new MemoryInstanceListeningStore();
  for (const agent of agents) instanceListening.set(fleetItem.fleet_id, agent.name, true);
  const hermes: HermesChatClient = {
    token: (box: BoxAddress) => Promise.resolve(`token-${box.instance}`),
    swarm: (box: BoxAddress) => Promise.resolve(swarm(box.instance)),
    sessions: () => Promise.resolve([]),
    history: () => Promise.resolve([]),
    send: () => (async function* () {})(),
    abort: () => Promise.resolve(),
    ...client,
  };
  return createChat({
    guardFleet: () =>
      Promise.resolve({ config: FIXTURE_CONFIG, fleet: fleetItem, stack: {} as StackInfo }),
    getAgent: (name: string) => Promise.resolve(agentNamed(name)),
    listAgents: () => Promise.resolve(agents),
    instanceListening,
    hermes,
    notifications: depsFor(store),
    ...deps,
  });
}

/**
 * An adapter whose stream fails before it says anything.
 *
 * Written as an iterable rather than as a generator that throws on its first
 * line, because a generator with no `yield` in it is not a generator as far as
 * the linter is concerned — and hanging an unreachable `yield` under an
 * exemption comment to satisfy that is a worse lie than this is.
 */
function failingStream(message: string): () => AsyncIterable<ChatFrame> {
  return () => ({
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<ChatFrame>> => Promise.reject(new Error(message)),
    }),
  });
}

async function collect(frames: AsyncIterable<ChatFrame>): Promise<ChatFrame[]> {
  const out: ChatFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

describe("chat.message: a reply nobody here asked for", () => {
  test("the first sighting of a bot is silent", () => {
    const store = new MemoryNotificationStore();
    observeChatActivity(depsFor(store), [{ instance: "atlas", bot: "default", last_message_at: AT }]);
    expect(rows(store)).toHaveLength(0);
    // Silent, but not forgotten: the watermark is what makes the *next* one
    // land, and a source that recorded nothing would announce the whole
    // transcript on the second read instead of the first.
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(AT);
  });

  test("a transcript that has moved on since raises exactly one row", () => {
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: AT }]);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: LATER }]);
    const found = rows(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("chat.message");
    expect(found[0]?.source).toBe("chat");
    expect(found[0]?.agent).toBe("atlas");
    expect(found[0]?.key).toBe(`${CHAT_MESSAGE_PREFIX}${FLEET}:atlas/default:${LATER}`);
  });

  test("a second read of the same timestamp does not write a second row", () => {
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: AT }]);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: LATER }]);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: LATER }]);
    expect(rows(store)).toHaveLength(1);
  });

  test("a timestamp that went backwards is not a new message", () => {
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: LATER }]);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: AT }]);
    expect(rows(store)).toHaveLength(0);
  });

  test("the row is titled with the bot's display name, not its profile name", async () => {
    // Every box has a profile called `default`, and "default on atlas has a new
    // message" names nothing the operator recognises.
    const store = new MemoryNotificationStore();
    const named = {
      ...PROFILES_LIST_RESULT,
      profiles: PROFILES_LIST_RESULT.profiles.map((p) => ({ ...p, display_name: "Atlas" })),
    };
    let payload: unknown = { sessions: [] };
    const chat = harness(
      { swarm: (box) => Promise.resolve(mapSwarm(box, named, null, null, payload)) },
      store,
    );
    await chat.swarms({ instance: "atlas" });
    payload = SESSION_LIST_POPULATED;
    await chat.swarms({ instance: "atlas" });
    const found = rows(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toContain("Atlas");
    expect(found[0]?.title).not.toContain("default");
    // The instance stays: one fleet, many boxes, each with a bot called
    // whatever this one is called.
    expect(found[0]?.title).toContain("atlas");
  });

  test("a bot with no display name is still named by its profile", () => {
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    observeChatActivity(deps, [{ instance: "atlas", bot: "researcher", last_message_at: AT }]);
    observeChatActivity(deps, [{ instance: "atlas", bot: "researcher", last_message_at: LATER }]);
    expect(rows(store)[0]?.title).toBe("researcher on atlas has a new message");
  });

  test("one bot's failed insert neither silences the next bot nor loses its own", () => {
    /**
     * The watermark used to move before the insert, under one `try` for the
     * whole roster: a store that threw on the second bot skipped the third and
     * every bot after it, having already recorded that they had been reported.
     */
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    const names = ["one", "two", "three"];
    const first = names.map((name) => ({ instance: "atlas", bot: name, last_message_at: AT }));
    const second = names.map((name) => ({ instance: "atlas", bot: name, last_message_at: LATER }));
    observeChatActivity(deps, first);

    const insert = store.insert.bind(store);
    let broken = true;
    store.insert = (row: Parameters<NotificationStore["insert"]>[0]) => {
      if (broken && row.ref === "atlas/two") throw new Error("FIXTURE store is full");
      return insert(row);
    };
    observeChatActivity(deps, second);
    store.insert = insert;

    expect(
      rows(store)
        .map((r) => r.ref)
        .sort(),
    ).toEqual(["atlas/one", "atlas/three"]);
    // Bot two was never told about, so its watermark must still say `AT` — and
    // the next read must therefore raise the row that was lost.
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "two"))).toBe(AT);
    broken = false;
    observeChatActivity(deps, second);
    expect(rows(store).some((r) => r.ref === "atlas/two")).toBe(true);
  });

  test("a bot that has never said anything is not news", () => {
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: null }]);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: null }]);
    expect(rows(store)).toHaveLength(0);
  });

  test("bots are watermarked apart, so one moving does not silence the other", () => {
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    const first = [
      { instance: "atlas", bot: "default", last_message_at: AT },
      { instance: "atlas", bot: "researcher", last_message_at: AT },
    ];
    observeChatActivity(deps, first);
    observeChatActivity(deps, [
      { instance: "atlas", bot: "default", last_message_at: LATER },
      { instance: "atlas", bot: "researcher", last_message_at: AT },
    ]);
    const found = rows(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.ref).toBe("atlas/default");
  });

  test("the box saying a bot is waiting on a person raises the gold class", () => {
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: AT }]);
    observeChatActivity(deps, [
      { instance: "atlas", bot: "default", last_message_at: LATER, needs_action: true },
    ]);
    expect(rows(store)[0]?.class).toBe("needs_action");
  });

  test("the row carries an action that names the thread", () => {
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: AT }]);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: LATER }]);
    expect(rows(store)[0]?.actions).toContainEqual({
      label: "Open chat",
      target: "chat",
      ref: "atlas/default",
    });
  });

  test("no row ever carries a word of what was said", () => {
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: AT }]);
    observeChatActivity(deps, [
      { instance: "atlas", bot: "default", last_message_at: LATER, title: "Bot Chat" },
    ]);
    const row = rows(store)[0];
    // Title and detail are built from the bot's identity and the box's own
    // label for it. There is no path from a message body to either, and this
    // asserts the shape rather than the absence of one example.
    expect(row?.title).toBe("Bot Chat on atlas has a new message");
    // The profile behind the display name, not the display name again.
    expect(row?.detail).toBe("default");
  });

  test("an unwritable inbox never fails a roster read", () => {
    const broken = {
      ...new MemoryNotificationStore(),
      seenStatus: () => {
        throw new Error("disk full");
      },
    } as unknown as NotificationStore;
    expect(() =>
      observeChatActivity(depsFor(broken), [
        { instance: "atlas", bot: "default", last_message_at: AT },
      ]),
    ).not.toThrow();
  });

  test("the same rule holds over the SQLite store the portal and the CLI share", () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteNotificationStore(db, () => new Date("2026-09-17T10:00:00.000Z"));
    const deps = depsFor(store);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: AT }]);
    expect(rows(store)).toHaveLength(0);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: LATER }]);
    observeChatActivity(deps, [{ instance: "atlas", bot: "default", last_message_at: LATER }]);
    expect(rows(store)).toHaveLength(1);
    db.close();
  });
});

describe("chat.message through the real roster mapper", () => {
  /**
   * The seam every other test in this file fakes, and the reason the source
   * shipped unable to fire.
   *
   * `deps.hermes.swarm` is a double everywhere above, handing back a bot with a
   * `last_message_at` on it. The real adapter's `mapSwarm` had that field
   * hardcoded to `null` — which is not "unknown", it is "this bot has never
   * spoken", for every bot, forever — so `observeChatActivity` hit its
   * `at == null` branch on every read and the inbox was silent by construction
   * while a hundred green tests said otherwise.
   *
   * So this one builds the swarm with the *real* mapper, from the recorded
   * payload the probe captured, and only then hands it to the surface. It fails
   * if that field ever goes back to a constant.
   */
  function realSwarm(box: BoxAddress, sessions: unknown): Swarm {
    return mapSwarm(box, PROFILES_LIST_RESULT, null, null, sessions);
  }

  test("the mapper produces a timestamp the source can diff", () => {
    const mapped = realSwarm(
      { instance: "atlas", baseUrl: "https://atlas.example.ts.net", fleet_id: FLEET },
      SESSION_LIST_POPULATED,
    );
    expect(mapped.bots.length).toBeGreaterThan(0);
    expect(mapped.bots.some((b) => b.last_message_at != null)).toBe(true);
  });

  test("a later session timestamp, through the mapper, raises exactly one row", async () => {
    const store = new MemoryNotificationStore();
    /**
     * Two readings of the same box: the recorded payload, and the same payload
     * with the newest thread having moved on by half an hour.
     *
     * The mutated row is the one whose session names no profile — which is the
     * ordinary shape on a swarm of one, and which `mapSwarm` attributes to the
     * default bot. That matters for this test: the probed box's profile list
     * holds only `default`, so a session belonging to any other bot produces no
     * roster entry and nothing to diff.
     */
    const moved = {
      sessions: SESSION_LIST_POPULATED.sessions.map((row) =>
        "mtime" in row ? { ...row, mtime: (row.mtime as number) + 1800 } : row,
      ),
    };
    let payload: unknown = SESSION_LIST_POPULATED;
    const chat = harness({ swarm: (box) => Promise.resolve(realSwarm(box, payload)) }, store);

    await chat.swarms({ instance: "atlas" });
    expect(rows(store)).toHaveLength(0);

    payload = moved;
    await chat.swarms({ instance: "atlas" });
    const found = rows(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("chat.message");
    expect(found[0]?.ref).toBe("atlas/default");
  });

  test("a bot first seen with nothing said still reports its first message", async () => {
    // The case the whole feature is for, and the one a null watermark swallows:
    // a bot created five minutes ago, whose first message is the first thing it
    // has ever done.
    const store = new MemoryNotificationStore();
    let payload: unknown = { sessions: [] };
    const chat = harness({ swarm: (box) => Promise.resolve(realSwarm(box, payload)) }, store);

    await chat.swarms({ instance: "atlas" });
    expect(rows(store)).toHaveLength(0);

    payload = SESSION_LIST_POPULATED;
    await chat.swarms({ instance: "atlas" });
    expect(rows(store).length).toBeGreaterThan(0);
  });
});

describe("chat.message through chat.swarms", () => {
  test("a roster read is where the row comes from", async () => {
    const store = new MemoryNotificationStore();
    let at = AT;
    const chat = harness(
      {
        swarm: (box) =>
          Promise.resolve(
            swarm(box.instance, { bots: [bot({ instance: box.instance, last_message_at: at })] }),
          ),
      },
      store,
    );
    await chat.swarms({ instance: "atlas" });
    expect(rows(store)).toHaveLength(0);
    at = LATER;
    await chat.swarms({ instance: "atlas" });
    expect(rows(store).map((r) => r.kind)).toEqual(["chat.message"]);
  });

  test("a box that did not answer moves no watermark", async () => {
    const store = new MemoryNotificationStore();
    const chat = harness(
      {
        swarm: () => {
          throw new Error("no route to host");
        },
      },
      store,
    );
    await chat.swarms({ instance: "atlas" });
    expect(rows(store)).toHaveLength(0);
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBeNull();
  });

  test("a roster read taken after a turn the caller streamed reports nothing", async () => {
    /**
     * The structural half of "a reply the caller is streaming raises nothing".
     *
     * Suppressing the row at the turn is not enough: the turn moved the box's
     * transcript on, so the *next roster read* sees a newer timestamp and
     * writes a row about the reply the operator watched arrive — one per turn,
     * forever. The turn advances the watermark itself, and this is the test
     * that says so.
     */
    const store = new MemoryNotificationStore();
    const box = { at: AT, session: SESSION };
    const chat = harness(movingBox(box, { send: replyingTurn(box) }), store, {
      // The laptop's clock, and it disagrees with the box on purpose.
      now: () => LATER,
    });

    await chat.swarms({ instance: "atlas" });
    await collect(chat.send({ instance: "atlas", bot: "default", message: "hi", session: SESSION }));
    // The box now reports the turn that just happened, on its own clock.
    await chat.swarms({ instance: "atlas" });
    expect(rows(store)).toHaveLength(0);

    // A message that arrives *after* the turn is still news.
    box.at = "2026-09-17T11:00:00.000Z";
    await chat.swarms({ instance: "atlas" });
    expect(rows(store).map((r) => r.kind)).toEqual(["chat.message"]);
  });

  test("a caller that stops at `done` has still advanced the watermark", async () => {
    /**
     * The `done` frame is the last thing most consumers want: the CLI's
     * `--json` head prints and exits, an SSE stream whose browser navigated
     * away is never pulled again. The verdict used to be recorded on the line
     * *after* the yield, which such a caller never resumes — so the watermark
     * stayed where it was and the next roster read announced the reply the
     * operator had just watched arrive.
     */
    const store = new MemoryNotificationStore();
    const box = { at: AT, session: SESSION };
    const chat = harness(
      movingBox(box, {
        send: () =>
          (async function* () {
            yield { type: "delta", seq: 0, message: "m1", text: "the answer" } as ChatFrame;
            box.at = REPLY;
            yield { type: "done", seq: 0, message: "m1" } as ChatFrame;
            // Never reached: the consumer below walks away at `done`.
            yield { type: "delta", seq: 1, message: "m1", text: "unreachable" } as ChatFrame;
          })(),
      }),
      store,
      { now: () => LATER },
    );

    await chat.swarms({ instance: "atlas" });
    for await (const frame of chat.send({
      instance: "atlas",
      bot: "default",
      message: "hi",
      session: SESSION,
    })) {
      if (frame.type === "done") break;
    }
    // The box's coordinate for the reply, never the laptop's `now`.
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(REPLY);

    // And the roster read that follows says nothing about that reply.
    await chat.swarms({ instance: "atlas" });
    expect(rows(store)).toHaveLength(0);
  });

  test("a turn the caller streamed raises nothing at all", async () => {
    const store = new MemoryNotificationStore();
    const chat = harness(
      {
        send: () =>
          (async function* () {
            yield { type: "delta", seq: 0, message: "m1", text: "the answer" } as ChatFrame;
            yield { type: "done", seq: 0, message: "m1" } as ChatFrame;
          })(),
      },
      store,
    );
    const frames = await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    expect(frames.some((f) => f.type === "delta")).toBe(true);
    // The reply arrived in the caller's hands. An inbox row about it would be a
    // notification about something the operator is, by construction, watching.
    expect(rows(store)).toHaveLength(0);
  });
});

describe("chat.error: a turn that did not happen", () => {
  test("a failure raises one row keyed on the bot and the code", () => {
    const store = new MemoryNotificationStore();
    notifyChatError(
      depsFor(store),
      { instance: "atlas", bot: "default" },
      {
        code: "CHAT_UNREACHABLE",
        message: "no route to host",
      },
    );
    const found = rows(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("chat.error");
    expect(found[0]?.class).toBe("bad");
    expect(found[0]?.key).toBe(`${CHAT_ERROR_PREFIX}${FLEET}:atlas/default:CHAT_UNREACHABLE`);
    expect(found[0]?.detail).toBe("CHAT_UNREACHABLE - no route to host");
  });

  test("retrying into the same failure does not write a second row", () => {
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    const failure = { code: "CHAT_UNREACHABLE", message: "no route to host" };
    for (let i = 0; i < 4; i++) notifyChatError(deps, { instance: "atlas", bot: "default" }, failure);
    expect(rows(store)).toHaveLength(1);
  });

  test("a different failure against the same bot is still said", () => {
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    notifyChatError(
      deps,
      { instance: "atlas", bot: "default" },
      {
        code: "CHAT_UNREACHABLE",
        message: "no route to host",
      },
    );
    notifyChatError(
      deps,
      { instance: "atlas", bot: "default" },
      {
        code: "CHAT_NO_SLOT",
        message: "no warm backend",
      },
    );
    expect(
      rows(store)
        .map((r) => r.key)
        .sort(),
    ).toEqual([
      `${CHAT_ERROR_PREFIX}${FLEET}:atlas/default:CHAT_NO_SLOT`,
      `${CHAT_ERROR_PREFIX}${FLEET}:atlas/default:CHAT_UNREACHABLE`,
    ]);
  });

  test("a turn that gets through resolves every open failure against that bot", () => {
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    notifyChatError(
      deps,
      { instance: "atlas", bot: "default" },
      {
        code: "CHAT_UNREACHABLE",
        message: "no route to host",
      },
    );
    notifyChatError(
      deps,
      { instance: "atlas", bot: "default" },
      {
        code: "CHAT_NO_SLOT",
        message: "no warm backend",
      },
    );
    resolveChatErrors(deps, { instance: "atlas", bot: "default" });
    expect(rows(store).every((r) => r.resolved_at !== null)).toBe(true);
    // A recurrence is a new row, never a revival of the closed one.
    notifyChatError(
      deps,
      { instance: "atlas", bot: "default" },
      {
        code: "CHAT_UNREACHABLE",
        message: "no route to host",
      },
    );
    expect(rows(store)).toHaveLength(3);
  });

  test("resolving one bot's failures leaves another bot's asking", () => {
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    const failure = { code: "CHAT_UNREACHABLE", message: "no route to host" };
    notifyChatError(deps, { instance: "atlas", bot: "default" }, failure);
    notifyChatError(deps, { instance: "atlas", bot: "researcher" }, failure);
    resolveChatErrors(deps, { instance: "atlas", bot: "default" });
    const open = rows(store).filter((r) => r.resolved_at === null);
    expect(open.map((r) => r.ref)).toEqual(["atlas/researcher"]);
  });
});

describe("chat.error through chat.send", () => {
  test("an error frame from the adapter raises the row", async () => {
    const store = new MemoryNotificationStore();
    const chat = harness(
      {
        send: () =>
          (async function* () {
            yield { type: "error", code: "CHAT_NO_SLOT", message: "no warm backend" } as ChatFrame;
          })(),
      },
      store,
    );
    await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    expect(rows(store).map((r) => r.kind)).toEqual(["chat.error"]);
  });

  test("a throw from the adapter raises the row too", async () => {
    const store = new MemoryNotificationStore();
    const chat = harness({ send: failingStream("socket closed") }, store);
    await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    const found = rows(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("chat.error");
  });

  test("a turn that throws after its `done` raises, and resolves nothing", async () => {
    /**
     * The watermark moves at `done`, because the operator has seen the reply.
     * Resolving this bot's open failures does not: that claims the conversation
     * is healthy, and a socket that died on the way out has not shown it.
     */
    const store = new MemoryNotificationStore();
    const deps = depsFor(store);
    // A distinct code, so the row the throw raises is a row of its own rather
    // than the same held condition found again.
    notifyChatError(
      deps,
      { instance: "atlas", bot: "default" },
      {
        code: "CHAT_NO_SLOT",
        message: "no warm backend",
      },
    );
    const box = { at: AT, session: SESSION };
    const chat = harness(
      movingBox(box, {
        send: () =>
          (async function* () {
            box.at = REPLY;
            yield { type: "done", seq: 0, message: "m1" } as ChatFrame;
            throw new Error("the socket died on the way out");
          })(),
      }),
      store,
      { now: () => LATER },
    );
    await collect(chat.send({ instance: "atlas", bot: "default", message: "hi", session: SESSION }));

    // Moved once, at `done`, and not moved a second time on the way out.
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(REPLY);
    const found = rows(store);
    expect(found.map((r) => r.kind)).toEqual(["chat.error", "chat.error"]);
    // The row the turn started with is still open: nothing resolved it.
    expect(found.filter((r) => r.resolved_at === null)).toHaveLength(2);
  });

  test("a turn that lands resolves the failure the last one raised", async () => {
    const store = new MemoryNotificationStore();
    let fail = true;
    const chat = harness(
      {
        send: () =>
          (async function* () {
            if (fail) {
              yield { type: "error", code: "CHAT_UNREACHABLE", message: "no route" } as ChatFrame;
              return;
            }
            yield { type: "done", seq: 0, message: "m1" } as ChatFrame;
          })(),
      },
      store,
    );
    await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    expect(rows(store).filter((r) => r.resolved_at === null)).toHaveLength(1);
    fail = false;
    await collect(chat.send({ instance: "atlas", bot: "default", message: "again" }));
    expect(rows(store).filter((r) => r.resolved_at === null)).toHaveLength(0);
  });

  test("a transient error that is followed by a `done` is not a failed turn", async () => {
    const store = new MemoryNotificationStore();
    const chat = harness(
      {
        send: () =>
          (async function* () {
            yield { type: "error", code: "CHAT_NO_SLOT", message: "waiting" } as ChatFrame;
            yield { type: "delta", seq: 1, message: "m1", text: "got one" } as ChatFrame;
            yield { type: "done", seq: 2, message: "m1" } as ChatFrame;
          })(),
      },
      store,
    );
    await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    // The answer reached the operator. A run that complained on the way is not
    // a turn that failed.
    expect(rows(store)).toHaveLength(0);
  });

  test("a stream that ends having said nothing resolves nothing", async () => {
    // A socket that closed quietly is not evidence the thread works. Resolving
    // on it would clear the inbox on exactly the evidence that should fill it.
    const store = new MemoryNotificationStore();
    notifyChatError(
      depsFor(store),
      { instance: "atlas", bot: "default" },
      { code: "CHAT_UNREACHABLE", message: "no route" },
    );
    const chat = harness({ send: () => (async function* () {})() }, store);
    await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    expect(rows(store).filter((r) => r.resolved_at === null)).toHaveLength(1);
  });

  test("an aborted turn is neither a failure nor a recovery", async () => {
    const store = new MemoryNotificationStore();
    notifyChatError(
      depsFor(store),
      { instance: "atlas", bot: "default" },
      {
        code: "CHAT_UNREACHABLE",
        message: "no route",
      },
    );
    const controller = new AbortController();
    const chat = harness(
      {
        send: () =>
          (async function* () {
            controller.abort();
            yield { type: "delta", seq: 0, message: "m1", text: "half " } as ChatFrame;
          })(),
      },
      store,
    );
    await collect(
      chat.send({ instance: "atlas", bot: "default", message: "hi" }, { signal: controller.signal }),
    );
    // The operator stopped it. That is not evidence the thread works again, and
    // it is not a failure to report either.
    expect(rows(store).filter((r) => r.resolved_at === null)).toHaveLength(1);
  });

  test("the message on the row is the masked one the caller saw", async () => {
    const store = new MemoryNotificationStore();
    const chat = harness(
      { send: failingStream("upstream said sk-ant-FIXTUREFIXTUREFIXTURE was rejected") },
      store,
    );
    await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    const detail = rows(store)[0]?.detail ?? "";
    expect(detail).not.toContain("sk-ant-FIXTUREFIXTUREFIXTURE");
    expect(detail).toContain("CHAT_UNREACHABLE");
  });
});

/**
 * The clock the watermark is kept in, and the fence that covers the gap.
 *
 * These are the two halves of one bug. The roster read compares the **box's**
 * coordinate; the turn used to record the **laptop's**, and the two are only
 * ever accidentally the same number. Both directions of the skew are wrong, and
 * they are wrong in opposite ways — the first costs a row about the operator's
 * own reply, the second swallows somebody else's message — which is why both
 * are asserted below rather than one standing in for the pair.
 *
 * The fence is what makes the box's coordinate usable at all: it cannot be read
 * until the turn is over, so something has to hold the roster read off in the
 * meantime, and it has to hold it off across processes, because the CLI and the
 * portal are two processes over one database.
 */
describe("the watermark is the box's clock, never the laptop's", () => {
  const WHERE = { instance: "atlas", bot: "default" };

  test("a box running ahead of the laptop: the reply is silent, the next message is not", async () => {
    const store = new MemoryNotificationStore();
    // The box stamps 10:15; the laptop thinks it is 09:31:40.
    const box = { at: AT, session: SESSION };
    const chat = harness(movingBox(box, { send: replyingTurn(box, REPLY) }), store, {
      now: () => LATER,
    });

    await chat.swarms({ instance: "atlas" });
    await collect(chat.send({ ...WHERE, message: "hi", session: SESSION }));
    await chat.swarms({ instance: "atlas" });
    // A laptop watermark of 09:31:40 sits *under* the box's 10:15, so the
    // reply the operator just watched arrive would be announced.
    expect(rows(store)).toHaveLength(0);
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(REPLY);

    box.at = "2026-09-17T10:20:00.000Z";
    await chat.swarms({ instance: "atlas" });
    expect(rows(store).map((r) => r.kind)).toEqual(["chat.message"]);
  });

  test("a box running behind the laptop: a message during the turn is not swallowed", async () => {
    const store = new MemoryNotificationStore();
    // The box stamps 09:05; the laptop thinks it is 09:31:40. A laptop
    // watermark would sit *over* everything the box says for the next half
    // hour, and every one of those messages would be lost in silence.
    const behind = "2026-09-17T09:05:00.000Z";
    const box = { at: AT, session: SESSION };
    const chat = harness(movingBox(box, { send: replyingTurn(box, behind) }), store, {
      now: () => LATER,
    });

    await chat.swarms({ instance: "atlas" });
    await collect(chat.send({ ...WHERE, message: "hi", session: SESSION }));
    await chat.swarms({ instance: "atlas" });
    expect(rows(store)).toHaveLength(0);
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(behind);

    // Somebody else says something a minute later, on the box's clock.
    box.at = "2026-09-17T09:06:00.000Z";
    await chat.swarms({ instance: "atlas" });
    expect(rows(store).map((r) => r.kind)).toEqual(["chat.message"]);
  });

  test("a coordinate belonging to another session does not advance anything", async () => {
    /**
     * Interleaved external activity. The bot's coordinate moved, but the
     * session holding it is not the one this turn spoke into — so the turn has
     * no evidence the coordinate is its own, and declines. The next roster read
     * then classifies it, which is one row about a reply the operator saw and
     * is the direction this is allowed to fail in.
     */
    const store = new MemoryNotificationStore();
    const box = { at: AT, session: "somebody-else" };
    const chat = harness(movingBox(box, { send: replyingTurn(box) }), store, { now: () => LATER });

    await chat.swarms({ instance: "atlas" });
    await collect(chat.send({ ...WHERE, message: "hi", session: SESSION }));
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(AT);
  });

  test("a box that cannot be read after the turn advances nothing", async () => {
    const store = new MemoryNotificationStore();
    const box = { at: AT, session: SESSION };
    const live = movingBox(box, { send: replyingTurn(box) });
    let reads = 0;
    const chat = harness(
      {
        ...live,
        // The roster read the turn takes at its end, and only that one: the
        // first is the read that establishes the watermark.
        swarm: (address: BoxAddress) => {
          reads += 1;
          return reads === 1
            ? (live.swarm?.(address) ?? Promise.reject(new Error("no swarm")))
            : Promise.reject(new Error("no route to host"));
        },
      },
      store,
      { now: () => LATER },
    );
    await chat.swarms({ instance: "atlas" });
    await collect(chat.send({ ...WHERE, message: "hi", session: SESSION }));
    expect(reads).toBe(2);
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(AT);
  });

  test("an aborted turn acknowledges its own activity and resolves nothing", async () => {
    const store = new MemoryNotificationStore();
    notifyChatError(depsFor(store), WHERE, { code: "CHAT_NO_SLOT", message: "no warm backend" });
    const box = { at: AT, session: SESSION };
    const controller = new AbortController();
    const chat = harness(
      movingBox(box, {
        send: () =>
          (async function* () {
            yield { type: "delta", seq: 0, message: "m1", text: "half of" } as ChatFrame;
            // The box persisted the partial turn before the operator stopped it.
            box.at = REPLY;
            controller.abort();
            yield { type: "delta", seq: 1, message: "m1", text: " an answer" } as ChatFrame;
          })(),
      }),
      store,
      { now: () => LATER },
    );

    await chat.swarms({ instance: "atlas" });
    await collect(
      chat.send({ ...WHERE, message: "hi", session: SESSION }, { signal: controller.signal }),
    );
    // Own activity: acknowledged, in the box's coordinate.
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(REPLY);
    // Turn health: not claimed. Stopping a turn proves nothing about the thread.
    expect(rows(store).filter((r) => r.resolved_at === null)).toHaveLength(1);
  });

  test("a lease past its TTL is not a fence", () => {
    const fence = new MemoryChatFenceStore();
    const t0 = Date.parse(AT);
    acquireChatFence(fence, FLEET, WHERE, { now: () => t0 });
    expect(chatFenced(fence, FLEET, WHERE, t0 + CHAT_FENCE_TTL_MS - 1)).toBe(true);
    // A holder that was killed is late by one TTL, never forever.
    expect(chatFenced(fence, FLEET, WHERE, t0 + CHAT_FENCE_TTL_MS + 1)).toBe(false);
  });

  test("a roster read past a stale lease classifies rather than defers", async () => {
    const store = new MemoryNotificationStore();
    const fence = new MemoryChatFenceStore();
    const box = { at: AT, session: SESSION };
    let clock = AT;
    const chat = harness(movingBox(box), store, { now: () => clock, chatFence: fence });

    await chat.swarms({ instance: "atlas" });
    // A turn taken by a process that then died, and never released its claim.
    acquireChatFence(fence, FLEET, WHERE, { now: () => Date.parse(AT) });
    box.at = REPLY;
    await chat.swarms({ instance: "atlas" });
    expect(rows(store)).toHaveLength(0);
    // Deferred, not classified: the watermark did not move, so nothing was lost.
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(AT);

    clock = new Date(Date.parse(AT) + CHAT_FENCE_TTL_MS + 1000).toISOString();
    await chat.swarms({ instance: "atlas" });
    expect(rows(store).map((r) => r.kind)).toEqual(["chat.message"]);
  });

  test("a turn one process is taking defers the other process's roster read", async () => {
    /**
     * The case the fence is persisted for. `hermetic chat` and the portal are
     * two processes over one SQLite home, and the roster poll belongs to the
     * one that is not streaming — so a fence in either closure would fence the
     * wrong side. Two `createChat` instances over one database is the smallest
     * honest model of that.
     */
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteNotificationStore(db, () => new Date(LATER));
    const fence = new SqliteChatFenceStore(db);
    const box = { at: AT, session: SESSION };

    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const streaming = harness(
      movingBox(box, {
        send: () =>
          (async function* () {
            // A block and not a delta: the delta gate buffers text until it
            // has a stable cut, and a test that waits on a frame the gate is
            // still holding would deadlock against its own turn.
            // The coordinate moves as soon as the turn starts — the box writes
            // the operator's own prompt into the transcript before the model
            // has said anything — which is precisely the window the fence
            // exists to cover.
            box.at = REPLY;
            yield {
              type: "block",
              seq: 0,
              message: "m1",
              block: { kind: "text", markdown: "the" },
            } as ChatFrame;
            await held;
            yield { type: "done", seq: 0, message: "m1" } as ChatFrame;
          })(),
      }),
      store,
      { now: () => LATER, chatFence: fence },
    );
    const polling = harness(movingBox(box), store, { now: () => LATER, chatFence: fence });

    await polling.swarms({ instance: "atlas" });
    const turn = streaming.send({ ...WHERE, message: "hi", session: SESSION })[Symbol.asyncIterator]();
    expect((await turn.next()).value).toMatchObject({ type: "block" });

    // Mid-turn: the other process raises nothing and, just as importantly,
    // leaves the watermark alone so the next read can still classify.
    await polling.swarms({ instance: "atlas" });
    expect(rows(store)).toHaveLength(0);
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(AT);

    release();
    while (!(await turn.next()).done) {
      // Drain the rest of the turn.
    }

    // The turn is over and its own reply is still not news.
    await polling.swarms({ instance: "atlas" });
    expect(rows(store)).toHaveLength(0);

    // A message that arrives after it is.
    box.at = "2026-09-17T11:00:00.000Z";
    await polling.swarms({ instance: "atlas" });
    expect(rows(store).map((r) => r.kind)).toEqual(["chat.message"]);
    db.close();
  });
});

/**
 * The lease's own rules, at the level they are enforced.
 *
 * The renewal one is not a detail: a renewal that did not check the owner let a
 * superseded holder's timer take the row back, and its release then deleted a
 * claim belonging to a turn that was still streaming — un-fencing a live turn,
 * which is the one thing the fence exists to prevent.
 */
describe("the turn fence's lease", () => {
  const WHERE = { instance: "atlas", bot: "default" };

  test("a superseded lease renews nothing and drops nothing", () => {
    const store = new MemoryChatFenceStore();
    const t0 = Date.parse(AT);
    const first = acquireChatFence(store, FLEET, WHERE, { now: () => t0 });
    const second = acquireChatFence(store, FLEET, WHERE, { now: () => t0 });

    // The first holder is told it no longer holds the row rather than taking
    // it back, and it stops renewing on that answer.
    expect(first.renew()).toBe(false);
    expect(second.renew()).toBe(true);

    // And its release leaves the live claim alone.
    first.release();
    expect(chatFenced(store, FLEET, WHERE, t0 + 1)).toBe(true);
    second.release();
    expect(chatFenced(store, FLEET, WHERE, t0 + 1)).toBe(false);
  });

  test("the same rule holds over the SQLite fence the two heads share", () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteChatFenceStore(db);
    const t0 = Date.parse(AT);
    const first = acquireChatFence(store, FLEET, WHERE, { now: () => t0 });
    const second = acquireChatFence(store, FLEET, WHERE, { now: () => t0 });

    expect(first.renew()).toBe(false);
    expect(second.renew()).toBe(true);
    first.release();
    expect(chatFenced(store, FLEET, WHERE, t0 + 1)).toBe(true);
    db.close();
  });

  test("a released lease stops renewing", () => {
    const store = new MemoryChatFenceStore();
    const lease = acquireChatFence(store, FLEET, WHERE, { now: () => Date.parse(AT) });
    lease.release();
    expect(lease.renew()).toBe(false);
    expect(chatFenced(store, FLEET, WHERE, Date.parse(AT) + 1)).toBe(false);
  });

  test("a box that never answers does not hold the end of the turn open", async () => {
    /**
     * The watermark is written before `done` is yielded, so the read that finds
     * it sits on the critical path of every turn's visible end. It is bounded:
     * past the deadline the turn declines, releases and finishes, rather than
     * leaving a caller watching a finished answer wait out an RPC timeout.
     */
    const store = new MemoryNotificationStore();
    const box = { at: AT, session: SESSION };
    const live = movingBox(box, { send: replyingTurn(box) });
    let reads = 0;
    const chat = harness(
      {
        ...live,
        swarm: (address: BoxAddress) => {
          reads += 1;
          return reads === 1
            ? (live.swarm?.(address) ?? Promise.reject(new Error("no swarm")))
            : new Promise<Swarm>(() => {
                // Never answers, and never rejects either.
              });
        },
      },
      store,
      { now: () => LATER, attributionDeadlineMs: 20 },
    );

    await chat.swarms({ instance: "atlas" });
    const frames = await collect(chat.send({ ...WHERE, message: "hi", session: SESSION }));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    // Declined, so the next roster read still gets to classify.
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(AT);
  });
});

function processEvent(over: Partial<ProcessEventBlock> = {}): ProcessEventBlock {
  return {
    kind: "process_event",
    event: "completion",
    outcome: "ok",
    process_id: "proc_a1",
    status: "completed normally",
    exit_code: 0,
    command: "bun run build",
    raw: "[IMPORTANT: …]",
    ...over,
  };
}

describe("chat.message: a background-process event", () => {
  const WHERE_EVENT = { instance: "atlas", bot: "default" };

  test("a routine event never raises a row", () => {
    const store = new MemoryNotificationStore();
    const routine: ProcessEventBlock[] = [
      processEvent(),
      processEvent({ outcome: "terminated", status: "terminated by Hermes" }),
      processEvent({
        event: "watch_match",
        outcome: "info",
        watch: { pattern: "ready", suppressed: 0 },
      }),
      processEvent({ event: "mcp_reload", outcome: "info", message: "MCP servers reloaded" }),
    ];
    for (const block of routine) {
      expect(notifyProcessEvent(depsFor(store), WHERE_EVENT, block, "m-1")).toBe(false);
    }
    expect(rows(store)).toEqual([]);
  });

  test("a failure raises one row worded from structured fields, however often it is polled", () => {
    const store = new MemoryNotificationStore();
    const failed = processEvent({
      outcome: "failed",
      status: "exited",
      exit_code: 1,
      command: "bun test packages/ui",
      output_tail: "FAIL secret-looking output",
    });
    for (let poll = 0; poll < 3; poll++) {
      notifyProcessEvent(depsFor(store), WHERE_EVENT, failed, "m-1");
    }
    const [row, ...rest] = rows(store);
    expect(rest).toEqual([]);
    expect(row?.title).toBe("A background command failed on default on atlas (exit 1)");
    expect(row?.class).toBe("bad");
    expect(row?.ref).toBe("atlas/default");
    expect(row?.key).toBe(`${CHAT_EVENT_PREFIX}${FLEET}:atlas/default:proc_a1`);
  });

  test("a DM reply names who replied, never what they said", () => {
    const store = new MemoryNotificationStore();
    const reply = (id: string) =>
      processEvent({
        process_id: id,
        command: "python bot_mode_dm.py",
        dm: { to_profile: "lead-qa", reply: "looks fine\nship it", warnings: [] },
      });
    const where = { ...WHERE_EVENT, title: "Bot Chat" };
    notifyProcessEvent(depsFor(store), where, reply("proc_1"), "m-1");
    notifyProcessEvent(depsFor(store), where, reply("proc_2"), "m-2");
    const titles = rows(store).map((r) => r.title);
    expect(titles).toEqual([
      "lead-qa replied to Bot Chat on atlas",
      "lead-qa replied to Bot Chat on atlas",
    ]);
    expect(rows(store).map((r) => r.detail)).toEqual(["default", "default"]);
    expect(rows(store).map((r) => r.class)).toEqual(["info", "info"]);
  });

  test("subagents and the other failure statuses read from fixed labels", () => {
    const store = new MemoryNotificationStore();
    const delegation = (outcome: "ok" | "failed", id: string) =>
      processEvent({
        event: "delegation",
        outcome,
        process_id: null,
        delegation: { id, batch: true, total: 2, succeeded: 1, tasks: [] },
      });
    notifyProcessEvent(depsFor(store), WHERE_EVENT, delegation("ok", "d-1"), "m-1");
    notifyProcessEvent(depsFor(store), WHERE_EVENT, delegation("failed", "d-2"), "m-2");
    notifyProcessEvent(
      depsFor(store),
      WHERE_EVENT,
      processEvent({ process_id: "p-3", outcome: "failed", status: "failed to start", exit_code: -1 }),
      "m-3",
    );
    notifyProcessEvent(
      depsFor(store),
      WHERE_EVENT,
      processEvent({
        process_id: "p-4",
        outcome: "failed",
        status: "marked lost because the process backend disappeared",
        exit_code: null,
      }),
      "m-4",
    );
    // All four rows share one timestamp, and the store breaks a tie by id the
    // way SQLite's `ORDER BY at DESC, id DESC` does, so the order is not the
    // order of insertion. The labels are what this test is about.
    expect(
      rows(store)
        .map((r) => r.title)
        .sort(),
    ).toEqual(
      [
        "Subagents finished for default on atlas",
        "Subagents finished for default on atlas with failures",
        "A background command failed to start on default on atlas",
        "A background command was lost on default on atlas",
      ].sort(),
    );
  });

  test("a notice with no process id is keyed on the message that carried it", () => {
    const store = new MemoryNotificationStore();
    const lost = processEvent({ process_id: null, outcome: "failed", status: "lost" });
    notifyProcessEvent(depsFor(store), WHERE_EVENT, lost, "m-9");
    notifyProcessEvent(depsFor(store), WHERE_EVENT, lost, "m-9");
    expect(rows(store).map((r) => r.key)).toEqual([`${CHAT_EVENT_PREFIX}${FLEET}:atlas/default:m-9`]);
  });

  test("a long bot title is cut to a one-line title", () => {
    const store = new MemoryNotificationStore();
    const failed = processEvent({ outcome: "failed", status: "exited", exit_code: 1 });
    notifyProcessEvent(depsFor(store), { ...WHERE_EVENT, title: "x".repeat(400) }, failed, "m-1");
    const title = rows(store)[0]?.title ?? "";
    expect(title.length).toBeLessThanOrEqual(140);
    expect(title.endsWith("…")).toBe(true);
  });

  test("an unwritable inbox is not a failure", () => {
    const store = new MemoryNotificationStore();
    store.insert = () => {
      throw new Error("disk full");
    };
    const failed = processEvent({ outcome: "failed", status: "exited", exit_code: 2 });
    expect(notifyProcessEvent(depsFor(store), WHERE_EVENT, failed, "m-1")).toBe(false);
  });
});

describe("chat.event: a roster movement is classified by one history read", () => {
  /** Between `AT` and `LATER`: inside the window a moved bot's read looks at. */
  const DURING = "2026-09-17T09:20:00.000Z";

  function row(id: string, at: string, over: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id,
      session: SESSION,
      role: "bot",
      at,
      blocks: [{ kind: "text", markdown: "the answer" }],
      ...over,
    };
  }

  function eventRow(id: string, at: string, over: Partial<ProcessEventBlock> = {}): ChatMessage {
    return row(id, at, { role: "system", blocks: [processEvent(over)] });
  }

  /** A roster that reports `state.at`, a history that answers `state.transcript`, and a call log. */
  function classifying(state: { at: string; transcript: ChatMessage[] | (() => ChatMessage[]) }): {
    client: Partial<HermesChatClient>;
    reads: number[];
  } {
    const reads: number[] = [];
    return {
      reads,
      client: {
        swarm: (box) =>
          Promise.resolve(
            swarm(box.instance, { bots: [bot({ instance: box.instance, last_message_at: state.at })] }),
          ),
        history: (_box, _bot, opts) => {
          reads.push(opts?.limit ?? -1);
          const t = state.transcript;
          return Promise.resolve(typeof t === "function" ? t() : t);
        },
      },
    };
  }

  test("a first sighting reads no history at all", async () => {
    const store = new MemoryNotificationStore();
    const { client, reads } = classifying({ at: AT, transcript: [eventRow("e1", AT)] });
    await harness(client, store).swarms({ instance: "atlas" });
    expect(reads).toEqual([]);
    expect(rows(store)).toEqual([]);
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(AT);
  });

  test("a movement that is only a routine event raises nothing and still moves the watermark", async () => {
    const store = new MemoryNotificationStore();
    const state = { at: AT, transcript: [row("r0", AT), eventRow("e1", LATER)] };
    const { client, reads } = classifying(state);
    const chat = harness(client, store);
    await chat.swarms({ instance: "atlas" });
    state.at = LATER;
    await chat.swarms({ instance: "atlas" });
    expect(reads).toHaveLength(1);
    expect(rows(store)).toEqual([]);
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(LATER);
  });

  test("a failed command raises its own row, worded without its command, and only once", async () => {
    const store = new MemoryNotificationStore();
    const state = {
      at: AT,
      transcript: [
        row("r0", AT),
        eventRow("e1", LATER, {
          outcome: "failed",
          status: "exited",
          exit_code: 2,
          command: "deploy --token FIXTURE",
          output_tail: "boom",
        }),
      ],
    };
    const { client, reads } = classifying(state);
    const chat = harness(client, store);
    await chat.swarms({ instance: "atlas" });
    state.at = LATER;
    await chat.swarms({ instance: "atlas" });
    await chat.swarms({ instance: "atlas" });
    const found = rows(store);
    expect(found.map((r) => r.key)).toEqual([`${CHAT_EVENT_PREFIX}${FLEET}:atlas/default:proc_a1`]);
    expect(found[0]?.title).toBe("A background command failed on Bot Chat on atlas (exit 2)");
    expect(found[0]?.title).not.toContain("deploy");
    expect(found[0]?.title).not.toContain("boom");
    // The second poll saw no movement, so it read nothing.
    expect(reads).toHaveLength(1);
  });

  test("a DM reply beside the bot's own reply raises both rows", async () => {
    const store = new MemoryNotificationStore();
    const state = {
      at: AT,
      transcript: [
        row("r0", AT),
        eventRow("e1", DURING, {
          process_id: "proc_dm",
          dm: { to_profile: "lead-qa", reply: "ship it", warnings: [] },
        }),
        row("r1", LATER),
      ],
    };
    const { client } = classifying(state);
    const chat = harness(client, store);
    await chat.swarms({ instance: "atlas" });
    state.at = LATER;
    await chat.swarms({ instance: "atlas" });
    const keys = rows(store)
      .map((r) => r.key ?? "")
      .sort();
    expect(keys).toEqual([
      `${CHAT_EVENT_PREFIX}${FLEET}:atlas/default:proc_dm`,
      `${CHAT_MESSAGE_PREFIX}${FLEET}:atlas/default:${LATER}`,
    ]);
    expect(rows(store).find((r) => r.key?.startsWith(CHAT_EVENT_PREFIX))?.title).toBe(
      "lead-qa replied to Bot Chat on atlas",
    );
  });

  test("an event the bot answered with a silence marker raises nothing", async () => {
    const store = new MemoryNotificationStore();
    const state = {
      at: AT,
      transcript: [
        row("r0", AT),
        eventRow("e1", DURING),
        row("r1", LATER, {
          blocks: [
            { kind: "reasoning", text: "nothing to say" },
            { kind: "text", markdown: " *NO_REPLY* " },
          ],
        }),
      ],
    };
    const { client } = classifying(state);
    const chat = harness(client, store);
    await chat.swarms({ instance: "atlas" });
    state.at = LATER;
    await chat.swarms({ instance: "atlas" });
    expect(rows(store)).toEqual([]);
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(LATER);
  });

  test("another bot's DM delivery is not news on its own", async () => {
    const store = new MemoryNotificationStore();
    const state = {
      at: AT,
      transcript: [
        row("r0", AT),
        row("d1", LATER, {
          role: "user",
          from_bot: { name: "Marshall", handle: "scribe" },
          blocks: [{ kind: "text", markdown: "Re-run the QA pass on #4124." }],
        }),
      ],
    };
    const { client } = classifying(state);
    const chat = harness(client, store);
    await chat.swarms({ instance: "atlas" });
    state.at = LATER;
    await chat.swarms({ instance: "atlas" });
    expect(rows(store)).toEqual([]);
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(LATER);
  });

  test("a marker on a failed turn, or mentioned in prose, is still a message", async () => {
    for (const reply of [
      { error: "TURN_FAILED", blocks: [{ kind: "text" as const, markdown: "NO_REPLY" }] },
      { blocks: [{ kind: "text" as const, markdown: "Use NO_REPLY when no answer is needed." }] },
    ]) {
      const store = new MemoryNotificationStore();
      const state = { at: AT, transcript: [row("r0", AT), row("r1", LATER, reply)] };
      const { client } = classifying(state);
      const chat = harness(client, store);
      await chat.swarms({ instance: "atlas" });
      state.at = LATER;
      await chat.swarms({ instance: "atlas" });
      expect(rows(store).map((r) => r.key)).toEqual([
        `${CHAT_MESSAGE_PREFIX}${FLEET}:atlas/default:${LATER}`,
      ]);
    }
  });

  test("a history read that fails falls back to the generic row, and the roster still answers", async () => {
    const store = new MemoryNotificationStore();
    const state = {
      at: AT,
      transcript: (): ChatMessage[] => {
        throw new Error("no route to host");
      },
    };
    const { client, reads } = classifying(state);
    const chat = harness(client, store);
    await chat.swarms({ instance: "atlas" });
    state.at = LATER;
    const result = await chat.swarms({ instance: "atlas" });
    expect(reads).toHaveLength(1);
    expect(result.swarms.map((s) => s.reachable)).toEqual([true]);
    expect(rows(store).map((r) => r.key)).toEqual([
      `${CHAT_MESSAGE_PREFIX}${FLEET}:atlas/default:${LATER}`,
    ]);
    expect(store.seenStatus(FLEET, chatSeenSubject("atlas", "default"))).toBe(LATER);
  });
});
