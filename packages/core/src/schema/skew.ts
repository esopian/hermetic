/**
 * Version skew: the fleet a laptop is pointed at was built by a different
 * hermetic than the one pointed at it (§6.6).
 *
 * hermetic does not run in compatibility mode. There is one foundation contract
 * per fleet, one hermeticd release per fleet, and one config rendered per agent
 * by whichever build last rendered it — and when the build in the operator's
 * hand disagrees with any of those, the honest answer is not to branch on the
 * version, it is to say so and name the one command that resolves it.
 *
 * That decision is what shapes this module. There is no per-version table of
 * what breaks, and deliberately so: such a table would have to be rewritten at
 * every `FOUNDATION_VERSION` bump, would be wrong the first time somebody
 * forgot, and would read as a promise that anything *not* listed still works.
 * The warning is generic and fixed — the axes it compares are the same four
 * forever, and the sentence does not change. The detail lives where detail
 * belongs: the version numbers themselves, the per-agent list in Settings, and
 * `hermetic doctor`.
 */
import { z } from "zod";

/**
 * How bad the disagreement is, in the order a head should prefer to report it.
 *
 * The three non-empty values are not degrees of the same thing — they differ in
 * who acts and whether acting helps:
 *
 * - `blocked` — the *fleet* is ahead of this build. `foundation.update` refuses
 *   with `FOUNDATION_NEWER` rather than applying an older template over a newer
 *   one, so no button in any head fixes this; upgrading hermetic does. It is
 *   the only severity a head may not let an operator dismiss.
 * - `degraded` — the fleet is behind this build. The common case, and the one
 *   this whole module exists for: `hermetic foundation update` resolves it.
 * - `drifted` — the fleet is current and some agents are holding a config that
 *   is not the one rendered for their row, with nothing in flight to change
 *   that. Unlike a release, a config is never taken on a box's own initiative:
 *   it moves only when something asks the box to apply it (`hermetic plan
 *   rollout` and `apply`, `upgrade --now`, or a recreate), so this one does not
 *   resolve itself and says which command does. Amber, like `degraded`, and
 *   dismissible like it.
 * - `pending` — the fleet is current and some agents have not caught up yet:
 *   their hermeticd is behind the release the fleet points at, which their
 *   runners take on their own next tick, or a config apply was asked of them
 *   moments ago and is still landing. Either way an operator who acts on this
 *   makes it slower, not faster. Never amber; never a block.
 *
 * The array is in ascending order of severity — `none < pending < drifted <
 * degraded < blocked` — so that `SkewSeverity.options.indexOf` ranks two of
 * them, should a reader ever need to. `computeSkew` tests them most-severe
 * first and returns the first that holds, which is the same order.
 */
export const SkewSeverity = z.enum(["none", "pending", "drifted", "degraded", "blocked"]);
export type SkewSeverity = z.infer<typeof SkewSeverity>;

/**
 * The one sentence, per severity. Every head prints one of these verbatim — the
 * portal's band, the drawer's band and the CLI's stderr block are the same
 * words in different type, which is the point: an operator who has read it once
 * recognises it everywhere and does not have to work out whether the shorter
 * spelling means something milder.
 */
export const SKEW_MESSAGE: Readonly<Record<SkewSeverity, string>> = {
  none: "",
  pending: "agents are taking the new release; they catch up on their own",
  drifted:
    "some agents are not running the config rendered for them; they converge only when it is applied",
  degraded: "some things will not behave as expected until the fleet is updated",
  blocked: "some things will not behave as expected; this build cannot update this fleet",
};

/** The command that resolves a `degraded` fleet. `blocked` has no command — see below. */
export const SKEW_FIX = "hermetic foundation update";

/**
 * The command that resolves a `drifted` fleet: re-render every agent's config
 * and ask the boxes that are behind to apply it (§6.5). A plan, not the apply
 * itself — it shows which agents it would converge, and `hermetic apply` runs
 * it. `pending` has no command, because the agents it is about need none.
 */
export const SKEW_DRIFT_FIX = "hermetic plan rollout";

/**
 * What an agent's applied config is, relative to what the fleet rendered for it.
 *
 * `unknown` is a first-class answer and not a synonym for `current`. An agent
 * that has never reported an applied hash — it predates the field, or it has
 * not heartbeated since it was created — is genuinely not known to be either,
 * and reporting it as current is the one way this could actively mislead.
 */
export const ConfigVerdict = z.enum(["current", "drifted", "unknown"]);
export type ConfigVerdict = z.infer<typeof ConfigVerdict>;

/**
 * The whole warning, computed once in core and rendered by every head.
 *
 * The counts are here rather than derived by each head because "3 agents
 * affected" has to mean the same thing in the portal and in the CLI, and
 * because what counts as affected depends on the severity: a `degraded`
 * foundation is a property of the *fleet*, so every live agent is affected by
 * it, while `pending` and `drifted` are per-agent and only the agents each one
 * is about are counted: the ones still catching up, or the ones whose config
 * nothing is applying.
 */
export const Skew = z.object({
  severity: SkewSeverity,
  /** The facts, in one line: `fleet foundation v1 · this build expects v2`. */
  headline: z.string(),
  /** `SKEW_MESSAGE[severity]`, carried on the wire so a head never has its own copy. */
  message: z.string(),
  /** What the fleet is on, and what this build would apply. */
  fleet_version: z.number().int().nonnegative(),
  expected_version: z.number().int().nonnegative(),
  /** Agents whose reported hermeticd is not the release the fleet now points at. */
  agents_behind: z.number().int().nonnegative(),
  /**
   * Agents holding a config that is not the one rendered for their row — all of
   * them, including any whose apply is still landing. The severity is what
   * tells the two apart; this is the raw count `hermetic doctor` would give.
   */
  agents_drifted: z.number().int().nonnegative(),
  /** How many agents the operator should read the headline as being about. */
  agents_affected: z.number().int().nonnegative(),
  /** The command that resolves it, or `null` when no command in this build does. */
  fix: z.string().nullable(),
});
export type Skew = z.infer<typeof Skew>;
