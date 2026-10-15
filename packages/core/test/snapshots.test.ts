/**
 * §7.1's data-volume snapshot policy: `snapshots.status`, `plan.snapshots`,
 * and the `apply` of a snapshots plan.
 *
 * What the design rests on, and so what is tested: the stack is the only
 * record of the policy, so `status` reads parameters and a change is one
 * change set; a plan patches the stack's current values and carries the whole
 * target, which `apply` re-checks against the stack; turning the policy off
 * keeps every snapshot already taken; and a fleet behind this build's
 * foundation is refused rather than rolled forward by the side door.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  MemoryBackend,
  seedFixtureAgents,
  seedFixtureFoundation,
} from "../src/backend/memory.ts";
import { HermeticError } from "../src/errors.ts";
import { FLEET_KEY, type OpEvent } from "../src/schema/index.ts";
import type { HermeticDeps } from "../src/hermetic.ts";
import { drain, testHermetic } from "./helpers.ts";

const FAST: NonNullable<HermeticDeps["foundation"]> = { changeSetPollMs: 0, heartbeatMs: 60_000 };

function fleet() {
  const backend = seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
  return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG, foundation: FAST }) };
}

function seedSnapshots(backend: MemoryBackend, n: number) {
  for (let i = 0; i < n; i++) {
    backend.snapshots.set(`snap-${i}`, {
      snapshot_id: `snap-${i}`,
      volume_id: "vol-fixture",
      size_gib: 10,
      started_at: "2026-10-01T05:00:00.000Z",
      tags: { "hermetic:role": "data" },
    });
  }
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof HermeticError ? e.code : `not-a-HermeticError:${String(e)}`;
  }
}

describe("snapshots.status", () => {
  test("a fleet on this build's template reports the default policy and its snapshots", async () => {
    const { backend, hermetic } = fleet();
    seedSnapshots(backend, 3);
    const report = await hermetic.snapshots.status();
    expect(report.policy).toEqual({ enabled: true, retain: 7, interval_hours: 24 });
    expect(report.existing).toEqual({ count: 3, volume_gib: 30 });
  });

  test("a stack from before the parameters reports no policy rather than guessing", async () => {
    const { backend, hermetic } = fleet();
    for (const k of ["SnapshotsEnabled", "SnapshotRetainCount", "SnapshotIntervalHours"]) {
      delete backend.stack?.parameters[k];
    }
    expect((await hermetic.snapshots.status()).policy).toBeNull();
    expect(await codeOf(() => hermetic.plan.snapshots({ enabled: false }))).toBe("CONFLICT");
  });
});

describe("plan.snapshots", () => {
  test("patches the stack's policy and carries the whole target", async () => {
    const { hermetic } = fleet();
    const plan = await hermetic.plan.snapshots({ retain: 3 });
    expect(plan.kind).toBe("snapshots");
    expect(plan.options.snapshots).toEqual({ enabled: true, retain: 3, interval_hours: 24 });
    expect(plan.steps.map((s) => s.id)).toEqual(["preflight", "stack"]);
    // Lowering retention deletes the oldest snapshots, and says so.
    expect(plan.steps[1]?.destructive).toBe(true);
    expect(plan.warnings.join("\n")).toContain("lowering retention from 7 to 3");
  });

  test("turning snapshots off warns that existing ones stay and keep billing", async () => {
    const { backend, hermetic } = fleet();
    seedSnapshots(backend, 5);
    const plan = await hermetic.plan.snapshots({ enabled: false });
    expect(plan.options.snapshots?.enabled).toBe(false);
    expect(plan.warnings.join("\n")).toContain("the 5 snapshot(s) this fleet holds now stay");
  });

  test("no change is a refusal, not an empty plan", async () => {
    const { hermetic } = fleet();
    expect(await codeOf(() => hermetic.plan.snapshots({ enabled: true, retain: 7 }))).toBe("CONFLICT");
  });

  test("an interval DLM does not accept is a validation error", async () => {
    const { hermetic } = fleet();
    expect(
      await codeOf(() => hermetic.plan.snapshots({ interval_hours: 5 as unknown as 6 })),
    ).not.toBeNull();
  });

  test("a fleet behind this build's foundation is told to update first", async () => {
    const { backend, hermetic } = fleet();
    const item = backend.fleetItem;
    if (item === null) throw new Error("no fleet");
    backend.fleetItem = { ...item, foundation_version: (item.foundation_version ?? 1) - 1 };
    const e = await hermetic.plan.snapshots({ enabled: false }).catch((x: unknown) => x);
    expect(String(e)).toContain("hermetic foundation update");
  });
});

describe("snapshotPolicyOf", () => {
  test("refuses values the template would not accept rather than guessing", async () => {
    const { snapshotPolicyOf } = await import("../src/shared/snapshots.ts");
    const ok = { SnapshotsEnabled: "true", SnapshotRetainCount: "7", SnapshotIntervalHours: "24" };
    expect(snapshotPolicyOf(ok)).toEqual({ enabled: true, retain: 7, interval_hours: 24 });
    for (const bad of [
      { ...ok, SnapshotsEnabled: "yes" },
      { ...ok, SnapshotRetainCount: "0" },
      { ...ok, SnapshotRetainCount: "2.5" },
      { ...ok, SnapshotIntervalHours: "5" },
    ]) {
      expect(snapshotPolicyOf(bad)).toBeNull();
    }
  });
});

describe("apply kind snapshots", () => {
  test("refuses with LOCKED while another fleet-wide operation holds the lock", async () => {
    const { backend, hermetic } = fleet();
    const plan = await hermetic.plan.snapshots({ retain: 14 });
    const item = backend.fleetItem;
    if (item === null) throw new Error("no fleet");
    backend.fleetItem = {
      ...item,
      lock: { owner: "someone-else#op", expires: "2999-01-01T00:00:00.000Z" },
    };
    expect(await codeOf(() => drain(hermetic.apply({ plan, yes: true })))).toBe("LOCKED");
    expect(backend.stack?.parameters["SnapshotRetainCount"]).toBe("7");
  });

  test("disabling while lowering retention says the lower count waits for re-enable", async () => {
    const { hermetic } = fleet();
    const plan = await hermetic.plan.snapshots({ enabled: false, retain: 2 });
    expect(plan.warnings.join("\n")).toContain("deletes nothing while snapshots are off");
  });

  test("moves only the three policy parameters, and deletes no snapshot", async () => {
    const { backend, hermetic } = fleet();
    seedSnapshots(backend, 4);
    const before = { ...backend.stack?.parameters };
    const plan = await hermetic.plan.snapshots({ enabled: false, interval_hours: 12 });
    const events: OpEvent[] = await drain(hermetic.apply({ plan, yes: true }));

    expect(events.at(-1)?.phase).toBe("done");
    expect(backend.mutations).toContain("foundation.createSnapshotChangeSet");
    expect(backend.stack?.parameters).toEqual({
      ...before,
      SnapshotsEnabled: "false",
      SnapshotIntervalHours: "12",
    });
    expect(backend.snapshots.size).toBe(4);
    expect((await hermetic.snapshots.status()).policy).toEqual({
      enabled: false,
      retain: 7,
      interval_hours: 12,
    });
    // Released, and recorded on the fleet's own event stream.
    expect((await backend.store.fleet.get())?.lock ?? null).toBeNull();
    const fleetEvents = await backend.store.events.query(FLEET_KEY);
    expect(fleetEvents.some((e) => e.action === "snapshots.apply")).toBe(true);
  });

  test("a plan applied after the stack already moved is refused", async () => {
    const { hermetic } = fleet();
    const plan = await hermetic.plan.snapshots({ retain: 14 });
    await drain(hermetic.apply({ plan, yes: true }));
    expect(await codeOf(() => drain(hermetic.apply({ plan, yes: true })))).toBe("CONFLICT");
  });

  test("a foundation update keeps the policy an operator chose", async () => {
    const { backend, hermetic } = fleet();
    await drain(hermetic.apply({ plan: await hermetic.plan.snapshots({ retain: 2 }), yes: true }));
    await drain(hermetic.foundation.update({ yes: true }));
    expect(backend.stack?.parameters["SnapshotRetainCount"]).toBe("2");
  });
});
