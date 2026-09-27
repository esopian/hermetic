/**
 * `foundation.status`, `plan.foundation` and `foundation.update` (§6.6): the
 * repeatable, versioned way to re-apply the foundation of §5 to a fleet that
 * already has one.
 *
 * `init --create` builds the stack once. Everything after that — a template fix,
 * a widened IAM policy, a new hermeticd — needed a teardown and a rebuild, which
 * is not a thing anyone does to a fleet with agents on it. This is the other
 * path: a CloudFormation change set the operator can read before it runs, a
 * recovery archive of the state it is about to change, and a rollout of the new
 * release to every box that is up.
 *
 * Its own directory, with an explicit `FoundationDeps`, for the reason `teardown.ts`
 * and `lifecycle.ts` are: it is one long operation with a dependency list it can
 * be handed, and `hermetic.ts` is at its size limit (AGENTS.md rule 5).
 *
 * The order of the phases is the safety property, and it is the same order
 * `plan.foundation` shows:
 *
 *   preflight → archive → stack → artifacts → migrate → rollout → done
 *
 * Nothing is *recorded* as done until `migrate` writes `_fleet`, so a failure
 * anywhere before it leaves "update available" true and the whole op re-runnable
 * from the top; every phase is idempotent for exactly that reason.
 */
import { createContext, type FoundationDeps } from "./shared.ts";
import { createStatus } from "./status.ts";
import { createChangeSet } from "./change-set.ts";
import { createPlan } from "./plan.ts";
import { createRelease } from "./release.ts";
import { createRollout } from "./rollout.ts";
import { createUpdate } from "./update.ts";

export type { FoundationDeps } from "./shared.ts";
export { compareReleaseTags, normaliseReleaseTag } from "./status.ts";

export function createFoundation(deps: FoundationDeps) {
  const ctx = createContext(deps);
  const { status } = createStatus(ctx);
  const changeSet = createChangeSet(ctx);
  const { plan } = createPlan(ctx, changeSet);
  const release = createRelease(ctx);
  const rollout = createRollout(ctx);
  const { update } = createUpdate(ctx, { changeSet, release, rollout });
  return { status, plan, update };
}
