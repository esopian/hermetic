/**
 * Keeping a transcript pinned to its live end.
 *
 * Pinning once, when a conversation opens or a row appends, is not enough: the
 * rows keep growing after they are drawn. An image sizes itself when its bytes
 * arrive (or fail to), KaTeX and fonts settle a frame later, and a card opens.
 * Each of those grows the log under a scroller that was at the bottom a moment
 * ago, and nothing scrolls it back — the reader is left mid-history with the
 * newest turn below the fold.
 *
 * So the log is watched for size changes and re-pinned while the reader is
 * following, and "following" only ends when the *reader* scrolls up.
 */
import { useEffect } from "react";
import type { RefObject } from "react";
import { isAtBottom } from "../nav/view-ack.ts";

/**
 * Whether the reader is still following after a scroll event.
 *
 * `atBottom` alone is not the answer. A scroll event is dispatched a frame
 * after the scroll that caused it, and content can grow in between: our own
 * pin to the bottom then reports "not at bottom" and would switch following
 * off on a scroll the reader never made. What the reader does to leave the
 * live end is scroll *up*, above the offset we last pinned to; anything at or
 * past it is still ours.
 */
export function nextFollowing(input: {
  following: boolean;
  atBottom: boolean;
  scrollTop: number;
  /** The `scrollTop` the last programmatic pin left, or null before any pin. */
  pinnedTop: number | null;
}): boolean {
  if (input.atBottom) return true;
  if (!input.following || input.pinnedTop === null) return false;
  // One pixel of slack: sub-pixel layouts round `scrollTop` either way.
  return input.scrollTop >= input.pinnedTop - 1;
}

/** The pin state one log carries: whether it follows, and where it last pinned. */
export interface Pin {
  following: boolean;
  pinnedTop: number | null;
}

/** Scroll `node` to its bottom and remember the offset that left. */
export function pinToBottom(node: HTMLElement, pin: Pin): void {
  node.scrollTop = node.scrollHeight;
  pin.pinnedTop = node.scrollTop;
}

/**
 * Tracks the reader's scrolling and re-pins the log whenever its content
 * resizes while they are following. `pin` is a ref the caller also writes: an
 * open or an own send sets `following` back to true.
 */
export function useStickToBottom(log: RefObject<HTMLElement | null>, pin: RefObject<Pin>): void {
  useEffect(() => {
    const node = log.current;
    if (!node) return;
    const onScroll = () => {
      const state = pin.current;
      state.following = nextFollowing({
        following: state.following,
        atBottom: isAtBottom(node),
        scrollTop: node.scrollTop,
        pinnedTop: state.pinnedTop,
      });
      // The reader left the live end: the old pin offset means nothing now,
      // and a later scroll back past it is not a return to following.
      if (!state.following) state.pinnedTop = null;
    };
    const repin = () => {
      if (pin.current.following) pinToBottom(node, pin.current);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    // `load`/`error` do not bubble, but they do capture: an image settling its
    // size is the commonest late layout shift, and this catches it even where
    // there is no ResizeObserver.
    node.addEventListener("load", repin, true);
    node.addEventListener("error", repin, true);

    // The log's own box does not change when its content grows, so each row is
    // observed, and the row list is watched to observe the rows that arrive.
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(repin) : null;
    const rows =
      typeof MutationObserver === "function" && resize
        ? new MutationObserver((records) => {
            for (const record of records) {
              record.addedNodes.forEach((added) => {
                if (added instanceof Element) resize.observe(added);
              });
              record.removedNodes.forEach((gone) => {
                if (gone instanceof Element) resize.unobserve(gone);
              });
            }
            repin();
          })
        : null;
    if (resize) for (const child of Array.from(node.children)) resize.observe(child);
    rows?.observe(node, { childList: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("load", repin, true);
      node.removeEventListener("error", repin, true);
      resize?.disconnect();
      rows?.disconnect();
    };
  }, [log, pin]);
}
