/**
 * The two interrupted operations a boot must not simply re-run (§4.4, §6.5).
 *
 * A lock outlives the process that took it, for the whole of its TTL, so the
 * ordinary crash window — a portal killed mid-create and restarted a minute
 * later by `--hot`, a laptop reopened while a lease is still live — is exactly
 * the window in which a boot meets its own predecessor's lock. Being refused
 * there says nothing about the work. And a recreate replaces a live instance
 * unconditionally, so replaying an interrupted one can destroy the replacement
 * the first attempt had already built.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HermeticError,
  MemoryPendingOpStore,
  openHermetic,
  type Hermetic,
  type OpEvent,
} from "@hermetic/core";
import { memoryLog } from "../src/log.ts";
import { OpRegistry } from "../src/ops.ts";
import { resumePendingOps } from "../src/resume.ts";

/**
 * §4.7: a resume replays only the rows that name the fleet it opened, so the
 * rows here say which fleet they were against and the calls say which fleet the
 * boot came up on.
 */
const FLEET = { account_id: "123456789012", region: "us-east-1", fleet_id: "fxtr0001" };
const OF_FLEET = { fleet: FLEET.fleet_id, account_id: FLEET.account_id, region: FLEET.region };

/** A create that refuses before its first event. */
function refusal(error: HermeticError): () => AsyncIterable<OpEvent> {
  // biome-ignore lint/correctness/useYield: the refusal arrives before the first event.
  return async function* (): AsyncIterable<OpEvent> {
    throw error;
  };
}

/** A create that works. */
function success(): () => AsyncIterable<OpEvent> {
  return async function* (): AsyncIterable<OpEvent> {
    yield { phase: "done", progress: 1, message: "created", at: new Date().toISOString() };
  };
}

const LIVE_LEASE: Array<[string, (expires: string) => HermeticError]> = [
  // The fleet lock, still held by whoever took it before the process died.
  [
    "op-locked",
    (expires) =>
      new HermeticError("LOCKED", "a foundation update is in progress", {
        owner: "someone#run-1",
        expires,
      }),
  ],
  // The same contention wearing the other code: the agent row exists and is
  // being created right now under a lease that has not lapsed (§6.2).
  [
    "op-name-taken",
    (expires) =>
      new HermeticError("NAME_TAKEN", "agent atlas is being created right now", {
        name: "atlas",
        owner: "someone#run-2",
        expires,
      }),
  ],
];

describe("a resume refused by a lease that is still live", () => {
  test("pending work survives transient LOCKED/NAME_TAKEN and retries after lease expiry", async () => {
    for (const [id, make] of LIVE_LEASE) {
      let now = Date.parse("2026-09-16T12:00:00.000Z");
      const expires = new Date(now + 5 * 60_000).toISOString();
      const booked: Array<{ delayMs: number; run: () => void }> = [];
      const pending = new MemoryPendingOpStore();
      const ops = new OpRegistry({ pending, now: () => now });

      let create = refusal(make(expires));
      const hermetic = { agents: { create: () => create() } } as unknown as Hermetic;

      pending.claim({
        ...OF_FLEET,
        id,
        method: "agents.create",
        target: "atlas",
        input: { name: "atlas" },
        started_at: new Date(now).toISOString(),
      });

      const outcome = await resumePendingOps({
        ops,
        pending,
        hermetic: () => hermetic,
        fleet: FLEET,
        now: () => now,
        schedule: (delayMs, run) => booked.push({ delayMs, run }),
      });
      expect(outcome.resumed).toEqual([id]);
      expect((await ops.wait(id))?.error?.code).toBe(make(expires).code);

      // The row is still on disk — the operator's instruction is outstanding,
      // not failed — and it says when it may be tried again: the moment the
      // lease that refused it runs out, and not a moment sooner.
      expect(pending.list().find((r) => r.id === id)?.retry_after).toBe(expires);
      for (let i = 0; i < 100 && booked.length === 0; i += 1) await Bun.sleep(1);
      expect(booked).toHaveLength(1);
      expect(booked[0]!.delayMs).toBe(5 * 60_000);

      // Expiry arrives and the retry runs the ordinary path: the lock was
      // waited out, never taken from the owner the refusal named.
      now += 5 * 60_000 + 1;
      create = success();
      booked.shift()!.run();
      for (let i = 0; i < 200 && pending.list().some((r) => r.id === id); i += 1) await Bun.sleep(1);
      expect(pending.list().map((r) => r.id)).not.toContain(id);
      expect((await ops.wait(id))?.status).toBe("ok");
    }
  });

  /**
   * The other half of the rule, and the reason the code alone cannot decide it:
   * a `NAME_TAKEN` that names no holder is an agent that exists, which no
   * amount of waiting changes.
   */
  test("a NAME_TAKEN that names no lease is a refusal, and clears the row", async () => {
    const pending = new MemoryPendingOpStore();
    const ops = new OpRegistry({ pending });
    pending.claim({
      ...OF_FLEET,
      id: "op-taken",
      method: "agents.create",
      target: "atlas",
      input: { name: "atlas" },
      started_at: new Date().toISOString(),
    });
    const create = refusal(
      new HermeticError("NAME_TAKEN", "agent atlas already exists", { name: "atlas" }),
    );
    const hermetic = { agents: { create: () => create() } } as unknown as Hermetic;

    await resumePendingOps({
      ops,
      pending,
      hermetic: () => hermetic,
      fleet: FLEET,
      schedule: () => {},
    });
    expect((await ops.wait("op-taken"))?.error?.code).toBe("NAME_TAKEN");
    expect(pending.list()).toEqual([]);
  });
});

describe("an interrupted recreate", () => {
  /**
   * Its own `HERMETIC_HOME`: the fixture home records which fleet is default,
   * and a suite that read the operator's would test whichever fleet they last
   * selected rather than the one it seeded.
   */
  const homes: string[] = [];
  afterAll(() => {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });

  test("recreate does not destructively replay", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermetic-resume-"));
    homes.push(home);
    const hermetic = await openHermetic({ fixture: true, home });
    const name = (await hermetic.agents.list())[0]!.name;
    const before = await hermetic.agents.get(name);
    const pending = new MemoryPendingOpStore();
    pending.claim({
      ...OF_FLEET,
      id: "op-recreate",
      method: "agents.recreate",
      target: name,
      input: { name, yes: true },
      started_at: new Date().toISOString(),
      phase: "instance",
      target_identity: {
        instance_id: before.instance_id ?? null,
        created_at: before.created_at ?? null,
      },
    });
    const ops = new OpRegistry({ pending });
    const log = memoryLog();

    const outcome = await resumePendingOps({
      ops,
      pending,
      hermetic: () => hermetic,
      fleet: FLEET,
      log,
    });
    expect(outcome.manual).toEqual(["op-recreate"]);
    expect(outcome.resumed).toEqual([]);
    expect(outcome.dropped).toEqual([]);
    // Nothing ran: no op was started, and the instance the interrupted attempt
    // might have been one step from attaching is where it was.
    expect(ops.get("op-recreate")).toBeUndefined();
    const after = await hermetic.agents.get(name);
    expect(after.instance_id).toBe(before.instance_id ?? null);
    expect(after.status).toBe(before.status);
    // The row survives: it is the only local record that the command was given.
    expect(pending.list().map((r) => r.id)).toEqual(["op-recreate"]);

    // And the operator is told which command finishes the job, on which agent,
    // and where the interrupted attempt had got to.
    const said = log.lines.join("\n");
    expect(said).toContain(`hermetic agent recreate ${name}`);
    expect(said).toContain("during instance");
  });
});

/**
 * §4.6: the other half of the rule, and the half that is about the *row* rather
 * than the method.
 *
 * A destroy is resumable on purpose — stopping halfway strands the agent in
 * `destroying` with its instance already gone (§6.6) — but only while the row
 * can still prove which agent the operator confirmed it against. The portal's
 * identity read is best effort (`app.ts`), and a row whose read failed, or one
 * written before the column existed, names an agent nobody can vouch for: the
 * name may since have been freed and taken by something else entirely.
 */
describe("an interrupted destroy", () => {
  /** A destroy that would succeed if anything let it run. */
  function destroyer(): { hermetic: Hermetic; destroyed: () => number } {
    let count = 0;
    const hermetic = {
      agents: {
        destroy: () => {
          count += 1;
          return success()();
        },
        get: () =>
          Promise.resolve({
            name: "atlas",
            instance_id: "i-confirmed",
            created_at: "2026-09-01T00:00:00.000Z",
          }),
      },
    } as unknown as Hermetic;
    return { hermetic, destroyed: () => count };
  }

  test("a row with no recorded identity is handed back rather than replayed", async () => {
    const pending = new MemoryPendingOpStore();
    const ops = new OpRegistry({ pending });
    const { hermetic, destroyed } = destroyer();
    pending.claim({
      ...OF_FLEET,
      id: "op-destroy",
      method: "agents.destroy",
      target: "atlas",
      input: { name: "atlas", yes: true },
      started_at: new Date().toISOString(),
      phase: "instance",
      // The identity read at confirmation time failed, so the row carries none.
      target_identity: null,
    });
    const log = memoryLog();

    const outcome = await resumePendingOps({
      ops,
      pending,
      hermetic: () => hermetic,
      fleet: FLEET,
      log,
    });
    expect(outcome.manual).toEqual(["op-destroy"]);
    expect(outcome.resumed).toEqual([]);
    expect(outcome.dropped).toEqual([]);
    // Nothing was destroyed, and no op exists to have destroyed it.
    expect(destroyed()).toBe(0);
    expect(ops.get("op-destroy")).toBeUndefined();
    // The row survives: it is the only local record that the command was given.
    expect(pending.list().map((r) => r.id)).toEqual(["op-destroy"]);

    const said = log.lines.join("\n");
    expect(said).toContain("hermetic agent destroy atlas");
    expect(said).toContain("does not record which agent it was confirmed against");
    expect(said).toContain("during instance");
  });

  test("a row that records one is still finished unattended", async () => {
    const pending = new MemoryPendingOpStore();
    const ops = new OpRegistry({ pending });
    const { hermetic, destroyed } = destroyer();
    pending.claim({
      ...OF_FLEET,
      id: "op-destroy-known",
      method: "agents.destroy",
      target: "atlas",
      input: { name: "atlas", yes: true },
      started_at: new Date().toISOString(),
      target_identity: { instance_id: "i-confirmed", created_at: "2026-09-01T00:00:00.000Z" },
    });

    const outcome = await resumePendingOps({ ops, pending, hermetic: () => hermetic, fleet: FLEET });
    expect(outcome.manual).toEqual([]);
    expect(outcome.resumed).toEqual(["op-destroy-known"]);
    expect((await ops.wait("op-destroy-known"))?.status).toBe("ok");
    expect(destroyed()).toBe(1);
  });

  /**
   * The identity is captured before destroy starts and never rewritten. A
   * second destroy can legitimately begin after the first one cleared the
   * instance id but before it finished the remaining cleanup, so the stable
   * creation time must be enough to let that retry finish unattended.
   */
  test("a matching creation time is proof without an instance id", async () => {
    const pending = new MemoryPendingOpStore();
    const ops = new OpRegistry({ pending });
    const { hermetic, destroyed } = destroyer();
    pending.claim({
      ...OF_FLEET,
      id: "op-destroy-half",
      method: "agents.destroy",
      target: "atlas",
      input: { name: "atlas", yes: true },
      started_at: new Date().toISOString(),
      target_identity: { instance_id: null, created_at: "2026-09-01T00:00:00.000Z" },
    });

    const outcome = await resumePendingOps({ ops, pending, hermetic: () => hermetic, fleet: FLEET });
    expect(outcome.manual).toEqual([]);
    expect(outcome.resumed).toEqual(["op-destroy-half"]);
    expect((await ops.wait("op-destroy-half"))?.status).toBe("ok");
    expect(destroyed()).toBe(1);
  });

  /** An instance id is independently immutable and proves the same thing. */
  test("a matching instance id is proof without a creation time", async () => {
    const pending = new MemoryPendingOpStore();
    const ops = new OpRegistry({ pending });
    const { hermetic, destroyed } = destroyer();
    pending.claim({
      ...OF_FLEET,
      id: "op-destroy-instance-only",
      method: "agents.destroy",
      target: "atlas",
      input: { name: "atlas", yes: true },
      started_at: new Date().toISOString(),
      target_identity: { instance_id: "i-confirmed", created_at: null },
    });

    const outcome = await resumePendingOps({ ops, pending, hermetic: () => hermetic, fleet: FLEET });
    expect(outcome.manual).toEqual([]);
    expect(outcome.resumed).toEqual(["op-destroy-instance-only"]);
    expect((await ops.wait("op-destroy-instance-only"))?.status).toBe("ok");
    expect(destroyed()).toBe(1);
  });

  /**
   * And the other half alone is no better: an agent row that reports no
   * creation time leaves the replay-time check with nothing to compare, and
   * "cannot say" is not "agrees".
   */
  test("an agent that reports no creation time refuses the replay", async () => {
    const pending = new MemoryPendingOpStore();
    const ops = new OpRegistry({ pending });
    let destroyed = 0;
    const hermetic = {
      agents: {
        destroy: () => {
          destroyed += 1;
          return success()();
        },
        // Same instance the row was confirmed against, so only the missing
        // creation time can refuse this.
        get: () => Promise.resolve({ name: "atlas", instance_id: "i-confirmed", created_at: null }),
      },
    } as unknown as Hermetic;
    pending.claim({
      ...OF_FLEET,
      id: "op-destroy-uncomparable",
      method: "agents.destroy",
      target: "atlas",
      input: { name: "atlas", yes: true },
      started_at: new Date().toISOString(),
      target_identity: { instance_id: "i-confirmed", created_at: "2026-09-01T00:00:00.000Z" },
    });

    const outcome = await resumePendingOps({ ops, pending, hermetic: () => hermetic, fleet: FLEET });
    expect(outcome.resumed).toEqual([]);
    expect(outcome.skipped).toEqual(["op-destroy-uncomparable"]);
    expect(destroyed).toBe(0);
  });

  /**
   * An identity whose every half is null says exactly as little as no identity
   * at all, and is read the same way. `db.ts` collapses one into the other on
   * the way off disk; an in-memory store does not, and a boot must not be able
   * to tell the difference.
   */
  test("an identity with nothing in it counts as none", async () => {
    const pending = new MemoryPendingOpStore();
    const ops = new OpRegistry({ pending });
    const { hermetic, destroyed } = destroyer();
    pending.claim({
      ...OF_FLEET,
      id: "op-destroy-empty",
      method: "agents.destroy",
      target: "atlas",
      input: { name: "atlas", yes: true },
      started_at: new Date().toISOString(),
      target_identity: { instance_id: null, created_at: null },
    });

    const outcome = await resumePendingOps({ ops, pending, hermetic: () => hermetic, fleet: FLEET });
    expect(outcome.manual).toEqual(["op-destroy-empty"]);
    expect(destroyed()).toBe(0);
  });
});
