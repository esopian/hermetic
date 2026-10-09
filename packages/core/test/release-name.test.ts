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

  /**
   * A stray already `shutting-down` — a crashed destroy's retry, say — still
   * runs its hermeticd, whose heartbeat does not move the row's version. It is
   * waited on like any other, so nothing on it is running when the name goes.
   */
  test("a stray already shutting down is waited on before the row goes", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const own = instanceOf(row);
    const stray = "i-stray0003";
    backend.instances.set(stray, {
      ...backend.instances.get(own)!,
      instance_id: stray,
      state: "shutting-down",
      public_ip: null,
    });

    const describe = backend.compute.describeInstance;
    let strayPolls = 0;
    backend.compute.describeInstance = async (id: string) => {
      const inst = backend.instances.get(id);
      if (id === stray && inst?.state === "shutting-down") {
        strayPolls += 1;
        if (strayPolls >= 2) backend.instances.set(id, { ...inst, state: "terminated" });
      }
      return describe(id);
    };
    const del = backend.store.agents.delete;
    const strayAtDelete: string[] = [];
    backend.store.agents.delete = async (name, opts) => {
      strayAtDelete.push(backend.instances.get(stray)!.state);
      return del(name, opts);
    };

    const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    expect(strayAtDelete).toEqual(["terminated"]);
    expect(strayPolls).toBeGreaterThanOrEqual(2);
    expect(
      events.some(
        (e) =>
          e.message.includes(`instance ${stray} is also tagged`) && e.message.includes("shutting down"),
      ),
    ).toBe(true);
    expect(await backend.store.agents.get("atlas")).toBeNull();
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

  test("the tombstone keeps the original destroy's time and actor, and records the release apart", async () => {
    const { backend, hermetic, row } = await created("atlas");
    makeLegacy(backend, row);
    // The old destroy, as its history recorded it: another operator, a day ago.
    const destroyedAt = new Date(Date.parse(row.created_at) + 60_000).toISOString();
    await backend.store.events.append({
      name: "atlas",
      timestamp: destroyedAt,
      actor: "former-operator",
      action: "destroy",
      from_status: "destroying",
      to_status: "destroyed",
      detail: "destroyed",
    });
    backend.advance(24 * HOUR);
    const [before] = await hermetic.agents.destroyed({ name: "atlas" });
    expect(before).toMatchObject({
      legacy: true,
      destroyed_at: destroyedAt,
      destroyed_by: "former-operator",
    });

    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    const release = (await backend.store.events.query("atlas")).find((e) => e.action === "release")!;
    const [tombstone] = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstone).toMatchObject({
      legacy: false,
      destroyed_at: destroyedAt,
      destroyed_by: "former-operator",
      released_at: backend.now().toISOString(),
      released_by: release.actor,
    });
    expect(release.timestamp).toBe(tombstone!.released_at!);
    expect(release.actor).not.toBe("former-operator");
    // `agents.destroyed` tells the same story before and after the release.
    const [after] = await hermetic.agents.destroyed({ name: "atlas" });
    expect(after).toMatchObject({
      destroyed_at: before!.destroyed_at,
      destroyed_by: before!.destroyed_by,
    });
    // The record ends at the release: that window still holds the release event.
    const life = await hermetic.agents.history({
      name: "atlas",
      since: tombstone!.created_at,
      until: tombstone!.released_at!,
    });
    expect(life.map((e) => e.action)).toContain("release");

    // The next life starts after the release, not merely after the old destroy.
    await drain(hermetic.agents.create({ name: "atlas" }));
    const again = (await backend.store.agents.get("atlas"))!;
    expect(again.created_at > tombstone!.released_at!).toBe(true);
  });

  test("a create that releases an old legacy row is born after the release, not the destroy", async () => {
    const { backend, hermetic, row } = await created("atlas");
    makeLegacy(backend, row);
    await backend.store.events.append({
      name: "atlas",
      timestamp: new Date(Date.parse(row.created_at) + 60_000).toISOString(),
      actor: "former-operator",
      action: "destroy",
      from_status: "destroying",
      to_status: "destroyed",
      detail: "destroyed",
    });
    backend.advance(24 * HOUR);

    // The clock is frozen: release and birth read the same instant.
    await drain(hermetic.agents.create({ name: "atlas" }));
    const [tombstone] = await backend.store.events.queryTombstones({ name: "atlas" });
    const again = (await backend.store.agents.get("atlas"))!;
    expect(tombstone!.destroyed_by).toBe("former-operator");
    expect(again.created_at > tombstone!.released_at!).toBe(true);
  });

  test("a destroy that is itself the release carries no released_at", async () => {
    const { backend, hermetic } = await created("atlas");
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    const [tombstone] = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstone!.released_at).toBeUndefined();
    expect(tombstone!.released_by).toBeUndefined();
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

/**
 * The row is deleted only if it is the same incarnation at the same version.
 * A release that stalled past its lock while the name was destroyed and
 * created again must not delete the newcomer, even at the same version.
 */
describe("the release's conditional delete", () => {
  test("a later incarnation of the name at the same version is not deleted", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const reborn = new Date(Date.parse(row.created_at) + HOUR).toISOString();

    // Between this run's tombstone and its delete, somebody else's release and
    // create put a new `atlas` in the table — at the very version this run read.
    const appendTombstone = backend.store.events.appendTombstone;
    backend.store.events.appendTombstone = async (t) => {
      await appendTombstone(t);
      const current = backend.agents.get("atlas")!;
      backend.agents.set("atlas", { ...current, created_at: reborn, status: "ready", lock: null });
    };

    let error: unknown = null;
    try {
      await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    } catch (e) {
      error = e;
    }
    expect((error as HermeticError).code).toBe("CONFLICT");
    const survivor = (await backend.store.agents.get("atlas"))!;
    expect(survivor).not.toBeNull();
    expect(survivor.created_at).toBe(reborn);
  });
});

/**
 * §6.7: a destroy that keeps the volume sets `former_agent` first and removes
 * `agent` second (`retagVolume`), both before any tombstone exists. A crash
 * anywhere in there must leave a disk the next destroy keeps — whatever that
 * destroy's own flag says — and a name the next destroy can release.
 */
describe("an interrupted keep-volume retag", () => {
  async function crashInRetag(afterDeleteTags: boolean) {
    const fleet = await created("atlas");
    const { backend, hermetic } = fleet;
    const retag = backend.compute.retagVolume;
    backend.compute.retagVolume = async (id, agent, opts) => {
      if (agent === null && opts?.formerAgent) {
        if (afterDeleteTags) {
          await retag(id, agent, opts);
        } else {
          // `CreateTags` landed, `DeleteTags` never did.
          backend.volumes.set(id, { ...backend.volumes.get(id)!, former_agent: opts.formerAgent });
        }
        throw new HermeticError("INTERNAL", "the laptop lost its network", {});
      }
      return retag(id, agent, opts);
    };
    await expect(
      drain(hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true })),
    ).rejects.toThrow(HermeticError);
    backend.compute.retagVolume = retag;
    expect(await backend.store.events.queryTombstones({ name: "atlas" })).toHaveLength(0);
    return fleet;
  }

  test("between setting former_agent and removing agent: a plain retry keeps the disk", async () => {
    const { backend, hermetic, row } = await crashInRetag(false);
    const kept = volumeOf(row);
    expect(backend.volumes.get(kept)).toMatchObject({ agent: "atlas", former_agent: "atlas" });

    backend.resetMutations();
    const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    expect(backend.mutations).not.toContain("compute.deleteVolume");
    expect(backend.volumes.get(kept)).toMatchObject({ agent: null, former_agent: "atlas" });
    expect(await backend.store.agents.get("atlas")).toBeNull();
    const [tombstone] = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstone).toMatchObject({ volume_id: kept, volume_kept: true });
    const note = events.find((e) => e.phase === "volume")!;
    expect(note.message).toContain("already carries former_agent=atlas");
    expect(note.level).toBe("warn");
  });

  test("after removing agent: a plain retry keeps the disk and releases the name", async () => {
    const { backend, hermetic, row } = await crashInRetag(true);
    const kept = volumeOf(row);
    expect(backend.volumes.get(kept)).toMatchObject({ agent: null, former_agent: "atlas" });

    backend.resetMutations();
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    expect(backend.mutations).not.toContain("compute.deleteVolume");
    expect(backend.volumes.get(kept)).toMatchObject({ agent: null, former_agent: "atlas" });
    expect(await backend.store.agents.get("atlas")).toBeNull();
    const [tombstone] = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstone).toMatchObject({ volume_id: kept, volume_kept: true });
  });

  /** Another agent's released disk is not this name's to claim. */
  test("a disk released from another name is foreign, not released", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const volumeId = volumeOf(row);
    backend.volumes.set(volumeId, {
      ...backend.volumes.get(volumeId)!,
      agent: null,
      former_agent: "bravo",
    });

    // A plain destroy refuses before it touches anything.
    await expect(drain(hermetic.agents.destroy({ name: "atlas", yes: true }))).rejects.toThrow(
      "is not atlas's",
    );
    expect(backend.volumes.get(volumeId)).toMatchObject({ agent: null, former_agent: "bravo" });

    // A keeping one releases the name and leaves bravo's disk saying bravo.
    const events = await drain(
      hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true }),
    );
    expect(backend.volumes.get(volumeId)).toMatchObject({ agent: null, former_agent: "bravo" });
    expect(events.some((e) => e.message.includes("belongs to someone else"))).toBe(true);
    expect(await backend.store.agents.get("atlas")).toBeNull();
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
    // Past the birth instant, so this run's own key is plainly `now`.
    backend.advance(HOUR);
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

/**
 * §6.7: a retry's tombstone lands on the key of the one it found. The key is
 * `destroyed_at`; nothing else a prior says — it may be the box's forgery —
 * may move it, or rewrite who released a legacy row.
 */
describe("a retry keeps the tombstone it found", () => {
  test("a prior whose released_at differs from destroyed_at does not move the key", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const destroyedAt = backend.now().toISOString();
    const releasedAt = new Date(backend.now().getTime() + 60_000).toISOString();
    await backend.store.events.appendTombstone(
      forgedTombstone(backend, row, { destroyed_at: destroyedAt, released_at: releasedAt }),
    );
    backend.advance(HOUR);

    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    const tombstones = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.destroyed_at).toBe(destroyedAt);
    expect(tombstones[0]!.released_at).toBeUndefined();
  });

  test("a legacy row's retry keeps released_at and released_by from the first run", async () => {
    const { backend, hermetic, row } = await created("atlas");
    makeLegacy(backend, row);
    const destroyedAt = new Date(Date.parse(row.created_at) + 60_000).toISOString();
    const releasedAt = new Date(Date.parse(row.created_at) + 120_000).toISOString();
    await backend.store.events.appendTombstone(
      forgedTombstone(backend, row, {
        destroyed_at: destroyedAt,
        released_at: releasedAt,
        released_by: "first-operator",
      }),
    );
    backend.advance(HOUR);

    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    const tombstones = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      destroyed_at: destroyedAt,
      released_at: releasedAt,
      released_by: "first-operator",
    });
  });

  test("a legacy prior released before it was destroyed keeps its key", async () => {
    const { backend, hermetic, row } = await created("atlas");
    makeLegacy(backend, row);
    const destroyedAt = new Date(Date.parse(row.created_at) + 120_000).toISOString();
    const releasedAt = new Date(Date.parse(row.created_at) + 60_000).toISOString();
    await backend.store.events.appendTombstone(
      forgedTombstone(backend, row, { destroyed_at: destroyedAt, released_at: releasedAt }),
    );
    backend.advance(HOUR);

    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    const tombstones = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstones).toHaveLength(1);
    // The release is lifted to the destroy rather than the key lowered to it.
    expect(tombstones[0]).toMatchObject({ destroyed_at: destroyedAt, released_at: destroyedAt });
  });
});

/**
 * A second managed disk tagged `agent=<name>` beside the row's own: a launch
 * whose volume id never reached the row, or the duplicate `doctor` reports.
 */
function addTaggedDisk(backend: MemoryBackend, row: Agent, volumeId: string): void {
  backend.volumes.set(volumeId, {
    ...backend.volumes.get(volumeOf(row))!,
    volume_id: volumeId,
    agent: row.name,
    role: "data",
    attached_to: null,
    state: "available",
  });
}

/** The warn a release yields for a disk it swept off the name. */
function sweptWarnings(
  events: Array<{ message: string; level?: string | undefined }>,
  volumeId: string,
) {
  return events.filter(
    (e) =>
      e.level === "warn" &&
      e.message.includes(`volume ${volumeId} `) &&
      e.message.includes("was still tagged agent="),
  );
}

/**
 * §6.7: a release leaves no disk tagged `agent=<name>`. Every one besides the
 * row's own is moved off the name to `former_agent=<name>` and reported —
 * never deleted, because the row never named it — so the next plain `create`
 * cannot adopt it by tag.
 */
describe("other disks still tagged for the name", () => {
  test("a crash after a keep retag beside a duplicate: the retry releases the name, both disks kept", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const own = volumeOf(row);
    addTaggedDisk(backend, row, "vol-dup");

    const append = backend.store.events.appendTombstone;
    let crashed = false;
    backend.store.events.appendTombstone = async (t) => {
      if (!crashed) {
        crashed = true;
        throw new HermeticError("INTERNAL", "the laptop lost its network", {});
      }
      return append(t);
    };
    await expect(
      drain(hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true })),
    ).rejects.toThrow(HermeticError);
    expect((await backend.store.agents.get("atlas"))!.status).toBe("destroying");

    backend.resetMutations();
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    expect(await backend.store.agents.get("atlas")).toBeNull();
    expect(backend.mutations).not.toContain("compute.deleteVolume");
    for (const id of [own, "vol-dup"]) {
      expect(backend.volumes.get(id)).toMatchObject({ agent: null, former_agent: "atlas" });
    }
    expect(await backend.compute.findVolumeByTag("atlas")).toBeNull();
    const tombstones = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({ volume_id: own, volume_kept: true });
  });

  for (const keep_volume of [false, true]) {
    test(`a row pointed at an earlier released disk: destroy${keep_volume ? " --keep-volume" : ""} moves the real one off the name`, async () => {
      const { backend, hermetic, row } = await created("atlas");
      const real = volumeOf(row);
      const old = "vol-released-earlier";
      backend.volumes.set(old, {
        ...backend.volumes.get(real)!,
        volume_id: old,
        agent: null,
        former_agent: "atlas",
        attached_to: null,
        state: "available",
      });
      const current = backend.agents.get("atlas")!;
      backend.agents.set("atlas", {
        ...current,
        volume_id: old,
        resources: { ...current.resources, volume_id: old },
      });

      backend.resetMutations();
      const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume }));

      expect(await backend.store.agents.get("atlas")).toBeNull();
      expect(backend.mutations).not.toContain("compute.deleteVolume");
      expect(backend.volumes.get(real)).toMatchObject({ agent: null, former_agent: "atlas" });
      expect(backend.volumes.get(old)).toMatchObject({ agent: null, former_agent: "atlas" });
      expect(sweptWarnings(events, real)).toHaveLength(1);
      expect(sweptWarnings(events, old)).toHaveLength(0);
      expect(await backend.compute.findVolumeByTag("atlas")).toBeNull();
    });
  }

  test("a row naming no volume while a disk carries the name: the disk is moved off it, not deleted", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const real = volumeOf(row);
    const current = backend.agents.get("atlas")!;
    const { volume_id: _dropped, ...resources } = current.resources;
    backend.agents.set("atlas", { ...current, volume_id: null, resources });

    backend.resetMutations();
    const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    expect(await backend.store.agents.get("atlas")).toBeNull();
    expect(backend.mutations).not.toContain("compute.deleteVolume");
    expect(backend.volumes.get(real)).toMatchObject({ agent: null, former_agent: "atlas" });
    expect(sweptWarnings(events, real)).toHaveLength(1);
    const [tombstone] = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstone).toMatchObject({ volume_id: null, volume_kept: false });
  });

  test("a create over a legacy row moves a stray tagged disk off the name and starts fresh", async () => {
    const { backend, hermetic, row } = await created("atlas");
    makeLegacy(backend, row);
    addTaggedDisk(backend, row, "vol-dup");
    backend.advance(HOUR);

    const events = await drain(hermetic.agents.create({ name: "atlas" }));

    expect(backend.volumes.get("vol-dup")).toMatchObject({ agent: null, former_agent: "atlas" });
    expect(sweptWarnings(events, "vol-dup")).toHaveLength(1);
    const again = (await backend.store.agents.get("atlas"))!;
    expect([volumeOf(row), "vol-dup"]).not.toContain(volumeOf(again));
  });
});

/**
 * §6.7: a tombstone's key is its `destroyed_at`. Under a frozen clock every
 * reading is the same instant, so each life of a name must still land on a
 * key of its own — or a destroy overwrites its predecessor's tombstone.
 */
describe("tombstone keys under a frozen clock", () => {
  test("three lives of one name leave three tombstones and three release events", async () => {
    const { backend, hermetic } = await created("atlas");
    // No `advance` anywhere.
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    for (let i = 0; i < 2; i++) {
      await drain(hermetic.agents.create({ name: "atlas" }));
      await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    }

    const tombstones = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstones).toHaveLength(3);
    expect(new Set(tombstones.map((t) => t.destroyed_at)).size).toBe(3);
    expect(new Set(tombstones.map((t) => t.created_at)).size).toBe(3);
    for (const t of tombstones) expect(t.destroyed_at > t.created_at).toBe(true);
    const releases = (await backend.store.events.query("atlas")).filter((e) => e.action === "release");
    expect(releases).toHaveLength(3);
    expect(new Set(releases.map((e) => e.timestamp)).size).toBe(3);
  });
});

/**
 * §6.7: adopting a released disk sets `agent=<name>` and then removes
 * `former_agent` — two calls. A crash between them leaves the shape an
 * interrupted release also leaves; the resumed create must finish the
 * adoption, or a later plain destroy would keep a disk it should delete.
 */
describe("an adoption interrupted between its two tag calls", () => {
  test("the resumed create clears former_agent, and a plain destroy then deletes the disk", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const kept = volumeOf(row);
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true }));
    backend.advance(HOUR);

    const retag = backend.compute.retagVolume;
    let crashed = false;
    backend.compute.retagVolume = async (id, agent, opts) => {
      if (!crashed && agent === "bravo") {
        crashed = true;
        // `CreateTags` landed (agent=bravo), `DeleteTags` (former_agent) never did.
        backend.volumes.set(id, { ...backend.volumes.get(id)!, agent: "bravo", role: "data" });
        throw new HermeticError("INTERNAL", "the laptop lost its network", {});
      }
      return retag(id, agent, opts);
    };
    await expect(drain(hermetic.agents.create({ name: "bravo", volume_id: kept }))).rejects.toThrow(
      HermeticError,
    );
    backend.compute.retagVolume = retag;
    expect(backend.volumes.get(kept)).toMatchObject({ agent: "bravo", former_agent: "atlas" });

    const events = await drain(hermetic.agents.create({ name: "bravo", volume_id: kept }));
    expect(backend.volumes.get(kept)!.agent).toBe("bravo");
    expect(backend.volumes.get(kept)!.former_agent ?? null).toBeNull();
    expect(events.some((e) => e.message.includes("cleared former_agent=atlas"))).toBe(true);

    backend.resetMutations();
    await drain(hermetic.agents.destroy({ name: "bravo", yes: true }));
    expect(backend.mutations).toContain("compute.deleteVolume");
    expect(backend.volumes.has(kept)).toBe(false);
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

/**
 * §6.7: the release names every disk it swept off the name — in the warnings
 * of whichever path released it, and durably on the `release` event, the only
 * record of the move besides the tags themselves.
 */
describe("swept disks are reported", () => {
  test("a legacy row that appears after the first read still reports its swept disk", async () => {
    const { backend, hermetic, row } = await created("atlas");
    makeLegacy(backend, row);
    addTaggedDisk(backend, row, "vol-dup");
    // The first read of the name misses the row, so the release happens in
    // `classify` rather than above the claim.
    const get = backend.store.agents.get;
    let reads = 0;
    backend.store.agents.get = async (name: string) => {
      reads += 1;
      if (name === "atlas" && reads === 1) return null;
      return get(name);
    };
    backend.advance(HOUR);

    const events = await drain(hermetic.agents.create({ name: "atlas" }));

    expect(backend.volumes.get("vol-dup")).toMatchObject({ agent: null, former_agent: "atlas" });
    expect(sweptWarnings(events, "vol-dup")).toHaveLength(1);
    expect(events.some((e) => e.level === "warn" && e.message.startsWith("released atlas"))).toBe(true);
  });

  test("the release event lists the disks the sweep moved", async () => {
    const { backend, hermetic, row } = await created("atlas");
    addTaggedDisk(backend, row, "vol-dup");

    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    const [release] = (await backend.store.events.query("atlas")).filter((e) => e.action === "release");
    expect(release!.detail).toContain("vol-dup");
    expect(release!.detail).toContain("former_agent=atlas");
  });

  test("a release that swept nothing says so plainly", async () => {
    const { backend, hermetic } = await created("atlas");
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    const [release] = (await backend.store.events.query("atlas")).filter((e) => e.action === "release");
    expect(release!.detail).toBe("name released; tombstone written");
  });
});

/**
 * The row's `created_at` and the events table are both writable by the box, so
 * a far-future instant in either must neither key a tombstone there nor take
 * the name's floor away.
 */
describe("far-future instants a box can write", () => {
  test("a row whose created_at is in the year 3000 is keyed at now", async () => {
    const { backend, hermetic } = await created("atlas");
    backend.advance(HOUR);
    backend.agents.set("atlas", {
      ...backend.agents.get("atlas")!,
      created_at: "3000-01-01T00:00:00.000Z",
    });

    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    const [tombstone] = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstone!.created_at).toBe("3000-01-01T00:00:00.000Z");
    expect(tombstone!.destroyed_at).toBe(backend.now().toISOString());
  });

  test("a planted future tombstone does not take the floor from the genuine one before it", async () => {
    const { backend, hermetic, row } = await created("atlas");
    // No `advance`: under a frozen clock the next life is born only because of
    // the floor, one millisecond past the last life's end.
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    const [genuine] = await backend.store.events.queryTombstones({ name: "atlas" });
    const future = new Date(backend.now().getTime() + 24 * HOUR).toISOString();
    await backend.store.events.appendTombstone(
      forgedTombstone(backend, row, { created_at: future, destroyed_at: future }),
    );

    await drain(hermetic.agents.create({ name: "atlas" }));

    const again = (await backend.store.agents.get("atlas"))!;
    expect(again.created_at > genuine!.destroyed_at).toBe(true);
  });
});

/**
 * §6.7: `--keep-volume` is written onto the disk before anything is
 * terminated. A run that dies between the terminate and the release's retag
 * has left no tombstone, so the tag is the only record of the choice — and a
 * retry typed without the flag must still keep the disk.
 */
describe("the keep intent is durable before the terminate", () => {
  test("a keep destroy that dies after the terminate: a plain retry keeps the disk", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const kept = volumeOf(row);

    const sweep = backend.secrets.deleteByPrefix;
    let crashed = false;
    backend.secrets.deleteByPrefix = async (prefix) => {
      if (!crashed) {
        crashed = true;
        throw new HermeticError("INTERNAL", "the laptop lost its network", {});
      }
      return sweep(prefix);
    };
    await expect(
      drain(hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true })),
    ).rejects.toThrow(HermeticError);
    expect(backend.instances.get(instanceOf(row))!.state).not.toBe("running");
    expect(await backend.store.events.queryTombstones({ name: "atlas" })).toHaveLength(0);
    // `agent` stays until the release: the disk is still this agent's.
    expect(backend.volumes.get(kept)).toMatchObject({ agent: "atlas", former_agent: "atlas" });

    backend.resetMutations();
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    expect(backend.mutations).not.toContain("compute.deleteVolume");
    expect(backend.volumes.get(kept)).toMatchObject({ agent: null, former_agent: "atlas" });
    expect(await backend.store.agents.get("atlas")).toBeNull();
    const [tombstone] = await backend.store.events.queryTombstones({ name: "atlas" });
    expect(tombstone).toMatchObject({ volume_id: kept, volume_kept: true });
  });
});

/**
 * §6.7: the release reads which disks hold the name, then writes. Whatever
 * moves in between is somebody else's, and the writes must not take it.
 */
describe("the release's tag writes", () => {
  test("a disk another agent adopted between the read and the write keeps its new owner", async () => {
    const { backend, hermetic, row } = await created("atlas");
    const own = volumeOf(row);
    addTaggedDisk(backend, row, "vol-dup");

    // Right after the release lists the disks — and after it resolved the
    // row's own — another agent's adoption retags both to `bravo`.
    const list = backend.compute.listVolumesByAgentTag;
    backend.compute.listVolumesByAgentTag = async (name) => {
      const listed = await list(name);
      for (const id of [own, "vol-dup"]) {
        backend.volumes.set(id, { ...backend.volumes.get(id)!, agent: "bravo" });
      }
      return listed;
    };
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true }));

    expect(backend.volumes.get(own)!.agent).toBe("bravo");
    expect(backend.volumes.get("vol-dup")!.agent).toBe("bravo");
    expect(await backend.store.agents.get("atlas")).toBeNull();
  });

  test("a disk created after the run began is a successor's and is not swept", async () => {
    const { backend, hermetic, row } = await created("atlas");
    addTaggedDisk(backend, row, "vol-dup");

    // A disk tagged for the name that EC2 made after this destroy started:
    // only a later incarnation, created once this run's lock had lapsed, can
    // own one.
    const list = backend.compute.listVolumesByAgentTag;
    backend.compute.listVolumesByAgentTag = async (name) => {
      backend.advance(1_000);
      backend.volumes.set("vol-successor", {
        ...backend.volumes.get("vol-dup")!,
        volume_id: "vol-successor",
        created_at: backend.now().toISOString(),
      });
      return list(name);
    };
    const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    expect(backend.volumes.get("vol-successor")!.agent).toBe("atlas");
    expect(backend.volumes.get("vol-successor")!.former_agent ?? null).toBeNull();
    expect(sweptWarnings(events, "vol-successor")).toHaveLength(0);
    // The older duplicate is still this name's to move off it.
    expect(backend.volumes.get("vol-dup")).toMatchObject({ agent: null, former_agent: "atlas" });
    expect(sweptWarnings(events, "vol-dup")).toHaveLength(1);
  });

  /**
   * A release that stalled past its lock: by the time it would write, the row
   * is no longer this run's. It refuses with `CONFLICT` before any tag moves.
   */
  const moved: Array<[string, (a: Agent, now: Date) => Agent]> = [
    [
      "its lock lapsed",
      (a, now) => ({
        ...a,
        lock: { owner: a.lock!.owner, expires: new Date(now.getTime() - 1).toISOString() },
      }),
    ],
    [
      "another operator holds the lock",
      (a) => ({ ...a, lock: { owner: "someone-else#1", expires: "2999-01-01T00:00:00.000Z" } }),
    ],
    [
      "a later incarnation holds the name",
      (a) => ({
        ...a,
        created_at: new Date(Date.parse(a.created_at) + HOUR).toISOString(),
        status: "ready",
        lock: null,
      }),
    ],
  ];
  for (const [label, move] of moved) {
    test(`the row is checked again before the first tag write: ${label}`, async () => {
      const { backend, hermetic, row } = await created("atlas");
      const own = volumeOf(row);
      addTaggedDisk(backend, row, "vol-dup");

      const list = backend.compute.listVolumesByAgentTag;
      backend.compute.listVolumesByAgentTag = async (name) => {
        const listed = await list(name);
        backend.agents.set("atlas", move(backend.agents.get("atlas")!, backend.now()));
        backend.resetMutations();
        return listed;
      };
      let error: unknown = null;
      try {
        await drain(hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true }));
      } catch (e) {
        error = e;
      }

      expect((error as HermeticError).code).toBe("CONFLICT");
      expect(backend.mutations).not.toContain("compute.retagVolume");
      expect(backend.volumes.get(own)!.agent).toBe("atlas");
      expect(backend.volumes.get("vol-dup")).toMatchObject({ agent: "atlas" });
      expect(backend.volumes.get("vol-dup")!.former_agent ?? null).toBeNull();
      expect(await backend.store.events.queryTombstones({ name: "atlas" })).toHaveLength(0);
      expect(await backend.store.agents.get("atlas")).not.toBeNull();
    });
  }
});
