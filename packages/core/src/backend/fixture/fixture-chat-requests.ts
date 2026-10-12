/**
 * The fixture's open clarify requests, and the turn script that raises them.
 *
 * A real box parks a turn on a `clarify` tool call until the operator answers
 * through `chat.respond`, and then the same turn carries on. The fixture's turn
 * (`fixture-chat.ts`) and its `respond` (`fixture-bot-mode.ts`, delegating to
 * the client) live in different modules, so the request a turn is parked on
 * needs a home both can reach: this registry, one per fixture chat client. The
 * turn opens a request and awaits it; `respond` settles it.
 *
 * The triggers are upstream's own (`tests-js/scripts/mock-server.ts` at Hermes
 * `v2026.9.24`): a prompt containing `E2E_BATCH_CLARIFY` asks a two-question
 * batch, one containing `E2E_BLOCKING_CLARIFY` asks a single question, and every
 * other prompt gets the ordinary canned turn. Matching by substring means
 * upstream's longer `E2E_BATCH_CLARIFY_TRIGGER` spelling works too.
 *
 * Nothing here reads a clock or arms a timer: a parked turn waits on a promise
 * that only `respond` or the turn's own `AbortSignal` settles, so a request
 * never expires on its own and a test never races one.
 */
import type { ChatRespondInput } from "../../schema/requests.ts";
import type { ChatBlock, ChatFrame } from "../../schema/index.ts";
import { HermeticError } from "../../errors.ts";

export const FIXTURE_BATCH_CLARIFY_TRIGGER = "E2E_BATCH_CLARIFY";
export const FIXTURE_BLOCKING_CLARIFY_TRIGGER = "E2E_BLOCKING_CLARIFY";

/** One question as the registry keeps it; `id` is what an answer is locked under. */
interface FixtureQuestion {
  id: string;
  prompt: string;
  choices: string[];
  multi_select: boolean;
}

/** How a parked turn was released. */
export type FixtureClarifyOutcome =
  | { kind: "answered"; answers: Record<string, string> }
  | { kind: "skipped" }
  | { kind: "aborted" };

export interface FixtureClarifyRequest {
  request_id: string;
  /** Settles exactly once: on the last answer, a skip, an abort or `close`. */
  settled: Promise<FixtureClarifyOutcome>;
  /** Forget the request, settling it `aborted` if nothing else had. Idempotent. */
  close(): void;
}

export interface FixtureChatRequests {
  open(questions: readonly FixtureQuestion[], signal?: AbortSignal): FixtureClarifyRequest;
  respond(input: ChatRespondInput): { status: "ok" | "expired"; remaining?: string[] };
}

export function createFixtureChatRequests(): FixtureChatRequests {
  /** Counted rather than random, so two runs of the same fixture mint the same ids. */
  let serial = 0;
  const open = new Map<
    string,
    {
      questions: readonly FixtureQuestion[];
      locked: Record<string, string>;
      settle: (outcome: FixtureClarifyOutcome) => void;
    }
  >();

  return {
    open(questions, signal) {
      const request_id = `srq-fixture-${++serial}`;
      let resolve!: (outcome: FixtureClarifyOutcome) => void;
      const settled = new Promise<FixtureClarifyOutcome>((done) => {
        resolve = done;
      });
      const onAbort = (): void => settle({ kind: "aborted" });
      // Removing the entry and the listener is part of settling, so a request
      // can be answered at most once and an aborted turn leaves nothing behind.
      const settle = (outcome: FixtureClarifyOutcome): void => {
        if (!open.delete(request_id)) return;
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      open.set(request_id, { questions, locked: {}, settle });
      if (signal?.aborted) settle({ kind: "aborted" });
      else signal?.addEventListener("abort", onAbort, { once: true });
      return { request_id, settled, close: () => settle({ kind: "aborted" }) };
    },

    respond(input) {
      const entry = open.get(input.request_id);
      // Unknown and already-settled read the same, as they do on a real box:
      // the request is no longer one the gateway is waiting on, so a lock
      // after the batch completed is expired too.
      if (!entry) return { status: "expired" };
      if (input.skip) {
        entry.settle({ kind: "skipped" });
        return { status: "ok" };
      }
      // The fixture raises a two-question batch or a single question, never a
      // one-question batch, so the count tells the two apart.
      const batch = entry.questions.length > 1;
      if (!batch) {
        if (input.answers !== undefined || input.question_id !== undefined)
          throw new HermeticError("VALIDATION", "This request asks a single question");
        entry.settle({
          kind: "answered",
          answers: { [entry.questions[0]?.id ?? ""]: input.answer ?? "" },
        });
        return { status: "ok" };
      }
      // A batch is answered per question, as core checks before locking on a
      // real box: an answer must name a pending question, and an empty map
      // names none.
      const answers =
        input.answers ??
        (input.question_id !== undefined && input.answer !== undefined
          ? { [input.question_id]: input.answer }
          : {});
      const ids = entry.questions.map((q) => q.id);
      const given = Object.keys(answers);
      if (!given.length || given.some((id) => !ids.includes(id)))
        throw new HermeticError("VALIDATION", "Choose the exact pending question");
      // Upstream's `lock_answer`: a lock overwrites any earlier lock of that
      // question, and the lock that leaves none open resolves the batch with
      // every answer locked so far.
      Object.assign(entry.locked, answers);
      const remaining = ids.filter((id) => !(id in entry.locked));
      if (remaining.length === 0) entry.settle({ kind: "answered", answers: { ...entry.locked } });
      return { status: "ok", remaining };
    },
  };
}

/* ── the scripted clarify turn ────────────────────────────────────────────── */

type SequencedFrame = Extract<ChatFrame, { seq: number }>;

/** Never empty: the first question is the one mirrored into `prompt`/`choices`. */
type FixtureQuestions = readonly [FixtureQuestion, ...FixtureQuestion[]];

const BATCH: FixtureQuestions = [
  {
    id: "q0",
    prompt: "Pick a batch drink?",
    choices: ["Coffee (Recommended)", "Tea"],
    multi_select: false,
  },
  { id: "q1", prompt: "Pick a batch time?", choices: ["Morning", "Night"], multi_select: true },
];

const BLOCKING: FixtureQuestions = [
  { id: "q0", prompt: "Keep this test turn running?", choices: ["Yes", "No"], multi_select: false },
];

export interface FixtureClarifyScript {
  questions: FixtureQuestions;
  /** Reasoning, the running `clarify` tool and the question card, seq from 1. */
  ask(message: string, request_id: string): SequencedFrame[];
  /** The tool completing, the continuation text and `done`, seq after `from`. */
  resume(message: string, outcome: FixtureClarifyOutcome, from: number): SequencedFrame[];
}

/** The clarify script a prompt triggers, or null for the ordinary canned turn. */
export function fixtureClarifyScript(prompt: string): FixtureClarifyScript | null {
  const batch = prompt.includes(FIXTURE_BATCH_CLARIFY_TRIGGER);
  if (!batch && !prompt.includes(FIXTURE_BLOCKING_CLARIFY_TRIGGER)) return null;
  const questions = batch ? BATCH : BLOCKING;
  const tool_id = "tl-fixture-clarify";
  // Upstream's tool arguments: a batch sends `questions`, a single `question`.
  const args = batch
    ? {
        questions: questions.map((q) => ({
          question: q.prompt,
          choices: q.choices,
          multi_select: q.multi_select,
        })),
      }
    : { question: questions[0].prompt, choices: questions[0].choices };
  const tool = (status: "running" | "ok", result: string | null): ChatBlock => ({
    kind: "tool",
    tool_id,
    name: "clarify",
    server: null,
    args,
    result,
    status,
    exit_code: null,
    duration_ms: status === "ok" ? 0 : null,
    render: null,
  });

  return {
    questions,
    ask(message, request_id) {
      const first = questions[0];
      const question: ChatBlock = {
        kind: "question",
        prompt: first.prompt,
        choices: first.choices,
        ...(batch
          ? {
              multi_select: first.multi_select,
              questions: questions.map((q) => ({ ...q, answer: null })),
            }
          : {}),
        request_id,
        expires_at: null,
        payload: { request_id, ...args },
      };
      const blocks: ChatBlock[] = [
        {
          kind: "reasoning",
          text: "The operator should decide this one. Ask before going any further.",
          duration_ms: 840,
          tokens: 18,
        },
        tool("running", null),
        question,
      ];
      return blocks.map((block, i) => ({ type: "block", seq: i + 1, message, block }));
    },
    resume(message, outcome, from) {
      let seq = from;
      const answered = outcome.kind === "answered" ? outcome.answers : {};
      const said = questions.flatMap((q) => (q.id in answered ? [answered[q.id] ?? ""] : []));
      const summary =
        outcome.kind === "answered"
          ? questions.map((q) => `${q.prompt} ${answered[q.id] ?? "(no answer)"}`).join("\n")
          : "Skipped";
      const reply =
        outcome.kind === "answered"
          ? `Got it: ${said.join("; ")}. Continuing.`
          : "Skipped. Continuing.";
      const frames: SequencedFrame[] = [
        { type: "block", seq: ++seq, message, block: tool("ok", summary) },
        { type: "block", seq: ++seq, message, block: { kind: "text", markdown: "" } },
      ];
      // Two deltas rather than one, so the continuation streams like any other text.
      const cut = Math.ceil(reply.length / 2);
      for (const text of [reply.slice(0, cut), reply.slice(cut)])
        frames.push({ type: "delta", seq: ++seq, message, text });
      frames.push({ type: "done", seq: ++seq, message, usage: null, incomplete: null });
      return frames;
    },
  };
}
