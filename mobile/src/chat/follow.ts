/**
 * Keeping the transcript pinned to its live end, the desktop's rule
 * (`packages/ui/src/chat/stick-to-bottom.ts`): the list follows while a turn
 * streams in and its rows grow, and following ends only when the *reader*
 * scrolls up. An own send turns it back on.
 *
 * Pure, no React Native, so the rule has a jest test of its own.
 */

/** How far from the end still counts as "at the bottom" (desktop `AT_BOTTOM_SLACK_PX`). */
export const AT_BOTTOM_SLACK = 40;

/**
 * Distance from the end of the content to the bottom of the viewport.
 *
 * `insetBottom` is the scroll view's bottom content inset. The chat scroll
 * view (`KeyboardChatScrollView`) lifts the content over the keyboard by adding
 * the keyboard's height there on iOS, so with the keyboard up the end of the
 * scrollable range is that much further down than the content's own end.
 */
export function fromBottom(m: {
  offsetY: number;
  contentHeight: number;
  viewportHeight: number;
  insetBottom?: number;
}): number {
  return m.contentHeight + (m.insetBottom ?? 0) - (m.offsetY + m.viewportHeight);
}

/**
 * Whether the reader is still following after a scroll event.
 *
 * `atBottom` alone is not the answer: content grows between a programmatic
 * pin and the scroll event it raises, so our own pin can report "not at the
 * bottom". What the reader does to leave the live end is scroll *up*, above
 * the offset we last pinned to; anything at or past it is still ours.
 */
export function nextFollowing(input: {
  following: boolean;
  atBottom: boolean;
  offsetY: number;
  /** The offset the last programmatic pin left, or null before any pin. */
  pinnedY: number | null;
}): boolean {
  if (input.atBottom) return true;
  if (!input.following || input.pinnedY === null) return false;
  // One point of slack: sub-pixel layouts round the offset either way.
  return input.offsetY >= input.pinnedY - 1;
}

/**
 * The offset a pin to the end leaves, for content of this height in this
 * viewport, with `insetBottom` of content inset below it (the keyboard, while
 * it is up — see `fromBottom`).
 */
export function endOffset(contentHeight: number, viewportHeight: number, insetBottom = 0): number {
  return Math.max(0, contentHeight + insetBottom - viewportHeight);
}

/**
 * Whether a content-size change should re-pin to the end. Not while the
 * reader's finger or fling is moving the list: a pin then would snap the
 * content back under the finger.
 */
export function shouldRepin(input: {
  following: boolean;
  dragging: boolean;
  momentum: boolean;
}): boolean {
  return input.following && !input.dragging && !input.momentum;
}
