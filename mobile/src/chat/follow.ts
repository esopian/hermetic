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

/**
 * How long the bottom inset must hold still before a re-pin follows it.
 * `KeyboardChatScrollView` reports the inset on every frame of the keyboard's
 * animation, and on iOS its own `keyboardLiftBehavior="whenAtEnd"` lift is
 * already moving the content with the keyboard on the UI thread. A JS
 * `scrollToOffset` per frame would race that lift and jitter, so the
 * transcript re-pins once, to the final inset, after the animation settles.
 * A little over three frames: the frames of one animation arrive about 16 ms
 * apart, or bunched together when the JS thread is busy.
 */
export const INSET_SETTLE_MS = 60;

/**
 * How long after a release with fling velocity to wait for the momentum to
 * begin. iOS sends `onMomentumScrollBegin` straight after the drag ends when
 * there is one; if it never comes (the velocity was too small to start a
 * deceleration), the touch has ended and a growth skipped under the finger
 * must still be caught up.
 */
export const MOMENTUM_GRACE_MS = 150;

/** Timers, injectable for tests; the default is the global pair. */
export interface PinTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const globalTimers: PinTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The transcript's follow state machine, kept out of the component so it can
 * be driven event by event in a test. The component forwards the scroll
 * view's events; the controller decides when to scroll.
 *
 * - Content growth re-pins at once while following and no touch is moving
 *   the list (`shouldRepin`).
 * - An inset change (the keyboard moving) re-pins only once the inset has
 *   settled (`INSET_SETTLE_MS`), to its final value.
 * - A touch's end catches up a growth skipped during it: at release with no
 *   velocity, at the end of a momentum that began, or `MOMENTUM_GRACE_MS`
 *   after a release with velocity when no momentum begins.
 */
export class PinController {
  following = true;
  /** The offset the last programmatic pin left, or null before any (or once not following). */
  pinnedY: number | null = null;
  readonly size = { content: 0, viewport: 0, inset: 0 };
  readonly touch = { dragging: false, momentum: false };
  private insetTimer: unknown = null;
  private graceTimer: unknown = null;
  private disposed = false;

  constructor(
    private readonly deps: {
      scrollTo(offset: number, animated: boolean): void;
      /** Called whenever following is set: each edge, and each explicit pin request. */
      onFollowing(following: boolean): void;
      timers?: PinTimers;
    },
  ) {}

  private get timers(): PinTimers {
    return this.deps.timers ?? globalTimers;
  }

  setFollowing(following: boolean): void {
    this.following = following;
    if (!following) this.pinnedY = null;
    this.deps.onFollowing(following);
  }

  /** Scroll to the end of the measured content plus the inset below it. */
  pinToEnd(animated: boolean): void {
    const y = endOffset(this.size.content, this.size.viewport, this.size.inset);
    this.deps.scrollTo(y, animated);
    this.pinnedY = y;
  }

  private repinIfFree(): void {
    if (shouldRepin({ following: this.following, ...this.touch })) this.pinToEnd(false);
  }

  onScroll(e: {
    offsetY: number;
    contentHeight: number;
    viewportHeight: number;
    /** iOS reports the inset with every scroll event; elsewhere the last one heard stands. */
    insetBottom?: number;
  }): void {
    if (e.insetBottom !== undefined) this.size.inset = e.insetBottom;
    const gap = fromBottom({
      offsetY: e.offsetY,
      contentHeight: e.contentHeight,
      viewportHeight: e.viewportHeight,
      insetBottom: this.size.inset,
    });
    const next = nextFollowing({
      following: this.following,
      atBottom: gap <= AT_BOTTOM_SLACK,
      offsetY: e.offsetY,
      pinnedY: this.pinnedY,
    });
    // Only the reader's own drag or fling ends following: a programmatic
    // pin, a layout pass or the list opening at the bottom raise scroll
    // events too, at offsets the content has already outgrown.
    const reader = this.touch.dragging || this.touch.momentum;
    if (next !== this.following && (next || reader)) this.setFollowing(next);
  }

  onContentSize(height: number): void {
    this.size.content = height;
    this.repinIfFree();
  }

  onViewport(height: number): void {
    this.size.viewport = height;
  }

  onInset(bottom: number): void {
    this.size.inset = bottom;
    if (this.disposed) return;
    if (this.insetTimer !== null) this.timers.clear(this.insetTimer);
    this.insetTimer = this.timers.set(() => {
      this.insetTimer = null;
      this.repinIfFree();
    }, INSET_SETTLE_MS);
  }

  dragBegin(): void {
    this.cancelGrace();
    this.touch.dragging = true;
  }

  dragEnd(velocityY: number | undefined): void {
    this.touch.dragging = false;
    if (!velocityY) {
      this.repinIfFree();
      return;
    }
    // A fling ends the touch at momentum end, unless the momentum never begins.
    this.cancelGrace();
    if (this.disposed) return;
    this.graceTimer = this.timers.set(() => {
      this.graceTimer = null;
      this.repinIfFree();
    }, MOMENTUM_GRACE_MS);
  }

  momentumBegin(): void {
    this.cancelGrace();
    this.touch.momentum = true;
  }

  /**
   * The end of a fling's momentum: the touch is over, so catch up a growth
   * skipped during it. Only a momentum seen to begin counts. iOS also sends
   * a momentum end after every programmatic scroll (`scrollToOffset` on
   * `RCTScrollViewComponentView`, at once when not animated), so re-pinning
   * on that one answers our own pin with another pin. UIKit rounds the offset
   * to the pixel grid, the next pin's offset never equals the one the view
   * holds, and the pair looped on the JS thread for as long as the transcript
   * stayed mounted.
   */
  momentumEnd(): void {
    if (!this.touch.momentum) return;
    this.touch.momentum = false;
    this.repinIfFree();
  }

  /** Drop pending timers (unmount). */
  dispose(): void {
    this.disposed = true;
    this.cancelGrace();
    if (this.insetTimer !== null) this.timers.clear(this.insetTimer);
    this.insetTimer = null;
  }

  private cancelGrace(): void {
    if (this.graceTimer !== null) this.timers.clear(this.graceTimer);
    this.graceTimer = null;
  }
}
