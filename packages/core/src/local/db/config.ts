import type { Database } from "bun:sqlite";
import type { LocalConfig, Pref } from "../../schema/index.ts";
import { LocalConfig as LocalConfigSchema } from "../../schema/index.ts";

/** §4.8: `prefs` keys the fleet directory owns. */
export const PREF_DEFAULT_FLEET = "default_fleet";
export const PREF_DIRECTORY_REGION = "directory_region";

interface FleetRow {
  name: string | null;
  schema_version: number;
  fleet_id: string;
  account_id: string;
  account_alias: string | null;
  org_id: string | null;
  profile: string;
  region: string;
  frozen_at: string;
  frozen_by: string;
}

/** A row is only a config if it still validates; a half-written one reads as absent. */
function toConfig(row: FleetRow | null): LocalConfig | null {
  if (!row) return null;
  const parsed = LocalConfigSchema.safeParse({
    schema_version: row.schema_version,
    name: row.name,
    fleet_id: row.fleet_id,
    account_id: row.account_id,
    account_alias: row.account_alias,
    org_id: row.org_id,
    profile: row.profile,
    region: row.region,
    frozen_at: row.frozen_at,
    frozen_by: row.frozen_by,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Every fleet frozen in this home (§4.8), by immutable id. The list
 * `resolveFleetId` chooses from, and the local half of `fleets.list`.
 */
export function listConfigs(db: Database): LocalConfig[] {
  let rows: FleetRow[];
  try {
    rows = db.query(`SELECT * FROM fleets ORDER BY name`).all() as FleetRow[];
  } catch {
    return [];
  }
  return rows.flatMap((row) => {
    const config = toConfig(row);
    return config ? [config] : [];
  });
}

/**
 * One frozen fleet, by id — or, with no id, the one this home would use if
 * nothing said otherwise: the recorded default, else the only row there is.
 *
 * Deliberately non-throwing where `resolveFleetId` refuses: this is the read
 * `init` and the run log use to ask "is anything frozen here at all", and an
 * ambiguous home is *not* an answer to that question, so it reads as `null` and
 * the entrypoints that need the refusal (`open.ts`) run the selection rule.
 */
export function readConfig(db: Database, fleetId?: string): LocalConfig | null {
  if (fleetId !== undefined) {
    let row: FleetRow | null;
    try {
      row = db.query(`SELECT * FROM fleets WHERE fleet_id = ?`).get(fleetId) as FleetRow | null;
    } catch {
      return null;
    }
    return toConfig(row);
  }
  const rows = listConfigs(db);
  if (rows.length === 0) return null;
  const preferred = defaultFleet(db);
  const chosen = preferred !== null ? rows.find((r) => r.fleet_id === preferred) : undefined;
  if (chosen) return chosen;
  return rows.length === 1 ? (rows[0] as LocalConfig) : null;
}

/**
 * Freeze a fleet into this home. The immutable id owns the row; `name` is a
 * display cache refreshed from the directory and has no local uniqueness rule.
 */
export function writeConfig(db: Database, config: LocalConfig): void {
  const parsed = LocalConfigSchema.parse(config);
  const write = db.transaction(() => {
    db.run(
      `INSERT INTO fleets (name, schema_version, fleet_id, account_id, account_alias, org_id, profile, region, frozen_at, frozen_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fleet_id) DO UPDATE SET
         name           = excluded.name,
         schema_version = excluded.schema_version,
         fleet_id       = excluded.fleet_id,
         account_id     = excluded.account_id,
         account_alias  = excluded.account_alias,
         org_id         = excluded.org_id,
         profile        = excluded.profile,
         region         = excluded.region,
         frozen_at      = excluded.frozen_at,
         frozen_by      = excluded.frozen_by`,
      [
        parsed.name,
        parsed.schema_version,
        parsed.fleet_id,
        parsed.account_id,
        parsed.account_alias,
        parsed.org_id,
        parsed.profile,
        parsed.region,
        parsed.frozen_at,
        parsed.frozen_by,
      ],
    );
  });
  write();
}

/**
 * Forget one fleet — `teardown --reset-local`, which unmade exactly one of them
 * (§4.8). With no name it forgets every fleet, which is what `init --reset` on
 * a single-fleet home has always meant. A default pointing at a row that just
 * went is cleared with it.
 */
export function clearConfig(db: Database, fleetId?: string): void {
  const clear = db.transaction(() => {
    if (fleetId === undefined) db.run(`DELETE FROM fleets`);
    else db.run(`DELETE FROM fleets WHERE fleet_id = ?`, [fleetId]);
    const preferred = defaultFleet(db);
    if (preferred !== null && readConfig(db, preferred) === null) {
      db.run(`DELETE FROM prefs WHERE key = ?`, [PREF_DEFAULT_FLEET]);
    }
  });
  clear();
}

/** `hermetic fleet use <name>` (§4.8): which fleet a bare command means here. */
export function defaultFleet(db: Database): string | null {
  return readPref(db, PREF_DEFAULT_FLEET);
}

export function setDefaultFleet(db: Database, name: string | null): void {
  if (name === null) db.run(`DELETE FROM prefs WHERE key = ?`, [PREF_DEFAULT_FLEET]);
  else writePref(db, PREF_DEFAULT_FLEET, name);
}

/**
 * The region this account's directory table lives in (§4.8), remembered by
 * `init` so no later command has to be told again. `null` until one succeeds.
 */
export function directoryRegion(db: Database): string | null {
  return readPref(db, PREF_DIRECTORY_REGION);
}

export function setDirectoryRegion(db: Database, region: string): void {
  writePref(db, PREF_DIRECTORY_REGION, region);
}

function readPref(db: Database, key: string): string | null {
  try {
    const row = db.query(`SELECT value FROM prefs WHERE key = ?`).get(key) as { value: string } | null;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function readPrefs(db: Database): Pref[] {
  return (db.query(`SELECT key, value FROM prefs ORDER BY key`).all() as Pref[]).map((p) => ({
    key: p.key,
    value: p.value,
  }));
}

export function writePref(db: Database, key: string, value: string): void {
  db.run(
    `INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}
