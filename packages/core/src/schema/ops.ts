import { z } from "zod";
import { AccountId, FleetIdSchema, Iso, Region, Version } from "./common.ts";
import { NetworkMode } from "./fleet.ts";

/** One tick of a long operation's event stream (§3.2 rule 2). */
export const OpEvent = z.object({
  phase: z.string(),
  progress: z.number().min(0).max(1),
  message: z.string(),
  level: z.enum(["info", "warn", "error"]).optional(),
  /**
   * `start` marks the beginning of a phase that will take a while (a
   * CloudFormation create, an instance launch); `done` marks its completion.
   * Events with neither are progress within whatever phase is open. Heads use
   * the pair to show the *right* current step during a long silence — before
   * this, "current" was inferred from the last event seen, which named the
   * previous phase for the whole three minutes a stack took to create.
   */
  kind: z.enum(["start", "done"]).optional(),
  at: Iso,
});
export type OpEvent = z.infer<typeof OpEvent>;

export const PlanKind = z.enum([
  "destroy",
  "teardown",
  "create",
  "recreate",
  "upgrade",
  /** `plan.foundation`: what `foundation.update` would change (§6.6). */
  "foundation",
  /** `plan.policy`: hermetic's own blocks in the tailnet policy file (§4.7). */
  "policy",
  /** `plan.rollout`: re-render the fleet's configs and converge every box (§6.5). */
  "rollout",
  /** `plan.network`: move the fleet between `public` and `nat` egress (§5). */
  "network",
]);
export type PlanKind = z.infer<typeof PlanKind>;

/**
 * The kinds whose `target` is an agent name. Every other kind names the fleet
 * or one of its parts (`tailnet`, a stack, a `fleet_id`), which is not an agent
 * and must not be recorded as one on a run or its notification (§4.6/§4.9).
 */
export const AGENT_PLAN_KINDS: readonly PlanKind[] = ["destroy", "create", "recreate", "upgrade"];

/** The agent a plan is about, or null for a fleet-level plan. */
export function planAgent(plan: { kind: PlanKind; target: string }): string | null {
  return AGENT_PLAN_KINDS.includes(plan.kind) ? plan.target : null;
}

export const PlanStep = z.object({
  id: z.string(),
  description: z.string(),
  destructive: z.boolean(),
});
export type PlanStep = z.infer<typeof PlanStep>;

/**
 * Options the plan was produced *with*, carried as data. `apply` used to recover
 * the volume decision by string-matching a step description, which made a plan's
 * prose load-bearing; this makes the decision explicit and typed.
 */
export const PlanOptions = z.object({
  /** `plan.destroy --keep-volume`: leave the data volume behind, released from the name (§6.7). */
  keep_volume: z.boolean().optional(),
  /** The four `teardown` flags (§9), carried so `apply` need not re-derive them. */
  purge: z.boolean().optional(),
  delete_snapshots: z.boolean().optional(),
  delete_volumes: z.boolean().optional(),
  reset_local: z.boolean().optional(),
  /**
   * `plan.policy`: the ETag of the tailnet policy the plan was computed
   * against. `apply` re-reads the policy and refuses if it has moved, so a
   * plan reviewed against one file cannot be applied to another (§4.7).
   */
  etag: z.string().optional(),
  /**
   * `plan.destroy`/`plan.recreate`: the agent row the plan describes, as it was
   * when the plan was made. The etag above is the same idea for the tailnet
   * policy, and these three are why: a plan is a document an operator reads,
   * approves and applies at some later moment, and in between the row can be
   * recreated onto a different instance and a different volume. `apply` re-reads
   * the row and refuses if `agent_version` has moved, so the thing destroyed is
   * the thing that was shown — the ids are carried beside it because "the plan
   * named vol-A, the row now names vol-B" is what the refusal has to be able to
   * say.
   */
  agent_version: z.number().int().nonnegative().optional(),
  instance_id: z.string().nullable().optional(),
  volume_id: z.string().nullable().optional(),
  /**
   * `plan.destroy`/`plan.recreate`: the row's `created_at`, which is what makes
   * it *this* incarnation of the name. The ids cannot say that on their own:
   * since §6.7 a destroy frees the name, so a plan read for a `creating` row
   * with no instance and no volume yet would otherwise match a later, unrelated
   * `creating` row of the same name, whose ids are just as null. `apply`
   * refuses with `PLAN_STALE` when the row's `created_at` differs, and refuses
   * a destroy plan that does not carry one at all — an older build wrote it.
   */
  created_at: z.string().optional(),
  /**
   * `plan.rollout`: which agents the plan was made for, and how many at a time.
   * Carried as data for the reason `keep_volume` is — `apply` must execute the
   * plan the operator read, not re-derive a wider one from today's defaults. A
   * plan made for one agent must never converge twelve.
   */
  rollout_agents: z.array(z.string()).optional(),
  rollout_concurrency: z.number().int().min(1).max(8).optional(),
  /**
   * `plan.network`: the mode the fleet is being moved *to*, carried as data for
   * the reason `keep_volume` is. `apply` must execute the change the operator
   * read — a plan reviewed as "public → nat" cannot be allowed to re-derive its
   * own target from whatever the fleet happens to be when it runs.
   */
  network: NetworkMode.optional(),
});
export type PlanOptions = z.infer<typeof PlanOptions>;

/**
 * Which fleet, in which account, the plan is about — so a head can repeat the
 * header line of §4.7 on the confirmation the operator is reading, and so
 * `apply` can refuse a plan made against a different fleet (§4.8): a home may
 * freeze several, and a `destroy` plan reviewed on `staging` must not be
 * applied to `main` because the operator switched fleets in between.
 *
 * `stack_id` is null when the foundation is already gone, and when the plan did
 * not resolve the stack at all — a plan that names an agent or the tailnet has
 * no reason to spend a `DescribeStacks` on one.
 */
export const PlanSummary = z.object({
  /**
   * The same `AccountId`/`Region` primitives `FleetTarget` is built from, not a
   * loose `z.string()`. A summary and a target are compared field for field
   * (the portal's `requirePlanTarget`), so a summary able to hold a shape no
   * target can hold is a summary that can only ever lose that comparison — and
   * the head used to read a summary it could not parse as a summary that was
   * not there, which turns a malformed field into a disarmed guard.
   */
  account_id: AccountId,
  region: Region,
  fleet_id: FleetIdSchema,
  stack_id: z.string().nullable(),
});
export type PlanSummary = z.infer<typeof PlanSummary>;

/** `plan.destroy(name)` → this; `apply(plan)` executes it. Core never asks "are you sure". */
export const Plan = z.object({
  kind: PlanKind,
  target: z.string(),
  options: PlanOptions.default({}),
  steps: z.array(PlanStep),
  warnings: z.array(z.string()),
  /**
   * Every plan this build produces carries one. Still optional in the schema
   * because `apply` parses a *document the caller handed in* — one written by
   * an older hermetic has no summary, and refusing to parse it would be a
   * worse answer than applying it unchecked. `apply` refuses on a summary that
   * *disagrees*; it cannot refuse one that was never there.
   */
  summary: PlanSummary.optional(),
  /**
   * What this plan would do to the fleet's hermeticd release — only on a
   * `foundation` plan, and only when the manifest could be read.
   *
   * It exists because the version alone cannot answer the question an operator
   * opens this plan to ask. `BUILD_VERSIONS.hermeticd` moves only when somebody
   * edits it by hand, so a checkout that changed the binary ships the same
   * label as the one that did not, and the drawer's `hermeticd <from> → <to>`
   * line is two readings of one constant: it cannot show a change, whatever
   * changed. `build` — the fingerprint of the sources the release was compiled
   * from — is the thing that can, and `releaseDrift` is the sentence to say
   * about it.
   *
   * It is on the plan rather than on `foundation.status` deliberately.
   * `status` is served on every `/api/meta` and costs one `_fleet` read and one
   * scan; this needs the fleet manifest out of S3, which a plan already pays
   * far more than for its CloudFormation change set. Optional for the usual
   * reason: an older hermetic's plan document carries none, and a fleet with no
   * published manifest (`--skip-artifacts`, an emptied bucket) genuinely has no
   * answer — which reads as unknown, never as agreement.
   */
  release: z
    .object({
      /** The release the fleet manifest names now, and the build that pushed it. */
      published_version: Version.nullable(),
      published_build: z.string().nullable(),
      /** What this checkout would push. `local_build` is null when it cannot say. */
      local_version: Version,
      local_build: z.string().nullable(),
      /**
       * `git rev-list --count HEAD` for each side: the release the fleet is on,
       * and the one this checkout would push.
       *
       * The digests above can only say *different*; these say *which way*. A
       * higher local number is work waiting to be pushed; a lower one means the
       * fleet is ahead of this checkout and pushing would move it backwards —
       * opposite situations that `published_build !== local_build` cannot
       * distinguish, and that two people sharing a fleet hit constantly.
       *
       * Null on either side wherever the checkout could not say: a built
       * binary, a tarball, a shallow clone, or a release pointed at by
       * `upgrade --hermeticd`. Null reads as unknown and never as zero.
       */
      published_build_number: z.number().int().positive().nullable(),
      local_build_number: z.number().int().positive().nullable(),
      /** The commit each side resolves back to, when known. */
      published_commit: z.string().nullable(),
      local_commit: z.string().nullable(),
      /**
       * `releaseDrift`'s sentence — same version, different build — or `null`
       * when there is nothing to say *or* nothing that can be said. The two are
       * distinguished by `published_build`/`local_build` being present.
       */
      drift: z.string().nullable(),
    })
    .optional(),
});
export type Plan = z.infer<typeof Plan>;
