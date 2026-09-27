/**
 * "The page came back" — said once per return, not once per event.
 *
 * Every read in this app that catches up when the window is looked at again
 * hangs off `visibilitychange`, and each of them assumed the event means what
 * its name says. It does not, reliably. An embedded browser pane flaps
 * hidden↔visible every couple of seconds while it is being captured, and a
 * `visibilitychange` listener that reads on the visible half is then a
 * two-second poll — which is exactly what the roster read (`chat.swarms`, a
 * fan-out with one round trip per box over the tailnet) was measured doing
 * against a live portal, from the one code path whose whole job was to be
 * *considerate* about a window nobody is looking at.
 *
 * Two rules, and both are needed. A *transition*: the event only counts when
 * `visibilityState` actually changed from hidden to visible, so a flap that
 * never left "visible" reads nothing. And an *age*: a return within
 * `minAgeMs` of the last read is not worth a read, because the answer it would
 * replace is younger than the server's own poll cadence. Neither on its own is
 * enough — a real hidden↔visible flap satisfies the first, and a browser that
 * fires a spurious change without moving the state satisfies the second.
 *
 * Kept here rather than in each caller because "how often may a return cost a
 * network read" is one decision, and five copies of it is five chances to get
 * it wrong the next time a browser surprises us.
 */

/**
 * How recent a read has to be for a return to the tab to skip it.
 *
 * Fifteen seconds is the ceiling the fleet already sets: the server's poller
 * re-reads on its own schedule (`packages/app/src/poller.ts`), so a browser
 * asking more often than that is asking for an answer nothing has produced.
 * Long enough that a pane flapping once a second costs at most four reads a
 * minute, short enough that an operator coming back to a tab they left open
 * over lunch sees a current rail immediately.
 */
export const RETURN_READ_MIN_AGE_MS = 15_000;

/** A mutable cell, so a React ref and a plain object are both acceptable. */
export interface Cell<T> {
  current: T;
}

export interface ReturnVisibleOptions {
  /** How young the last read may be and still be reused. Zero means "always read". */
  minAgeMs?: number;
  /**
   * When the last read happened, shared with the caller.
   *
   * Passing the caller's own cell is what makes the age check about *reads*
   * rather than about this listener: a roster read made by a mutation or by the
   * store's own tick stamps the same cell, and a return a second later is then
   * correctly a no-op.
   */
  lastReadAt?: Cell<number>;
  /** The clock, for tests that own one. */
  now?: () => number;
}

/**
 * Call `read` when the page goes from hidden to visible, at most once per
 * `minAgeMs`. Returns the unsubscribe, like every other listener here.
 */
export function onReturnVisible(read: () => void, options: ReturnVisibleOptions = {}): () => void {
  const { minAgeMs = RETURN_READ_MIN_AGE_MS, now = () => Date.now() } = options;
  const lastReadAt = options.lastReadAt ?? { current: 0 };
  // Seeded from the state the page is in *now*: a listener registered while the
  // page is visible must not treat the next spurious event as an arrival.
  let wasVisible = isVisible();
  const handler = (): void => {
    const visible = isVisible();
    const returned = visible && !wasVisible;
    wasVisible = visible;
    if (!returned) return;
    if (minAgeMs > 0 && now() - lastReadAt.current < minAgeMs) return;
    lastReadAt.current = now();
    read();
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}

/**
 * What the head last said about this window, or null when it has said nothing.
 *
 * The app's webview reports `document.visibilityState === "hidden"` for the
 * life of the window and fires no `visibilitychange`, so the page cannot answer
 * the question for itself. The main process can — a window it owns is focused
 * or it is not — and pushes the answer as `app.visibility`
 * (`api/transport-rpc.ts`). Held here rather than in the transport because this
 * is where every gated reader already asks.
 */
let pushed: boolean | null = null;

/**
 * Record what the head said, and tell the listeners.
 *
 * The synthetic `visibilitychange` is what makes this a *replacement* for the
 * event rather than a second mechanism beside it: `onReturnVisible` and the
 * three surfaces that listen for the event by hand (`chat-state.tsx`,
 * `RoomConversation.tsx`, `nav/view-ack.ts`) keep working unchanged, and the
 * transition and age rules above still throttle a window that is being flapped
 * at. A push that does not move the state dispatches nothing, so a head that
 * re-states the obvious costs no reads.
 */
export function setPageVisible(visible: boolean): void {
  if (pushed === visible) return;
  pushed = visible;
  // Guarded, because this runs as the transport is built and the transport is
  // built in tests that have no DOM at all: recording the state must not depend
  // on there being anything to tell.
  if (typeof document === "undefined" || typeof document.dispatchEvent !== "function") return;
  document.dispatchEvent(new Event("visibilitychange"));
}

/**
 * Forget what the head said, so the page falls back to `document` again. Only a
 * test has a reason to: a window's visibility outlives any one transport.
 */
export function clearPageVisible(): void {
  pushed = null;
}

/**
 * Is the page on screen?
 *
 * The head's answer wins where there is one, because in the app it is the only
 * true one. Otherwise `visibilityState` rather than `hidden`, which is the
 * spelling the chat surface already gates its ticks on, and an environment that
 * reports neither reads as visible — refusing to read at all is the worse
 * failure.
 */
export function isVisible(): boolean {
  if (pushed !== null) return pushed;
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}
