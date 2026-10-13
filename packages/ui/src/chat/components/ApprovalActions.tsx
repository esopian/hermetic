/**
 * The approval card's answers (`chat.respond kind:"approval"`, §9.2).
 *
 * The buttons are exactly `block.choices`, in the gateway's order. That is the
 * only guard there is: upstream grants any non-`deny` choice it is sent,
 * offered or not (D27), so a choice the gateway did not offer — `session` on a
 * smart-denied command, `always` where permanent approval is off — must never
 * be drawn. "Always allow" persists a pattern on the box, so it takes a second
 * step inside the card naming the pattern and the command; the chat has no
 * modal idiom, and the step is part of the card the operator is reading.
 *
 * Settled, the card keeps its head and command and says what happened; a
 * request the box let go of says the command was not run.
 */
import { useContext, useEffect, useId, useRef, useState } from "react";
import type { ChatBlockOf } from "../../api/index.ts";
import type { ClosedRequest } from "../chat-requests.ts";
import { BotResponses, Failure, GONE, SENT, useSubmit } from "./BotResponses.tsx";
import { RedactedText } from "./RedactedText.tsx";

type Choice = "once" | "session" | "always" | "deny";

/** The button for each answer; the room's approval card uses the same words. */
export const APPROVAL_LABEL: Record<Choice, string> = {
  once: "Approve once",
  session: "This session",
  always: "Always allow",
  deny: "Deny",
};

/** The settled line for each answer the box took. */
export const APPROVAL_OUTCOME: Record<Choice, string> = {
  once: "Approved once",
  session: "Allowed this session",
  always: "Always allowed",
  deny: "Denied",
};

export const EXPIRED = "Request expired.";

const KNOWN = new Set<string>(["once", "session", "always", "deny"]);

/**
 * The choices to draw. A block stored before core filled `choices` reads back
 * as the narrowest set (the schema's default); unknown values are dropped.
 */
function offered(block: ChatBlockOf<"approval">): Choice[] {
  const raw: readonly string[] = Array.isArray(block.choices) ? block.choices : [];
  const known = [...new Set(raw.filter((c): c is Choice => KNOWN.has(c)))];
  return known.length > 0 ? known : ["once", "deny"];
}

export function RequestActions({
  block,
  closed,
  pending = 0,
  now = Date.now(),
}: {
  block: ChatBlockOf<"approval">;
  /** How the box closed this request, when it did (`closedRequests`). */
  closed?: ClosedRequest;
  /** Open approvals in this turn, this one included; labelled when more than one. */
  pending?: number;
  now?: number;
}) {
  const respond = useContext(BotResponses);
  const { state, busy, submit, settled } = useSubmit(respond);
  const [chosen, setChosen] = useState<Choice | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [lapsed, setLapsed] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const title = useId();
  useEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);
  /**
   * Where focus goes once the control holding it is gone, so it does not fall
   * to the page: back to "Always allow" when the step closes; to the card's
   * own line once the answer settles or the step finds the request lapsed; back
   * to "Always allow" when a confirmed answer failed. Never taken from
   * elsewhere — only while focus is on the page itself or still in this card.
   */
  const trigger = useRef<HTMLButtonElement>(null);
  const landing = useRef<HTMLParagraphElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const back = useRef(false);
  useEffect(() => {
    if (!back.current) return;
    back.current = false;
    trigger.current?.focus({ preventScroll: true });
  });
  const failed = !!state && !settled;
  useEffect(() => {
    if (!settled && !lapsed && !failed) return;
    const active = document.activeElement;
    const card = (landing.current ?? root.current)?.closest(".ch-approve") ?? null;
    const dropped = !active || active === document.body;
    if (settled || lapsed) {
      if (dropped || (card?.contains(active) ?? false)) landing.current?.focus({ preventScroll: true });
    } else if (dropped) trigger.current?.focus({ preventScroll: true });
  }, [settled, lapsed, failed]);
  const close = () => {
    back.current = true;
    setConfirming(false);
  };

  if (closed && (closed.kind === "timeout" || closed.kind === "cancelled"))
    return (
      <p className="bm-approval-outcome bad" role="status">
        {closed.kind === "timeout"
          ? "Approval timed out — the command was not run"
          : "Approval cancelled — the command was not run"}
      </p>
    );
  if (!respond || !block.request_id)
    return (
      <p className="bm-note">Respond in Hermes. This conversation is waiting for your approval.</p>
    );
  const request_id = block.request_id;
  if (settled)
    return (
      <p className="bm-approval-outcome" role="status" ref={landing} tabIndex={-1}>
        {state === SENT && chosen ? APPROVAL_OUTCOME[chosen] : GONE}
      </p>
    );
  const expired = lapsed || (!!block.expires_at && Date.parse(block.expires_at) < now);
  const answer = (choice: Choice) => {
    setChosen(choice);
    void submit({ request_id, kind: "approval", choice });
  };
  /**
   * The second step's submit. The card may have sat open past the request's
   * life, or the box may have closed it meanwhile: either way nothing is sent.
   */
  const always = () => {
    const gone = !!block.expires_at && Date.parse(block.expires_at) < Date.now();
    if (gone || closed) {
      setConfirming(false);
      setLapsed(true);
      return;
    }
    setConfirming(false);
    answer("always");
  };
  return (
    <div className="bm-request-actions" ref={root}>
      {pending > 1 ? <p className="bm-approval-pending">{`${pending} approvals pending`}</p> : null}
      {expired ? (
        <p ref={landing} tabIndex={-1}>
          {EXPIRED}
        </p>
      ) : confirming ? (
        // The step owns Escape: back to the buttons, and the key goes no
        // further — it must not stop the turn or close the view. The shell's
        // capture-phase handlers see `data-owns-escape` and stand aside.
        <div
          className="bm-approval-confirm"
          role="group"
          aria-labelledby={title}
          data-owns-escape=""
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            close();
          }}
        >
          <p id={title}>
            <b>Always allow this command?</b>
          </p>
          <p className="bm-note">
            Hermes stops asking for commands that match this pattern. It is saved in
            ~/.hermes/config.yaml on the box.
          </p>
          {block.pattern ? (
            <p className="mono">
              <RedactedText text={block.pattern} />
            </p>
          ) : null}
          <pre className="ch-code">
            <RedactedText text={block.summary} />
          </pre>
          <div className="ch-prompts">
            <button ref={cancel} className="btn btn-secondary" type="button" onClick={close}>
              Cancel
            </button>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={always}>
              Always allow
            </button>
          </div>
        </div>
      ) : (
        <div className="ch-prompts">
          {offered(block).map((choice) => (
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              key={choice}
              ref={choice === "always" ? trigger : undefined}
              onClick={() => (choice === "always" ? setConfirming(true) : answer(choice))}
            >
              {APPROVAL_LABEL[choice]}
            </button>
          ))}
        </div>
      )}
      <Failure state={state} />
    </div>
  );
}
