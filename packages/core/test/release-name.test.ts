/**
 * §6.7: destroying an agent releases its name completely. After a destroy only
 * the per-name events and one tombstone hold the name, and a `create` of it is
 * a brand-new agent. Driven end to end through `testHermetic` over the
 * `MemoryBackend`, so the release is exercised exactly where destroy and create
 * call it (`agents/lifecycle/release-name.ts`).
 */
import { describe, expect, test } from "bun:test";
import { HermeticError } from "../src/errors.ts";
import type { Agent, AgentTombstone } from "../src/schema/index.ts";
import { FIXTURE_CONFIG, type MemoryBackend } from "../src/backend/memory.ts";
import { drain, freshFleet } from "./helpers.ts";

const HOUR = 3_600_000;

async function created(name: string) {
  const fleet = freshFleet();
  await drain(fleet.hermetic.agents.create({ name }));
  const row = (await fleet.backend.store.agents.get(name))!;
  return { ...fleet, row };
}

function volumeOf(row: Agent): string {
  return (row.resources.volume_id ?? row.volume_id)!;
}

function instanceOf(row: Agent): string {
  return (row.resources.instance_id ?? row.instance_id)!;
}

/**
 * The shape a destroy left before tombstones existed: the row kept forever in
 * `destroyed`, its box gone, its kept volume still tagged `agent=<name>`.
 */
function makeLegacy(backend: MemoryBackend, row: Agent): void {
  const instanceId = instanceOf(row);
  const volumeId = volumeOf(row);
  const inst = backend.instances.get(instanceId)!;
  backend.instances.set(instanceId, { ...inst, state: "terminated", public_ip: null });
  const vol = backend.volumes.get(volumeId)!;
  backend.volumes.set(volumeId, { ...vol, state: "available", attached_to: null });
  backend.agents.set(row.name, {
    ...backend.agents.get(row.name)!,
    status: "destroyed",
    lock: null,
    instance_id: null,
    volume_id: volumeId,
    resources: { volume_id: volumeId, ssm_paths: [] },
    tailscale_ip: null,
    tailscale_dns_name: null,
  });
}

/**
 * A tombstone for `row`'s incarnation as a box could plant one: the instance
 * role may put any item in the events table.
 */
function forgedTombstone(
  backend: MemoryBackend,
  row: Agent,
  overrides: Partial<AgentTombstone> = {},
): AgentTombstone {
  return {
    name: row.name,
    fleet_id: FIXTURE_CONFIG.fleet_id,
    created_at: row.created_at,
    created_by: row.created_by,
    destroyed_at: backend.now().toISOString(),
    destroyed_by: "a-compromised-box",
    size: row.size,
    region: row.region,
    provider: row.provider,
    profile_id: null,
    instance_id: null,
    volume_id: null,
    volume_kept: false,
    hermes_version: row.hermes_version,
    legacy: false,
    ...overrides,
  };
}

describe("destroy releases the name", () => {
  test("the row goes, a tombstone records it, events stay, and the name is reusable", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const eventsBefore = await backend.store.events.query("atlas");
    expect(eventsBefore.length).toBeGreaterThan(0);

    backend.advance(HOUR);
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    expect(await backend.store.agents.get("atlas")).toBeNull();
    const [tombstone, ...more] = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(more).toEqual([]);
    expect(tombstone).toMatchObject({
      name: "atlas",
      fleet_id: FIXTURE_CONFIG.fleet_id,
      created_at: row.created_at,
      created_by: row.created_by,
      destroyed_at: backend.now().toISOString(),
      size: row.size,
      region: row.region,
      provider: row.provider,
      instance_id: instanceOf(row),
      volume_id: volumeOf(row),
      volume_kept: false,
      hermes_version: row.hermes_version,
      legacy: false,
    });
    expect(tombstone!.destroyed_by).toBeTruthy();
    expect(tombstone!.profile_id).toBe(row.profile_id ?? null);

    // Every event the agent had survives, plus the release itself.
    const eventsAfter = await backend.store.events.query("atlas");
    for (const e of eventsBefore) {
      expect(eventsAfter.some((a) => a.timestamp === e.timestamp && a.action === e.action)).toBe(true);
    }
    expect(eventsAfter.some((e) => e.action === "release")).toBe(true);

    // Nothing else holds the name: no volume tagged for it, no SSM, no config.
    expect(await backend.compute.findVolumeByTag("atlas")).toBeNull();
    expect([...backend.params.keys()].filter((k) => k.includes("/atlas/"))).toEqual([]);
    expect([...backend.objects.keys()].filter((k) => k.startsWith("config/atlas/"))).toEqual([]);

    // And the name is free: a create is a brand-new agent.
    backend.advance(HOUR);
    await drain(hermetic.agents.create({ name: "atlas" }));
    const again = (await backend.store.agents.get("atlas"))!;
    expect(again.status).not.toBe("destroyed");
    expect(again.created_at).toBe(backend.now().toISOString());
    expect(again.created_at > row.created_at).toBe(true);
    expect(volumeOf(again)).not.toBe(volumeOf(row));
  });

  test("under a frozen clock the next life still starts strictly after the last one ended", async () => {
    const { backend, hermetic } = await created("atlas");
    // No `advance` anywhere: destroy and create read the same instant.
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    const [tombstone] = await backend.store.events.queryTombstones({ name: "atlas" });

    await drain(hermetic.agents.create({ name: "atlas" }));
    const again = (await backend.store.agents.get("atlas"))!;
    expect(again.created_at > tombstone!.destroyed_at).toBe(true);
    // The windows are inclusive, so an equal boundary would put the old life's
    // last event in the new life's window.
    const window = await hermetic.agents.history({ name: "atlas", since: again.created_at });
    expect(window.some((e) => e.action === "release")).toBe(false);
  });

  test("--keep-volume releases the disk from the name, and a create makes a new one", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const kept = volumeOf(row);

    await drain(hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true }));

    const vol = backend.volumes.get(kept)!;
    expect(vol.agent).toBeNull();
    expect(vol.former_agent).toBe("atlas");
    expect(vol.role).toBe("data");
    expect(await backend.compute.findVolumeByTag("atlas")).toBeNull();
    const [tombstone] = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstone).toMatchObject({ volume_id: kept, volume_kept: true });
    const listed = (await backend.compute.listVolumes()).find((v) => v.volume_id === kept)!;
    expect(listed.former_agent).toBe("atlas");
    expect(listed.tags["hermetic:former_agent"]).toBe("atlas");

    backend.advance(HOUR);
    await drain(hermetic.agents.create({ name: "atlas" }));
    const again = (await backend.store.agents.get("atlas"))!;
    expect(volumeOf(again)).not.toBe(kept);
    // The old disk is untouched: still nobody's, still whose it was.
    expect(backend.volumes.get(kept)!.agent).toBeNull();
    expect(backend.volumes.get(kept)!.former_agent).toBe("atlas");
  });

  test("an explicit --volume adopts a released disk and clears former_agent", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const kept = volumeOf(row);
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true }));

    backend.advance(HOUR);
    const events = await drain(hermetic.agents.create({ name: "bravo", volume_id: kept }));
    // Whose it was, in the tag that said so — not `agent=(none)`.
    const said = `tagged former_agent=atlas and is now agent=bravo`;
    expect(events.some((e) => e.message.includes(said))).toBe(true);
    const history = await backend.store.events.query("bravo");
    expect(history.some((e) => e.detail?.includes("tag former_agent=atlas rewritten"))).toBe(true);
    expect(volumeOf((await backend.store.agents.get("bravo"))!)).toBe(kept);
    expect(backend.volumes.get(kept)!.agent).toBe("bravo");
    expect(backend.volumes.get(kept)!.former_agent ?? null).toBeNull();
  });

  test("the row outlives a shutting-down instance and goes once it is terminated", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const instanceId = instanceOf(row);
    const volumeId = volumeOf(row);

    // Real EC2: terminate is accepted, the box sits in `shutting-down` for a
    // while (the volume already detached), and only later reads `terminated`.
    backend.compute.terminate = async (id: string) => {
      const inst = backend.instances.get(id)!;
      backend.instances.set(id, { ...inst, state: "shutting-down", public_ip: null });
      const vol = backend.volumes.get(volumeId)!;
      backend.volumes.set(volumeId, { ...vol, state: "available", attached_to: null });
    };
    const describe = backend.compute.describeInstance;
    let shuttingPolls = 0;
    const rowSeenWhileShutting: boolean[] = [];
    backend.compute.describeInstance = async (id: string) => {
      const inst = backend.instances.get(id);
      if (id === instanceId && inst?.state === "shutting-down") {
        shuttingPolls += 1;
        rowSeenWhileShutting.push((await backend.store.agents.get("atlas")) !== null);
        if (shuttingPolls >= 3) backend.instances.set(id, { ...inst, state: "terminated" });
      }
      return describe(id);
    };
    const del = backend.store.agents.delete;
    const stateAtDelete: string[] = [];
    backend.store.agents.delete = async (name, opts) => {
      stateAtDelete.push(backend.instances.get(instanceId)!.state);
      return del(name, opts);
    };

    const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    expect(shuttingPolls).toBeGreaterThanOrEqual(3);
    expect(rowSeenWhileShutting.every(Boolean)).toBe(true);
    expect(stateAtDelete).toEqual(["terminated"]);
    expect(events.some((e) => e.message.includes(`waiting for instance ${instanceId}`))).toBe(true);
    expect(await backend.store.agents.get("atlas")).toBeNull();
  });
});

describe("stray instances tagged for the name", () => {
  test("a second tagged box is terminated too, and the row waits for both", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const own = instanceOf(row);
    const volumeId = volumeOf(row);
    // A launch whose id never reached the row: same tags, not named by it.
    const stray = "i-stray0001";
    backend.instances.set(stray, { ...backend.instances.get(own)!, instance_id: stray });

    backend.compute.terminate = async (id: string) => {
      const inst = backend.instances.get(id)!;
      backend.instances.set(id, { ...inst, state: "shutting-down", public_ip: null });
      if (id === own) {
        const vol = backend.volumes.get(volumeId)!;
        backend.volumes.set(volumeId, { ...vol, state: "available", attached_to: null });
      }
    };
    const describe = backend.compute.describeInstance;
    const polls = new Map<string, number>();
    backend.compute.describeInstance = async (id: string) => {
      const inst = backend.instances.get(id);
      if (inst?.state === "shutting-down") {
        const n = (polls.get(id) ?? 0) + 1;
        polls.set(id, n);
        if (n >= 2) backend.instances.set(id, { ...inst, state: "terminated" });
      }
      return describe(id);
    };
    const del = backend.store.agents.delete;
    const statesAtDelete: string[] = [];
    backend.store.agents.delete = async (name, opts) => {
      statesAtDelete.push(backend.instances.get(own)!.state, backend.instances.get(stray)!.state);
      return del(name, opts);
    };

    const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    expect(events.some((e) => e.message.includes(`instance ${stray} is also tagged`))).toBe(true);
    expect(statesAtDelete).toEqual(["terminated", "terminated"]);
    expect(polls.get(stray)).toBeGreaterThanOrEqual(2);
    expect(await backend.store.agents.get("atlas")).toBeNull();
    expect(await backend.compute.listInstancesByTag("atlas")).toEqual([]);
  });
});

describe("a legacy destroyed row", () => {
  test("destroy releases it, and its kept volume is released rather than deleted", async () => {
    const { backend, hermetic, row } = await created("atlas");
    makeLegacy(backend, row);
    const kept = volumeOf(row);

    const plan = await hermetic.plan.destroy({ name: "atlas" });
    expect(plan.warnings.join(" ")).toContain("record predates tombstones; will be released");
    expect(plan.steps.map((s) => s.id)).toEqual(["volume", "release"]);

    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    expect(await backend.store.agents.get("atlas")).toBeNull();
    expect(backend.volumes.has(kept)).toBe(true);
    expect(backend.volumes.get(kept)!.agent).toBeNull();
    expect(backend.volumes.get(kept)!.former_agent).toBe("atlas");
    const [tombstone] = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstone).toMatchObject({ created_at: row.created_at, volume_kept: true });
    expect(backend.mutations).not.toContain("compute.deleteVolume");
  });

  test("create over it releases it, then claims the name afresh", async () => {
    const { backend, hermetic, row } = await created("atlas");
    makeLegacy(backend, row);

    backend.advance(HOUR);
    await drain(hermetic.agents.create({ name: "atlas" }));

    const again = (await backend.store.agents.get("atlas"))!;
    expect(again.status).not.toBe("destroyed");
    expect(again.created_at > row.created_at).toBe(true);
    expect(volumeOf(again)).not.toBe(volumeOf(row));
    const tombstones = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.created_at).toBe(row.created_at);
    expect(backend.volumes.get(volumeOf(row))!.former_agent).toBe("atlas");
  });

  test("a create over it that is refused for another reason releases nothing", async () => {
    const { backend, hermetic, row } = await created("atlas");
    makeLegacy(backend, row);

    let code: string | null = null;
    try {
      await drain(hermetic.agents.create({ name: "atlas", volume_id: "vol-doesnotexist" }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).not.toBeNull();
    // The release is irreversible, so it waits for every check a create makes first.
    expect((await backend.store.agents.get("atlas"))!.status).toBe("destroyed");
    expect(await backend.store.events.queryTombstones({ name: "atlas" })).toEqual([]);
    expect(backend.volumes.get(volumeOf(row))!.agent).toBe("atlas");
  });

  test("the new life's created_at follows the old life's destroyed_at", async () => {
    const { backend, hermetic, row } = await created("atlas");
    makeLegacy(backend, row);
    // A clock that moves on every reading, as a real one does between calls.
    const now = backend.clock.now;
    backend.clock.now = () => {
      backend.advance(1);
      return now();
    };

    await drain(hermetic.agents.create({ name: "atlas" }));
    const [tombstone] = await backend.store.events.queryTombstones({ name: "atlas" });
    const again = (await backend.store.agents.get("atlas"))!;
    expect(again.created_at > tombstone!.destroyed_at).toBe(true);
  });

  test("a legacy row that appears after the first read is released, and --volume re-resolved", async () => {
    const { backend, hermetic, row } = await created("atlas");
    makeLegacy(backend, row);
    const kept = volumeOf(row);
    // The first read of the name misses the row, so the release happens in
    // `classify`, after `--volume` was resolved against the old tags.
    const get = backend.store.agents.get;
    let reads = 0;
    backend.store.agents.get = async (name: string) => {
      reads += 1;
      if (name === "atlas" && reads === 1) return null;
      return get(name);
    };

    backend.advance(HOUR);
    await drain(hermetic.agents.create({ name: "atlas", volume_id: kept }));
    expect(volumeOf((await backend.store.agents.get("atlas"))!)).toBe(kept);
    expect(backend.volumes.get(kept)!.agent).toBe("atlas");
    expect(backend.volumes.get(kept)!.former_agent ?? null).toBeNull();
    expect(await backend.store.events.queryTombstones({ name: "atlas" })).toHaveLength(1);
  });

  test("create over it with --volume of its own kept disk adopts that disk", async () => {
    const { backend, hermetic, row } = await created("atlas");
    makeLegacy(backend, row);
    const kept = volumeOf(row);

    backend.advance(HOUR);
    await drain(hermetic.agents.create({ name: "atlas", volume_id: kept }));
    const again = (await backend.store.agents.get("atlas"))!;
    expect(volumeOf(again)).toBe(kept);
    // Re-resolved after the release, so the adoption saw `former_agent` and
    // put the disk back under the name, rather than leaving it nobody's.
    expect(backend.volumes.get(kept)!.agent).toBe("atlas");
    expect(backend.volumes.get(kept)!.former_agent ?? null).toBeNull();
    expect(await backend.compute.findVolumeByTag("atlas")).toMatchObject({ volume_id: kept });
  });

  test("a legacy row released by somebody else between the read and the lock is no obstacle", async () => {
    const { backend, hermetic, row } = await created("atlas");
    makeLegacy(backend, row);
    const kept = volumeOf(row);
    const update = backend.store.agents.update;
    let raced = false;
    backend.store.agents.update = async (name, expectedVersion, patch) => {
      if (!raced && name === "atlas" && patch.lock) {
        raced = true;
        // A concurrent release lands first: the disk off the name, the row gone.
        await backend.compute.retagVolume(kept, null, { formerAgent: "atlas" });
        backend.agents.delete("atlas");
      }
      return update(name, expectedVersion, patch);
    };

    backend.advance(HOUR);
    await drain(hermetic.agents.create({ name: "atlas" }));

    expect(raced).toBe(true);
    const again = (await backend.store.agents.get("atlas"))!;
    expect(again.status).not.toBe("destroyed");
    expect(again.created_at > row.created_at).toBe(true);
    expect(volumeOf(again)).not.toBe(kept);
    expect(backend.volumes.get(kept)!.agent).toBeNull();
    expect(backend.volumes.get(kept)!.former_agent).toBe("atlas");
  });

  test("create over a legacy row another operator holds is refused", async () => {
    const { backend, hermetic, row } = await created("atlas");
    makeLegacy(backend, row);
    backend.agents.set("atlas", {
      ...backend.agents.get("atlas")!,
      lock: {
        owner: "someone-else#1",
        expires: new Date(backend.now().getTime() + HOUR).toISOString(),
      },
    });

    let code: string | null = null;
    try {
      await drain(hermetic.agents.create({ name: "atlas" }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("NAME_TAKEN");
    expect((await backend.store.agents.get("atlas"))!.status).toBe("destroyed");
    expect(await backend.store.events.queryTombstones({ name: "atlas" })).toEqual([]);
  });
});

describe("crash ordering", () => {
  test("a crash between tombstone and delete leaves a destroying row a retry finishes", async () => {
    const { backend, hermetic } = await created("atlas");

    const del = backend.store.agents.delete;
    let crashed = false;
    backend.store.agents.delete = async (name, opts) => {
      if (!crashed && opts !== undefined) {
        crashed = true;
        throw new HermeticError("INTERNAL", "the laptop lost its network", {});
      }
      return del(name, opts);
    };

    await expect(drain(hermetic.agents.destroy({ name: "atlas", yes: true }))).rejects.toThrow(
      HermeticError,
    );
    const stranded = (await backend.store.agents.get("atlas"))!;
    expect(stranded.status).toBe("destroying");
    expect(await backend.store.events.queryTombstones({ name: "atlas" })).toHaveLength(1);

    backend.advance(HOUR);
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    expect(await backend.store.agents.get("atlas")).toBeNull();
    // The retry reused the tombstone for this incarnation; no duplicate.
    const tombstones = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstones).toHaveLength(1);
  });

  test("a retry keeps the volume the first run promised to keep", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const kept = volumeOf(row);

    const del = backend.store.agents.delete;
    let crashed = false;
    backend.store.agents.delete = async (name, opts) => {
      if (!crashed && opts !== undefined) {
        crashed = true;
        throw new HermeticError("INTERNAL", "the laptop lost its network", {});
      }
      return del(name, opts);
    };
    await expect(
      drain(hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true })),
    ).rejects.toThrow(HermeticError);

    // The retry forgets the flag; the tombstone remembers the decision.
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    expect(await backend.store.agents.get("atlas")).toBeNull();
    expect(backend.volumes.has(kept)).toBe(true);
    expect(backend.volumes.get(kept)!.former_agent).toBe("atlas");
  });
});

describe("a retry after the tombstone", () => {
  test("re-runs every step, and leaves a disk that is somebody else's now alone", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const volumeId = volumeOf(row);
    // Between create and destroy the disk was retagged to another agent.
    backend.volumes.set(volumeId, { ...backend.volumes.get(volumeId)!, agent: "bravo" });

    const del = backend.store.agents.delete;
    let crashed = false;
    backend.store.agents.delete = async (name, opts) => {
      if (!crashed && opts !== undefined) {
        crashed = true;
        throw new HermeticError("INTERNAL", "the laptop lost its network", {});
      }
      return del(name, opts);
    };
    await expect(
      drain(hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true })),
    ).rejects.toThrow(HermeticError);
    const [tombstone] = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstone!.volume_kept).toBe(false);

    // Without `keep_volume`, and with a disk that fails the ownership check:
    // the steps all run again (each finding its work done), and the disk that
    // is somebody else's now is left alone rather than wedging the retry.
    backend.resetMutations();
    const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    expect(await backend.store.agents.get("atlas")).toBeNull();
    expect(backend.volumes.get(volumeId)!.agent).toBe("bravo");
    expect(backend.mutations).not.toContain("compute.deleteVolume");
    expect(events.some((e) => e.phase === "instance" && e.message.includes("already"))).toBe(true);
    expect(events.some((e) => e.phase === "secrets")).toBe(true);
    expect(events.some((e) => e.phase === "config")).toBe(true);
    expect(events.find((e) => e.phase === "volume")!.message).toContain("left untouched");
    expect(await backend.store.events.queryTombstones({ name: "atlas" })).toHaveLength(1);
  });

  /**
   * The events table is writable by the boxes, so a tombstone is not proof the
   * box is gone. One planted for a live agent changes nothing about what a
   * destroy does before the release — and is replaced by the real record.
   */
  test("a forged tombstone for a live agent still gets it terminated, swept and recorded", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const instanceId = instanceOf(row);
    const volumeId = volumeOf(row);
    await backend.store.events.appendTombstone(forgedTombstone(backend, row));
    // A second box the forger would like to keep, too.
    const stray = "i-stray0002";
    backend.instances.set(stray, { ...backend.instances.get(instanceId)!, instance_id: stray });
    expect(backend.instances.get(instanceId)!.state).toBe("running");

    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    expect(backend.instances.get(instanceId)!.state).toBe("terminated");
    expect(backend.instances.get(stray)!.state).toBe("terminated");
    expect([...backend.params.keys()].filter((k) => k.includes("/atlas/"))).toEqual([]);
    expect([...backend.objects.keys()].filter((k) => k.startsWith("config/atlas/"))).toEqual([]);
    expect(backend.volumes.has(volumeId)).toBe(false);
    expect(await backend.store.agents.get("atlas")).toBeNull();
    const tombstones = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstones).toHaveLength(1);
    // Rewritten from the row, on the same key: the forger's account is gone.
    expect(tombstones[0]!.destroyed_by).not.toBe("a-compromised-box");
    expect(tombstones[0]!.instance_id).toBe(instanceId);
    expect(tombstones[0]!.volume_id).toBe(volumeId);
  });

  test("a prior tombstone saying the disk went cannot override --keep-volume", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const volumeId = volumeOf(row);
    await backend.store.events.appendTombstone(forgedTombstone(backend, row, { volume_kept: false }));

    backend.resetMutations();
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true }));

    expect(backend.mutations).not.toContain("compute.deleteVolume");
    expect(backend.volumes.has(volumeId)).toBe(true);
    expect(backend.volumes.get(volumeId)!.agent).toBeNull();
    expect(backend.volumes.get(volumeId)!.former_agent).toBe("atlas");
    const tombstones = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({ volume_id: volumeId, volume_kept: true });
  });

  test("a future-dated tombstone is not adopted: a fresh one is written beside it", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const future = new Date(backend.now().getTime() + HOUR).toISOString();
    await backend.store.events.appendTombstone(forgedTombstone(backend, row, { destroyed_at: future }));

    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    const now = backend.now().toISOString();
    const tombstones = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstones).toHaveLength(2);
    // The planted one is left exactly as it was written.
    expect(tombstones.find((t) => t.destroyed_at === future)).toMatchObject({
      destroyed_by: "a-compromised-box",
      instance_id: null,
    });
    // The real record carries this run's clock, and so does its `release` event.
    expect(tombstones.find((t) => t.destroyed_at === now)).toMatchObject({
      instance_id: instanceOf(row),
      volume_id: volumeOf(row),
    });
    expect(tombstones.find((t) => t.destroyed_at === now)!.destroyed_by).not.toBe("a-compromised-box");
    const releases = (await backend.store.events.query("atlas")).filter((e) => e.action === "release");
    expect(releases.map((e) => e.timestamp)).toEqual([now]);
  });
});

describe("findVolumeByTag", () => {
  test("a volume tagged only former_agent=<name> is not found for <name>", async () => {
    const { backend, row } = await created("atlas");
    const volumeId = volumeOf(row);
    expect(await backend.compute.findVolumeByTag("atlas")).toMatchObject({ volume_id: volumeId });

    await backend.compute.retagVolume(volumeId, null, { formerAgent: "atlas" });
    expect(await backend.compute.findVolumeByTag("atlas")).toBeNull();
  });
});
