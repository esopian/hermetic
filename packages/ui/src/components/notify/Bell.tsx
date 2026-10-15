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
 *
 * An agent's open file request (attachments plan §8.6) counts as needing you,
 * whichever session raised it: it comes from the box's own slot list
 * (`file-requests-state.tsx`) rather than from a core row, so it is added here.
 */
import type { RefObject } from "react";
import { bellParts } from "../../logic/inbox-logic.ts";
import { useFileRequestsIfAvailable } from "../../state/file-requests-state.tsx";

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
  const files = useFileRequestsIfAvailable()?.all.length ?? 0;
  const unreadAll = unread + files;
  const needsAll = needsAction + files;
  const { tone, main, more } = bellParts(unreadAll, needsAll);
  const label =
    tone === "needs_action"
      ? `Notifications: ${needsAll} need you · ${unreadAll} unread`
      : tone === "unread"
        ? `Notifications: ${unreadAll} unread`
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
