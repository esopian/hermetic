/**
 * `core/src/chat-observe.ts` (§9.2): a durable watch on a
 * conversation, and the four things it promises.
 *
 * The file is in two halves because the guarantees are.
 *
 * The **fixture half** drives `createChat` over `fixtureChatClient`, so an
 * observation goes through the fleet guard, the listen check, the redaction
 * door and the adapter seam exactly as a real one does. That is where the
 * acceptance criteria live: an external message arriving with no local send,
 * two observers not doubling anything, and a tab closing detaching only itself.
 *
 * The **service half** drives `createChatObservation` with hand-written deps,
 * because the reconnect policy and the cursor are only assertable when the test
 * decides what fails and when. Nothing in either half waits on a real clock:
 * every sleep is injected and every wait is bounded, so a regression is a
 * failure rather than a suite that hangs.
 *
 * No network anywhere. The fixture client constructs no socket and no `fetch`,
 * and the service's deps are closures over arrays.
 */
import { describe, expect, test } from "bun:test";
import { createChat } from "../src/chat/chat.ts";
import type { ChatDeps } from "../src/chat/chat.ts";
import { createChatObservation } from "../src/chat/chat-observe.ts";
import { createChatObserve } from "../src/chat/hermes/hermes-chat-observe.ts";
import type { ObserveOptions } from "../src/chat/hermes/hermes-chat-types.ts";
import type {
  ChatObserveDeps,
  ChatObserveSnapshot,
  ChatObserveHint,
} from "../src/chat/chat-observe.ts";
import { createFixtureChatActivity, fixtureChatClient } from "../src/backend/fixture/fixture-chat.ts";
import type { FixtureChatActivity } from "../src/backend/fixture/fixture-chat.ts";
import { MemoryInstanceListeningStore } from "../src/chat/instance-listening.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import {
  MemoryNotificationStore,
  chatSeenSubject,
  notificationsList,
} from "../src/chat/notifications.ts";
import type { StackInfo } from "../src/backend/types.ts";
import type { ChatMessage, ChatObserveEvent } from "../src/schema/index.ts";
import { HermeticError } from "../src/errors.ts";
import { REDACTED } from "../src/chat/chat-redact.ts";

const AT = "2026-09-17T09:00:00.000Z";
/** Every wait in this file is bounded by this, so a regression fails rather than hangs. */
const PATIENCE_MS = 2_000;

const backend = seedFixtureFleet(new MemoryBackend());
const agents = await backend.store.agents.scan();
const seeded = await backend.store.fleet.get();
if (seeded === null) throw new Error("the fixture seed writes a fleet item");
const fleetItem = seeded;

/* ── bounded waiting ──────────────────────────────────────────────────────── */

/**
 * One observer, with a handle for stopping it.
 *
 * Every test goes through this rather than iterating the stream directly,
 * because an observation stream never ends on its own — a conversation is never
 * over — and the two failure modes of a naive consumer are both silent. A bare
 * `for await` waits for the suite timeout and reports nothing about what was
 * missing; and returning a generator that is parked waiting for its next event
 * cannot complete until something wakes it, which is what a caller's
 * `AbortSignal` is for. `stop()` aborts first and returns second, which is the
 * order both heads use.
 */
/** Returned by `next` when the window closed first. Not a value the stream can yield. */
const TIMED_OUT = Symbol("timed out");

function watching(open: (signal: AbortSignal) => AsyncIterable<ChatObserveEvent>) {
  const controller = new AbortController();
  const it = open(controller.signal)[Symbol.asyncIterator]();
  /**
   * The in-flight `it.next()`, held across a window that closed on it.
   *
   * Losing the race must not abandon the pull. An async iterator queues every
   * `next()` and answers them in order, so a second call made after a timeout
   * would be answered *second* — the event the test is waiting for goes to the
   * abandoned promise and the test times out holding the one after it. That is
   * silent, and it only bites a test that waits, times out, and then waits
   * again, which is exactly the shape of "did the poll floor keep delivering?".
   */
  let pending: Promise<IteratorResult<ChatObserveEvent>> | null = null;
  return {
    /** The next event, or `undefined` if none arrived inside the window. */
    async next(ms = PATIENCE_MS): Promise<ChatObserveEvent | undefined> {
      const current = (pending ??= it.next());
      const step = await Promise.race([
        current,
        new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), ms)),
      ]);
      if (step === TIMED_OUT) return undefined;
      pending = null;
      return step.done === true ? undefined : step.value;
    },
    /** The next `n` events, failing by name rather than by timeout. */
    async take(n: number, ms = PATIENCE_MS): Promise<ChatObserveEvent[]> {
      const out: ChatObserveEvent[] = [];
      for (let i = 0; i < n; i++) {
        const event = await this.next(ms);
        if (event === undefined) break;
        out.push(event);
      }
      if (out.length < n) {
        throw new Error(`expected ${n} events, saw ${out.length}: ${JSON.stringify(out)}`);
      }
      return out;
    },
    /** Everything that arrives inside the window, however little that is. */
    async drain(ms = 300): Promise<ChatObserveEvent[]> {
      const out: ChatObserveEvent[] = [];
      for (;;) {
        const event = await this.next(ms);
        if (event === undefined) return out;
        out.push(event);
      }
    },
    async stop(): Promise<void> {
      controller.abort();
      await it.return?.();
    },
  };
}

/** Let every already-scheduled microtask and timer callback run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/* ── the fixture harness ──────────────────────────────────────────────────── */

interface Harness {
  chat: ReturnType<typeof createChat>;
  activity: FixtureChatActivity;
  /** Every method the adapter was asked for, in order. */
  calls: string[];
}

function harness(deps: Partial<ChatDeps> = {}): Harness {
  const activity = createFixtureChatActivity();
  const calls: string[] = [];
  const base = fixtureChatClient({ activity });
  const instanceListening = new MemoryInstanceListeningStore();
  for (const agent of agents) instanceListening.set(fleetItem.fleet_id, agent.name, true);
  const chat = createChat({
    instanceListening,
    fleet: () => fleetItem.fleet_id,
    guardFleet: () =>
      Promise.resolve({
        config: FIXTURE_CONFIG,
        fleet: fleetItem,
        stack: {
          stack_id: "arn:aws:cloudformation:us-east-1:111122223333:stack/hermetic/1",
          stack_name: "hermetic",
          status: "CREATE_COMPLETE",
          tags: {},
          outputs: {},
          parameters: {},
        } satisfies StackInfo,
      }),
    getAgent: (name) => {
      const found = agents.find((a) => a.name === name);
      if (!found) throw new Error(`the fixture has no agent ${name}`);
      return Promise.resolve(found);
    },
    listAgents: () => Promise.resolve(agents),
    now: () => AT,
    hermes: {
      ...base,
      history: (box, bot, opts) => {
        calls.push("history");
        return base.history(box, bot, opts);
      },
      send: (box, bot, text, opts) => {
        calls.push("send");
        return base.send(box, bot, text, opts);
      },
      abort: (box, bot, opts) => {
        calls.push("abort");
        return base.abort(box, bot, opts);
      },
      observe: (box, bot, opts) => {
        calls.push("observe");
        return base.observe?.(box, bot, opts) ?? (async function* () {})();
      },
    },
    ...deps,
  });
  return { chat, activity, calls };
}

const WHERE = { instance: "atlas", bot: "default" };

/* ── the service harness ──────────────────────────────────────────────────── */

interface Script {
  /** What the next authoritative read answers with, in order. */
  reads: ChatObserveSnapshot[];
  /** Thrown instead of answering, once, when set for that read. */
  failures: (Error | null)[];
}

interface ServiceHarness {
  service: ReturnType<typeof createChatObservation>;
  /** How many authoritative reads happened. */
  snapshots: () => number;
  /** How many hint streams were opened. */
  opened: () => number;
  /** Every backoff the service slept for, in order. */
  slept: number[];
  /** Announce a hint on the open stream. */
  hint: () => void;
  /** End the open hint stream, as a dashboard restart does. */
  drop: () => void;
}

function message(id: string, text = id): ChatMessage {
  return { id, session: "s1", role: "user", at: AT, blocks: [{ kind: "text", markdown: text }] };
}

function service(script: Script, over: Partial<ChatObserveDeps> = {}): ServiceHarness {
  let reads = 0;
  let opened = 0;
  const slept: number[] = [];
  const listeners = new Set<{ push(): void; close(): void }>();
  const harness: ServiceHarness = {
    snapshots: () => reads,
    opened: () => opened,
    slept,
    hint: () => {
      for (const l of [...listeners]) l.push();
    },
    drop: () => {
      for (const l of [...listeners]) l.close();
    },
    service: createChatObservation({
      snapshot: () => {
        const failure = script.failures[reads] ?? null;
        const answer = script.reads[Math.min(reads, script.reads.length - 1)];
        reads += 1;
        if (failure) return Promise.reject(failure);
        return Promise.resolve({
          session: answer?.session ?? "s1",
          messages: [...(answer?.messages ?? [])],
        });
      },
      hints: (_target, opts) => {
        opened += 1;
        return (async function* (): AsyncIterable<ChatObserveHint> {
          const pending: number[] = [];
          let done = false;
          let wake: (() => void) | null = null;
          const nudge = (): void => {
            const w = wake;
            wake = null;
            w?.();
          };
          const listener = {
            push: () => {
              pending.push(1);
              nudge();
            },
            close: () => {
              done = true;
              nudge();
            },
          };
          listeners.add(listener);
          opts.signal?.addEventListener("abort", listener.close, { once: true });
          try {
            for (;;) {
              while (pending.length > 0) {
                pending.shift();
                yield {};
              }
              if (done) return;
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          } finally {
            listeners.delete(listener);
          }
        })();
      },
      now: () => AT,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      // Long enough that nothing in these tests is driven by the poll: every
      // reconcile below is provoked by a hint or by a retry, which is what makes
      // the assertions about *why* something happened meaningful.
      pollMs: 60_000,
      reconnect: { attempts: 3, baseMs: 1, maxMs: 4 },
      ...over,
    }),
  };
  return harness;
}

const TARGET = { instance: "atlas", bot: "default" };

/* ── the acceptance criteria, through the fixture ─────────────────────────── */

describe("chat.observe: external activity", () => {
  test("a message sent from Desktop, the CLI or a routine arrives with no local send", async () => {
    const { chat, activity } = harness();
    const watcher = watching((signal) => chat.observe(WHERE, { signal }));
    expect((await watcher.next())?.type).toBe("snapshot");

    // Nothing on this laptop sends anything. The message is appended to the
    // box's transcript by something else entirely, which is the whole case.
    activity.arrive(WHERE, "the nightly digest finished");

    const event = await watcher.next();
    expect(event?.type).toBe("message");
    if (event?.type === "message") {
      expect(event.message.blocks).toEqual([{ kind: "text", markdown: "the nightly digest finished" }]);
    }
    await watcher.stop();
  });

  test("an observation writes no inbox row, whatever it sees", async () => {
    /**
     * §4.9 gives `chat.message` one source: the `chat.swarms` roster diff. An
     * observation used to be a second one, and it could not work — it
     * reconciles mid-turn, before `done` advances the watermark, so it reported
     * the reply the operator was watching arrive as unread news.
     */
    const store = new MemoryNotificationStore();
    const { chat, activity } = harness({ notifications: { store, fleet: () => fleetItem.fleet_id } });
    const watcher = watching((signal) => chat.observe(WHERE, { signal }));
    await watcher.next();
    activity.arrive(WHERE, "the nightly digest finished");
    expect((await watcher.next())?.type).toBe("message");
    await settle();
    await watcher.stop();
    const inbox = { store, fleet: () => fleetItem.fleet_id };
    expect(notificationsList(inbox).notifications).toEqual([]);

    // Not a vacuous assertion: this inbox really is the one the surface was
    // built with, and the one source §4.9 names does reach it — a roster read
    // records its silent first-sighting watermark through it.
    await chat.swarms({ instance: WHERE.instance });
    expect(
      store.seenStatus(fleetItem.fleet_id, chatSeenSubject(WHERE.instance, WHERE.bot)),
    ).not.toBeNull();
  });

  test("observation sends nothing, creates nothing and stops nothing", async () => {
    const { chat, activity, calls } = harness();
    const watcher = watching((signal) => chat.observe(WHERE, { signal }));
    await watcher.next();
    activity.arrive(WHERE, "one");
    expect((await watcher.next())?.type).toBe("message");
    await watcher.stop();
    await settle();
    // The two reads an observation is allowed to make, and nothing else. A
    // `send` here would be a prompt nobody typed; an `abort` would be this
    // laptop stopping work on a box because a tab was open.
    expect(new Set(calls)).toEqual(new Set(["observe", "history"]));
  });

  test("two observers share one upstream stream and each sees the message once", async () => {
    const { chat, activity } = harness();
    const first = watching((signal) => chat.observe(WHERE, { signal }));
    expect((await first.next())?.type).toBe("snapshot");
    const second = watching((signal) => chat.observe(WHERE, { signal }));
    // The late joiner is handed the subscription's own snapshot rather than
    // provoking a second read of the box.
    expect((await second.next())?.type).toBe("snapshot");
    expect(activity.streams(WHERE)).toBe(1);

    activity.arrive(WHERE, "one message, two watchers");
    const a = await first.next();
    const b = await second.next();
    expect(a?.type).toBe("message");
    expect(b?.type).toBe("message");
    if (a?.type === "message" && b?.type === "message") expect(a.message.id).toBe(b.message.id);
    // Neither observer saw it twice, and neither cost a second stream.
    expect(await first.drain(200)).toEqual([]);
    expect(activity.streams(WHERE)).toBe(1);
    await first.stop();
    await second.stop();
  });

  test("a tab closing detaches only its own observation", async () => {
    const { chat, activity, calls } = harness();
    const staying = watching((signal) => chat.observe(WHERE, { signal }));
    await staying.next();
    const leaving = watching((signal) => chat.observe(WHERE, { signal }));
    await leaving.next();

    // The second tab closes. Local observation control, and nothing more.
    await leaving.stop();
    await settle();
    expect(calls).not.toContain("abort");

    activity.arrive(WHERE, "still watching");
    expect((await staying.next())?.type).toBe("message");
    // Still one upstream stream: the survivor kept the one it had rather than
    // the detach tearing it down and a reconnect building another.
    expect(activity.streams(WHERE)).toBe(1);
    await staying.stop();
  });

  test("a turn already accepted is never resent, and shows once across a reconnect", async () => {
    const { chat, activity, calls } = harness({
      observeTuning: {
        sleep: () => Promise.resolve(),
        pollMs: 20,
        reconnect: { attempts: 3, baseMs: 1, maxMs: 4 },
      },
    });
    // The operator sends. The box accepts it, and the durable transcript now
    // holds the prompt.
    for await (const _frame of chat.send({ ...WHERE, message: "restart the indexer" })) {
      // drained
    }
    const sends = calls.filter((c) => c === "send").length;
    expect(sends).toBe(1);
    const prompt = activity.arrive(WHERE, "restart the indexer", "durable-prompt-1");

    const watcher = watching((signal) => chat.observe(WHERE, { signal }));
    expect((await watcher.next())?.type).toBe("snapshot");
    // The stream is lost — a dashboard restart — and the box replays the row it
    // already holds when the observation comes back.
    activity.drop(WHERE);
    await settle();
    activity.arrive(WHERE, "restart the indexer", prompt.id);
    activity.arrive(WHERE, "and then reindex");

    // Reconnect timing is injected because this test covers what happens after
    // reconnect, not the separately tested production backoff duration. The
    // drain window stays at the file's default: it is an idle window paid once,
    // and a loaded runner must not be able to cut the replay short.
    const events = await watcher.drain();
    await watcher.stop();
    // Not one more prompt than the operator typed, and not one more copy of it
    // in the transcript the observation reported.
    expect(calls.filter((c) => c === "send").length).toBe(sends);
    const prompts = events.filter((e) => e.type === "message" && e.message.id === prompt.id);
    expect(prompts).toEqual([]);
    expect(events.filter((e) => e.type === "message").length).toBe(1);
  });
});

/**
 * The runtime gate, through `chat.ts` rather than through the service.
 *
 * `hermes.observe` is defined by every real adapter, so gating the hint channel
 * on whether the method exists answers a question nobody asked. What decides
 * whether hints work is what the socket does, and that is only knowable at
 * runtime — which is why a gateway that accepts the socket and closes it used
 * to look supported all the way to a terminal error.
 */
describe("chat.observe: hints are gated on what the socket did", () => {
  const closes = (): AsyncIterable<ChatObserveHint> =>
    (async function* (): AsyncIterable<ChatObserveHint> {})();

  test("a gateway that broadcasts nothing is not re-probed for the next conversation", async () => {
    const opens: string[] = [];
    const { chat } = harness({
      hermes: {
        ...fixtureChatClient({ activity: createFixtureChatActivity() }),
        observe: (_box, bot) => {
          opens.push(bot);
          return closes();
        },
      },
      observeTuning: {
        sleep: () => Promise.resolve(),
        pollMs: 20,
        reconnect: { attempts: 3, baseMs: 1, maxMs: 4 },
      },
    });

    const first = watching((signal) => chat.observe(WHERE, { signal }));
    expect((await first.next())?.type).toBe("snapshot");
    const advisories = await first.drain(150);
    expect(advisories.every((e) => e.type === "reconnect")).toBe(true);
    // The budget, spent once. No terminal error: the conversation is still
    // being read, on the poll floor.
    expect(opens.length).toBe(3);
    await first.stop();
    await settle();

    // A second conversation on the same box. The gateway has already shown what
    // its socket does, so this one starts on the poll floor instead of paying
    // the same thirty seconds of reconnects to learn it again.
    const second = watching((signal) => chat.observe({ instance: "atlas", bot: "scribe" }, { signal }));
    expect((await second.next())?.type).toBe("snapshot");
    expect(await second.drain(150)).toEqual([]);
    expect(opens.length).toBe(3);
    await second.stop();
  });

  test("a gateway that does broadcast is asked once and kept", async () => {
    const activity = createFixtureChatActivity();
    const opens: string[] = [];
    const { chat } = harness({
      hermes: {
        ...fixtureChatClient({ activity }),
        observe: (box, bot, opts) => {
          opens.push(bot);
          return fixtureChatClient({ activity }).observe?.(box, bot, opts) ?? closes();
        },
      },
    });
    const watcher = watching((signal) => chat.observe(WHERE, { signal }));
    expect((await watcher.next())?.type).toBe("snapshot");
    activity.arrive(WHERE, "the gateway does broadcast");
    expect((await watcher.next())?.type).toBe("message");
    expect(opens.length).toBe(1);
    await watcher.stop();
  });
});

/* ── the cursor and the reconnect policy ──────────────────────────────────── */

describe("chat.observe: cursor and reconnect", () => {
  test("a reconnect resumes from the cursor rather than replaying the transcript", async () => {
    const h = service({
      reads: [
        { session: "s1", messages: [message("m1"), message("m2")] },
        { session: "s1", messages: [message("m1"), message("m2")] },
        { session: "s1", messages: [message("m1"), message("m2"), message("m3")] },
      ],
      failures: [],
    });
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    expect((await watcher.next())?.type).toBe("snapshot");

    // The stream drops. The service spends one attempt, backs off and reopens,
    // and the read it makes on the way back returns the whole transcript again.
    h.drop();
    await settle();
    h.hint();

    const events = await watcher.drain(300);
    await watcher.stop();
    const delivered = events.filter((e) => e.type === "message");
    expect(delivered.map((e) => (e.type === "message" ? e.message.id : ""))).toEqual(["m3"]);
    expect(events.filter((e) => e.type === "reconnect").length).toBe(1);
  });

  test("a row upstream returns twice is delivered once", async () => {
    const h = service({
      reads: [
        { session: "s1", messages: [message("m1")] },
        // The same durable row twice inside one page: an upstream replay.
        { session: "s1", messages: [message("m1"), message("m2"), message("m2")] },
      ],
      failures: [],
    });
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    await watcher.next();
    h.hint();
    const events = await watcher.drain(300);
    await watcher.stop();
    expect(events.filter((e) => e.type === "message").length).toBe(1);
  });

  test("the reconnect budget is bounded, and the backoff is the documented one", async () => {
    let opened = 0;
    const h = service(
      { reads: [{ session: "s1", messages: [] }], failures: [] },
      {
        // A hint stream that ends the instant it is opened: the pathological
        // case, and the one an unbounded retry would spin on for ever.
        hints: () => {
          opened += 1;
          return (async function* (): AsyncIterable<ChatObserveHint> {})();
        },
      },
    );
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    const events = await watcher.take(4);
    const reconnects = events.filter((e) => e.type === "reconnect");
    expect(reconnects.length).toBe(3);
    expect(reconnects.map((e) => (e.type === "reconnect" ? e.delay_ms : 0))).toEqual([1, 2, 4]);
    expect(reconnects.map((e) => (e.type === "reconnect" ? e.attempt : 0))).toEqual([1, 2, 3]);
    expect(h.slept).toEqual([1, 2, 4]);
    // Three reopens and not a fourth, however long the watch runs: the first
    // open plus one per attempt of the budget.
    expect(opened).toBe(4);
    expect(await watcher.drain(200)).toEqual([]);
    expect(opened).toBe(4);
    expect(h.slept).toEqual([1, 2, 4]);
    await watcher.stop();
  });

  test("a failure retrying cannot fix ends the observation at once", async () => {
    const refusal = new HermeticError(
      "VALIDATION",
      "atlas: listen to this instance before opening chat",
    );
    const h = service({ reads: [{ session: "s1", messages: [] }], failures: [refusal] });
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    const events = await watcher.take(1);
    await watcher.stop();
    expect(events[0]?.type).toBe("error");
    expect(h.slept).toEqual([]);
  });

  test("a second observer joins the subscription rather than building one", async () => {
    const h = service({ reads: [{ session: "s1", messages: [message("m1")] }], failures: [] });
    const first = watching((signal) => h.service.observe(TARGET, { signal }));
    await first.next();
    const second = watching((signal) => h.service.observe(TARGET, { signal }));
    await second.next();
    await settle();
    expect(h.opened()).toBe(1);
    // The late joiner cost no upstream read at all.
    expect(h.snapshots()).toBe(1);
    await first.stop();
    await second.stop();
  });

  test("the last observer leaving ends the subscription", async () => {
    const h = service({ reads: [{ session: "s1", messages: [] }], failures: [] });
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    await watcher.next();
    expect(h.service.observers(TARGET)).toBe(1);
    await watcher.stop();
    await settle();
    expect(h.service.observers(TARGET)).toBe(0);

    // The loop really stopped, rather than the registry merely forgetting it: a
    // hint on the stream it used to hold provokes no further read of the box.
    // A subscription that outlived its last observer would go on reading a
    // conversation nobody is watching for as long as the portal runs.
    const reads = h.snapshots();
    h.hint();
    await settle();
    expect(h.snapshots()).toBe(reads);
  });
});

/* ── the degrade: a gateway that broadcasts nothing ───────────────────────── */

/**
 * The failure fixture-mode QA found and no unit test did.
 *
 * A gateway whose hint socket closes the instant it is opened used to kill the
 * observation exactly `1+2+4+8+16` seconds after it started: the one shared
 * retry counter was reset only by a stream that survived a wait, a stream that
 * ends at once never survives one, so the budget burnt straight through and the
 * loop emitted a terminal `error` — which the portal shows as `Watch again` and
 * does not retry. Every authoritative read was succeeding throughout.
 *
 * The clock is injected, so "past the point the old code died" is expressed as
 * "after the whole budget has been spent" rather than as thirty-one real
 * seconds. `sleep` resolves at once and the poll floor is 20ms, so the whole
 * file still runs inside its `PATIENCE_MS` bound.
 */
interface PollingHarness {
  service: ReturnType<typeof createChatObservation>;
  /** The box's transcript. Push to it to make something arrive over there. */
  messages: ChatMessage[];
  slept: number[];
  reads: () => number;
  opened: () => number;
}

function polling(over: Partial<ChatObserveDeps> = {}): PollingHarness {
  const messages: ChatMessage[] = [];
  let reads = 0;
  let opened = 0;
  const slept: number[] = [];
  return {
    messages,
    slept,
    reads: () => reads,
    opened: () => opened,
    service: createChatObservation({
      snapshot: () => {
        reads += 1;
        return Promise.resolve({ session: "s1", messages: [...messages] });
      },
      hints: () => {
        opened += 1;
        // Accepts the socket and closes it at once, which is the shape an older
        // Hermes, a proxy, or a middlebox that drops the upgrade produces.
        return (async function* (): AsyncIterable<ChatObserveHint> {})();
      },
      now: () => AT,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      pollMs: 20,
      reconnect: { attempts: 3, baseMs: 1, maxMs: 4 },
      ...over,
    }),
  };
}

describe("chat.observe: a hint channel that does not work", () => {
  test("a hint stream that ends at once degrades to polling and keeps delivering", async () => {
    const h = polling();
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    expect((await watcher.next())?.type).toBe("snapshot");

    // The advisories the bounded budget spends, and then silence rather than a
    // terminal error: the hint channel is gone, the observation is not.
    const advisories = await watcher.drain(150);
    expect(advisories.map((e) => e.type)).toEqual(["reconnect", "reconnect", "reconnect"]);

    // Past the point the old code was already dead. Something arrives on the
    // box with nothing sent from here, and the poll floor still finds it.
    h.messages.push(message("m1"));
    const first = await watcher.next(500);
    expect(first?.type).toBe("message");
    if (first?.type === "message") expect(first.message.id).toBe("m1");
    await watcher.stop();
  });

  test("polling keeps delivering at the floor for as long as hints are unavailable", async () => {
    const h = polling();
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    await watcher.next();
    await watcher.drain(150);

    // Two messages, separated in time, each found by a different poll tick.
    for (const id of ["m1", "m2"]) {
      h.messages.push(message(id));
      const event = await watcher.next(500);
      expect(event?.type).toBe("message");
      if (event?.type === "message") expect(event.message.id).toBe(id);
    }
    await watcher.stop();
  });

  test("a hint stream that ends at once does not reopen without bound", async () => {
    const h = polling();
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    await watcher.next();
    await watcher.drain(150);
    // One open, plus one for each attempt of the budget. The original failure
    // this bound exists to prevent was an open per loop pass, for ever.
    expect(h.opened()).toBe(4);
    expect(h.slept).toEqual([1, 2, 4]);

    const reads = h.reads();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.opened()).toBe(4);
    // And it is not a dead loop it has settled into: the poll floor kept
    // reading the box across those ticks.
    expect(h.reads()).toBeGreaterThan(reads);
    await watcher.stop();
  });

  test("the hint channel closing is reported under its own code, not the read's", async () => {
    const h = polling();
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    await watcher.next();
    const advisories = await watcher.drain(150);
    await watcher.stop();
    const codes = advisories.map((e) => (e.type === "reconnect" ? e.code : e.type));
    expect(new Set(codes)).toEqual(new Set(["CHAT_HINTS_ENDED"]));
  });

  test("a conversation the box will not answer at all still ends in a terminal error", async () => {
    const h = polling({
      // The hint channel is irrelevant here; the read is what has gone, and the
      // read is the only thing that can prove a conversation unobservable.
      snapshot: () => Promise.reject(new HermeticError("CHAT_UNREACHABLE", "atlas: no answer")),
    });
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    const events = await watcher.take(4);
    await watcher.stop();
    expect(events.slice(0, 3).map((e) => e.type)).toEqual(["reconnect", "reconnect", "reconnect"]);
    const last = events[3];
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.code).toBe("CHAT_UNREACHABLE");
      expect(last.message).toContain("gave up after 3 attempts");
    }
  });

  test("a gateway with no hint channel at all polls, and opens nothing", async () => {
    const h = polling({ hints: undefined });
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    expect((await watcher.next())?.type).toBe("snapshot");
    h.messages.push(message("m1"));
    expect((await watcher.next(500))?.type).toBe("message");
    expect(h.opened()).toBe(0);
    expect(h.slept).toEqual([]);
    await watcher.stop();
  });

  test("a hints factory that throws synchronously degrades to a poll rather than dying", async () => {
    // `deps.hints` itself throwing before handing back a stream — not the
    // stream ending or misbehaving once open, which the tests above cover.
    // `chat.ts`'s own `hints` can never do this (it hands back an async
    // generator, which defers a throw into the first `next()`), but any other
    // `ChatObserveDeps` can, and the open site used to sit outside the loop's
    // try/catch: a synchronous throw there would escape the detached `run()`,
    // leaving the subscription registered with an observer mailbox open and
    // nothing left to feed it.
    let factoryCalls = 0;
    const h = polling({
      hints: () => {
        factoryCalls += 1;
        throw new Error("gateway rejected the upgrade synchronously");
      },
    });
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    expect((await watcher.next())?.type).toBe("snapshot");
    h.messages.push(message("m1"));
    expect((await watcher.next(500))?.type).toBe("message");
    // The throw happens before a stream is ever handed back, so nothing was
    // opened to leak, and no reconnect advisory was ever due — the catch
    // spends `hintAttempt` silently, the same way a stream that reaches its
    // own budget's end does.
    expect(h.opened()).toBe(0);
    expect(h.slept).toEqual([]);
    // The degrade is bounded, not a poll-interval-paced retry forever: once
    // `hintAttempt` passes `attempts` (3, from `polling()`'s reconnect config)
    // the catch sets `pollOnly` and `wantHints` stops calling the factory at
    // all. Proven by letting real time pass well past the point four more
    // poll ticks would have produced four more calls, and seeing none of them.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const callsAtBudget = factoryCalls;
    expect(callsAtBudget).toBe(4);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(factoryCalls).toBe(callsAtBudget);
    await watcher.stop();
  });
});

/* ── §8.3: a failure is not a way out for a secret ────────────────────────── */

/**
 * The snapshot path's *results* are sealed by `chat.ts` on the way out of every
 * public method, and its messages are redacted row by row before that. A
 * failure raised while watching goes nowhere near either door: it is caught in
 * `run`, turned into a `reconnect` or an `error` event, and emitted straight to
 * every observer — and, in the portal, straight into `portal.log`, which is a
 * file on the laptop. §8.3 covers that file too.
 *
 * The sentinel below is a `FIXTURE` value, as every planted secret in this repo
 * must be, and it is the same `sk-ant-` family `tests/chat-redaction.test.ts`
 * enumerates.
 */
describe("chat.observe: a failure never carries a secret out", () => {
  const SECRET = "sk-ant-FIXTUREANTHROPICKEY";
  const LEAKY = `the gateway refused ${SECRET}`;

  test("a retryable failure is masked in the reconnect event it produces", async () => {
    const h = service({
      reads: [{ session: "s1", messages: [] }],
      failures: [new HermeticError("CHAT_UNREACHABLE", LEAKY)],
    });
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    const events = await watcher.take(1);
    await watcher.stop();
    const first = events[0];
    expect(first?.type).toBe("reconnect");
    if (first?.type !== "reconnect") throw new Error("expected a reconnect event");
    expect(first.message).not.toContain(SECRET);
    expect(first.message).toContain(REDACTED);
    // Masked, not discarded: the operator still learns what refused them.
    expect(first.message).toContain("the gateway refused");
    expect(first.code).toBe("CHAT_UNREACHABLE");
  });

  test("a terminal failure is masked in the error event it produces", async () => {
    const h = service({
      reads: [{ session: "s1", messages: [] }],
      failures: [new HermeticError("VALIDATION", LEAKY)],
    });
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    const events = await watcher.take(1);
    await watcher.stop();
    const first = events[0];
    expect(first?.type).toBe("error");
    if (first?.type !== "error") throw new Error("expected an error event");
    expect(first.message).not.toContain(SECRET);
    expect(first.message).toContain(REDACTED);
  });

  /**
   * The hint stream is the half the snapshot path's redaction cannot reach at
   * all: it is the adapter's socket, and a handshake that echoes the session
   * token it was refused with fails here rather than inside `chat.history`.
   */
  test("a hint stream that fails is masked too, and it is a different path", async () => {
    const h = service(
      { reads: [{ session: "s1", messages: [] }], failures: [] },
      {
        // An iterator that refuses rather than an empty generator: the failure
        // has to come *out of the stream*, which is the path `reason` guards.
        hints: (): AsyncIterable<ChatObserveHint> => ({
          [Symbol.asyncIterator]: () => ({
            next: (): Promise<IteratorResult<ChatObserveHint>> =>
              Promise.reject(new HermeticError("CHAT_UNREACHABLE", LEAKY)),
          }),
        }),
      },
    );
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    const events = await watcher.take(2);
    await watcher.stop();
    const failure = events.find((e) => e.type === "reconnect" || e.type === "error");
    expect(failure).toBeDefined();
    const said = failure?.type === "reconnect" || failure?.type === "error" ? failure.message : "";
    expect(said).not.toContain(SECRET);
    expect(said).toContain(REDACTED);
  });

  /** A plain `Error` is masked on the same path, under `UNKNOWN`. */
  test("an unclassified throw is masked as well", async () => {
    const h = service({
      reads: [{ session: "s1", messages: [] }],
      failures: [new Error(LEAKY)],
    });
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    const events = await watcher.take(1);
    await watcher.stop();
    const first = events[0];
    if (first?.type !== "error") throw new Error("expected an error event");
    expect(first.code).toBe("UNKNOWN");
    expect(first.message).not.toContain(SECRET);
    expect(first.message).toContain(REDACTED);
  });
});

/**
 * The hint channel's whole reason to exist is the gap between "a message
 * arrived" and "the poll floor came round", so a hint that is silently dropped
 * is not a small loss: the observation still works, it just works no better
 * than the five-second poll it was built to beat. Observation's whole promise
 * is that an external message arrives immediately, and this is the test that
 * holds it to that.
 */
describe("chat.observe: a hint survives the wait that did not deliver it", () => {
  test("a hint raised after whole poll intervals have elapsed wakes the read at once", async () => {
    const POLL_MS = 200;
    const arrivals: ChatMessage[] = [message("m0")];
    let reads = 0;
    const h = service(
      { reads: [], failures: [] },
      {
        pollMs: POLL_MS,
        snapshot: () => {
          reads += 1;
          return Promise.resolve({ session: "s1", messages: [...arrivals] });
        },
      },
    );
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    expect((await watcher.next())?.type).toBe("snapshot");

    // Two whole intervals go by with nothing to say. Each one ends a wait that
    // the hint read lost, and a lost race that abandons its pull is what leaves
    // the next hint answering a promise nobody is holding.
    const ticked = reads;
    while (reads < ticked + 2) await settle();

    // A tick has just fired, so a whole interval is now free: anything that
    // arrives inside a quarter of one arrived because of the hint and not
    // because the poll came round again.
    arrivals.push(message("m1"));
    h.hint();

    const event = await watcher.next(POLL_MS / 4);
    expect(event).toMatchObject({ type: "message", message: { id: "m1" } });
    await watcher.stop();
  });

  test("hints keep being delivered promptly, tick after tick", async () => {
    const POLL_MS = 200;
    const arrivals: ChatMessage[] = [message("m0")];
    let reads = 0;
    const h = service(
      { reads: [], failures: [] },
      {
        pollMs: POLL_MS,
        snapshot: () => {
          reads += 1;
          return Promise.resolve({ session: "s1", messages: [...arrivals] });
        },
      },
    );
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    expect((await watcher.next())?.type).toBe("snapshot");

    // One swallowed hint per elapsed tick compounds, so the repeat is the
    // assertion: a channel that is consumed and re-read stays correct, one that
    // queues a second read behind an abandoned one falls a hint further behind
    // every interval.
    for (const id of ["m1", "m2"]) {
      const ticked = reads;
      while (reads < ticked + 1) await settle();
      arrivals.push(message(id));
      h.hint();
      expect(await watcher.next(POLL_MS / 4)).toMatchObject({
        type: "message",
        message: { id },
      });
    }

    // And one stream throughout: nothing here reopened the channel.
    expect(h.opened()).toBe(1);
    await watcher.stop();
  });
});

/**
 * Dropping one hint stream, as a thing the loop can actually do.
 *
 * A watch re-opens its hint stream on every read outage, so "drop the stream"
 * has to mean the gateway side unwinds — otherwise a pinned portal observation
 * accumulates one live upstream socket per outage for as long as it is pinned.
 * `return()` alone cannot deliver that: an async generator answers requests in
 * queue order, so a `return()` issued while a `next()` is still parked on a
 * silent gateway is answered after that `next()`, which is never. Both tests
 * below drive the drop from the read-failure path, because that is the one the
 * portal actually takes.
 */
describe("chat.observe: dropping a hint stream really cancels it", () => {
  test("a stream dropped on a read failure unwinds while its pull is still parked", async () => {
    /** Set by the generator's own `finally`. The whole assertion. */
    let unwound = false;
    let opened = 0;
    const outage = new HermeticError("CHAT_UNREACHABLE", "atlas: the box did not answer");
    const h = service(
      { reads: [{ session: "s1", messages: [] }], failures: [null, outage] },
      {
        // The poll floor is what brings the loop back round to the read that
        // fails. No hint ever arrives to do it, which is the point.
        pollMs: 5,
        hints: (_target, opts) => {
          opened += 1;
          return (async function* (): AsyncIterable<ChatObserveHint> {
            try {
              /**
               * A gateway that is connected and silent. The pull parks here and
               * nothing settles it but the signal — which is precisely what the
               * real socket does: `runtimeSocket` closes on abort, its frame
               * generator returns, and the adapter's `for await` unwinds. If
               * the abort never reaches *this* stream the park is forever, the
               * `return()` queued behind it is never answered, and the
               * `finally` below never runs.
               */
              await new Promise<void>((resolve) => {
                opts.signal?.addEventListener("abort", () => resolve(), { once: true });
              });
            } finally {
              unwound = true;
            }
          })();
        },
      },
    );
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    expect((await watcher.next())?.type).toBe("snapshot");
    expect((await watcher.next())?.type).toBe("reconnect");
    await settle();
    // The gateway side ran its unwind, having yielded nothing: the pull the
    // loop was holding was never answered by a hint, only by the cancellation.
    expect(unwound).toBe(true);
    // And what was dropped was one stream, not the observation: the loop opened
    // a replacement rather than ending.
    expect(opened).toBe(2);
    await watcher.stop();
  });

  test("a stream whose `return()` throws synchronously does not take the loop with it", async () => {
    const refusal = new HermeticError(
      "VALIDATION",
      "atlas: listen to this instance before opening chat",
    );
    let returned = 0;
    const h = service(
      { reads: [{ session: "s1", messages: [] }], failures: [null, refusal] },
      {
        pollMs: 5,
        hints: (): AsyncIterable<ChatObserveHint> => ({
          [Symbol.asyncIterator]: (): AsyncIterator<ChatObserveHint> => ({
            /** Never answers. This is the stream the loop is trying to drop. */
            next: () => new Promise<IteratorResult<ChatObserveHint>>(() => undefined),
            /**
             * Legal for a hand-written iterator, and the reason the guard has
             * to wrap the *call*: a synchronous throw is raised before
             * `Promise.resolve` is ever reached, so catching the rejection
             * catches nothing.
             */
            return: (): never => {
              returned += 1;
              throw new Error("this iterator refuses to be closed");
            },
          }),
        }),
      },
    );
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    expect((await watcher.next())?.type).toBe("snapshot");
    /**
     * `close()` runs inside the detached `void run(sub)`, so a throw escaping
     * it would take the loop out from under its own cleanup: the subscription
     * would stay registered and every observer mailbox would be left open,
     * waiting on a watch that had stopped. This terminal event is the proof
     * that the cleanup stayed inside.
     */
    expect((await watcher.next())?.type).toBe("error");
    expect(returned).toBe(1);
    await watcher.stop();
  });
});

/* ── the canonical session rolling over ───────────────────────────────────── */

/**
 * A conversation that is archived and reopened is a *different* conversation,
 * and the set difference that drives every other read has nothing to say about
 * it: every row of the new transcript is unseen, so a cursor-only service
 * announces a whole conversation as a run of arrivals. Each one is labelled
 * with a session the consumer has never heard of, none of them replaces the
 * transcript they supersede, and a head that folds them onto the read it holds
 * ends up with two sessions' rows under one session's name.
 *
 * So the rule is not "the first read is a snapshot" but "an authoritative read
 * of a session the consumer is not already holding is a snapshot".
 */
describe("chat.observe: a session rollover is a new read, not a run of arrivals", () => {
  /** `message` above pins every row to `s1`; a rollover needs rows from two. */
  const row = (id: string, session: string): ChatMessage => ({
    id,
    session,
    role: "user",
    at: AT,
    blocks: [{ kind: "text", markdown: id }],
  });

  test("a read whose session changed is announced as a snapshot, not as messages", async () => {
    const h = service({
      reads: [
        { session: "s1", messages: [row("a1", "s1"), row("a2", "s1")] },
        // Archived, and `chat.open` established a new canonical session. Every
        // id here is new, which is exactly why a set difference gets it wrong.
        { session: "s2", messages: [row("b1", "s2"), row("b2", "s2")] },
      ],
      failures: [],
    });
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    expect(await watcher.next()).toMatchObject({
      type: "snapshot",
      session: "s1",
      messages: [{ id: "a1" }, { id: "a2" }],
    });

    await settle();
    h.hint();
    const events = await watcher.drain(300);
    await watcher.stop();

    // One event, and it replaces. Not two `message` deltas carrying `s2` onto a
    // transcript still labelled `s1`.
    expect(events.map((e) => e.type)).toEqual(["snapshot"]);
    expect(events[0]).toMatchObject({
      type: "snapshot",
      session: "s2",
      messages: [{ id: "b1" }, { id: "b2" }],
    });
  });

  test("the cursor is rebuilt from the new read, so nothing old suppresses a new row", async () => {
    // `b1` is the id a row of the *old* session already had. If the window
    // survived the rollover it would swallow the new session's row of that name.
    const h = service({
      reads: [
        { session: "s1", messages: [row("b1", "s1")] },
        { session: "s2", messages: [row("b1", "s2"), row("b2", "s2")] },
        { session: "s2", messages: [row("b1", "s2"), row("b2", "s2"), row("b3", "s2")] },
      ],
      failures: [],
    });
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    expect((await watcher.next())?.type).toBe("snapshot");

    await settle();
    h.hint();
    expect(await watcher.next()).toMatchObject({
      type: "snapshot",
      session: "s2",
      messages: [{ id: "b1" }, { id: "b2" }],
    });

    // And the read after the rollover is a difference against the new window,
    // not against the one the retired session left behind.
    await settle();
    h.hint();
    const after = await watcher.drain(300);
    await watcher.stop();
    expect(after.map((e) => e.type)).toEqual(["message"]);
    expect(after[0]).toMatchObject({ type: "message", session: "s2", message: { id: "b3" } });
  });

  test("a null canonical session counts on both sides of the comparison", async () => {
    const reads: ChatObserveSnapshot[] = [
      { session: null, messages: [] },
      // Still no canonical session: `null` to `null` is not a rollover, so the
      // row that appeared is a delta like any other.
      { session: null, messages: [row("a1", "s1")] },
      // A bot acquiring its first session has rolled over.
      { session: "s2", messages: [row("b1", "s2")] },
      // And so has one whose session was retired back to none.
      { session: null, messages: [] },
    ];
    let reading = 0;
    const h = service(
      { reads: [], failures: [] },
      {
        snapshot: () => {
          const answer = reads[Math.min(reading, reads.length - 1)];
          reading += 1;
          return Promise.resolve({
            session: answer?.session ?? null,
            messages: [...(answer?.messages ?? [])],
          });
        },
      },
    );
    const watcher = watching((signal) => h.service.observe(TARGET, { signal }));
    expect(await watcher.next()).toMatchObject({ type: "snapshot", session: null, messages: [] });

    await settle();
    h.hint();
    expect(await watcher.next()).toMatchObject({
      type: "message",
      session: null,
      message: { id: "a1" },
    });

    await settle();
    h.hint();
    expect(await watcher.next()).toMatchObject({
      type: "snapshot",
      session: "s2",
      messages: [{ id: "b1" }],
    });

    await settle();
    h.hint();
    expect(await watcher.next()).toMatchObject({ type: "snapshot", session: null, messages: [] });
    await watcher.stop();
  });
});

/* ── hints across a compression ───────────────────────────────────────────── */

/**
 * Upstream's `session.compress` writes the continuation under a *new* session
 * id and broadcasts under it (`hermes_state_compression.py`'s lineage). A watch
 * pinned to the id the operator opened therefore stops recognising its own
 * conversation's events the first time it is compressed — and because a hint is
 * only ever advisory, nothing reports the loss: the watch silently falls back
 * to the poll floor and every external message arrives up to five seconds late.
 */
describe("chat.observe: a session that compressed under the watch", () => {
  const ROOT = "sess-root";
  const TIP = "sess-tip";

  /** The live adapter over a socket that says one thing. */
  function adapter(event: Record<string, unknown>) {
    return createChatObserve({
      connect: () =>
        Promise.resolve({
          request: () => Promise.resolve(null),
          events: (async function* () {
            yield event;
          })(),
          arrived: () => 1,
          close: () => undefined,
        }),
    });
  }

  const BOX = { instance: "atlas", baseUrl: "https://atlas.example.ts.net", fleet_id: "fxtr0001" };

  async function hints(opts: ObserveOptions): Promise<ChatObserveHint[]> {
    const out: ChatObserveHint[] = [];
    for await (const hint of adapter({ session_id: TIP }).observe(BOX, "default", opts)) {
      out.push(hint);
    }
    return out;
  }

  test("a hint naming the tip reaches a watch pinned to the root", async () => {
    expect(await hints({ session: ROOT, sessions: () => [ROOT, TIP] })).toEqual([{ session: TIP }]);
  });

  test("a hint about somebody else's conversation is still dropped", async () => {
    expect(await hints({ session: ROOT, sessions: () => [ROOT] })).toEqual([]);
  });

  test("a watch that named no session is unchanged: it takes everything", async () => {
    expect(await hints({})).toEqual([{ session: TIP }]);
  });

  test("the observation tells the adapter which session its last read resolved to", async () => {
    let ask: (() => readonly string[]) | undefined;
    const service = createChatObservation({
      snapshot: () => Promise.resolve({ session: TIP, messages: [] }),
      hints: (_target, opts) => {
        ask = opts.sessions;
        return (async function* (): AsyncIterable<ChatObserveHint> {
          await new Promise<void>((resolve) => opts.signal?.addEventListener("abort", () => resolve()));
        })();
      },
      now: () => AT,
      sleep: () => Promise.resolve(),
      pollMs: 60_000,
    });
    const watcher = watching((signal) => service.observe({ ...TARGET, session: ROOT }, { signal }));
    await watcher.next();
    await settle();
    // The pinned id, because that is what the operator asked to watch, and the
    // tip, because that is where the box is writing.
    // Asked at each event, never at open: at open the tip is not known yet.
    expect([...(ask?.() ?? [])].sort()).toEqual([ROOT, TIP].sort());
    await watcher.stop();
  });
});
