/**
 * The header bell and its count chip.
 *
 * The chip has exactly two colours and they never mix (the gold-outranks-orange
 * rule): orange for unread, gold for "something is blocked on you", gold
 * winning whenever both are true. That is the whole reason `badgeTone` is a
 * pure function rather than a ternary here — a quiet bell is a claim, and the
 * claim has a test.
 *
 * When something needs you, the gold count is followed by a dim `+N` for the
 * other unread rows (`bellParts`): the same inbox, said quieter, not a second
 * colour.
 */
import type { RefObject } from "react";
import { bellParts } from "../../logic/inbox-logic.ts";

export function Bell({
  unread,
  needsAction,
  open,
  onToggle,
  triggerRef,
}: {
  unread: number;
  needsAction: number;
  open: boolean;
  onToggle: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { tone, main, more } = bellParts(unread, needsAction);
  const label =
    tone === "needs_action"
      ? `Notifications: ${needsAction} need you · ${unread} unread`
      : tone === "unread"
        ? `Notifications: ${unread} unread`
        : "Notifications";

  return (
    <button
      type="button"
      ref={triggerRef}
      className="nt-bell"
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      data-tone={tone}
      onClick={onToggle}
    >
      <span aria-hidden="true">◔</span>
      {tone === "quiet" ? null : (
        <span className={tone === "needs_action" ? "count needs-action" : "count"}>{main}</span>
      )}
      {more > 0 ? <span className="count sub">+{more}</span> : null}
    </button>
  );
}
