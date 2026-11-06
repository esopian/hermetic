/**
 * The header bell and its dot.
 *
 * A dot, never a count: the operator needs to know that something is waiting,
 * not how much. It has exactly two colours and they never mix (the
 * gold-outranks-orange rule): orange for unread, gold for "something is blocked
 * on you", gold winning whenever both are true (`bellTone`).
 *
 * An agent's open file request (attachments plan §8.6) counts as needing you,
 * whichever session raised it: it comes from the box's own slot list
 * (`file-requests-state.tsx`) rather than from a core row, so it is added here.
 */
import type { RefObject } from "react";
import { bellTone } from "../../logic/inbox-logic.ts";
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
  const tone = bellTone(unread + files, needsAction + files);
  const label =
    tone === "needs_action"
      ? "Notifications: something needs you"
      : tone === "unread"
        ? "Notifications: unread"
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
        <span className={tone === "needs_action" ? "count dot needs-action" : "count dot"} />
      )}
    </button>
  );
}
