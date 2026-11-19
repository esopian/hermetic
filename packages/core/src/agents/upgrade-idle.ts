/**
 * `upgrade --hermes V --now`'s idle wait (decision D4): before the pin is
 * published, wait for the box to have no session running or waiting on a
 * person, so stopping Hermes for the swap does not cut a turn.
 *
 * The probe is the gateway's `session.active_list` over every live session
 * (`hermes-chat-busy.ts`). "Could not tell" is not "idle": a box that does not
 * answer the probe is waited on like a busy one, and `--force` is the way past
 * both. A box that is not up never reaches this (`convergeDeferral`).
 *
 * Counted looks, not a deadline, for the reason `waitForConverge` gives: the
 * fixture clock is frozen.
 */
import { abortableSleep, checkAbort } from "../abort.ts";
import type { CoreContext } from "../context.ts";
import { evt } from "../events.ts";
import type { Agent, OpEvent } from "../schema/index.ts";

/** D4's N: ten minutes, then the agent is left on the Hermes it runs. */
export const UPGRADE_IDLE_TIMEOUT_MS = 10 * 60_000;
export const UPGRADE_IDLE_POLL_MS = 10_000;

/** `false` idle, `true` busy, `null` could not tell. Never throws. */
export type BoxBusy = (agent: Agent, signal?: AbortSignal) => Promise<boolean | null>;

export interface IdleWaitDeps {
  readonly ctx: CoreContext;
  readonly busy: BoxBusy;
  readonly timeoutMs: number;
  readonly pollMs: number;
}

/**
 * Yields a line each time the box's answer changes, and returns whether it was
 * seen idle within the budget. An abort throws `ABORTED`.
 */
export async function* waitForIdle(
  deps: IdleWaitDeps,
  agent: Agent,
  progress: number,
  signal?: AbortSignal,
): AsyncGenerator<OpEvent, boolean> {
  const looks = Math.max(1, Math.ceil(deps.timeoutMs / deps.pollMs));
  const minutes = String(Math.round(deps.timeoutMs / 60_000));
  let last: boolean | null | undefined;
  for (let i = 0; i <= looks; i += 1) {
    checkAbort(signal, "idle");
    const busy = await deps.busy(agent, signal);
    if (busy === false) return true;
    if (busy !== last) {
      last = busy;
      yield evt(
        `${agent.name}:idle`,
        progress,
        busy
          ? `${agent.name} has a session running; waiting up to ${minutes}m for it to finish before stopping Hermes`
          : `${agent.name}'s gateway did not say whether a session is running; asking again for up to ${minutes}m`,
        deps.ctx.nowIso(),
      );
    }
    if (i < looks) await abortableSleep(deps.pollMs, signal);
  }
  checkAbort(signal, "idle");
  return false;
}
