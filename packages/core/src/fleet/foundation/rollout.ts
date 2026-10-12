/**
 * §6.6 step 6: ask every box that is up to take the new release, and watch it
 * land.
 *
 * A thin wrapper since `artifacts.push` and `upgrade --hermeticd` learned to do
 * the same thing: the request, the watch and the three outcomes live in
 * `fleet/hermeticd-rollout.ts`. What stays here is what is `foundation.update`'s
 * own — the release label is this build's, the slice of the progress bar is
 * `PHASE.rollout`, the wait defaults to the deployment's, and the fleet lock it
 * holds across the whole update is renewed between polls.
 */
import type { OpEvent } from "../../schema/index.ts";
import { rolloutHermeticd } from "../hermeticd-rollout.ts";
import { PHASE, type FoundationCtx } from "./shared.ts";

export function createRollout(ctx: FoundationCtx) {
  const { deps, core, hermeticdVersion } = ctx;

  async function* rollout(
    /** The digest `pushAndPrune` just published; the only evidence of landing. */
    targetSha256: string | null,
    keepLock: () => Promise<void>,
    overrideWaitMs: number | undefined,
    /** The fleet's `auto_update_hermeticd`, for when a straggler takes it instead. */
    autoUpdate: boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<OpEvent, void> {
    yield* rolloutHermeticd(
      {
        ctx: core,
        waitMs: overrideWaitMs ?? deps.rolloutWaitMs ?? 0,
        pollMs: deps.rolloutPollMs,
      },
      {
        targetSha256,
        version: hermeticdVersion,
        phase: "rollout",
        progress: PHASE.rollout,
        autoUpdate,
        keepLock,
        signal,
      },
    );
  }

  return { rollout };
}
