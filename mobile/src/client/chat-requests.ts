/**
 * Server requests in the transcript — approvals and clarifies — and the rules
 * for drawing and answering them.
 *
 * Mirrors `packages/ui/src/chat/chat-requests.ts` (`closedRequests`,
 * `keepsCard`, `openRequests`), `components/ApprovalActions.tsx` (labels and
 * `offered`) and the pure half of `components/BotResponses.tsx` (the clarify
 * form's entries, answers and summaries). Pure TypeScript.
 */
import type {
  ActivityBlock,
  ApprovalBlock,
  ApprovalChoice,
  ChatBlock,
  QuestionBlock,
} from "@hermetic/core/chat-client";

/* ── closed and open ─────────────────────────────────────────────────────── */

export type ClosedKind = "skipped" | "answered" | "timeout" | "cancelled";
export interface ClosedRequest {
  kind: ClosedKind;
  title: string;
}

export const SKIPPED_TITLE = "Question skipped";

function closedKind(block: ActivityBlock): ClosedKind {
  switch (block.reason) {
    case "timeout":
      return "timeout";
    case "resolved":
      return "answered";
    case "interrupted":
    case "shutdown":
    case "session_closed":
    case "other":
      return "cancelled";
    default:
      return block.title === SKIPPED_TITLE ? "skipped" : "answered";
  }
}

/** Request ids a message has already closed (a finished `notice` carrying the id), with how. */
export function closedRequests(blocks: readonly ChatBlock[]): Map<string, ClosedRequest> {
  const closed = new Map<string, ClosedRequest>();
  for (const block of blocks)
    if (
      block.kind === "activity" &&
      block.category === "notice" &&
      block.state === "done" &&
      block.request_id
    )
      closed.set(block.request_id, { kind: closedKind(block), title: block.title });
  return closed;
}

/** Whether a closed request's card stays as its settled summary. */
export function keepsCard(block: ChatBlock, closed: ClosedRequest | undefined): boolean {
  if (!closed) return true;
  if (block.kind === "question") return closed.kind !== "answered";
  if (block.kind === "approval") return closed.kind === "timeout" || closed.kind === "cancelled";
  return true;
}

export type RequestBlock = ApprovalBlock | QuestionBlock;

/**
 * Requests still waiting: an id, not closed, not answered here, not expired —
 * and in a turn still live on this phone (`answerable`). One that is not (the
 * turn dropped, cut off, running on the box unfollowed, or settled without a
 * response) is stale: its card draws `STALE`, and nothing waits on it.
 */
export function openRequests(
  blocks: readonly ChatBlock[],
  closed: ReadonlyMap<string, ClosedRequest>,
  released: ReadonlySet<string> | readonly string[] | null | undefined,
  now: number,
  answerable = true,
): RequestBlock[] {
  if (!answerable) return [];
  const done = released ? new Set(released) : null;
  return blocks.filter(
    (block): block is RequestBlock =>
      (block.kind === "approval" || block.kind === "question") &&
      !!block.request_id &&
      !closed.has(block.request_id) &&
      !done?.has(block.request_id) &&
      !(block.expires_at && Date.parse(block.expires_at) <= now),
  );
}

/** The earliest `expires_at` among `open` still ahead of `now`, or `null`. */
export function nextExpiry(open: readonly RequestBlock[], now: number): number | null {
  let next: number | null = null;
  for (const block of open) {
    const at = block.expires_at ? Date.parse(block.expires_at) : Number.NaN;
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

/* ── approvals ───────────────────────────────────────────────────────────── */

export const APPROVAL_LABEL: Record<ApprovalChoice, string> = {
  once: "Approve once",
  session: "This session",
  always: "Always allow",
  deny: "Deny",
};

export const APPROVAL_OUTCOME: Record<ApprovalChoice, string> = {
  once: "Approved once",
  session: "Allowed this session",
  always: "Always allowed",
  deny: "Denied",
};

export const EXPIRED = "Request expired.";
export const SENT = "Response sent.";
export const GONE = "Already answered or expired.";
/** A request whose turn is no longer live on this phone (`openRequests`). */
export const STALE = "This request can no longer be answered from here.";

const KNOWN_CHOICES = new Set<string>(["once", "session", "always", "deny"]);

/** Exactly the choices the gateway offered, in its order; the narrowest set when none. */
export function offeredChoices(block: Pick<ApprovalBlock, "choices">): ApprovalChoice[] {
  const raw: readonly string[] = Array.isArray(block.choices) ? block.choices : [];
  const known = [...new Set(raw.filter((c): c is ApprovalChoice => KNOWN_CHOICES.has(c)))];
  return known.length > 0 ? known : ["once", "deny"];
}

export function approvalClosedLine(kind: ClosedKind): string | null {
  if (kind === "timeout") return "Approval timed out — the command was not run";
  if (kind === "cancelled") return "Approval cancelled — the command was not run";
  return null;
}

/* ── clarify ─────────────────────────────────────────────────────────────── */

/** One question of the form. `id` is the gateway's `qid`, `null` for a single question. */
export interface QuestionEntry {
  id: string | null;
  prompt: string;
  choices: string[];
  multi_select: boolean;
  answer: string | null;
}

/** What the operator has staged for one question. */
export interface Stage {
  picked: string[];
  text: string;
  touched?: true;
}
export const EMPTY_STAGE: Stage = { picked: [], text: "" };

export function questionsOf(block: QuestionBlock): QuestionEntry[] {
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  if (Array.isArray(block.questions) && block.questions.length > 0)
    return block.questions.map((q) => ({
      id: q.id,
      prompt: text(q.prompt),
      choices: strings(q.choices),
      multi_select: q.multi_select === true,
      answer: typeof q.answer === "string" ? q.answer : null,
    }));
  return [
    {
      id: null,
      prompt: text(block.prompt),
      choices: strings(block.choices),
      multi_select: block.multi_select === true,
      answer: null,
    },
  ];
}

const RECOMMENDED = /\s*\(recommended\)$/i;
/** A choice without the gateway's " (Recommended)" suffix. */
export const bare = (choice: string): string => choice.replace(RECOMMENDED, "");

function listOf(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed;
  } catch {
    // Not a JSON list.
  }
  return null;
}

/** A locked answer back onto the controls. */
export function replayed(q: QuestionEntry): Stage {
  if (q.answer === null) return EMPTY_STAGE;
  const values = (q.multi_select && listOf(q.answer)) || [q.answer];
  const matches = (choice: string) => values.includes(choice) || values.includes(bare(choice));
  const picked = q.choices.filter(matches);
  if (!q.multi_select)
    return picked.length > 0
      ? { picked: picked.slice(0, 1), text: "" }
      : { picked: [], text: q.answer };
  const rest = values.filter((v) => !q.choices.some((c) => c === v || bare(c) === v));
  return { picked, text: rest.join(", ") };
}

/** The answer a question would send, or `null` while it has none. */
export function answerOf(q: QuestionEntry, stage: Stage): string | null {
  const typed = stage.text.trim();
  if (q.multi_select) {
    const all = [
      ...q.choices.filter((c) => stage.picked.includes(c)).map(bare),
      ...(typed ? [typed] : []),
    ];
    return all.length > 0 ? JSON.stringify(all) : null;
  }
  const pick = stage.picked[0];
  return pick !== undefined ? bare(pick) : typed || null;
}

export const skippedAnswer = (value: string | null): boolean => value === null || value.trim() === "";

/** How a sent answer reads on the settled card. */
export function answerText(q: QuestionEntry, value: string | null): string {
  if (value === null || skippedAnswer(value)) return "Skipped";
  const label = (v: string) => (q.choices.includes(v) ? bare(v) : v);
  const list = q.multi_select ? listOf(value) : null;
  return list ? list.map(label).join(", ") : label(value);
}

/** A, B, C…; past Z the row's number. */
export const letter = (index: number): string =>
  index < 26 ? String.fromCharCode(65 + index) : String(index + 1);

/** Pick or unpick a choice on a stage. */
export function pick(stage: Stage, q: QuestionEntry, choice: string): Stage {
  if (q.multi_select)
    return {
      ...stage,
      picked: stage.picked.includes(choice)
        ? stage.picked.filter((c) => c !== choice)
        : [...stage.picked, choice],
      touched: true,
    };
  return { picked: [choice], text: "", touched: true };
}

/** Type into "Other": single-select clears the pick, multi-select keeps it. */
export function typeOther(stage: Stage, q: QuestionEntry, text: string): Stage {
  return q.multi_select ? { ...stage, text, touched: true } : { picked: [], text, touched: true };
}

/** The `chat.respond` payload for a confirmed form, or `null` while it is incomplete. */
export function clarifyPayload(
  request_id: string,
  questions: readonly QuestionEntry[],
  stages: readonly Stage[],
):
  | { request_id: string; kind: "question"; answers: Record<string, string> }
  | { request_id: string; kind: "question"; answer: string }
  | null {
  const values = questions.map((q, i) => answerOf(q, stages[i] ?? EMPTY_STAGE));
  if (values.some((v) => v === null)) return null;
  const batch = questions.every((q) => q.id !== null);
  if (batch)
    return {
      request_id,
      kind: "question",
      answers: Object.fromEntries(questions.map((q, i) => [q.id as string, values[i] as string])),
    };
  return { request_id, kind: "question", answer: values[0] as string };
}

export function lateAnswer(prompt: string, choice: string): string {
  return `Re: "${prompt}" — my answer: ${choice}`;
}
