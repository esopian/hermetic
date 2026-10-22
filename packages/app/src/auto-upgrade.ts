/**
 * The fleet's opt-in automatic update (`FleetSettings.auto_upgrade`, §6.6):
 * when this app is a strictly newer build than the one that last published to
 * the fleet, it starts the same `artifacts.push` the Update button starts —
 * hermeticd plus every agent's re-rendered config — as an ordinary op, so it
 * shows in the Runs view, `hermetic runs` and `app.log` like any other.
 *
 * Desktop main process only. The CLI never does this: a command an operator
 * typed must do what it says and nothing besides.
 *
 * Fed from two places that already hold a fresh `foundation.status`: the
 * poller's advisory tick (the first one runs at launch, then every minute) and
 * the `meta.get` body the page refreshes from. Neither pays a read for this.
 */
import type { FleetSettings, FoundationStatus } from "@hermetic/core";
import { autoUpgrade } from "@hermetic/core";
import { writeBlocked } from "./handlers/shared.ts";
import type { AppLog } from "./log.ts";
import type { OpRegistry } from "./ops.ts";
import type { AppState } from "./state.ts";

export type AutoUpgradeDecision = { run: true } | { run: false; reason: string };

export interface AutoUpgradeInput {
  settings: Pick<FleetSettings, "auto_upgrade"> | null | undefined;
  status: FoundationStatus;
  /** Any op running in this app, or a teardown/foundation update/switch holding the fleet. */
  opInFlight: boolean;
  /** This process already started one for this fleet. */
  attempted: boolean;
}

/**
 * Whether to start the update now. Pure, so every refusal is a table row in
 * the tests. The status gates come before the setting so a caller can probe
 * them without having read the settings (`createAutoUpgrade`).
 */
export function autoUpgradeDecision(input: AutoUpgradeInput): AutoUpgradeDecision {
  const { status } = input;
  // Strictly newer only: `same` has nothing to move, `older` would move the
  // fleet backwards, and `unknown` cannot tell which — two laptops guessing
  // would push their own render over each other's on every refresh.
  if (status.build_order !== "newer") {
    return { run: false, reason: `build is ${status.build_order ?? "unknown"} than the fleet's` };
  }
  if (status.tool_outdated) return { run: false, reason: "the fleet is ahead of this build" };
  // A foundation update stays a person's decision (it changes AWS resources),
  // and an artifacts push ahead of it would ship what the old stack cannot run.
  if (
    status.fleet.foundation_version !== status.available.foundation_version ||
    status.fleet.template_sha256 !== status.available.template_sha256
  ) {
    return { run: false, reason: "a foundation update is pending, which stays manual" };
  }
  const work =
    (status.fleet.artifacts_version ?? 0) < (status.available.artifacts_version ?? 0) ||
    status.fleet.hermeticd_version !== status.available.hermeticd_version ||
    status.agents.some((a) => a.config === "update");
  if (!work) return { run: false, reason: "nothing to update" };
  if (status.in_progress !== null || input.opInFlight) {
    return { run: false, reason: "an op is already running" };
  }
  if (input.attempted) return { run: false, reason: "already attempted by this process" };
  if (!autoUpgrade(input.settings)) return { run: false, reason: "auto_upgrade is off" };
  return { run: true };
}

export interface AutoUpgrade {
  /**
   * Decide on `status` and start the update if it says so. `settings` is
   * read from the fleet when not given, and only once the status alone would
   * fire. Never throws.
   */
  check(status: FoundationStatus, settings?: FleetSettings | null): Promise<AutoUpgradeDecision>;
}

export function createAutoUpgrade(deps: {
  state: AppState;
  ops: OpRegistry;
  log?: AppLog;
}): AutoUpgrade {
  const { state, ops, log } = deps;
  /**
   * Fleets this process has started one for. One build per process, so the
   * fleet id is the whole (fleet, build) key: a push that failed is not
   * retried in a loop, and is retried on the next launch.
   */
  const attempted = new Set<string>();

  const decide = (
    fleet: string,
    status: FoundationStatus,
    settings: Pick<FleetSettings, "auto_upgrade"> | null | undefined,
  ) =>
    autoUpgradeDecision({
      settings,
      status,
      opInFlight: writeBlocked(state) !== null || ops.list({ status: "running" }).ops.length > 0,
      attempted: attempted.has(fleet),
    });

  return {
    async check(status, settings) {
      const fleet = state.initialized ? state.fleetId : null;
      if (fleet === null) return { run: false, reason: "no fleet" };
      try {
        let read = settings;
        if (read === undefined) {
          const probe = decide(fleet, status, { auto_upgrade: true });
          if (!probe.run) return probe;
          read = (await state.hermetic.settings.get()).settings;
        }
        // Decided again after the await, synchronously up to `ops.start`, so
        // the poller and a page refresh landing together start one op.
        const decision = decide(fleet, status, read);
        if (!decision.run || state.fleetId !== fleet) return decision;
        attempted.add(fleet);
        const h = state.hermetic;
        log?.line("info", "auto-upgrade", "this build is newer than the fleet's; updating it", {
          fleet,
          fleet_artifacts: status.fleet.artifacts_version ?? 0,
          available_artifacts: status.available.artifacts_version ?? 0,
          configs: status.agents.filter((a) => a.config === "update").length,
        });
        // The same start the `artifacts.push` handler makes for the Update button.
        ops.start("artifacts.push", null, (signal) => h.artifacts.push({}, { signal }));
        return decision;
      } catch (e) {
        log?.line(
          "warn",
          "auto-upgrade",
          `check failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return { run: false, reason: "check failed" };
      }
    },
  };
}
