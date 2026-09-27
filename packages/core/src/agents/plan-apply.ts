/**
 * `apply`: execute a plan produced by `plan.*` (§3.2 rule 3). Its own module
 * with an explicit deps object (AGENTS.md rule 5) — it owns no state, only
 * the dispatch from a plan's `kind` to the operation that performs it and
 * the checks that stand in front of each one.
 */
import type { ApplyInput, OpEvent } from "../schema/index.ts";
import { ApplyInput as ApplyInputSchema } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import { validateName } from "../shared/naming.ts";
import type { CoreContext } from "../context.ts";
import type { OpOptions } from "../hermetic.ts";
import type { createLifecycle } from "./lifecycle.ts";
import type { createPlans } from "./plans.ts";
import type { createFoundation } from "../fleet/foundation/index.ts";
import type { createPolicy } from "../fleet/policy.ts";
import type { createNetwork } from "../fleet/network.ts";
import type { createRollout } from "./rollout.ts";
import type { createTeardown } from "../fleet/teardown.ts";

export interface ApplyDeps {
  ctx: CoreContext;
  /** The two agent plans' staleness check (`plans.ts`). */
  plans: Pick<ReturnType<typeof createPlans>, "assertCurrent">;
  destroy: ReturnType<typeof createLifecycle>["destroy"];
  recreate: ReturnType<typeof createLifecycle>["recreate"];
  foundation: Pick<ReturnType<typeof createFoundation>, "update">;
  policy: Pick<ReturnType<typeof createPolicy>, "apply">;
  network: Pick<ReturnType<typeof createNetwork>, "apply">;
  rollout: Pick<ReturnType<typeof createRollout>, "run">;
  teardown: ReturnType<typeof createTeardown>["teardown"];
}

export function createApply(deps: ApplyDeps) {
  const { requireConfig } = deps.ctx;
  const { plans, destroy, recreate, foundation, policy, network, rollout, teardown } = deps;

  /**
   * Execute a plan produced by `plan.*`. Core never asks "are you sure" (§3.2
   * rule 3) — it insists the head did, and it reads the plan's typed `options`
   * rather than parsing its human-readable steps back.
   */
  async function* apply(input: ApplyInput, opts: OpOptions = {}): AsyncIterable<OpEvent> {
    const parsed = ApplyInputSchema.parse(input);
    if (!parsed.yes) {
      throw new HermeticError(
        "CONFIRMATION_REQUIRED",
        `applying a ${parsed.plan.kind} plan is irreversible; the head must confirm and pass yes`,
        { kind: parsed.plan.kind, target: parsed.plan.target },
      );
    }
    const plan = parsed.plan;

    /**
     * §4.8, before any kind-specific work: a plan is a document produced at one
     * moment and applied at another, and in between the operator may have
     * switched the fleet this home is open on. Every plan this build produces
     * names the fleet it was made for, so applying one to a different fleet is
     * refused rather than executed against whatever is in front of it — an
     * agent name is unique only *within* a fleet, so `destroy atlas` planned on
     * `staging` and applied to `main` would destroy a different box.
     *
     * A plan with no summary at all is one an older hermetic wrote (the field
     * is additive); there is nothing to compare, so it applies as it always
     * did. What cannot happen is a summary that disagrees.
     */
    const planFleet = plan.summary?.fleet_id;
    if (planFleet !== undefined) {
      const config = requireConfig();
      if (planFleet !== config.fleet_id) {
        throw new HermeticError(
          "FLEET_MISMATCH",
          `plan was made for fleet ${planFleet}; this command is running against ${config.fleet_id}${config.name ? ` ("${config.name}")` : ""}`,
          {
            plan_fleet: planFleet,
            fleet_id: config.fleet_id,
            alias: config.name,
            kind: plan.kind,
            target: plan.target,
          },
        );
      }
    }

    switch (plan.kind) {
      case "destroy": {
        /**
         * The staleness check the `policy` case below has always had, for the
         * two plans that name an agent (`plans.ts`) — and then the same
         * promise handed to the operation, which checks it once more with the
         * agent's lock held. This check cannot hold that lock (the operation
         * takes it), so on its own it leaves a gap a `recreate` fits through:
         * the plan says "terminate i-old", the row moves, and `i-new` is what
         * dies (§6.7).
         */
        const expected = await plans.assertCurrent(plan);
        yield* destroy(
          {
            name: validateName(plan.target),
            yes: true,
            delete_volume: plan.options.delete_volume === true,
          },
          opts,
          expected,
        );
        return;
      }
      case "recreate": {
        const expected = await plans.assertCurrent(plan);
        yield* recreate({ name: validateName(plan.target), yes: true }, opts, expected);
        return;
      }
      case "foundation":
        // The same ceremony `foundation.update` itself takes: `yes` is the head
        // saying the operator confirmed, and there is no account-level typing
        // to do — an update creates nothing and destroys nothing (§6.6).
        yield* foundation.update({ yes: true }, opts);
        return;
      case "policy":
        // The policy plan carries the ETag it was computed against; `apply`
        // re-reads the file and refuses if it has moved (§4.7).
        yield* policy.apply(plan, opts);
        return;
      case "network":
        /**
         * §5: move the fleet between `public` and `nat`. The plan carries the
         * target mode as data; `apply` re-reads the stack and refuses if the
         * fleet is already there, or if agents sit in subnets the change would
         * have to delete. It takes the `_fleet` lock, like `foundation.update`.
         */
        yield* network.apply(plan, opts);
        return;
      case "rollout":
        /**
         * No staleness check against the plan document: a rollout names no
         * instance and deletes nothing, and `run` re-reads every row and
         * re-renders before it writes, so a plan read ten minutes ago converges
         * the fleet as it is now rather than as it was. What the plan is for is
         * the operator seeing which boxes will be touched before any of them is.
         */
        yield* rollout.run(
          {
            ...(plan.options.rollout_agents === undefined
              ? {}
              : { agents: plan.options.rollout_agents }),
            ...(plan.options.rollout_concurrency === undefined
              ? {}
              : { concurrency: plan.options.rollout_concurrency }),
          },
          opts,
        );
        return;
      case "teardown": {
        /**
         * A teardown plan is the one plan whose target is the *account*, so it
         * carries the §4.7 ceremony with it: `yes` alone used to be enough here,
         * which made `apply plan.json --yes` a whole-foundation delete with no
         * typed account id anywhere in it. The digits are required, and they are
         * compared against the frozen config — never against the plan document,
         * which is an untrusted file the caller handed in.
         */
        const frozen = requireConfig();
        const typed = parsed.confirm_account_id;
        if (typed === undefined) {
          throw new HermeticError(
            "CONFIRMATION_REQUIRED",
            "applying a teardown plan destroys the whole foundation; type the twelve digits of the account id and pass them as confirm_account_id",
            { kind: plan.kind, target: plan.target, observed: frozen.account_id },
          );
        }
        if (typed !== frozen.account_id) {
          throw new HermeticError(
            "CONFIRMATION_REQUIRED",
            `the account id you typed does not match the account this home is frozen to (${frozen.account_id})`,
            { typed, frozen: frozen.account_id },
          );
        }
        // The flags the plan was produced with, not the defaults: a plan that
        // said it would keep the volumes must not delete them (§3.2 rule 3).
        yield* teardown(
          {
            yes: true,
            confirm_account_id: typed,
            purge: plan.options.purge ?? true,
            delete_snapshots: plan.options.delete_snapshots ?? false,
            delete_volumes: plan.options.delete_volumes ?? false,
            reset_local: plan.options.reset_local ?? true,
          },
          opts,
        );
        return;
      }
      default:
        // TODO(evan): PHASE2 — `create` and `upgrade` plans, once the heads offer a dry-run
        // for them too.
        throw new HermeticError("UNSUPPORTED", `cannot apply a ${plan.kind} plan yet`, {
          kind: plan.kind,
        });
    }
  }

  return { apply };
}
