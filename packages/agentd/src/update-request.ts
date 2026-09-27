/**
 * The rollout receiver (§6.6). `foundation.update` re-points the fleet manifest
 * at a new hermeticd release and then writes `update_request` onto every live
 * agent row: "take it now, rather than on the nightly check".
 *
 * The row is read once every 30 s by the heartbeat, which is the only loop that
 * already reads it — so the heartbeat notices the request and this gate carries
 * it across to the update loop. The two never import each other: the heartbeat
 * takes an `onUpdateRequest` callback, `serve` wires it to `makeUpdateGate()`,
 * and the update loop takes what the gate holds.
 *
 * Three rules the shape encodes:
 *
 *  - a request is acted on once. The heartbeat de-duplicates on `id`, and the
 *    field is never cleared on the row (hermetic decides "done" from the
 *    `hermeticd_version` the heartbeat already writes), so an un-de-duplicated
 *    reader would update on every tick forever;
 *  - a request that arrives while the bootstrap is still running is not lost.
 *    `maybeUpdate` returns `null` in that window and the loop `restore()`s the
 *    request for the next tick, because the heartbeat will not report the same
 *    id twice;
 *  - the wait is interruptible, but only by *news*. The loop sleeps
 *    `UPDATE_POLL_MS` between ticks, and a rollout that had to wait a minute
 *    per box for no reason is a minute of an operator watching a progress bar,
 *    so `wait()` races the host sleep against the next request. A request that
 *    the loop put back is deliberately not news: it would return from every
 *    wait instantly and turn the whole bootstrap window into a spin loop of
 *    `systemctl is-active` and manifest fetches. `restore()` therefore keeps
 *    the request pending but clears its claim on the wait; a genuinely new
 *    request arriving during that sleep still wakes the loop.
 */
import type { UpdateRequest } from "@hermetic/core/schema";
import type { Host } from "./host.ts";
import { makeRequestGate } from "./request-gate.ts";

export interface UpdateGateDeps {
  /**
   * One line when a request is taken up. `main.ts`'s `log` redacts; nothing in
   * an `UpdateRequest` is a secret, and this keeps it that way if that changes.
   */
  readonly log?: (message: string) => void;
}

export interface UpdateGate {
  /** Wire this to `HeartbeatDeps.onUpdateRequest`. */
  readonly onUpdateRequest: (request: UpdateRequest) => void;
  /** The pending request, if any, and clear it. */
  take(): UpdateRequest | null;
  /**
   * Put one back — the update could not run yet. It stays pending for the next
   * tick, but it no longer cuts the wait short: the loop must sleep out the
   * poll interval rather than spin on a request it already knows it cannot act
   * on.
   */
  restore(request: UpdateRequest): void;
  /** Whether a request is waiting, without taking it. */
  pending(): UpdateRequest | null;
  /** Sleep `ms`, returning early only for a request the loop has not yet tried. */
  wait(host: Host, ms: number): Promise<void>;
}

export function makeUpdateGate(deps: UpdateGateDeps = {}): UpdateGate {
  const log = deps.log ?? ((): void => {});
  /**
   * The mechanism is `makeRequestGate` (`request-gate.ts`), shared with §6.5's
   * converge receiver: the three rules above are the same three rules a config
   * request needs, and two copies of them would be two places to fix the day one
   * of them is wrong. What stays here is what is specific to *this* request —
   * the sentence it logs, and the name the rest of the box calls it by.
   */
  const gate = makeRequestGate<UpdateRequest>((request) => {
    log(
      `update requested by ${request.issued_by}: hermeticd ${request.hermeticd_version} (request ${request.id})`,
    );
  });

  return {
    onUpdateRequest: gate.onRequest,
    take: () => gate.take(),
    restore: (request) => {
      gate.restore(request);
    },
    pending: () => gate.pending(),
    wait: (host, ms) => gate.wait(host, ms),
  };
}
