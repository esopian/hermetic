/**
 * The composer, and what it says about where a reply goes.
 *
 * Every session carries where it came from, and the portal started few of
 * them. The composer restates the destination only where sending has a
 * consequence or cannot happen yet. A consequence goes on the send button and
 * the footer (`sendLabel`, `composerHint` in `chat-logic.ts`): a `routine`
 * reply starts a new session ("Send · new session"), a `peer` reply answers a
 * robot ("Reply to …"), a `channel` reply leaves the tailnet ("Send to …"), all
 * in warn — the button is the one thing certainly in view when Enter is
 * pressed. A `desktop` or `room` reply gets only a muted footer fragment. A
 * composer that is blocked — the session read in flight, a bot whose
 * conversations are none of them this portal's, a read that failed — gets a
 * slim one-line band explaining the dead button, and for `unchosen` one chip
 * per conversation to pick from. `portal`, `hermetic` and `cli` say nothing:
 * the last two mean only that this laptop holds no record of sending into the
 * session, which is too often this operator's own conversation to be worth a
 * warning, and the header's origin badge still names them. Thread-level bands
 * (stopped, reconnecting, destroyed) stay at the top of the thread.
 */
import { useChatIfAvailable } from "../chat-state.tsx";
import { useRef, useState } from "react";
import { insertMention, mentionAt, mentionHandle, mentionOptions } from "../chat-mentions.ts";
import type { MentionBot } from "../chat-mentions.ts";
import { composerHint, destinationNotice, originClass, previewOf, sendLabel } from "../chat-logic.ts";
import { RedactedText } from "./RedactedText.tsx";
import type { Destination } from "../chat-logic.ts";

/** A conversation the `unchosen` band offers as a chip. */
export interface ComposerChoice {
  id: string;
  title: string;
  origin: string;
  origin_detail?: string | null;
}

export function Composer({
  /**
   * Where a reply goes, and how sure the thread is — never a bare origin.
   * `portal` must be a value that was read rather than one that was fallen
   * back to: the not-yet-known states are what disable sending.
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
  choices = [],
  onChoose,
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
  /** The bot's conversations, drawn as chips when the destination is `unchosen`. */
  choices?: readonly ComposerChoice[];
  /** Select a conversation, as the rail's Sessions tab does. */
  onChoose?: (session: string) => void;
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
  const label = sendLabel(destination);
  const hint = composerHint(destination);
  const picks = destination.state === "unchosen" && onChoose ? choices : [];
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
        <div className={`ch-band slim ${notice.tone}`} role="note" title={notice.title}>
          <span>
            {destination.state === "unchosen" && picks.length === 0
              ? "Pick a conversation in the rail to reply into."
              : notice.headline}
          </span>
          {picks.map((pick) => {
            const where = pick.origin_detail?.trim() || pick.origin;
            // The warn tint marks "leaves the tailnet", which only `channel`
            // does; `routine` and `peer` stay on this fleet's own boxes.
            return (
              <button
                type="button"
                key={pick.id}
                className={`ch-pick ${pick.origin}${pick.origin === "channel" ? " warn" : ""}`}
                onClick={() => onChoose?.(pick.id)}
              >
                <i aria-hidden="true" />
                {`${pick.title} · ${where}`}
                {pick.origin === "channel" ? <span className="m"> · leaves tailnet</span> : null}
              </button>
            );
          })}
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
          className={[
            "ch-send",
            label ? `label ${label.tone}` : "",
            text.trim() && enabled ? "ready" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          disabled={!enabled || text.trim().length === 0 || (sending && !chat)}
          title={canQueue ? "Queue (⌘↵ or Enter)" : "Send (⌘↵ or Enter)"}
          onClick={submit}
        >
          {label ? (
            <>
              {label.label} <span className="k">↵</span>
            </>
          ) : (
            "↵"
          )}
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
          {hint ? (
            <span className={`ch-composer-hint ${hint.tone}`}>
              {sending || where ? ` · ${hint.text}` : hint.text}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}
