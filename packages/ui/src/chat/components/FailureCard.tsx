/**
 * A failed turn's card, and what the operator can do about it.
 *
 * One renderer for every path a failure arrives by: the live `error` frame
 * (`applyFrame` sets `failure` on the turn, minting it when nothing came
 * first) and a failed row read back from history carry the same `ChatFailure`,
 * so the card draws the same thing before and after the re-read. A row from an
 * older build has only the `error` string; `failureOf` reads that into the same
 * shape. A turn that merely stopped (`incomplete`, no error) has no failure
 * and offers nothing to do but wait for the box's copy.
 *
 * The actions are `recoveryPlan`'s (`chat-recovery.ts`) and bind to the failed
 * turn's own prompt, found by this message's ids — never the latest thing the
 * operator said, and never a steer said into it. Only the conversation's
 * latest failure offers to send again (Retry, Compact, a new session), as
 * Desktop offers them only on the last message. Nothing here retries on its
 * own, and nothing collects a key.
 */
import { useEffect, useRef, useState } from "react";
import type { ChatFailureView, ChatMessageView } from "../../api/index.ts";
import { chatCompact, chatOpen } from "../../api/index.ts";
import { fmtClock } from "../../logic/format.ts";
import { useNavIfAvailable } from "../../nav/nav-state.tsx";
import { useChatGetter, useChatSelect } from "../chat-select.tsx";
import type { Chat } from "../chat-types.ts";
import { sameValue } from "../chat-message-identity.ts";
import { chatHash, isChatHash } from "../chat-routing.ts";
import {
  draftInto,
  failedTurnPrompt,
  failureDetails,
  failureView,
  isLatestFailure,
  recoveryPlan,
} from "../chat-recovery.ts";
import { RedactedText } from "./RedactedText.tsx";
import { renderProbe } from "../render-probe.ts";

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
const CODED = /^([A-Z][A-Z0-9_]{2,})(?:\s*[·:—-]\s*([\s\S]*))?$/;

export function splitError(error: string | null | undefined): {
  code: string | null;
  message: string | null;
} {
  if (!error) return { code: "INCOMPLETE", message: null };
  const m = CODED.exec(error.trim());
  if (!m) return { code: null, message: error };
  return { code: m[1] ?? null, message: m[2]?.trim() || null };
}

/** A message's failure: the structured one, else its `error` string read into that shape. */
export function failureOf(message: ChatMessageView): ChatFailureView | null {
  if (message.failure) return message.failure;
  if (!message.error) return null;
  const { code, message: said } = splitError(message.error);
  return { code: code ?? "UNKNOWN", message: said ?? "" };
}

export function FailureCard({
  failure,
  ids = [],
  at = new Date().toISOString(),
}: {
  /** `null` for a turn that stopped with no reason given. */
  failure: ChatFailureView | null;
  /** Every source id of the failed message, to find the prompt it answered. */
  ids?: readonly string[];
  /** When the turn failed, for the copied details. */
  at?: string;
}) {
  const copy = failureView(failure);
  return (
    <div className={`ch-card ${copy.tone} ch-failure`}>
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
        {failure ? <Recovery failure={failure} ids={ids} at={at} /> : null}
      </div>
    </div>
  );
}

/**
 * What the recovery buttons draw from the chat store, and nothing else: a
 * failure card sits in a settled message, and subscribing it to the whole chat
 * value re-rendered it on every clock tick and roster read (`chat-select.tsx`).
 * Compared structurally, so a re-derived but equal answer is no change.
 */
function recoveryView(chat: Chat | null, ids: readonly string[]) {
  if (!chat) return null;
  const all = chat.live ? [...chat.messages, chat.live] : chat.messages;
  return {
    target: chat.selection,
    // What Retry sends: the turn's prompt and the staged files that went with
    // it, as this browser remembered them when it sent; else read back.
    turn: failedTurnPrompt(all, ids, chat.turnPrompts),
    sending: chat.sending,
    // Sending again is the latest failure's to offer (`isLatestFailure`); an
    // older card keeps Edit, the links and Copy details.
    resend: isLatestFailure(all, ids),
  };
}

function Recovery({
  failure,
  ids,
  at,
}: {
  failure: ChatFailureView;
  ids: readonly string[];
  at: string;
}) {
  renderProbe.hit?.("FailureCard", ids.join(",") || at);
  const view = useChatSelect((chat) => recoveryView(chat, ids), sameValue);
  /** The chat as it is when a button is pressed; the handlers subscribe to nothing. */
  const getChat = useChatGetter();
  const nav = useNavIfAvailable();
  const root = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const plan = recoveryPlan(failure);
  // Retry waits for the provider's reset, then is simply enabled: one render
  // at that moment, never a send.
  const [, wake] = useState(0);
  useEffect(() => {
    if (plan.retryAt === null) return;
    const ms = plan.retryAt - Date.now();
    if (ms <= 0) return;
    // One past the reset, so the render it causes reads it as passed.
    const timer = setTimeout(() => wake((n) => n + 1), ms + 1);
    return () => clearTimeout(timer);
  }, [plan.retryAt]);
  const waiting = plan.retryAt !== null && plan.retryAt > Date.now() ? plan.retryAt : null;

  const target = view?.target ?? null;
  const turn = view?.turn ?? null;
  const prompt = turn?.text || null;
  const canResend = !!turn && (!!turn.text || turn.attachments.length > 0);
  const idle = !!view && !view.sending && !busy;
  const resend = !!view && view.resend;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setNote("");
    try {
      await work();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const retry = () => {
    if (turn && canResend) getChat()?.send(turn.text, turn.attachments);
  };
  const edit = () => {
    const chat = getChat();
    if (!chat || !turn) return;
    if (prompt) draftInto(chat.draft, chat.setDraft, prompt, root.current);
    // The files go back to the tray with the words, staged as they were.
    if (turn.attachments.length > 0) chat.attachments.restore(turn.attachments);
  };
  const compact = () =>
    void run(async () => {
      const chat = getChat();
      if (!chat || !target) return;
      await chatCompact({
        instance: target.instance,
        bot: target.bot,
        ...(chat.session ? { session: chat.session.id } : {}),
      });
      await chat.reloadHistory();
    });
  /**
   * Open a new session and send the failed prompt into it. The operator may
   * have moved on while the session was opening: then they are not pulled
   * back, and the prompt waits as the new session's draft. So it does if this
   * window cannot switch to it, or the store will not start the turn.
   */
  // A card no longer on screen is a conversation the operator has left.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const fresh = () =>
    void run(async () => {
      const chat = getChat();
      if (!chat || !target || !turn || !canResend) return;
      const text = turn.text;
      const files = turn.attachments;
      const from = JSON.stringify(target);
      const opened = await chatOpen({ instance: target.instance, bot: target.bot, new_session: true });
      const next = { instance: opened.instance, bot: opened.bot, session: opened.session };
      const now = getChat();
      if (!now) return;
      const park = (why: string) => {
        now.stageDraft(next, text);
        // A draft's files belong to the conversation that holds them, so the
        // failed one keeps them rather than losing them on the way.
        if (files.length > 0) chat.attachments.restore(files);
        const kept =
          files.length > 0 ? " Its attached files are back in this conversation's draft." : "";
        setNote(`Opened a new session${why}. The prompt is waiting in its draft.${kept}`);
      };
      if (!mounted.current || JSON.stringify(now.selection) !== from)
        return park(" while you were elsewhere");
      if (!now.select(next.instance, next.bot, next.session))
        return park(", but this window could not switch to it");
      if (isChatHash(window.location.hash)) window.location.hash = chatHash(next);
      if (!now.send(text, files)) park(", but the turn did not start");
    });
  const binding = () => {
    if (!nav || !target) return;
    nav.openAgent(target.instance);
    nav.setAgentTab("config");
  };
  const copyDetails = () =>
    void run(async () => {
      try {
        await navigator.clipboard.writeText(failureDetails(failure, at));
        setNote("Copied.");
      } catch {
        setNote("Could not copy — the details are the code and message above.");
      }
    });

  return (
    <div className="ch-failure-actions" ref={root}>
      {plan.retry && resend && waiting !== null ? (
        <p className="bm-note">{`Retry available at ${fmtClock(new Date(waiting).toISOString())}`}</p>
      ) : null}
      <div className="ch-prompts">
        {plan.retry && resend ? (
          <button
            className="btn btn-secondary"
            type="button"
            disabled={!idle || !canResend || waiting !== null}
            onClick={retry}
          >
            Retry
          </button>
        ) : null}
        {plan.editMessage && view ? (
          <button className="btn btn-secondary" type="button" disabled={!canResend} onClick={edit}>
            Edit message
          </button>
        ) : null}
        {plan.compact && resend ? (
          <button className="btn btn-secondary" type="button" disabled={!idle} onClick={compact}>
            Compact
          </button>
        ) : null}
        {plan.newSession && resend ? (
          <button
            className="btn btn-secondary"
            type="button"
            disabled={!idle || !canResend}
            onClick={fresh}
          >
            Start new session
          </button>
        ) : null}
        {(plan.chooseModel || plan.switchProvider) && nav && target ? (
          <button className="btn btn-secondary" type="button" onClick={binding}>
            {plan.chooseModel ? "Choose model" : "Switch provider"}
          </button>
        ) : null}
        {plan.updateApiKey && nav ? (
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => nav.openSettings("providers")}
          >
            Update API key
          </button>
        ) : null}
        <button className="btn btn-secondary" type="button" disabled={busy} onClick={copyDetails}>
          Copy details
        </button>
      </div>
      {plan.signInAgain ? (
        <p className="bm-note">
          <RedactedText text={`Sign in to ${plan.signInAgain} again on the box, then retry.`} />
        </p>
      ) : null}
      {target ? (
        <p className="bm-note">
          Box-side errors: <code>{`hermetic logs ${target.instance} --file errors`}</code>
        </p>
      ) : null}
      {note ? <p role="status">{note}</p> : null}
    </div>
  );
}
