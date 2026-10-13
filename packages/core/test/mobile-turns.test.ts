/**
 * The bridge's turn registry (`mobile/turns.ts`): a turn runs to the end with
 * nobody attached, every frame gets a bridge `n`, a resume replays exactly what
 * came after `after`, a full buffer drops the oldest and says so, finished
 * turns are swept after retention, and an abort ends the turn `aborted`.
 */
import { describe, expect, test } from "bun:test";
import { HermeticError } from "../src/errors.ts";
import type { ChatFrame } from "../src/schema/index.ts";
import { createTurnRegistry, type TurnEvent } from "../src/mobile/turns.ts";

/** A `chat.send` the test feeds by hand. */
function manualSend() {
  const queue: Array<ChatFrame | Error | null> = [];
  let wake: (() => void) | null = null;
  const sent: unknown[] = [];
  let signal: AbortSignal | null = null;
  return {
    sent,
    signal: () => signal,
    push(item: ChatFrame | Error | null) {
      queue.push(item);
      wake?.();
    },
    send(input: unknown, opts: { signal: AbortSignal }): AsyncIterable<ChatFrame> {
      sent.push(input);
      signal = opts.signal;
      return (async function* () {
        for (;;) {
          while (queue.length > 0) {
            const item = queue.shift();
            if (item === null || item === undefined) return;
            if (item instanceof Error) throw item;
            yield item;
          }
          if (opts.signal.aborted) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
            opts.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      })();
    },
  };
}

const delta = (seq: number, text: string): ChatFrame => ({ type: "delta", seq, message: "m1", text });
const done = (seq: number): ChatFrame => ({ type: "done", seq, message: "m1" });
const settle = () => new Promise((r) => setTimeout(r, 5));

const INPUT = { device_id: "d1", instance: "atlas", bot: "default", message: "hi" };

describe("turn registry", () => {
  test("frames get n from 1, seq is left alone, and the turn ends done with nobody attached", async () => {
    const chat = manualSend();
    const ends: string[] = [];
    const reg = createTurnRegistry({
      send: chat.send,
      abort: async () => ({}),
      onEnd: (t, info) => ends.push(`${t.state}:${info.reply}`),
    });
    const t = reg.start(INPUT);
    expect(t.state).toBe("running");
    expect(chat.sent).toEqual([{ instance: "atlas", bot: "default", message: "hi" }]);
    chat.push(delta(7, "Hel"));
    chat.push(delta(7, "lo"));
    chat.push(done(9));
    chat.push(null);
    await settle();
    const after = reg.summary(t.turn_id);
    expect(after?.state).toBe("done");
    expect(after?.last_n).toBe(3);
    expect(ends).toEqual(["done:Hello"]);

    const attached = reg.attach(t.turn_id, 0, () => {});
    expect(
      attached?.replay.map((e) => (e.type === "frame" ? [e.n, e.frame.type] : ["end", e.state])),
    ).toEqual([
      [1, "delta"],
      [2, "delta"],
      [3, "done"],
      ["end", "done"],
    ]);
    const frames = attached?.replay.filter((e) => e.type === "frame") ?? [];
    expect(
      frames.map((e) => (e.type === "frame" && e.frame.type === "delta" ? e.frame.seq : -1)),
    ).toEqual([7, 7, -1]);
  });

  test("a resume replays only n > after, then goes live", async () => {
    const chat = manualSend();
    const reg = createTurnRegistry({ send: chat.send, abort: async () => ({}) });
    const t = reg.start(INPUT);
    chat.push(delta(1, "a"));
    chat.push(delta(2, "b"));
    chat.push(delta(3, "c"));
    await settle();
    const live: TurnEvent[] = [];
    const attached = reg.attach(t.turn_id, 2, (e) => live.push(e));
    expect(attached?.truncated).toBe(false);
    expect(attached?.replay.map((e) => e.n)).toEqual([3]);
    chat.push(delta(4, "d"));
    chat.push(done(5));
    chat.push(null);
    await settle();
    expect(live.map((e) => `${e.type}:${e.n}`)).toEqual(["frame:4", "frame:5", "end:5"]);
  });

  test("a detached listener hears nothing more", async () => {
    const chat = manualSend();
    const reg = createTurnRegistry({ send: chat.send, abort: async () => ({}) });
    const t = reg.start(INPUT);
    const live: TurnEvent[] = [];
    const attached = reg.attach(t.turn_id, 0, (e) => live.push(e));
    chat.push(delta(1, "a"));
    await settle();
    attached?.detach();
    chat.push(delta(2, "b"));
    chat.push(null);
    await settle();
    expect(live.map((e) => e.n)).toEqual([1]);
  });

  test("a full buffer drops the oldest and marks the turn truncated", async () => {
    const chat = manualSend();
    const reg = createTurnRegistry({ send: chat.send, abort: async () => ({}), maxFrames: 3 });
    const t = reg.start(INPUT);
    for (let i = 1; i <= 5; i++) chat.push(delta(i, String(i)));
    chat.push(done(6));
    chat.push(null);
    await settle();
    expect(reg.summary(t.turn_id)?.truncated).toBe(true);
    const fromStart = reg.attach(t.turn_id, 0, () => {});
    expect(fromStart?.truncated).toBe(true);
    expect(fromStart?.replay.map((e) => e.n)).toEqual([4, 5, 6, 6]);
    // Asking from inside what is still held is not a gap.
    expect(reg.attach(t.turn_id, 4, () => {})?.truncated).toBe(false);
  });

  test("finished turns are swept after retention; running ones are not", async () => {
    let now = 1_000_000;
    const chat = manualSend();
    const reg = createTurnRegistry({
      send: chat.send,
      abort: async () => ({}),
      clock: () => now,
      retentionMs: 1_000,
    });
    const finished = reg.start(INPUT);
    chat.push(done(1));
    chat.push(null);
    await settle();
    const chat2 = manualSend();
    const reg2 = createTurnRegistry({
      send: chat2.send,
      abort: async () => ({}),
      clock: () => now,
      retentionMs: 1,
    });
    const running = reg2.start(INPUT);
    now += 1_000;
    reg.sweep();
    expect(reg.summary(finished.turn_id)).not.toBeNull();
    now += 1;
    reg.sweep();
    reg2.sweep();
    expect(reg.summary(finished.turn_id)).toBeNull();
    expect(reg.attach(finished.turn_id, 0, () => {})).toBeNull();
    expect(reg2.summary(running.turn_id)?.state).toBe("running");
    reg2.stopAll();
  });

  test("abort asks core to stop the conversation, and the turn ends aborted", async () => {
    const chat = manualSend();
    const aborts: unknown[] = [];
    const reg = createTurnRegistry({
      send: chat.send,
      abort: async (input) => {
        aborts.push(input);
        chat.push(null);
        return {};
      },
    });
    const t = reg.start({ ...INPUT, session: "s1" });
    chat.push(delta(1, "partial"));
    await settle();
    expect(await reg.abort(t.turn_id)).toBe(true);
    await settle();
    expect(aborts).toEqual([{ instance: "atlas", bot: "default", session: "s1" }]);
    expect(reg.summary(t.turn_id)?.state).toBe("aborted");
    expect(await reg.abort(t.turn_id)).toBe(false);
    expect(await reg.abort("nope")).toBe(false);
  });

  test("a stop the box refuses still ends the read", async () => {
    const chat = manualSend();
    const reg = createTurnRegistry({
      send: chat.send,
      abort: async () => {
        throw new HermeticError("CHAT_UNREACHABLE", "box gone");
      },
    });
    const t = reg.start(INPUT);
    await reg.abort(t.turn_id);
    await settle();
    expect(chat.signal()?.aborted).toBe(true);
    expect(reg.summary(t.turn_id)?.state).toBe("aborted");
  });

  test("an error frame or a throw ends the turn error, with the reason as a frame", async () => {
    const chat = manualSend();
    const ends: string[] = [];
    const reg = createTurnRegistry({
      send: chat.send,
      abort: async () => ({}),
      onEnd: (t, info) => ends.push(`${t.state}:${info.error?.code}`),
    });
    const a = reg.start(INPUT);
    chat.push({ type: "error", code: "CHAT_TURN_FAILED", message: "nope" });
    chat.push(null);
    await settle();
    expect(reg.summary(a.turn_id)?.state).toBe("error");

    const chat2 = manualSend();
    const reg2 = createTurnRegistry({ send: chat2.send, abort: async () => ({}) });
    const b = reg2.start(INPUT);
    chat2.push(new HermeticError("CHAT_UNREACHABLE", "box gone"));
    await settle();
    const replay = reg2.attach(b.turn_id, 0, () => {})?.replay ?? [];
    expect(replay[0]?.type === "frame" && replay[0].frame).toEqual({
      type: "error",
      code: "CHAT_UNREACHABLE",
      message: "box gone",
    });
    expect(reg2.summary(b.turn_id)?.state).toBe("error");
    expect(ends).toEqual(["error:CHAT_TURN_FAILED"]);
  });

  test("a request core refuses throws from start and registers nothing", () => {
    const reg = createTurnRegistry({
      send: () => {
        throw new HermeticError("VALIDATION", "listen first");
      },
      abort: async () => ({}),
    });
    expect(() => reg.start(INPUT)).toThrow("listen first");
    expect(reg.list()).toEqual([]);
  });
});
