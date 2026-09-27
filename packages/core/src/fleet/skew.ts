/**
 * Computing the §6.6 version skew: pure functions over facts the fleet already
 * records, so both heads render the same warning from the same numbers.
 *
 * Deliberately free of AWS, of the backend, and of anything asynchronous. Every
 * input here is already on the `_fleet` item or on the agent rows that
 * `foundation.status` scans anyway, which is what makes the warning free enough
 * to attach to a read every head performs on every request.
 *
 * The comparisons are four, and only the first three can raise a warning:
 *
 *   foundation — the fleet's contract version vs the one this build ships
 *   hermeticd  — each agent's reported release vs the one the fleet points at
 *   config     — each agent's applied config vs the one rendered for its row
 *   hermes     — pinned vs upstream, which is advisory and stays out of this
 *
 * Hermes is excluded on purpose. A Hermes bump is a deliberate, per-agent
 * `hermetic upgrade --hermes`, which no button and no foundation update
 * performs, so folding it in here would put it behind a warning whose one fix
 * does not apply it (`foundation-logic.ts` makes the same argument for the
 * Settings card).
 */
// Imported from the modules themselves rather than through `schema/index.ts`:
// core's own barrel is for its consumers, and a module that only needs two
// sibling schemas should not make itself depend on the whole of it.
import type { AgentStatus } from "../schema/agent.ts";
import type { ConfigVerdict, Skew } from "../schema/skew.ts";
import { SKEW_FIX, SKEW_MESSAGE } from "../schema/skew.ts";

/**
 * Statuses that take no part in a skew count.
 *
 * `destroyed` is a tombstone — the row outlives the box by design (§4.3) and
 * counting it would keep a fleet permanently "3 agents affected" after the
 * three were deleted. `creating` is the other end of the same argument: the box
 * does not exist yet, has reported no version, and is by definition being built
 * by *this* build, so it can be neither behind nor drifted.
 *
 * `bootstrapping` is `creating`'s twin and was missing for no better reason
 * than that the argument above was written with `create` in mind. It is the
 * status `recreate` parks a row in after launching the replacement instance —
 * with `hermeticd_version` and `config_hash` already set to what this run just
 * pinned and `last_heartbeat` cleared to null (`lifecycle.ts`) — so for the
 * whole bootstrap window the row *describes a box that does not exist yet*.
 * Counting it answers a question about a machine that has never spoken.
 *
 * `stopped` is deliberately *not* here, though nothing on a stopped row is a
 * report either. The list gates `agents_affected`, and a fleet-wide foundation
 * skew affects a powered-off agent exactly as much as a running one — it is a
 * property of the fleet, not of the box. What a stopped agent must not do is
 * count as *behind*, and that is `current`'s job rather than this list's: it is
 * `null` for any agent that has not reported, which `computeSkew` reads as
 * unknown rather than as either answer.
 */
const UNCOUNTED: readonly AgentStatus[] = ["destroyed", "creating", "bootstrapping"];

/** What the skew count considers an agent at all. */
export function counts(status: AgentStatus): boolean {
  return !UNCOUNTED.includes(status);
}

/**
 * Is this agent's applied config the one the fleet rendered for it?
 *
 * The two hashes mean different things and are written by different actors: the
 * laptop writes `config_hash` when it renders and uploads a bundle, and the box
 * writes `applied_config_hash` when it has actually applied one. Before those
 * were separate fields there was one attribute carrying both meanings in turn,
 * which is precisely why drift was invisible — a box that applied an old bundle
 * overwrote the record of what it should have applied.
 *
 * A missing half is `unknown` rather than a guess in either direction. Rows
 * written before the field existed have no applied hash and never will until
 * their box next reports; saying "current" there would be inventing a fact, and
 * saying "drifted" would report the whole fleet as broken on the day this
 * shipped.
 */
export function configVerdict(agent: {
  status?: AgentStatus | undefined;
  config_hash?: string | null | undefined;
  applied_config_hash?: string | null | undefined;
}): ConfigVerdict {
  if (agent.status !== undefined && !reportsItsOwnConfig(agent.status)) return "unknown";
  const desired = agent.config_hash ?? null;
  const applied = agent.applied_config_hash ?? null;
  if (desired === null || applied === null) return "unknown";
  return desired === applied ? "current" : "drifted";
}

/**
 * Statuses in which the row's `applied_config_hash` is a live report, rather
 * than a reading left behind by a box that is no longer in that state.
 *
 * `error` is the one that has to be named. A bootstrap stage writes
 * `/etc/hermetic/manifest.json` before `04-apply` runs — the ordering §6.5's
 * converge no longer uses, but the stage path still does, because there the
 * truth is carried by the status rather than by the file. So a box whose apply
 * failed lands in `error` holding a manifest that names the config it was
 * installing, its heartbeat reports that hash, and the two agree: a green
 * `current` beside a box that is broken in exactly the way the field was meant
 * to reveal. The status already says something is wrong; the config column must
 * not spend its credibility arguing.
 *
 * `UNCOUNTED`'s three are here for the reason they are there — the row
 * describes a box that does not exist yet, or no longer does. Both now clear
 * the field on the way in (`lifecycle.ts`), so this is belt and braces rather
 * than the only guard, which is the right amount for a claim this load-bearing.
 *
 * `stopping`/`destroying` stay answerable: the box is still up and still
 * heartbeating while it winds down, and what it reports is true until it stops.
 */
function reportsItsOwnConfig(status: AgentStatus): boolean {
  return counts(status) && status !== "error";
}

/** One agent, reduced to the three facts a skew is computed from. */
export interface SkewAgent {
  status: AgentStatus;
  /**
   * The agent's reported hermeticd is the release the fleet points at — or
   * `null` when the box has reported no version at all, which is a different
   * answer from "an older one" and must not be collapsed into it.
   */
  current: boolean | null;
  config: ConfigVerdict;
}

export interface SkewInput {
  /** `_fleet.foundation_version`; 0 for a fleet stamped before it existed. */
  fleetVersion: number;
  /** `FOUNDATION_VERSION`: what this build would apply. */
  expectedVersion: number;
  /** The fleet is *ahead* of this build (`FoundationStatus.tool_outdated`). */
  toolOutdated: boolean;
  /** The version, the template digest or the release differs (`update_available`). */
  updateAvailable: boolean;
  agents: readonly SkewAgent[];
}

/**
 * The whole warning, from those facts.
 *
 * The order of the tests is the severity order, and each one is a different
 * question rather than a stricter threshold of the same one:
 *
 * 1. Is the *fleet* newer than this build? Then nothing here can fix it and no
 *    other finding matters — an operator on an outdated build cannot act on a
 *    drifted config either.
 * 2. Is the fleet behind this build? Then the foundation is the skew, it is
 *    fleet-wide, and every live agent is affected by it whether or not that
 *    agent's own versions have moved yet.
 * 3. Otherwise the fleet is current, so anything still behind is an agent
 *    catching up — which resolves itself, and must not be dressed up as
 *    something the operator has failed to do.
 */
export function computeSkew(input: SkewInput): Skew {
  const live = input.agents.filter((a) => counts(a.status));
  /**
   * Strictly `false`, never falsy. `current` is tri-state: `null` means the box
   * has not reported a version, which is not the same as having reported an old
   * one — a stopped agent, or one whose replacement is still booting, reports
   * nothing at all, and `!a.current` counted every one of them as a straggler.
   * Same rule as `config === "drifted"` on the line below, which has always had
   * to be written this way because `ConfigVerdict` has had three states from the
   * day it was split out.
   */
  const behind = live.filter((a) => a.current === false).length;
  const drifted = live.filter((a) => a.config === "drifted").length;
  const base = {
    fleet_version: input.fleetVersion,
    expected_version: input.expectedVersion,
    agents_behind: behind,
    agents_drifted: drifted,
  };

  if (input.toolOutdated) {
    return {
      ...base,
      severity: "blocked",
      headline: `fleet foundation v${input.fleetVersion} · this build only knows v${input.expectedVersion}`,
      message: SKEW_MESSAGE.blocked,
      agents_affected: live.length,
      // Not `SKEW_FIX`: `foundation.update` is exactly the command that refuses
      // here (`FOUNDATION_NEWER`), so offering it would point at a button that
      // cannot work. Upgrading hermetic is the fix, and it is not a command
      // hermetic runs on itself.
      fix: null,
    };
  }

  if (input.updateAvailable) {
    return {
      ...base,
      severity: "degraded",
      headline: `fleet foundation v${input.fleetVersion} · this build expects v${input.expectedVersion}`,
      message: SKEW_MESSAGE.degraded,
      agents_affected: live.length,
      fix: SKEW_FIX,
    };
  }

  if (behind > 0 || drifted > 0) {
    // Counted once: an agent that is both behind *and* drifted is one agent
    // that has not caught up, not two.
    const catching = live.filter((a) => a.current === false || a.config === "drifted").length;
    return {
      ...base,
      severity: "pending",
      headline: `foundation v${input.fleetVersion} is current · ${catching === 1 ? "1 agent has" : `${catching} agents have`} not caught up`,
      message: SKEW_MESSAGE.pending,
      // Only the ones still catching up: the fleet itself is current, so an
      // agent that has taken the release is not affected by anything.
      agents_affected: catching,
      fix: null,
    };
  }

  return {
    ...base,
    severity: "none",
    headline: `foundation v${input.fleetVersion} · up to date`,
    message: SKEW_MESSAGE.none,
    agents_affected: 0,
    fix: null,
  };
}
