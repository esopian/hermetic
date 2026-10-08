/**
 * Which incarnation of each agent name this laptop's local state describes
 * (§6.7).
 *
 * A destroy releases the name, and a later `create` can hand it to a different
 * box. The laptop that ran the destroy forgets everything it keyed on
 * `(fleet_id, name)` (`purge-agent.ts`); every *other* laptop learns of the
 * release only by reading the fleet. So each laptop records the `created_at`
 * of the row its local state was gathered against, and compares on every read
 * that hands a head a live row:
 *
 * - the same `created_at`: the same box, nothing to do;
 * - a later `created_at`: the name was released and taken again since this
 *   laptop last looked. The old box's watermarks, opt-ins, fence and sessions
 *   are purged with the same `purgeLocalAgent` the release itself runs (less
 *   its incarnation step, which would undo the record), and the new
 *   incarnation is recorded;
 * - an earlier `created_at` than the recorded one: a read that was delayed past
 *   a newer one (two scans in flight). Ignored — it neither purges nor records,
 *   so the reconciliation never moves backward to the predecessor;
 * - no record at all: the first time this laptop sees the name. It is recorded
 *   and nothing is purged. That includes every name on the first read after the
 *   upgrade that introduced this table: the state already on disk was gathered
 *   against *some* incarnation this laptop cannot now identify, and assuming it
 *   was the wrong one would wipe every operator's chat history, listening
 *   opt-ins and mutes on upgrade. A name released and re-taken before that first
 *   read keeps its stale state, exactly as it did before this table existed;
 * - recorded, but absent from a *complete* scan: the name was released and not
 *   yet taken again. Purged and forgotten, so a dead box's open notifications
 *   stop counting in the badge here too. A single-row read (`getAgent`) cannot
 *   tell absence from a name it did not ask about, so it never does this.
 *
 * A legacy `destroyed` row (§6.7, from before tombstones) counts as absent: it
 * is history, not a box.
 *
 * A scan is only complete if it saw every row. The store's `scan` skips a row it
 * cannot parse — a half-written item from an interrupted `create`, a row a newer
 * build wrote — and reports it through `unparseable()` (`backend/types.ts`,
 * `doctor`'s `unparseable_rows`). That row is missing from the scan but is not
 * released: reading it as absent would purge the name's chat sessions, fence,
 * opt-ins and mute, and once the row parses again it would be a first sighting
 * with nothing left to adopt. So the absence rule is skipped for the whole read
 * whenever any row was unparseable, rather than excluding the reported names:
 * the store may report a row with no readable name at all (`(unnamed row)`), and
 * a skipped release only delays the purge to the next fully parsed scan, while a
 * wrongly applied one loses state for good. The `created_at` comparison for the
 * rows that did parse still runs. If the store cannot say what it skipped (the
 * probe throws), the scan counts as incomplete too. The skipped list is read
 * once on entry, before any await (see `reconcileIncarnations`): a purge yields,
 * and a concurrent scan finishing meanwhile would otherwise replace it.
 *
 * Reconciles overlap: two reads in one process (a purge yields), or the CLI and
 * the app sharing one SQLite file. Each decides against the record as it read
 * it, and by the time it acts another may have moved the record on. Acting on a
 * stale read is the failure that matters — an older scan purging the
 * successor's freshly configured state and recording the predecessor again —
 * so every write is a compare-and-set against the value the decision was made
 * on (`claim`, `forgetIf`), and a purge follows only a write this call won:
 *
 * - a row whose record must change *claims* the new value first and purges
 *   after. Winning the claim proves the record still held what the decision was
 *   based on, so the purge is the one that decision called for; a lost claim
 *   purges nothing, re-reads the record and decides again, so a newer scan that
 *   lost to an older one still records itself rather than leaving the record
 *   behind (and purges what the older one adopted, as any later incarnation
 *   would). Claiming first also keeps "a failed purge is still recorded" for
 *   free;
 * - a name absent from a complete scan is forgotten only if the record still
 *   holds the value the scan read, and purged only if that delete happened. A
 *   concurrent scan that recorded a successor meanwhile has made the name live
 *   again, and the absence this scan saw is already out of date.
 *
 * The compare is on the exact recorded string, so the ordering rules
 * (`isOlder`, the `inFuture` exception) stay here in one place rather than
 * being repeated in SQL.
 *
 * Purely local, like the tables it guards — nothing here reaches AWS, and it
 * must never move to DynamoDB, because "what this laptop has seen" is the whole
 * meaning of a row.
 */

/**
 * `name → created_at` for one fleet, as last recorded on this laptop.
 *
 * The reconciler only ever writes through the compare-and-set pair, `claim` and
 * `forgetIf`: each succeeds only while the record still holds the value the
 * caller last read, and reports whether it did. `forget` is unconditional and
 * belongs to the release's own purge (`purge-agent.ts`), which drops the record
 * whatever it holds.
 */
export interface IncarnationStore {
  list(fleet: string): Map<string, string>;
  get(fleet: string, name: string): string | undefined;
  /**
   * Record `next` for `name` if the record still holds `expected` — `undefined`
   * meaning "no record". Returns whether this call wrote it.
   */
  claim(fleet: string, name: string, expected: string | undefined, next: string): boolean;
  /** Drop `name`'s record if it still holds `expected`. Returns whether it did. */
  forgetIf(fleet: string, name: string, expected: string): boolean;
  forget(fleet: string, name: string): void;
}

export class MemoryIncarnationStore implements IncarnationStore {
  private readonly fleets = new Map<string, Map<string, string>>();

  list(fleet: string): Map<string, string> {
    return new Map(this.fleets.get(fleet) ?? []);
  }

  get(fleet: string, name: string): string | undefined {
    return this.fleets.get(fleet)?.get(name);
  }

  claim(fleet: string, name: string, expected: string | undefined, next: string): boolean {
    if (this.get(fleet, name) !== expected) return false;
    const names = this.fleets.get(fleet) ?? new Map<string, string>();
    names.set(name, next);
    this.fleets.set(fleet, names);
    return true;
  }

  forgetIf(fleet: string, name: string, expected: string): boolean {
    if (this.get(fleet, name) !== expected) return false;
    return this.fleets.get(fleet)?.delete(name) ?? false;
  }

  forget(fleet: string, name: string): void {
    this.fleets.get(fleet)?.delete(name);
  }
}

/** The part of an agent row the comparison needs. */
export interface IncarnationRow {
  name: string;
  created_at: string;
  status?: string;
}

export interface IncarnationReconcilerDeps {
  store: IncarnationStore;
  /** The fleet this instance was opened as; `null` with no frozen config. */
  fleet: () => string | null;
  /**
   * `purge-agent.ts`'s `purgeLocalAgent`, the one the release runs, but built
   * *without* the incarnation store: the reconciler claims the new
   * `created_at` before purging, and a purge that forgot the record would drop
   * that claim, leaving the name unrecorded for a concurrent scan to adopt an
   * older value into.
   */
  purge: (fleetId: string, name: string) => Promise<void>;
  /**
   * Names the most recent scan skipped as unparseable (`agents.unparseable?.()`);
   * absent for a store that does not track them. It reflects the latest scan
   * only, so the reconciler reads it once on entry, before any await, and the
   * caller must call straight after its own `scan()` resolves.
   */
  unparseable?: () => readonly string[];
}

export interface ReconcileOptions {
  /**
   * The rows are the whole fleet (a scan), so a recorded name missing from
   * them has been released. `false` for a single-row read.
   */
  complete: boolean;
}

/**
 * Whether instant `a` is strictly before `b`. Parsed rather than compared as
 * strings, so `…:00Z` and `…:00.000Z` order correctly; an unparseable value is
 * never "older", so it falls through to the plain different-incarnation rule.
 */
function isOlder(a: string, b: string): boolean {
  return Date.parse(a) < Date.parse(b);
}

/**
 * How far past this laptop's clock a recorded `created_at` may sit and still be
 * a genuine incarnation: the same 60 seconds `release-name.ts` allows a
 * tombstone for a laptop trailing the one that wrote it. Kept local rather than
 * imported, so this purely local module does not reach into the AWS-side
 * lifecycle code.
 */
const FUTURE_SKEW_MS = 60_000;

function inFuture(createdAt: string): boolean {
  return Date.parse(createdAt) > Date.now() + FUTURE_SKEW_MS;
}

export function createIncarnationReconciler(deps: IncarnationReconcilerDeps) {
  /**
   * Never throws: like `observeHealth`, this is bookkeeping a read does on the
   * way past, and a broken local table must not be what fails a fleet list or
   * a chat send. A purge that fails part-way still records the new
   * incarnation — the claim is written before the purge runs, `purgeLocalAgent`
   * has already run every step it could, and retrying on every poll would keep
   * wiping whatever the operator sets up on the new box.
   */
  return async function reconcileIncarnations(
    rows: readonly IncarnationRow[],
    opts: ReconcileOptions,
  ): Promise<void> {
    // Snapshot before the first await. `unparseable()` describes the store's
    // *latest* scan, and a purge below yields to the event loop, where a
    // concurrent scan can finish and replace it. Callers invoke this straight
    // after their own `scan()` resolves, with no await between, so this is the
    // skipped list of the scan whose rows are being reconciled. An unreadable
    // probe counts as "something was skipped".
    let scanIncomplete = false;
    if (opts.complete) {
      try {
        scanIncomplete = (deps.unparseable?.() ?? []).length > 0;
      } catch {
        scanIncomplete = true;
      }
    }
    let fleet: string | null;
    let recorded: Map<string, string>;
    try {
      fleet = deps.fleet();
      if (fleet === null) return;
      recorded = deps.store.list(fleet);
    } catch {
      return;
    }
    const purge = async (name: string): Promise<void> => {
      try {
        await deps.purge(fleet, name);
      } catch {
        // See above: best effort, recorded regardless.
      }
    };
    /**
     * Bring `name`'s record to `createdAt`, starting from `prior` as `list`
     * read it. Each pass decides against the record as last read and writes
     * only by `claim`, so a pass acting on a value someone else has since
     * replaced loses and purges nothing; it re-reads and decides again. A won
     * claim ends it: the record now holds `createdAt`, and a replacement purges
     * the old box's state once. The purge leaves the record alone (see
     * `purge` on the deps), so there is nothing to re-check afterwards.
     * Bounded: a record still contended after `CLAIM_ATTEMPTS` lost claims is
     * left for the next read, which compares afresh.
     */
    const settle = async (name: string, createdAt: string, recordedAt: string | undefined) => {
      let prior = recordedAt;
      for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
        const action = decide(prior, createdAt);
        if (action === "keep") return;
        try {
          if (!deps.store.claim(fleet, name, prior, createdAt)) {
            prior = deps.store.get(fleet, name);
            continue;
          }
        } catch {
          // Unrecorded means the next read compares again; nothing is lost.
          return;
        }
        if (action === "replace") await purge(name);
        return;
      }
    };
    const live = new Set<string>();
    for (const row of rows) {
      if (row.status === "destroyed") continue;
      live.add(row.name);
      await settle(row.name, row.created_at, recorded.get(row.name));
    }
    if (!opts.complete || scanIncomplete) return;
    for (const [name, recordedAt] of recorded) {
      if (live.has(name)) continue;
      /**
       * Conditional on the value this scan read. A scan running alongside may
       * have recorded a successor since `list` — the name is live again, and
       * this scan's view of it as released is out of date — so the delete
       * misses and nothing is purged. Only a delete that happened earns the
       * purge, and in-process the two run with no await between them.
       */
      let released = false;
      try {
        released = deps.store.forgetIf(fleet, name, recordedAt);
      } catch {
        // As above.
      }
      if (released) await purge(name);
    }
  };
}

/** How many compare-and-set passes `settle` makes before leaving a contended record. */
const CLAIM_ATTEMPTS = 4;

/**
 * What a live row asks of its name's record, given the value it holds now:
 * `keep` it, `adopt` the row on a first sighting (record, purge nothing), or
 * `replace` it (record, then purge the old box's state).
 */
function decide(prior: string | undefined, createdAt: string): "keep" | "adopt" | "replace" {
  if (prior === createdAt) return "keep";
  if (prior === undefined) return "adopt";
  /**
   * Monotonic: a row older than the one recorded is a delayed read — a scan
   * that began before the successor was created and finished after a newer
   * scan recorded it. Acting on it would purge the successor's freshly
   * configured local state and record the predecessor again, and the next
   * poll would purge once more. A name's `created_at` only moves forward
   * (§6.7), so an older one is stale, never a release; it is ignored.
   *
   * Only while the recorded value is believable. A row's `created_at` is
   * written by the box, so one dated in the future was forged or skewed,
   * and trusting it as the high-water mark would make every real successor
   * read as "older" for good, carrying the dead box's local state forward
   * forever. Past `FUTURE_SKEW_MS` beyond now, the comparison is
   * abandoned and the plain different-incarnation rule applies.
   */
  if (isOlder(createdAt, prior) && !inFuture(prior)) return "keep";
  return "replace";
}

export type ReconcileIncarnations = ReturnType<typeof createIncarnationReconciler>;
