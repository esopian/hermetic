/**
 * The `/btw` side question's surfaces (§9.2 A side question; ui-brief "Side
 * question (/btw)"): the spotlight card over the bottom of the thread, the
 * undo strip a dismissed card leaves, and the composer's cue while a draft
 * reads as one. All three are drawn by the composer, so the full view, the
 * dock and the agent drawer get the same ones. State is `chat-btw.ts`.
 *
 * The card is a non-modal dialog: focus stays where it was (the composer), and
 * Esc with focus inside it discards it (`data-owns-escape`, so the shell's
 * stop-the-turn handler stands aside).
 */
import { useState } from "react";
import { quoteBtw } from "../chat-btw.ts";
import type { BtwCard, BtwControls } from "../chat-btw.ts";
import { chatHash, isChatHash } from "../chat-routing.ts";
import type { Chat } from "../chat-types.ts";
import { RedactedText } from "./RedactedText.tsx";
import { TextBlock } from "./blocks/Text.tsx";

/** HH:MM, the laptop's zone, 24-hour: the time the answer's snapshot ends. */
const CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const TEMPORARY = <span className="ch-btw-tag tmp">temporary</span>;

/** The footer's account of what the answer could see. */
function seen(card: BtwCard): string {
  if (card.state === "usage") return "Nothing was asked";
  if (!card.midTurn) return "Goes away when dismissed · sees the whole chat · no tools";
  const up = card.until ? `sees the chat up to ${CLOCK.format(new Date(card.until))} · ` : "";
  return `Goes away when dismissed · ${up}not the running turn · no tools`;
}

export function BtwSpotlight({
  chat,
  btw,
  card,
  working,
  onQuote,
}: {
  chat: Chat;
  btw: BtwControls;
  card: BtwCard;
  /** A turn is running in this conversation now: Continue as a branch warns. */
  working: boolean;
  /** Put this text in the composer as its draft (Quote into message). */
  onQuote: (draft: string) => void;
}) {
  const [branching, setBranching] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);

  const backToQueue = () => {
    if (!card.from) return;
    btw.close();
    chat.restoreQueued(card.from.row, card.from.ahead, card.from.behind);
  };
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(card.answer);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  /** A new session seeded with the chat and this pair, opened the way `/new` opens one. */
  const branch = async () => {
    setBranching(true);
    setBranchError(null);
    try {
      const made = await btw.branch();
      // Only this card: a new `/btw` may have replaced it while the branch was made.
      btw.close(card.id);
      const next = { instance: made.instance, bot: made.bot, session: made.session };
      if (chat.select(next.instance, next.bot, next.session) && isChatHash(window.location.hash))
        window.location.hash = chatHash(next);
    } catch (error) {
      setBranchError(error instanceof Error ? error.message : String(error));
    } finally {
      setBranching(false);
    }
  };

  return (
    <div className="ch-btw-anchor">
      <div
        className="ch-btw"
        role="dialog"
        aria-label="Side question"
        data-owns-escape=""
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          e.stopPropagation();
          btw.discard();
        }}
      >
        <div className="ch-btw-head">
          <span className="ch-btw-tag">btw</span>
          <div className="ch-btw-q">
            {card.question ? <RedactedText text={card.question} /> : "/btw"}
          </div>
          {TEMPORARY}
          <button
            type="button"
            className="ch-btw-discard"
            title="Dismiss discards it (Esc)"
            onClick={() => btw.discard()}
          >
            Discard ×
          </button>
        </div>
        <div className="ch-btw-body">
          {card.from ? <div className="ch-btw-meta">from the queue</div> : null}
          {card.state === "pending" ? (
            <div className="ch-btw-pending">
              <i className="ch-btw-sq" aria-hidden="true" />
              Answering from the conversation so far…
            </div>
          ) : card.state === "error" ? (
            <div className="ch-btw-err" role="alert">
              {card.answer}
            </div>
          ) : card.state === "usage" ? (
            <div className="ch-btw-usage">{card.answer}</div>
          ) : (
            <div className="ch-msg-body ch-btw-answer">
              <TextBlock block={{ kind: "text", markdown: card.answer }} />
            </div>
          )}
          {card.state === "done" ? (
            <div className="ch-btw-acts">
              <span className="ch-btw-keep">keep it:</span>
              <button
                type="button"
                className="ch-chip"
                onClick={() => {
                  btw.close();
                  onQuote(quoteBtw(card, chat.draft));
                }}
              >
                Quote into message
              </button>
              {btw.canBranch ? (
                <button
                  type="button"
                  className="ch-chip"
                  disabled={branching}
                  title={
                    working
                      ? "Opens a new session with this chat, question and answer. A turn is still running here, so both agents may act on the box at once."
                      : "Opens a new session with this chat, question and answer"
                  }
                  onClick={() => void branch()}
                >
                  {branching ? "Branching…" : "Continue as a branch ↗"}
                </button>
              ) : null}
              <button type="button" className="ch-chip" onClick={() => void copy()}>
                {copied === "copied"
                  ? "Copied"
                  : copied === "failed"
                    ? "Clipboard unavailable"
                    : "Copy"}
              </button>
            </div>
          ) : null}
          {card.state === "error" || (card.state === "pending" && card.from) ? (
            <div className="ch-btw-acts">
              {card.state === "error" ? (
                <button type="button" className="ch-chip" onClick={() => btw.retry()}>
                  Retry
                </button>
              ) : null}
              {card.from ? (
                <button
                  type="button"
                  className="ch-chip"
                  title="Cancel the side question and put the message back where it was"
                  onClick={backToQueue}
                >
                  ↩ Back to queue
                </button>
              ) : null}
            </div>
          ) : null}
          {branchError ? (
            <div className="ch-btw-err" role="alert">
              {branchError}
            </div>
          ) : null}
        </div>
        <div className="ch-btw-foot">
          {`${seen(card)} · `}
          <span className="ch-kbd">Esc</span> discard
        </div>
      </div>
    </div>
  );
}

/** "Side answer discarded: it is gone. [Undo] 8s", over a bar that drains for the 8 s. */
export function BtwUndoStrip({ btw, draft }: { btw: BtwControls; draft: string }) {
  if (!btw.undo) return null;
  return (
    <div className="ch-btw-undo" role="status">
      <i className="ch-btw-sq dim" aria-hidden="true" />
      <span>Side answer discarded: it is gone.</span>
      <button type="button" className="ch-chip" onClick={() => btw.restore(draft)}>
        Undo
      </button>
      <span className="ch-btw-undo-t">{`${btw.undo.left}s`}</span>
      {/* Keyed on the card, so a fresh discard restarts the drain. */}
      <i className="ch-btw-undo-bar" key={btw.undo.card.id} aria-hidden="true" />
    </div>
  );
}

/** Above the input while the draft is a `/btw` line: it is asked now, not queued. */
export function BtwCue() {
  return (
    <div className="ch-btw-cue" role="note">
      {TEMPORARY}
      <span>
        Side question: asked now, not queued. The answer is temporary and is not added to this
        conversation.
      </span>
    </div>
  );
}
