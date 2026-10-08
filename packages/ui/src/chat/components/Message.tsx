/**
 * One turn in the transcript.
 *
 * Two things here are not layout.
 *
 * **Message-level failure is one renderer, not six blocks.** Rate limited,
 * credential rejected, turn ceiling, context full, box went away, model
 * missing — six cases that differ in their words and in one
 * tone bit. They are a `ChatMessage` with `error` set and `incomplete` true, so
 * they are drawn here, from `failureCopy()`, and a seventh code gets a card with
 * the code on it rather than silence.
 *
 * **A failed turn keeps what it had produced.** The blocks that arrived before
 * the stream stopped are rendered above the failure card, and the card says
 * they are incomplete. Hermes writes its own transcript on the box, so nothing
 * is actually lost; throwing away the visible half would only make that harder
 * to believe.
 */
import type { TurnActivity } from "../chat-activity.ts";
import { botLabel } from "../chat-presentation.ts";
import { ActivityGroup, isActivity, needsAttention } from "./Activity.tsx";
import { RedactedText } from "./RedactedText.tsx";
import type { ChatBlockView, ChatMessageView } from "../../api/index.ts";
import { fmtClock } from "../../logic/format.ts";
import { failureCopy } from "../chat-logic.ts";
import type { MessageRow } from "../chat-logic.ts";
import { Block } from "./blocks/index.tsx";
import { Face, OperatorFace } from "./Face.tsx";
import { RowBoundary } from "./RowBoundary.tsx";

/**
 * `ChatMessage.error` is one string, and it is allowed to be either a
 * `HermeticError` code, a sentence, or — as the fixture writes it and as a box
 * plausibly would — a code with a sentence after it.
 *
 * §9.2 deliberately does not narrow the field to the `ErrorCode` enum, because
 * a box can report a code this build has never heard of. So the shape is read
 * rather than assumed: a leading SHOUTING_SNAKE token is the code and gets the
 * copy that belongs to it, whatever follows a separator is the detail, and a
 * string with no such token is a sentence and is shown as one.
 *
 * Absence with `incomplete` set is its own case: the turn stopped and nothing
 * said why, which is the dropped-stream pane.
 */
const CODED = /^([A-Z][A-Z0-9_]{2,})(?:\s*[·:\u2014-]\s*([\s\S]*))?$/;

export function splitError(error: string | null | undefined): {
  code: string | null;
  message: string | null;
} {
  if (!error) return { code: "INCOMPLETE", message: null };
  const m = CODED.exec(error.trim());
  if (!m) return { code: null, message: error };
  return { code: m[1] ?? null, message: m[2]?.trim() || null };
}

/** A message-level failure, keyed off the code core or the provider reported. */
export function FailureCard({ code, message }: { code: string | null; message: string | null }) {
  const copy = failureCopy(code, message);
  return (
    <div className={`ch-card ${copy.tone}`}>
      <div className="ch-card-head">
        <span>{copy.head}</span>
        <span className="right mono">{copy.right}</span>
      </div>
      <div className="ch-card-body">
        <p>
          <b>
            <RedactedText text={copy.title} />
          </b>{" "}
          <RedactedText text={copy.detail} />
        </p>
      </div>
    </div>
  );
}

/** The turn meter: what it cost, which an unattended fleet has to make visible. */
function Meter({ usage }: { usage: NonNullable<ChatMessageView["usage"]> }) {
  return (
    <div className="ch-meter">
      {usage.input_tokens ? (
        <span>
          <b>{usage.input_tokens.toLocaleString()}</b> in
        </span>
      ) : null}
      {usage.output_tokens ? (
        <span>
          <b>{usage.output_tokens.toLocaleString()}</b> out
        </span>
      ) : null}
      {usage.cost_usd !== null && usage.cost_usd !== undefined ? (
        <span>
          <b>{`$${usage.cost_usd.toFixed(4)}`}</b>
        </span>
      ) : null}
      {usage.model ? <span className="mono">{usage.model}</span> : null}
    </div>
  );
}

/**
 * A cheap signal of what a section currently says.
 *
 * `RowBoundary` retries when its `resetKey` changes. Block *count* alone does
 * not change when a streaming block grows or a tool call comes back, so a
 * boundary that caught a render error on half-arrived content would stay
 * tripped over content that has since become renderable. Text length and tool
 * status move on exactly those edits and cost nothing to compute.
 */
function sectionSignal(blocks: readonly ChatBlockView[]): string {
  let text = 0;
  const marks: string[] = [];
  for (const block of blocks) {
    if (block.kind === "text") text += block.markdown.length;
    else if (block.kind === "reasoning") text += block.text.length;
    else if (block.kind === "tool") marks.push(block.status ?? "?");
    else if (block.kind === "activity") marks.push(block.state);
  }
  return `${text}/${marks.join(",")}`;
}

export function Message({
  row,
  fleetId,
  instance,
  /** The bot whose thread this is, for a message that names no author. */
  bot,
  botTitle,
  status,
  now,
  /** The turn is still arriving, so the last prose block gets a caret. */
  streaming = false,
  activity = streaming ? "streaming" : "idle",
  /**
   * What this turn answers, when it directly follows a background event
   * (`threadItems`): Hermes woke the bot with that event, so this is its reply.
   */
  inReply = null,
}: {
  row: MessageRow<ChatMessageView> & { ids?: readonly string[] };
  fleetId: string;
  instance: string;
  bot: string;
  botTitle?: string | null;
  status: "ready" | "degraded" | "error" | "stopped" | "destroyed" | "pending";
  now: number;
  streaming?: boolean;
  activity?: TurnActivity;
  inReply?: string | null;
}) {
  const { message, continuation } = row;
  // Every source id this article stands for. A `#message=` link names the row
  // the box wrote, which may now be in the middle of a merged turn, so the
  // article has to answer to all of them and not only to the one it is named by.
  const ids = row.ids?.length ? row.ids : [message.id];
  const mine = message.role === "user";
  const author = message.author ?? null;
  const who = mine
    ? "You"
    : botLabel(
        author?.instance ?? instance,
        author?.bot ?? bot,
        !author || (author.instance === instance && author.bot === bot) ? botTitle : null,
      );
  const broken = !!message.error || !!message.incomplete;
  if (message.blocks.length === 0 && !broken && !message.usage) return null;
  const closedRequests = new Set(
    message.blocks.flatMap((block) =>
      block.kind === "activity" &&
      block.category === "notice" &&
      block.state === "done" &&
      block.request_id
        ? [block.request_id]
        : [],
    ),
  );
  const blocks = message.blocks.filter(
    (block) =>
      (block.kind !== "text" || block.markdown.trim().length > 0) &&
      !(
        (block.kind === "approval" || block.kind === "question") &&
        block.request_id &&
        closedRequests.has(block.request_id)
      ),
  );
  const waiting = blocks.some((block) => block.kind === "approval" || block.kind === "question");
  // One turn's work is one group. Only something addressed to the reader —
  // prose, a question, an approval, a card — closes the run; a notice *about*
  // the run does not, so the tool call after it rejoins the group rather than
  // opening a second "Tools complete" beside it. The group is emitted at its
  // first block's position, so a notice that arrived mid-run is drawn *below*
  // the whole group, not between the two calls it separated. Keeping arrival
  // order instead is what split the turn in two.
  const sections: { activity: boolean; blocks: typeof blocks }[] = [];
  let run: { activity: boolean; blocks: typeof blocks } | null = null;
  for (const block of blocks) {
    const attention = needsAttention(block);
    if (isActivity(block) && !attention) {
      if (run) run.blocks.push(block);
      else {
        run = { activity: true, blocks: [block] };
        sections.push(run);
      }
      continue;
    }
    sections.push({ activity: false, blocks: [block] });
    if (!(attention && block.kind === "activity")) run = null;
  }

  // Empty text placeholders do not end a pending activity section. A new
  // generation can also update an earlier keyed block after prose has arrived.
  //
  // The run is emitted at its first block's position, so the live group is not
  // the last section whenever a notice about the run arrived after it: those
  // sections sit below the group and are still part of the same turn's work.
  // Reading the last section as the live one there tells a running turn it
  // stopped.
  const lastActivity = sections.findLastIndex((section) => section.activity);
  const trailingNotices =
    lastActivity >= 0 &&
    sections.slice(lastActivity + 1).every((section) => section.blocks[0]?.kind === "activity");
  const activeGroup =
    trailingNotices || (streaming && (activity === "thinking" || waiting))
      ? lastActivity
      : sections.length - 1;

  const meta = [
    fmtClock(message.at),
    message.incomplete && !message.error ? "incomplete" : null,
    streaming ? (waiting ? "waiting" : activity === "idle" ? null : activity) : null,
    // A room or peer turn is not by the session's own bot, so the message says
    // which box the author is on. A plain bot chat does not need it.
    author && author.instance !== instance ? `@ ${author.instance}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      data-chat-message={message.id}
      data-chat-ids={ids.join(" ")}
      tabIndex={-1}
      className={`ch-msg${mine ? " me" : ""}${continuation ? " cont" : ""}`}
    >
      {mine ? (
        <OperatorFace />
      ) : (
        <Face
          fleetId={fleetId}
          instance={author?.instance ?? instance}
          bot={author?.bot ?? bot}
          size={36}
          status={status}
          activity={activity}
          square={false}
        />
      )}
      <div>
        {inReply ? (
          <div className="ch-inreply">
            <RedactedText text={`↳ responding to ${inReply}`} />
          </div>
        ) : null}
        <div className="ch-msg-head">
          <span className="ch-msg-who">{who}</span>
          <span className="ch-msg-meta">{meta}</span>
        </div>
        <div className="ch-msg-body">
          {/*
            A turn is now one article built out of several source rows
            (`chat-turns.ts`), so the boundary `Thread` puts around the row is
            no longer fine enough: one block that cannot be read would take the
            prose either side of it down with it. Each section gets its own
            blast door, and the row-level one stays as the floor under
            everything that is not a section.
          */}
          {sections.map((section, index) =>
            section.activity ? (
              <RowBoundary
                key={index}
                resetKey={`${message.id}:${index}:${section.blocks.length}:${sectionSignal(section.blocks)}`}
                label={`${message.id} activity ${index}`}
              >
                <ActivityGroup
                  blocks={section.blocks}
                  streaming={
                    (streaming && activity !== "idle" && index === activeGroup) ||
                    (streaming && waiting && index === activeGroup)
                  }
                  activity={activity}
                  waiting={waiting}
                />
              </RowBoundary>
            ) : (
              <RowBoundary
                key={index}
                resetKey={`${message.id}:${index}:${section.blocks.length}:${sectionSignal(section.blocks)}`}
                label={`${message.id} block ${index}`}
              >
                <Block
                  block={section.blocks[0]!}
                  now={now}
                  streaming={streaming && activity === "streaming" && index === sections.length - 1}
                  mine={mine}
                />
              </RowBoundary>
            ),
          )}
          {broken ? <FailureCard {...splitError(message.error)} /> : null}
          {message.usage ? <Meter usage={message.usage} /> : null}
        </div>
      </div>
    </article>
  );
}
