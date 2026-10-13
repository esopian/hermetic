/**
 * A value that follows its source at most once every `ms`, leading and
 * trailing: the first change shows at once, a burst after it lands as one
 * update when the window closes, and the last value always arrives.
 *
 * Used for the streaming reply: deltas arrive every ~25 ms, and re-rendering
 * the transcript that often kept FlashList from ever finishing a layout pass,
 * so the reply appeared in one jump at the end instead of growing.
 */
import { useEffect, useRef, useState } from "react";

export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    if (Object.is(value, shown)) return;
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setShown(value);
      return;
    }
    const timer = setTimeout(() => {
      last.current = Date.now();
      setShown(latest.current);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, shown, ms]);

  return shown;
}
