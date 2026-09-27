/**
 * The change set (§6.6 step 3) and the Bedrock grant it states (§8.3): what
 * `plan` computes and deletes, and what `update` computes and executes.
 */
import { randomUUID } from "node:crypto";
import type { Agent, FleetItem } from "../../schema/index.ts";
import { bedrockIdsFromArns, desiredBedrockModelIds } from "../../profiles/bedrock-grants.ts";
import { settingsOf } from "../../profiles/settings.ts";
import { HermeticError } from "../../errors.ts";
import type { ChangeSetInfo, StackInfo } from "../../backend/types.ts";
import {
  changeSetName as buildChangeSetName,
  computeChangeSet as computeChangeSetShared,
  type StackChangeDeps,
} from "../stack-change.ts";
import type { FoundationCtx } from "./shared.ts";

export function createChangeSet(ctx: FoundationCtx) {
  const { deps, backend, hermeticdVersion, nowIso } = ctx;

  // ─── the change set ────────────────────────────────────────────────────────

  /**
   * What `stack-change.ts` needs from this closure. The change-set choreography
   * itself — the bounded compute, the stateful-replacement refusal, the delete
   * of anything that will not be executed — is shared with `apply` kind
   * `network`, which drives the same stack through the same three steps for a
   * different reason (§5, §6.6 step 3).
   */
  const stackDeps: StackChangeDeps = {
    backend,
    nowIso,
    changeSetPollMs: deps.changeSetPollMs,
    changeSetTimeoutMs: deps.changeSetTimeoutMs,
    heartbeatMs: deps.heartbeatMs,
  };

  /**
   * What the fleet already has granted.
   *
   * `_fleet` records it from v10 on; before that — and on a `_fleet` restored
   * from an older archive — the stack's own parameter is the truth, and reading
   * it is what stops an update narrowing a grant somebody was given by a build
   * whose defaults have since moved on. Every reader of "what is granted now"
   * goes through this, so a pre-v10 fleet cannot read as granting nothing in
   * one place and everything in another.
   *
   * **A failed read is a failed update, not an empty grant.** This answer is
   * unioned into the parameter the change set states, so a swallowed
   * `DescribeStacks` on a pre-v10 fleet would not mean "unknown" — it would mean
   * "granted nothing", and the update would quietly narrow the IAM policy under
   * boxes that are serving. Every other AWS read this update depends on
   * (`releaseVersions`, the change set itself) throws rather than guesses, and
   * this is the one whose guess is destructive, so it throws too.
   * `backfillBedrockGrant` tolerates the same failure because it only *caches*
   * the answer — it writes no policy — which is why the two differ.
   */
  async function grantedNow(fleet: FleetItem): Promise<string[]> {
    if (fleet.bedrock_model_ids !== undefined) return fleet.bedrock_model_ids;
    let stack: StackInfo | null;
    try {
      stack = await backend.foundation.describeStack();
    } catch (e) {
      throw new HermeticError(
        "FOUNDATION_UPDATE_FAILED",
        `this fleet does not record its Bedrock grant, so it has to be read off the foundation stack, and that read failed: ${e instanceof Error ? e.message : String(e)}. Refusing rather than restating a grant computed as though the fleet had none — that would narrow the agent role's policy under every box now serving.`,
        { fleet_id: fleet.fleet_id },
      );
    }
    return bedrockIdsFromArns(stack?.parameters["BedrockModelArns"]);
  }

  /**
   * §8.3: the Bedrock model ids this fleet needs granted, as of now.
   *
   * Computed from the fleet's own documents — its provider profiles and its
   * agent rows — unioned with this build's defaults and with whatever the fleet
   * already holds, so an update can widen the grant and can never narrow it
   * under a box that is serving.
   */
  async function bedrockGrant(fleet: FleetItem, granted?: readonly string[]): Promise<string[]> {
    const { settings } = settingsOf(fleet);
    // Same rule as `grantedNow`: a scan that fails is an update that fails. The
    // rows can only *widen* the grant (`granted` is unioned in), so a swallowed
    // failure would not narrow the policy — but it would quietly leave a model
    // only an agent row names out of the grant, and the update would report
    // success while that agent fails every turn.
    let agents: Agent[];
    try {
      agents = await backend.store.agents.scan();
    } catch (e) {
      throw new HermeticError(
        "FOUNDATION_UPDATE_FAILED",
        `the Bedrock grant is computed from every agent row, and reading them failed: ${e instanceof Error ? e.message : String(e)}. Refusing rather than restating a grant that leaves out whatever those rows name.`,
        { fleet_id: fleet.fleet_id },
      );
    }
    return desiredBedrockModelIds({
      settings,
      agents,
      granted: granted ?? (await grantedNow(fleet)),
    });
  }

  /** This build's template, rolled forward — the only `CreateChangeSet` an update makes. */
  const createUpdateChangeSet = (name: string, bedrockModelArns?: readonly string[]) => () =>
    backend.foundation.createChangeSet({
      name,
      hermeticVersion: hermeticdVersion,
      ...(bedrockModelArns === undefined ? {} : { bedrockModelArns }),
    });

  function changeSetName(version: number): string {
    return buildChangeSetName(`foundation-v${version}`, nowIso, randomUUID().slice(0, 8));
  }

  /** The shared compute, with this module's phase and its own `CreateChangeSet`. */
  async function computeChangeSet(
    name: string,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>,
  ): Promise<ChangeSetInfo> {
    return computeChangeSetShared(stackDeps, {
      name,
      // No grant on the *plan*'s change set: a plan is a question, and the
      // parameter it would state is one CloudFormation would then diff the
      // policy against. The delta is reported as a step instead (see `plan`).
      create: createUpdateChangeSet(name),
      phase: "stack",
      errorCode: "FOUNDATION_UPDATE_FAILED",
      ...(signal ? { signal } : {}),
      ...(heartbeat ? { heartbeat } : {}),
    });
  }

  return {
    stackDeps,
    grantedNow,
    bedrockGrant,
    createUpdateChangeSet,
    changeSetName,
    computeChangeSet,
  };
}
