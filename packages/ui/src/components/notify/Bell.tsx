/**
 * The header bell and its count chip.
 *
 * The chip has exactly two colours and they never mix (the gold-outranks-orange
 * rule): orange for unread, gold for "something is blocked on you", gold
 * winning whenever both are true. That is the whole reason `badgeTone` is a
 * pure function rather than a ternary here — a quiet bell is a claim, and the
 * claim has a test.
 */
import type { RefObject } from "react";
import { badgeTone } from "../../logic/notification-logic.ts";

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
  const tone = badgeTone(unread, needsAction);
  const count = tone === "needs_action" ? needsAction : unread;
  const label =
    tone === "needs_action"
      ? `Notifications: ${needsAction} need you`
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
        <span className={tone === "needs_action" ? "count needs-action" : "count"}>{count}</span>
      )}
    </button>
  );
}
