/**
 * The per-agent lifecycle: `agents.create`, `destroy`, `stop`, `start`,
 * `recreate` (§6.2, §6.6).
 *
 * These five are one surface because they are one subject — they share the TTL
 * lock, the §4.3 status machine, the rendered config, and the rule that every
 * step checks reality before acting (§4.5) — and because together they were two
 * thirds of `hermetic.ts`, which is capped at 2500 lines for the good reason
 * that a file nobody can hold in their head is a file nobody reviews.
 *
 * That same cap has since divided them across several files. `create` is in
 * `lifecycle/create-agent.ts` and `recreate` in `lifecycle/recreate-agent.ts`;
 * they are the two that build a box, so the release lookup and the cloud-init
 * document they share sit in `lifecycle/release.ts`, built once here and handed
 * to both. `create`'s `--volume` checks are in `lifecycle/adopt-volume.ts` and
 * its re-run instance wait in `lifecycle/recorded-instance.ts`. `destroy` is in
 * `destroy-agent.ts`, `stop` and `start` are in `power.ts`, and the tailnet
 * sweep `destroy` and `recreate` both run is in `tailnet-devices.ts`. Each of
 * those takes its own explicit deps object, and `createLifecycle` assembles the
 * five into the one surface `hermetic.ts` still asks for.
 *
 * `LifecycleDeps` is `{ ctx }` plus what is the lifecycle's own. The shared
 * helpers — guards, locks, transitions, the render — arrive as one
 * `CoreContext` (`context.ts`); the same shape as `PlanDeps` (`plans.ts`),
 * `TeardownDeps` (`teardown.ts`), `DestroyDeps` (`destroy-agent.ts`) and
 * `PowerDeps` (`power.ts`).
 */
import type { Agent } from "../schema/index.ts";
import type { CoreContext } from "../context.ts";
import type { VolumeReservation } from "../volumes/volume-claims.ts";
import { createDestroy } from "./destroy-agent.ts";
import { createPower } from "./power.ts";
import { createTailnetCleanup } from "../fleet/tailnet-devices.ts";
import { createCreateOp } from "./lifecycle/create-agent.ts";
import { createRecreateOp } from "./lifecycle/recreate-agent.ts";
import { createRelease } from "./lifecycle/release.ts";

/**
 * What the lifecycle needs beyond the shared context: the pinned versions and
 * the guards, locks and render come with `ctx`; what is listed here is the
 * volume reservation the five share with `volumes.delete`, the SSM slot paths
 * (§8) and §8.3's apply, which lives with the profile binding it rewrites.
 */
export interface LifecycleDeps {
  ctx: CoreContext;
  /**
   * §9.1's volume reservation, shared with `volumes.delete`. An adoption holds
   * it from the moment it re-checks the disk under its own lock to the moment
   * the row records ownership; after that the row is the claim.
   */
  volumeClaims: VolumeReservation;

  /* SSM paths (§8) */
  tsKeyPath: (name: string) => string;
  providerKeyPath: (name: string) => string;
  /**
   * Any slot of an agent's own SSM prefix, by name (§8.3). `providerKeyPath`
   * above is the fixed `provider-key` one every legacy row still uses; a row
   * bound to a provider profile names `provider-key-<profile_id>-r<revision>`
   * instead, and
   * which of those it is is a fact about the row rather than about the layout.
   */
  agentSlotPath: (name: string, slot: string) => string;
  /** `/hermetic/<fleet_id>/secrets/<slug>` — a fleet shared slot, by slug. */
  sharedSlotPath: (slug: string) => string;
  bwsPath: (name: string) => string;
  /**
   * §8.3: perform whatever provider change `agents.set` staged on this row, or
   * hand the row back untouched. `recreate` runs it because a rebuild is the
   * moment the box takes a fresh configuration anyway — staging a change and
   * then recreating must not boot the replacement onto the *old* binding.
   */
  applyPending: (agent: Agent) => Promise<Agent>;
}

export function createLifecycle(deps: LifecycleDeps) {
  /**
   * The release lookup and the cloud-init document, built once and handed to
   * both builders: `create` and `recreate` share them so the two can never
   * disagree about what a booting instance is told (§6.3).
   */
  const release = createRelease(deps.ctx);
  const { create } = createCreateOp(deps, release);

  // ─── destroy, stop and start ───────────────────────────────────────────────

  /**
   * Three of the five operations this module names live beside it: `destroy` in
   * `destroy-agent.ts`, `stop` and `start` in `power.ts`, and the tailnet sweep
   * those two share with `recreate` in `tailnet-devices.ts`. Each takes an
   * explicit deps object that `LifecycleDeps` satisfies, so this is the whole of
   * the wiring — none of them reads anything from this closure.
   */
  const { removeTailnetDevices } = createTailnetCleanup(deps.ctx);
  const { destroy } = createDestroy(deps);
  const { stop, start } = createPower(deps);
  const { recreate } = createRecreateOp(deps, { release, removeTailnetDevices });

  return { create, destroy, stop, start, recreate };
}
