/**
 * One turn in the transcript.
 *
 * Two things here are not layout.
 *
 * **Message-level failure is one renderer, not six blocks.** Rate limited,
 * credential rejected, turn ceiling, context full, box went away, model
 * missing — six cases that differ in their words, one tone bit and what can be
 * done about them. They are a `ChatMessage` with `failure` (or the older
 * `error` string) set, so they are drawn here by `FailureCard`, live and from
 * history alike, and a seventh code gets a card with the code on it rather
 * than silence.
 *
 * **A failed turn keeps what it had produced.** The blocks that arrived before
 * the stream stopped are rendered above the failure card, and the card says
 * they are incomplete. Hermes writes its own transcript on the box, so nothing
 * is actually lost; throwing away the visible half would only make that harder
 * to believe.
 */
import type { TurnActivity } from "../chat-activity.ts";
import { botLabel } from "../chat-presentation.ts";
import { ActivityGroup, isActivity, isStatusBlock, needsAttention } from "./Activity.tsx";
import { RedactedText } from "./RedactedText.tsx";
import { closedRequests, keepsCard, nextExpiry, openRequests } from "../chat-requests.ts";
import type { ClosedRequest } from "../chat-requests.ts";
import { useWakeAt } from "../use-wake-at.ts";
import { useChatIfAvailable } from "../chat-state.tsx";
import type { ChatBlockView, ChatMessageView } from "../../api/index.ts";
import { fmtClock } from "../../logic/format.ts";
import { FailureCard, failureOf } from "./FailureCard.tsx";
import { SILENT_LABEL, heldBlock, silentBlock, silentTitle } from "../chat-silence.ts";
import type { MessageRow } from "../chat-logic.ts";
import { Block } from "./blocks/index.tsx";
import { isRequestTool, untrustedBefore } from "../file-request-logic.ts";
import { isShareTool, shareIdOf } from "./blocks/ShareCard.tsx";
import { dmBotName, dmSender, messageAgentCall } from "../bot-dm.ts";
import { DmSentMarker, useBotDm } from "./BotDm.tsx";
import { Face, OperatorFace } from "./Face.tsx";
import { InspectMessageButton } from "./inspector/InspectEntry.tsx";
import { RowBoundary } from "./RowBoundary.tsx";

export { FailureCard, splitError } from "./FailureCard.tsx";

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

/** An approval or a clarify: the cards that read expiry, against the live clock. */
const requestCard = (block: ChatBlockView | undefined): boolean =>
  block?.kind === "approval" || block?.kind === "question";

/** How the box closed a request card's request, when it did. */
function requestClosed(
  block: ChatBlockView | undefined,
  closed: ReadonlyMap<string, ClosedRequest>,
): ClosedRequest | undefined {
  return (block?.kind === "approval" || block?.kind === "question") && block.request_id
    ? closed.get(block.request_id)
    : undefined;
}

/** A text block's words; empty for any other kind. */
function markdownOf(block: ChatBlockView | undefined): string {
  return block?.kind === "text" ? block.markdown : "";
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
    else if (block.kind === "subagent") marks.push(block.verdict);
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
  /**
   * The box's word on a turn running in the conversation, for the newest bot
   * turn only (`Thread`): how a tool call with no result yet reads. Absent on
   * every other row.
   */
  remoteBusy,
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
  remoteBusy?: boolean | null;
}) {
  const { message, continuation } = row;
  const dm = useBotDm();
  // Every source id this article stands for. A `#message=` link names the row
  // the box wrote, which may now be in the middle of a merged turn, so the
  // article has to answer to all of them and not only to the one it is named by.
  const ids = row.ids?.length ? row.ids : [message.id];
  // Another bot's `message_agent` delivery is on the user role, and it is that
  // bot speaking, not the operator (`bot-dm.ts`).
  const fromBot = message.role === "user" ? (message.from_bot ?? null) : null;
  const sender = fromBot ? dmSender(fromBot, dm.teammates) : null;
  const mine = message.role === "user" && !fromBot;
  // The operator's words, delivered into a turn that was already running.
  const steered = mine && message.steered === true;
  const author = message.author ?? null;
  const who = fromBot
    ? dmBotName(sender, fromBot.name)
    : mine
      ? "You"
      : botLabel(
          author?.instance ?? instance,
          author?.bot ?? bot,
          !author || (author.instance === instance && author.bot === bot) ? botTitle : null,
        );
  const failure = failureOf(message);
  const broken = !!failure || !!message.incomplete;
  // Requests: which the box closed (and how), which the operator answered from
  // their own card (`released`), and which are still open at this moment. The
  // transcript clock ticks every 30 s; expiry is read against the real one, and
  // a timer re-renders at the earliest open expiry so "waiting" ends on time.
  const released = useChatIfAvailable()?.released;
  const clock = Math.max(now, Date.now());
  const closed = closedRequests(message.blocks);
  const open = openRequests(message.blocks, closed, released, clock);
  useWakeAt(nextExpiry(open, clock));
  if (message.blocks.length === 0 && !broken && !message.usage) return null;
  const blocks = message.blocks.filter(
    (block) =>
      (block.kind !== "text" || block.markdown.trim().length > 0) &&
      !(
        (block.kind === "approval" || block.kind === "question") &&
        block.request_id &&
        !keepsCard(block, closed.get(block.request_id))
      ),
  );
  const pending = open.filter((block) => block.kind === "approval").length;
  // An intentional-silence marker (`chat-silence.ts`) is never drawn as prose:
  // a settled one becomes a muted "stayed silent" line, and one still
  // streaming is held back behind the caret until it diverges into an answer.
  const silent = silentBlock(message, blocks, streaming);
  const held = heldBlock(blocks, streaming);
  if (held >= 0) blocks[held] = { kind: "text", markdown: "" };
  if (silent >= 0 && blocks.every((block, i) => i === silent || isStatusBlock(block))) {
    // Nothing else in the turn: one line in the event column, not a bubble.
    // Status snapshots go too — a settled group shows nothing for them.
    return (
      <article
        data-chat-message={message.id}
        data-chat-ids={ids.join(" ")}
        tabIndex={-1}
        className="ch-silent"
        title={silentTitle(markdownOf(blocks[silent]))}
      >
        <span className="ch-silent-gut">
          <Face
            fleetId={fleetId}
            instance={author?.instance ?? instance}
            bot={author?.bot ?? bot}
            size={20}
            status={status}
            square={false}
          />
        </span>
        <span className="ch-silent-line">
          <b>{who}</b> {SILENT_LABEL}
          <span className="ch-silent-at">{fmtClock(message.at)}</span>
        </span>
      </article>
    );
  }
  // Only an open request waits on the reader: not one closed, answered from
  // its card or expired. A question with no `request_id` is one a history read
  // settled.
  const waiting = open.length > 0;
  // One turn's work is one group. Only something addressed to the reader —
  // prose, a question, an approval, a card — closes the run; a notice *about*
  // the run does not, so the tool call after it rejoins the group rather than
  // opening a second "Tools complete" beside it. The group is emitted at its
  // first block's position, so a notice that arrived mid-run is drawn *below*
  // the whole group, not between the two calls it separated. Keeping arrival
  // order instead is what split the turn in two.
  const sections: { activity: boolean; blocks: typeof blocks }[] = [];
  let run: { activity: boolean; blocks: typeof blocks } | null = null;
  // A file shared once is one card, whether the turn named it by `share_file`
  // or again on a `MEDIA:` line: the first block to draw it keeps it.
  const shared = new Set<string>();
  for (const block of blocks) {
    const shareId = shareIdOf(block);
    if (shareId !== null) {
      if (shared.has(shareId)) continue;
      shared.add(shareId);
    }
    const attention = needsAttention(block);
    // A DM to another bot is a line between the prose, not a step in the
    // group: it closes the run, so the turn reads in the order it happened.
    if (messageAgentCall(block)) {
      sections.push({ activity: false, blocks: [block] });
      run = null;
      continue;
    }
    // A file or secret request is a card the operator answers, never a step
    // folded into "Tools complete": it stands alone and closes the run.
    // So is a file the agent shared, or the box's refusal to share it.
    if (isRequestTool(block) || isShareTool(block)) {
      sections.push({ activity: false, blocks: [block] });
      run = null;
      continue;
    }
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
      className={`ch-msg${mine ? " me" : ""}${steered ? " steered" : ""}${continuation ? " cont" : ""}`}
    >
      {fromBot ? (
        sender ? (
          <Face
            fleetId={fleetId}
            instance={instance}
            bot={sender.name}
            size={36}
            status={status}
            square={false}
          />
        ) : (
          <div className="ch-avatar">{fromBot.name.slice(0, 2).toUpperCase()}</div>
        )
      ) : mine ? (
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
          {steered ? (
            <span
              className="kicker ch-msg-tag"
              title="Sent while the agent was working; delivered into the running turn"
            >
              Steered
            </span>
          ) : null}
          <span className="ch-msg-meta">{meta}</span>
          <InspectMessageButton message={message.id} />
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
                  remoteBusy={remoteBusy}
                />
              </RowBoundary>
            ) : (
              <RowBoundary
                key={index}
                resetKey={`${message.id}:${index}:${section.blocks.length}:${sectionSignal(section.blocks)}`}
                label={`${message.id} block ${index}`}
              >
                {section.blocks[0] === blocks[silent] ? (
                  <p className="ch-silent-note" title={silentTitle(markdownOf(section.blocks[0]))}>
                    {SILENT_LABEL}
                  </p>
                ) : messageAgentCall(section.blocks[0]!) ? (
                  <DmSentMarker
                    call={messageAgentCall(section.blocks[0]!)!}
                    at={message.at}
                    fleetId={fleetId}
                    instance={author?.instance ?? instance}
                    status={status}
                  />
                ) : (
                  <Block
                    block={section.blocks[0]!}
                    now={requestCard(section.blocks[0]) ? clock : now}
                    streaming={streaming && activity === "streaming" && index === sections.length - 1}
                    mine={mine}
                    closed={requestClosed(section.blocks[0], closed)}
                    pending={pending}
                    instance={instance}
                    fleetId={fleetId}
                    agent={author?.instance ?? instance}
                    at={message.at}
                    untrusted={
                      isRequestTool(section.blocks[0]) &&
                      untrustedBefore(blocks, blocks.indexOf(section.blocks[0]))
                    }
                  />
                )}
              </RowBoundary>
            ),
          )}
          {broken ? <FailureCard failure={failure} ids={ids} at={message.at} /> : null}
          {message.usage ? <Meter usage={message.usage} /> : null}
          {fromBot ? (
            <div className="ch-dm-mark from">
              {dm.open ? (
                <button
                  type="button"
                  onClick={() => dm.open?.({ side: "receiver", deliveryId: message.id })}
                >
                  <RedactedText text={`Message from ${who}`} /> <span aria-hidden="true">⇄</span>
                </button>
              ) : (
                <span className="ch-dm-mark-static">
                  <RedactedText text={`Message from ${who}`} />
                </span>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
