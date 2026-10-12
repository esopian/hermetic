/**
 * Which terminal session this page is showing, and whether anybody can see it
 * (issue #18).
 *
 * Two readers need the same fact. The toast gate (`isWatchingTerminal`, read
 * by `notify-state.tsx`) must not interrupt somebody about the session they are
 * already looking at, the way `isWatchingThread` keeps a reply in the open chat
 * thread quiet. And the app's attention rules need `terminal.view`, so a session
 * on screen raises no rows in the first place — the Terminal section reports
 * that from `onTerminalViewChange`.
 *
 * A module, not a React context: the writer (the Terminal section) and the
 * readers (the notification provider, the section's own view report) sit in
 * different subtrees, and the readers want the fact at delivery time rather
 * than at render time. `chat-state.tsx` hands its equivalent to
 * `notify.setWatching`; this one has no provider to hand it to, because the
 * terminal outlives the drawer and has none.
 *
 * "Viewed" is the section's word plus the window's: a session selected in a
 * window behind an editor is not being watched, for the reason
 * `WatchedThread.focused` gives — treating it as watched would drop exactly
 * the alerts the operator went to the other window to be told about. Focus and
 * visibility are read live (`isVisible()`, `document.hasFocus()`), and every
 * focus, blur and visibility change re-reads them, so a listener hears about a
 * window going to the background without the section doing anything.
 */
import { isVisible } from "../lib/visibility.ts";
import { isWatchingTerminalSession } from "../logic/terminal-notify.ts";

/** The session the Terminal section has on screen in this page, or `null`. */
let showing: string | null = null;
/** The last value listeners were told, so a change is reported once. */
let lastViewed: string | null = null;
const listeners = new Set<(viewed: string | null) => void>();
let windowHooked = false;

/**
 * Whether this window is on screen and has focus; true where there is no DOM
 * to ask. Exported because the return toast asks the same question about the
 * same window (`terminal-notify-state.ts`), and two spellings of it could
 * disagree about when the operator came back.
 */
export function windowPresent(): boolean {
  if (typeof document === "undefined") return true;
  const focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
  return isVisible() && focused;
}

/** Tell every listener when the effective viewed session moved; nothing when it did not. */
function recompute(): void {
  const viewed = viewedTerminal();
  if (viewed === lastViewed) return;
  lastViewed = viewed;
  for (const listener of [...listeners]) listener(viewed);
}

/**
 * Hooked once and never unhooked: three cheap listeners on a page that has a
 * terminal at all, and a recompute that does nothing unless the answer moved.
 */
function hookWindow(): void {
  if (windowHooked || typeof window === "undefined" || typeof document === "undefined") return;
  windowHooked = true;
  window.addEventListener("focus", recompute);
  window.addEventListener("blur", recompute);
  document.addEventListener("visibilitychange", recompute);
}

/**
 * The Terminal section's one write: the session it is showing, or `null` when
 * it shows none (no session selected, the section left, the drawer closed).
 * Call it on every change of selected session and with `null` on unmount.
 */
export function setTerminalShowing(session_id: string | null): void {
  showing = session_id;
  hookWindow();
  recompute();
}

/** The session the section is showing, whether or not the window is in front. */
export function terminalShowing(): string | null {
  return showing;
}

/**
 * The session somebody is actually looking at: the one on screen, in a window
 * that is visible and focused. `null` otherwise. This is what `terminal.view`
 * reports.
 */
export function viewedTerminal(): string | null {
  return showing !== null && windowPresent() ? showing : null;
}

/** Whether this row is about the session on screen and in focus (the toast gate's question). */
export function isWatchingTerminal(n: { kind: string; ref?: string | null }): boolean {
  return isWatchingTerminalSession(n, viewedTerminal());
}

/**
 * Called with the viewed session (`viewedTerminal()`) every time it changes —
 * the section moved, or the window gained or lost focus or visibility. Not
 * called on subscribe; read `viewedTerminal()` for the current value. Returns
 * the unsubscribe.
 */
export function onTerminalViewChange(listener: (viewed: string | null) => void): () => void {
  hookWindow();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forget everything. Tests only: the module outlives any one mount. */
export function resetTerminalWatch(): void {
  showing = null;
  lastViewed = null;
  listeners.clear();
}
