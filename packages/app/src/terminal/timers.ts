/**
 * The clock the terminal transport runs on (issue #18).
 *
 * Coalescing windows, the resync throttle, keepalives and the fixture shell's
 * `sleep` are all time, and a test that waited on the wall clock for each of
 * them would be slow and flaky. So every unit here takes one of these, and
 * the tests hand in a fake they advance by hand.
 */

/** Opaque: whatever the clock's `setTimeout` returned, handed back to `clearTimeout`. */
export type TimerHandle = unknown;

export interface Timers {
  /** Milliseconds, monotonic enough to measure an interval with. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** The real clock. `performance.now()` because an interval must not jump with the wall clock. */
export const realTimers: Timers = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
