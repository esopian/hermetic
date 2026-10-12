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
import { useContext, useRef, useState } from "react";
import { botCandidate } from "../chat-mentions.ts";
import type { MentionBot } from "../chat-mentions.ts";
import { useFleetIfAvailable } from "../../state/state.tsx";
import { MentionList, useMentionPicker } from "./MentionPicker.tsx";
import { composerHint, destinationNotice, originClass, sendLabel } from "../chat-logic.ts";
import { RedactedText } from "./RedactedText.tsx";
import { BotResponses } from "./BotResponses.tsx";
import { useFocusOnReturn } from "../../lib/focus.ts";
import { expiryOf } from "../chat-requests.ts";
import { useWakeAt } from "../use-wake-at.ts";
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
  // Switching back to the app lands the caret here, so a paste goes in.
  useFocusOnReturn(input, editable);
  const chat = useChatIfAvailable();
  const fleetId = useFleetIfAvailable()?.meta?.config?.fleet_id ?? "";
  const text = chat ? chat.draft : localText;
  const setText = chat ? chat.setDraft : setLocalText;
  const notice = destinationNotice(destination);
  const label = sendLabel(destination);
  const hint = composerHint(destination);
  const picks = destination.state === "unchosen" && onChoose ? choices : [];
  /**
   * Teammates on this instance, as Hermes Desktop offers them. The caller
   * already leaves out the bot this thread talks to; Hermes resolves the tag.
   */
  const picker = useMentionPicker({
    text,
    setText,
    input,
    candidates: mentions.map(botCandidate),
  });

  /**
   * The queue exists only where the store does.
   *
   * A composer mounted without a provider — a demo shell, and any tree
   * that renders one for its own reasons — has nowhere to hold a queued
   * message, so it keeps the old rule and refuses to take one while a turn is
   * running. Nothing is silently swallowed either way.
   */
  const queued = chat?.queued ?? [];
  const respond = useContext(BotResponses);
  /** The store and the send callback as of the latest render, for code resuming after an await. */
  const latest = useRef({ chat, onSend });
  latest.current = { chat, onSend };

  /**
   * Run `then` once any clarify the reply is waiting on has been skipped.
   *
   * Hermes Desktop's rule, by action (D4a): steering into the agent while it
   * waits on a question declines the question first — the turn is parked
   * inside the clarify tool, and a steer would wait behind that tool for as
   * long as the question stays open. Queueing does not: a queued message is
   * "after the current work", and the question is part of that work, so the
   * text waits in the queue and the card stays answerable. So ⌘Enter and a
   * queued row's send-now come through here; Enter while the agent works does
   * not, and neither does a send with nothing running (no turn is parked on
   * anything then). The question may sit in the live message
   * or in a part of the reply an earlier steer closed off (`openRequest`).
   *
   * The card closes only once the box has acknowledged the skip: `ok` and
   * `expired` both mean the request is gone. A failed call leaves the card as
   * it was, still answerable, and the message goes out as it would have.
   *
   * The message belongs to the conversation it was typed in. If the operator
   * has moved to another one by the time the skip returns, nothing is sent:
   * the text goes back into the first conversation's draft instead.
   */
  const afterOpenQuestion = (then: () => void, text: string | null) => {
    // Only a running turn is parked on a question; with none, a card still
    // drawn as open is stale and is left alone.
    const request_id = respond && chat?.sending ? chat.openRequest() : null;
    const target = chat?.selection ?? null;
    if (!respond || !chat || !request_id || !target) {
      then();
      return;
    }
    const proceed = () => {
      const now = latest.current.chat?.selection ?? null;
      const same =
        now !== null &&
        now.instance === target.instance &&
        now.bot === target.bot &&
        now.session === target.session;
      if (same) then();
      else if (text !== null) latest.current.chat?.stageDraft(target, text);
    };
    // Through `then` so a provider that throws rather than rejects lands in
    // the same place as one that rejects.
    Promise.resolve()
      .then(() => respond({ request_id, kind: "question", skip: true }))
      .then(() => {
        latest.current.chat?.settleRequest(request_id, "skipped", target);
        proceed();
      }, proceed);
  };
  const parkedQueue = chat?.queueParked ?? false;
  const canQueue = chat !== null && sending && enabled;
  // Read each render: the open clarify moves with the frames that re-render
  // this, and a render at its expiry takes the hint down with no frame at all.
  const asking = canQueue && respond && chat ? chat.openRequest() : null;
  useWakeAt(
    asking && chat ? expiryOf([...chat.messages, ...(chat.live ? [chat.live] : [])], asking) : null,
  );

  /**
   * Enter sends, or queues. §9.2 gives a conversation one active turn and says
   * sending waits — so a second message is *held*, not refused and not fired
   * at a busy session. A held message leaves any open question alone: it is
   * the operator's to answer or to skip (⌘Enter), not the queue's (D4a). It
   * leaves the input either way: an operator who pressed Enter is done with
   * that text, and finding it still in the box is how the same message gets
   * sent twice.
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
    // Nothing is running, so nothing is parked on a question: a card still
    // drawn as open is stale, and a plain send leaves it alone.
    setText("");
    onSend(body);
  };

  /**
   * ⌘Enter while the agent works: the message goes now rather than after the
   * turn — steered into it, or forced through by stopping it (`chat-queue.ts`).
   * Idle, it is the same as Enter.
   */
  const submitNow = () => {
    const body = text.trim();
    if (!canQueue || !chat || body.length === 0) {
      submit();
      return;
    }
    setText("");
    afterOpenQuestion(() => latest.current.chat?.sendNow(body), body);
  };

  /**
   * A queued row back into the input, to be reworded and sent again. Ahead of
   * anything already typed there, so nothing the operator wrote is lost.
   */
  const editQueued = (id: string, queuedText: string) => {
    if (!chat) return;
    chat.unqueue(id);
    const next = text.trim() ? `${queuedText}\n\n${text}` : queuedText;
    setText(next);
    const el = input.current;
    if (el) {
      el.focus({ preventScroll: true });
      setTimeout(() => el.setSelectionRange?.(next.length, next.length), 0);
    }
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

      <div className="ch-input-wrap bm-input-wrap">
        <MentionList picker={picker} fleetId={fleetId} label="Mention a bot" />
        {queued.length > 0 ? (
          // Above the input and joined to it, in order, drained from the top —
          // the shape Conductor uses. Each row is the operator's own words, so it
          // goes through `RedactedText` like every other piece of prose in the
          // thread.
          <section className="ch-queue" aria-label="Queued messages">
            <header className="ch-queue-head">
              <span className="ch-queue-title">Queued</span>
              <span className="ch-queue-status">
                {parkedQueue
                  ? "paused · ↑ sends one now, or send a message to resume"
                  : "sends when the agent is free"}
              </span>
            </header>
            <ul>
              {queued.map((row) => (
                <li className="ch-queue-row" key={row.id}>
                  <span className="ch-queue-text">
                    {/* One line, cut by the row's width rather than at a character count. */}
                    <RedactedText text={row.text.replace(/\s*\n+\s*/g, " ")} />
                  </span>
                  <button
                    type="button"
                    className="ch-queue-act"
                    title="Edit — back into the input"
                    aria-label="Edit queued message"
                    onClick={() => editQueued(row.id, row.text)}
                  >
                    <Icon d={["M16 3l5 5L8 21H3v-5z", "M13 6l5 5"]} />
                  </button>
                  <button
                    type="button"
                    className="ch-queue-act"
                    title="Remove from the queue"
                    aria-label="Remove queued message"
                    onClick={() => chat?.unqueue(row.id)}
                  >
                    <Icon d={["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"]} />
                  </button>
                  <button
                    type="button"
                    className="ch-queue-act"
                    title={sending ? "Send now, into the running turn" : "Send now"}
                    aria-label="Send queued message now"
                    // A queued row stays in its own conversation's queue if the
                    // selection moves, so there is nothing to stage.
                    onClick={() =>
                      afterOpenQuestion(() => latest.current.chat?.sendQueuedNow(row.id), null)
                    }
                  >
                    <Icon d={["M12 19V5", "M6 11l6-6 6 6"]} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <textarea
          ref={input}
          className="ch-input"
          aria-label={placeholder}
          {...picker.inputProps}
          rows={1}
          disabled={!editable}
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            picker.track(e.target);
          }}
          onSelect={(e) => picker.track(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.defaultPrevented || e.nativeEvent.isComposing) return;
            if (picker.onKeyDown(e)) return;
            // Enter sends — or queues, while the agent works — and Shift+Enter
            // is a newline. ⌘Enter (Ctrl+Enter) sends now: the same as Enter
            // when idle, past the queue when not.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (e.metaKey || e.ctrlKey) submitNow();
              else submit();
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
          title={canQueue ? "Queue (Enter)" : "Send (Enter or ⌘↵)"}
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
      {asking !== null ? (
        <div className="ch-composer-question" role="note">
          A question is waiting — <span className="ch-kbd">Enter</span> queues until it is answered ·{" "}
          <span className="ch-kbd">⌘Enter</span> skips it and steers
        </div>
      ) : null}
      <div className="ch-composer-foot">
        <span>
          <span className="ch-kbd">Enter</span> send · <span className="ch-kbd">⇧ Enter</span> newline ·{" "}
          <span className="ch-kbd">Esc</span> stop
          {canQueue ? (
            <>
              {" · Enter queues while the agent works · "}
              <span className="ch-kbd">⌘ Enter</span> sends now
            </>
          ) : null}
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

/** A 14px stroked glyph, drawn like the rest of the chat's inline icons. */
function Icon({ d }: { d: string[] }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      {d.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
