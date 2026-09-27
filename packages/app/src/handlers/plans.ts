/**
 * `plan.*` and `apply`: §3.2 rule 3, plan then apply. Every plan is a read; the
 * one write is `apply`, which is every other mutating method wearing a plan.
 *
 * Nothing here knows what a status code is: a refusal is a thrown
 * `HermeticError`. The schemas are declared here, so the method
 * and the schema the parity contract compares cannot drift apart
 * (`declare.ts`).
 */
import {
  ApplyInput,
  PlanDestroyInput,
  PlanFoundationInput,
  PlanNetworkInput,
  PlanPolicyInput,
  PlanRecreateInput,
  PlanRolloutInput,
  PlanTeardownInput,
} from "@hermetic/core";
import { HermeticError, planAgent } from "@hermetic/core";
import { declareRpc } from "../declare.ts";
import { accepted, type Accepted } from "../ops.ts";
import { requirePlanTarget, requireTarget, withTarget } from "../target.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";
import { TEARDOWN_PLANNING, afterTeardown, requireWritable } from "./shared.ts";

export const planDestroySchema = declareRpc("plan.destroy", PlanDestroyInput);
export const planRecreateSchema = declareRpc("plan.recreate", PlanRecreateInput);
export const planTeardownSchema = declareRpc("plan.teardown", PlanTeardownInput);
export const planFoundationSchema = declareRpc("plan.foundation", PlanFoundationInput);
export const planPolicySchema = declareRpc("plan.policy", PlanPolicyInput);
export const planNetworkSchema = declareRpc("plan.network", PlanNetworkInput);
export const planRolloutSchema = declareRpc("plan.rollout", PlanRolloutInput);
export const applySchema = declareRpc("apply", ApplyInput);

// §4.7 mutation bodies — see `handlers/shared.ts` and `target.ts`.
export const applyBody = withTarget(applySchema);

export async function planDestroy(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().plan.destroy(parseInput(planDestroySchema, params));
}

export async function planRecreate(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().plan.recreate(parseInput(planRecreateSchema, params));
}

export async function planTeardown(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().plan.teardown(parseInput(planTeardownSchema, params));
}

/**
 * §6.6's dry run. It takes no input, so there is nothing to hand core — but it
 * still validates against core's own schema, so the parity test compares the
 * same object on both sides.
 */
export async function planFoundation(ctx: HandlerContext, params: unknown) {
  /**
   * The one plan that is not a free read: it asks CloudFormation to compute a
   * real change set against the live stack (and deletes it again), which
   * CloudFormation refuses while that stack is mid-update. Answering the
   * refusal here names the op instead of surfacing a raw CFN error, and
   * `foundation.status().in_progress` is what the UI should be showing anyway
   * while one runs.
   *
   * Not `requireWritable`: this is the one guard that carries the op id in its
   * details, and a plan is a read that only this single op conflicts with.
   */
  if (ctx.state.foundationUpdateOpId !== null) {
    throw new HermeticError("CONFLICT", "foundation update in progress", {
      op_id: ctx.state.foundationUpdateOpId,
    });
  }
  parseInput(planFoundationSchema, params ?? {});
  return await ctx.hermetic().plan.foundation();
}

/**
 * §4.7's dry run over the tailnet policy. A pure read of Tailscale's API — it
 * fetches the policy and validates it, which stores nothing — so unlike
 * `planFoundation` above it needs no in-flight guard.
 */
export async function planPolicy(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().plan.policy(parseInput(planPolicySchema, params ?? {}));
}

/**
 * §5's re-network, planned. A read: it reads the stack, the `_fleet` item and
 * every agent's instance, and writes nothing — unlike `planFoundation` above it
 * computes no change set, so it needs no in-flight guard either.
 */
export async function planNetwork(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().plan.network(parseInput(planNetworkSchema, params));
}

/**
 * §6.5's converge, planned. A read: it renders to compute each agent's hash and
 * writes nothing — no row, no object — which is what lets the UI ask "what
 * would a rollout do" as freely as it asks anything else.
 */
export async function planRollout(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().plan.rollout(parseInput(planRolloutSchema, params ?? {}));
}

export async function apply(ctx: HandlerContext, params: unknown): Promise<Accepted> {
  const { state, ops } = ctx;
  const { hermetic: h, input } = requireTarget(state, parseInput(applyBody, params));
  // Core refuses an unconfirmed apply too, but as an op that would be a 202
  // followed by a failure; the head owes the client the 428 now.
  if (!input.yes) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      `applying a ${input.plan.kind} plan is destructive; send {"yes": true}`,
      { kind: input.plan.kind, target: input.plan.target },
    );
  }
  /**
   * §4.7: the plan carries its own account, region and `fleet_id`, written when
   * it was computed. The request's `target` says which fleet the *caller* means
   * and the summary says which fleet the *document* is about, and applying a
   * plan to a fleet it was not computed against is the same mistake as
   * destroying the wrong agent — one round trip and one stack later.
   */
  requirePlanTarget(state, input.plan.summary);
  // `apply` is every other mutating method wearing a plan: core dispatches
  // `kind: "foundation"` straight into `foundation.update` and `"teardown"`
  // into `teardown`, so the guards that hold for those have to hold for this
  // one or the plan file is the way around them.
  requireWritable(state);
  /**
   * A teardown plan applied here *is* a teardown, and used to be the one door
   * into `teardown` that claimed no slot and ran no reset: the portal stayed
   * open to agent mutations while its foundation was being deleted,
   * `--reset-local` left an initialized server holding an instance with no
   * fleet under it, and nothing was recorded for the wizard to show. The claim
   * is taken before the op so a switch cannot land between the two.
   */
  if (input.plan.kind === "teardown") {
    state.beginTeardown(TEARDOWN_PLANNING);
    const teardownOp = ops.start("apply", input.plan.target, (signal) => h.apply(input, { signal }), {
      agent: planAgent(input.plan),
    });
    state.beginTeardown(teardownOp.id);
    // `PlanOptions.reset_local` is optional, and core's apply dispatch reads it
    // as `?? true` — a plan that omits the flag resets local state. The head
    // has to read the same default or the portal stays on a dashboard for a
    // fleet it has just deleted.
    afterTeardown(ctx, teardownOp.id, input.plan, input.plan.options.reset_local ?? true);
    return accepted(teardownOp);
  }
  const op = ops.start("apply", input.plan.target, (signal) => h.apply(input, { signal }), {
    agent: planAgent(input.plan),
  });
  // A foundation plan applied here *is* a foundation update, so it claims the
  // same slot the update handler does — otherwise the second half of the mutual
  // exclusion is missing and an agent mutation lands mid-update.
  if (input.plan.kind === "foundation") {
    state.beginFoundationUpdate(op.id);
    void ops.wait(op.id).finally(() => state.endFoundationUpdate());
  }
  return accepted(op);
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const planHandlers = {
  "plan.destroy": planDestroy,
  "plan.recreate": planRecreate,
  "plan.teardown": planTeardown,
  "plan.foundation": planFoundation,
  "plan.policy": planPolicy,
  "plan.network": planNetwork,
  "plan.rollout": planRollout,
  apply,
} satisfies Record<string, Handler>;
