/**
 * The observation's poll floor (§9.2): the long floor (`OBSERVE_HINTED_POLL_MS`)
 * only while a hint stream is open and healthy, the conversation idle and no
 * turn busy; the short one (`OBSERVE_POLL_MS`) otherwise. A hint wakes the read
 * at once whichever floor is in force.
 *
 * Real timers, scaled down: the short floor is 10ms and the long one 10s, so
 * "how many reads in 300ms" tells the two apart by two orders of magnitude.
 * The activity window runs on an injected clock, so it is moved by assignment.
 */
import { describe, expect, test } from "bun:test";
import {
  OBSERVE_HINTED_POLL_MS,
  OBSERVE_HOT_MS,
  OBSERVE_POLL_MS,
  createChatObservation,
} from "../src/chat/chat-observe.ts";
import type { ChatObserveDeps, ChatObserveHint } from "../src/chat/chat-observe.ts";
import type { ChatMessage, ChatObserveEvent } from "../src/schema/index.ts";

const AT = "2026-10-17T09:00:00.000Z";
const TARGET = { instance: "atlas", bot: "default" };
const SHORT = 10;
const LONG = 10_000;
const HOT = 1_000;

function message(id: string): ChatMessage {
  return { id, session: "s1", role: "user", at: AT, blocks: [{ kind: "text", markdown: id }] };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until a counter stops moving for 50ms, and return where it settled. */
async function steady(count: () => number): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const before = count();
    await pause(50);
    if (count() === before) return before;
  }
  throw new Error("the counter never settled");
}

/** A hint stream that stays open and silent until `push`. */
function hintSource() {
  const waiting: ((result: IteratorResult<ChatObserveHint>) => void)[] = [];
  const queued: ChatObserveHint[] = [];
  return {
    push(hint: ChatObserveHint = {}): void {
      const next = waiting.shift();
      if (next) next({ value: hint, done: false });
      else queued.push(hint);
    },
    open(_target: unknown, opts: { signal?: AbortSignal | undefined }): AsyncIterable<ChatObserveHint> {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const ready = queued.shift();
            if (ready) return Promise.resolve({ value: ready, done: false });
            return new Promise<IteratorResult<ChatObserveHint>>((resolve) => {
              waiting.push(resolve);
              opts.signal?.addEventListener("abort", () => resolve({ value: undefined, done: true }), {
                once: true,
              });
            });
          },
          return: () => Promise.resolve({ value: undefined, done: true }),
        }),
      };
    },
  };
}

function rig(over: Partial<ChatObserveDeps> = {}) {
  const transcript: ChatMessage[] = [message("m0")];
  let reads = 0;
  let now = 0;
  const events: ChatObserveEvent[] = [];
  const controller = new AbortController();
  const service = createChatObservation({
    snapshot: () => {
      reads += 1;
      return Promise.resolve({ session: "s1", messages: [...transcript] });
    },
    now: () => AT,
    clock: () => now,
    pollMs: SHORT,
    hintedPollMs: LONG,
    hotMs: HOT,
    ...over,
  });
  const done = (async () => {
    for await (const event of service.observe(TARGET, { signal: controller.signal }))
      events.push(event);
  })();
  return {
    transcript,
    events,
    reads: () => reads,
    advance: (ms: number) => {
      now += ms;
    },
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

describe("chat.observe: the poll floor", () => {
  test("the defaults: five seconds without hints, a minute with healthy ones", () => {
    expect(OBSERVE_POLL_MS).toBe(5_000);
    expect(OBSERVE_HINTED_POLL_MS).toBe(60_000);
    expect(OBSERVE_HOT_MS).toBe(60_000);
  });

  test("an idle conversation with a healthy hint stream waits the long floor", async () => {
    const hints = hintSource();
    const r = rig({ hints: hints.open });
    await pause(300);
    // The first read and nothing after it: the short floor would be ~30 reads.
    expect(r.reads()).toBe(1);
    await r.stop();
  });

  test("no hint stream keeps the short floor", async () => {
    const r = rig();
    await pause(300);
    expect(r.reads()).toBeGreaterThan(5);
    await r.stop();
  });

  test("a hint stream shown not to work keeps the short floor", async () => {
    const hints = hintSource();
    const r = rig({ hints: hints.open, hintsUsable: () => false });
    await pause(300);
    expect(r.reads()).toBeGreaterThan(5);
    await r.stop();
  });

  test("a stream being reopened after it ended keeps the short floor until it survives a wait", async () => {
    // The first stream ends at once; its replacement stays open and silent.
    const hints = hintSource();
    let opened = 0;
    const r = rig({
      hints: (target, opts) => {
        opened += 1;
        return opened === 1
          ? (async function* (): AsyncIterable<ChatObserveHint> {})()
          : hints.open(target, opts);
      },
      sleep: () => Promise.resolve(),
    });
    await pause(300);
    // The first read, the read after the reopen, one short wait for the new
    // stream to prove itself and the read after it — then the long floor.
    expect(opened).toBe(2);
    expect(r.reads()).toBe(3);
    await r.stop();
  });

  test("a stream whose every open ends settles onto the short floor", async () => {
    const r = rig({
      hints: () => (async function* (): AsyncIterable<ChatObserveHint> {})(),
      sleep: () => Promise.resolve(),
      reconnect: { attempts: 2, baseMs: 1, maxMs: 1 },
    });
    await pause(300);
    expect(r.reads()).toBeGreaterThan(5);
    await r.stop();
  });

  test("a turn that reads busy keeps the short floor", async () => {
    const hints = hintSource();
    const r = rig({ hints: hints.open, busy: () => Promise.resolve(true) });
    await pause(300);
    expect(r.reads()).toBeGreaterThan(5);
    await r.stop();
  });

  test("an idle answer from the busy probe lets the floor lengthen", async () => {
    const hints = hintSource();
    const r = rig({ hints: hints.open, busy: () => Promise.resolve(false) });
    await pause(300);
    // One short wait while the first probe is out, then the long floor.
    expect(r.reads()).toBeLessThanOrEqual(2);
    await r.stop();
  });

  test("a hint wakes the read at once under the long floor, then activity keeps it short", async () => {
    const hints = hintSource();
    const r = rig({ hints: hints.open });
    await pause(50);
    expect(r.reads()).toBe(1);

    r.transcript.push(message("m1"));
    hints.push();
    await pause(30);
    expect(r.events.some((e) => e.type === "message")).toBe(true);

    // Inside the activity window: back on the short floor.
    const hot = r.reads();
    await pause(150);
    expect(r.reads()).toBeGreaterThan(hot + 3);

    // Past it: the next wait is the long one again. Settled first, so a short
    // timer already running when the clock moved is not counted against it.
    r.advance(HOT + 1);
    const cooled = await steady(r.reads);
    await pause(200);
    expect(r.reads()).toBe(cooled);
    await r.stop();
  });

  test("a box-wide hint wakes a read but does not hold the short floor", async () => {
    const hints = hintSource();
    const r = rig({ hints: hints.open });
    await pause(30);
    // No session: another bot's change, a cron edit, a pairing.
    hints.push({});
    await pause(30);
    expect(r.reads()).toBe(2);
    await pause(200);
    expect(r.reads()).toBe(2);
    // A hint naming this conversation is activity.
    hints.push({ session: "s1" });
    await pause(150);
    expect(r.reads()).toBeGreaterThan(5);
    await r.stop();
  });
});
