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
 * upstream's longer `E2E_BATCH_CLARIFY_TRIGGER` spelling works too. Two more are
 * the fixture's own: `E2E_ONE_BATCH_CLARIFY` (a batch of one) and
 * `E2E_CLARIFY_TIMEOUT` (a single question that times out).
 *
 * A parked turn waits on a promise that `respond`, the turn's own `AbortSignal`
 * or, for a request opened with a `timeoutMs`, a timer settles. Only the
 * `*_TIMEOUT` triggers arm a timer: every other request never expires on its
 * own, so a test never races one. Approvals (`fixture-chat-approval.ts`) park on
 * the same registry.
 */
import type { ChatRespondInput } from "../../schema/requests.ts";
import type { ApprovalChoice, ChatBlock, ChatFrame } from "../../schema/index.ts";
import { HermeticError } from "../../errors.ts";
import { hermesActivity } from "../../chat/hermes/hermes-chat-activity.ts";
import { CLARIFY_TIMEOUT_RESPONSE } from "../../chat/hermes/hermes-chat-history.ts";

export const FIXTURE_BATCH_CLARIFY_TRIGGER = "E2E_BATCH_CLARIFY";
export const FIXTURE_BLOCKING_CLARIFY_TRIGGER = "E2E_BLOCKING_CLARIFY";
/** A batch of exactly one question: `questions[]` on the wire, so `answers` is the only way to answer. */
export const FIXTURE_ONE_QUESTION_BATCH_TRIGGER = "E2E_ONE_BATCH_CLARIFY";
/** A single question that nobody answers: the request closes with reason `timeout`. */
export const FIXTURE_CLARIFY_TIMEOUT_TRIGGER = "E2E_CLARIFY_TIMEOUT";

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
  | { kind: "timeout" }
  | { kind: "aborted" };

/**
 * How a parked approval was released. The gateway does not check the choice
 * against the offered list (D27), so `choice` is whatever the operator sent.
 */
export type FixtureApprovalOutcome =
  | { kind: "choice"; choice: ApprovalChoice }
  | { kind: "timeout" }
  | { kind: "aborted" };

interface FixtureParked<Outcome> {
  request_id: string;
  /** Settles exactly once: on an answer, a timeout, an abort or `close`. */
  settled: Promise<Outcome>;
  /** Forget the request, settling it `aborted` if nothing else had. Idempotent. */
  close(): void;
}
export type FixtureClarifyRequest = FixtureParked<FixtureClarifyOutcome>;
export type FixtureApprovalRequest = FixtureParked<FixtureApprovalOutcome>;

/** What decides how a clarify request answers, and when it gives up. */
export interface FixtureClarifyShape {
  /**
   * Whether the gateway asked a batch (`questions[]` on the wire). Decided by
   * shape, never by count: a one-question batch is still a batch, answered by
   * `answers`, and the gateway rejects the single-question fields on it.
   */
  batch: boolean;
  /** Settle `timeout` after this long, as the gateway's clarify wait does. */
  timeoutMs?: number | undefined;
}

export interface FixtureChatRequests {
  open(
    questions: readonly FixtureQuestion[],
    signal: AbortSignal | undefined,
    shape: FixtureClarifyShape,
  ): FixtureClarifyRequest;
  openApproval(signal?: AbortSignal, timeoutMs?: number): FixtureApprovalRequest;
  respond(input: ChatRespondInput): { status: "ok" | "expired"; remaining?: string[] };
}

export function createFixtureChatRequests(): FixtureChatRequests {
  /** Counted rather than random, so two runs of the same fixture mint the same ids. */
  let serial = 0;
  const open = new Map<
    string,
    | {
        kind: "question";
        questions: readonly FixtureQuestion[];
        batch: boolean;
        locked: Record<string, string>;
        settle: (outcome: FixtureClarifyOutcome) => void;
      }
    | { kind: "approval"; settle: (outcome: FixtureApprovalOutcome) => void }
  >();

  /**
   * One parked request. Removing the entry, the listener and the timer is part
   * of settling, so a request can be answered at most once and an aborted or
   * timed-out turn leaves nothing behind.
   */
  function park<Outcome extends { kind: string }>(
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    timedOut: Outcome,
    aborted: Outcome,
    register: (request_id: string, settle: (outcome: Outcome) => void) => void,
  ): FixtureParked<Outcome> {
    const request_id = `srq-fixture-${++serial}`;
    let resolve!: (outcome: Outcome) => void;
    const settled = new Promise<Outcome>((done) => {
      resolve = done;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => settle(aborted);
    const settle = (outcome: Outcome): void => {
      if (!open.delete(request_id)) return;
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve(outcome);
    };
    register(request_id, settle);
    if (signal?.aborted) settle(aborted);
    else {
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => settle(timedOut), timeoutMs);
    }
    return { request_id, settled, close: () => settle(aborted) };
  }

  return {
    open(questions, signal, shape) {
      return park<FixtureClarifyOutcome>(
        signal,
        shape.timeoutMs,
        { kind: "timeout" },
        { kind: "aborted" },
        (request_id, settle) =>
          open.set(request_id, {
            kind: "question",
            questions,
            batch: shape.batch,
            locked: {},
            settle,
          }),
      );
    },

    openApproval(signal, timeoutMs) {
      return park<FixtureApprovalOutcome>(
        signal,
        timeoutMs,
        { kind: "timeout" },
        { kind: "aborted" },
        (request_id, settle) => open.set(request_id, { kind: "approval", settle }),
      );
    },

    respond(input) {
      const entry = open.get(input.request_id);
      // Unknown and already-settled read the same, as they do on a real box:
      // the request is no longer one the gateway is waiting on, so a lock
      // after the batch completed is expired too.
      if (!entry) return { status: "expired" };
      if (entry.kind === "approval") {
        if (input.kind !== "approval")
          throw new HermeticError("VALIDATION", "This request is an approval");
        // `approval.respond` does not check the choice against the offered list
        // (`methods_prompt.py:1239-1253`): anything but `deny` is a grant.
        entry.settle({ kind: "choice", choice: input.choice ?? "deny" });
        return { status: "ok" };
      }
      if (input.kind !== "question")
        throw new HermeticError("VALIDATION", "This request is a question");
      if (input.skip) {
        entry.settle({ kind: "skipped" });
        return { status: "ok" };
      }
      if (!entry.batch) {
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

/** The wire choices carry upstream's " (Recommended)" label; what the agent gets back does not. */
const RECOMMENDED = / \(Recommended\)$/i;
const bare = (text: string): string => text.replace(RECOMMENDED, "").trim();

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

/** A batch of one: still `questions[]` on the wire, still answered by `answers`. */
const ONE_QUESTION_BATCH: FixtureQuestions = [
  {
    id: "q0",
    prompt: "Pick the only drink?",
    choices: ["Coffee (Recommended)", "Tea"],
    multi_select: false,
  },
];

const TIMEOUT: FixtureQuestions = [
  {
    id: "q0",
    prompt: "Proceed with the default plan?",
    choices: ["Proceed (Recommended)", "Hold"],
    multi_select: false,
  },
];

export interface FixtureClarifyScript {
  questions: FixtureQuestions;
  /** `questions[]` on the wire (the gateway decides by shape, not by count). */
  batch: boolean;
  /** The request gives up on its own (`reason: "timeout"`) if nobody answers. */
  timeout: boolean;
  /** Reasoning, the running `clarify` tool and the question card, seq from 1. */
  ask(message: string, request_id: string): SequencedFrame[];
  /** The tool completing, the continuation text and `done`, seq after `from`. */
  resume(
    message: string,
    outcome: FixtureClarifyOutcome,
    from: number,
    request_id: string,
  ): SequencedFrame[];
}

/** "A", "A and B", "A, B and C". */
const naturalList = (items: readonly string[]): string =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * A multi-select answer is a JSON array string on the wire (or, from a plain
 * client, a comma list); upstream's `_parse_multi_select_response`.
 */
function selections(raw: string): string[] {
  let items: unknown = null;
  if (raw.trim().startsWith("[")) {
    try {
      items = JSON.parse(raw);
    } catch {
      items = null;
    }
  }
  const list = Array.isArray(items) ? items.map(String) : raw.split(",");
  return list.map((item) => bare(item)).filter(Boolean);
}

/** The clarify script a prompt triggers, or null for the ordinary canned turn. */
export function fixtureClarifyScript(prompt: string): FixtureClarifyScript | null {
  const timeout = prompt.includes(FIXTURE_CLARIFY_TIMEOUT_TRIGGER);
  const oneBatch = prompt.includes(FIXTURE_ONE_QUESTION_BATCH_TRIGGER);
  const batch = prompt.includes(FIXTURE_BATCH_CLARIFY_TRIGGER);
  if (!batch && !oneBatch && !timeout && !prompt.includes(FIXTURE_BLOCKING_CLARIFY_TRIGGER))
    return null;
  const questions = timeout ? TIMEOUT : oneBatch ? ONE_QUESTION_BATCH : batch ? BATCH : BLOCKING;
  const asksBatch = batch || oneBatch;
  const tool_id = "tl-fixture-clarify";
  // Upstream's tool arguments, as the model wrote them: a batch sends
  // `questions`, a single question `question`, and the choices are bare (the
  // label is presentation the UI adds).
  const args = asksBatch
    ? {
        questions: questions.map((q) => ({
          question: q.prompt,
          choices: q.choices.map(bare),
          multi_select: q.multi_select,
        })),
      }
    : { question: questions[0].prompt, choices: questions[0].choices.map(bare) };
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

  /**
   * The tool's JSON result, in `tools/clarify_tool.py`'s own shapes: a single
   * question is `{question, choices_offered, user_response}`, a batch
   * `{responses: [...], timed_out?}` with a blank for every unanswered one. A
   * multi-select answer is a list; the label is stripped.
   */
  const result = (answers: Record<string, string>, timedOut: boolean): string => {
    const response = (q: FixtureQuestion) => {
      const raw = answers[q.id];
      return {
        question: q.prompt,
        choices_offered: q.choices.length ? q.choices.map(bare) : null,
        user_response: !raw
          ? timedOut && !asksBatch
            ? CLARIFY_TIMEOUT_RESPONSE
            : ""
          : q.multi_select
            ? selections(raw)
            : bare(raw),
      };
    };
    if (!asksBatch) return JSON.stringify(response(questions[0]));
    return JSON.stringify({
      responses: questions.map(response),
      ...(timedOut ? { timed_out: true } : {}),
    });
  };

  return {
    questions,
    batch: asksBatch,
    timeout,
    ask(message, request_id) {
      const first = questions[0];
      const question: ChatBlock = {
        kind: "question",
        prompt: first.prompt,
        choices: first.choices,
        ...(asksBatch
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
    resume(message, outcome, from, request_id) {
      let seq = from;
      const answered = outcome.kind === "answered" ? outcome.answers : {};
      const said = questions.flatMap((q) => {
        const raw = answered[q.id];
        if (raw === undefined) return [];
        return [q.multi_select ? naturalList(selections(raw)) : bare(raw)];
      });
      const reply =
        outcome.kind === "answered"
          ? `Got it: ${said.join("; ")}. Continuing.`
          : outcome.kind === "timeout"
            ? "No answer came in time. Continuing with the default."
            : "Skipped. Continuing.";
      const frames: SequencedFrame[] = [];
      // The gateway withdraws a request that ran out of time (`request.cancel`),
      // which is a notice in the live stream and nothing in the stored turn.
      const closed =
        outcome.kind === "timeout"
          ? hermesActivity("request.cancel", { id: request_id, method: "clarify", reason: "timeout" })
          : null;
      if (closed) frames.push({ type: "block", seq: ++seq, message, block: closed });
      frames.push(
        {
          type: "block",
          seq: ++seq,
          message,
          block: tool("ok", result(answered, outcome.kind === "timeout")),
        },
        { type: "block", seq: ++seq, message, block: { kind: "text", markdown: "" } },
      );
      // Two deltas rather than one, so the continuation streams like any other text.
      const cut = Math.ceil(reply.length / 2);
      for (const text of [reply.slice(0, cut), reply.slice(cut)])
        frames.push({ type: "delta", seq: ++seq, message, text });
      frames.push({ type: "done", seq: ++seq, message, usage: null, incomplete: null });
      return frames;
    },
  };
}
