/**
 * §7.1's data-volume snapshot policy: how often the fleet's DLM policy
 * snapshots every agent's `/data` volume, how many it keeps, and whether it
 * runs at all — a read (`snapshots.status`), a dry run (`plan.snapshots`) and
 * the `apply` case that executes it. The shape `network.ts` has, as its own
 * module per AGENTS.md rule 5.
 *
 * **CloudFormation owns the answer.** The policy is three parameters of the
 * foundation stack, read back from `DescribeStacks`; nothing caches it, so
 * there is nothing to drift. A change is one change set that restates those
 * three and keeps every other parameter (`createSnapshotChangeSet`), and
 * CloudFormation updates the one `AWS::DLM::LifecyclePolicy` in place.
 *
 * **Lighter than a re-network, on purpose.** No archive and no manifest
 * republish: no box reads the policy, and a failed change set rolls back to
 * the policy that was running. The `_fleet` lock is still taken, because a
 * foundation update executing a change set at the same moment would race this
 * one on the same stack.
 *
 * **Turning it off deletes nothing.** The policy goes `DISABLED`, so DLM stops
 * creating *and* stops expiring; the snapshots already taken stay, and keep
 * being billed, until an operator removes them. `status` counts them so a head
 * can say so. Lowering `retain` is the way to shed them gradually: an enabled
 * policy deletes the oldest past the new count on its next run.
 */
import { randomUUID } from "node:crypto";
import { DATA_SNAPSHOT_TAG } from "../backend/constants.ts";
import type { StackInfo } from "../backend/types.ts";
import type { CoreContext } from "../context.ts";
import { HermeticError } from "../errors.ts";
import { checkAbort } from "../abort.ts";
import { evt } from "../events.ts";
import { FOUNDATION_VERSION } from "../version.ts";
import { LOCK_TTL_MS, createFleetLock, fleetLockKeeper } from "./fleet-lock.ts";
import { changeSetName, runChangeSet, type StackChangeDeps } from "./stack-change.ts";
import {
  FLEET_KEY,
  PlanSnapshotsInput as PlanSnapshotsInputSchema,
  SnapshotPolicySchema,
  describeSnapshotPolicy,
  sameSnapshotPolicy,
  snapshotPolicyOf,
  snapshotWindowDays,
  type FleetItem,
  type Plan,
  type PlanSnapshotsInput,
  type PlanStep,
  type PlanSummary,
  type SnapshotPolicy,
  type SnapshotsReport,
} from "../schema/index.ts";

/** The phase boundaries, so `plan` and `apply` agree about where the bar is. */
const PHASE = {
  preflight: [0, 0.1],
  stack: [0.1, 0.95],
} as const;

/** The change-set timings a test shortens; production leaves them alone. */
export interface SnapshotsDeps {
  ctx: CoreContext;
  /** `FOUNDATION_VERSION` unless a test says otherwise. */
  foundationVersion?: number | undefined;
  changeSetPollMs?: number | undefined;
  changeSetTimeoutMs?: number | undefined;
  heartbeatMs?: number | undefined;
}

export function createSnapshots(deps: SnapshotsDeps) {
  const { appendEvent, backend, guardAccount, nowIso } = deps.ctx;
  const foundationVersion = deps.foundationVersion ?? FOUNDATION_VERSION;
  const now = () => backend.clock.now();

  const fleetLock = createFleetLock({
    backend,
    lockTtlMs: LOCK_TTL_MS,
    now,
    rerun: "`hermetic plan snapshots` and `hermetic apply`",
  });

  const stackDeps: StackChangeDeps = {
    backend,
    nowIso,
    ...(deps.changeSetPollMs !== undefined ? { changeSetPollMs: deps.changeSetPollMs } : {}),
    ...(deps.changeSetTimeoutMs !== undefined ? { changeSetTimeoutMs: deps.changeSetTimeoutMs } : {}),
    ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
  };

  function fleetSummary(stack: StackInfo | null): PlanSummary {
    const config = deps.ctx.requireConfig();
    return {
      account_id: config.account_id,
      region: config.region,
      fleet_id: config.fleet_id,
      stack_id: stack?.stack_id ?? null,
    };
  }

  /**
   * This fleet's data-volume snapshots, by the DLM policy's own tag. The
   * backend scopes the listing to this fleet (`listSnapshots`), so another
   * fleet's in the same account are never counted.
   */
  async function existing() {
    const mine = await backend.compute.listSnapshots(DATA_SNAPSHOT_TAG);
    return {
      count: mine.length,
      volume_gib: mine.reduce((sum, s) => sum + s.size_gib, 0),
    };
  }

  /** §7.1, §9: the policy the stack runs, and how many snapshots exist. A pure read. */
  async function status(): Promise<SnapshotsReport> {
    await guardAccount();
    const stack = await backend.foundation.describeStack();
    return {
      policy: stack === null ? null : snapshotPolicyOf(stack.parameters),
      existing: await existing(),
    };
  }

  /**
   * The current policy, or the refusal that says why there is none to change.
   * Also refuses a fleet behind this build's foundation: the change set runs
   * this build's template, and executing it would roll the template forward
   * without the migrations `foundation update` applies on the way.
   */
  function currentPolicy(fleet: FleetItem, stack: StackInfo): SnapshotPolicy {
    const version = fleet.foundation_version ?? 0;
    if (version !== foundationVersion) {
      throw new HermeticError(
        "CONFLICT",
        version < foundationVersion
          ? `this fleet's foundation is v${version} and this build's is v${foundationVersion}; run \`hermetic foundation update\` first, then change the snapshot policy`
          : `this fleet's foundation is v${version}, newer than this build's v${foundationVersion}; upgrade hermetic before changing the snapshot policy`,
        { fleet_version: version, build_version: foundationVersion },
      );
    }
    const policy = snapshotPolicyOf(stack.parameters);
    if (policy === null) {
      throw new HermeticError(
        "CONFLICT",
        `the ${stack.stack_name} stack carries no snapshot-policy parameters; run \`hermetic foundation update\` to bring it onto a template that has them`,
        { stack: stack.stack_name },
      );
    }
    return policy;
  }

  function samePolicyError(p: SnapshotPolicy): HermeticError {
    return new HermeticError(
      "CONFLICT",
      `the fleet's snapshot policy is already ${describeSnapshotPolicy(p)}; nothing to change`,
      { policy: p },
    );
  }

  async function plan(input: PlanSnapshotsInput): Promise<Plan> {
    const parsed = PlanSnapshotsInputSchema.parse(input);
    const { fleet, stack } = await deps.ctx.guardFleet();
    const from = currentPolicy(fleet, stack);
    const to: SnapshotPolicy = {
      enabled: parsed.enabled ?? from.enabled,
      retain: parsed.retain ?? from.retain,
      interval_hours: parsed.interval_hours ?? from.interval_hours,
    };
    if (sameSnapshotPolicy(from, to)) throw samePolicyError(from);
    const held = await existing();

    const warnings: string[] = [];
    if (!to.enabled) {
      warnings.push(
        `turning snapshots off stops new ones and stops expiring old ones: the ${held.count} snapshot(s) this fleet holds now stay, and keep being billed, until you delete them. Lowering the retention count with snapshots on is the way to shed them gradually.`,
      );
      warnings.push(
        "with snapshots off, a data volume that is lost or corrupted cannot be restored: an agent's memory lives only on its live volume.",
      );
      if (to.retain < from.retain) {
        warnings.push(
          `the lower retention (${to.retain}) is recorded but deletes nothing while snapshots are off; it takes effect, and deletes each volume's oldest past ${to.retain}, once they are turned back on.`,
        );
      }
    } else if (from.enabled && to.retain < from.retain) {
      warnings.push(
        `lowering retention from ${from.retain} to ${to.retain}: on its next scheduled run (within ${to.interval_hours} h) DLM deletes each volume's oldest snapshots past ${to.retain}. Those cannot be restored.`,
      );
    }
    if (to.enabled && to.interval_hours < from.interval_hours) {
      warnings.push(
        `snapshots every ${to.interval_hours} h keep ${to.retain} snapshots ≈ ${snapshotWindowDays(to).toFixed(1)} days back; more frequent snapshots store more changed blocks and cost more.`,
      );
    }

    const steps: PlanStep[] = [
      {
        id: "preflight",
        description: `take the ${FLEET_KEY} lock; agent operations refuse with LOCKED while it is held`,
        destructive: false,
      },
      {
        id: "stack",
        description: `update the foundation stack's snapshot policy: ${describeSnapshotPolicy(from)} → ${describeSnapshotPolicy(to)}`,
        destructive: !to.enabled || (from.enabled && to.retain < from.retain),
      },
    ];

    return {
      kind: "snapshots",
      target: fleet.fleet_id,
      options: { snapshots: to },
      steps,
      warnings,
      summary: fleetSummary(stack),
    };
  }

  /**
   * Execute a `plan.snapshots`: lock, change set, release. The change set is
   * the commit point and there is nothing to stamp after it — the stack is the
   * only record of the policy.
   */
  async function* apply(planned: Plan, opts: { signal?: AbortSignal; opId?: string } = {}) {
    const target = SnapshotPolicySchema.safeParse(planned.options.snapshots);
    if (!target.success) {
      throw new HermeticError(
        "VALIDATION",
        "this plan carries no target snapshot policy; run `hermetic plan snapshots` again",
        { kind: planned.kind },
      );
    }
    const to = target.data;
    const owner = `${await deps.ctx.actor()}#${opts.opId ?? randomUUID()}`;

    yield evt(
      "preflight",
      PHASE.preflight[0],
      "checking the account, the fleet and the current snapshot policy",
      nowIso(),
      undefined,
      "start",
    );
    const { fleet: found, stack: guarded } = await deps.ctx.guardFleet();
    // Re-checked against reality, not trusted from the plan: another operator
    // may have changed the policy since it was made.
    const from = currentPolicy(found, guarded);
    if (sameSnapshotPolicy(from, to)) throw samePolicyError(from);

    if (fleetLock.isLive(found, owner)) {
      throw new HermeticError(
        "LOCKED",
        `another fleet-wide operation is already running (locked by ${found.lock?.owner ?? "another operator"} until ${found.lock?.expires})`,
        { owner: found.lock?.owner ?? null, expires: found.lock?.expires ?? null },
      );
    }
    if (!(await fleetLock.acquire(owner))) {
      throw new HermeticError(
        "LOCKED",
        `another operator took the ${FLEET_KEY} lock first; try again once their operation finishes`,
        {},
      );
    }
    let current: FleetItem = fleetLock.withLock((await backend.store.fleet.get()) ?? found, owner);
    let released = false;
    const keepLock = fleetLockKeeper(
      fleetLock,
      LOCK_TTL_MS,
      () => current,
      (next) => {
        current = next;
      },
      owner,
    );

    try {
      yield evt(
        "preflight",
        PHASE.preflight[1],
        `snapshots ${describeSnapshotPolicy(from)} → ${describeSnapshotPolicy(to)}; took the ${FLEET_KEY} lock`,
        nowIso(),
        undefined,
        "done",
      );

      checkAbort(opts.signal, "stack");
      current = await fleetLock.renew(current, owner);
      const name = changeSetName("snapshots", nowIso, randomUUID().slice(0, 8));
      yield* runChangeSet(stackDeps, {
        guarded,
        name,
        create: () =>
          backend.foundation.createSnapshotChangeSet({
            name,
            hermeticVersion: deps.ctx.hermeticdVersion,
            policy: to,
          }),
        phase: "stack",
        errorCode: "SNAPSHOTS_UPDATE_FAILED",
        from: PHASE.stack[0],
        to: PHASE.stack[1],
        verb: "updating the snapshot policy",
        keepLock,
        ...(opts.signal ? { signal: opts.signal } : {}),
        noChangesMessage: `the stack already runs ${describeSnapshotPolicy(to)}; no CloudFormation change`,
      });

      await appendEvent(
        FLEET_KEY,
        "snapshots.apply",
        `snapshots ${describeSnapshotPolicy(from)} → ${describeSnapshotPolicy(to)}`,
      );
      current = await fleetLock.release(current, owner);
      released = true;
      yield evt("done", 1, `the fleet's snapshot policy is ${describeSnapshotPolicy(to)}`, nowIso());
    } finally {
      if (!released) {
        try {
          const latest = await backend.store.fleet.get();
          if (latest?.lock?.owner === owner) await fleetLock.release(latest, owner);
        } catch {
          /* the caller's error is the one that matters */
        }
      }
    }
  }

  return { status, plan, apply };
}
