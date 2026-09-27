/**
 * `.ch-card` — the one shape every block in the transcript is drawn in.
 *
 * The design has thirty-two examples of it and one rule underneath them all:
 * the *default state* of a card is a function of its verdict, not of its type.
 * `ok`/`warn`/`bad`/`acc`/`muted` start collapsed; `unknown` and anything that
 * failed start open. That rule lives in `chat-logic.ts`; this component is what
 * obeys it, once, so no renderer gets to have its own opinion about it.
 *
 * A collapsed card does not render its body at all, rather than hiding it with
 * CSS the way an earlier static prototype did. Two reasons: a transcript can
 * hold a megabyte of tool output and none of it is worth laying out to hide,
 * and a test asserting "a green exit code starts collapsed" should be able to
 * say so by not finding the output. The `.collapsed` class is still on the
 * card, so whatever rules the stylesheet has for one still apply.
 */
import { RedactedText } from "./RedactedText.tsx";
import { useState } from "react";
import type { ReactNode } from "react";
import { startsCollapsed } from "../chat-logic.ts";
import type { CardVerdict } from "../chat-logic.ts";

export function Card({
  verdict,
  failed = false,
  /** The head's left label: the tool's name, `Reasoning`, `agent`, `plan · destroy`. */
  head,
  /** The monospaced middle — a command, a path, a query. Optional by design. */
  subject,
  /** The head's right label: `exit 0 · 0.4s`, `4 results`, `live · updated 3s ago`. */
  right,
  /** A card with nothing to hide (a table, an image) is never collapsible. */
  collapsible = true,
  children,
}: {
  verdict: CardVerdict;
  failed?: boolean;
  head: ReactNode;
  subject?: ReactNode;
  right?: ReactNode;
  collapsible?: boolean;
  children?: ReactNode;
}) {
  /**
   * The operator's own answer, or `null` while they have not given one.
   *
   * The collapse rule is a function of the *current* verdict, not of the
   * verdict this card happened to mount with — and a card mounts with the wrong
   * one routinely. A tool arrives `running`, which is unsettled and therefore
   * open; it then settles `ok`, and "a green exit code was never news" has to
   * apply to that transition too, not only to the same card read back out of
   * history later. Computing it once at mount left every streamed tool call
   * sitting open with its output on screen.
   *
   * An operator who has opened or shut this card keeps their answer, because
   * having clicked is the one thing more specific than the rule.
   */
  const [choice, setChoice] = useState<boolean | null>(null);
  const collapsed = choice ?? (collapsible && startsCollapsed(verdict, failed));
  const open = !collapsible || !collapsed;
  const setCollapsed = (next: (v: boolean) => boolean) => setChoice(next(collapsed));

  const inner = (
    <>
      {collapsible ? <span data-caret>{open ? "▾" : "▸"}</span> : null}
      <span>{head}</span>
      {subject ? (
        <code className="mono" data-subject>
          {typeof subject === "string" ? <RedactedText text={subject} /> : subject}
        </code>
      ) : null}
      {right !== undefined ? <span className="right">{right}</span> : null}
    </>
  );

  return (
    <div className={`ch-card ${verdict}${open ? "" : " collapsed"}`}>
      {collapsible ? (
        <button
          type="button"
          className="ch-card-head clickable"
          aria-expanded={open}
          onClick={() => setCollapsed((v) => !v)}
        >
          {inner}
        </button>
      ) : (
        <div className="ch-card-head">{inner}</div>
      )}
      {open ? children : null}
    </div>
  );
}

/** The card's body. `tight` is the modifier for a pane that sets its own padding. */
export function CardBody({
  tight = false,
  children,
  ...rest
}: {
  tight?: boolean;
  children?: ReactNode;
} & { style?: React.CSSProperties }) {
  return (
    <div className={tight ? "ch-card-body tight" : "ch-card-body"} {...rest}>
      {children}
    </div>
  );
}

/** A preformatted pane: tool output, a payload, a code fence. */
export function CodePane({ text, tight = true }: { text: string; tight?: boolean }) {
  return (
    <pre className={tight ? "ch-code ch-card-body tight" : "ch-code ch-card-body"}>
      <RedactedText text={text} />
    </pre>
  );
}
