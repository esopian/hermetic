/**
 * Reading a conversation marks its messages read.
 *
 * The inbox row and the transcript are two records of the same event, and until
 * now only one of them could be cleared: an operator who sat watching a bot
 * answer still had a bell counting the answers they had just read, and the only
 * way down was the notification centre. Hermes Desktop clears a chat's unread
 * on view and this is the same rule, stated as three conditions that all have
 * to hold at once.
 *
 * **Visible** — `document.visibilityState`, not "the tab exists". A transcript
 * in a background tab is not being read, and a message that arrives there has
 * to survive until somebody looks.
 *
 * **Mounted and at the bottom** — the thread is on screen *and* the reader is
 * at the live end of it. Somebody scrolled up into last week's turns is reading
 * that, not the message that just landed, and clearing it would take away the
 * only pointer they have back to it. `AT_BOTTOM_SLACK_PX` of slack because
 * `scrollHeight - scrollTop - clientHeight` is rarely exactly zero: fractional
 * device pixels, a sub-pixel row height and a smooth scroll that stopped one
 * pixel short all land near the bottom without being on it.
 *
 * **Unread rows for this conversation** — read off the inbox itself rather than
 * from anything the thread counts on its own, so the thing cleared is the thing
 * that was drawn.
 *
 * A turn in flight is deliberately *not* a reason to hold off: a streaming
 * answer is the case where the operator is most certainly looking at it.
 *
 * The debounce is what keeps a burst of arrivals one write rather than five,
 * and `acked` is what keeps a row from being acked twice while the optimistic
 * update is still in the air — the inbox is refreshed asynchronously, so a
 * second render can still carry a row the first pass already sent.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { chatThreadOf, isResolved } from "../logic/notification-logic.ts";
import { isVisible, onReturnVisible } from "../lib/visibility.ts";

/** How far off the bottom still counts as the bottom. */
export const AT_BOTTOM_SLACK_PX = 40;

/** How long a new row waits before it is acked, so a burst is one write. */
export const VIEW_ACK_DEBOUNCE_MS = 300;

/** A notification row, structurally — the fields this rule reads and no more. */
export interface AckableRow {
  id: string;
  kind: string;
  ref?: string | null;
  read_at?: string | null;
  muted?: boolean | null;
  resolved_at?: string | null;
}

/** Is this scroller at its live end? */
export function isAtBottom(node: HTMLElement, slack = AT_BOTTOM_SLACK_PX): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= slack;
}

/**
 * The unread `chat.message` rows belonging to one `<instance>/<bot>`, in the
 * order the inbox holds them.
 *
 * Only `chat.message`. A `chat.error` row is a *condition* (§9.2) rather than
 * news, and looking at the conversation it failed in is not evidence that
 * anybody dealt with it.
 */
export function unreadChatRowIds(
  items: readonly AckableRow[],
  instance: string,
  bot: string,
): string[] {
  const ids: string[] = [];
  for (const row of items) {
    if (row.kind !== "chat.message") continue;
    if (row.read_at || row.muted || isResolved(row)) continue;
    const thread = chatThreadOf(row);
    if (thread === null) continue;
    if (thread.instance !== instance || thread.bot !== bot) continue;
    ids.push(row.id);
  }
  return ids;
}

/**
 * Acks this conversation's unread rows while it is being looked at.
 *
 * `scroller` is the transcript's own scrolling element; the hook does not own
 * it, because the thread already has a ref on it for autoscroll and two refs on
 * one node is how they get out of step.
 */
export function useViewAck({
  scroller,
  instance,
  bot,
  items,
  ackMany,
  active = true,
  debounceMs = VIEW_ACK_DEBOUNCE_MS,
}: {
  scroller: RefObject<HTMLElement | null>;
  instance: string;
  bot: string;
  items: readonly AckableRow[] | null | undefined;
  ackMany: ((ids: readonly string[]) => void | Promise<void>) | null | undefined;
  /** False where there is no inbox to clear, or no conversation on screen. */
  active?: boolean;
  /** Test seam; production callers use the burst-coalescing default. */
  debounceMs?: number;
}): void {
  // Re-runs the rule when the *answer* to "is this at the bottom" changes, and
  // on every visibility change. A scroll that does not cross the line renders
  // nothing: the log fires a scroll event per frame and a `setState` on each of
  // them would repaint the transcript for the length of a drag.
  const [pulse, setPulse] = useState(0);
  const atBottom = useRef(true);
  const acked = useRef<Set<string>>(new Set());
  /**
   * Rows whose write is open. A row leaves this set when the write settles and
   * joins `acked` only if it *succeeded*: an ack the portal rejected is a row
   * that is still unread on the box, and treating the attempt as the outcome
   * would clear it from this tab's inbox for as long as the tab lived.
   */
  const pending = useRef<Set<string>>(new Set());
  const ids = useMemo(
    () => (items ? unreadChatRowIds(items, instance, bot) : []),
    [items, instance, bot],
  );
  const key = ids.join(",");

  // A different conversation is a different set of rows; what was acked in the
  // last one says nothing about this one.
  useEffect(() => {
    acked.current = new Set();
    pending.current = new Set();
  }, [instance, bot]);

  useEffect(() => {
    const node = scroller.current;
    const bump = () => {
      const at = node ? isAtBottom(node) : false;
      if (at === atBottom.current) return;
      atBottom.current = at;
      setPulse((n) => n + 1);
    };
    // A *return*, not every visibility event: a pane that flaps hidden↔visible
    // while it is captured fires several a second, and each one used to be a
    // re-render of the transcript for a rule whose answer had not moved. No
    // minimum age — the pass below costs nothing when there is nothing unread,
    // and an operator looking at the thread again should see it clear now.
    const stop = onReturnVisible(() => setPulse((n) => n + 1), { minAgeMs: 0 });
    node?.addEventListener("scroll", bump, { passive: true });
    return () => {
      node?.removeEventListener("scroll", bump);
      stop();
    };
  }, [scroller, instance, bot]);

  useEffect(() => {
    if (!active || !ackMany) return;
    const node = scroller.current;
    if (!node) return;
    if (!isVisible()) return;
    if (!isAtBottom(node)) return;
    const fresh = ids.filter((id) => !acked.current.has(id) && !pending.current.has(id));
    if (fresh.length === 0) return;
    const timer = setTimeout(() => {
      for (const id of fresh) pending.current.add(id);
      // A failure is left for the next pass to pick up — the inbox refreshes,
      // a message arrives, the reader scrolls — rather than retried on a loop
      // of its own, which would hammer a portal that is already answering no.
      void Promise.resolve(ackMany(fresh)).then(
        () => {
          for (const id of fresh) {
            acked.current.add(id);
            pending.current.delete(id);
          }
        },
        () => {
          for (const id of fresh) pending.current.delete(id);
        },
      );
    }, debounceMs);
    return () => clearTimeout(timer);
    // `key` is what makes a *set* of rows the dependency rather than the array
    // identity the inbox rebuilds on every refresh.
  }, [active, ackMany, scroller, ids, key, pulse, debounceMs]);
}
