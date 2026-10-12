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
import { CLARIFY_TIMEOUT_RESPONSE } from "../src/chat/hermes/hermes-chat-history.ts";
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

/** The completed `clarify` tool's result, parsed: upstream's JSON shape. */
function clarifyResult(frames: readonly ChatFrame[]): unknown {
  const done = frames.flatMap((f) =>
    f.type === "block" && f.block.kind === "tool" && f.block.status === "ok" ? [f.block] : [],
  );
  expect(done).toHaveLength(1);
  return JSON.parse(String(done[0]?.result));
}

/** What a re-read of the conversation holds: the stored turn's blocks. */
async function reread(hermetic: Hermetic) {
  const read = await hermetic.chat.history({ instance: INSTANCE, bot: BOT });
  const reply = read.messages.findLast((m) => m.blocks.some((b) => b.kind === "tool"));
  return reply?.blocks ?? [];
}

const settledQuestion = (blocks: readonly ChatBlock[]) =>
  blocks.flatMap((b) => (b.kind === "question" ? [b] : []));

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

    expect(await lock("q0", "Coffee")).toEqual({ status: "ok", remaining: ["q1"] });
    expect(await stillPending(turn.next)).toBe(true);
    expect(await lock("q1", "Night")).toEqual({ status: "ok", remaining: [] });

    const frames = await drain(turn);
    expect(lastText(frames)).toBe("Got it: Coffee; Night. Continuing.");
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

    expect(await answer({ q0: "Coffee" })).toEqual({ status: "ok", remaining: ["q1"] });
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

describe("the clarify result and the stored turn", () => {
  test("a batch's tool result is upstream's `{responses}` JSON, bare labels and a list for multi-select", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilQuestion(hermetic, "E2E_BATCH_CLARIFY");
    await hermetic.chat.respond({
      instance: INSTANCE,
      bot: BOT,
      session,
      kind: "question",
      request_id: String(turn.question.request_id),
      // What the UI sends for a multi-select: a JSON array string.
      answers: { q0: "Coffee (Recommended)", q1: JSON.stringify(["Morning", "Night"]) },
    });
    const frames = await drain(turn);
    expect(clarifyResult(frames)).toEqual({
      responses: [
        {
          question: "Pick a batch drink?",
          choices_offered: ["Coffee", "Tea"],
          user_response: "Coffee",
        },
        {
          question: "Pick a batch time?",
          choices_offered: ["Morning", "Night"],
          user_response: ["Morning", "Night"],
        },
      ],
    });
    // The echo reads a JSON-array answer as a sentence, not as raw JSON.
    expect(lastText(frames)).toBe("Got it: Coffee; Morning and Night. Continuing.");
  });

  test("a re-read shows the settled summary: the parked question is gone, request_id is null", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilQuestion(hermetic, "E2E_BATCH_CLARIFY");
    await hermetic.chat.respond({
      instance: INSTANCE,
      bot: BOT,
      session,
      kind: "question",
      request_id: String(turn.question.request_id),
      answers: { q0: "Tea", q1: JSON.stringify(["Morning", "Night"]) },
    });
    await drain(turn);

    const stored = settledQuestion(await reread(hermetic));
    // One question block, not the live one and a settled one beside it.
    expect(stored).toHaveLength(1);
    expect(stored[0]?.request_id).toBeNull();
    expect(stored[0]?.questions?.map((q) => [q.id, q.prompt, q.answer])).toEqual([
      ["q0", "Pick a batch drink?", "Tea"],
      ["q1", "Pick a batch time?", JSON.stringify(["Morning", "Night"])],
    ]);
    // Bare labels: what the tool offered, not the presentation label.
    expect(stored[0]?.questions?.[0]?.choices).toEqual(["Coffee", "Tea"]);
  });

  test("a skipped question re-reads as an empty answer", async () => {
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
    expect(clarifyResult(frames)).toEqual({
      question: "Keep this test turn running?",
      choices_offered: ["Yes", "No"],
      user_response: "",
    });
    const stored = settledQuestion(await reread(hermetic));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.request_id).toBeNull();
    expect(stored[0]?.questions?.map((q) => q.answer)).toEqual([""]);
  });

  test("a single question's result is `{question, choices_offered, user_response}`", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilQuestion(hermetic, "E2E_BLOCKING_CLARIFY");
    await hermetic.chat.respond({
      instance: INSTANCE,
      bot: BOT,
      session,
      kind: "question",
      request_id: String(turn.question.request_id),
      answer: "No",
    });
    expect(clarifyResult(await drain(turn))).toEqual({
      question: "Keep this test turn running?",
      choices_offered: ["Yes", "No"],
      user_response: "No",
    });
  });
});

describe("a clarify's shape is `questions[]` or not, whatever its length", () => {
  test("a one-question batch accepts `answers` and settles on it", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilQuestion(hermetic, "E2E_ONE_BATCH_CLARIFY");
    expect(turn.question.questions).toHaveLength(1);
    const target = {
      instance: INSTANCE,
      bot: BOT,
      session,
      kind: "question" as const,
      request_id: String(turn.question.request_id),
    };
    // A batch has no bare `answer`: it names no question, as the gateway reads it.
    const bare = await hermetic.chat.respond({ ...target, answer: "Tea" }).catch((e: unknown) => e);
    expect(bare).toMatchObject({ code: "VALIDATION" });

    expect(await hermetic.chat.respond({ ...target, answers: { q0: "Tea" } })).toEqual({
      status: "ok",
      remaining: [],
    });
    const frames = await drain(turn);
    expect(clarifyResult(frames)).toEqual({
      responses: [
        { question: "Pick the only drink?", choices_offered: ["Coffee", "Tea"], user_response: "Tea" },
      ],
    });
    expect(lastText(frames)).toBe("Got it: Tea. Continuing.");
  });

  test("a single question still refuses `answers`", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilQuestion(hermetic, "E2E_BLOCKING_CLARIFY");
    const failed = await hermetic.chat
      .respond({
        instance: INSTANCE,
        bot: BOT,
        session,
        kind: "question",
        request_id: String(turn.question.request_id),
        answers: { q0: "Yes" },
      })
      .catch((e: unknown) => e);
    expect(failed).toMatchObject({ code: "VALIDATION" });
  });
});

describe("a clarify nobody answers", () => {
  test("closes with reason `timeout`, and the turn carries on with a note of it", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilQuestion(hermetic, "E2E_CLARIFY_TIMEOUT");
    expect(turn.question.questions).toBeUndefined();
    expect(turn.question.choices).toEqual(["Proceed (Recommended)", "Hold"]);

    // Parked until the request's own wait runs out, not forever.
    expect(await stillPending(turn.next)).toBe(true);
    const frames = await drain(turn);

    const closed = frames.flatMap((f) =>
      f.type === "block" && f.block.kind === "activity" && f.block.reason ? [f.block] : [],
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      reason: "timeout",
      request_id: turn.question.request_id,
      detail: "Timed out",
    });
    expect(frames.at(-1)?.type).toBe("done");
    expect(lastText(frames)).toContain("No answer came in time");
    // A single question stores upstream's sentinel; only a batch says `timed_out`.
    const result = clarifyResult(frames);
    expect(result).toMatchObject({ user_response: CLARIFY_TIMEOUT_RESPONSE });
    expect(result).not.toHaveProperty("timed_out");

    // Nothing is waiting any more.
    const late = await hermetic.chat.respond({
      instance: INSTANCE,
      bot: BOT,
      session,
      kind: "question",
      request_id: String(turn.question.request_id),
      answer: "Proceed",
    });
    expect(late).toEqual({ status: "expired" });
    // The stored turn keeps the settled summary and not the notice.
    const blocks = await reread(hermetic);
    expect(blocks.some((b) => b.kind === "activity")).toBe(false);
    expect(settledQuestion(blocks)[0]?.questions?.map((q) => q.answer)).toEqual([""]);
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
