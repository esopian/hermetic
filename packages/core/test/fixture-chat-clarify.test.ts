/**
 * The fixture's clarify loop (`fixture-chat-requests.ts`): a trigger phrase in
 * the prompt parks the turn on one question card, `chat.respond` settles it, and
 * the same stream carries on to `done`.
 *
 * Every test opens a real fixture `Hermetic` and goes through `chat.send` and
 * `chat.respond`, because the seam being proved is the one between the turn
 * generator and `respond` across the Bot Mode wrapper, not either half alone.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHermetic } from "../src/index.ts";
import type { Hermetic } from "../src/hermetic.ts";
import { ChatBlock, type ChatFrame } from "../src/schema/index.ts";

const INSTANCE = "atlas";
const BOT = "default";

async function fixtureHermetic(): Promise<{ hermetic: Hermetic; session: string }> {
  const home = mkdtempSync(join(tmpdir(), "hermetic-fixture-clarify-"));
  const hermetic = await openHermetic({ fixture: true, home });
  await hermetic.chat.listen({ instance: INSTANCE, listening: true });
  const conversation = await hermetic.chat.open({ instance: INSTANCE, bot: BOT });
  return { hermetic, session: conversation.session };
}

const tick = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** True when `p` has not settled after a short wait: the turn is still parked. */
async function stillPending(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await tick(25);
  return !settled;
}

/**
 * A turn read up to its question card, with the next read already in flight.
 *
 * Holding that one `next()` and reusing it, rather than racing a fresh one per
 * check, keeps a single reader on the stream.
 */
async function untilQuestion(hermetic: Hermetic, message: string, signal?: AbortSignal) {
  const it = hermetic.chat
    .send({ instance: INSTANCE, bot: BOT, message }, signal ? { signal } : {})
    [Symbol.asyncIterator]();
  const frames: ChatFrame[] = [];
  for (;;) {
    const read = await it.next();
    if (read.done) throw new Error("the turn ended before asking anything");
    frames.push(read.value);
    const frame = read.value;
    if (frame.type === "block" && frame.block.kind === "question") {
      return { it, frames, question: frame.block, next: it.next() };
    }
  }
}

type Turn = Awaited<ReturnType<typeof untilQuestion>>;

async function drain(turn: Turn): Promise<ChatFrame[]> {
  let read = await turn.next;
  while (!read.done) {
    turn.frames.push(read.value);
    read = await turn.it.next();
  }
  return turn.frames;
}

/** The text the turn streamed after its last text block opened. */
function lastText(frames: readonly ChatFrame[]): string {
  const opened = frames.findLastIndex((f) => f.type === "block" && f.block.kind === "text");
  return frames
    .slice(opened + 1)
    .flatMap((f) => (f.type === "delta" ? [f.text] : []))
    .join("");
}

const questionBlocks = (frames: readonly ChatFrame[]) =>
  frames.flatMap((f) => (f.type === "block" && f.block.kind === "question" ? [f.block] : []));

describe("a batch clarify", () => {
  test("asks one card, parks, and continues on `answers`", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilQuestion(hermetic, "please E2E_BATCH_CLARIFY now");

    expect(ChatBlock.safeParse(turn.question).success).toBe(true);
    expect(turn.question.request_id).toMatch(/^srq-fixture-\d+$/);
    expect(turn.question.prompt).toBe("Pick a batch drink?");
    expect(turn.question.choices).toEqual(["Coffee (Recommended)", "Tea"]);
    expect(turn.question.questions?.map((q) => [q.id, q.multi_select, q.answer])).toEqual([
      ["q0", false, null],
      ["q1", true, null],
    ]);
    const tools = turn.frames.flatMap((f) =>
      f.type === "block" && f.block.kind === "tool" ? [f.block] : [],
    );
    expect(tools.map((t) => [t.name, t.status])).toEqual([["clarify", "running"]]);

    expect(await stillPending(turn.next)).toBe(true);

    const answered = await hermetic.chat.respond({
      instance: INSTANCE,
      bot: BOT,
      session,
      kind: "question",
      request_id: String(turn.question.request_id),
      answers: { q0: "Tea", q1: "Morning" },
    });
    expect(answered).toEqual({ status: "ok", remaining: [] });

    const frames = await drain(turn);
    expect(questionBlocks(frames)).toHaveLength(1);
    expect(frames.at(-1)?.type).toBe("done");
    expect(lastText(frames)).toBe("Got it: Tea; Morning. Continuing.");
    const done = frames.flatMap((f) =>
      f.type === "block" && f.block.kind === "tool" && f.block.status === "ok" ? [f.block] : [],
    );
    expect(done.map((t) => t.tool_id)).toEqual(["tl-fixture-clarify"]);

    // Settled once; the second answer finds nothing waiting.
    const again = await hermetic.chat.respond({
      instance: INSTANCE,
      bot: BOT,
      session,
      kind: "question",
      request_id: String(turn.question.request_id),
      skip: true,
    });
    expect(again).toEqual({ status: "expired" });
  });

  test("one `question_id` lock leaves the turn parked until the last", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilQuestion(hermetic, "E2E_BATCH_CLARIFY");
    const request_id = String(turn.question.request_id);
    const lock = (question_id: string, answer: string) =>
      hermetic.chat.respond({
        instance: INSTANCE,
        bot: BOT,
        session,
        kind: "question",
        request_id,
        question_id,
        answer,
      });

    expect(await lock("q0", "Coffee (Recommended)")).toEqual({ status: "ok", remaining: ["q1"] });
    expect(await stillPending(turn.next)).toBe(true);
    expect(await lock("q1", "Night")).toEqual({ status: "ok", remaining: [] });

    const frames = await drain(turn);
    expect(lastText(frames)).toBe("Got it: Coffee (Recommended); Night. Continuing.");
  });

  test("a partial `answers` map parks the turn, and a later lock replaces an earlier one", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilQuestion(hermetic, "E2E_BATCH_CLARIFY");
    const answer = (answers: Record<string, string>) =>
      hermetic.chat.respond({
        instance: INSTANCE,
        bot: BOT,
        session,
        kind: "question",
        request_id: String(turn.question.request_id),
        answers,
      });

    expect(await answer({ q0: "Coffee (Recommended)" })).toEqual({ status: "ok", remaining: ["q1"] });
    expect(await stillPending(turn.next)).toBe(true);
    expect(await answer({ q0: "Tea" })).toEqual({ status: "ok", remaining: ["q1"] });
    expect(await stillPending(turn.next)).toBe(true);
    expect(await answer({ q1: "Night" })).toEqual({ status: "ok", remaining: [] });
    expect(lastText(await drain(turn))).toBe("Got it: Tea; Night. Continuing.");

    // The batch resolved; a lock after that finds nothing waiting.
    expect(await answer({ q1: "Morning" })).toEqual({ status: "expired" });
  });

  test("an unknown question, an empty map, or an unnamed `answer` is refused", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilQuestion(hermetic, "E2E_BATCH_CLARIFY");
    const target = {
      instance: INSTANCE,
      bot: BOT,
      session,
      kind: "question" as const,
      request_id: String(turn.question.request_id),
    };
    for (const input of [
      { ...target, answers: { q0: "Tea", q9: "?" } },
      { ...target, answers: {} },
      { ...target, answer: "Tea" },
    ]) {
      const failed = await hermetic.chat.respond(input).catch((e: unknown) => e);
      expect(failed).toMatchObject({ code: "VALIDATION" });
      expect(String((failed as Error).message)).toContain("exact pending question");
    }
    // Nothing was locked by the refusals: one full answer still resolves it.
    expect(await stillPending(turn.next)).toBe(true);
    expect(await hermetic.chat.respond({ ...target, answers: { q0: "Tea", q1: "Night" } })).toEqual({
      status: "ok",
      remaining: [],
    });
    expect(lastText(await drain(turn))).toBe("Got it: Tea; Night. Continuing.");
  });
});

describe("a blocking clarify", () => {
  test("is a single question, and `answer` alone continues it", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilQuestion(hermetic, "E2E_BLOCKING_CLARIFY");
    expect(turn.question.prompt).toBe("Keep this test turn running?");
    expect(turn.question.choices).toEqual(["Yes", "No"]);
    expect(turn.question.questions).toBeUndefined();

    const answered = await hermetic.chat.respond({
      instance: INSTANCE,
      bot: BOT,
      session,
      kind: "question",
      request_id: String(turn.question.request_id),
      answer: "Yes",
    });
    // A single question resolves through `request.answer`, which reports no `remaining`.
    expect(answered).toEqual({ status: "ok" });
    expect(lastText(await drain(turn))).toBe("Got it: Yes. Continuing.");
  });

  test("`skip` continues it with nothing answered", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilQuestion(hermetic, "E2E_BLOCKING_CLARIFY");
    await hermetic.chat.respond({
      instance: INSTANCE,
      bot: BOT,
      session,
      kind: "question",
      request_id: String(turn.question.request_id),
      skip: true,
    });
    const frames = await drain(turn);
    expect(frames.at(-1)?.type).toBe("done");
    expect(lastText(frames)).toBe("Skipped. Continuing.");
  });
});

describe("requests nobody is waiting on", () => {
  test("an unknown request is expired", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const answered = await hermetic.chat.respond({
      instance: INSTANCE,
      bot: BOT,
      session,
      kind: "question",
      request_id: "srq-fixture-999",
      answer: "Yes",
    });
    expect(answered).toEqual({ status: "expired" });
  });

  test("an abort while parked ends the stream, and the request with it", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const controller = new AbortController();
    const turn = await untilQuestion(hermetic, "E2E_BATCH_CLARIFY", controller.signal);
    controller.abort();
    const frames = await drain(turn);
    expect(frames.some((f) => f.type === "done")).toBe(false);
    expect(questionBlocks(frames)).toHaveLength(1);

    const late = await hermetic.chat.respond({
      instance: INSTANCE,
      bot: BOT,
      session,
      kind: "question",
      request_id: String(turn.question.request_id),
      skip: true,
    });
    expect(late).toEqual({ status: "expired" });
  });

  test("any other prompt still gets the ordinary turn", async () => {
    const { hermetic } = await fixtureHermetic();
    const frames: ChatFrame[] = [];
    for await (const frame of hermetic.chat.send({ instance: INSTANCE, bot: BOT, message: "hi" }))
      frames.push(frame);
    expect(questionBlocks(frames)).toHaveLength(0);
    expect(frames.at(-1)?.type).toBe("done");
  });
});
