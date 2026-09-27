/**
 * A clock a test steps by hand, for the timers `ChatProvider` arms.
 *
 * `ChatTiming` (`chat-state.tsx`) lets the store's `now`, `setTimeout` and
 * `setInterval` be handed in, and this is the thing to hand in. It replaces
 * nothing on `globalThis`: React's own scheduling, Testing Library's `waitFor`
 * and every neighbouring file keep the platform clock, which is the difference
 * between this and `jest.useFakeTimers()`. Bun's fake timers patched the
 * globals React's async `act()` parks on, and advanced them on a developer
 * laptop but not on the CI runner — the same file hung to the runner timeout
 * there and passed here. A clock only the store reads has no such seam.
 *
 * `advance(ms)` runs every timer that comes due in that window, in order, each
 * inside its own `act()` with a settle after it, so a state update a timer
 * causes — and a read the effect it re-arms then starts — is flushed into the
 * tree before the next timer fires, at the virtual time it fired. Nothing here
 * sleeps.
 */
import type { ChatTiming } from "../src/chat/chat-state.tsx";
import { act } from "./dom.ts";

/** The platform's own `setTimeout`, captured before any file could fake it. */
const platformSetTimeout = globalThis.setTimeout;

/** One macrotask on the real clock, so every promise chain started so far has run. */
const macrotask = (): Promise<void> => new Promise((resolve) => platformSetTimeout(resolve, 0));

/**
 * Let everything the tree has started land, inside `act()`.
 *
 * This is the step between "an event was dispatched" and "the read it caused
 * has been counted": the store answers a visibility change or a selection with
 * a promise chain that resolves over several turns, and an assertion that
 * followed the dispatch directly would be reading a render from before it.
 */
export async function settle(): Promise<void> {
  await act(async () => {
    await macrotask();
  });
}

interface Armed {
  at: number;
  seq: number;
  fn: () => void;
  /** The period of an interval, `null` for a one-shot. */
  every: number | null;
  cancelled: boolean;
}

export interface FakeClock {
  /** The virtual time, in milliseconds since the epoch. */
  now(): number;
  /** The three fields of `ChatTiming` this clock owns; spread into `timing`. */
  timing: Pick<ChatTiming, "now" | "setTimeout" | "setInterval">;
  /**
   * Move the clock forward by `ms`, firing every timer due in the window.
   *
   * Each firing is its own `act()`; the clock reads the timer's due time while
   * it runs, and an interval is re-armed before its callback runs so that a
   * cancel from inside the callback (an effect cleanup) takes.
   */
  advance(ms: number): Promise<void>;
  /** How many timers are armed and not cancelled. */
  pending(): number;
}

export function fakeClock(start = Date.parse("2026-09-18T12:00:00Z")): FakeClock {
  let now = start;
  let seq = 0;
  const armed = new Set<Armed>();
  const arm = (fn: () => void, ms: number, every: number | null): (() => void) => {
    const timer: Armed = { at: now + Math.max(0, ms), seq: ++seq, fn, every, cancelled: false };
    armed.add(timer);
    return () => {
      timer.cancelled = true;
      armed.delete(timer);
    };
  };
  const next = (until: number): Armed | undefined => {
    let found: Armed | undefined;
    for (const timer of armed) {
      if (timer.cancelled || timer.at > until) continue;
      if (!found || timer.at < found.at || (timer.at === found.at && timer.seq < found.seq))
        found = timer;
    }
    return found;
  };
  return {
    now: () => now,
    timing: {
      now: () => now,
      setTimeout: (fn, ms) => arm(fn, ms, null),
      // A zero-period interval would be due again the instant it fired.
      setInterval: (fn, ms) => arm(fn, ms, Math.max(1, ms)),
    },
    async advance(ms) {
      const until = now + ms;
      for (let timer = next(until); timer; timer = next(until)) {
        now = Math.max(now, timer.at);
        if (timer.every === null) armed.delete(timer);
        else {
          timer.at += timer.every;
          timer.seq = ++seq;
        }
        const { fn } = timer;
        await act(async () => {
          fn();
          await macrotask();
        });
        await settle();
      }
      now = until;
    },
    pending: () => armed.size,
  };
}
