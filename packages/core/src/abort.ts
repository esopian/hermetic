/**
 * The two things every long operation does with an `AbortSignal` (§3.2 rule 2).
 *
 * `checkAbort` is the throw: an op that has been aborted stops at the next
 * phase boundary with `ABORTED` naming the phase it was in, rather than
 * finishing a cloud call nobody is waiting for. Every extracted module takes it
 * through its deps object, so it lives here rather than inside the SDK closure
 * — it closes over nothing.
 *
 * `abortableSleep` is the wait: a poll loop that sleeps five seconds between
 * questions must not keep an aborted op alive for the rest of that sleep. Three
 * copies of it had grown — `handoff.ts`, `attach.ts`, `foundation.ts` — and one
 * of them carried a comment apologising for being a copy.
 *
 * Both leave nothing behind. The timer is cleared when the abort wins and the
 * listener is removed when the timer wins, because a rollout that polls every
 * ten seconds for ten minutes would otherwise pin sixty dead listeners to a
 * signal the caller still holds.
 */
import { HermeticError } from "./errors.ts";

/** Throw `ABORTED`, naming the phase, if the caller has hung up. */
export function checkAbort(signal: AbortSignal | undefined, phase: string): void {
  if (signal?.aborted) {
    throw new HermeticError("ABORTED", `operation aborted during ${phase}`, { phase });
  }
}

/** The type every deps object names for its `checkAbort`. */

/**
 * Sleep `ms`, or until `signal` aborts, whichever comes first. Never rejects:
 * an aborted wait is a wait that is *over*, and the caller decides what that
 * means by asking `checkAbort` next.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * The error a long operation records when nobody ever asked it to fail: its
 * consumer simply stopped consuming.
 *
 * A `for await` that breaks, a `.return()` on the generator, a browser tab that
 * closed mid-op — all three resume the op at its last `yield` with a `return`
 * completion, which runs `finally` and *skips* `catch`. Every lifecycle op used
 * to release its TTL lock in a `catch`, so an abandoned one left the row locked
 * for the whole ten minutes with no record of why (§4.4). The unwind is a
 * `finally` now, and this is what it writes when there is no error to name.
 *
 * It lives here rather than in `lifecycle.ts` because `destroy-agent.ts` and
 * `power.ts` need the same sentence, and because — like everything else in this
 * file — it closes over nothing.
 */
export function abandoned(name: string, method: string): HermeticError {
  return new HermeticError("ABORTED", `${method} of ${name} was abandoned before it finished`, {
    name,
    method,
  });
}
