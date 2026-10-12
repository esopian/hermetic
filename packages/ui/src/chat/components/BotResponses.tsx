/**
 * Answering a server request from the transcript (`chat.respond`, §9.2): the
 * approval card's four choices, and the clarify card whole.
 *
 * A clarify is one request however many questions it carries, and the gateway
 * keeps the turn parked until every one of them has an answer. So a batch is
 * one form with one confirm, never a card per question that each looks
 * answered on its own while the turn waits for the rest. A single question is
 * the same form with one entry, which keeps the two from drifting apart.
 */
import { createContext, useContext, useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import type { ChatBlockOf, ChatBlockView, ChatMessageView } from "../../api/index.ts";
import { RedactedText } from "./RedactedText.tsx";

/** `ChatRespondInput` less the conversation, which the provider fills in. */
export type Decision = {
  request_id: string;
  kind: "approval" | "question";
  choice?: "once" | "session" | "always" | "deny";
  /**
   * A single question's answer, or one batch question's when `question_id`
   * names it. The clarify card never locks one at a time: it sends a batch
   * whole through `answers`; `question_id` stays for callers that do.
   */
  answer?: string;
  question_id?: string;
  /** Every answer of a batch at once, keyed by the question's `id` (the gateway `qid`). */
  answers?: Record<string, string>;
  /** Decline to answer: the box continues as if the operator said nothing. */
  skip?: true;
};
export type Respond = (decision: Decision) => Promise<unknown>;
export const BotResponses = createContext<Respond | null>(null);

const SENT = "Response sent.";
const GONE = "Already answered or expired.";

/**
 * The request ids a message has already closed: the box says a request is
 * over (answered elsewhere, withdrawn, expired) with a finished `notice`
 * carrying its id, and a card for it must neither draw nor be answered.
 */
export function closedRequests(blocks: readonly ChatBlockView[]): Set<string> {
  return new Set(
    blocks.flatMap((block) =>
      block.kind === "activity" &&
      block.category === "notice" &&
      block.state === "done" &&
      block.request_id
        ? [block.request_id]
        : [],
    ),
  );
}

/**
 * The newest clarify in `scope` still waiting on the operator, by request id,
 * or `null`. The composer declines it before sending (`Composer.tsx`), because
 * a steer queues behind the blocked tool and would otherwise never land.
 *
 * `scope` is one message or the parts of one reply in order — the live message
 * and the parts a steer closed off (`openRequest` in `chat-conversations.ts`).
 * A close lands where it is assembled, which for a box-sent notice is the live
 * part even when the card sits in an earlier one, so the closed set is read
 * across the whole scope.
 */
export function openQuestion(
  scope: ChatMessageView | readonly ChatMessageView[] | null | undefined,
  now = Date.now(),
): string | null {
  const parts: readonly ChatMessageView[] = !scope ? [] : "blocks" in scope ? [scope] : scope;
  const closed = new Set(parts.flatMap((message) => [...closedRequests(message.blocks)]));
  for (let p = parts.length - 1; p >= 0; p -= 1) {
    const blocks = parts[p]!.blocks;
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i]!;
      if (block.kind !== "question" || !block.request_id || closed.has(block.request_id)) continue;
      if (block.expires_at && Date.parse(block.expires_at) < now) continue;
      return block.request_id;
    }
  }
  return null;
}

function useSubmit(respond: Respond | null) {
  const [state, setState] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(decision: Decision) {
    if (busy || !respond) return;
    setBusy(true);
    setState("");
    try {
      const result = await respond(decision);
      setState(
        result && typeof result === "object" && "status" in result && result.status === "expired"
          ? GONE
          : SENT,
      );
    } catch (e) {
      setState(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return { state, busy, submit, settled: state === SENT || state === GONE };
}

function Failure({ state }: { state: string }) {
  return state ? (
    <p role="alert" className="bm-error">
      {state}
    </p>
  ) : null;
}

/** The approval card's choices. The clarify card is `QuestionCard`, head and all. */
export function RequestActions({ block }: { block: ChatBlockOf<"approval"> }) {
  const respond = useContext(BotResponses);
  const { state, busy, submit, settled } = useSubmit(respond);
  const expired = !!block.expires_at && Date.parse(block.expires_at) < Date.now();
  if (!respond || !block.request_id)
    return (
      <p className="bm-note">Respond in Hermes. This conversation is waiting for your approval.</p>
    );
  const request_id = block.request_id;
  if (settled) return <p role="status">{state}</p>;
  return (
    <div className="bm-request-actions">
      {expired ? (
        <p>Request expired.</p>
      ) : (
        <div className="ch-prompts">
          {(
            [
              ["once", "Approve once"],
              ["session", "This session"],
              ["always", "Always allow"],
              ["deny", "Deny"],
            ] as const
          ).map(([value, label]) => (
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              key={value}
              onClick={() => void submit({ request_id, kind: "approval", choice: value })}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <Failure state={state} />
    </div>
  );
}

/* ── the clarify card ────────────────────────────────────────────────────── */

/** One question of the form. `id` is the gateway's `qid`, `null` for a single question. */
interface Entry {
  id: string | null;
  prompt: string;
  choices: string[];
  multi_select: boolean;
  /**
   * The answer the gateway already holds: a lock replayed on reconnect, or, on
   * a card read back from history, what was sent ("" for a skipped question).
   */
  answer: string | null;
}

/**
 * What the operator has staged for one question: picked choices and typed
 * text, and whether they have edited it at all — a question they emptied is
 * still theirs, and a later lock must not refill it.
 */
interface Stage {
  picked: string[];
  text: string;
  touched?: true;
}
const EMPTY: Stage = { picked: [], text: "" };

/**
 * The questions a block asks. A batch lists them; a single question is the
 * block's own prompt. Fields are normalised here because a transcript is data
 * read back from storage, and a block from another build may lack one.
 */
function questionsOf(block: ChatBlockOf<"question">): Entry[] {
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

/** The gateway marks its suggestion with this suffix and strips it from an answer. */
const RECOMMENDED = /\s*\(recommended\)$/i;
const bare = (choice: string) => choice.replace(RECOMMENDED, "");

/** A multi-select answer is a JSON list of strings; anything else is one value. */
function listOf(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed;
  } catch {
    // Not a JSON list.
  }
  return null;
}

/** A locked answer back onto the controls: its choices picked, anything else typed. */
function replayed(q: Entry): Stage {
  if (q.answer === null) return EMPTY;
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

/**
 * The answer a question would send, or `null` while it has none. A choice goes
 * out bare, without the gateway's " (Recommended)" suffix, as Hermes Desktop
 * sends it (the gateway strips the suffix too, so either is accepted);
 * multi-select sends the picks and any typed text as a JSON list, which is how
 * the gateway takes one.
 */
function answerOf(q: Entry, stage: Stage): string | null {
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

/** A question declined as a whole: nothing sent for it, or the empty answer history records. */
const skipped = (value: string | null) => value === null || value.trim() === "";

/**
 * How a sent answer reads on the settled card: a choice without the gateway's
 * suggestion suffix, a multi-select's values joined with ", ", and a declined
 * question as "Skipped".
 */
function answerText(q: Entry, value: string | null): string {
  if (value === null || skipped(value)) return "Skipped";
  const label = (v: string) => (q.choices.includes(v) ? bare(v) : v);
  const list = q.multi_select ? listOf(value) : null;
  return list ? list.map(label).join(", ") : label(value);
}

/** The row's letter, A, B, C…; past Z the row's number, which no gateway reaches. */
const letter = (index: number) => (index < 26 ? String.fromCharCode(65 + index) : String(index + 1));

function ChoiceLabel({ choice }: { choice: string }) {
  const plain = bare(choice);
  if (plain === choice) return <>{choice}</>;
  return (
    <>
      {plain}
      <span className="bm-recommended">{choice.slice(plain.length)}</span>
    </>
  );
}

/**
 * The prompt, emphasised, with "choose any" on a multi-select that has
 * choices: the badges' shape says the same, but not to everyone.
 */
function Prompt({ q, id }: { q: Entry; id?: string }) {
  return (
    <div className="bm-question-head">
      <p className="bm-question-prompt" id={id}>
        <RedactedText text={q.prompt} />
      </p>
      {q.multi_select && q.choices.length > 0 ? (
        <span className="bm-question-hint">choose any</span>
      ) : null}
    </div>
  );
}

/**
 * One choice row. A single-select row is a radio and its badge is round; a
 * multi-select row is a checkbox and its badge is square, ticked when picked.
 * Both stay `<button>`s with radio or checkbox semantics, each its own tab
 * stop (no arrow-key roving), so Space and Enter work without a handler.
 */
function Option({
  q,
  index,
  choice,
  checked,
  disabled,
  onPick,
}: {
  q: Entry;
  index: number;
  choice: string;
  checked: boolean;
  disabled: boolean;
  onPick?: () => void;
}) {
  const content = (
    <>
      <span className="bm-badge" aria-hidden="true">
        {q.multi_select && checked ? "✓" : letter(index)}
      </span>
      <span className="bm-option-label">
        <ChoiceLabel choice={choice} />
      </span>
    </>
  );
  // One literal role per branch, so the linter can see `aria-checked` belongs to it.
  return q.multi_select ? (
    <button
      className="ch-prompt bm-option"
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onPick}
    >
      {content}
    </button>
  ) : (
    <button
      className="ch-prompt bm-option"
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onPick}
    >
      {content}
    </button>
  );
}

/**
 * The choice list: a radiogroup for single-select, a plain list of checkboxes
 * otherwise. It is named by the question's group around it, not again here, so
 * the prompt is announced once.
 */
function Options({ q, children }: { q: Entry; children: ReactNode }) {
  return (
    <div
      className={q.multi_select ? "ch-prompts bm-options multi" : "ch-prompts bm-options"}
      role={q.multi_select ? undefined : "radiogroup"}
    >
      {children}
    </div>
  );
}

/**
 * Each question with what went back. `values` is one entry per question (`null`
 * for a skipped one), or `null` when nothing is known to have counted — an
 * expired request, whose answer the box never took — and only the prompts show.
 */
function Summary({
  questions,
  values,
  status,
}: {
  questions: Entry[];
  values: (string | null)[] | null;
  status?: string;
}) {
  return (
    <div className="bm-settled">
      {questions.map((q, i) => {
        const value = values ? (values[i] ?? null) : null;
        return (
          <div className="bm-question" key={q.id ?? i}>
            <p className="bm-question-prompt">
              <strong>
                <RedactedText text={q.prompt} />
              </strong>
            </p>
            {values ? (
              <p className={skipped(value) ? "bm-settled-skipped" : "bm-settled-answer"}>
                <RedactedText text={answerText(q, value)} />
              </p>
            ) : null}
          </div>
        );
      })}
      {status ? <p role="status">{status}</p> : null}
    </div>
  );
}

/**
 * The whole clarify card, head included: whether the head says "turn paused"
 * depends on the form's own state. It says so only while this card can
 * answer the request — a responder and a request id, not expired, not yet
 * settled. A transcript question with no way to answer, an expired request
 * and a settled card do not claim the turn is waiting on this card.
 */
export function QuestionCard({
  block,
  now = Date.now(),
}: {
  block: ChatBlockOf<"question">;
  /** The clock expiry is read against: the transcript's, so every block agrees. */
  now?: number;
}) {
  const respond = useContext(BotResponses);
  const ids = useId();
  const { state, busy, submit, settled } = useSubmit(respond);
  const questions = questionsOf(block);
  const [stages, setStages] = useState<Stage[]>(() => questions.map(replayed));
  /** What went out, one entry per question (`null` for a skipped one), for the settled card. */
  const [sent, setSent] = useState<(string | null)[] | null>(null);
  // A replay can carry locks the first delivery did not. They fill questions
  // the operator has not touched and never overwrite one they have, even one
  // they emptied.
  const locks = JSON.stringify(questions.map((q) => q.answer));
  useEffect(() => {
    setStages((current) =>
      questions.map((q, i) => {
        const stage = current[i] ?? EMPTY;
        return stage.touched || q.answer === null ? stage : replayed(q);
      }),
    );
    // Keyed on the locks alone: `questions` is rebuilt every render.
  }, [locks, questions.length]);

  const request_id = block.request_id ?? null;
  // A question with no request id but recorded answers is a clarify read back
  // from history: it was settled when it happened, so it reads as settled.
  const recorded = !request_id && questions.some((q) => q.answer !== null);
  const live = !!respond && !!request_id;
  const expired = !!block.expires_at && Date.parse(block.expires_at) < now;
  const paused = live && !expired && !settled;

  const form = (request_id: string) => {
    // A batch is answered whole, keyed by each question's `id`; a single question by its value.
    const batch = questions.every((q) => q.id !== null);
    const values = questions.map((q, i) => answerOf(q, stages[i] ?? EMPTY));
    const answered = values.filter((v) => v !== null).length;
    const ready = answered === questions.length;
    const locked = busy || expired;
    const edit = (index: number, next: (stage: Stage, q: Entry) => Stage) =>
      setStages((current) =>
        questions.map((q, i) =>
          i === index ? { ...next(current[i] ?? EMPTY, q), touched: true } : (current[i] ?? EMPTY),
        ),
      );
    const confirm = () => {
      if (locked || !ready) return;
      setSent(values);
      void submit(
        batch
          ? {
              request_id,
              kind: "question",
              answers: Object.fromEntries(questions.map((q, i) => [q.id!, values[i]!])),
            }
          : { request_id, kind: "question", answer: values[0]! },
      );
    };
    return (
      <div className="bm-request-actions">
        {questions.length > 1 ? (
          <p className="bm-question-progress">{`${answered} of ${questions.length} answered`}</p>
        ) : null}
        {questions.map((q, i) => {
          const stage = stages[i] ?? EMPTY;
          // "Other" is the row after the choices, lettered after them but
          // outside the radiogroup (it is a text field, not a radio); a
          // question with no choices is just the text field.
          const prompt = `${ids}-q${i}`;
          const other = (
            <input
              className="bm-other-input"
              id={`${prompt}-other`}
              aria-label={`Answer: ${q.prompt}`}
              placeholder={q.choices.length > 0 ? "Other (type your answer)" : "Type your answer…"}
              disabled={locked}
              value={stage.text}
              onChange={(e) => {
                const text = e.target.value;
                edit(i, (s, entry) => (entry.multi_select ? { ...s, text } : { picked: [], text }));
              }}
              onKeyDown={(e) => {
                // An IME's Enter commits the composition; it is not a confirm.
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  confirm();
                }
              }}
            />
          );
          return (
            <div className="bm-question" role="group" aria-labelledby={prompt} key={q.id ?? i}>
              <Prompt q={q} id={prompt} />
              {q.choices.length > 0 ? (
                <>
                  <Options q={q}>
                    {q.choices.map((choice, index) => (
                      <Option
                        key={`${index}-${choice}`}
                        q={q}
                        index={index}
                        choice={choice}
                        checked={stage.picked.includes(choice)}
                        disabled={locked}
                        onPick={() =>
                          edit(i, (s, entry) =>
                            entry.multi_select
                              ? {
                                  ...s,
                                  picked: s.picked.includes(choice)
                                    ? s.picked.filter((c) => c !== choice)
                                    : [...s.picked, choice],
                                }
                              : { picked: [choice], text: "" },
                          )
                        }
                      />
                    ))}
                  </Options>
                  <label
                    htmlFor={`${prompt}-other`}
                    className={[
                      "bm-option bm-other",
                      q.multi_select ? "multi" : "",
                      stage.text.trim() ? "on" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <span className="bm-badge" aria-hidden="true">
                      {q.multi_select && stage.text.trim() ? "✓" : letter(q.choices.length)}
                    </span>
                    {other}
                  </label>
                </>
              ) : (
                <div className="bm-answer">{other}</div>
              )}
            </div>
          );
        })}
        {expired ? <p>Request expired.</p> : null}
        <div className="bm-question-foot">
          <button
            className="btn bm-skip"
            type="button"
            disabled={locked}
            onClick={() => {
              setSent(questions.map(() => null));
              void submit({ request_id, kind: "question", skip: true });
            }}
          >
            Skip
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={locked || !ready}
            onClick={confirm}
          >
            Confirm and continue
          </button>
        </div>
        <Failure state={state} />
      </div>
    );
  };

  let body: ReactNode;
  if (recorded) body = <Summary questions={questions} values={questions.map((q) => q.answer)} />;
  // Settled, the card collapses in place to what was asked and what went back,
  // and the reply carries on below it in the same message. An answer is shown
  // only when the box took it: for an expired request it never counted.
  else if (live && settled)
    body = <Summary questions={questions} values={state === SENT ? sent : null} status={state} />;
  else if (!live)
    body = (
      <>
        {questions.map((q, i) => (
          <div className="bm-question" key={q.id ?? i}>
            <Prompt q={q} />
            {q.choices.length > 0 ? (
              <Options q={q}>
                {q.choices.map((choice, index) => (
                  <Option
                    key={`${index}-${choice}`}
                    q={q}
                    index={index}
                    choice={choice}
                    checked={false}
                    disabled
                  />
                ))}
              </Options>
            ) : null}
          </div>
        ))}
        <p className="bm-note">Respond in Hermes. Choices are shown here for reference.</p>
      </>
    );
  else body = form(request_id!);

  return (
    <div className={recorded || settled ? "ch-card muted bm-clarify" : "ch-card acc bm-clarify"}>
      <div className="ch-card-head">
        <span>question</span>
        {paused ? <span className="right">turn paused</span> : null}
      </div>
      <div className="ch-card-body">{body}</div>
    </div>
  );
}
