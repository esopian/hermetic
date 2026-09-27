import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Run,
  RunTarget,
  RunsListInput,
  TeardownReceipt,
  TeardownsListInput,
} from "../../schema/index.ts";
import {
  Run as RunSchema,
  RunTarget as RunTargetSchema,
  TeardownReceipt as TeardownReceiptSchema,
} from "../../schema/index.ts";
import type { RunStore, TeardownStore } from "../../hermetic.ts";
import { openLocalDb, type DbFileOptions } from "./index.ts";
import { notifySettledRun } from "./notifications.ts";

/** `init --reset` archives the run log rather than dropping it (§4.7). */
export function archiveRuns(db: Database, now: Date = new Date()): number {
  const at = now.toISOString();
  const move = db.transaction(() => {
    db.run(
      `INSERT OR REPLACE INTO runs_archive
         (id, command, args, agent, started_at, finished_at, exit_code, log, fleet, account_id, region, fleet_name, archived_at)
       SELECT id, command, args, agent, started_at, finished_at, exit_code, log, fleet, account_id, region, fleet_name, ? FROM runs`,
      [at],
    );
    db.run(`DELETE FROM runs`);
  });
  const before = (db.query(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n;
  move();
  return before;
}

interface RunRow {
  id: string;
  command: string;
  args: string;
  agent: string | null;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  log: string;
  fleet: string | null;
  account_id: string | null;
  region: string | null;
  fleet_name: string | null;
}

function toRun(row: RunRow): Run {
  return RunSchema.parse({
    id: row.id,
    command: row.command,
    args: JSON.parse(row.args) as string[],
    agent: row.agent,
    started_at: row.started_at,
    finished_at: row.finished_at,
    exit_code: row.exit_code,
    log: row.log,
    fleet: row.fleet,
    account_id: row.account_id,
    region: row.region,
    fleet_name: row.fleet_name,
  });
}

export interface RecordRunInput {
  command: string;
  args?: string[];
  agent?: string | null;
  started_at?: string;
  finished_at?: string | null;
  exit_code?: number | null;
  log?: string;
  id?: string;
  /** Which fleet the command was against (§4.8); null for one that names none. */
  fleet?: string | null;
  /**
   * The rest of the resolved target (§4.6). A head that already knows what it
   * is talking to — the portal, which resolved its fleet at boot — passes it
   * here; one that does not yet (the CLI, whose row opens before core is even
   * open) opens the row without it and calls `annotate` once it does.
   */
  account_id?: string | null;
  region?: string | null;
  fleet_name?: string | null;
}

/**
 * What the heads call once a command finishes: `hermetic runs --last` is the
 * local log of everything this laptop ran, with captured output (§4.6). Secrets
 * never reach it — the heads pass rendered output, and core never echoes a value
 * (§8.3).
 */
export function recordRun(db: Database, input: RecordRunInput): Run {
  const run: Run = RunSchema.parse({
    id: input.id ?? randomUUID(),
    command: input.command,
    args: input.args ?? [],
    agent: input.agent ?? null,
    started_at: input.started_at ?? new Date().toISOString(),
    finished_at: input.finished_at ?? null,
    exit_code: input.exit_code ?? null,
    log: input.log ?? "",
    fleet: input.fleet ?? null,
    account_id: input.account_id ?? null,
    region: input.region ?? null,
    fleet_name: input.fleet_name ?? null,
  });
  db.run(
    `INSERT INTO runs (id, command, args, agent, started_at, finished_at, exit_code, log, fleet, account_id, region, fleet_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       finished_at = excluded.finished_at,
       exit_code   = excluded.exit_code,
       log         = excluded.log,
       fleet       = COALESCE(excluded.fleet, runs.fleet),
       account_id  = COALESCE(excluded.account_id, runs.account_id),
       region      = COALESCE(excluded.region, runs.region),
       fleet_name  = COALESCE(excluded.fleet_name, runs.fleet_name)`,
    [
      run.id,
      run.command,
      JSON.stringify(run.args),
      run.agent,
      run.started_at,
      run.finished_at,
      run.exit_code,
      run.log,
      run.fleet,
      run.account_id,
      run.region,
      run.fleet_name,
    ],
  );
  return run;
}

/**
 * Stamp a row with the target its command turned out to be against (§4.6).
 *
 * Separate from `start` because the two happen at different times: the row is
 * opened when the command does, which is before core has resolved *which*
 * fleet an alias, `HERMETIC_FLEET` or a persisted default means. Writing the
 * target only once it is known is what makes the run log attributable — before
 * this the row simply said nothing, and every reader downstream had to guess.
 *
 * `COALESCE` in both directions: a later annotate never erases an earlier one
 * with a null, and a run that resolved a fleet keeps it even if a second call
 * knows less. Nothing here can change a row's command, its exit code or its
 * log.
 */
export function annotateRun(db: Database, id: string, target: RunTarget): void {
  const parsed = RunTargetSchema.parse(target);
  db.run(
    `UPDATE runs SET
       fleet      = COALESCE(?, fleet),
       account_id = COALESCE(?, account_id),
       region     = COALESCE(?, region),
       fleet_name = COALESCE(?, fleet_name)
     WHERE id = ?`,
    [parsed.fleet_id, parsed.account_id, parsed.region, parsed.fleet_name, id],
  );
}

/**
 * What a head holds for the length of one command (§4.6). `start` writes the row
 * as the command begins so a crashed run still shows up in `hermetic runs`, and
 * `finish` fills in the exit code and the captured output.
 *
 * The `log` it stores is what the head *rendered* — the same text the operator
 * saw. Core never echoes a secret value (§8.3), so nothing secret can reach it
 * unless a head goes out of its way to put it there.
 */
export interface RunRecorder {
  start(input: RecordRunInput): Run;
  /**
   * Which fleet the command turned out to be against (§4.6). Called once the
   * head has an open core instance, which is the first moment anyone knows:
   * `start` runs before that, so the row it opens can only carry what the
   * operator *typed*.
   */
  annotate(id: string, target: RunTarget): void;
  /**
   * `op` is the notification seam (§4.9). A head passes it for a
   * *long operation* — a `STREAMING_METHODS` member — and core writes the
   * `operation.failed` / `operation.done` row here, which is the one place both
   * heads already pass through: the server's op registry is server-only, so a
   * `hermetic agent create` from the CLI would otherwise raise nothing.
   *
   * Omit it and no notification is written. An aborted op is an omission too:
   * stopping an op is the operator's own action, and telling them about it is
   * telling them what they just did.
   */
  finish(
    id: string,
    result: {
      exit_code: number;
      log?: string;
      finished_at?: string;
      op?: { method: string; error?: { code: string; message: string } };
    },
  ): void;
  list(input?: RunsListInput): Promise<Run[]>;
  close(): void;
}

export interface OpenRunOptions extends DbFileOptions {
  home?: string;
}

/**
 * Open just the local run log, without a frozen config and without AWS. Heads
 * call this directly: recording a run is a head concern (only the head knows
 * what it rendered), and it must work even for a command that failed
 * `NOT_INITIALIZED`.
 *
 * `opts.fixture` records into `hermetic-fixture.db` instead of the operator's
 * real `hermetic.db` (§4.6) — a fixture session's runs must never land in the
 * real run log.
 */
export function openRunRecorder(home?: string, opts: DbFileOptions = {}): RunRecorder {
  const local = openLocalDb({ ...(home !== undefined ? { home } : {}), ...opts });
  const store = new SqliteRunStore(local.db);
  return {
    start: (input) => recordRun(local.db, input),
    annotate: (id, target) => {
      annotateRun(local.db, id, target);
    },
    finish: (id, result) => {
      // An UPDATE, not an upsert: finishing a run that was never started must
      // not invent a row with no command in it.
      local.db.run(`UPDATE runs SET finished_at = ?, exit_code = ?, log = ? WHERE id = ?`, [
        result.finished_at ?? new Date().toISOString(),
        result.exit_code,
        result.log ?? "",
        id,
      ]);
      if (result.op) notifySettledRun(local.db, id, result.op);
    },
    list: (input = {}) => store.list(input),
    close: () => local.close(),
  };
}

/**
 * `openRunRecorder` with the `{ home, fixture }` shape the heads' call sites
 * need once they know whether the running command is a fixture one — the CLI's
 * `startRun()` (`packages/cli/src/run-log.ts`) and the app's op registry
 * (`packages/app/src/main/index.ts`) both go through it, which is what keeps a
 * fixture run out of the real `hermetic.db`.
 */
export function runRecorderFor(opts: OpenRunOptions): RunRecorder {
  return openRunRecorder(opts.home, { fixture: opts.fixture ?? false });
}

/**
 * The fallback when `HERMETIC_HOME` cannot be opened — a read-only directory, a
 * file that is not a database. `runs` is the one store whose loss is survivable
 * (§4.6), so a broken home degrades the run log rather than the command.
 */
export class MemoryRunStore implements RunStore {
  constructor(private readonly rows: Run[] = []) {}

  async list(input: RunsListInput = {}): Promise<Run[]> {
    const sorted = [...this.rows].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
    const matching = input.agent ? sorted.filter((r) => r.agent === input.agent) : sorted;
    return matching.slice(0, input.last ? 1 : (input.limit ?? 50));
  }
}

/**
 * The local run log, however it can be had. Fixture mode uses this too: the run
 * log is a property of *this laptop*, not of the fleet being talked to, so
 * `hermetic runs --fixture` shows the same rows the CLI recorded through
 * `openRunRecorder` (§4.6).
 */
/**
 * The teardown record for a home that may not have one yet. Same shape as
 * `openRunStore`, and the same reason: reading the log of what a laptop did
 * must never be what creates the database (§4.7).
 */
export function openTeardownStore(
  home?: string,
  opts: DbFileOptions = {},
): { teardowns: TeardownStore; close(): void } {
  try {
    const local = openLocalDb({
      ...(home !== undefined ? { home } : {}),
      ...opts,
      renameCorrupt: false,
    });
    return { teardowns: new SqliteTeardownStore(local.db), close: () => local.close() };
  } catch {
    return { teardowns: new MemoryTeardownStore(), close: () => {} };
  }
}

/** What a home with no readable database answers: nothing, and it keeps nothing. */
export class MemoryTeardownStore implements TeardownStore {
  private readonly receipts: TeardownReceipt[] = [];
  async record(receipt: TeardownReceipt): Promise<void> {
    this.receipts.unshift(receipt);
  }
  async list(input: TeardownsListInput = {}): Promise<TeardownReceipt[]> {
    return this.receipts.slice(0, input.last ? 1 : (input.limit ?? 20));
  }
}

export function openRunStore(
  home?: string,
  opts: DbFileOptions = {},
): { runs: RunStore; close(): void } {
  try {
    const local = openLocalDb({
      ...(home !== undefined ? { home } : {}),
      ...opts,
      // Never rename an operator's database aside just to read the run log.
      renameCorrupt: false,
    });
    return { runs: new SqliteRunStore(local.db), close: () => local.close() };
  } catch {
    return { runs: new MemoryRunStore(), close: () => {} };
  }
}

/** Backs `runs.list` (§9). Newest first; `--last` is a limit of one. */
/**
 * The `teardowns` table (§4.6). Written once per teardown, ok or failed, and
 * never dropped: `init --reset` and `teardown --reset-local` both leave it
 * alone, so the record of what a fleet left behind outlives the fleet.
 */
export class SqliteTeardownStore implements TeardownStore {
  constructor(private readonly db: Database) {}

  async record(receipt: TeardownReceipt): Promise<void> {
    this.db.run(
      `INSERT OR REPLACE INTO teardowns
         (id, at, fleet_id, account_id, region, stack_name, outcome, receipt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        receipt.id,
        receipt.finished_at,
        receipt.fleet_id,
        receipt.account_id,
        receipt.region,
        receipt.stack_name,
        receipt.outcome,
        JSON.stringify(receipt),
      ],
    );
  }

  async list(input: TeardownsListInput = {}): Promise<TeardownReceipt[]> {
    const limit = input.last ? 1 : (input.limit ?? 20);
    const rows = this.db
      .query(`SELECT receipt FROM teardowns ORDER BY at DESC LIMIT ?`)
      .all(limit) as Array<{ receipt: string }>;
    return rows.flatMap((row) => {
      // A row this build cannot parse is a row an older or newer hermetic
      // wrote. Skipping it is better than failing the whole list: the point of
      // the table is that it keeps working when nothing else does.
      const parsed = TeardownReceiptSchema.safeParse(JSON.parse(row.receipt) as unknown);
      return parsed.success ? [parsed.data] : [];
    });
  }
}

export class SqliteRunStore implements RunStore {
  constructor(private readonly db: Database) {}

  async list(input: RunsListInput = {}): Promise<Run[]> {
    const limit = input.last ? 1 : (input.limit ?? 50);
    const rows = input.agent
      ? (this.db
          .query(`SELECT * FROM runs WHERE agent = ? ORDER BY started_at DESC LIMIT ?`)
          .all(input.agent, limit) as RunRow[])
      : (this.db.query(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`).all(limit) as RunRow[]);
    return rows.map(toRun);
  }
}
