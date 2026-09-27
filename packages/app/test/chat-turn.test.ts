/**
 * `chat.send` / `chat.turn` — the live turn, as the head runs it.
 *
 * A turn is the one request that pushes frames for as long as the agent keeps
 * talking, so it is the one request whose *ending* is interesting: the caller
 * closes the stream, and the send on the box has to stop with it rather than
 * go on talking into a sink nobody reads.
 *
 * These cases were written against `POST /api/chat/:instance/:bot/messages`,
 * where "the caller went away" was a cancelled response body. Over the bridge
 * it is `chat.turn.abort` (and the window's `closeAll`), which is the same
 * event with a name — so what they assert is unchanged and how they say it is
 * not.
 *
 * Core is a double: what is being asserted is the head's plumbing of the
 * caller's abort, which is exactly what a double can say.
 */
import { expect, test } from "bun:test";
import type { ChatFrame, Hermetic } from "@hermetic/core";
import { createChatOwner } from "../src/chat-owner.ts";
import type { HandlerContext } from "../src/handlers/ctx.ts";
import { dispatch } from "../src/handlers/dispatch.ts";
import { createStreamRegistry, type StreamFrame } from "../src/handlers/streams.ts";
import { memoryLog } from "../src/log.ts";
import { OpRegistry } from "../src/ops.ts";
import { AppState, fixedInstance } from "../src/state.ts";

const FLEET_TARGET = {
  account_id: "123456789012",
  region: "us-west-2",
  fleet_id: "fxtr0001",
} as const;

interface Turn {
  /** The input core was handed, so the test can read the message off it. */
  input: { message: string } | null;
  /** Resolves once the generator's `finally` has run — the call is let go. */
  closed: Promise<void>;
  /** True once the signal core was given reports an abort. */
  aborted: () => boolean;
}

function double(): { hermetic: Hermetic; turn: Turn } {
  let release = (): void => {};
  const turn: Turn = {
    input: null,
    closed: new Promise<void>((resolve) => {
      release = resolve;
    }),
    aborted: () => false,
  };
  const send = async function* (
    input: { message: string },
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<ChatFrame> {
    turn.input = input;
    turn.aborted = () => opts?.signal?.aborted === true;
    try {
      yield { type: "delta", seq: 1, message: "m1", text: "thinking" };
      // Park until the caller's abort says the reader is gone. A turn that
      // ends on its own would prove nothing about the disconnect.
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted === true) {
          resolve();
          return;
        }
        opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done", seq: 2, message: "m1" };
    } finally {
      release();
    }
  };
  return { hermetic: { chat: { send }, target: FLEET_TARGET } as unknown as Hermetic, turn };
}

/** A context over one doubled instance, and the frames anything it opens pushed. */
function harness(hermetic: Hermetic) {
  const log = memoryLog();
  const state = new AppState({
    fixture: true,
    home: ":memory:",
    reopen: fixedInstance(hermetic),
    hermetic,
    target: { ...FLEET_TARGET },
    poller: null,
  });
  const frames: StreamFrame[] = [];
  const ctx: HandlerContext = {
    state,
    hermetic: () => state.hermetic,
    ops: new OpRegistry(),
    poller: () => null,
    chatOwner: createChatOwner({ hermetic: () => state.hermetic }),
    fixture: true,
    opts: { fixture: true, log },
    log,
    streams: createStreamRegistry(),
  };
  const sink = (frame: StreamFrame): void => void frames.push(frame);
  return { ctx, frames, log, sink };
}

/** Waits for a frame the predicate accepts, or gives up rather than hanging. */
async function until(frames: StreamFrame[], want: (f: StreamFrame) => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (frames.some(want)) return;
    await Bun.sleep(5);
  }
  throw new Error("the frame never arrived");
}

test("the whole message reaches core and the turn pushes frames as they come", async () => {
  const { hermetic, turn } = double();
  const { ctx, frames, sink } = harness(hermetic);
  // Far past the 6,000 characters the composer used to refuse, and past
  // anything a URL could have carried: the message is a value on the request.
  const message = "x".repeat(20_000);
  const { stream_id } = (await dispatch(
    ctx,
    "chat.send",
    { instance: "atlas", bot: "default", message, target: FLEET_TARGET },
    sink,
  )) as { stream_id: string };

  await until(frames, (f) => f.event === "delta");
  expect(turn.input?.message).toBe(message);

  await dispatch(ctx, "chat.turn.abort", { stream_id });
  await turn.closed;
});

test("a caller that goes away mid-turn aborts the send on the box", async () => {
  const { hermetic, turn } = double();
  const { ctx, frames, sink } = harness(hermetic);
  const { stream_id } = (await dispatch(
    ctx,
    "chat.send",
    { instance: "atlas", bot: "default", message: "hello", target: FLEET_TARGET },
    sink,
  )) as { stream_id: string };
  await until(frames, (f) => f.event === "delta");
  expect(turn.aborted()).toBe(false);

  // The disconnect. Nothing else ends this turn, so a generator still parked
  // after this would hang the test rather than pass it.
  expect(await dispatch(ctx, "chat.turn.abort", { stream_id })).toEqual({ closed: true });
  await turn.closed;
  expect(turn.aborted()).toBe(true);
});

/**
 * A turn that finished is not a failed request.
 *
 * The browser's SSE reader used to cancel the response the instant it parsed
 * `done`, which aborted the fetch — so a perfectly ordinary turn ended as a
 * client disconnect and left a warning behind. A caller closing a turn it has
 * already seen `done` on is still what a closed tab looks like, and it must
 * leave nothing in the terminal: the answer was already written, there is
 * nothing anyone can act on, and a warn per turn is how `app.log` becomes
 * unreadable.
 */
test("a turn that ran out forgets itself and leaves no warning in the log", async () => {
  const send = async function* (): AsyncGenerator<ChatFrame> {
    yield { type: "delta", seq: 1, message: "m1", text: "thinking" };
    yield { type: "done", seq: 2, message: "m1" };
  };
  const hermetic = { chat: { send }, target: FLEET_TARGET } as unknown as Hermetic;
  const { ctx, frames, log, sink } = harness(hermetic);
  const { stream_id } = (await dispatch(
    ctx,
    "chat.send",
    { instance: "atlas", bot: "default", message: "hello", target: FLEET_TARGET },
    sink,
  )) as { stream_id: string };

  await until(frames, (f) => f.event === "done");
  // The source is exhausted, so the stream closes itself rather than waiting
  // to be told: a late close from the caller is a no-op, not a failure.
  for (let i = 0; i < 200 && ctx.streams.has(stream_id); i += 1) await Bun.sleep(5);
  expect(await dispatch(ctx, "chat.turn.abort", { stream_id })).toEqual({ closed: false });
  expect(log.lines.filter((line) => /\s(WARN|ERROR)\s/.test(line))).toEqual([]);
});
