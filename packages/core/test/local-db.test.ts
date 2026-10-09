import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  DB_FILENAME,
  FIXTURE_DB_FILENAME,
  MemoryRunStore,
  SqliteLocalChatSessions,
  SqliteRunStore,
  archiveRuns,
  clearConfig,
  corruptRename,
  defaultFleet,
  directoryRegion,
  hermeticHome,
  listConfigs,
  migrate,
  openLocalDb,
  openPendingOpStore,
  openRunRecorder,
  openRunStore,
  readConfig,
  readPrefs,
  recordRun,
  runRecorderFor,
  setDefaultFleet,
  setDirectoryRegion,
  writeConfig,
  writePref,
} from "../src/local/db/index.ts";
import { FIXTURE_CONFIG } from "../src/backend/memory.ts";
import { openHermetic } from "../src/open.ts";
import type { LocalConfig } from "../src/schema/index.ts";

/** Never the operator's real `~/.hermetic` — always a scratch home (§4.6). */
const SCRATCH = tmpdir();

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(SCRATCH, "hermetic-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const CONFIG: LocalConfig = { ...FIXTURE_CONFIG };

/**
 * The schema as it stood at migration v3, written out so the v4 migration can
 * be exercised against a database this build did not create. Copying it here
 * rather than importing it is the point: a migration test that shared its
 * "before" with the code under test would only ever prove the code agrees with
 * itself.
 */
const V3_SCHEMA: readonly string[] = [
  `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`,
  `CREATE TABLE config (
     id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, fleet_id TEXT NOT NULL,
     account_id TEXT NOT NULL, account_alias TEXT, org_id TEXT, profile TEXT NOT NULL,
     region TEXT NOT NULL, frozen_at TEXT NOT NULL, frozen_by TEXT NOT NULL)`,
  `CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY, command TEXT NOT NULL, args TEXT NOT NULL, agent TEXT,
     started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, log TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE runs_archive (
     id TEXT PRIMARY KEY, command TEXT NOT NULL, args TEXT NOT NULL, agent TEXT,
     started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, log TEXT NOT NULL DEFAULT '',
     archived_at TEXT NOT NULL)`,
  `CREATE TABLE teardowns (
     id TEXT PRIMARY KEY, at TEXT NOT NULL, fleet_id TEXT NOT NULL, account_id TEXT NOT NULL,
     region TEXT NOT NULL, stack_name TEXT NOT NULL, outcome TEXT NOT NULL, receipt TEXT NOT NULL)`,
  `CREATE TABLE pending_ops (
     id TEXT PRIMARY KEY, method TEXT NOT NULL, target TEXT, input TEXT NOT NULL,
     started_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)`,
  `INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-01-01T00:00:00.000Z'),
     (2, '2026-01-01T00:00:00.000Z'), (3, '2026-01-01T00:00:00.000Z')`,
];

/**
 * A v4 home: `fleets` keyed by the fleet's *name*, `prefs.default_fleet` and
 * every `fleet` column holding that name. What the v5 migration has to rewrite.
 */
const V4_SCHEMA: readonly string[] = [
  `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`,
  `CREATE TABLE fleets (
     name TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, fleet_id TEXT NOT NULL UNIQUE,
     account_id TEXT NOT NULL, account_alias TEXT, org_id TEXT, profile TEXT NOT NULL,
     region TEXT NOT NULL, frozen_at TEXT NOT NULL, frozen_by TEXT NOT NULL)`,
  `CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY, command TEXT NOT NULL, args TEXT NOT NULL, agent TEXT,
     started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, log TEXT NOT NULL DEFAULT '',
     fleet TEXT)`,
  `CREATE TABLE runs_archive (
     id TEXT PRIMARY KEY, command TEXT NOT NULL, args TEXT NOT NULL, agent TEXT,
     started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, log TEXT NOT NULL DEFAULT '',
     archived_at TEXT NOT NULL, fleet TEXT)`,
  `CREATE TABLE teardowns (
     id TEXT PRIMARY KEY, at TEXT NOT NULL, fleet_id TEXT NOT NULL, account_id TEXT NOT NULL,
     region TEXT NOT NULL, stack_name TEXT NOT NULL, outcome TEXT NOT NULL, receipt TEXT NOT NULL)`,
  `CREATE TABLE pending_ops (
     id TEXT PRIMARY KEY, method TEXT NOT NULL, target TEXT, input TEXT NOT NULL,
     started_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, fleet TEXT)`,
  `INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-01-01T00:00:00.000Z'),
     (2, '2026-01-01T00:00:00.000Z'), (3, '2026-01-01T00:00:00.000Z'),
     (4, '2026-01-01T00:00:00.000Z')`,
];

/** A v4 home holding one fleet called `main`, referenced by name everywhere. */
function seedV4(path: string, second?: { name: string; fleet_id: string }): void {
  const legacy = new Database(path, { create: true });
  for (const statement of V4_SCHEMA) legacy.run(statement);
  const fleet = (name: string, fleet_id: string): void => {
    legacy.run(
      `INSERT INTO fleets (name, schema_version, fleet_id, account_id, account_alias, org_id, profile, region, frozen_at, frozen_by)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        fleet_id,
        CONFIG.account_id,
        CONFIG.account_alias,
        CONFIG.org_id,
        CONFIG.profile,
        CONFIG.region,
        CONFIG.frozen_at,
        CONFIG.frozen_by,
      ],
    );
  };
  fleet("main", CONFIG.fleet_id);
  if (second) fleet(second.name, second.fleet_id);
  legacy.run(`INSERT INTO prefs (key, value) VALUES ('default_fleet', 'main')`);
  legacy.run(
    `INSERT INTO runs (id, command, args, started_at, fleet) VALUES ('r1', 'agent ps', '[]', ?, 'main'), ('r2', 'agent ps', '[]', ?, NULL)`,
    [CONFIG.frozen_at, CONFIG.frozen_at],
  );
  legacy.run(
    `INSERT INTO runs_archive (id, command, args, started_at, archived_at, fleet) VALUES ('a1', 'agent ps', '[]', ?, ?, 'main')`,
    [CONFIG.frozen_at, CONFIG.frozen_at],
  );
  legacy.run(
    `INSERT INTO pending_ops (id, method, target, input, started_at, fleet) VALUES ('p1', 'agents.create', 'atlas', '{}', ?, 'main')`,
    [CONFIG.frozen_at],
  );
  legacy.close();
}

/**
 * A v5 home, written out by hand: everything `origin/master`'s five migrations
 * leave behind, and a ledger recording them the way builds before the named
 * scheme did — a bare number and a timestamp, nothing else.
 *
 * Copied rather than imported for the same reason `V3_SCHEMA` and `V4_SCHEMA`
 * are. This is the "before" the ledger has to reason about on a real laptop,
 * and a fixture generated by the code under test would only prove that code
 * agrees with itself.
 */
const V5_SCHEMA: readonly string[] = [
  `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`,
  `CREATE TABLE fleets (
     fleet_id TEXT PRIMARY KEY, name TEXT, schema_version INTEGER NOT NULL,
     account_id TEXT NOT NULL, account_alias TEXT, org_id TEXT, profile TEXT NOT NULL,
     region TEXT NOT NULL, frozen_at TEXT NOT NULL, frozen_by TEXT NOT NULL)`,
  `CREATE INDEX fleets_name ON fleets (name)`,
  `CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY, command TEXT NOT NULL, args TEXT NOT NULL, agent TEXT,
     started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, log TEXT NOT NULL DEFAULT '',
     fleet TEXT)`,
  `CREATE TABLE runs_archive (
     id TEXT PRIMARY KEY, command TEXT NOT NULL, args TEXT NOT NULL, agent TEXT,
     started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, log TEXT NOT NULL DEFAULT '',
     archived_at TEXT NOT NULL, fleet TEXT)`,
  `CREATE TABLE teardowns (
     id TEXT PRIMARY KEY, at TEXT NOT NULL, fleet_id TEXT NOT NULL, account_id TEXT NOT NULL,
     region TEXT NOT NULL, stack_name TEXT NOT NULL, outcome TEXT NOT NULL, receipt TEXT NOT NULL)`,
  `CREATE TABLE pending_ops (
     id TEXT PRIMARY KEY, method TEXT NOT NULL, target TEXT, input TEXT NOT NULL,
     started_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, fleet TEXT)`,
  `INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-01-01T00:00:00.000Z'),
     (2, '2026-01-01T00:00:00.000Z'), (3, '2026-01-01T00:00:00.000Z'),
     (4, '2026-01-01T00:00:00.000Z'), (5, '2026-01-01T00:00:00.000Z')`,
];

/** A v5 home holding one fleet, referenced by id, with a default set. */
function seedV5(path: string, extra: readonly string[] = []): void {
  const legacy = new Database(path, { create: true });
  for (const statement of [...V5_SCHEMA, ...extra]) legacy.run(statement);
  legacy.run(
    `INSERT INTO fleets (fleet_id, name, schema_version, account_id, account_alias, org_id, profile, region, frozen_at, frozen_by)
     VALUES (?, 'main', 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      CONFIG.fleet_id,
      CONFIG.account_id,
      CONFIG.account_alias,
      CONFIG.org_id,
      CONFIG.profile,
      CONFIG.region,
      CONFIG.frozen_at,
      CONFIG.frozen_by,
    ],
  );
  legacy.run(`INSERT INTO prefs (key, value) VALUES ('default_fleet', ?)`, [CONFIG.fleet_id]);
  legacy.close();
}

/** The ledger as rows, in the order a reader would read it. */
function ledger(db: Database): Array<{ version: number; name: string | null; applied_at: string }> {
  return db
    .query(`SELECT version, name, applied_at FROM schema_migrations ORDER BY version, name`)
    .all() as Array<{ version: number; name: string | null; applied_at: string }>;
}

function tablesIn(db: Database): string[] {
  return (
    db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe("the local database", () => {
  test("HERMETIC_HOME wins over ~/.hermetic", () => {
    const previous = process.env["HERMETIC_HOME"];
    process.env["HERMETIC_HOME"] = home;
    try {
      expect(hermeticHome()).toBe(home);
      // An explicit override still wins over the environment.
      expect(hermeticHome("/elsewhere")).toBe("/elsewhere");
    } finally {
      if (previous === undefined) delete process.env["HERMETIC_HOME"];
      else process.env["HERMETIC_HOME"] = previous;
    }
  });

  test("migrations are idempotent", () => {
    const local = openLocalDb({ home });
    // Re-running every migration on an up-to-date file changes nothing.
    migrate(local.db);
    migrate(local.db);
    const applied = local.db
      .query(`SELECT version FROM schema_migrations ORDER BY version`)
      .all() as Array<{ version: number }>;
    expect(applied.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

    const tables = (
      local.db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    // §4.8: `config` became `fleets`, and v5 re-keyed that on `fleet_id`.
    expect(tables).not.toContain("config");
    expect(tables).toContain("fleets");
    expect(tables).toContain("prefs");
    // §4.6: the permanent teardown record, which nothing clears.
    expect(tables).toContain("teardowns");
    expect(tables).toContain("runs");
    // §4.9: the operator's inbox, and the fleet scan's memory of what
    // it last saw — both local, both beside `runs`.
    expect(tables).toContain("notifications");
    expect(tables).toContain("notification_mutes");
    expect(tables).toContain("agent_status_seen");
    local.close();

    // And re-opening the same home is a no-op too.
    const again = openLocalDb({ home });
    expect(again.corruptedTo).toBeNull();
    again.close();
  });

  test("a fleet row round-trips, and writing it again replaces it", () => {
    const local = openLocalDb({ home });
    expect(readConfig(local.db)).toBeNull();

    writeConfig(local.db, CONFIG);
    expect(readConfig(local.db)).toEqual(CONFIG);

    // A second write for the same fleet id replaces rather than adds (§4.6).
    writeConfig(local.db, { ...CONFIG, region: "eu-west-1", account_alias: null });
    const rows = local.db.query(`SELECT COUNT(*) AS n FROM fleets`).get() as { n: number };
    expect(rows.n).toBe(1);
    expect(readConfig(local.db)!.region).toBe("eu-west-1");
    expect(readConfig(local.db)!.account_alias).toBeNull();

    clearConfig(local.db);
    expect(readConfig(local.db)).toBeNull();
    local.close();
  });

  /** §4.8: a home may hold several, and the selection rule chooses between them. */
  test("several fleets live side by side, keyed by fleet id", () => {
    const local = openLocalDb({ home });
    writeConfig(local.db, CONFIG);
    writeConfig(local.db, { ...CONFIG, name: "staging", fleet_id: "sg7k2m4p" });
    expect(listConfigs(local.db).map((c) => c.name)).toEqual(["main", "staging"]);

    // Ambiguous with no default: `readConfig` answers nothing rather than guessing.
    expect(readConfig(local.db)).toBeNull();
    setDefaultFleet(local.db, "sg7k2m4p");
    expect(readConfig(local.db)!.fleet_id).toBe("sg7k2m4p");
    expect(defaultFleet(local.db)).toBe("sg7k2m4p");

    // Forgetting one leaves the other, and takes the stale default with it.
    clearConfig(local.db, "sg7k2m4p");
    expect(listConfigs(local.db).map((c) => c.fleet_id)).toEqual([CONFIG.fleet_id]);
    expect(defaultFleet(local.db)).toBeNull();
    local.close();
  });

  /**
   * §4.6: two fleets may both be aliasless, and both rows have to survive —
   * the row key is the `fleet_id`, and nothing in SQLite arbitrates aliases.
   */
  test("two aliasless fleets are two rows", () => {
    const local = openLocalDb({ home });
    writeConfig(local.db, { ...CONFIG, name: null });
    writeConfig(local.db, { ...CONFIG, name: null, fleet_id: "sg7k2m4p" });
    expect(
      listConfigs(local.db)
        .map((c) => c.fleet_id)
        .sort(),
    ).toEqual([CONFIG.fleet_id, "sg7k2m4p"]);
    expect(listConfigs(local.db).every((c) => c.name === null)).toBe(true);
    local.close();
  });

  /** `fleet alias` refreshes the cached label in place: same fleet_id, one row. */
  test("a write under a new alias updates the row with the same fleet_id", () => {
    const local = openLocalDb({ home });
    writeConfig(local.db, CONFIG);
    writeConfig(local.db, { ...CONFIG, name: "renamed" });
    expect(listConfigs(local.db).map((c) => c.name)).toEqual(["renamed"]);
    writeConfig(local.db, { ...CONFIG, name: null });
    expect(listConfigs(local.db).map((c) => c.name)).toEqual([null]);
    local.close();
  });

  /**
   * §4.6: two homes may cache the same alias briefly while another laptop moves
   * it. SQLite must not arbitrate that — the directory does — so a duplicate
   * cached label is stored rather than refused.
   */
  test("two rows may cache the same alias without the write failing", () => {
    const local = openLocalDb({ home });
    writeConfig(local.db, CONFIG);
    writeConfig(local.db, { ...CONFIG, fleet_id: "sg7k2m4p" });
    expect(listConfigs(local.db).map((c) => c.name)).toEqual(["main", "main"]);
    local.close();
  });

  test("the directory region is remembered once and read back", () => {
    const local = openLocalDb({ home });
    expect(directoryRegion(local.db)).toBeNull();
    setDirectoryRegion(local.db, "eu-central-1");
    expect(directoryRegion(local.db)).toBe("eu-central-1");
    local.close();
  });

  test("a row that no longer validates reads as no config at all", () => {
    const local = openLocalDb({ home });
    writeConfig(local.db, CONFIG);
    local.db.run(`UPDATE fleets SET account_id = 'not-twelve-digits' WHERE name = ?`, [CONFIG.name]);
    // hermetic refuses to run without a *valid* frozen row; `init` fixes it.
    expect(readConfig(local.db)).toBeNull();
    local.close();
  });

  /**
   * §4.8's migration: a home frozen before fleets had names keeps running. Its
   * one row becomes a `fleets` row named by its own `fleet_id` — already a valid
   * name, and one that cannot collide with a fleet created later — and it
   * becomes the default, so nothing about that laptop's commands changes.
   */
  test("a v3 database migrates its config row into an aliased, default fleet", () => {
    const path = join(home, DB_FILENAME);
    const legacy = new Database(path, { create: true });
    for (const statement of V3_SCHEMA) legacy.run(statement);
    legacy.run(
      `INSERT INTO config (id, schema_version, fleet_id, account_id, account_alias, org_id, profile, region, frozen_at, frozen_by)
       VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        CONFIG.fleet_id,
        CONFIG.account_id,
        CONFIG.account_alias,
        CONFIG.org_id,
        CONFIG.profile,
        CONFIG.region,
        CONFIG.frozen_at,
        CONFIG.frozen_by,
      ],
    );
    legacy.run(`INSERT INTO runs (id, command, args, started_at) VALUES ('r1', 'agent ps', '[]', ?)`, [
      CONFIG.frozen_at,
    ]);
    legacy.close();

    const local = openLocalDb({ home });
    const migrated = listConfigs(local.db);
    expect(migrated).toHaveLength(1);
    // The one fleet a legacy home held keeps `main` as its display alias — it
    // is what that home has always called it. The *default* is re-recorded as
    // the fleet id by the v5 migration, because an alias can move (§4.6).
    expect(migrated[0]!.name).toBe("main");
    expect(migrated[0]!.fleet_id).toBe(CONFIG.fleet_id);
    expect(defaultFleet(local.db)).toBe(CONFIG.fleet_id);
    // The run log came through, and now carries a (null) fleet column.
    const runs = local.db.query(`SELECT id, fleet FROM runs`).all() as Array<{
      id: string;
      fleet: string | null;
    }>;
    expect(runs).toEqual([{ id: "r1", fleet: null }]);
    local.close();
  });

  /**
   * §4.6: the v5 migration is the one that moves identity off the label. Every
   * *reference* to a fleet has to be rewritten before the table it resolves
   * through is re-keyed, or there is nothing left to resolve with.
   */
  test("a v4 database rewrites every reference from the fleet name to its id", () => {
    seedV4(join(home, DB_FILENAME));

    const local = openLocalDb({ home });
    // The row survives, alias and all, and is now keyed by its id.
    const rows = listConfigs(local.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("main");
    expect(rows[0]!.fleet_id).toBe(CONFIG.fleet_id);

    expect(defaultFleet(local.db)).toBe(CONFIG.fleet_id);
    const runs = local.db.query(`SELECT id, fleet FROM runs ORDER BY id`).all() as Array<{
      id: string;
      fleet: string | null;
    }>;
    // A run that named the fleet now names its id; one that named none still
    // names none — a row with nothing to resolve is history, not a row to blank.
    expect(runs).toEqual([
      { id: "r1", fleet: CONFIG.fleet_id },
      { id: "r2", fleet: null },
    ]);
    expect(
      (local.db.query(`SELECT fleet FROM runs_archive WHERE id = 'a1'`).get() as { fleet: string })
        .fleet,
    ).toBe(CONFIG.fleet_id);
    expect(
      (local.db.query(`SELECT fleet FROM pending_ops WHERE id = 'p1'`).get() as { fleet: string })
        .fleet,
    ).toBe(CONFIG.fleet_id);

    // And re-running it changes nothing: `migrate` is applied-version gated,
    // but the statements themselves are written to be safe twice over.
    migrate(local.db);
    migrate(local.db);
    expect(defaultFleet(local.db)).toBe(CONFIG.fleet_id);
    expect(listConfigs(local.db).map((c) => c.fleet_id)).toEqual([CONFIG.fleet_id]);
    expect(
      (local.db.query(`SELECT fleet FROM runs WHERE id = 'r1'`).get() as { fleet: string }).fleet,
    ).toBe(CONFIG.fleet_id);
    local.close();
  });

  /**
   * §4.6: the target columns. A run says which account, region and `fleet_id`
   * it was against, plus the alias at the time — and a database written before
   * they existed keeps every row it had, holding null for all four.
   */
  test("an older database gains the target columns without losing a row", async () => {
    seedV4(join(home, DB_FILENAME));

    const local = openLocalDb({ home });
    for (const table of ["runs", "runs_archive"]) {
      const columns = (
        local.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(columns).toContain("account_id");
      expect(columns).toContain("region");
      expect(columns).toContain("fleet_name");
    }

    // The v4 rows read back through the schema, unattributed but intact: the
    // run genuinely does not know its account, and inventing one from today's
    // config would be the guess this whole change exists to stop making.
    const rows = await new SqliteRunStore(local.db).list();
    expect(rows.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    for (const row of rows) {
      expect(row.account_id).toBeNull();
      expect(row.region).toBeNull();
      expect(row.fleet_name).toBeNull();
    }
    // A row recorded from here on carries the whole target, and archiving
    // carries it across with the row.
    recordRun(local.db, {
      id: "r3",
      command: "agent ps",
      fleet: CONFIG.fleet_id,
      account_id: CONFIG.account_id,
      region: CONFIG.region,
      fleet_name: "main",
    });
    archiveRuns(local.db);
    const archived = local.db
      .query(`SELECT account_id, region, fleet_name FROM runs_archive WHERE id = 'r3'`)
      .get() as { account_id: string; region: string; fleet_name: string };
    expect(archived).toEqual({
      account_id: CONFIG.account_id,
      region: CONFIG.region,
      fleet_name: "main",
    });
    local.close();
  });

  /**
   * §4.6: the v5 table drops the `UNIQUE` the v4 one had on the label. It is a
   * cache of something the account's directory owns, and two rows may hold the
   * same one while this laptop catches up with another's alias edit — SQLite
   * arbitrating that would turn a stale cache into a failed write.
   */
  test("a migrated v4 database accepts two rows caching one alias", () => {
    seedV4(join(home, DB_FILENAME), { name: "staging", fleet_id: "sg7k2m4p" });

    const local = openLocalDb({ home });
    expect(listConfigs(local.db)).toHaveLength(2);
    writeConfig(local.db, { ...CONFIG, name: "staging", fleet_id: CONFIG.fleet_id });
    expect(
      listConfigs(local.db)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["staging", "staging"]);
    local.close();
  });

  /** §4.7 step 5: rename, continue, lose only the runs log. */
  test("an unreadable database is renamed aside and a fresh one takes its place", () => {
    const path = join(home, DB_FILENAME);
    writeFileSync(path, "this is not a sqlite file, it is a haiku about one\n".repeat(40));

    const local = openLocalDb({ home });
    expect(local.corruptedTo).not.toBeNull();
    expect(local.corruptedTo).toContain(`${DB_FILENAME}.corrupt-`);
    expect(existsSync(local.corruptedTo!)).toBe(true);

    // The fresh file is usable straight away.
    writeConfig(local.db, CONFIG);
    expect(readConfig(local.db)).toEqual(CONFIG);
    local.close();

    expect(readdirSync(home).filter((f) => f.startsWith(`${DB_FILENAME}.corrupt-`))).toHaveLength(1);
  });

  test("corruptRename is a no-op when there is nothing to rename", () => {
    expect(corruptRename(join(home, "absent.db"))).toBeNull();
  });

  test("prefs are per-operator overrides, keyed and upsertable", () => {
    const local = openLocalDb({ home });
    writePref(local.db, "size", "large");
    writePref(local.db, "browser", "false");
    writePref(local.db, "size", "small");
    expect(readPrefs(local.db)).toEqual([
      { key: "browser", value: "false" },
      { key: "size", value: "small" },
    ]);
    local.close();
  });
});

/**
 * The ledger keys migrations by **name** (see `MIGRATIONS` in `local/db.ts`).
 * These tests exist because the numbered scheme it replaced silently lost a
 * whole feature: eight worktrees of this repository share one
 * `~/.hermetic/hermetic.db`, two of them claimed migration 6 for something
 * else, and this branch's migration 6 — the notification inbox — was therefore
 * skipped forever on a laptop whose ledger said it had run.
 */
describe("the migration ledger", () => {
  /**
   * The names as shipped. Pinned here on purpose: a name is the only record
   * that a particular migration ran on somebody's laptop, so editing one is a
   * breaking change and this list is what makes that impossible to do quietly.
   */
  const NAMES = [
    "initial-config-prefs-runs",
    "teardown-receipts",
    "pending-ops",
    "fleets-by-name",
    "fleets-by-id",
    "notifications-inbox",
    "runs-fleet-target",
    "pending-ops-fleet-identity",
    "pending-ops-phase-retry",
    "chat-local-sessions",
    "instance-listening",
    "chat-turn-fence",
    "notifications-cleared-snoozed",
    "notifications-restored",
  ];

  test("a fresh home gets every table, and a named ledger row for each migration", () => {
    const local = openLocalDb({ home });

    const rows = ledger(local.db);
    expect(rows.map((r) => r.name)).toEqual(NAMES);
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

    const tables = tablesIn(local.db);
    for (const table of [
      "fleets",
      "prefs",
      "runs",
      "runs_archive",
      "teardowns",
      "pending_ops",
      "notifications",
      "notification_mutes",
      "agent_status_seen",
      "chat_local_sessions",
    ]) {
      expect(tables).toContain(table);
    }
    local.close();
  });

  /**
   * The bug, exactly as it was found: a v5 home carrying an unnamed `6` that a
   * sibling branch wrote for a migration of its own. The number is taken; the
   * name is not, so this branch's migration runs and the inbox exists.
   */
  test("a numbered row another branch wrote does not hide this branch's migration", () => {
    const path = join(home, DB_FILENAME);
    seedV5(path, [
      // A sibling branch's migration 6: its own table, and its own bare row.
      `CREATE TABLE sibling_widgets (id TEXT PRIMARY KEY, note TEXT NOT NULL)`,
      `INSERT INTO sibling_widgets (id, note) VALUES ('w1', 'another branch owns this')`,
      `INSERT INTO schema_migrations (version, applied_at) VALUES (6, '2026-09-14T21:13:03.160Z')`,
    ]);

    const local = openLocalDb({ home });

    const tables = tablesIn(local.db);
    expect(tables).toContain("notifications");
    expect(tables).toContain("notification_mutes");
    expect(tables).toContain("agent_status_seen");
    // A table this branch has never heard of is left completely alone.
    expect(tables).toContain("sibling_widgets");
    expect(local.db.query(`SELECT COUNT(*) AS n FROM sibling_widgets`).get()).toEqual({ n: 1 });

    const rows = ledger(local.db);
    // The sibling's row stays, unnamed and untouched, beside this branch's.
    expect(rows.filter((r) => r.version === 6 && r.name === null)).toEqual([
      { version: 6, name: null, applied_at: "2026-09-14T21:13:03.160Z" },
    ]);
    expect(rows.filter((r) => r.name === "notifications-inbox")).toHaveLength(1);
    // The five legacy migrations are still recorded only as numbers, because
    // their numbered rows were trusted and so they never re-ran.
    expect(rows.filter((r) => r.name === null).map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6]);
    local.close();
  });

  test("a home already carrying this branch's named row does not re-run it", () => {
    const local = openLocalDb({ home });
    const before = ledger(local.db);
    local.db.run(`INSERT INTO notifications (id, at, source, kind, class, title)
                    VALUES ('n1', '2026-09-17T00:00:00.000Z', 'operation', 'operation.done', 'fyi', 'hello')`);

    migrate(local.db);
    migrate(local.db);

    // Same rows, same timestamps: nothing ran a second time.
    expect(ledger(local.db)).toEqual(before);
    expect(local.db.query(`SELECT COUNT(*) AS n FROM notifications`).get()).toEqual({ n: 1 });
    local.close();
  });

  /**
   * The safety property the legacy window exists for. Migration 5 moves rows
   * out of `fleets_by_name` and drops it, and migration 4 drops `config` and
   * adds columns that already exist — re-running either against a migrated
   * database throws. Both are inside 1–5, where a bare number is trusted, so a
   * v5 home must come through `migrate` untouched rather than blowing up.
   */
  test("the legacy 1-5 window is never re-run against an already-migrated database", () => {
    const path = join(home, DB_FILENAME);
    seedV5(path);

    const local = openLocalDb({ home });

    expect(readConfig(local.db)).toEqual({ ...CONFIG, name: "main" });
    expect(defaultFleet(local.db)).toBe(CONFIG.fleet_id);
    // Migration 5's scratch table would exist again if it had re-run.
    expect(tablesIn(local.db)).not.toContain("fleets_by_name");
    expect(
      ledger(local.db)
        .filter((r) => r.name !== null)
        .map((r) => r.name),
    ).toEqual(NAMES.slice(5));

    // And it stays a no-op however many times the home is opened.
    migrate(local.db);
    expect(readConfig(local.db)).toEqual({ ...CONFIG, name: "main" });
    local.close();
  });
});

describe("the runs log", () => {
  function seeded(db: Database) {
    recordRun(db, {
      id: "r1",
      command: "agent ps",
      args: ["--json"],
      started_at: "2026-09-01T10:00:00.000Z",
      finished_at: "2026-09-01T10:00:01.000Z",
      exit_code: 0,
      log: "eleven agents",
    });
    recordRun(db, {
      id: "r2",
      command: "agent create",
      args: ["atlas"],
      agent: "atlas",
      started_at: "2026-09-01T11:00:00.000Z",
      finished_at: null,
      exit_code: null,
      log: "",
    });
  }

  test("records, lists newest-first, filters by agent and honours --last", async () => {
    const local = openLocalDb({ home });
    seeded(local.db);
    const store = new SqliteRunStore(local.db);

    const all = await store.list();
    expect(all.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(all[0]!.args).toEqual(["atlas"]);
    expect(all[1]!.exit_code).toBe(0);

    expect((await store.list({ last: true })).map((r) => r.id)).toEqual(["r2"]);
    expect((await store.list({ agent: "atlas" })).map((r) => r.id)).toEqual(["r2"]);
    expect(await store.list({ agent: "corvid" })).toEqual([]);
    local.close();
  });

  test("recording the same id twice finishes the run rather than duplicating it", async () => {
    const local = openLocalDb({ home });
    recordRun(local.db, { id: "r1", command: "agent rerun", started_at: "2026-09-01T10:00:00.000Z" });
    recordRun(local.db, {
      id: "r1",
      command: "agent rerun",
      started_at: "2026-09-01T10:00:00.000Z",
      finished_at: "2026-09-01T10:00:09.000Z",
      exit_code: 0,
      log: "rerun requested",
    });
    const rows = await new SqliteRunStore(local.db).list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.exit_code).toBe(0);
    expect(rows[0]!.log).toBe("rerun requested");
    local.close();
  });

  /**
   * §4.8: which fleet a command was against. The column has been there since
   * migration v4; this is what makes it readable, so Settings → Runs can be an
   * audit log per fleet rather than three fleets' histories in one list.
   */
  test("a recorded run round-trips its fleet, and a row that names none reads null", async () => {
    const local = openLocalDb({ home });
    recordRun(local.db, {
      id: "r1",
      command: "agent create",
      args: ["atlas"],
      agent: "atlas",
      started_at: "2026-09-01T10:00:00.000Z",
      fleet: "staging",
    });
    // A head that has not been taught to pass one yet: null, and legal.
    recordRun(local.db, {
      id: "r2",
      command: "runs",
      started_at: "2026-09-01T11:00:00.000Z",
    });

    const rows = await new SqliteRunStore(local.db).list();
    expect(rows.map((r) => [r.id, r.fleet])).toEqual([
      ["r2", null],
      ["r1", "staging"],
    ]);

    // Finishing the run leaves the fleet alone rather than blanking it.
    recordRun(local.db, {
      id: "r1",
      command: "agent create",
      args: ["atlas"],
      agent: "atlas",
      started_at: "2026-09-01T10:00:00.000Z",
      finished_at: "2026-09-01T10:00:09.000Z",
      exit_code: 0,
    });
    expect((await new SqliteRunStore(local.db).list({ agent: "atlas" }))[0]!.fleet).toBe("staging");
    local.close();
  });

  /** `init --reset` archives rather than drops (§4.7). */
  test("archiveRuns empties the log and keeps the rows", async () => {
    const local = openLocalDb({ home });
    seeded(local.db);
    expect(archiveRuns(local.db)).toBe(2);
    expect(await new SqliteRunStore(local.db).list()).toEqual([]);
    const archived = local.db.query(`SELECT COUNT(*) AS n FROM runs_archive`).get() as { n: number };
    expect(archived.n).toBe(2);
    local.close();
  });
});

/** §4.6: the heads record what they rendered, and can do so without a config row. */
describe("openRunRecorder", () => {
  test("records a run before it finishes, then completes it", async () => {
    const recorder = openRunRecorder(home);
    const run = recorder.start({ command: "agent create", args: ["atlas"], agent: "atlas" });
    expect(run.exit_code).toBeNull();
    expect((await recorder.list())[0]!.finished_at).toBeNull();

    recorder.finish(run.id, { exit_code: 0, log: "atlas handed off" });
    const [finished] = await recorder.list();
    expect(finished!.exit_code).toBe(0);
    expect(finished!.log).toBe("atlas handed off");
    expect(finished!.command).toBe("agent create");
    recorder.close();
  });

  /**
   * §4.6: the row is opened before core is, so the target is stamped on
   * afterwards. Everything about attributing a run to a fleet hangs off this:
   * a head that had to name the fleet at `start` could only name one the
   * operator had already typed as an id, which is the minority of commands.
   */
  test("annotate stamps the target the command turned out to be against", async () => {
    const recorder = openRunRecorder(home);
    const run = recorder.start({ command: "agent ps", args: [], agent: null });
    expect(run.fleet).toBeNull();
    expect(run.account_id).toBeNull();

    recorder.annotate(run.id, {
      account_id: CONFIG.account_id,
      region: CONFIG.region,
      fleet_id: CONFIG.fleet_id,
      fleet_name: "main",
    });
    recorder.finish(run.id, { exit_code: 0, log: "twelve agents" });

    const [row] = await recorder.list();
    expect(row!.fleet).toBe(CONFIG.fleet_id);
    expect(row!.account_id).toBe(CONFIG.account_id);
    expect(row!.region).toBe(CONFIG.region);
    expect(row!.fleet_name).toBe("main");
    // Finishing a run says nothing about its fleet, and must not unsay it.
    expect(row!.exit_code).toBe(0);
    recorder.close();
  });

  test("a later annotate that knows less never erases what an earlier one knew", async () => {
    const recorder = openRunRecorder(home);
    const run = recorder.start({ command: "agent ps", args: [], agent: null });
    const target = {
      account_id: CONFIG.account_id,
      region: CONFIG.region,
      fleet_id: CONFIG.fleet_id,
    };
    recorder.annotate(run.id, { ...target, fleet_name: "main" });
    // The alias was cleared between the two calls; the row keeps what it saw.
    recorder.annotate(run.id, { ...target, fleet_name: null });

    const [row] = await recorder.list();
    expect(row!.fleet_name).toBe("main");
    expect(row!.fleet).toBe(CONFIG.fleet_id);
    recorder.close();
  });

  /**
   * §4.6: a run that never resolved a fleet — `FLEET_REQUIRED`, an unknown
   * `--fleet`, a home with nothing frozen — stays unattributed. The readers
   * show it as unknown; what they must never do is read it as the fleet that
   * happens to be open, which is a different row's history.
   */
  test("a run that resolved no fleet keeps no identity", async () => {
    const recorder = openRunRecorder(home);
    recorder.start({ id: "r8", command: "agent ps", args: [] });
    recorder.finish("r8", { exit_code: 7, log: "FLEET_REQUIRED" });
    const [row] = await recorder.list();
    expect(row!.fleet).toBeNull();
    expect(row!.account_id).toBeNull();
    expect(row!.region).toBeNull();
    expect(row!.fleet_name).toBeNull();
    recorder.close();
  });

  /**
   * §4.8: the alias is a label, `fleet_id` is the fleet. A row recorded while
   * `staging` meant one fleet still belongs to that fleet after the label has
   * been moved to another — which is why nothing downstream compares aliases.
   */
  test("a run survives its fleet's alias being renamed onto another fleet", async () => {
    const recorder = openRunRecorder(home);
    const run = recorder.start({ command: "agent create", args: ["kite"], agent: "kite" });
    recorder.annotate(run.id, {
      account_id: CONFIG.account_id,
      region: CONFIG.region,
      fleet_id: "sg7k2m4p",
      fleet_name: "staging",
    });
    // `staging` now labels a different fleet, and that fleet records its own run.
    const later = recorder.start({ command: "agent ps", args: [], agent: null });
    recorder.annotate(later.id, {
      account_id: CONFIG.account_id,
      region: CONFIG.region,
      fleet_id: CONFIG.fleet_id,
      fleet_name: "staging",
    });

    const rows = await recorder.list();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(run.id)!.fleet).toBe("sg7k2m4p");
    expect(byId.get(later.id)!.fleet).toBe(CONFIG.fleet_id);
    // Both say `staging`, and neither is attributed by it.
    expect(rows.map((r) => r.fleet_name)).toEqual(["staging", "staging"]);
    recorder.close();
  });

  test("finishing a run that was never started invents nothing", async () => {
    const recorder = openRunRecorder(home);
    recorder.finish("never-started", { exit_code: 1 });
    expect(await recorder.list()).toEqual([]);
    recorder.close();
  });

  test("works on a home with no frozen config, so a failed init is still logged", async () => {
    const recorder = openRunRecorder(home);
    recorder.start({ id: "r9", command: "init", args: ["--create"] });
    recorder.finish("r9", { exit_code: 2, log: "NOT_INITIALIZED" });
    const rows = await recorder.list({ last: true });
    expect(rows[0]!.exit_code).toBe(2);
    recorder.close();

    const local = openLocalDb({ home });
    expect(readConfig(local.db)).toBeNull();
    local.close();
  });
});

/**
 * §4.6: the run log belongs to this laptop, not to the fleet being talked to, so
 * `--fixture` reads the same rows a *fixture* session recorded — but never the
 * operator's real `hermetic.db`. Mixing the two would mean `hermetic runs`
 * (real mode) fills up with `agents.destroy`/`teardown` rows from unrelated
 * fixture walkthroughs, which is exactly the bug this file guards against.
 */
describe("fixture mode has its own local run log", () => {
  test("openHermetic({ fixture: true }) reads what a fixture openRunRecorder wrote", async () => {
    const recorder = openRunRecorder(home, { fixture: true });
    const run = recorder.start({ command: "agent ps", args: ["--fixture"], agent: null });
    recorder.finish(run.id, { exit_code: 0, log: "eleven agents" });
    recorder.close();

    const hermetic = await openHermetic({ fixture: true, home });
    const rows = await hermetic.runs.list();
    expect(rows.map((r) => r.id)).toEqual([run.id]);
    expect(rows[0]!.command).toBe("agent ps");
    expect(rows[0]!.exit_code).toBe(0);

    // The fleet really is the fixture one — this is not accidentally a real open.
    expect((await hermetic.agents.list()).map((a) => a.name)).toContain("atlas");
  });

  test("fixture runs land in hermetic-fixture.db, never in hermetic.db", async () => {
    const recorder = openRunRecorder(home, { fixture: true });
    const run = recorder.start({ command: "agent destroy", args: ["atlas"], agent: "atlas" });
    recorder.finish(run.id, { exit_code: 0, log: "destroyed" });
    recorder.close();

    // The fixture file exists and holds the row.
    expect(existsSync(join(home, FIXTURE_DB_FILENAME))).toBe(true);
    const fixtureLocal = openLocalDb({ home, fixture: true });
    expect((await new SqliteRunStore(fixtureLocal.db).list()).map((r) => r.id)).toEqual([run.id]);
    fixtureLocal.close();

    // The real database was never created by any of this.
    expect(existsSync(join(home, DB_FILENAME))).toBe(false);
  });

  test("runRecorderFor({ fixture: true }) is the same file as openRunRecorder(home, { fixture: true })", async () => {
    const recorder = runRecorderFor({ home, fixture: true });
    const run = recorder.start({ command: "agent rerun", args: ["corvid"], agent: "corvid" });
    recorder.finish(run.id, { exit_code: 0 });
    recorder.close();

    const { runs, close } = openRunStore(home, { fixture: true });
    expect((await runs.list({})).map((r) => r.id)).toEqual([run.id]);
    close();
    expect(existsSync(join(home, DB_FILENAME))).toBe(false);
  });

  test("runRecorderFor({ fixture: false }) writes hermetic.db as before", async () => {
    const recorder = runRecorderFor({ home, fixture: false });
    const run = recorder.start({ command: "agent ps", args: [], agent: null });
    recorder.finish(run.id, { exit_code: 0 });
    recorder.close();

    expect(existsSync(join(home, DB_FILENAME))).toBe(true);
    expect(existsSync(join(home, FIXTURE_DB_FILENAME))).toBe(false);
  });

  test("a home with no runs yet reads as empty rather than failing", async () => {
    const hermetic = await openHermetic({ fixture: true, home });
    expect(await hermetic.runs.list()).toEqual([]);
    // Reading an empty fixture log must not create the real database either.
    expect(existsSync(join(home, DB_FILENAME))).toBe(false);
  });

  test("--last and --agent work in fixture mode too", async () => {
    const recorder = openRunRecorder(home, { fixture: true });
    recorder.start({
      id: "r1",
      command: "agent create",
      args: ["atlas"],
      agent: "atlas",
      started_at: "2026-09-01T10:00:00.000Z",
    });
    recorder.start({
      id: "r2",
      command: "agent rerun",
      args: ["corvid"],
      agent: "corvid",
      started_at: "2026-09-01T11:00:00.000Z",
    });
    recorder.close();

    const hermetic = await openHermetic({ fixture: true, home });
    expect((await hermetic.runs.list({ last: true })).map((r) => r.id)).toEqual(["r2"]);
    expect((await hermetic.runs.list({ agent: "atlas" })).map((r) => r.id)).toEqual(["r1"]);
  });

  test("an unusable HERMETIC_HOME degrades to an empty in-memory log, not an error", async () => {
    // A file where the home directory should be: `mkdir` cannot succeed.
    const blocked = join(home, "blocked");
    await Bun.write(blocked, "not a directory\n");

    const hermetic = await openHermetic({ fixture: true, home: blocked });
    expect(await hermetic.runs.list()).toEqual([]);
    // The fixture fleet still works; only the run log was lost (§4.6).
    expect((await hermetic.agents.list()).length).toBeGreaterThan(0);
  });

  test("a corrupt real database is untouched, and does not stop the fixture log", async () => {
    const corrupt = join(home, DB_FILENAME);
    await Bun.write(corrupt, "not a database\n".repeat(50));

    const hermetic = await openHermetic({ fixture: true, home });
    expect(await hermetic.runs.list()).toEqual([]);
    // Untouched: `init` decides what to do with a broken real file, not `runs`
    // (§4.7) — and fixture mode never opens `hermetic.db` at all now, so the
    // fixture log works fine (`hermetic-fixture.db` was created alongside it).
    expect(readdirSync(home).sort()).toEqual([DB_FILENAME, FIXTURE_DB_FILENAME].sort());
  });

  test("a corrupt fixture database is renamed aside like a real one would be", async () => {
    const corrupt = join(home, FIXTURE_DB_FILENAME);
    await Bun.write(corrupt, "not a database\n".repeat(50));

    const recorder = openRunRecorder(home, { fixture: true });
    const run = recorder.start({ command: "agent ps", args: [], agent: null });
    recorder.finish(run.id, { exit_code: 0 });
    recorder.close();

    const entries = readdirSync(home);
    expect(entries.some((f) => f.startsWith(`${FIXTURE_DB_FILENAME}.corrupt-`))).toBe(true);
    expect(entries).toContain(FIXTURE_DB_FILENAME);
  });
});

describe("MemoryRunStore", () => {
  test("is newest-first and honours the same filters", async () => {
    const rows = [
      {
        id: "a",
        command: "x",
        args: [],
        agent: "atlas",
        started_at: "2026-09-01T10:00:00.000Z",
        finished_at: null,
        exit_code: null,
        log: "",
        fleet: "main",
        account_id: null,
        region: null,
        fleet_name: null,
      },
      {
        id: "b",
        command: "y",
        args: [],
        agent: null,
        started_at: "2026-09-01T11:00:00.000Z",
        finished_at: null,
        exit_code: null,
        log: "",
        fleet: null,
        account_id: null,
        region: null,
        fleet_name: null,
      },
    ];
    const store = new MemoryRunStore(rows);
    expect((await store.list()).map((r) => r.id)).toEqual(["b", "a"]);
    expect((await store.list({ last: true })).map((r) => r.id)).toEqual(["b"]);
    expect((await store.list({ agent: "atlas" })).map((r) => r.id)).toEqual(["a"]);
  });
});

/**
 * Which conversations this laptop started (§9.2).
 *
 * The behaviour under test is one direction and one default: a row is only ever
 * evidence *for* `portal`, and its absence — a fresh laptop, a wiped database, a
 * pruned row, another operator's machine — always means foreign.
 */
describe("the local chat session record", () => {
  const NOW_ISO = "2026-09-17T12:00:00.000Z";

  function store() {
    const local = openLocalDb({ home });
    return { local, sessions: new SqliteLocalChatSessions(local.db, () => new Date(NOW_ISO)) };
  }

  test("a remembered session is recognised, and nothing else is", () => {
    const { local, sessions } = store();
    sessions.remember("fxtr0001", { instance: "atlas", bot: "default", session: "s-1" }, NOW_ISO);
    expect([...sessions.mine("fxtr0001", ["s-1", "s-2"])]).toEqual(["s-1"]);
    expect([...sessions.mine("fxtr0001", [])]).toEqual([]);
    local.close();
  });

  test("another fleet's session of the same id is not this fleet's", () => {
    const { local, sessions } = store();
    sessions.remember("fxtr0001", { instance: "atlas", bot: "default", session: "s-1" }, NOW_ISO);
    expect([...sessions.mine("sg7k2m4p", ["s-1"])]).toEqual([]);
    local.close();
  });

  test("remembering twice is one row, not two", () => {
    const { local, sessions } = store();
    sessions.remember("fxtr0001", { instance: "atlas", bot: "default", session: "s-1" }, NOW_ISO);
    sessions.remember("fxtr0001", { instance: "atlas", bot: "default", session: "s-1" }, NOW_ISO);
    const count = local.db.query(`SELECT COUNT(*) AS n FROM chat_local_sessions`).get() as {
      n: number;
    };
    expect(count.n).toBe(1);
    local.close();
  });

  test("a row older than the retention window is pruned, and the thread warns again", () => {
    // Sessions on a box outlive rows on a laptop, so the table has to be
    // bounded. Expiring makes the portal *more* cautious, never less, which is
    // the only direction this record is allowed to fail in.
    const local = openLocalDb({ home });
    const september = new SqliteLocalChatSessions(local.db, () => new Date(NOW_ISO));
    september.remember("fxtr0001", { instance: "atlas", bot: "default", session: "s-1" }, NOW_ISO);
    expect([...september.mine("fxtr0001", ["s-1"])]).toEqual(["s-1"]);

    // Two months later, on the next write — the sweep is on write, so a laptop
    // that is not chatting spends nothing on it.
    const december = new SqliteLocalChatSessions(local.db, () => new Date("2026-12-01T00:00:00.000Z"));
    december.remember(
      "fxtr0001",
      { instance: "atlas", bot: "default", session: "s-2" },
      "2026-12-01T00:00:00.000Z",
    );
    expect([...december.mine("fxtr0001", ["s-1", "s-2"])]).toEqual(["s-2"]);
    local.close();
  });
});

/**
 * §4.7: a pending row belongs to a fleet only if it can name the whole of one.
 *
 * `fleet` alone was the v4 story, and it is not identity: two accounts may each
 * hold a fleet whose eight-character id is the same eight characters. The
 * filter therefore reads all three columns and a row missing any of them is
 * nobody's — which is the case these cover, because the alternative is that
 * whichever portal boots first replays somebody else's interrupted create.
 */
describe("the pending op log, on disk", () => {
  /** What a resuming portal asks for: the fleet it opened, named in full. */
  const TARGET = {
    account_id: CONFIG.account_id,
    region: CONFIG.region,
    fleet_id: CONFIG.fleet_id,
  };
  /** The same fleet as a row records it — `fleet` is the column, `fleet_id` the field. */
  const ROW = { fleet: CONFIG.fleet_id, account_id: CONFIG.account_id, region: CONFIG.region };

  function claimed(store: ReturnType<typeof openPendingOpStore>, id: string, row: object): void {
    store.claim({
      id,
      method: "agents.create",
      target: "atlas",
      input: { name: "atlas" },
      started_at: `2026-09-01T10:00:0${id.slice(-1)}.000Z`,
      ...row,
    });
  }

  test("a row that names only part of a fleet is nobody's to resume", () => {
    const store = openPendingOpStore({ home });
    claimed(store, "p-1", ROW);
    // The v4 shape: a `fleet_id` and nothing to place it in.
    claimed(store, "p-2", { fleet: CONFIG.fleet_id });
    // Written by nothing at all — the oldest rows, from before fleets were
    // recorded on a pending op.
    claimed(store, "p-3", {});
    // The same eight characters in another account. Identical `fleet`, and not
    // this fleet: the case the two extra columns exist for.
    claimed(store, "p-4", { ...ROW, account_id: "210987654321" });
    // This fleet's id, in the account that holds it, in another region.
    claimed(store, "p-5", { ...ROW, region: "eu-west-1" });

    expect(store.list(TARGET).map((r) => r.id)).toEqual(["p-1"]);
    expect(store.listUnattributed().map((r) => r.id)).toEqual(["p-2", "p-3"]);
    // Nothing was deleted to make the filter tidy: every row is still somebody's
    // unfinished work, and `list()` with no argument still sees all of them.
    expect(store.list().map((r) => r.id)).toEqual(["p-1", "p-2", "p-3", "p-4", "p-5"]);
    store.close();
  });

  test("the identity a destroy was confirmed against survives a restart", () => {
    const store = openPendingOpStore({ home });
    store.claim({
      id: "p-6",
      method: "agents.destroy",
      target: "atlas",
      input: { name: "atlas", yes: true },
      started_at: "2026-09-01T10:00:00.000Z",
      ...ROW,
      target_identity: { instance_id: "i-0123456789abcdef0", created_at: "2026-08-01T09:00:00Z" },
    });
    store.close();

    // Re-opened, because the whole point of the column is the boot after the
    // one that wrote it.
    const reopened = openPendingOpStore({ home });
    expect(reopened.list(TARGET)[0]!.target_identity).toEqual({
      instance_id: "i-0123456789abcdef0",
      created_at: "2026-08-01T09:00:00Z",
    });
    reopened.close();
  });
});

describe("the home directory", () => {
  const modeOf = (path: string): number => statSync(path).mode & 0o777;

  test("a home openLocalDb creates is owner-only", () => {
    const fresh = join(home, "nested", "home");
    const db = openLocalDb({ home: fresh });
    db.close();
    expect(modeOf(fresh)).toBe(0o700);
  });

  test("an existing home keeps the mode the operator gave it", () => {
    chmodSync(home, 0o755);
    const db = openLocalDb({ home });
    db.close();
    expect(modeOf(home)).toBe(0o755);
  });
});
