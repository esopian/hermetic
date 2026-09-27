/**
 * The hand-off between the heartbeat and a loop that acts on a row request.
 *
 * There are two such requests now — §6.6's `update_request` (take the new
 * hermeticd release) and §6.5's `apply_request` (apply the config your row
 * names) — and both need the same three properties, which is why this is one
 * mechanism rather than two copies of it:
 *
 *  - **acted on once.** The heartbeat de-duplicates on `id` and the field is
 *    never cleared on the row, so a reader that did not de-duplicate would act
 *    on every tick forever;
 *  - **not lost to a busy box.** A loop that cannot act yet `restore()`s the
 *    request for the next tick, because the heartbeat will not report the same
 *    id twice;
 *  - **interruptible, but only by news.** The loop sleeps between ticks, and a
 *    request that had to wait a minute per box for no reason is a minute of an
 *    operator watching a progress bar — so `wait()` races the sleep against the
 *    next request. A request the loop *put back* is deliberately not news: it
 *    would return from every wait instantly and turn the waiting window into a
 *    spin loop. `restore()` therefore keeps the request pending but clears its
 *    claim on the wait; a genuinely new request arriving during that sleep
 *    still wakes the loop.
 *
 * The reason each request exists, and what its loop does with it, stays in the
 * module that owns it (`update-request.ts`, `converge.ts`). This is only the
 * plumbing they share.
 */
import type { Host } from "./host.ts";

/** Anything a row can carry as a request: identified, so it can be acted on once. */
export interface Identified {
  readonly id: string;
}

export interface RequestGate<T extends Identified> {
  /** Wire this to the heartbeat's `on…Request` callback. */
  readonly onRequest: (request: T) => void;
  /** The pending request, if any, and clear it. */
  take(): T | null;
  /** Put one back: it stays pending for the next tick, but no longer cuts the wait short. */
  restore(request: T): void;
  /** Whether a request is waiting, without taking it. */
  pending(): T | null;
  /** Sleep `ms`, returning early only for a request the loop has not yet tried. */
  wait(host: Host, ms: number): Promise<void>;
}

export function makeRequestGate<T extends Identified>(
  announce: (request: T) => void = () => {},
): RequestGate<T> {
  let pending: T | null = null;
  /** Whether `pending` is news, i.e. something the loop has not tried yet. */
  let unseen = false;
  let wake: (() => void) | null = null;

  return {
    onRequest(request) {
      pending = request;
      unseen = true;
      announce(request);
      const resume = wake;
      wake = null;
      resume?.();
    },

    take() {
      const request = pending;
      pending = null;
      unseen = false;
      return request;
    },

    restore(request) {
      // A newer request that landed while this one was in flight wins: it names
      // what the fleet wants *now*, and it keeps its claim on the wait.
      if (pending) return;
      pending = request;
      unseen = false;
    },

    pending() {
      return pending;
    },

    async wait(host, ms) {
      if (pending && unseen) return;
      await Promise.race([
        host.sleep(ms),
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      ]);
      wake = null;
    },
  };
}
