/**
 * The `_fleet` lock (§4.4), as the two operations that take it both need it.
 *
 * `foundation.update` and `apply` kind `network` are the same ceremony over
 * different blast radii: take the one fleet-wide lock, keep it alive from
 * *inside* the long phases rather than only between them, and release it in a
 * `finally` so an aborted browser tab does not leave a fleet locked for the
 * whole TTL. Both of them also have to treat a lost lock as a failure of the
 * op rather than a silent no-op — a commit point that quietly does nothing is
 * how a fleet ends up reporting "update available" for ever with its stack
 * already updated.
 *
 * This module exists because that argument is subtle enough that two copies of
 * it would drift, and the copy that drifted would be the one nobody was
 * looking at. `createFleetLock` takes the backend and the TTL explicitly; it
 * holds no state of its own, so a caller still threads the current `FleetItem`
 * through its own phases the way it always did.
 */
import type { Backend, FleetExpectation } from "../backend/types.ts";
import { HermeticError } from "../errors.ts";
import type { FleetItem } from "../schema/index.ts";
import { FLEET_KEY } from "../schema/index.ts";
import { isLockLive } from "../agents/state.ts";
import { PUBLIC_METHODS } from "../surface.ts";

/**
 * How long any §4.4 lock lives without being renewed — the per-agent locks and
 * the fleet-wide one alike. Ten minutes, because the operations that take it
 * are stack updates and instance launches, and they keep it alive from inside
 * their long phases (`fleetLockKeeper`).
 */
export const LOCK_TTL_MS = 10 * 60_000;

/**
 * The TTL a provider-profile write takes the fleet lock for (§8.3).
 *
 * Thirty seconds rather than ten minutes, because the shape of the operation is
 * different in both directions. It is two writes — the settings record and the
 * SSM slot — with nothing slow between them, so it never needs ten minutes; and
 * it runs no heartbeat, because a heartbeat only earns its keep on an operation
 * with long phases to renew from inside. That combination is only safe if the
 * TTL is short: the cost of a laptop dying mid-rotation is that nobody can touch
 * this fleet's profiles until the lock expires, and thirty seconds is a wait an
 * operator will sit through where ten minutes is one they would work around.
 */
export const PROFILE_LOCK_TTL_MS = 30_000;

/**
 * The owner string a lock is taken under: who, which run, and — for the callers
 * that pass one — what they are doing.
 *
 * The operation rides on the owner rather than on a field of its own because
 * the lock is read by callers that have no other way to ask. An agent operation
 * refused by a live fleet lock has the owner string and nothing else, and
 * "something is in progress" is not a thing an operator can act on. `#` already
 * separates the actor from the run id, so the operation goes after a space,
 * which neither an ARN nor a UUID contains.
 */
export function lockOwner(actor: string, runId: string, operation?: string): string {
  return `${actor}#${runId}${operation === undefined ? "" : ` ${operation}`}`;
}

/**
 * The revision an operation took the lock at, and commits its final whole-item
 * write against (§4.4).
 *
 * Taken from the item read *at the lock take*, and then carried unchanged
 * through every phase — which is what makes it mean anything. Renewing the lock
 * writes the `lock` attribute alone and leaves both counters where they are, so
 * a value captured here is still the answer ten minutes and four phases later:
 * either nobody else wrote `_fleet`, or the commit point refuses rather than
 * reverting them.
 */
export function expectationOf(fleet: FleetItem): FleetExpectation {
  return { version: fleet.version ?? 0, settingsVersion: fleet.settings?.version ?? null };
}

/**
 * Every operation an owner string may name itself as: the command surface, which
 * covers both spellings a caller uses — the dotted method a public surface entry
 * is called by (`providers.update`) and the bare command an operation that is a
 * command in its own right is typed as (`teardown`, itself a public method).
 *
 * A closed set rather than a pattern, because the pattern it replaces matched
 * any trailing lowercase word. An owner is an actor and a run id, and neither is
 * hermetic's to constrain: an IAM role path, a session name or an SSO user name
 * ending in a space and a word would have been read back as an operation, and
 * the refusal would have told the operator that "developer is in progress".
 */
const LOCK_OPERATIONS: ReadonlySet<string> = new Set<string>(PUBLIC_METHODS);

/**
 * The operation a lock was taken for, or `null` for an owner that named none —
 * which includes an owner whose trailing word is not an operation at all.
 */
export function lockOperation(owner: string): string | null {
  const trailing = / ([^ ]+)$/.exec(owner)?.[1];
  return trailing !== undefined && LOCK_OPERATIONS.has(trailing) ? trailing : null;
}

/**
 * What the holder of the fleet lock is doing, worded for the start of a refusal.
 *
 * A lock whose owner names no operation is a `foundation update` or an `apply`
 * kind `network` — the two callers that predate the convention and are the
 * overwhelmingly likely answer — so the old wording stays the fallback rather
 * than being replaced by something vaguer.
 */
export function lockActivity(owner: string): string {
  const op = lockOperation(owner);
  return op === null ? "a foundation update is in progress" : `${op} is in progress`;
}

export interface FleetLockDeps {
  backend: Backend;
  /** The same TTL every agent lock uses (§4.4); the fleet lock is one of them. */
  lockTtlMs: number;
  /** The backend's clock, so a test can hold time still. */
  now: () => Date;
  /**
   * The command an operator re-runs after a lost lock, spelled the way they
   * would type it. Part of the message rather than of the caller, because "the
   * lock was lost" is only actionable when it says what to do next — and the
   * two callers say different things.
   */
  rerun: string;
}

export interface FleetLock {
  /** Is somebody holding it — and, when `owner` is given, somebody who is not us? */
  isLive(fleet: FleetItem, owner?: string): boolean;
  /**
   * The caller's copy with our lock stamped on it, TTL from now. Nothing is
   * written — `acquire` writes the lock — so this is only how a long operation
   * keeps its in-memory copy honest about who holds it.
   */
  withLock(fleet: FleetItem, owner: string): FleetItem;
  /**
   * Replace the whole item at a commit point, and refuse loudly rather than
   * overwrite anybody. `what` names the write, because "the lock was lost
   * while …" is only actionable if it says which step was interrupted.
   *
   * `expect` is the row as this operation *read* it when it took the lock —
   * `expectationOf` of that item, not of the one being written. The two differ
   * on purpose: a migration may have put settings on the copy in hand, and the
   * question the store answers is whether anybody else changed the stored row
   * since, not what this write is about to say. Two ways it can be refused, and
   * they are different failures — somebody else holds the lock now (`LOCKED`),
   * or the row moved while nobody held it (`CONFLICT`).
   */
  writeLocked(
    next: FleetItem,
    owner: string,
    what: string,
    expect: FleetExpectation,
  ): Promise<FleetItem>;
  /**
   * Push the expiry out, by writing the `lock` attribute alone. Called between
   * phases, and from inside the long ones. It requires the stored lock to be
   * *already ours and still live*, and is `LOCKED` otherwise — whether somebody
   * else took it or it merely lapsed with nobody else wanting it. Either way
   * this run no longer holds what it believes it holds, and a renew that
   * re-acquired would paper over the window in which it did not.
   */
  renew(fleet: FleetItem, owner: string): Promise<FleetItem>;
  /** Drop it. A release that loses the race is a no-op, never an error. */
  release(fleet: FleetItem, owner: string): Promise<FleetItem>;
  /**
   * Take the lock by writing *only* the lock field, without holding a copy of
   * the item at all. `false` means somebody else's lock is live.
   *
   * Every caller takes it this way — the long operations as well as §8.3's
   * profile writes. Taking it from a copy of the item would write back every
   * other attribute as the caller last read them, and so revert any settings or
   * metadata write that landed in between; and because a lock take leaves
   * `version` alone, the holder's own expectation survives every renew.
   */
  acquire(owner: string): Promise<boolean>;
  /** Give it back, by the same narrow door. Losing the race is a no-op. */
  unlock(owner: string): Promise<void>;
  /**
   * The clock every expiry on this lock is written and read against — the
   * backend's, not the process's.
   *
   * Exposed because `fleetLockKeeper` has to age the lock on the same clock
   * that stamps its expiry. Reading `Date.now()` there while the expiry came
   * from `deps.now()` gave one heartbeat two clocks: a test holding time still
   * could never make a renewal come due, and in production the two could drift
   * apart, so a lock could pass its stamped expiry without the keeper noticing
   * it was a third of its life old.
   */
  now(): Date;
}

export function createFleetLock(deps: FleetLockDeps): FleetLock {
  const { backend, now } = deps;

  function withLock(fleet: FleetItem, owner: string): FleetItem {
    return {
      ...fleet,
      lock: { owner, expires: new Date(now().getTime() + deps.lockTtlMs).toISOString() },
    };
  }

  /**
   * A lost lock is never something to carry on through. Ignoring it made the
   * *commit point* a silent no-op — the stack updated, the manifest was
   * rewritten, `_fleet` was not stamped, and the op still ended `done`, so the
   * fleet looked updated and reported "update available" forever.
   */
  function lockLost(what: string, owner: string, holder: string | null): HermeticError {
    return new HermeticError(
      "LOCKED",
      `the ${FLEET_KEY} lock was lost while ${what}; ${holder ?? "another operator"} holds it now. The stack and the release may already be updated — re-run ${deps.rerun} once they are done.`,
      { what, owner, holder },
    );
  }

  /**
   * The commit point's write. It is refused for two different reasons, and they
   * are worth telling apart: the lock was lost to somebody who holds it now, or
   * the row changed under a lock that had quietly expired — the second being
   * the case where writing this item anyway would revert their change.
   */
  async function writeLocked(
    next: FleetItem,
    owner: string,
    what: string,
    expect: FleetExpectation,
  ): Promise<FleetItem> {
    const written = await backend.store.fleet.replaceFleet(next, owner, now(), expect);
    if (written !== null) return written;
    const held = await backend.store.fleet.get();
    // Every one of these writes is conditional on the row existing, so a
    // refusal with no row behind it is a deleted `_fleet`, not a contested one.
    // Reporting it as `CONFLICT` with `actual: 0` sent an operator looking for
    // the write that moved the counter, and there was none.
    if (held === null) {
      throw new HermeticError(
        "NOT_FOUND",
        `this fleet has no ${FLEET_KEY} record, so ${what} could not be recorded; run \`hermetic doctor\``,
        { what, owner, scope: "fleet" },
      );
    }
    if (isLockLive(held?.lock, owner, now().getTime())) {
      throw lockLost(what, owner, held?.lock?.owner ?? null);
    }
    throw new HermeticError(
      "CONFLICT",
      `${FLEET_KEY} changed while ${what}, so this operation would have reverted somebody else's write. The stack and the release may already be updated — re-run ${deps.rerun}.`,
      { what, owner, expected: expect.version, actual: held?.version ?? 0 },
    );
  }

  return {
    isLive: (fleet, owner) => isLockLive(fleet.lock, owner, now().getTime()),
    withLock,
    writeLocked,
    /**
     * `renewFleetLock`, never `lockFleet`. A take succeeds on a lock that is
     * absent, null or expired, and for a renew each of those is the failure it
     * is meant to report: the run's TTL lapsed inside a long phase, the fleet
     * was unprotected for however long that took, and re-acquiring it here
     * would hide that window rather than end the operation on it. Whether
     * somebody else took the lock in the meantime or nobody did makes no
     * difference to this run — it did not hold what it believed it held.
     */
    renew: async (fleet, owner) => {
      const expires = new Date(now().getTime() + deps.lockTtlMs).toISOString();
      if (await backend.store.fleet.renewFleetLock(owner, expires, now())) {
        return { ...fleet, lock: { owner, expires } };
      }
      const held = await backend.store.fleet.get();
      const holder = held?.lock ?? null;
      throw lockLost(
        "renewing the lock",
        owner,
        holder !== null && isLockLive(holder, owner, now().getTime()) ? holder.owner : null,
      );
    },
    release: async (fleet, owner) => {
      // A release that loses the race has nothing to release: somebody else's
      // lock is theirs to drop, and refusing loudly here would replace the
      // outcome the caller actually cares about. `unlockFleet` is silent on a
      // failed condition for exactly that reason.
      await backend.store.fleet.unlockFleet(owner);
      return { ...fleet, lock: null };
    },
    acquire: (owner) =>
      backend.store.fleet.lockFleet(
        owner,
        new Date(now().getTime() + deps.lockTtlMs).toISOString(),
        now(),
      ),
    unlock: (owner) => backend.store.fleet.unlockFleet(owner),
    now,
  };
}

/**
 * The heartbeat both callers hand to their long phases: renew once the lock is
 * a third of its life old, and not once per poll (§4.4). Written here because
 * the "a third" is the number that makes a stack update, a large archive and a
 * slow push each survive on their own, and two copies of it would not stay the
 * same number.
 *
 * Named for the *fleet* lock specifically: `hermetic.ts` has a `lockKeeper` of
 * its own doing the same job for the per-agent locks, and the two are not
 * interchangeable.
 *
 * The age is measured on `lock.now()` — the backend's clock, the one that
 * stamps the expiry being renewed — and never on `Date.now()`. One clock
 * writes the deadline and another deciding when to beat is two clocks for one
 * heartbeat: a test holding time still could not make a renewal come due, and
 * in production nothing keeps the two in step. `hermetic.ts`'s per-agent
 * `lockKeeper` already ages on `backend.clock` for the same reason.
 */
export function fleetLockKeeper(
  lock: FleetLock,
  lockTtlMs: number,
  read: () => FleetItem,
  write: (fleet: FleetItem) => void,
  owner: string,
): () => Promise<void> {
  let renewedAt = lock.now().getTime();
  return async () => {
    const at = lock.now().getTime();
    if (at - renewedAt < lockTtlMs / 3) return;
    renewedAt = at;
    write(await lock.renew(read(), owner));
  };
}
