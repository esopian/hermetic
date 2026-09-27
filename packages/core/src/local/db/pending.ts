import type { FleetTarget } from "../../schema/index.ts";
import { sameFleetTarget } from "../../schema/index.ts";
import { openLocalDb, type LocalDb } from "./index.ts";
import type { OpenRunOptions } from "./runs.ts";

/**
 * One op this laptop had in flight. `attempts` counts how many times a *boot*
 * has picked it up, so an op that kills the process on every resume gives up
 * instead of turning the portal into a crash loop.
 */
export interface PendingOp {
  id: string;
  /** Dotted core method, e.g. `agents.create`. */
  method: string;
  target: string | null;
  /**
   * Which fleet the op was against (§4.7, §4.8), as the immutable triple.
   * Null on rows written before a home could hold more than one, and on rows
   * written before the account and the region joined the `fleet_id` — those
   * cannot say which fleet they meant, so no boot replays them (`list(fleet)`
   * returns only fully attributed rows; `listUnattributed` is how a boot finds
   * the rest in order to say so).
   */
  fleet?: string | null;
  account_id?: string | null;
  region?: string | null;
  /**
   * What the op's target looked like when it was claimed (§4.7).
   *
   * An agent name is a label that can be freed and taken again, so a destroy
   * confirmed against one agent and replayed a boot later could land on its
   * successor. The two fields below are the parts of the row that a successor
   * cannot share: `created_at` is written once when the row is created and
   * `instance_id` moves on every recreate. A resume compares them and refuses
   * on any disagreement (`resume.ts`).
   */
  target_identity?: PendingOpIdentity | null;
  /** The op's validated request, as JSON. Never carries a secret (§8.3). */
  input: unknown;
  started_at: string;
  attempts: number;
  /**
   * The last phase the op's event stream reported (§4.6). A phase is a label,
   * never a value (§8.3), and it says where the interrupted work stopped — what
   * a boot tells an operator about an operation it is not going to replay, and
   * what a retry logs about the run it is finishing.
   */
  phase?: string | null;
  /**
   * The earliest moment this row may be tried again, when a prior attempt was
   * refused by a lease that was still live (§4.4). Null on a row nothing has
   * refused yet. A boot leaves a row with a future `retry_after` pending —
   * waiting the lease out rather than taking ownership from its holder.
   */
  retry_after?: string | null;
}

/** The immutable half of an agent row, as it stood when a pending op was claimed. */
export interface PendingOpIdentity {
  instance_id: string | null;
  created_at: string | null;
}

/** A row read back off disk is data, not a value this process wrote: shape-check it. */
function toIdentity(raw: unknown): PendingOpIdentity | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as { instance_id?: unknown; created_at?: unknown };
  const instance_id = typeof value.instance_id === "string" ? value.instance_id : null;
  const created_at = typeof value.created_at === "string" ? value.created_at : null;
  if (instance_id === null && created_at === null) return null;
  return { instance_id, created_at };
}

/**
 * The in-flight op log (§4.6). Deliberately tiny: `claim` on start, `clear` on
 * settle, `list` at boot. It records *that* an op was running and with what
 * input — never how far it got, which is read back out of AWS by the resumed
 * op itself (§4.5).
 */
export interface PendingOpStore {
  claim(op: Omit<PendingOp, "attempts"> & { attempts?: number }): void;
  clear(id: string): void;
  /**
   * Every pending op, or — given a fleet — only the rows that name *exactly*
   * that fleet: same `fleet_id`, same account, same region. A portal booted on
   * one fleet must not replay an `agents.create` that was running against
   * another (§4.8), and a row that names no fleet, or only part of one, cannot
   * prove it was not (§4.7) — those are `listUnattributed`'s, and no boot acts
   * on them. Keyed by id and never by display alias, which two fleets may
   * equally not have (§4.6).
   */
  list(fleet?: FleetTarget): PendingOp[];
  /**
   * The rows `list(fleet)` will never return, whichever fleet asks: written
   * before the identity columns existed, or by a build that could not say.
   * They stay on disk — they are somebody's unfinished work, and deleting them
   * would lose the only local record of it — and a boot reports them so an
   * operator can re-run the command themselves.
   */
  listUnattributed(): PendingOp[];
  /** Bumps `attempts` and returns the new value. */
  attempted(id: string): number;
  /**
   * Records how far the op has got, so an interrupted one can say where it
   * stopped. A phase, never a value (§8.3). A row that is no longer there —
   * the op settled a moment ago — is not an error: there is nothing to record.
   */
  progress(id: string, phase: string): void;
  /**
   * Keeps the row and says when it may be tried again (§4.4). The one outcome
   * that is neither "settled" nor "this process died": a lease that was still
   * live refused the attempt, and the work is owed a retry once it lapses.
   */
  defer(id: string, retryAfter: string): void;
  close(): void;
}

/**
 * The fleet a pending row names, or `null` when it names only part of one.
 * Partial attribution is not weaker identity, it is none: two accounts may hold
 * fleets whose eight-character ids collide, and a row that cannot rule that out
 * must not be replayed (§4.7).
 */
export function pendingTarget(row: PendingOp): FleetTarget | null {
  if (row.fleet == null || row.account_id == null || row.region == null) return null;
  return { fleet_id: row.fleet, account_id: row.account_id, region: row.region };
}

const PENDING_COLUMNS = `id, method, target, input, started_at, attempts, fleet, account_id, region, target_identity, phase, retry_after`;

interface PendingRow {
  id: string;
  method: string;
  target: string | null;
  input: string;
  started_at: string;
  attempts: number;
  fleet: string | null;
  account_id: string | null;
  region: string | null;
  target_identity: string | null;
  phase: string | null;
  retry_after: string | null;
}

function toPendingOp(r: PendingRow): PendingOp[] {
  let input: unknown;
  try {
    input = JSON.parse(r.input);
  } catch {
    // A row we cannot read is a row we cannot safely re-run.
    return [];
  }
  let identity: PendingOpIdentity | null = null;
  if (r.target_identity !== null) {
    try {
      identity = toIdentity(JSON.parse(r.target_identity));
    } catch {
      identity = null;
    }
  }
  return [
    {
      id: r.id,
      method: r.method,
      target: r.target,
      input,
      started_at: r.started_at,
      attempts: r.attempts,
      fleet: r.fleet,
      account_id: r.account_id,
      region: r.region,
      target_identity: identity,
      phase: r.phase,
      retry_after: r.retry_after,
    },
  ];
}

/**
 * A store that remembers nothing, for tests and for a home that could not be
 * opened. Losing this log costs a resume, never correctness: the agent row in
 * DynamoDB is the durable record, and `doctor` finds what was left behind.
 */
export class MemoryPendingOpStore implements PendingOpStore {
  private readonly rows = new Map<string, PendingOp>();
  claim(op: Omit<PendingOp, "attempts"> & { attempts?: number }): void {
    this.rows.set(op.id, { ...op, attempts: op.attempts ?? 0 });
  }
  clear(id: string): void {
    this.rows.delete(id);
  }
  list(fleet?: FleetTarget): PendingOp[] {
    return [...this.rows.values()]
      .filter((r) => fleet === undefined || sameFleetTarget(pendingTarget(r), fleet))
      .sort((a, b) => (a.started_at < b.started_at ? -1 : 1));
  }
  listUnattributed(): PendingOp[] {
    return [...this.rows.values()]
      .filter((r) => pendingTarget(r) === null)
      .sort((a, b) => (a.started_at < b.started_at ? -1 : 1));
  }
  attempted(id: string): number {
    const row = this.rows.get(id);
    if (!row) return 0;
    row.attempts += 1;
    return row.attempts;
  }
  progress(id: string, phase: string): void {
    const row = this.rows.get(id);
    if (row) row.phase = phase;
  }
  defer(id: string, retryAfter: string): void {
    const row = this.rows.get(id);
    if (row) row.retry_after = retryAfter;
  }
  close(): void {
    this.rows.clear();
  }
}

/**
 * Same file and same fixture split as the run log: a fixture session's pending
 * ops live in `hermetic-fixture.db` and can never resume against a real fleet.
 */
export function openPendingOpStore(opts: OpenRunOptions = {}): PendingOpStore {
  let local: LocalDb;
  try {
    local = openLocalDb({
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      fixture: opts.fixture ?? false,
    });
  } catch {
    // §4.6: an unopenable home degrades resume, never the fleet.
    return new MemoryPendingOpStore();
  }
  return {
    claim: (op) => {
      local.db.run(
        `INSERT OR REPLACE INTO pending_ops
           (id, method, target, input, started_at, attempts, fleet, account_id, region, target_identity, phase, retry_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          op.id,
          op.method,
          op.target,
          JSON.stringify(op.input ?? null),
          op.started_at,
          op.attempts ?? 0,
          op.fleet ?? null,
          op.account_id ?? null,
          op.region ?? null,
          op.target_identity == null ? null : JSON.stringify(op.target_identity),
          op.phase ?? null,
          op.retry_after ?? null,
        ],
      );
    },
    clear: (id) => {
      local.db.run(`DELETE FROM pending_ops WHERE id = ?`, [id]);
    },
    list: (fleet?: FleetTarget) => {
      const rows =
        fleet === undefined
          ? local.db.query(`SELECT ${PENDING_COLUMNS} FROM pending_ops ORDER BY started_at`).all()
          : local.db
              .query(
                // All three, and every one of them stated: a row that names
                // only part of its fleet is not this fleet's row (§4.7).
                `SELECT ${PENDING_COLUMNS} FROM pending_ops
                   WHERE fleet = ? AND account_id = ? AND region = ?
                   ORDER BY started_at`,
              )
              .all(fleet.fleet_id, fleet.account_id, fleet.region);
      return (rows as PendingRow[]).flatMap(toPendingOp);
    },
    listUnattributed: () => {
      const rows = local.db
        .query(
          `SELECT ${PENDING_COLUMNS} FROM pending_ops
             WHERE fleet IS NULL OR account_id IS NULL OR region IS NULL
             ORDER BY started_at`,
        )
        .all();
      return (rows as PendingRow[]).flatMap(toPendingOp);
    },
    attempted: (id) => {
      local.db.run(`UPDATE pending_ops SET attempts = attempts + 1 WHERE id = ?`, [id]);
      const row = local.db.query(`SELECT attempts FROM pending_ops WHERE id = ?`).get(id) as {
        attempts: number;
      } | null;
      return row?.attempts ?? 0;
    },
    progress: (id, phase) => {
      local.db.run(`UPDATE pending_ops SET phase = ? WHERE id = ?`, [phase, id]);
    },
    defer: (id, retryAfter) => {
      local.db.run(`UPDATE pending_ops SET retry_after = ? WHERE id = ?`, [retryAfter, id]);
    },
    close: () => local.close(),
  };
}
