import { describe, expect, test } from "bun:test";
import { HermeticError } from "../src/errors.ts";
import {
  FIXTURE_CONFIG,
  MemoryBackend,
  seedFixtureFleet,
  seedFixtureVolumes,
} from "../src/backend/memory.ts";
import { drain, testHermetic } from "./helpers.ts";

/**
 * The seeded fleet plus the three shapes no agent row can produce: a volume
 * whose row is gone, one hermetic did not create, and an ambiguous pair.
 */
function seeded() {
  const backend = seedFixtureVolumes(seedFixtureFleet(new MemoryBackend()));
  return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG }) };
}

/** The destroyed fixture agent's kept data volume — the reclaimable case (§6.6). */
const ORIOLE = "vol-fixture00000000012";
/** A volume whose agent row is gone entirely, not merely destroyed. */
const NO_ROW = "vol-fixture0000000dorado";
const STRAY = "vol-fixture00000000stray";
const GROVE_A = "vol-fixture000000grovea";
const GROVE_B = "vol-fixture000000groveb";
/** `atlas` is running, so its volume is attached. */
const ATTACHED = "vol-fixture00000000001";
/** `juniper` is stopped: free, but a live row still owns it. */
const OWNED = "vol-fixture00000000008";

async function groupOf(volumeId: string): Promise<string> {
  const { hermetic } = seeded();
  const { volumes } = await hermetic.volumes.list({});
  return volumes.find((v) => v.volume_id === volumeId)?.group ?? "(missing)";
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "(no error)";
  } catch (e) {
    return (e as HermeticError).code;
  }
}

describe("volumes.list groups by who is reading a volume", () => {
  test("attached: an instance has it", async () => {
    expect(await groupOf(ATTACHED)).toBe("attached");
  });

  test("detached: free, but a live agent row still owns it", async () => {
    expect(await groupOf(OWNED)).toBe("detached");
  });

  test("no_agent: the row is destroyed, so nothing is reading it", async () => {
    expect(await groupOf(ORIOLE)).toBe("no_agent");
  });

  test("no_agent: the row is gone entirely", async () => {
    expect(await groupOf(NO_ROW)).toBe("no_agent");
  });

  test("unmanaged: hermetic did not create it", async () => {
    expect(await groupOf(STRAY)).toBe("unmanaged");
  });

  test("ambiguous: two volumes, one agent tag, no role=data on either", async () => {
    expect(await groupOf(GROVE_A)).toBe("ambiguous");
    expect(await groupOf(GROVE_B)).toBe("ambiguous");
  });

  test("each ambiguous volume names its twin, so neither reads as the answer", async () => {
    const { hermetic } = seeded();
    const { volumes } = await hermetic.volumes.list({});
    const a = volumes.find((v) => v.volume_id === GROVE_A)!;
    expect(a.ambiguous_with).toEqual([GROVE_B]);
  });

  test("a role=data tag settles the pair, and the other becomes a plain volume", async () => {
    const { backend, hermetic } = seeded();
    const b = backend.volumes.get(GROVE_B)!;
    backend.volumes.set(GROVE_B, { ...b, role: "data" });
    const { volumes } = await hermetic.volumes.list({});
    expect(volumes.find((v) => v.volume_id === GROVE_B)?.group).toBe("no_agent");
    // The unlabelled one is still hermetic's, and still has no agent reading it;
    // it is simply no longer competing to *be* grove's memory.
    expect(volumes.find((v) => v.volume_id === GROVE_A)?.group).toBe("no_agent");
  });

  test("ambiguity beats attachment: an attached pair is still not identifiable", async () => {
    const { backend, hermetic } = seeded();
    const a = backend.volumes.get(GROVE_A)!;
    backend.volumes.set(GROVE_A, { ...a, state: "in-use", attached_to: "i-somebox" });
    const { volumes } = await hermetic.volumes.list({});
    expect(volumes.find((v) => v.volume_id === GROVE_A)?.group).toBe("ambiguous");
  });

  test("in-use with no attachment record still reads as attached", async () => {
    const { backend, hermetic } = seeded();
    const v = backend.volumes.get(NO_ROW)!;
    backend.volumes.set(NO_ROW, { ...v, state: "in-use" });
    const { volumes } = await hermetic.volumes.list({});
    const found = volumes.find((x) => x.volume_id === NO_ROW)!;
    expect(found.attached).toBe(true);
    expect(found.group).toBe("attached");
  });
});

describe("volumes.list summary", () => {
  test("counts and costs the whole account, not the filtered rows", async () => {
    const { hermetic } = seeded();
    const all = await hermetic.volumes.list({});
    const filtered = await hermetic.volumes.list({ unattached: true });
    expect(filtered.volumes.length).toBeLessThan(all.volumes.length);
    // The headline is what the account holds; a filter that also shrank it
    // would hide exactly what the view exists to show.
    expect(filtered.summary).toEqual(all.summary);
    expect(filtered.volumes.every((v) => !v.attached)).toBe(true);
  });

  test("unattached cost is gp3 list price over the unattached GiB", async () => {
    const { hermetic } = seeded();
    const { volumes, summary } = await hermetic.volumes.list({});
    const gib = volumes.filter((v) => !v.attached).reduce((n, v) => n + v.size_gib, 0);
    expect(summary.unattached_gib).toBe(gib);
    expect(summary.unattached_monthly_cost_usd).toBeCloseTo(gib * 0.08, 2);
  });

  test("a read makes no mutating call", async () => {
    const { backend, hermetic } = seeded();
    await hermetic.volumes.list({});
    await hermetic.volumes.get({ volume_id: ORIOLE });
    expect(backend.mutations).toEqual([]);
  });
});

describe("volumes.get", () => {
  test("carries the tags and the snapshots", async () => {
    const { hermetic } = seeded();
    const detail = await hermetic.volumes.get({ volume_id: ORIOLE });
    expect(detail.tags["agent"]).toBe("oriole");
    expect(detail.tags["hermetic:managed"]).toBe("true");
    expect(detail.snapshot_list.length).toBe(detail.snapshots);
  });

  test("an unknown id is NOT_FOUND, not an empty answer", async () => {
    const { hermetic } = seeded();
    expect(await codeOf(hermetic.volumes.get({ volume_id: "vol-000000000000000" }))).toBe("NOT_FOUND");
  });
});

describe("volumes.delete", () => {
  test("deletes a volume no agent is reading, and keeps its snapshots", async () => {
    const { backend, hermetic } = seeded();
    const before = backend.snapshots.size;
    const result = await hermetic.volumes.delete({ volume_id: NO_ROW, yes: true });
    expect(result.size_gib).toBe(500);
    expect(result.monthly_saving_usd).toBeCloseTo(40, 2);
    expect(backend.volumes.has(NO_ROW)).toBe(false);
    expect(backend.snapshots.size).toBe(before);
    expect(result.snapshots_kept).toBeGreaterThan(0);
  });

  test("refuses without an explicit yes, and touches nothing", async () => {
    const { backend, hermetic } = seeded();
    expect(await codeOf(hermetic.volumes.delete({ volume_id: NO_ROW, yes: false }))).toBe(
      "CONFIRMATION_REQUIRED",
    );
    expect(backend.mutations).toEqual([]);
    expect(backend.volumes.has(NO_ROW)).toBe(true);
  });

  test("refuses an attached volume", async () => {
    const { backend, hermetic } = seeded();
    expect(await codeOf(hermetic.volumes.delete({ volume_id: ATTACHED, yes: true }))).toBe(
      "VOLUME_IN_USE",
    );
    expect(backend.volumes.has(ATTACHED)).toBe(true);
  });

  test("refuses a volume a live agent row still owns", async () => {
    const { hermetic } = seeded();
    expect(await codeOf(hermetic.volumes.delete({ volume_id: OWNED, yes: true }))).toBe("CONFLICT");
  });

  test("refuses an ambiguous volume rather than guessing", async () => {
    const { hermetic } = seeded();
    expect(await codeOf(hermetic.volumes.delete({ volume_id: GROVE_A, yes: true }))).toBe("CONFLICT");
  });

  test("refuses a volume hermetic did not create", async () => {
    const { backend, hermetic } = seeded();
    expect(await codeOf(hermetic.volumes.delete({ volume_id: STRAY, yes: true }))).toBe(
      "VOLUME_UNUSABLE",
    );
    expect(backend.volumes.has(STRAY)).toBe(true);
  });

  /**
   * The four refusals were decided from one snapshot of EC2 *and* DynamoDB, and
   * the interesting moment is the one after it: `DeleteVolume` is irreversible
   * and a snapshot is not the volume, so the last thing `delete` does before
   * deleting is look again (§4.5).
   */
  test("a volume something claims between the check and the delete is not deleted", async () => {
    const { backend, hermetic } = seeded();
    const scan = backend.store.agents.scan;
    let reads = 0;
    backend.store.agents.scan = async () => {
      // The second read is the one taken immediately before `DeleteVolume`; by
      // then a live row owns this disk.
      if (++reads === 2) {
        const rival = (await backend.store.agents.get("juniper"))!;
        await backend.store.agents.update("juniper", rival.version, {
          volume_id: ORIOLE,
          resources: { ...rival.resources, volume_id: ORIOLE },
        });
      }
      return scan();
    };

    let error: HermeticError | null = null;
    try {
      await hermetic.volumes.delete({ volume_id: ORIOLE, yes: true });
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("CONFLICT");
    expect(backend.volumes.has(ORIOLE)).toBe(true);
    expect(backend.mutations).not.toContain("compute.deleteVolume");
  });

  /**
   * The narrower half of the same second look: nothing about the new state
   * forbids the delete, but the volume is not in the state the operator was
   * shown. The refusal has to be actionable — it says which way it moved and,
   * here, that asking again will work.
   */
  test("a volume that moved between the reads is refused with a next step", async () => {
    const { backend, hermetic } = seeded();
    // First read: `in-use` with no attachment record, which reads as attached
    // (§9.1) and is the one shape that gets past the four refusals.
    const before = backend.volumes.get(ORIOLE)!;
    backend.volumes.set(ORIOLE, { ...before, state: "in-use" });
    const listVolumes = backend.compute.listVolumes;
    let reads = 0;
    backend.compute.listVolumes = async () => {
      if (++reads === 2) backend.volumes.set(ORIOLE, { ...before, state: "available" });
      return listVolumes();
    };

    let error: HermeticError | null = null;
    try {
      await hermetic.volumes.delete({ volume_id: ORIOLE, yes: true });
    } catch (e) {
      error = e as HermeticError;
    }

    expect(error?.code).toBe("CONFLICT");
    expect(error?.message).toContain("attached → no_agent");
    expect(error?.message).toContain("nothing was deleted");
    expect(error?.message).toContain("will go through");
    expect(error?.details?.["retryable"]).toBe(true);
    expect(backend.volumes.has(ORIOLE)).toBe(true);
    expect(backend.mutations).not.toContain("compute.deleteVolume");
  });

  test("a volume something attaches between the check and the delete is not deleted", async () => {
    const { backend, hermetic } = seeded();
    const listVolumes = backend.compute.listVolumes;
    let reads = 0;
    backend.compute.listVolumes = async () => {
      if (++reads === 2) {
        const v = backend.volumes.get(ORIOLE)!;
        backend.volumes.set(ORIOLE, { ...v, state: "in-use", attached_to: "i-somebox" });
      }
      return listVolumes();
    };

    expect(await codeOf(hermetic.volumes.delete({ volume_id: ORIOLE, yes: true }))).toBe(
      "VOLUME_IN_USE",
    );
    expect(backend.volumes.has(ORIOLE)).toBe(true);
    expect(backend.mutations).not.toContain("compute.deleteVolume");
  });

  test("the destroyed agent's kept volume is the one it does accept", async () => {
    const { backend, hermetic } = seeded();
    await hermetic.volumes.delete({ volume_id: ORIOLE, yes: true });
    expect(backend.volumes.has(ORIOLE)).toBe(false);
    // The row itself is untouched: events survive, and so does the record (§4.3).
    expect((await backend.store.agents.get("oriole"))?.status).toBe("destroyed");
  });
});

describe("agents.create --volume", () => {
  test("adopts the volume instead of creating one, and rewrites its agent tag", async () => {
    const { backend, hermetic } = seeded();
    const events = await drain(hermetic.agents.create({ name: "cinder-2", volume_id: ORIOLE }));

    expect(backend.mutations).not.toContain("compute.createVolume");
    expect(backend.mutations).toContain("compute.retagVolume");
    expect(events.find((e) => e.phase === "volume")?.message).toContain("adopted");
    expect(backend.volumes.get(ORIOLE)?.agent).toBe("cinder-2");

    const row = (await backend.store.agents.get("cinder-2"))!;
    expect(row.resources.volume_id).toBe(ORIOLE);
    // The row records the volume as it is, not the fleet default.
    expect(row.volume_gib).toBe(100);
  });

  test("the rewrite is recorded on the new agent's history", async () => {
    const { backend, hermetic } = seeded();
    await drain(hermetic.agents.create({ name: "cinder-2", volume_id: ORIOLE }));
    const events = await backend.store.events.query("cinder-2");
    const adopted = events.find((e) => e.action === "volume");
    expect(adopted?.detail).toContain("agent=oriole");
    expect(adopted?.detail).toContain("agent=cinder-2");
  });

  test("no rewrite when the name already matches the tag", async () => {
    const { backend, hermetic } = seeded();
    // `dorado`'s row is gone, so its own name is free again.
    await drain(hermetic.agents.create({ name: "dorado", volume_id: NO_ROW }));
    expect(backend.mutations).not.toContain("compute.retagVolume");
    expect(backend.mutations).not.toContain("compute.createVolume");
  });

  test("refuses an unknown volume before it claims the name", async () => {
    const { backend, hermetic } = seeded();
    expect(
      await codeOf(drain(hermetic.agents.create({ name: "ghost", volume_id: "vol-000000000000000" }))),
    ).toBe("NOT_FOUND");
    expect(await backend.store.agents.get("ghost")).toBeNull();
    expect(backend.mutations).toEqual([]);
  });

  test("refuses an attached volume", async () => {
    const { hermetic } = seeded();
    expect(await codeOf(drain(hermetic.agents.create({ name: "thief", volume_id: ATTACHED })))).toBe(
      "VOLUME_IN_USE",
    );
  });

  test("refuses a volume a live agent row still owns", async () => {
    const { hermetic } = seeded();
    expect(await codeOf(drain(hermetic.agents.create({ name: "thief", volume_id: OWNED })))).toBe(
      "CONFLICT",
    );
  });

  test("refuses an ambiguous volume", async () => {
    const { hermetic } = seeded();
    expect(await codeOf(drain(hermetic.agents.create({ name: "grove-2", volume_id: GROVE_A })))).toBe(
      "CONFLICT",
    );
  });

  test("refuses a volume hermetic did not create", async () => {
    const { hermetic } = seeded();
    expect(await codeOf(drain(hermetic.agents.create({ name: "borrower", volume_id: STRAY })))).toBe(
      "VOLUME_UNUSABLE",
    );
  });

  test("refuses a volume in another availability zone, before RunInstances", async () => {
    const { backend, hermetic } = seeded();
    const v = backend.volumes.get(NO_ROW)!;
    backend.volumes.set(NO_ROW, { ...v, az: "us-west-2c" });
    expect(await codeOf(drain(hermetic.agents.create({ name: "elsewhere", volume_id: NO_ROW })))).toBe(
      "VOLUME_UNUSABLE",
    );
    expect(backend.mutations).not.toContain("compute.runInstance");
  });

  test("a destroyed agent's name is still taken, whatever its volume says", async () => {
    const { hermetic } = seeded();
    // §4.3: `destroyed` is terminal and the row is kept forever, so reclaiming
    // oriole's memory means giving the new agent a different name.
    expect(await codeOf(drain(hermetic.agents.create({ name: "oriole", volume_id: ORIOLE })))).toBe(
      "NAME_TAKEN",
    );
  });

  /**
   * The tag rewrite is the other thing adoption changes, and until the ledger
   * recorded it, `--rollback-on-failure` left it behind: `vol-X` tagged for an
   * agent that no longer exists, waiting to be silently inherited by the next
   * create under that name (§1).
   */
  test("a rollback puts an adopted volume's agent tag back", async () => {
    const { backend, hermetic } = seeded();
    expect(backend.volumes.get(ORIOLE)?.agent).toBe("oriole");
    backend.compute.runInstance = async () => {
      throw new HermeticError("INTERNAL", "RunInstances exploded");
    };

    await codeOf(
      drain(hermetic.agents.create({ name: "cinder-2", volume_id: ORIOLE, rollback_on_failure: true })),
    );

    expect(backend.volumes.get(ORIOLE)?.agent).toBe("oriole");
    expect(backend.volumes.has(ORIOLE)).toBe(true);
    // And the row is gone, so nothing at all is left claiming oriole's memory.
    expect(await backend.store.agents.get("cinder-2")).toBeNull();
  });

  /**
   * The re-run case, which the first version of the ledger missed entirely: an
   * attempt that retagged `vol-X` from `oriole` to `cinder-2` and then died
   * leaves the tag already naming this agent, so the second attempt has no
   * rewrite to make — and recorded nothing to undo. Its
   * `--rollback-on-failure` then deleted the row and left `vol-X` tagged for a
   * `cinder-2` that does not exist, which is the exact trap the entry exists to
   * prevent: the next plain `create cinder-2` finds it by tag and silently
   * attaches oriole's memory (§1).
   */
  test("a re-run rolls back a retag its own earlier attempt made", async () => {
    const { backend, hermetic } = seeded();

    // Attempt one: adopts oriole's volume, retags it, and dies at the launch.
    backend.compute.runInstance = async () => {
      throw new HermeticError("INTERNAL", "RunInstances exploded");
    };
    await codeOf(drain(hermetic.agents.create({ name: "cinder-2", volume_id: ORIOLE })));
    expect(backend.volumes.get(ORIOLE)?.agent).toBe("cinder-2");
    // Nothing rolled back, and the row is left for a re-run (§4.5).
    expect(await backend.store.agents.get("cinder-2")).not.toBeNull();
    // The re-run below claims the name afresh, which is the shape that makes
    // the leftover tag debris rather than this run's own bookkeeping.
    await backend.store.agents.delete("cinder-2");

    // Attempt two, with the flag, fails the same way.
    await codeOf(
      drain(hermetic.agents.create({ name: "cinder-2", volume_id: ORIOLE, rollback_on_failure: true })),
    );

    // Given back to the row that still names the disk — a destroyed row is kept
    // forever and goes on naming its volume (§4.3), so this is a fact rather
    // than a guess.
    expect(backend.volumes.get(ORIOLE)?.agent).toBe("oriole");
    expect(backend.volumes.has(ORIOLE)).toBe(true);
    expect(await backend.store.agents.get("cinder-2")).toBeNull();
  });

  /**
   * And the other side of that rule: when *no* row names the disk, the tag was
   * already like that when this run arrived — an operator's own label, say —
   * and a rollback that stripped it would be undoing something it never did.
   */
  test("a tag no row accounts for is left exactly as it was found", async () => {
    const { backend, hermetic } = seeded();
    // `dorado`'s row is gone entirely, so its volume's tag belongs to nobody.
    expect(backend.volumes.get(NO_ROW)?.agent).toBe("dorado");
    backend.compute.runInstance = async () => {
      throw new HermeticError("INTERNAL", "RunInstances exploded");
    };

    await codeOf(
      drain(hermetic.agents.create({ name: "dorado", volume_id: NO_ROW, rollback_on_failure: true })),
    );

    expect(backend.volumes.get(NO_ROW)?.agent).toBe("dorado");
    expect(backend.mutations).not.toContain("compute.retagVolume");
  });

  /**
   * Two creates racing for one disk. `resolveAdopted` runs before either owns a
   * row, so both can pass it; the second look under the lock is what turns the
   * loser into a refusal that has minted nothing and launched nothing.
   */
  test("a row that claims the volume between the check and the lock refuses the create", async () => {
    const { backend, hermetic } = seeded();
    const claimed = backend.store.agents.putIfAbsent;
    backend.store.agents.putIfAbsent = async (agent) => {
      // The competitor lands in the gap: it claims oriole's volume for itself
      // after our refusals were decided and before our row exists.
      const rival = (await backend.store.agents.get("juniper"))!;
      await backend.store.agents.update("juniper", rival.version, {
        volume_id: ORIOLE,
        resources: { ...rival.resources, volume_id: ORIOLE },
      });
      return claimed(agent);
    };
    backend.resetMutations();

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "cinder-2", volume_id: ORIOLE }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("CONFLICT");
    // Nothing was minted and nothing was launched — but the row *was* claimed
    // and is deliberately kept (§4.5), so the message says that rather than
    // implying the name is free again.
    expect(error?.message).toContain("no key was minted and no instance launched");
    expect(error?.message).toContain("left in `creating` for a re-run");
    expect((await backend.store.agents.get("cinder-2"))?.status).toBe("creating");
    expect(backend.mutations).not.toContain("compute.runInstance");
    expect(backend.mutations).not.toContain("compute.retagVolume");
    expect(backend.mutations).not.toContain("secrets.put");
    expect(backend.volumes.get(ORIOLE)?.agent).toBe("oriole");
  });

  test("a rollback never deletes an adopted volume", async () => {
    const { backend, hermetic } = seeded();
    // Fail after the volume step: the run adopted a volume it did not create,
    // so the unwind may terminate its instance and delete its row, but the
    // volume holds an earlier agent's memory and is not this run's to destroy.
    backend.compute.runInstance = async () => {
      throw new HermeticError("INTERNAL", "RunInstances exploded");
    };
    await codeOf(
      drain(hermetic.agents.create({ name: "cinder-2", volume_id: ORIOLE, rollback_on_failure: true })),
    );
    expect(backend.volumes.has(ORIOLE)).toBe(true);
    expect(backend.mutations).not.toContain("compute.deleteVolume");
  });
});

/**
 * §9.1: a volume's owner is a row, rows are kept forever (§4.3), and a
 * reclaimed disk is therefore named by *two* rows — the destroyed agent whose
 * memory it holds, and the live one now reading it. Which of the two a scan
 * returns first is arbitrary, and answering with the first one made the live
 * owner invisible roughly half the time: `volume delete` then saw `no_agent`
 * on both of its looks and deleted a running agent's memory.
 */
describe("a volume named by a destroyed row and a live one", () => {
  /**
   * `cinder-2` reclaims `oriole`'s disk and then lets go of it — stopped, or
   * mid-recreate — which is the state a live owner's volume is legitimately
   * detached in. `order` decides which of the two rows the scan hands back
   * first, because the bug was that it mattered.
   */
  async function reclaimed(order: "destroyed first" | "live first") {
    const { backend, hermetic } = seeded();
    await drain(hermetic.agents.create({ name: "cinder-2", volume_id: ORIOLE }));
    const volume = backend.volumes.get(ORIOLE)!;
    backend.volumes.set(ORIOLE, { ...volume, state: "available", attached_to: null });

    const scan = backend.store.agents.scan;
    backend.store.agents.scan = async () => {
      const rows = await scan();
      const first = order === "destroyed first" ? "oriole" : "cinder-2";
      return [...rows].sort((a, b) => (a.name === first ? -1 : b.name === first ? 1 : 0));
    };
    return { backend, hermetic };
  }

  for (const order of ["destroyed first", "live first"] as const) {
    test(`the live row is the owner, whichever comes back first (${order})`, async () => {
      const { hermetic } = await reclaimed(order);
      const { volumes } = await hermetic.volumes.list({});
      const view = volumes.find((v) => v.volume_id === ORIOLE)!;
      expect(view.owners).toEqual(["cinder-2"]);
      expect(view.retained_by).toBeNull();
      expect(view.agent_status).not.toBe("destroyed");
      expect(view.group).toBe("detached");
    });

    test(`delete refuses the live owner's detached disk (${order})`, async () => {
      const { backend, hermetic } = await reclaimed(order);
      let error: HermeticError | null = null;
      try {
        await hermetic.volumes.delete({ volume_id: ORIOLE, yes: true });
      } catch (e) {
        error = e as HermeticError;
      }
      expect(error?.code).toBe("CONFLICT");
      expect(error?.message).toContain("cinder-2");
      expect(backend.volumes.has(ORIOLE)).toBe(true);
      expect(backend.mutations).not.toContain("compute.deleteVolume");
    });
  }

  test("a destroyed row alone is retained_by, and still reclaimable", async () => {
    const { hermetic } = seeded();
    const { volumes } = await hermetic.volumes.list({});
    const view = volumes.find((v) => v.volume_id === ORIOLE)!;
    expect(view.owners).toEqual([]);
    expect(view.retained_by).toBe("oriole");
    expect(view.group).toBe("no_agent");
  });

  /**
   * The other end of the same rule. Two *live* rows naming one disk is not a
   * thing to resolve by picking one: hermetic knows which volume this is and
   * not whose it is, which is the `ambiguous` refusal from the other side.
   */
  test("two live rows claiming one disk is ambiguous, and refuses deletion", async () => {
    const { backend, hermetic } = seeded();
    for (const name of ["juniper", "ember"]) {
      const row = (await backend.store.agents.get(name))!;
      await backend.store.agents.update(name, row.version, {
        volume_id: NO_ROW,
        resources: { ...row.resources, volume_id: NO_ROW },
      });
    }

    const { volumes } = await hermetic.volumes.list({});
    const view = volumes.find((v) => v.volume_id === NO_ROW)!;
    expect(view.group).toBe("ambiguous");
    expect(view.owners.sort()).toEqual(["ember", "juniper"]);

    let error: HermeticError | null = null;
    try {
      await hermetic.volumes.delete({ volume_id: NO_ROW, yes: true });
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("CONFLICT");
    expect(error?.message).toContain("both claim");
    expect(backend.volumes.has(NO_ROW)).toBe(true);
  });
});

/**
 * §9.1's reservation: adoption and deletion are the two operations that act on
 * a disk no row owns yet, so neither has a lock to take and both decide from a
 * read. The reservation is keyed on the thing they compete for — the volume id
 * — and held only until a row records ownership.
 */
describe("the volume reservation", () => {
  const TTL_MS = 10 * 60_000;

  /** What a claim taken by somebody else looks like from here. */
  async function reserve(backend: MemoryBackend, volumeId: string, owner: string, ms = TTL_MS) {
    const expires = new Date(backend.now().getTime() + ms).toISOString();
    await backend.store.volumeClaims.claim(volumeId, owner, expires, backend.now());
  }

  test("a live claim is shown on the volume, by holder and expiry", async () => {
    const { backend, hermetic } = seeded();
    await reserve(backend, ORIOLE, "agent create bravo");
    const { volumes } = await hermetic.volumes.list({});
    const view = volumes.find((v) => v.volume_id === ORIOLE)!;
    expect(view.reserved_by).toBe("agent create bravo");
    expect(view.reserved_until).not.toBeNull();
  });

  test("an expired claim holds nothing and is not shown", async () => {
    const { backend, hermetic } = seeded();
    await reserve(backend, ORIOLE, "agent create bravo", -1000);
    const { volumes } = await hermetic.volumes.list({});
    expect(volumes.find((v) => v.volume_id === ORIOLE)?.reserved_by).toBeNull();
  });

  test("delete is refused while an adoption holds the reservation, and names it", async () => {
    const { backend, hermetic } = seeded();
    await reserve(backend, ORIOLE, "agent create bravo");

    let error: HermeticError | null = null;
    try {
      await hermetic.volumes.delete({ volume_id: ORIOLE, yes: true });
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("LOCKED");
    expect(error?.message).toContain("agent create bravo");
    expect(backend.volumes.has(ORIOLE)).toBe(true);
    expect(backend.mutations).not.toContain("compute.deleteVolume");
  });

  test("adoption is refused while a delete holds the reservation", async () => {
    const { backend, hermetic } = seeded();
    await reserve(backend, ORIOLE, "volume delete (run-1)");

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "cinder-2", volume_id: ORIOLE }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("LOCKED");
    expect(error?.message).toContain("volume delete (run-1)");
    expect(backend.mutations).not.toContain("compute.retagVolume");
    expect(backend.mutations).not.toContain("compute.runInstance");
  });

  test("an expired claim is taken over rather than waited out", async () => {
    const { backend, hermetic } = seeded();
    // The laptop that held it died ten minutes ago; §4.4's TTL is what makes
    // that a wait rather than a fleet nobody can touch.
    await reserve(backend, ORIOLE, "agent create bravo", -1);
    await hermetic.volumes.delete({ volume_id: ORIOLE, yes: true });
    expect(backend.volumes.has(ORIOLE)).toBe(false);
  });

  test("a finished adoption gives the reservation back", async () => {
    const { backend, hermetic } = seeded();
    await drain(hermetic.agents.create({ name: "cinder-2", volume_id: ORIOLE }));
    // The row names the disk now, and the row is the durable claim; carrying
    // the reservation past that point would only expire on somebody.
    expect(backend.claims.size).toBe(0);
    expect(backend.mutations).toContain("store.volumeClaims.claim");
    expect(backend.mutations).toContain("store.volumeClaims.release");
  });

  test("a finished delete gives the reservation back", async () => {
    const { backend, hermetic } = seeded();
    await hermetic.volumes.delete({ volume_id: ORIOLE, yes: true });
    expect(backend.claims.size).toBe(0);
  });

  /**
   * The other pairing, raced the same way: a delete is inside its reservation —
   * past its last look, about to call `DeleteVolume` — when an adoption of the
   * same disk arrives. One of the two happens, and the other is told why.
   */
  test("a delete and an adoption racing for one disk: one wins, one is refused", async () => {
    const { backend, hermetic } = seeded();
    let taken = (): void => {};
    let tried = (): void => {};
    const reserved = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const attempted = new Promise<void>((resolve) => {
      tried = resolve;
    });

    const claim = backend.store.volumeClaims.claim;
    let first = true;
    backend.store.volumeClaims.claim = async (volumeId, owner, expires, now) => {
      const result = await claim(volumeId, owner, expires, now);
      if (first) {
        first = false;
        taken();
        await attempted;
      } else {
        tried();
      }
      return result;
    };

    const deleting = hermetic.volumes.delete({ volume_id: ORIOLE, yes: true });
    await reserved;
    const adopting = await drain(hermetic.agents.create({ name: "cinder-2", volume_id: ORIOLE }))
      .then(() => null)
      .catch((e: HermeticError) => e);
    await deleting;

    expect(adopting?.code).toBe("LOCKED");
    expect(adopting?.message).toContain("volume delete");
    expect(backend.volumes.has(ORIOLE)).toBe(false);
    expect(backend.mutations).not.toContain("compute.retagVolume");
  });

  test("an adoption that is refused leaves no claim and no retag", async () => {
    const { backend, hermetic } = seeded();
    // The rival claims the disk between `resolveAdopted` and the row claim,
    // which is what `reconfirmAdopted` exists to catch — and the reservation
    // must not outlive a run that ends there.
    const claimed = backend.store.agents.putIfAbsent;
    backend.store.agents.putIfAbsent = async (agent) => {
      const rival = (await backend.store.agents.get("juniper"))!;
      await backend.store.agents.update("juniper", rival.version, {
        volume_id: ORIOLE,
        resources: { ...rival.resources, volume_id: ORIOLE },
      });
      return claimed(agent);
    };

    expect(await codeOf(drain(hermetic.agents.create({ name: "cinder-2", volume_id: ORIOLE })))).toBe(
      "CONFLICT",
    );
    expect(backend.claims.size).toBe(0);
    expect(backend.mutations).not.toContain("compute.retagVolume");
    expect(backend.volumes.get(ORIOLE)?.agent).toBe("oriole");
  });

  /**
   * The race the reservation exists for, made deterministic: two creates under
   * different names, adopting one disk, each holding its own agent lock — so
   * nothing else in the system puts them in each other's way. The first is
   * parked inside its reservation until the second has tried to take one.
   */
  test("two creates adopting one disk: exactly one wins, the other is told who", async () => {
    const { backend, hermetic } = seeded();
    let taken = (): void => {};
    let tried = (): void => {};
    /** The winner is inside its reservation. */
    const reserved = new Promise<void>((resolve) => {
      taken = resolve;
    });
    /** The loser has had its attempt, so the winner may carry on. */
    const attempted = new Promise<void>((resolve) => {
      tried = resolve;
    });

    const claim = backend.store.volumeClaims.claim;
    let winner = true;
    backend.store.volumeClaims.claim = async (volumeId, owner, expires, now) => {
      const result = await claim(volumeId, owner, expires, now);
      if (winner) {
        winner = false;
        taken();
        // Parked *inside* the window the reservation covers: between the claim
        // and the row that makes it durable, which is exactly where the second
        // create used to walk straight through.
        await attempted;
      } else {
        tried();
      }
      return result;
    };

    const first = drain(hermetic.agents.create({ name: "cinder-2", volume_id: ORIOLE }));
    await reserved;
    const loser = await drain(hermetic.agents.create({ name: "cinder-3", volume_id: ORIOLE }))
      .then(() => null)
      .catch((e: HermeticError) => e);
    await first;

    expect(loser?.code).toBe("LOCKED");
    expect(loser?.message).toContain("agent create cinder-2");
    expect(loser?.details?.["volume_id"]).toBe(ORIOLE);
    expect((await backend.store.agents.get("cinder-2"))!.resources.volume_id).toBe(ORIOLE);
    expect((await backend.store.agents.get("cinder-3"))?.resources.volume_id ?? null).toBeNull();
    // One box, not two: the disk the loser never got is the disk it never
    // launched onto.
    expect(backend.mutations.filter((m) => m === "compute.runInstance").length).toBe(1);
  });
});

/**
 * §5: another fleet's volume is another fleet's to reclaim, rename or delete.
 * `Ec2Compute.listVolumes` drops it after reading the tags back, and the
 * fixture models the same cut — so `volume ls` cannot show it and
 * `agent create --volume` cannot reach it. There is deliberately no separate
 * "belongs to another fleet" refusal: saying that would mean reading outside
 * the fleet to say it.
 */
describe("a volume tagged for another fleet", () => {
  function withForeign() {
    const { backend, hermetic } = seeded();
    backend.volumes.set("vol-foreign00000000", {
      volume_id: "vol-foreign00000000",
      size_gib: 100,
      state: "available",
      agent: "atlas",
      role: "data",
      fleet_id: "sg7k2m4p",
      az: backend.launchAzId,
      created_at: "2026-08-01T00:00:00.000Z",
    });
    return { backend, hermetic };
  }

  test("is invisible to volume ls, even though it is unattached and billing", async () => {
    const { hermetic } = withForeign();
    const { volumes } = await hermetic.volumes.list({});
    expect(volumes.map((v) => v.volume_id)).not.toContain("vol-foreign00000000");
  });

  test("`agent create --volume` answers NOT_FOUND rather than adopting it", async () => {
    const { backend, hermetic } = withForeign();
    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "borrower", volume_id: "vol-foreign00000000" }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("NOT_FOUND");
    expect(error?.message).toContain("belongs to another fleet");
    // And nothing was stamped: the other fleet can still find its own disk.
    expect(backend.volumes.get("vol-foreign00000000")!.fleet_id).toBe("sg7k2m4p");
    expect(backend.mutations).not.toContain("compute.retagVolume");
  });
});
