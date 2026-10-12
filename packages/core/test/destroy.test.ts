import { describe, expect, test } from "bun:test";
import { HermeticError } from "../src/errors.ts";
import type { AgentStatus } from "../src/schema/index.ts";
import type { AgentPatch } from "../src/backend/types.ts";
import {
  FIXTURE_CONFIG,
  FIXTURE_HERMETICD_VERSION,
  FIXTURE_PROFILE_IDS,
  MemoryBackend,
  seedFixtureFleet,
} from "../src/backend/memory.ts";
import { agentParamPath, agentParamPrefix, sharedSecretPath } from "../src/backend/constants.ts";
import { profileSlotSlug } from "../src/schema/index.ts";
import { drain, freshFleet, testHermetic } from "./helpers.ts";

function seeded() {
  const backend = seedFixtureFleet(new MemoryBackend());
  return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG }) };
}

describe("agents.destroy", () => {
  test("refuses without an explicit yes", async () => {
    const { backend, hermetic } = seeded();
    let code: string | null = null;
    try {
      await drain(hermetic.agents.destroy({ name: "atlas", yes: false }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("CONFIRMATION_REQUIRED");
    expect(backend.mutations).toEqual([]);
    expect((await backend.store.agents.get("atlas"))!.status).toBe("ready");
  });

  test("--keep-volume keeps the data volume, released from the name", async () => {
    const { backend, hermetic } = seeded();
    const before = (await backend.store.agents.get("atlas"))!;
    const volumeId = before.resources.volume_id!;

    const events = await drain(
      hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true }),
    );
    expect(events.at(-1)?.progress).toBe(1);
    expect(events.find((e) => e.phase === "volume")?.message).toContain("keeping");

    // §6.7: the row is gone; the volume outlives it under `former_agent`.
    expect(await backend.store.agents.get("atlas")).toBeNull();
    expect(backend.volumes.has(volumeId)).toBe(true);
    expect(backend.volumes.get(volumeId)!.agent).toBeNull();
    expect(backend.volumes.get(volumeId)!.former_agent).toBe("atlas");
    expect(backend.volumes.get(volumeId)!.role).toBe("data");
    expect(backend.mutations).not.toContain("compute.deleteVolume");

    // The instance is gone, the SSM slots are gone, the config objects are gone.
    expect(backend.instances.get(before.resources.instance_id!)!.state).toBe("terminated");
    expect(await backend.secrets.list("/hermes/fxtr0001/atlas/")).toEqual([]);
    expect([...backend.objects.keys()].filter((k) => k.startsWith("config/atlas/"))).toEqual([]);
    // Every version, not a delete marker over the current one: the bucket is
    // versioned and keeps noncurrent versions, so only the version-aware door
    // frees the old config (§6.7).
    expect(backend.mutations).toContain("artifacts.purgeByPrefix");
    expect(backend.mutations).not.toContain("artifacts.deleteByPrefix");
  });

  test("deletes the data volume by default", async () => {
    const { backend, hermetic } = seeded();
    const volumeId = (await backend.store.agents.get("corvid"))!.resources.volume_id!;

    const events = await drain(hermetic.agents.destroy({ name: "corvid", yes: true }));
    expect(events.find((e) => e.phase === "volume")?.message).toContain("deleted");
    expect(events.find((e) => e.phase === "volume")?.level).toBe("warn");

    expect(backend.volumes.has(volumeId)).toBe(false);
    expect(backend.mutations).toContain("compute.deleteVolume");
    expect(await backend.store.agents.get("corvid")).toBeNull();
  });

  test("events are never deleted", async () => {
    const { backend, hermetic } = seeded();
    const before = await backend.store.events.query("ember");
    expect(before.length).toBeGreaterThan(0);

    await drain(hermetic.agents.destroy({ name: "ember", yes: true }));

    const after = await backend.store.events.query("ember");
    expect(after.length).toBeGreaterThan(before.length);
    for (const e of before) {
      expect(after.some((a) => a.timestamp === e.timestamp && a.action === e.action)).toBe(true);
    }
    expect(after.some((e) => e.action === "release")).toBe(true);
    // The row is released (§6.7); the tombstone is what records it.
    expect(await backend.store.agents.get("ember")).toBeNull();
    expect((await backend.store.events.queryTombstones({ name: "ember" })).length).toBe(1);
  });

  test("destroying twice is NOT_FOUND the second time, and changes nothing", async () => {
    const { backend, hermetic } = seeded();
    await drain(hermetic.agents.destroy({ name: "ibis", yes: true }));
    backend.resetMutations();
    let code: string | null = null;
    try {
      await drain(hermetic.agents.destroy({ name: "ibis", yes: true }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("NOT_FOUND");
    expect(backend.mutations).toEqual([]);
  });

  test("an unknown agent is NOT_FOUND", async () => {
    const { hermetic } = seeded();
    let code: string | null = null;
    try {
      await drain(hermetic.agents.destroy({ name: "nosuch", yes: true }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("NOT_FOUND");
  });

  test("a freshly created agent can be destroyed straight away", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "atlas" }));
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    expect(await backend.store.agents.get("atlas")).toBeNull();
  });
});

/**
 * §4.5: "any operator can re-run `create` to finish, or `destroy` to clean up".
 * A destroy that died partway has to be one of those, and it was not: the row it
 * left in `destroying` had no edge back to itself in the §4.3 table, so every
 * retry threw `INVALID_TRANSITION` before reaching the step that still needed
 * doing. Destroy, recreate and stop all refused the row, and the only way out
 * was editing DynamoDB by hand.
 */
/**
 * §4.4: `destroy` heartbeat its TTL lock exactly once, before the SSM sweep,
 * and then spent the tailnet call, the config sweep and an unbounded detach
 * wait without touching it. A destroy slower than `LOCK_TTL_MS` — a tailnet API
 * that is thinking about it, a bucket with thousands of objects — unlocked
 * itself while it was still deleting things.
 */
describe("destroy keeps its lock alive between steps", () => {
  test("the lock is renewed before the tailnet call and before the config sweep", async () => {
    const { backend, hermetic } = seeded();
    const started = backend.now().getTime();
    const ttl = 10 * 60_000;

    // Each of these steps takes long enough that the lock would otherwise be a
    // third of its life older by the time the next one runs.
    const terminate = backend.compute.terminate;
    backend.compute.terminate = async (id: string) => {
      backend.advance(5 * 60_000);
      return terminate(id);
    };
    const secrets = backend.secrets.deleteByPrefix;
    backend.secrets.deleteByPrefix = async (prefix: string) => {
      backend.advance(5 * 60_000);
      return secrets(prefix);
    };

    const expiries: Record<string, string | null> = {};
    const at = async (step: string): Promise<void> => {
      expiries[step] = (await backend.store.agents.get("atlas"))!.lock?.expires ?? null;
    };
    const listDevices = backend.tailscale.listDevices;
    backend.tailscale.listDevices = async () => {
      await at("tailnet");
      return listDevices();
    };
    const objects = backend.artifacts.purgeByPrefix;
    backend.artifacts.purgeByPrefix = async (prefix: string) => {
      await at("config");
      return objects(prefix);
    };

    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    // Both were taken after five minutes had passed, so a lock that was never
    // renewed would still expire at `started + ttl`.
    expect(Date.parse(expiries["tailnet"]!)).toBeGreaterThan(started + ttl);
    expect(Date.parse(expiries["config"]!)).toBeGreaterThan(started + ttl + 5 * 60_000);
  });
});

describe("a destroy that failed partway can be run again", () => {
  test("the volume step failing leaves a row a second destroy can finish", async () => {
    const { backend, hermetic } = seeded();
    const before = (await backend.store.agents.get("corvid"))!;
    const volumeId = before.resources.volume_id!;
    const instanceId = before.resources.instance_id!;

    // Exactly the reported failure: EC2 has not finished detaching the volume
    // from the instance we just terminated, so `DeleteVolume` is refused.
    const realDelete = backend.compute.deleteVolume;
    backend.compute.deleteVolume = async () => {
      throw new HermeticError(
        "INTERNAL",
        `Volume ${volumeId} is currently attached to {${instanceId}}`,
        { aws_error: "VolumeInUse" },
      );
    };

    await expect(drain(hermetic.agents.destroy({ name: "corvid", yes: true }))).rejects.toThrow(
      HermeticError,
    );

    // The instance really is gone and the row honestly says it is part-destroyed.
    const stranded = (await backend.store.agents.get("corvid"))!;
    expect(stranded.status).toBe("destroying");
    expect(backend.instances.get(instanceId)!.state).toBe("terminated");
    // The lock is not left behind for the TTL to clean up.
    expect(stranded.lock).toBeNull();

    // The retry, against a fixed world, finishes the job rather than throwing.
    backend.compute.deleteVolume = realDelete;
    const events = await drain(hermetic.agents.destroy({ name: "corvid", yes: true }));

    expect(events.at(-1)?.progress).toBe(1);
    expect(await backend.store.agents.get("corvid")).toBeNull();
    expect(backend.volumes.has(volumeId)).toBe(false);
  });

  test("the retry does not redo the steps the first run finished", async () => {
    const { backend, hermetic } = seeded();
    const instanceId = (await backend.store.agents.get("corvid"))!.resources.instance_id!;

    backend.compute.deleteVolume = async () => {
      throw new HermeticError("INTERNAL", "refused", { aws_error: "VolumeInUse" });
    };
    await expect(drain(hermetic.agents.destroy({ name: "corvid", yes: true }))).rejects.toThrow(
      HermeticError,
    );

    backend.resetMutations();
    // Kept this time, so the stub still refusing `DeleteVolume` is not reached.
    const events = await drain(
      hermetic.agents.destroy({ name: "corvid", yes: true, keep_volume: true }),
    );

    // Reality-checked: the instance is already terminated, so nothing terminates
    // it again, and the SSM/S3 prefixes are already empty.
    expect(backend.mutations).not.toContain("compute.terminate");
    expect(backend.mutations).not.toContain("secrets.deleteByPrefix");
    expect(backend.mutations).not.toContain("artifacts.purgeByPrefix");
    expect(events.find((e) => e.phase === "instance")?.message).toContain(
      `instance ${instanceId} is already terminated`,
    );
    expect(events.at(-1)?.progress).toBe(1);
  });

  test("the failure is written to the agent's history", async () => {
    const { backend, hermetic } = seeded();
    backend.compute.deleteVolume = async () => {
      throw new HermeticError("CONFLICT", "refused");
    };
    await expect(drain(hermetic.agents.destroy({ name: "corvid", yes: true }))).rejects.toThrow(
      HermeticError,
    );

    const history = await backend.store.events.query("corvid");
    const failure = history.find((e) => e.action === "failed");
    expect(failure).toBeDefined();
    expect(failure!.detail).toBe("destroy failed (CONFLICT)");
  });

  test("re-entering `destroying` writes no second transition event", async () => {
    // A re-entry is not a state change, so the history must not claim one.
    const { backend, hermetic } = seeded();
    backend.compute.deleteVolume = async () => {
      throw new HermeticError("CONFLICT", "refused");
    };
    await expect(drain(hermetic.agents.destroy({ name: "ember", yes: true }))).rejects.toThrow(
      HermeticError,
    );

    await drain(hermetic.agents.destroy({ name: "ember", yes: true, keep_volume: true }));

    const history = await backend.store.events.query("ember");
    const entered = history.filter((e) => e.to_status === "destroying");
    expect(entered.length).toBe(1);
    expect(history.some((e) => e.action === "release")).toBe(true);
  });

  test("a row already destroying in the store, with a stale local copy, is adopted rather than refused", async () => {
    const { backend, hermetic } = seeded();
    const row = (await backend.store.agents.get("atlas"))!;
    expect(row.status).toBe("ready");

    // Behind this run's back — another operator, a resumed op — the row is
    // already in `destroying`, and left unlocked. Anything holding a `ready`
    // copy of it is now stale, and the right answer is to adopt reality and
    // carry on, not to refuse.
    await backend.store.agents.update("atlas", row.version, { status: "destroying" });

    const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    expect(events.at(-1)?.progress).toBe(1);
    expect(await backend.store.agents.get("atlas")).toBeNull();

    const history = await backend.store.events.query("atlas");
    // Nothing moved when destroy re-entered `destroying`, so destroy claims no
    // transition into it. (The move behind our back was a bare store write,
    // which appends nothing to the history either — hence none at all, rather
    // than one.)
    expect(history.filter((e) => e.to_status === "destroying").length).toBe(0);
    expect(history.some((e) => e.action === "release")).toBe(true);
  });

  test("destroy waits for the volume to detach before deleting it", async () => {
    const { backend, hermetic } = seeded();
    const volumeId = (await backend.store.agents.get("corvid"))!.resources.volume_id!;
    const instanceId = (await backend.store.agents.get("corvid"))!.resources.instance_id!;

    // A backend whose terminate does *not* detach synchronously — which is what
    // real EC2 does. The volume comes free two describes later.
    backend.compute.terminate = async (id: string) => {
      const inst = backend.instances.get(id);
      if (inst) backend.instances.set(id, { ...inst, state: "shutting-down", public_ip: null });
    };
    let describes = 0;
    backend.compute.describeVolume = async (id: string) => {
      describes += 1;
      if (describes >= 3) {
        // The detach finishes as the instance does (§6.7's release waits on it).
        const inst = backend.instances.get(instanceId);
        if (inst) backend.instances.set(instanceId, { ...inst, state: "terminated" });
        return { volume_id: id, size_gib: 100, state: "available", attachments: [] };
      }
      return {
        volume_id: id,
        size_gib: 100,
        state: "in-use",
        attachments: [{ instance_id: instanceId, state: "attached" }],
      };
    };
    const deletedWhile: string[] = [];
    backend.compute.deleteVolume = async (id: string) => {
      deletedWhile.push(`${id}@${describes}`);
    };

    const events = await drain(hermetic.agents.destroy({ name: "corvid", yes: true }));

    // It did not delete until the third describe reported the volume free.
    expect(deletedWhile).toEqual([`${volumeId}@3`]);
    expect(events.some((e) => e.message.includes(`waiting for ${instanceId} to release`))).toBe(true);
    expect(await backend.store.agents.get("corvid")).toBeNull();
  });
});

/** The same wedge, on the other operation that moves through a transient status. */
/**
 * `waitVolumeReleased` answers `gone` or `free`, and `destroy` used to ignore
 * the difference: it said "deleted data volume vol-X" for a `DeleteVolume` that
 * deleted nothing, about a disk somebody else had already removed. The one
 * sentence an operator reads about their agent's memory has to be true.
 */
describe("--delete-volume says what actually happened to the volume", () => {
  test("a volume that is already gone is reported as gone, not as deleted", async () => {
    const { backend, hermetic } = seeded();
    const before = (await backend.store.agents.get("atlas"))!;
    const volumeId = before.resources.volume_id!;
    // Removed out from under us — an operator with the console open, or an
    // earlier run of this same destroy that died after the delete.
    backend.volumes.delete(volumeId);

    const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    const volume = events.filter((e) => e.phase === "volume").at(-1)!;
    expect(volume.message).toContain(`data volume ${volumeId} is already gone`);
    expect(volume.message).not.toContain("deleted data volume");
    expect(await backend.store.agents.get("atlas")).toBeNull();
  });

  test("a volume that is really there is still reported as deleted", async () => {
    const { backend, hermetic } = seeded();
    const volumeId = (await backend.store.agents.get("atlas"))!.resources.volume_id!;

    const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    expect(events.filter((e) => e.phase === "volume").at(-1)!.message).toContain(
      `deleted data volume ${volumeId}`,
    );
    expect(backend.volumes.has(volumeId)).toBe(false);
  });
});

describe("a stop that failed partway can be run again", () => {
  test("a second stop finishes rather than throwing INVALID_TRANSITION", async () => {
    const { backend, hermetic } = seeded();
    const instanceId = (await backend.store.agents.get("atlas"))!.resources.instance_id!;

    backend.compute.stop = async () => {
      throw new HermeticError("INTERNAL", "StopInstances refused");
    };
    await expect(drain(hermetic.agents.stop("atlas"))).rejects.toThrow(HermeticError);
    expect((await backend.store.agents.get("atlas"))!.status).toBe("stopping");

    backend.compute.stop = async (id: string) => {
      const inst = backend.instances.get(id);
      if (inst) backend.instances.set(id, { ...inst, state: "stopped", public_ip: null });
    };
    await drain(hermetic.agents.stop("atlas"));

    expect((await backend.store.agents.get("atlas"))!.status).toBe("stopped");
    expect(backend.instances.get(instanceId)!.state).toBe("stopped");
  });
});

/**
 * The other direction of staleness: our copy of the row is behind the store, so
 * the version-conditional write is refused. If the store already reached where
 * we were going, that is the same "our picture was stale" story — we take the
 * store's row as our picture, re-lock it in our own name, and carry on. What we
 * do *not* do is write our own pending patch over the row that won, or step over
 * a lock another run still holds.
 */
describe("a store that moved ahead of us mid-transition", () => {
  /**
   * Reproduces the race exactly: between our read and our write, somebody else
   * moves the row to `status`, so our update comes back CONFLICT. Returns what
   * the racer saw, so a test can name the owner our run was holding.
   */
  function raceTo(
    backend: MemoryBackend,
    status: AgentStatus,
    patch: AgentPatch = {},
  ): { owner: string | null } {
    const update = backend.store.agents.update;
    const seen: { owner: string | null } = { owner: null };
    let raced = false;
    backend.store.agents.update = async (name: string, version: number, p: AgentPatch) => {
      if (raced || p.status !== status) return update(name, version, p);
      raced = true;
      const current = (await backend.store.agents.get(name))!;
      seen.owner = current.lock?.owner ?? null;
      await update(name, current.version, { ...patch, status });
      throw new HermeticError("CONFLICT", `agent ${name} changed underneath this operation`, {
        name,
      });
    };
    return seen;
  }

  test("a CONFLICT whose target the store already reached is adopted, and stop finishes", async () => {
    const { backend, hermetic } = seeded();
    const instanceId = (await backend.store.agents.get("atlas"))!.resources.instance_id!;
    raceTo(backend, "stopping", { lock: null });

    await drain(hermetic.agents.stop("atlas"));

    expect((await backend.store.agents.get("atlas"))!.status).toBe("stopped");
    expect(backend.instances.get(instanceId)!.state).toBe("stopped");

    const history = await backend.store.events.query("atlas");
    // The adopting run writes no event of its own: whoever moved the row owns
    // that half of the history. (Here that was a bare store write, which appends
    // nothing — so none at all, rather than one.)
    expect(history.filter((e) => e.to_status === "stopping").length).toBe(0);
    expect(history.filter((e) => e.to_status === "stopped").length).toBe(1);
  });

  test("a row that moves under the release is not deleted, and a retry finishes it", async () => {
    const { backend, hermetic } = seeded();

    // Another writer moves the row between the tombstone and the delete: the
    // delete is conditional on the version this run read (§6.7), so it refuses.
    const append = backend.store.events.appendTombstone;
    let raced = false;
    backend.store.events.appendTombstone = async (t) => {
      await append(t);
      if (raced) return;
      raced = true;
      const current = (await backend.store.agents.get("corvid"))!;
      await backend.store.agents.update("corvid", current.version, { health: null });
    };

    let code: string | null = null;
    try {
      await drain(hermetic.agents.destroy({ name: "corvid", yes: true }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("CONFLICT");
    const stranded = (await backend.store.agents.get("corvid"))!;
    expect(stranded.status).toBe("destroying");
    expect(stranded.lock).toBeNull();
    expect((await backend.store.events.queryTombstones({ name: "corvid" })).length).toBe(1);

    const events = await drain(hermetic.agents.destroy({ name: "corvid", yes: true }));
    expect(events.at(-1)?.progress).toBe(1);
    expect(await backend.store.agents.get("corvid")).toBeNull();
    // The retry reused the first run's tombstone rather than writing a second.
    expect((await backend.store.events.queryTombstones({ name: "corvid" })).length).toBe(1);
  });

  test("adoption keeps this run holding the lock for the rest of the operation", async () => {
    const { backend, hermetic } = seeded();
    // A recreate drains through `stopped` and then does most of its work —
    // minting a key, terminating strays, launching, attaching. All of that has
    // to stay locked, or a second operator walks in behind it (§4.4).
    const raced = raceTo(backend, "stopped", { lock: null });
    const ownersAtLaunch: Array<string | null> = [];
    const runInstance = backend.compute.runInstance;
    backend.compute.runInstance = async (spec) => {
      ownersAtLaunch.push((await backend.store.agents.get("atlas"))!.lock?.owner ?? null);
      return runInstance(spec);
    };

    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));

    expect(raced.owner).not.toBeNull();
    expect(ownersAtLaunch).toEqual([raced.owner]);

    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.status).toBe("bootstrapping");
    // And the op still owns the lock at the end, so releasing it works.
    expect(after.lock).toBeNull();
  });

  test("a re-entry whose version moved is adopted too, not thrown", async () => {
    const { backend, hermetic } = seeded();
    const row = (await backend.store.agents.get("corvid"))!;
    await backend.store.agents.update("corvid", row.version, { status: "destroying" });
    // The row is both already `destroying` *and* moves again between our lock
    // and our re-entering write. A retry of a wedged op must not re-wedge on it.
    raceTo(backend, "destroying");

    await drain(hermetic.agents.destroy({ name: "corvid", yes: true }));

    expect(await backend.store.agents.get("corvid")).toBeNull();
  });

  test("an expired foreign lock is free, so the row is adoptable", async () => {
    const { backend, hermetic } = seeded();
    // The canonical wedge: the run that got there first died, and its TTL lock
    // has since expired. §4.4 already calls that lock free, and adoption uses
    // the same rule rather than a stricter one of its own.
    const expires = new Date(backend.clock.now().getTime() - 60 * 60_000).toISOString();
    raceTo(backend, "stopping", { lock: { owner: "dead-run#x", expires } });

    await drain(hermetic.agents.stop("atlas"));

    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.status).toBe("stopped");
    expect(after.lock).toBeNull();
  });

  test("a live foreign lock is refused, not adopted", async () => {
    const { backend, hermetic } = seeded();
    const instanceId = (await backend.store.agents.get("atlas"))!.resources.instance_id!;
    // Same race, except the row that got there first belongs to an operation
    // still running. Adopting it would be exactly the takeover the TTL lock of
    // §4.4 exists to prevent.
    const expires = new Date(backend.clock.now().getTime() + 60 * 60_000).toISOString();
    raceTo(backend, "stopping", { lock: { owner: "someone-else#x", expires } });

    let code: string | null = null;
    try {
      await drain(hermetic.agents.stop("atlas"));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    // The code is the CONFLICT the store raised: the lock is only consulted once
    // the write has already been refused, so it does not become a LOCKED.
    expect(code).toBe("CONFLICT");

    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.status).toBe("stopping");
    expect(after.lock?.owner).toBe("someone-else#x");
    expect(backend.instances.get(instanceId)!.state).toBe("running");

    const history = await backend.store.events.query("atlas");
    // Nothing was stopped, so nothing claims it was. (The `failed (CONFLICT)`
    // event `unwind` writes is the attempt itself, and belongs there.)
    expect(history.filter((e) => e.to_status === "stopped").length).toBe(0);
    expect(history.some((e) => e.detail === "stop failed (CONFLICT)")).toBe(true);
  });

  /**
   * §4.2: a recreate is a first boot on the same volume, and what it *built* —
   * the instance it launched, the config it uploaded, the previous boot's state
   * it cleared — is true whoever moved the status. Those are `facts`, not the
   * `extra` that describes the world the run is leaving, and a race must not
   * drop them: a row that kept an unacked `command` would have the new box's
   * runner act on it, and one that kept the old `config_hash`/`hermeticd_version`
   * would describe a boot that never happened.
   */
  async function seedPreviousBoot(backend: MemoryBackend, name: string): Promise<void> {
    const row = (await backend.store.agents.get(name))!;
    await backend.store.agents.update(name, row.version, {
      hermeticd_version: "0.4.0",
      config_hash: "0000000000000000",
      command: {
        id: "cmd-old",
        action: "rerun",
        issued_by: "operator@example.com",
        issued_at: "2026-09-01T09:00:00.000Z",
      },
      bootstrap: {
        hermeticd_version: "0.4.0",
        stages: [
          {
            id: "01-tailscale",
            status: "ok",
            attempt: 1,
            started_at: "2026-09-01T09:00:10.000Z",
            ended_at: "2026-09-01T09:00:40.000Z",
          },
          {
            id: "02-data-volume",
            status: "failed",
            attempt: 1,
            started_at: "2026-09-01T09:00:40.000Z",
            ended_at: "2026-09-01T09:00:55.000Z",
            exit_code: 100,
            message: "device /dev/nvme1n1 has an unknown signature",
          },
        ],
        current: null,
        started_at: "2026-09-01T09:00:10.000Z",
        updated_at: "2026-09-01T09:00:55.000Z",
        last_command_id: "cmd-older",
      },
    });
  }

  test("a raced recreate still clears the previous boot's progress and command", async () => {
    const { backend, hermetic } = seeded();
    await seedPreviousBoot(backend, "atlas");
    // Somebody else moves the row to `bootstrapping` first, leaving the previous
    // boot's `bootstrap`/`command` exactly where they were.
    raceTo(backend, "bootstrapping", { lock: null });

    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));

    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.status).toBe("bootstrapping");
    // Otherwise hermeticd's runner reads `cmd-old` as an unacked instruction to
    // this boot, and resumes the previous boot's stages as if they were its own.
    expect(after.command).toBeNull();
    expect(after.bootstrap).toBeNull();
  });

  test("a raced recreate still records the instance and config it just built", async () => {
    const { backend, hermetic } = seeded();
    await seedPreviousBoot(backend, "atlas");
    const launched: string[] = [];
    const runInstance = backend.compute.runInstance;
    backend.compute.runInstance = async (spec) => {
      const instance = await runInstance(spec);
      launched.push(instance.instance_id);
      return instance;
    };
    raceTo(backend, "bootstrapping", { lock: null });

    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));

    const after = (await backend.store.agents.get("atlas"))!;
    expect(launched).toHaveLength(1);
    expect(after.instance_id).toBe(launched[0]!);
    expect(after.resources.instance_id).toBe(launched[0]!);
    // The row names the release this boot was launched on and the config object
    // this run actually uploaded — not the previous boot's.
    expect(after.hermeticd_version).toBe(FIXTURE_HERMETICD_VERSION);
    expect(after.config_hash).not.toBe("0000000000000000");
    expect(after.resources.config_key).toBe(`config/atlas/${after.config_hash}.tgz`);
    expect(backend.objects.has(after.resources.config_key!)).toBe(true);
  });

  test("a stop that wins the drain race leaves no stale health on the row", async () => {
    const { backend, hermetic } = seeded();
    expect((await backend.store.agents.get("atlas"))!.health).not.toBeNull();
    // The racer is a `stop`: it wrote the fields describing the box it left, but
    // `health` is not one of them — only `recreate`, which terminated that box,
    // knows there is nothing left to be healthy. So the board would show a green
    // health for an instance that no longer exists.
    raceTo(backend, "stopped", {
      tailscale_ip: null,
      last_heartbeat: null,
      metrics: null,
      lock: null,
    });
    const healthAtLaunch: unknown[] = [];
    const runInstance = backend.compute.runInstance;
    backend.compute.runInstance = async (spec) => {
      healthAtLaunch.push((await backend.store.agents.get("atlas"))!.health ?? null);
      return runInstance(spec);
    };

    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));

    expect(healthAtLaunch).toEqual([null]);
    expect((await backend.store.agents.get("atlas"))!.health).toBeNull();
  });

  // No call site names the same field in both `extra` and `facts`, so the
  // "facts win on overlap" rule has nothing to pin here beyond the spread order
  // in `transition` itself.

  test("a re-read that fails keeps the CONFLICT rather than reporting the read's error", async () => {
    const { backend, hermetic } = seeded();
    const update = backend.store.agents.update;
    const get = backend.store.agents.get;
    let failNextGet = false;
    let raced = false;
    backend.store.agents.get = async (name: string) => {
      if (!failNextGet) return get(name);
      failNextGet = false;
      throw new HermeticError("INTERNAL", "the table is having a moment", { name });
    };
    backend.store.agents.update = async (name: string, version: number, p: AgentPatch) => {
      if (raced || p.status !== "stopping") return update(name, version, p);
      raced = true;
      const current = (await get(name))!;
      await update(name, current.version, { status: "stopping", lock: null });
      failNextGet = true;
      throw new HermeticError("CONFLICT", `agent ${name} changed underneath this operation`, {
        name,
      });
    };

    let code: string | null = null;
    try {
      await drain(hermetic.agents.stop("atlas"));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    // A transient read failure must not replace the classified error the caller
    // is owed.
    expect(code).toBe("CONFLICT");
  });
});

describe("plan.destroy / apply", () => {
  test("the plan names every step and marks the destructive ones", async () => {
    const { hermetic } = seeded();
    const plan = await hermetic.plan.destroy({ name: "atlas" });
    expect(plan.kind).toBe("destroy");
    expect(plan.target).toBe("atlas");
    expect(plan.steps.map((s) => s.id)).toEqual([
      "terminate",
      "tailnet",
      "secrets",
      "config",
      "volume",
      "release",
    ]);
    // §6.7: the volume goes by default, and the release frees the name.
    expect(plan.steps.find((s) => s.id === "volume")!.destructive).toBe(true);
    expect(plan.steps.find((s) => s.id === "release")!.description).toContain("reusable");
    // §6.7: the tailnet sweep is destructive to a record of the operator's, and
    // the step says out loud that an under-scoped OAuth client skips it.
    const tailnet = plan.steps.find((s) => s.id === "tailnet")!;
    expect(tailnet.destructive).toBe(true);
    expect(tailnet.description).toContain("devices:core");
    expect(plan.warnings.join(" ")).toContain("events are never deleted");
  });

  test("a default plan is destructive and applying it deletes the volume", async () => {
    const { backend, hermetic } = seeded();
    const volumeId = (await backend.store.agents.get("granite"))!.resources.volume_id!;
    const plan = await hermetic.plan.destroy({ name: "granite" });
    expect(plan.steps.find((s) => s.id === "volume")!.destructive).toBe(true);

    await drain(hermetic.apply({ plan, yes: true }));
    expect(backend.volumes.has(volumeId)).toBe(false);
    expect(await backend.store.agents.get("granite")).toBeNull();
  });

  test("applying a keep-volume plan keeps the volume", async () => {
    const { backend, hermetic } = seeded();
    const volumeId = (await backend.store.agents.get("heron"))!.resources.volume_id!;
    const plan = await hermetic.plan.destroy({ name: "heron", keep_volume: true });
    expect(plan.steps.find((s) => s.id === "volume")!.destructive).toBe(false);
    expect(plan.options.keep_volume).toBe(true);
    await drain(hermetic.apply({ plan, yes: true }));
    expect(backend.volumes.has(volumeId)).toBe(true);
    expect(backend.volumes.get(volumeId)!.former_agent).toBe("heron");
  });

  /**
   * A plan is a document: produced, read, confirmed, and only then applied. In
   * that gap a `recreate` can put the agent on a different instance and a
   * different volume — and applying the old plan would then destroy resources
   * the operator was never shown. The `policy` plan has carried its ETag for
   * exactly this reason; these two carry the ids they promised to act on.
   */
  test("a destroy plan whose instance has moved since is refused, and says so", async () => {
    const { backend, hermetic } = seeded();
    const plan = await hermetic.plan.destroy({ name: "granite" });
    const volumeId = (await backend.store.agents.get("granite"))!.resources.volume_id!;
    const instanceId = (await backend.store.agents.get("granite"))!.resources.instance_id!;

    // Recreated in between: same disk, a different box from the one the plan
    // named as the thing it would terminate.
    await drain(hermetic.agents.recreate({ name: "granite", yes: true }));

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.apply({ plan, yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    // `PLAN_STALE`, not `CONFLICT`: a head has to tell a plan the world moved
    // past — which reading the plan again fixes — from a lock race, a volume
    // reservation or a fleet-wide op in flight, which it does not.
    expect(error?.code).toBe("PLAN_STALE");
    // The refusal names what moved rather than asserting that something did.
    expect(error?.message).toContain(`the plan named instance ${instanceId}`);
    expect(error?.details?.["moved"]).toHaveLength(1);
    expect((await backend.store.agents.get("granite"))!.status).not.toBe("destroyed");
    expect(backend.volumes.has(volumeId)).toBe(true);
  });

  test("a destroy plan whose data volume has moved since is refused, naming the volume", async () => {
    const { backend, hermetic } = seeded();
    const plan = await hermetic.plan.destroy({ name: "granite" });
    const row = (await backend.store.agents.get("granite"))!;
    const planned = row.resources.volume_id!;
    // The row now names a different disk — the shape that made this check worth
    // having: `apply` would otherwise delete a volume the plan never mentioned.
    await backend.store.agents.update("granite", row.version, {
      volume_id: "vol-somebodyelses0001",
      resources: { ...row.resources, volume_id: "vol-somebodyelses0001" },
    });

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.apply({ plan, yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("PLAN_STALE");
    expect(error?.message).toContain(`the plan named data volume ${planned}`);
    expect(error?.message).toContain("vol-somebodyelses0001");
    expect(backend.volumes.has(planned)).toBe(true);
  });

  /**
   * The row's `version` is *not* the witness, and this is why: hermeticd bumps
   * it from the box on every `ready → degraded` and back. A flapping agent is
   * exactly the agent an operator is planning to destroy, and refusing their
   * plan with a `PLAN_STALE` that can name nothing that moved would be the check
   * making itself useless.
   */
  test("a version bump with the same instance and volume still applies", async () => {
    const { backend, hermetic } = seeded();
    const plan = await hermetic.plan.destroy({ name: "granite" });
    const volumeId = (await backend.store.agents.get("granite"))!.resources.volume_id!;

    // Two heartbeats' worth of flapping: the row version moves, nothing the
    // plan promised to act on does.
    for (const health of [false, true]) {
      const row = (await backend.store.agents.get("granite"))!;
      await backend.store.agents.update("granite", row.version, {
        status: health ? "ready" : "degraded",
        health: { hermes: health, tailscale: true, disk: true },
      });
    }
    const bumped = (await backend.store.agents.get("granite"))!;
    expect(bumped.version).toBeGreaterThan(plan.options.agent_version!);

    await drain(hermetic.apply({ plan, yes: true }));

    expect(await backend.store.agents.get("granite")).toBeNull();
    expect(backend.volumes.has(volumeId)).toBe(false);
  });

  /**
   * The narrow window the plan check alone cannot close: it reads the row,
   * compares, and returns, and `destroy` then takes the lock. A `recreate`
   * landing between the two swaps `instance_id`, and the destroy terminates a
   * box the reviewed plan never named (§6.7). So the comparison is made a
   * second time with the lock held, which is the first moment the answer cannot
   * go stale between the asking and the acting.
   */
  test("an instance that moves between the plan check and the lock is refused", async () => {
    const { backend, hermetic } = seeded();
    const plan = await hermetic.plan.destroy({ name: "granite" });
    const planned = (await backend.store.agents.get("granite"))!.resources.instance_id!;

    // The rival lands in the gap, exactly: the write goes in as this destroy is
    // taking its lock, and the lock is then taken over the moved row — which is
    // what makes the plan's check, already passed, a statement about a world
    // that no longer exists.
    const update = backend.store.agents.update;
    let raced = false;
    backend.store.agents.update = async (name, version, patch) => {
      if (raced || name !== "granite" || !patch.lock) return update(name, version, patch);
      raced = true;
      const current = (await backend.store.agents.get(name))!;
      await update(name, current.version, {
        instance_id: "i-recreated0000001",
        resources: { ...current.resources, instance_id: "i-recreated0000001" },
      });
      const moved = (await backend.store.agents.get(name))!;
      return update(name, moved.version, patch);
    };
    backend.resetMutations();

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.apply({ plan, yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }

    expect(error?.code).toBe("PLAN_STALE");
    expect(error?.message).toContain(`the plan named instance ${planned}`);
    expect(error?.message).toContain("i-recreated0000001");
    expect(error?.message).toContain("nothing was destroyed");
    // Nothing was terminated, the row never left its status, and the lock is
    // back — a stale plan must not cost the next operator ten minutes.
    expect(backend.mutations).not.toContain("compute.terminate");
    const after = (await backend.store.agents.get("granite"))!;
    expect(after.status).not.toBe("destroying");
    expect(after.status).not.toBe("destroyed");
    expect(after.lock).toBeNull();
  });

  test("a direct destroy carries no plan, so nothing is revalidated", async () => {
    const { backend, hermetic } = seeded();
    // The CLI's `agent destroy --yes` path: no document to be stale, and the
    // row's ids are whatever they are.
    await drain(hermetic.agents.destroy({ name: "granite", yes: true }));
    expect(await backend.store.agents.get("granite")).toBeNull();
  });

  test("a recreate plan whose instance has moved since is refused too", async () => {
    const { backend, hermetic } = seeded();
    const plan = await hermetic.plan.recreate({ name: "granite" });
    await drain(hermetic.agents.recreate({ name: "granite", yes: true }));
    backend.resetMutations();

    let code: string | null = null;
    try {
      await drain(hermetic.apply({ plan, yes: true }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("PLAN_STALE");
    expect(backend.mutations).not.toContain("compute.runInstance");
  });

  /**
   * §6.7 frees a destroyed name, so the ids are not an identity: a `creating`
   * row has no instance and no volume yet, and neither does the next, unrelated
   * `creating` row that claims the same name once the first is gone. Only the
   * row's `created_at` tells the two incarnations apart.
   */
  function incarnate(backend: MemoryBackend, name: string, createdAt: string): void {
    const row = backend.agents.get(name)!;
    const { instance_id: _i, volume_id: _v, ...resources } = row.resources;
    backend.agents.set(name, {
      ...row,
      status: "creating",
      instance_id: null,
      volume_id: null,
      resources,
      lock: null,
      version: 1,
      created_at: createdAt,
      updated_at: createdAt,
    });
  }

  test("a destroy plan for an earlier incarnation of the name is refused", async () => {
    const { backend, hermetic } = seeded();
    incarnate(backend, "granite", "2026-01-01T00:00:00.000Z");
    const plan = await hermetic.plan.destroy({ name: "granite" });
    expect(plan.options.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(plan.options.instance_id).toBeNull();
    expect(plan.options.volume_id).toBeNull();

    // Destroyed and claimed again in between: same name, same null ids, a
    // different agent that nobody reviewed a plan for.
    incarnate(backend, "granite", "2026-02-01T00:00:00.000Z");
    backend.resetMutations();

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.apply({ plan, yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("PLAN_STALE");
    expect(error?.message).toContain("created at 2026-01-01T00:00:00.000Z");
    expect(error?.message).toContain("2026-02-01T00:00:00.000Z");
    expect(error?.details?.["observed_created_at"]).toBe("2026-02-01T00:00:00.000Z");
    // Refused by the plan check, before the lock: the row was never written.
    expect(error?.message).not.toContain("nothing was destroyed");
    expect(backend.mutations).not.toContain("store.agents.update");
    const after = (await backend.store.agents.get("granite"))!;
    expect(after.created_at).toBe("2026-02-01T00:00:00.000Z");
    expect(after.status).toBe("creating");
    expect(backend.mutations).not.toContain("store.agents.delete");
  });

  test("a new incarnation that lands between the plan check and the lock is refused", async () => {
    const { backend, hermetic } = seeded();
    incarnate(backend, "granite", "2026-01-01T00:00:00.000Z");
    const plan = await hermetic.plan.destroy({ name: "granite" });

    // The same gap the instance race above uses: the name is released and
    // claimed again as this destroy is taking its lock.
    const update = backend.store.agents.update;
    let raced = false;
    backend.store.agents.update = async (name, version, patch) => {
      if (raced || name !== "granite" || !patch.lock) return update(name, version, patch);
      raced = true;
      incarnate(backend, "granite", "2026-02-01T00:00:00.000Z");
      return update(name, 1, patch);
    };
    backend.resetMutations();

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.apply({ plan, yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("PLAN_STALE");
    expect(error?.message).toContain("nothing was destroyed");
    expect(error?.message).toContain("2026-02-01T00:00:00.000Z");
    const after = (await backend.store.agents.get("granite"))!;
    expect(after.created_at).toBe("2026-02-01T00:00:00.000Z");
    expect(after.status).toBe("creating");
    expect(after.lock).toBeNull();
    expect(backend.mutations).not.toContain("store.agents.delete");
  });

  test("a destroy plan that does not say created_at is refused as stale, deleting nothing", async () => {
    const { backend, hermetic } = seeded();
    const plan = await hermetic.plan.destroy({ name: "granite" });
    const { created_at: _dropped, ...older } = plan.options;
    backend.resetMutations();

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.apply({ plan: { ...plan, options: older }, yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("PLAN_STALE");
    expect(error?.message).toContain("predates the current build");
    expect(error?.message).toContain("hermetic plan destroy granite");
    expect(backend.mutations).not.toContain("compute.terminate");
    expect(await backend.store.agents.get("granite")).not.toBeNull();
  });

  /**
   * §6.7 flipped the volume default. A plan file from the build before it
   * carries `delete_volume: false` — "keep" — which the schema now drops; read
   * as "no keep_volume" it would delete the disk the reviewed plan kept.
   */
  test("a destroy plan that does not say keep_volume is refused as stale, deleting nothing", async () => {
    const { backend, hermetic } = seeded();
    const volumeId = (await backend.store.agents.get("granite"))!.resources.volume_id!;
    const plan = await hermetic.plan.destroy({ name: "granite" });
    expect(plan.options.keep_volume).toBe(false);
    const { keep_volume: _dropped, ...older } = plan.options;
    backend.resetMutations();

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.apply({ plan: { ...plan, options: older }, yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("PLAN_STALE");
    expect(error?.message).toContain("hermetic plan destroy granite");
    expect(backend.volumes.has(volumeId)).toBe(true);
    expect(backend.mutations).not.toContain("compute.terminate");
    expect(backend.mutations).not.toContain("compute.deleteVolume");
    expect(await backend.store.agents.get("granite")).not.toBeNull();
  });

  test("a plan from an older build says so rather than failing obscurely", async () => {
    const { hermetic } = seeded();
    const plan = await hermetic.plan.destroy({ name: "granite" });
    const stripped = { ...plan, options: { keep_volume: true } };

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.apply({ plan: stripped, yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("VALIDATION");
    expect(error?.message).toContain("predates the current build");
    expect(error?.message).toContain("hermetic plan destroy granite");
  });

  /**
   * §8.3: a profile-bound agent accumulates slots. Every rotation binds it to a
   * new `provider-key-<profile_id>-r<N>` and the older ones are deliberately **never**
   * deleted — an agent rolled back to a previous binding has to still find the
   * credential that binding ran on — so the only thing that ever cleans them up
   * is the destroy, which takes the whole agent prefix rather than the one slot
   * the row happens to name. A sweep that deleted `credential_ref` alone would
   * leave a copy of the operator's key in SSM for every rotation the agent ever
   * saw, on a row that no longer exists to explain them.
   */
  test("the sweep takes every revision of the agent's key slot, not just the current one", async () => {
    const { backend, hermetic } = seeded();
    const slot = (name: string, s: string) => agentParamPath(FIXTURE_CONFIG.fleet_id, name, s);
    // `corvid` is bound to `openrouter-cheap` at r1; these are the slots two
    // earlier bindings of the same agent would have left behind.
    for (const revision of [2, 3]) {
      backend.params.set(
        slot("corvid", `provider-key-${FIXTURE_PROFILE_IDS.openrouter}-r${revision}`),
        "sk-FIXTURE-ROTATED",
      );
    }
    expect((await backend.store.agents.get("corvid"))!.credential_ref).toBe(
      `provider-key-${FIXTURE_PROFILE_IDS.openrouter}-r1`,
    );

    const plan = await hermetic.plan.destroy({ name: "corvid" });
    expect(plan.steps.find((s) => s.id === "secrets")!.description).toContain(
      `${agentParamPrefix(FIXTURE_CONFIG.fleet_id)}corvid/`,
    );

    await drain(hermetic.apply({ plan, yes: true }));

    expect(await backend.secrets.list(`${agentParamPrefix(FIXTURE_CONFIG.fleet_id)}corvid/`)).toEqual(
      [],
    );
    for (const revision of [1, 2, 3]) {
      expect(
        backend.params.has(
          slot("corvid", `provider-key-${FIXTURE_PROFILE_IDS.openrouter}-r${revision}`),
        ),
      ).toBe(false);
    }
  });

  /**
   * And the boundary the sweep must not cross. The profile's own slot is the
   * fleet's, not the agent's — it is what every *other* agent on that profile
   * was snapshotted from, and what the next rotation writes — so a destroy that
   * reached it would take the fleet's credential away because one box was
   * deleted.
   */
  test("the shared profile slot is not the agent's, and the sweep leaves it alone", async () => {
    const { backend, hermetic } = seeded();
    const shared = sharedSecretPath(
      FIXTURE_CONFIG.fleet_id,
      profileSlotSlug(FIXTURE_PROFILE_IDS.openrouter),
    );
    expect(backend.params.has(shared)).toBe(true);
    // A second agent on the same profile, to say what "shared" means here.
    const alsoBound = agentParamPath(
      FIXTURE_CONFIG.fleet_id,
      "granite",
      `provider-key-${FIXTURE_PROFILE_IDS.openrouter}-r1`,
    );
    backend.params.set(alsoBound, "sk-FIXTURE-ROTATED");

    await drain(hermetic.apply({ plan: await hermetic.plan.destroy({ name: "corvid" }), yes: true }));

    expect(backend.params.has(shared)).toBe(true);
    expect(backend.params.has(alsoBound)).toBe(true);
    // Nor any other fleet-level slot: `/hermetic/…` is a different root (§8.2).
    expect(
      [...backend.params.keys()].some((p) =>
        p.startsWith(`/hermetic/${FIXTURE_CONFIG.fleet_id}/secrets/`),
      ),
    ).toBe(true);
  });

  test("an unchanged plan still applies", async () => {
    const { backend, hermetic } = seeded();
    const plan = await hermetic.plan.destroy({ name: "granite" });
    const volumeId = (await backend.store.agents.get("granite"))!.resources.volume_id!;

    await drain(hermetic.apply({ plan, yes: true }));

    expect(await backend.store.agents.get("granite")).toBeNull();
    expect(backend.volumes.has(volumeId)).toBe(false);
  });

  /**
   * §4.8. A plan is produced at one moment and applied at another, and a home
   * may hold several fleets — so the fleet it was made for travels with it.
   */
  test("the plan says which fleet it is for, and applying it there works", async () => {
    const { backend, hermetic } = seeded();
    const plan = await hermetic.plan.destroy({ name: "granite" });
    expect(plan.summary?.fleet_id).toBe(FIXTURE_CONFIG.fleet_id);
    expect(plan.summary?.account_id).toBe(FIXTURE_CONFIG.account_id);

    await drain(hermetic.apply({ plan, yes: true }));
    expect(await backend.store.agents.get("granite")).toBeNull();
  });

  test("a plan made for another fleet is refused before anything is touched", async () => {
    const { backend, hermetic } = seeded();
    const plan = await hermetic.plan.destroy({ name: "granite" });
    const volumeId = (await backend.store.agents.get("granite"))!.resources.volume_id!;
    // The same plan document, made on the other fleet this laptop holds.
    const elsewhere = {
      ...plan,
      summary: { ...plan.summary!, fleet_id: "sg7k2m4p" },
    };
    backend.resetMutations();

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.apply({ plan: elsewhere, yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("FLEET_MISMATCH");
    expect(error?.message).toContain("sg7k2m4p");
    // The refusal names the fleet the command is actually running against, so
    // the operator can see which way round the mistake is — by id first (§4.6),
    // with the display alias as the parenthetical.
    expect(error?.message).toContain(`${FIXTURE_CONFIG.fleet_id} ("${FIXTURE_CONFIG.name}")`);
    // Before any kind-specific work: nothing was terminated, deleted or written.
    expect(backend.mutations).toEqual([]);
    expect(backend.volumes.has(volumeId)).toBe(true);
    expect((await backend.store.agents.get("granite"))!.status).not.toBe("destroyed");
  });
});

describe("teardown", () => {
  test("refuses without --yes", async () => {
    const { hermetic } = seeded();
    let code: string | null = null;
    try {
      await drain(hermetic.teardown({ yes: false }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("CONFIRMATION_REQUIRED");
  });

  test("refuses while agents exist", async () => {
    const { backend, hermetic } = seeded();
    let code: string | null = null;
    try {
      await drain(hermetic.teardown({ yes: true }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("AGENTS_EXIST");
    expect(backend.stack).not.toBeNull();
  });

  test("deletes the stack once every agent is destroyed", async () => {
    const { backend, hermetic } = seeded();
    for (const name of [...backend.agents.keys()]) {
      await drain(hermetic.agents.destroy({ name, yes: true }));
    }
    const plan = await hermetic.plan.teardown();
    expect(plan.warnings.some((w) => w.includes("still exist"))).toBe(false);

    await drain(hermetic.teardown({ yes: true }));
    expect(backend.stack).toBeNull();
  });
});
