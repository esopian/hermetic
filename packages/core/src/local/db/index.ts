import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HermeticError } from "../../errors.ts";
import { migrate } from "./migrations.ts";

export { SCHEMA_VERSION, migrate } from "./migrations.ts";
export * from "./config.ts";
export * from "./runs.ts";
export * from "./pending.ts";
export * from "./notifications.ts";
export * from "./chat.ts";
export * from "./presets.ts";
export * from "./incarnations.ts";

/**
 * §4.6: the SQLite file holds only what this laptop knows — the frozen config,
 * per-operator preferences, and the command run log. Nothing in it mirrors
 * DynamoDB (§4.5), so deleting it costs only the `runs` log.
 *
 * `bun:sqlite` returns untyped rows, so every read casts explicitly and then
 * validates against the schema that owns the shape.
 */

export const DB_FILENAME = "hermetic.db";
/**
 * §4.6: fixture mode's run log lives in its own file, never in the operator's
 * real `hermetic.db`. A fixture session still wants `hermetic runs --fixture`
 * to show something (and to accumulate across fixture sessions the way the
 * real log does across real ones), so it gets a second SQLite file in the same
 * home rather than the in-memory store `openMemoryDb` uses for `init` itself.
 */
export const FIXTURE_DB_FILENAME = "hermetic-fixture.db";

export function hermeticHome(override?: string): string {
  return override ?? process.env["HERMETIC_HOME"] ?? join(homedir(), ".hermetic");
}

export interface DbFileOptions {
  /** Use `hermetic-fixture.db` instead of `hermetic.db` (§4.6). */
  fixture?: boolean;
}

function dbFilename(opts: DbFileOptions = {}): string {
  return opts.fixture ? FIXTURE_DB_FILENAME : DB_FILENAME;
}

export function dbPath(home?: string, opts: DbFileOptions = {}): string {
  return join(hermeticHome(home), dbFilename(opts));
}

/** `hermetic.db` → `hermetic.db.corrupt-<timestamp>` (§4.7 step 5). */
export function corruptRename(path: string, now: Date = new Date()): string | null {
  if (!existsSync(path)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const target = `${path}.corrupt-${stamp}`;
  renameSync(path, target);
  return target;
}

export interface LocalDb {
  db: Database;
  path: string;
  home: string;
  /** Set when an unreadable file was renamed out of the way on open. */
  corruptedTo: string | null;
  /**
   * Write a consistent copy of this database to `path` (§6.6's recovery
   * archive). See `archiveTo`; the handle stays open and usable.
   */
  archiveTo(path: string): void;
  close(): void;
}

/**
 * `VACUUM INTO`: a consistent copy of the open database, written in one
 * statement while the connection stays open. Copying the *file* instead would
 * be a copy of whatever the WAL had not checkpointed yet — a database that
 * opens and is missing the last thing that happened, which is the worst shape a
 * recovery archive can take.
 *
 * SQLite refuses to overwrite an existing destination, so the caller owns
 * making sure the path is free; that is the archive directory it just made.
 */
export function archiveDatabaseTo(db: Database, path: string): void {
  db.run(`VACUUM INTO ?`, [path]);
}

export interface OpenLocalDbOptions extends DbFileOptions {
  home?: string | undefined;
  /** `false` to fail rather than rename an unreadable file. */
  renameCorrupt?: boolean;
}

/**
 * Open `${HERMETIC_HOME ?? ~/.hermetic}/hermetic.db`, creating the directory and
 * running migrations. An unreadable file is renamed aside and a fresh one takes
 * its place (§4.7 step 5): only the `runs` log is lost, and `init` continues.
 *
 * `opts.fixture` switches to `hermetic-fixture.db` instead (§4.6) — same
 * schema, same migrations, a file the operator's real database never shares.
 */
export function openLocalDb(opts: OpenLocalDbOptions = {}): LocalDb {
  const home = hermeticHome(opts.home);
  // Owner-only when this call creates it: the home holds the config, the run
  // log and the app log, a map of the operator's fleet. `mode` applies only to
  // directories `mkdirSync` makes, so an existing home keeps the mode it has.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, dbFilename(opts));

  /**
   * A portal holds more than one handle on this file at once — the run log, the
   * pending-op log, and core's own config read — so a write can arrive while
   * another connection holds the lock. Waiting briefly is the difference
   * between "the second writer waited 3ms" and `SQLITE_BUSY`.
   */
  const open = (): Database => {
    const opened = new Database(path, { create: true });
    opened.run(`PRAGMA busy_timeout = 5000`);
    return opened;
  };

  let corruptedTo: string | null = null;
  let db: Database;
  try {
    db = open();
    migrate(db);
  } catch (e) {
    if (opts.renameCorrupt === false) {
      throw new HermeticError("INTERNAL", `${path} is not a readable hermetic database`, {
        path,
        cause: e instanceof Error ? e.message : String(e),
      });
    }
    corruptedTo = corruptRename(path);
    db = open();
    migrate(db);
  }

  return {
    db,
    path,
    home,
    corruptedTo,
    archiveTo: (to: string) => archiveDatabaseTo(db, to),
    close: () => db.close(),
  };
}

/**
 * A database that lives only in this process. Fixture mode uses it so a wizard
 * walkthrough exercises the same migrations and the same `LocalDb` shape without
 * touching the operator's real `~/.hermetic/hermetic.db` (§4.6).
 */
export function openMemoryDb(): LocalDb {
  const db = new Database(":memory:");
  migrate(db);
  return {
    db,
    path: ":memory:",
    home: ":memory:",
    corruptedTo: null,
    archiveTo: (to: string) => archiveDatabaseTo(db, to),
    close: () => db.close(),
  };
}
