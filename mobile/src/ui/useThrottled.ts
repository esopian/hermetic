/**
 * A value that follows its source at most once every `ms`, leading and
 * trailing: the first change shows at once, a burst after it lands as one
 * update when the window closes, and the last value always arrives.
 *
 * Used for the streaming reply: deltas arrive every ~25 ms, and re-rendering
 * the transcript that often kept FlashList from ever finishing a layout pass,
 * so the reply appeared in one jump at the end instead of growing.
 *
 * The leading edge is taken during render, so a change outside the window
 * costs one render, not a render with the old value and a second from an
 * effect. `immediate` names values that skip the window altogether (the reply
 * ending: it must not linger beside the recorded message).
 */
import { useEffect, useReducer, useRef } from "react";

export function useThrottled<T>(value: T, ms: number, immediate?: (value: T) => boolean): T {
  const state = useRef<{ shown: T; at: number }>({ shown: value, at: Number.NEGATIVE_INFINITY });
  const latest = useRef(value);
  latest.current = value;
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  const s = state.current;
  if (!Object.is(value, s.shown)) {
    const now = Date.now();
    if (now - s.at >= ms || immediate?.(value)) {
      s.shown = value;
      s.at = now;
    }
  }
  const held = !Object.is(value, s.shown);

  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(
      () => {
        s.shown = latest.current;
        s.at = Date.now();
        redraw();
      },
      Math.max(0, s.at + ms - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [held, value, ms, s]);

  return s.shown;
}
