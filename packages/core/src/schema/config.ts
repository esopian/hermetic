import { z } from "zod";
import { FleetIdSchema, Iso, AccountId, Region } from "./common.ts";
import { FleetName } from "./directory.ts";

/**
 * One frozen fleet row in the local SQLite file (§4.6). A home may hold several
 * — one per fleet it has been pointed at — keyed by `name`, which is also the
 * name that fleet carries in the account's directory (§4.8).
 *
 * `schema_version` stays `1`: the *row* shape is versioned by the sqlite
 * migration that owns the table, not by a literal in the payload.
 */
export const LocalConfig = z.object({
  schema_version: z.literal(1),
  /**
   * This fleet's optional display alias (§4.6), cached from the account's
   * directory, which owns it. `null` when the fleet has none, and a fleet
   * without one is displayed as its `fleet_id` by every head. It is never the
   * key of anything: the row, the default-fleet preference, the run log and
   * the portal's state are all keyed on `fleet_id`.
   */
  name: FleetName.nullable().default(null),
  fleet_id: FleetIdSchema,
  account_id: AccountId,
  account_alias: z.string().nullable(),
  org_id: z.string().nullable(),
  profile: z.string().min(1),
  region: Region,
  frozen_at: Iso,
  frozen_by: z.string(),
});
export type LocalConfig = z.infer<typeof LocalConfig>;

/** A per-operator override of `_fleet.defaults` (§4.6 `prefs`). */
export const Pref = z.object({
  key: z.string().min(1),
  value: z.string(),
});
export type Pref = z.infer<typeof Pref>;

/**
 * What a recorded run was against (§4.6): the immutable triple that identifies
 * a fleet, plus the display alias it answered to when the command ran.
 *
 * Attribution keys on `fleet_id` and nothing else. `fleet_name` is kept for the
 * same reason a receipt keeps the shop's name: it is what the operator saw at
 * the time, and it may since have moved to another fleet.
 */
export const RunTarget = z.object({
  account_id: AccountId,
  region: Region,
  fleet_id: FleetIdSchema,
  fleet_name: FleetName.nullable(),
});
export type RunTarget = z.infer<typeof RunTarget>;

/** The target a frozen fleet row identifies — what a run against it records. */
export function runTargetFor(config: LocalConfig): RunTarget {
  return {
    account_id: config.account_id,
    region: config.region,
    fleet_id: config.fleet_id,
    fleet_name: config.name,
  };
}

/** One row of the local command run log (§4.6 `runs`). */
export const Run = z.object({
  id: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  agent: z.string().nullable(),
  started_at: Iso,
  finished_at: Iso.nullable(),
  exit_code: z.number().int().nullable(),
  log: z.string(),
  /**
   * The `fleet_id` the command was against (§4.8) — the column is called
   * `fleet` because it predates the rest of the target and rows written under
   * that name are history worth keeping.
   *
   * Null for a command that resolved no fleet: one that failed before core
   * chose one, one against a home with none, and every row written before
   * migration v4. A reader shows a null as *unknown* and never as the fleet it
   * happens to have open — a run log that guesses is worse than one that says
   * nothing, because a guess reads as an answer.
   */
  fleet: z.string().nullable(),
  /**
   * The rest of the resolved target (§4.6), written once the command knows
   * what it is talking to. Null together with `fleet` on a run that never got
   * that far, and on every row written before migration v6.
   *
   * Loose `z.string()` rather than the strict `AccountId`/`Region`/`FleetName`
   * that `RunTarget` validates on the way in: this is the *reading* end of a
   * table that outlives several builds, and a row whose account id no longer
   * matches today's regex is a row to display, not one to fail a list over.
   */
  account_id: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  /** The display alias at the time, which may since have moved (§4.8). */
  fleet_name: z.string().nullable().default(null),
});
export type Run = z.infer<typeof Run>;
