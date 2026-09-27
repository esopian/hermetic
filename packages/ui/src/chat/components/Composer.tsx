/**
 * The composer, and the band above it.
 *
 * **The origin banner is a safety feature, not decoration.** Every session
 * carries where it came from, and the portal started almost none of them: a box
 * runs messaging channels, cron jobs, a dashboard and a CLI, Hermes Desktop can
 * attach to it, and other bots drive turns on it. So whenever the origin is
 * anything but `portal`, the composer restates the destination directly above
 * the input, and it cannot be dismissed.
 *
 * The reason is specific and it is not "for clarity". A reply into a `channel`
 * session leaves the tailnet and lands in somebody's Slack. A reply into a
 * `peer` session answers another robot. A reply into a `routine` session starts
 * a session the routine will never read. None of those is what the operator
 * assumed when they hit Enter in a box that looks like every other box, and
 * there is no other moment at which they could find out.
 *
 * `destinationNotice()` decides what it says; this decides where it goes. It is
 * rendered here — inside the composer, above the input — rather than up beside
 * the thread header, because it is a statement about what *sending* does, and a
 * banner at the top of a scrolled transcript is not on screen at the moment
 * that matters. Thread-level bands (stopped, reconnecting, destroyed) stay at
 * the top where the skeleton puts them; this one travels with the button.
 */
import { useChatIfAvailable } from "../chat-state.tsx";
import { useRef, useState } from "react";
import { insertMention, mentionAt, mentionHandle, mentionOptions } from "../chat-mentions.ts";
import type { MentionBot } from "../chat-mentions.ts";
import { destinationNotice, originClass, previewOf } from "../chat-logic.ts";
import { RedactedText } from "./RedactedText.tsx";
import type { Destination } from "../chat-logic.ts";

export function Composer({
  /**
   * Where a reply goes, and how sure the thread is — never a bare origin.
   * `portal` is the one value that silences the band, so it has to be a value
   * that was read rather than one that was fallen back to.
   */
  destination,
  placeholder,
  enabled,
  editable = enabled,
  sending,
  /** The tailnet name this thread is talking to, for the footer. */
  where,
  onSend,
  onAbort,
  mentions = [],
  mentionHint,
}: {
  destination: Destination;
  placeholder: string;
  enabled: boolean;
  /** Drafting can continue while destination evidence refreshes; sending cannot. */
  editable?: boolean;
  sending: boolean;
  where?: string | null;
  onSend: (text: string) => void;
  onAbort: () => void;
  mentions?: readonly MentionBot[];
  mentionHint?: string;
}) {
  const [localText, setLocalText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [choice, setChoice] = useState(0);
  const chat = useChatIfAvailable();
  const text = chat ? chat.draft : localText;
  const setText = chat ? chat.setDraft : setLocalText;
  const notice = destinationNotice(destination);
  const match = dismissed ? null : mentionAt(text, cursor);
  const options = match ? mentionOptions(mentions, match.query) : [];
  const choose = (bot: MentionBot) => {
    if (!match) return;
    const result = insertMention(text, match, mentionHandle(bot, mentions));
    setText(result.text);
    setCursor(result.cursor);
    setDismissed(true);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(result.cursor, result.cursor);
    });
  };

  /**
   * The queue exists only where the store does.
   *
   * A composer mounted without a provider — a demo shell, and any tree
   * that renders one for its own reasons — has nowhere to hold a queued
   * message, so it keeps the old rule and refuses to take one while a turn is
   * running. Nothing is silently swallowed either way.
   */
  const queued = chat?.queued ?? [];
  const parkedQueue = chat?.queueParked ?? false;
  const canQueue = chat !== null && sending && enabled;

  /**
   * Enter sends, or queues. §9.2 gives a conversation one active turn and says
   * sending waits — so a second message is *held*, not refused and not fired
   * at a busy session. It leaves the input either way: an operator who pressed
   * Enter is done with that text, and finding it still in the box is how the
   * same message gets sent twice.
   */
  const submit = () => {
    const body = text.trim();
    if (!enabled || body.length === 0) return;
    if (sending) {
      if (!chat) return;
      setText("");
      chat.queueMessage(body);
      return;
    }
    setText("");
    onSend(body);
  };

  return (
    <div className="ch-composer">
      {notice ? (
        // Undismissible by construction: there is no control here to dismiss it
        // with, and it is re-derived from the session on every render.
        <div className={`ch-band ${notice.tone}`} role="note">
          <i className="dot" />
          <span>{notice.headline}</span>
          <span className="sub">{notice.detail}</span>
          <span className="spacer" />
          <span className={`ch-origin ${originClass(destination)}`}>
            <i />
            {notice.badge}
          </span>
        </div>
      ) : null}

      {queued.length > 0 ? (
        // Above the input, in order, drained from the top. Each row is the
        // operator's own words, so it goes through `RedactedText` like every
        // other piece of prose in the thread.
        <ul className="ch-queue" aria-label="Queued messages">
          {queued.map((row) => (
            <li className="ch-queue-row" key={row.id}>
              <span className="ch-queue-dot" aria-hidden="true" />
              <span className="ch-queue-text">
                <RedactedText text={previewOf(row.text) ?? row.text} />
              </span>
              <button
                type="button"
                className="ch-queue-drop"
                title="Remove from the queue"
                aria-label="Remove queued message"
                onClick={() => chat?.unqueue(row.id)}
              >
                {"\u2715"}
              </button>
            </li>
          ))}
          <li className="ch-queue-foot">
            {queued.length} queued ·{" "}
            {parkedQueue ? "paused — send a message to resume" : "sends when the agent is free"}
          </li>
        </ul>
      ) : null}

      <div className="ch-input-wrap bm-input-wrap">
        {options.length > 0 ? (
          <div className="bm-mentions" role="listbox" aria-label="Mention a bot">
            {options.map((bot, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === choice}
                key={`${bot.instance}/${bot.name}`}
                onClick={() => choose(bot)}
              >
                <b>{bot.title}</b>
                <span className="mono">
                  {mentionHandle(bot, mentions)} · {bot.instance}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={input}
          className="ch-input"
          aria-label={placeholder}
          aria-autocomplete={mentions.length ? "list" : undefined}
          rows={1}
          disabled={!editable}
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCursor(e.target.selectionStart);
            setDismissed(false);
            setChoice(0);
          }}
          onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (e.defaultPrevented || e.nativeEvent.isComposing) return;
            if (
              options.length > 0 &&
              ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)
            ) {
              e.preventDefault();
              if (e.key === "Escape") setDismissed(true);
              else if (e.key === "ArrowDown") setChoice((index) => (index + 1) % options.length);
              else if (e.key === "ArrowUp")
                setChoice((index) => (index + options.length - 1) % options.length);
              else choose(options[choice % options.length]!);
              return;
            }
            // Enter sends, Shift+Enter is a newline, and ⌘Enter is a third
            // spelling of the first.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
              return;
            }
            // Esc stops the turn. `preventDefault` is load-bearing rather than
            // tidy: the app shell has a window-level Escape handler that closes
            // whichever full-page view is up, and it checks `defaultPrevented`
            // first — so without this, stopping a turn would also leave the
            // chat view.
            if (e.key === "Escape" && sending) {
              e.preventDefault();
              onAbort();
            }
          }}
        />
        <button
          type="button"
          className={text.trim() && enabled ? "ch-send ready" : "ch-send"}
          disabled={!enabled || text.trim().length === 0 || (sending && !chat)}
          title={canQueue ? "Queue (⌘↵ or Enter)" : "Send (⌘↵ or Enter)"}
          onClick={submit}
        >
          ↵
        </button>
      </div>

      {mentionHint ? <div className="bm-mention-hint">{mentionHint}</div> : null}
      <div className="ch-composer-foot">
        <span>
          <span className="ch-kbd">Enter</span> send · <span className="ch-kbd">⇧ Enter</span> newline ·{" "}
          <span className="ch-kbd">Esc</span> stop
          {canQueue ? " · Enter queues while the agent works" : ""}
        </span>
        <span className="right">
          {sending ? "turn in flight" : where ? `over the tailnet · ${where}` : ""}
        </span>
      </div>
    </div>
  );
}
