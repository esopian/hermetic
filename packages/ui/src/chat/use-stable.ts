/**
 * Hold on to a value while a new one is equal to it.
 *
 * For a value rebuilt on every render — a roster array after a refresh, a map
 * recomputed from the transcript — that is handed to a memoized child or a
 * context: the child sees the old reference until the content actually moves.
 * The held reference is replaced during render, which is safe here because it
 * only ever caches a value equal to the one being returned.
 */
import { useRef } from "react";

export function useStable<T>(value: T, equal: (held: T, next: T) => boolean): T {
  const held = useRef(value);
  if (held.current !== value && !equal(held.current, value)) held.current = value;
  return held.current;
}
