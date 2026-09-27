/**
 * The two clocks the `_fleet` lock (§4.4) is read against: the one its heartbeat
 * ages on, and the one its expiry instant is compared with.
 *
 * Both are here rather than beside their callers because both defects were the
 * same shape — one half of the lock answering a question on a different clock
 * (or a different comparison) from the half that acts on the answer — and a
 * test that holds the two halves together is the only kind that keeps them from
 * drifting apart again.
 *
 * Everything below knocks on the doors the store actually opens: `lockFleet` to
 * take, `renewFleetLock` to renew, `replaceFleet` for the commit point. `put` is
 * create-only and there is no whole-item write that is not one of these.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { guardClient } from "../src/aws/client.ts";
import { createDynamoStores } from "../src/aws/dynamo.ts";
import { MemoryBackend, seedFixtureFoundation } from "../src/backend/memory.ts";
import type { FleetStore } from "../src/backend/types.ts";
import {
  LOCK_TTL_MS,
  createFleetLock,
  expectationOf,
  fleetLockKeeper,
  lockOwner,
} from "../src/fleet/fleet-lock.ts";
import type { FleetItem } from "../src/schema/index.ts";
import { isLockLive } from "../src/agents/state.ts";
import { inputsOf } from "./aws-harness.ts";

const OWNER = lockOwner("arn:aws:iam::123456789012:user/e", "run-1");
const OTHER = lockOwner("arn:aws:iam::123456789012:user/other", "run-2");

function fleetLockOn(backend: MemoryBackend) {
  return createFleetLock({
    backend,
    lockTtlMs: LOCK_TTL_MS,
    // The backend's clock, exactly as every real caller wires it.
    now: () => backend.clock.now(),
    rerun: "hermetic foundation update",
  });
}

describe("the heartbeat ages the lock on the clock that stamped it", () => {
  /**
   * The defect: `fleetLockKeeper` measured "is the lock a third of its life
   * old" against `Date.now()` while the expiry it renews is written from the
   * injected clock. Nothing kept the two in step, so on a held clock the
   * heartbeat could never come due — and in production the two could disagree
   * about a lock's age while the store only ever honours the stamped expiry.
   *
   * Every assertion below moves the injected clock and never the process one,
   * so it can only pass if the keeper reads the same clock the lock does.
   */
  test("a renewal comes due on the injected clock, not the process clock", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const lock = fleetLockOn(backend);
    expect(await lock.acquire(OWNER)).toBe(true);
    let current: FleetItem = lock.withLock((await backend.store.fleet.get()) as FleetItem, OWNER);
    const taken = current.lock?.expires;
    backend.resetMutations();

    const keep = fleetLockKeeper(
      lock,
      LOCK_TTL_MS,
      () => current,
      (next) => {
        current = next;
      },
      OWNER,
    );

    // Nothing has aged: the keeper is called on every poll of a long phase and
    // must write on almost none of them.
    await keep();
    expect(current.lock?.expires).toBe(taken);

    // One millisecond short of a third of the TTL is still not due.
    backend.advance(LOCK_TTL_MS / 3 - 1);
    await keep();
    expect(current.lock?.expires).toBe(taken);
    expect(backend.mutations).not.toContain("store.fleet.renewFleetLock");

    // A third of the TTL, on the injected clock, is due.
    backend.advance(1);
    await keep();
    const renewed = new Date(backend.now().getTime() + LOCK_TTL_MS).toISOString();
    expect(current.lock?.expires).toBe(renewed);
    // Through the renew door, not the take door: a heartbeat that re-acquired
    // would take back a lapsed lock and hide the window (§4.4).
    expect(backend.mutations.filter((m) => m === "store.fleet.renewFleetLock")).toHaveLength(1);
    expect(backend.mutations).not.toContain("store.fleet.lockFleet");
    // And it reached the store, not just this run's copy of the item.
    expect((await backend.store.fleet.get())?.lock?.expires).toBe(renewed);

    // The clock the *next* renewal is measured from moved too, so the keeper
    // writes once per third of a TTL rather than on every poll thereafter.
    backend.advance(LOCK_TTL_MS / 3 - 1);
    await keep();
    expect(current.lock?.expires).toBe(renewed);
    expect(backend.mutations.filter((m) => m === "store.fleet.renewFleetLock")).toHaveLength(1);
  });
});

const ddb = mockClient(DynamoDBDocumentClient);

/** The store refuses a client `aws.client()` did not build; the guard is not the subject here. */
function dynamoFleet(): FleetStore {
  const client = guardClient(new DynamoDBClient({ region: "us-west-2" }), async () => {});
  return createDynamoStores(client, { agents: "hermetic-agents", events: "hermetic-events" }).fleet;
}

/**
 * The expiry comparison DynamoDB would actually make, parsed out of the
 * condition the store sent rather than restated here.
 *
 * Parsed, because a restatement is a second copy of the rule and this test
 * exists to stop a second copy drifting: widening the take's `<` to `<=`, or
 * narrowing the renew's `>=` to `>`, changes the answer here instead of
 * quietly agreeing. String comparison because that is what DynamoDB does to two
 * ISO-8601 instants.
 */
function dynamoSaysExpiry(
  condition: string,
  expires: string,
  nowIso: string,
): { operator: string; holds: boolean } {
  const m = /#lock\.#expires (<=?|>=?) :now/.exec(condition);
  if (m === null) throw new Error(`no expiry clause in condition: ${condition}`);
  const operator = m[1] as string;
  const holds =
    operator === "<"
      ? expires < nowIso
      : operator === "<="
        ? expires <= nowIso
        : operator === ">"
          ? expires > nowIso
          : expires >= nowIso;
  return { operator, holds };
}

/** The one `UpdateCommand`/`PutCommand` a single store call sent, and its `:now`. */
function sentCondition(ctor: unknown): { condition: string; now: string } {
  const [input] = inputsOf<{
    ConditionExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  }>(ddb, ctor);
  if (input === undefined) throw new Error("the store sent no conditional write");
  return {
    condition: input.ConditionExpression,
    now: input.ExpressionAttributeValues[":now"] as string,
  };
}

beforeEach(() => ddb.reset());
afterAll(() => ddb.restore());

describe("at the exact expiry instant the reader and the stores agree", () => {
  const EXPIRES = "2026-09-01T12:10:00.000Z";
  const at = Date.parse(EXPIRES);
  /** The new expiry a take or a renew would write; never the subject, so any value does. */
  const LATER = "2026-09-01T12:20:00.000Z";

  /**
   * The defect: `isLockLive` used `>` while DynamoDB frees the lock on
   * `#lock.#expires < :now` and the memory double matches it. For the one
   * millisecond in which `expires === now`, a head was therefore told the lock
   * was dead — "nothing is in progress, offer the action" — by a store that
   * would still refuse the take with `LOCKED`.
   *
   * The table is the contract: at each instant, what the reader says and what
   * each store does are the same fact, read three ways.
   */
  const instants: ReadonlyArray<readonly [string, number, boolean]> = [
    ["a millisecond before expiry", -1, true],
    ["at the expiry instant", 0, true],
    ["a millisecond after expiry", 1, false],
  ];

  /** A fleet whose lock is `OTHER`'s and expires at `EXPIRES`, taken through its own door. */
  async function lockedByOther(): Promise<MemoryBackend> {
    const backend = seedFixtureFoundation(new MemoryBackend());
    backend.setNow(new Date(at - LOCK_TTL_MS));
    expect(await backend.store.fleet.lockFleet(OTHER, EXPIRES, backend.now())).toBe(true);
    return backend;
  }

  for (const [label, offset, live] of instants) {
    test(`${label}: the lock is ${live ? "live" : "free"} everywhere`, async () => {
      const now = new Date(at + offset);
      const held = { owner: OTHER, expires: EXPIRES };

      // ── the reader every head and guard goes through ────────────────────
      expect(isLockLive(held, undefined, now.getTime())).toBe(live);
      // …and asked by a caller that is not the holder, which is the question
      // the stores' conditions are actually answering.
      expect(isLockLive(held, OWNER, now.getTime())).toBe(live);

      // ── the memory double ───────────────────────────────────────────────
      // A take by somebody else succeeds only once the lock is free.
      const take = await lockedByOther();
      expect(await take.store.fleet.lockFleet(OWNER, LATER, now)).toBe(!live);
      // The holder's own renew is the mirror image: allowed only while it is
      // still live, because a lapsed lock is not re-acquirable by asking again.
      const renew = await lockedByOther();
      expect(await renew.store.fleet.renewFleetLock(OTHER, LATER, now)).toBe(live);
      // And the commit-point write, which is refused by anybody else's live lock.
      const replace = await lockedByOther();
      const stored = (await replace.store.fleet.get()) as FleetItem;
      const written = await replace.store.fleet.replaceFleet(
        { ...stored, lock: null },
        OWNER,
        now,
        expectationOf(stored),
      );
      expect(written === null).toBe(live);

      // ── the real store, judged by the condition DynamoDB would evaluate ──
      ddb.on(UpdateCommand).resolves({});
      await dynamoFleet().lockFleet(OWNER, LATER, now);
      const dynamoTake = sentCondition(UpdateCommand);
      expect(dynamoTake.now).toBe(now.toISOString());
      const freed = dynamoSaysExpiry(dynamoTake.condition, EXPIRES, dynamoTake.now);
      expect(freed.operator).toBe("<");
      expect(freed.holds).toBe(!live);

      ddb.reset();
      ddb.on(UpdateCommand).resolves({});
      await dynamoFleet().renewFleetLock(OTHER, LATER, now);
      const dynamoRenew = sentCondition(UpdateCommand);
      expect(dynamoRenew.now).toBe(now.toISOString());
      const stillOurs = dynamoSaysExpiry(dynamoRenew.condition, EXPIRES, dynamoRenew.now);
      expect(stillOurs.operator).toBe(">=");
      expect(stillOurs.holds).toBe(live);

      ddb.reset();
      ddb.on(PutCommand).resolves({});
      await dynamoFleet().replaceFleet({ ...stored, lock: null }, OWNER, now, expectationOf(stored));
      const dynamoReplace = sentCondition(PutCommand);
      expect(dynamoReplace.now).toBe(now.toISOString());
      const unlocked = dynamoSaysExpiry(dynamoReplace.condition, EXPIRES, dynamoReplace.now);
      expect(unlocked.operator).toBe("<");
      expect(unlocked.holds).toBe(!live);
    });
  }
});
