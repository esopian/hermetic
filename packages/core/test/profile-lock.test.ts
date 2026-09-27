/**
 * §8.3's profile writes under the `_fleet` lock (§4.4).
 *
 * The bug this file exists for cannot be seen from either operator's side.
 * `providers.update` commits revision N+1 to `_fleet.settings` and *then*
 * overwrites the shared SSM slot, so two rotations of the same profile can
 * interleave into a record that says r3 holding the key that belongs to r2 —
 * both commands report success, the record is internally consistent, and every
 * agent on that profile is quietly using a key the fleet no longer believes it
 * has. Serialising the pair of writes is the only thing that prevents it, so
 * the tests here are about the lock rather than about the profiles.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  FIXTURE_PROFILE_IDS,
  MemoryBackend,
  seedFixtureFleet,
} from "../src/backend/memory.ts";
import { sharedSecretPath as sharedSecretPathFor } from "../src/backend/constants.ts";
import {
  LOCK_TTL_MS,
  PROFILE_LOCK_TTL_MS,
  createFleetLock,
  expectationOf,
  lockOperation,
  lockOwner,
} from "../src/fleet/fleet-lock.ts";
import { profileSlotSlug } from "../src/schema/index.ts";
import type { FleetItem, FleetSettings } from "../src/schema/index.ts";
import { HermeticError } from "../src/errors.ts";
import { drain, testHermetic } from "./helpers.ts";

const ANT = FIXTURE_PROFILE_IDS.anthropic;
const ANT_PATH = sharedSecretPathFor(FIXTURE_CONFIG.fleet_id, profileSlotSlug(ANT));
/** Every shared slot this fleet has, by the path prefix they all share. */
const SHARED_PREFIX = ANT_PATH.slice(0, ANT_PATH.lastIndexOf("/") + 1);

/** Fixture values that stay obviously fixtures (§11.3, the leak grep). */
const KEY_ONE = "sk-FIXTURE-ROTATION-ONE";
const KEY_TWO = "sk-FIXTURE-ROTATION-TWO";

function fleet() {
  const backend = seedFixtureFleet(new MemoryBackend());
  return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG }) };
}

function fleetOf(backend: MemoryBackend): FleetItem {
  return backend.fleetItem!;
}

async function errorOf(fn: () => Promise<unknown>): Promise<HermeticError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof HermeticError) return e;
    throw e;
  }
  throw new Error("expected a HermeticError, and the call succeeded");
}

/** Stamp somebody else's live lock on `_fleet`, the way a running op would. */
function holdLock(backend: MemoryBackend, owner: string, ttlMs = 60_000): string {
  backend.fleetItem = {
    ...fleetOf(backend),
    lock: { owner, expires: new Date(backend.clock.now().getTime() + ttlMs).toISOString() },
  };
  return owner;
}

describe("a profile write holds the fleet lock across both of its writes", () => {
  /**
   * The race the lock exists for, driven at the one instant it is visible: the
   * first rotation has committed r2 and is inside the SSM write. Without the
   * lock the second rotation would read r2, commit r3 and write its own key —
   * and whichever SSM write finished last would decide what the fleet is
   * actually using, with nothing recording the disagreement.
   */
  test("a second rotation mid-flight is refused, and succeeds once the first is done", async () => {
    const { backend, hermetic } = fleet();
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const realPut = backend.secrets.put;
    let puts = 0;
    backend.secrets.put = async (path: string, value: string) => {
      puts += 1;
      if (puts === 1) {
        reached.resolve();
        await release.promise;
      }
      await realPut(path, value);
    };

    const first = hermetic.providers.update({ profile: ANT, api_key: KEY_ONE });
    await reached.promise;

    const refused = await errorOf(() => hermetic.providers.update({ profile: ANT, api_key: KEY_TWO }));
    expect(refused.code).toBe("LOCKED");
    // Named by what the holder is doing, not by a foundation update that is not
    // running — and by the holder itself, so two operators can find each other.
    expect(refused.message).toInclude("providers.update is in progress");
    expect(refused.message).toInclude(fleetOf(backend).lock!.owner);
    expect(lockOperation(fleetOf(backend).lock!.owner)).toBe("providers.update");
    // The refusal wrote nothing: the first rotation's record still stands alone.
    expect(fleetOf(backend).settings!.profiles![ANT]!.revision).toBe(2);

    release.resolve();
    await first;
    // …and the lock is gone the moment the first finishes, not a TTL later.
    expect(fleetOf(backend).lock ?? null).toBeNull();

    await hermetic.providers.update({ profile: ANT, api_key: KEY_TWO });
    // Serialised: r3 on the record, r3's key in the slot. The interleaving
    // would have left r3 on the record and r2's key in the slot.
    expect(fleetOf(backend).settings!.profiles![ANT]!.revision).toBe(3);
    expect(await backend.secrets.get(ANT_PATH)).toBe(KEY_TWO);
  });

  /**
   * The lock is released in a `finally`, so the failure an operator is told
   * about is the rotation's and not "the fleet is locked" for the next thirty
   * seconds. The `CONFLICT` itself is the pre-existing contract: the record
   * moved and the slot did not, which is a re-run and not a repair.
   */
  test("an SSM failure mid-rotation still reports CONFLICT, and gives the lock back", async () => {
    const { backend, hermetic } = fleet();
    backend.secrets.put = async () => {
      throw new Error("ssm is down");
    };
    const failed = await errorOf(() => hermetic.providers.update({ profile: ANT, api_key: KEY_ONE }));
    expect(failed.code).toBe("CONFLICT");
    expect(failed.message).toInclude("re-run the rotation");
    expect(fleetOf(backend).lock ?? null).toBeNull();
  });

  /**
   * The gap the settings condition cannot cover: between the commit and the
   * slot write.
   *
   * The commit carries the owner, so a lost lock refuses it. SSM has no such
   * condition, so a `put` that arrives after the TTL lapsed would land on a
   * slot the next operator has already rotated — their record, our key, and
   * nothing anywhere recording the disagreement. The fence is a re-acquire
   * immediately before the write.
   */
  test("a rotation whose lock lapsed before the slot write refuses instead of overwriting", async () => {
    const { backend, hermetic } = fleet();
    const theirs = lockOwner("arn:aws:iam::000000000000:user/other", "run-2", "providers.update");
    const realPutSettings = backend.store.fleet.putSettings;
    let commits = 0;
    backend.store.fleet.putSettings = async (...args: Parameters<typeof realPutSettings>) => {
      const ok = await realPutSettings(...args);
      if (++commits === 1 && ok) {
        // Our thirty seconds run out while SSM is throttling us…
        backend.advance(PROFILE_LOCK_TTL_MS + 1_000);
        // …and the next operator takes the lock and rotates the same profile.
        expect(
          await backend.store.fleet.lockFleet(
            theirs,
            new Date(backend.clock.now().getTime() + PROFILE_LOCK_TTL_MS).toISOString(),
            backend.clock.now(),
          ),
        ).toBe(true);
        await backend.secrets.put(ANT_PATH, KEY_TWO);
      }
      return ok;
    };

    const refused = await errorOf(() => hermetic.providers.update({ profile: ANT, api_key: KEY_ONE }));
    expect(refused.code).toBe("CONFLICT");
    expect(refused.message).toInclude(profileSlotSlug(ANT));
    expect(refused.message).toInclude("re-run the rotation");
    // The whole point: their key is still the one the slot holds.
    expect(await backend.secrets.get(ANT_PATH)).toBe(KEY_TWO);
    // And giving our lock back does not take theirs away.
    expect(fleetOf(backend).lock?.owner).toBe(theirs);
  });

  /**
   * The other side of the same fence. The write landed, but the lock was not
   * ours while it did, so the slot may hold a key the record does not describe
   * — which is the difference between "re-run it" and "it worked".
   */
  test("a rotation that loses the lock across the slot write says so", async () => {
    const { backend, hermetic } = fleet();
    const theirs = lockOwner("arn:aws:iam::000000000000:user/other", "run-2", "providers.update");
    const realPut = backend.secrets.put;
    let puts = 0;
    backend.secrets.put = async (path: string, value: string) => {
      await realPut(path, value);
      if (++puts === 1) {
        backend.advance(PROFILE_LOCK_TTL_MS + 1_000);
        await backend.store.fleet.lockFleet(
          theirs,
          new Date(backend.clock.now().getTime() + PROFILE_LOCK_TTL_MS).toISOString(),
          backend.clock.now(),
        );
      }
    };

    const refused = await errorOf(() => hermetic.providers.update({ profile: ANT, api_key: KEY_ONE }));
    expect(refused.code).toBe("CONFLICT");
    expect(refused.message).toInclude(profileSlotSlug(ANT));
    expect(refused.message).toInclude("re-run the rotation");
    expect(refused.details).toMatchObject({ profile: ANT, partial_write: profileSlotSlug(ANT) });
  });

  /**
   * A release is not part of the operation. `unlockFleet` rethrows anything
   * but a lost race, so an unwrapped `finally` would replace a rotation that
   * landed with an error, and the operator would re-run a write that already
   * happened. The TTL is what covers the release that never lands.
   */
  test("a throttled release does not fail a write that landed", async () => {
    const { backend, hermetic } = fleet();
    backend.store.fleet.unlockFleet = async () => {
      throw new Error("ProvisionedThroughputExceededException");
    };

    const result = await hermetic.providers.update({ profile: ANT, model: "claude-sonnet-5" });
    expect(result.profile.model).toBe("claude-sonnet-5");
    expect(fleetOf(backend).settings!.profiles![ANT]!.model).toBe("claude-sonnet-5");
    // Left behind, deliberately: thirty seconds from now it is nobody's.
    expect(lockOperation(fleetOf(backend).lock!.owner)).toBe("providers.update");
  });

  /** A TTL lock is a lock with an end (§4.4): a dead laptop frees this one in 30s. */
  test("a lock left behind by a dead process is taken over once it expires", async () => {
    const { backend, hermetic } = fleet();
    const owner = lockOwner("arn:aws:iam::000000000000:user/gone", "dead-run", "providers.update");
    expect(
      await backend.store.fleet.lockFleet(
        owner,
        new Date(backend.clock.now().getTime() + PROFILE_LOCK_TTL_MS).toISOString(),
        backend.clock.now(),
      ),
    ).toBe(true);

    expect(
      (await errorOf(() => hermetic.providers.update({ profile: ANT, model: "claude-sonnet-5" }))).code,
    ).toBe("LOCKED");

    backend.advance(PROFILE_LOCK_TTL_MS + 1_000);
    await hermetic.providers.update({ profile: ANT, model: "claude-sonnet-5" });
    expect(fleetOf(backend).settings!.profiles![ANT]!.model).toBe("claude-sonnet-5");
    expect(fleetOf(backend).lock ?? null).toBeNull();
  });
});

describe("every way out of a profile write gives the lock back", () => {
  /**
   * The rollback path, which is the one with two failures in it: the commit is
   * refused, the undo deletes the slot the create had already published — and
   * the `finally` still has to run, or a fleet is locked for thirty seconds
   * because somebody's create lost a race.
   */
  test("a create whose commit loses releases the lock", async () => {
    const { backend, hermetic } = fleet();
    const before = await backend.secrets.list(SHARED_PREFIX);
    // Every settings write is refused, which is what a lost race looks like
    // from inside `commitSettings`.
    backend.store.fleet.putSettings = async () => false;

    const refused = await errorOf(() =>
      hermetic.providers.create({ provider: "vercel", name: "vercel-spare", api_key: KEY_ONE }),
    );
    expect(refused.code).toBe("CONFLICT");
    expect(fleetOf(backend).lock ?? null).toBeNull();
    // The undo ran too: no slot left over holding a key nothing names.
    expect(await backend.secrets.list(SHARED_PREFIX)).toEqual(before);
  });

  /**
   * A refusal is an exit like any other. The confirmation is asked for inside
   * the lock — every reason the delete is impossible is found first (§8.3) —
   * so an operator who runs it without `--yes`, reads the sentence and runs it
   * properly must not be told the fleet is locked by their own last attempt.
   */
  test("a delete refused for want of a confirmation releases the lock", async () => {
    const { backend, hermetic } = fleet();
    const refused = await errorOf(() => hermetic.providers.delete({ profile: "vercel-gw" }));
    expect(refused.code).toBe("CONFIRMATION_REQUIRED");
    expect(fleetOf(backend).lock ?? null).toBeNull();

    // And the re-run, immediately, is not refused by the lock the first left.
    const done = await hermetic.providers.delete({ profile: "vercel-gw", yes: true });
    expect(done.deleted).toBe(true);
    expect(fleetOf(backend).lock ?? null).toBeNull();
  });
});

describe("what else the profile lock stops, and what it does not", () => {
  /**
   * §6.6's rule applied to a new holder: nothing per-agent may start while the
   * fleet-wide lock is live. What changes here is only the wording — an
   * operator refused during a key rotation is told about the key rotation.
   */
  test("an agent operation is refused, and the message names the providers command", async () => {
    const { backend, hermetic } = fleet();
    const owner = holdLock(
      backend,
      lockOwner("arn:aws:iam::000000000000:user/other", "run-1", "providers.update"),
    );

    // `juniper` is the fixture's stopped agent, so a `start` is a real
    // operation rather than a no-op that never reaches the lock.
    const refused = await errorOf(() => drain(hermetic.agents.start("juniper")));
    expect(refused.code).toBe("LOCKED");
    expect(refused.message).toInclude("providers.update is in progress");
    expect(refused.details).toMatchObject({ owner, scope: "fleet" });
  });

  /** Reads are never blocked: watching a fleet through a change is the point. */
  test("reads are unaffected", async () => {
    const { backend, hermetic } = fleet();
    holdLock(backend, lockOwner("arn:aws:iam::000000000000:user/other", "run-1", "providers.update"));
    expect((await hermetic.agents.list()).length).toBeGreaterThan(0);
    expect((await hermetic.providers.list()).profiles.length).toBeGreaterThan(0);
  });

  /**
   * One lock, both directions. A `foundation update` rewrites every agent row
   * and the whole release; a profile rotation rewrites a credential every
   * running agent reads. Neither may run inside the other.
   */
  test("foundation.update is refused while a profile write holds the lock", async () => {
    const { backend, hermetic } = fleet();
    holdLock(backend, lockOwner("arn:aws:iam::000000000000:user/other", "run-1", "providers.update"));
    const refused = await errorOf(() => drain(hermetic.foundation.update({ yes: true })));
    expect(refused.code).toBe("LOCKED");
    expect(refused.message).toInclude("providers.update is in progress");
  });

  test("a profile write is refused while a foundation update holds the lock", async () => {
    const { backend, hermetic } = fleet();
    // A foundation update's owner names no operation, so the message falls back
    // to the wording that was always right for it.
    holdLock(backend, lockOwner("arn:aws:iam::000000000000:user/other", "run-1"));
    const refused = await errorOf(() => hermetic.providers.update({ profile: ANT, model: "x" }));
    expect(refused.code).toBe("LOCKED");
    expect(refused.message).toInclude("a foundation update is in progress");
    expect(refused.message).toInclude("hermetic providers update");
  });
});

describe("FleetStore.lockFleet / replaceFleet / unlockFleet", () => {
  /**
   * The reason the lock is taken through a field-only write at all. Taking it
   * from a copy of the item means writing back every attribute as the caller
   * last read it, and profile writes are frequent enough that "as the caller
   * last read it" is routinely one settings version stale — so the lock itself
   * would revert a `settings.set` that landed in the gap.
   */
  test("taking the lock from a stale copy does not revert a settings write", async () => {
    const { backend } = fleet();
    const stale = (await backend.store.fleet.get())!;
    const before = stale.settings!.version;

    const landed: FleetSettings = { ...stale.settings!, version: before + 1 };
    expect(await backend.store.fleet.putSettings(landed, before, backend.clock.now())).toBe(true);

    const owner = lockOwner("arn:aws:iam::000000000000:user/me", "run-1", "providers.update");
    expect(
      await backend.store.fleet.lockFleet(
        owner,
        new Date(backend.clock.now().getTime() + PROFILE_LOCK_TTL_MS).toISOString(),
        backend.clock.now(),
      ),
    ).toBe(true);
    expect(fleetOf(backend).settings!.version).toBe(before + 1);
    expect(fleetOf(backend).lock?.owner).toBe(owner);

    // And the other door — the whole-item replacement the long operations commit
    // through — refuses the stale copy rather than writing it over the top. It
    // states the `settings.version` it was composed against, and that is no
    // longer the stored one.
    expect(
      await backend.store.fleet.replaceFleet(stale, owner, backend.clock.now(), {
        version: stale.version ?? 0,
        settingsVersion: before,
      }),
    ).toBeNull();
    expect(fleetOf(backend).settings!.version).toBe(before + 1);
  });

  /**
   * The counters `replaceFleet` is conditional on, one at a time, so a
   * regression in either is named rather than hidden by the other.
   * `MemoryBackend` has to refuse for exactly the reasons DynamoDB's condition
   * expression does, or the fixture would be a more permissive fleet than the
   * real one.
   */
  test("replaceFleet refuses a moved item version, a moved settings version and a foreign lock", async () => {
    const { backend } = fleet();
    const owner = lockOwner("arn:aws:iam::000000000000:user/me", "run-1", "foundation.update");
    const stored = (await backend.store.fleet.get())!;
    const at = { version: stored.version ?? 0, settingsVersion: stored.settings!.version };

    // Someone wrote an attribute: the item version moved, the expectation did not.
    expect(
      await backend.store.fleet.updateFleet(
        { tailscale_oauth_client_id: "kabc123" },
        { now: backend.clock.now() },
      ),
    ).not.toBeNull();
    expect(await backend.store.fleet.replaceFleet(stored, owner, backend.clock.now(), at)).toBeNull();

    // Caught up on the item version, but now a settings write lands.
    const caught = { ...at, version: at.version + 1 };
    const next: FleetSettings = { ...stored.settings!, version: at.settingsVersion + 1 };
    expect(await backend.store.fleet.putSettings(next, at.settingsVersion, backend.clock.now())).toBe(
      true,
    );
    expect(
      await backend.store.fleet.replaceFleet(stored, owner, backend.clock.now(), caught),
    ).toBeNull();

    // Both counters agree, but somebody else's lock is live.
    const agreed = { version: at.version + 1, settingsVersion: at.settingsVersion + 1 };
    const theirs = lockOwner("arn:aws:iam::000000000000:user/you", "run-2");
    holdLock(backend, theirs);
    expect(
      await backend.store.fleet.replaceFleet(stored, owner, backend.clock.now(), agreed),
    ).toBeNull();

    // And with the lock released it lands, bumping the counter it stated.
    await backend.store.fleet.unlockFleet(theirs);
    const written = await backend.store.fleet.replaceFleet(
      { ...stored, settings: next },
      owner,
      backend.clock.now(),
      agreed,
    );
    expect(written?.version).toBe(agreed.version + 1);
  });

  /**
   * The attribute-level door, from the other side: a patch names what it sets,
   * so everything it does not name survives — including the settings record a
   * whole-item write would have carried a stale copy of.
   */
  test("updateFleet writes the named attribute alone, under the lock condition", async () => {
    const { backend } = fleet();
    const stale = (await backend.store.fleet.get())!;
    const before = stale.settings!.version;
    const landed: FleetSettings = { ...stale.settings!, version: before + 1 };
    expect(await backend.store.fleet.putSettings(landed, before, backend.clock.now())).toBe(true);

    const written = await backend.store.fleet.updateFleet(
      { tailscale_oauth_client_id: "kabc123" },
      { now: backend.clock.now() },
    );
    expect(written?.tailscale_oauth_client_id).toBe("kabc123");
    expect(written?.settings?.version).toBe(before + 1);
    expect(written?.version).toBe((stale.version ?? 0) + 1);

    // A live lock somebody else holds refuses it; theirs does not refuse them.
    const theirs = lockOwner("arn:aws:iam::000000000000:user/you", "run-2");
    holdLock(backend, theirs);
    expect(
      await backend.store.fleet.updateFleet({ tailnet: "other.ts.net" }, { now: backend.clock.now() }),
    ).toBeNull();
    expect(
      await backend.store.fleet.updateFleet(
        { tailnet: "other.ts.net" },
        { now: backend.clock.now(), owner: theirs },
      ),
    ).not.toBeNull();
    expect(fleetOf(backend).tailnet).toBe("other.ts.net");

    // And the stated revision, when one is stated, is checked too.
    expect(
      await backend.store.fleet.updateFleet(
        { tailnet: "third.ts.net" },
        { now: backend.clock.now(), owner: theirs, expectVersion: 0 },
      ),
    ).toBeNull();
  });

  /**
   * The re-entry the holder needs, and its limit. Our own lock does not refuse
   * our own settings write; a lock that expired under us and was taken by
   * somebody else is a different owner and still does — which is what makes a
   * rotation without a heartbeat fail loudly instead of overwriting.
   */
  test("putSettings accepts the lock's holder and still refuses a different one", async () => {
    const { backend } = fleet();
    const mine = lockOwner("arn:aws:iam::000000000000:user/me", "run-1", "providers.update");
    const theirs = lockOwner("arn:aws:iam::000000000000:user/you", "run-2", "providers.update");
    const stored = (await backend.store.fleet.get())!;
    const at = stored.settings!.version;
    holdLock(backend, mine);

    const next: FleetSettings = { ...stored.settings!, version: at + 1 };
    expect(await backend.store.fleet.putSettings(next, at, backend.clock.now(), mine)).toBe(true);

    const after: FleetSettings = { ...next, version: at + 2 };
    expect(await backend.store.fleet.putSettings(after, at + 1, backend.clock.now(), theirs)).toBe(
      false,
    );
    // And with no owner at all, which is every other writer on this fleet.
    expect(await backend.store.fleet.putSettings(after, at + 1, backend.clock.now())).toBe(false);
  });

  /**
   * The memory mirror of the real store's `attribute_not_exists(#name)`. `put`
   * is `init --create`'s door and nobody else's: a whole-item write onto a
   * `_fleet` that is already there would revert its lock, its settings and its
   * revision counter in one go, which is the write every other method in this
   * store was rewritten to make impossible.
   */
  test("put creates _fleet and refuses a row that is already there", async () => {
    const { backend } = fleet();
    const stored = fleetOf(backend);
    const e = await errorOf(() =>
      backend.store.fleet.put({ ...stored, tailnet: "somewhere-else.ts.net", lock: null }),
    );
    expect(e.code).toBe("CONFLICT");
    expect(e.message).toContain(stored.fleet_id);
    expect(fleetOf(backend).tailnet).toBe(stored.tailnet);

    // The same call on a fleet that has no item is the creation it is for, and
    // the revision counter is present from that first write.
    const empty = new MemoryBackend();
    await empty.store.fleet.put({ ...stored, version: undefined });
    expect(empty.fleetItem?.version).toBe(0);
  });

  /**
   * A renew is not a take. Going through `lockFleet` — which succeeds on a lock
   * that is absent, null or expired — meant a run whose TTL lapsed inside a
   * long phase silently re-acquired, and the window in which anybody could have
   * taken the fleet left no trace.
   */
  test("renewFleetLock refuses a lapsed lock rather than taking it back", async () => {
    const { backend } = fleet();
    const mine = lockOwner("arn:aws:iam::000000000000:user/me", "run-1", "foundation.update");
    const theirs = lockOwner("arn:aws:iam::000000000000:user/you", "run-2");
    const later = new Date(backend.clock.now().getTime() + 60_000).toISOString();

    // Ours and live: the ordinary case, and the only one that succeeds.
    holdLock(backend, mine);
    expect(await backend.store.fleet.renewFleetLock(mine, later, backend.clock.now())).toBe(true);
    expect(fleetOf(backend).lock?.expires).toBe(later);

    // Lapsed, and somebody else took it.
    holdLock(backend, theirs);
    expect(await backend.store.fleet.renewFleetLock(mine, later, backend.clock.now())).toBe(false);
    expect(fleetOf(backend).lock?.owner).toBe(theirs);

    // Lapsed, and nobody took it: still a refusal, and the lock is not ours again.
    holdLock(backend, mine, -1);
    expect(await backend.store.fleet.renewFleetLock(mine, later, backend.clock.now())).toBe(false);
    expect(fleetOf(backend).lock?.expires).not.toBe(later);

    // Released altogether: there is nothing to renew.
    await backend.store.fleet.unlockFleet(mine);
    expect(await backend.store.fleet.renewFleetLock(mine, later, backend.clock.now())).toBe(false);
    expect(fleetOf(backend).lock).toBeNull();
  });

  /** Nothing to set is nothing to write, and a counter that moves for a no-op
   * refuses somebody else's commit point for no reason at all. */
  test("a patch that names nothing moves no counter", async () => {
    const { backend } = fleet();
    const before = fleetOf(backend).version ?? 0;
    backend.resetMutations();

    const written = await backend.store.fleet.updateFleet(
      { tailnet: undefined },
      { now: backend.clock.now() },
    );
    expect(written?.version ?? 0).toBe(before);
    expect(fleetOf(backend).version ?? 0).toBe(before);
    expect(backend.mutations).toEqual([]);
  });

  test("unlockFleet by anybody but the holder is a no-op", async () => {
    const { backend } = fleet();
    const mine = lockOwner("arn:aws:iam::000000000000:user/me", "run-1", "providers.update");
    holdLock(backend, mine);

    await backend.store.fleet.unlockFleet("somebody-else");
    expect(fleetOf(backend).lock?.owner).toBe(mine);

    await backend.store.fleet.unlockFleet(mine);
    expect(fleetOf(backend).lock).toBeNull();
    // Releasing a lock that is already gone is not a failure either.
    await backend.store.fleet.unlockFleet(mine);
  });
});

/**
 * The two refusals `createFleetLock` turns a store's `null`/`false` into. Both
 * were wrong in the same direction: they told an operator to look for another
 * operator who was not there.
 */
describe("the fleet lock's own refusals", () => {
  function lockOf(backend: MemoryBackend) {
    return createFleetLock({
      backend,
      lockTtlMs: LOCK_TTL_MS,
      now: () => backend.clock.now(),
      rerun: "`hermetic foundation update`",
    });
  }

  test("renew refuses a lapsed lock instead of quietly re-acquiring it", async () => {
    const { backend } = fleet();
    const lock = lockOf(backend);
    const mine = lockOwner("arn:aws:iam::000000000000:user/me", "run-1", "foundation.update");
    const theirs = lockOwner("arn:aws:iam::000000000000:user/you", "run-2");

    // Lapsed, and another operator now holds it: named, so the message is actionable.
    holdLock(backend, theirs);
    const taken = await errorOf(() => lock.renew(fleetOf(backend), mine));
    expect(taken.code).toBe("LOCKED");
    expect(taken.message).toContain(theirs);
    expect(fleetOf(backend).lock?.owner).toBe(theirs);

    // Lapsed with nobody else waiting: still refused, and still not re-acquired.
    holdLock(backend, mine, -1);
    const lapsed = await errorOf(() => lock.renew(fleetOf(backend), mine));
    expect(lapsed.code).toBe("LOCKED");
    expect(fleetOf(backend).lock?.expires).toBe(
      new Date(backend.clock.now().getTime() - 1).toISOString(),
    );
  });

  test("a commit point with no _fleet row is NOT_FOUND, not a CONFLICT with nothing behind it", async () => {
    const { backend } = fleet();
    const stored = fleetOf(backend);
    const mine = lockOwner("arn:aws:iam::000000000000:user/me", "run-1", "foundation.update");
    const at = expectationOf(stored);
    backend.fleetItem = null;

    const e = await errorOf(() =>
      lockOf(backend).writeLocked(stored, mine, "stamping the foundation version", at),
    );
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toContain("stamping the foundation version");
  });
});
