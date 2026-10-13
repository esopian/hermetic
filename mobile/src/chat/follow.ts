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

/** Distance from the end of the content to the bottom of the viewport. */
export function fromBottom(m: {
  offsetY: number;
  contentHeight: number;
  viewportHeight: number;
}): number {
  return m.contentHeight - (m.offsetY + m.viewportHeight);
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

/** The offset a pin to the end leaves, for content of this height in this viewport. */
export function endOffset(contentHeight: number, viewportHeight: number): number {
  return Math.max(0, contentHeight - viewportHeight);
}
