import { testHermetic } from "./helpers.ts";
import { describe, expect, test } from "bun:test";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { checkLocalTailscale } from "../src/fleet/doctor.ts";
import { TAILSCALE_ADMIN_DNS_URL, parseTailscaleStatus } from "../src/fleet/preflight.ts";
import type { TailscalePreflight } from "../src/schema/index.ts";

/**
 * §4.8: these describe a fleet the account's directory knows about — an
 * unregistered fleet is its own `doctor` finding, and it is not the drift these
 * tests are about. The fixture directory is process-global, so each file says
 * which account it is in rather than inheriting whichever ran last.
 */
/**
 * §9: `doctor` reconciles DynamoDB against EC2 and Tailscale, both of which
 * can drift independently of any hermetic operation (an instance launched or
 * terminated by hand, a device removed in the admin console).
 */
function seeded() {
  const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
  return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG }) };
}

describe("doctor: EC2 drift", () => {
  test("a row with no live instance while ready reports instance_missing", async () => {
    const { backend, hermetic } = seeded();
    // atlas's row says "ready" but its EC2 instance was terminated by hand.
    for (const [id, inst] of backend.instances) {
      if (inst.agent === "atlas") backend.instances.set(id, { ...inst, state: "terminated" });
    }
    const report = await hermetic.doctor();
    expect(report.instance_drift).toContainEqual(
      expect.objectContaining({ kind: "instance_missing", agent: "atlas" }),
    );
    expect(report.findings.join(" ")).toContain("instance_missing");
    expect(report.ok).toBe(false);
  });

  test("a live instance with no agent row reports orphan_instance", async () => {
    const { backend, hermetic } = seeded();
    backend.instances.set("i-orphan0000000", {
      instance_id: "i-orphan0000000",
      state: "running",
      public_ip: "203.0.113.99",
      agent: "ghost",
      fleet_id: FIXTURE_CONFIG.fleet_id,
    });
    const report = await hermetic.doctor();
    expect(report.instance_drift).toContainEqual(
      expect.objectContaining({ kind: "orphan_instance", agent: "ghost" }),
    );
    expect(report.findings.join(" ")).toContain("orphan_instance");
  });

  test("a live instance whose agent tag names a destroyed row also reports orphan_instance", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", { ...atlas, status: "destroyed" });
    const report = await hermetic.doctor();
    expect(report.instance_drift).toContainEqual(
      expect.objectContaining({ kind: "orphan_instance", agent: "atlas" }),
    );
  });

  test("a row whose recorded instance_id disagrees with the live one reports instance_mismatch", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", {
      ...atlas,
      instance_id: "i-stale00000000",
      resources: { ...atlas.resources, instance_id: "i-stale00000000" },
    });
    const report = await hermetic.doctor();
    expect(report.instance_drift).toContainEqual(
      expect.objectContaining({ kind: "instance_mismatch", agent: "atlas" }),
    );
    expect(report.findings.join(" ")).toContain("instance_mismatch");
  });

  test("a live instance with no instance_id on the agent row reports instance_unrecorded", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", {
      ...atlas,
      instance_id: null,
      resources: { ...atlas.resources, instance_id: undefined },
    });
    const report = await hermetic.doctor();
    expect(report.instance_drift).toContainEqual(
      expect.objectContaining({ kind: "instance_unrecorded", agent: "atlas" }),
    );
    expect(report.findings.join(" ")).toContain("instance_unrecorded");
  });

  /**
   * Two live boxes for one agent: nothing in AWS prevents it (two recreates
   * racing, or a launch whose id was never persisted followed by another), and
   * before `instance_duplicate` existed no tool said a word about the second.
   */
  test("a second live instance for an active agent reports instance_duplicate", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    backend.instances.set("i-double00000000", {
      instance_id: "i-double00000000",
      state: "running",
      public_ip: "203.0.113.77",
      agent: "atlas",
      fleet_id: FIXTURE_CONFIG.fleet_id,
    });

    const report = await hermetic.doctor();
    const duplicates = report.instance_drift.filter((d) => d.kind === "instance_duplicate");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.agent).toBe("atlas");
    expect(duplicates[0]!.detail).toContain("i-double00000000");
    expect(duplicates[0]!.detail).toContain(atlas.resources.instance_id!);
    expect(report.instance_drift.filter((d) => d.kind === "instance_mismatch")).toEqual([]);
    expect(report.instance_drift.filter((d) => d.kind === "orphan_instance")).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.findings).toContain(duplicates[0]!.detail);
  });

  /**
   * Same fleet, but the duplicate is iterated *first*. The row is still right,
   * so the answer must not flip to `instance_mismatch` on the order EC2 happens
   * to return.
   */
  test("the duplicate listing before the recorded instance changes nothing", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    const recorded = atlas.resources.instance_id!;
    const original = backend.instances.get(recorded)!;
    backend.instances.delete(recorded);
    backend.instances.set("i-double00000000", {
      instance_id: "i-double00000000",
      state: "running",
      public_ip: "203.0.113.77",
      agent: "atlas",
      fleet_id: FIXTURE_CONFIG.fleet_id,
    });
    backend.instances.set(recorded, original);

    const report = await hermetic.doctor();
    const duplicates = report.instance_drift.filter((d) => d.kind === "instance_duplicate");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.detail).toContain("i-double00000000");
    expect(report.instance_drift.filter((d) => d.kind === "instance_mismatch")).toEqual([]);
    expect(report.instance_drift.filter((d) => d.kind === "orphan_instance")).toEqual([]);
  });

  /**
   * The row names none of them, so nothing marks one of the two boxes as the
   * agent's: `instance_unrecorded` names both, and both are duplicates. Which
   * one EC2 lists first must not decide which finding gets which id.
   */
  test("a row recording no id with two live instances reports the same either way", async () => {
    const details = [] as string[][];
    for (const order of [
      ["i-yankee00000000", "i-zulu0000000000"],
      ["i-zulu0000000000", "i-yankee00000000"],
    ]) {
      const { backend, hermetic } = seeded();
      const atlas = backend.agents.get("atlas")!;
      backend.instances.delete(atlas.resources.instance_id!);
      backend.agents.set("atlas", {
        ...atlas,
        instance_id: null,
        resources: { ...atlas.resources, instance_id: undefined },
      });
      for (const id of order) {
        backend.instances.set(id, {
          instance_id: id,
          state: "running",
          public_ip: "203.0.113.77",
          agent: "atlas",
          fleet_id: FIXTURE_CONFIG.fleet_id,
        });
      }

      const report = await hermetic.doctor();
      const unrecorded = report.instance_drift.filter((d) => d.kind === "instance_unrecorded");
      expect(unrecorded).toHaveLength(1);
      expect(unrecorded[0]!.detail).toContain("i-yankee00000000");
      expect(unrecorded[0]!.detail).toContain("i-zulu0000000000");
      const duplicates = report.instance_drift.filter((d) => d.kind === "instance_duplicate");
      expect(duplicates).toHaveLength(2);
      expect(duplicates.every((d) => d.detail.includes("(none recorded)"))).toBe(true);
      details.push(report.instance_drift.map((d) => `${d.kind}:${d.detail}`).sort());
    }
    expect(details[0]).toEqual(details[1]!);
  });

  /** One box and no recorded id is still just the one finding. */
  test("a row recording no id with one live instance is unrecorded and nothing else", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", {
      ...atlas,
      instance_id: null,
      resources: { ...atlas.resources, instance_id: undefined },
    });
    const report = await hermetic.doctor();
    expect(report.instance_drift.filter((d) => d.kind === "instance_unrecorded")).toHaveLength(1);
    expect(report.instance_drift.filter((d) => d.kind === "instance_duplicate")).toEqual([]);
  });

  /**
   * `recreate` refuses a row that is not settled, so advising it on one
   * mid-operation is advice that cannot be taken.
   */
  test("the remediation hint is only recreate's when recreate would run", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", { ...atlas, status: "destroying" });
    backend.instances.set("i-double00000000", {
      instance_id: "i-double00000000",
      state: "running",
      public_ip: "203.0.113.77",
      agent: "atlas",
      fleet_id: FIXTURE_CONFIG.fleet_id,
    });

    const report = await hermetic.doctor();
    const duplicates = report.instance_drift.filter((d) => d.kind === "instance_duplicate");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.detail).toContain("terminate it by hand once atlas settles");
    expect(duplicates[0]!.detail).not.toContain("agent recreate");
  });

  /**
   * `listManagedInstances` keeps `shutting-down` so a destroy in flight is
   * visible, and every `recreate` leaves one for the 30–60 s EC2 takes to
   * finish with it. Calling that a second box would make `doctor` red about the
   * operation the operator just ran. (The fixture's `terminate` jumps straight
   * to `terminated`, so this state has to be seeded by hand.)
   */
  test("an instance already shutting down is neither a duplicate nor an orphan", async () => {
    const { backend, hermetic } = seeded();
    backend.instances.set("i-dying", {
      instance_id: "i-dying",
      state: "shutting-down",
      public_ip: null,
      agent: "atlas",
      fleet_id: FIXTURE_CONFIG.fleet_id,
    });
    const report = await hermetic.doctor();
    expect(report.instance_drift.filter((d) => d.kind === "instance_duplicate")).toEqual([]);
    expect(report.instance_drift.filter((d) => d.kind === "orphan_instance")).toEqual([]);
    expect(report.instance_drift).toEqual([]);
    // The seeded fleet is not `ok` to begin with — it carries a stale heartbeat
    // — so the claim that matters is that the dying box added nothing at all.
    const baseline = await seeded().hermetic.doctor();
    expect(report.findings).toEqual(baseline.findings);
    expect(report.ok).toBe(baseline.ok);
  });

  /**
   * A box mid-terminate is not something the agent can be running on, so the
   * instance the row records naming one counts as gone: a `ready` row with
   * nothing else out there is `instance_missing`, which is the honest answer —
   * and it is the one that would go unsaid if `shutting-down` still counted as
   * the agent's own instance.
   */
  test("a ready row whose only instance is shutting down reports instance_missing", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    const recorded = atlas.resources.instance_id!;
    backend.instances.set(recorded, {
      ...backend.instances.get(recorded)!,
      state: "shutting-down",
    });

    const report = await hermetic.doctor();
    expect(report.instance_drift.filter((d) => d.kind === "instance_missing")).toEqual([
      expect.objectContaining({ kind: "instance_missing", agent: "atlas" }),
    ]);
    expect(report.instance_drift.filter((d) => d.kind === "instance_mismatch")).toEqual([]);
    expect(report.instance_drift.filter((d) => d.kind === "instance_duplicate")).toEqual([]);
    expect(report.instance_drift.filter((d) => d.kind === "orphan_instance")).toEqual([]);
  });

  /**
   * The row records X, X is gone, and Y and Z are both out there. No live box is
   * *the* agent's, so which one EC2 happens to list first must not decide which
   * finding names which id.
   */
  test("a recorded instance that is gone with two live ones reports the same either way", async () => {
    const details = [] as string[][];
    for (const order of [
      ["i-yankee00000000", "i-zulu0000000000"],
      ["i-zulu0000000000", "i-yankee00000000"],
    ]) {
      const { backend, hermetic } = seeded();
      const atlas = backend.agents.get("atlas")!;
      backend.instances.delete(atlas.resources.instance_id!);
      backend.agents.set("atlas", {
        ...atlas,
        instance_id: "i-gone0000000000",
        resources: { ...atlas.resources, instance_id: "i-gone0000000000" },
      });
      for (const id of order) {
        backend.instances.set(id, {
          instance_id: id,
          state: "running",
          public_ip: "203.0.113.77",
          agent: "atlas",
          fleet_id: FIXTURE_CONFIG.fleet_id,
        });
      }

      const report = await hermetic.doctor();
      const mismatches = report.instance_drift.filter((d) => d.kind === "instance_mismatch");
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.detail).toContain("i-yankee00000000");
      expect(mismatches[0]!.detail).toContain("i-zulu0000000000");
      // Neither is the agent's, so neither gets to be the one that is not a duplicate.
      const duplicates = report.instance_drift.filter((d) => d.kind === "instance_duplicate");
      expect(duplicates).toHaveLength(2);
      details.push(report.instance_drift.map((d) => `${d.kind}:${d.detail}`).sort());
    }
    expect(details[0]).toEqual(details[1]!);
  });

  test("a clean fixture has no instance drift", async () => {
    const { hermetic } = seeded();
    const report = await hermetic.doctor();
    expect(report.instance_drift).toEqual([]);
  });
});

describe("doctor: tailscale drift", () => {
  test("a ready row with no matching device reports tailscale_missing", async () => {
    const { backend, hermetic } = seeded();
    backend.tailscaleDevices = (backend.tailscaleDevices ?? []).filter(
      (d) => d.hostname !== "fxtr0001-atlas",
    );
    const report = await hermetic.doctor();
    expect(report.tailscale.missing).toContain("atlas");
    expect(report.findings.join(" ")).toContain("tailscale_missing");
    expect(report.ok).toBe(false);
  });

  /**
   * The node whose name a stale device took. A device carries the OS hostname
   * — the agent's own name — separately from the MagicDNS `name` that took the
   * `-2` suffix, so a node admitted as `atlas-2` is still present *as* atlas.
   * The old code looked for the canonical FQDN only and would have called this
   * agent unreachable while its dashboard was serving fine.
   */
  test("a ready row is found under the name it actually holds", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", { ...atlas, tailscale_dns_name: "fxtr0001-atlas-2.hermetic.ts.net" });
    backend.tailscaleDevices = (backend.tailscaleDevices ?? []).map((d) =>
      d.hostname === "fxtr0001-atlas" ? { ...d, name: "fxtr0001-atlas-2.hermetic.ts.net" } : d,
    );
    const report = await hermetic.doctor();
    expect(report.tailscale.missing).toEqual([]);
    expect(report.findings.join(" ")).not.toContain("tailscale_missing");
  });

  /**
   * Reported, but not as a finding: the fix is deleting a device in a console
   * hermetic's OAuth client cannot reach, so a fleet with one recreated agent
   * would answer PROBLEMS until somebody happened to do it — and a report that
   * is permanently red is a report nobody reads. It rides on `tailscale`, next
   * to the `devices:core` skip, which is informational for the same reason.
   */
  test("a real name that is not the canonical one is a tailnet detail, not a finding", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", { ...atlas, tailscale_dns_name: "fxtr0001-atlas-2.hermetic.ts.net" });
    const report = await hermetic.doctor();
    const stale = report.tailscale.stale.find((s) => s.agent === "atlas")!;
    expect(stale.real).toBe("fxtr0001-atlas-2.hermetic.ts.net");
    // The canonical spelling carries the fleet prefix since v4: the node joins
    // the tailnet as `<fleet id>-<agent>` (§5).
    expect(stale.canonical).toBe("fxtr0001-atlas.hermetic.ts.net");
    expect(stale.note).toContain("fxtr0001-atlas-2.hermetic.ts.net");
    // The console path is still named — it is the fix on a fleet whose client
    // was never re-scoped, and the one an operator may prefer anyway.
    expect(stale.note).toContain("Machines → atlas");
    // But this fixture *can* read devices, so the client has `devices:core`
    // and the note offers the command that clears it (§6.5).
    expect(stale.note).toContain("hermetic agent recreate atlas will remove it");
    expect(report.findings.join(" ")).not.toContain("tailscale_stale_device");
    // The findings are what they would have been without the rename: the seeded
    // stale heartbeat, and nothing else. Renaming only the row cannot cause
    // `tailscale_missing` — a device is matched on its OS hostname, which the
    // rename did not touch. The stale device adds nothing.
    expect(report.findings).toEqual(["lumen is ready but has not heartbeated recently"]);
  });

  /**
   * The other half of the same sentence: a fleet that cannot read the device
   * list cannot delete one either, so the note must not promise a command that
   * would only warn.
   */
  test("without the devices scope the note keeps the admin console as the only fix", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", { ...atlas, tailscale_dns_name: "fxtr0001-atlas-2.hermetic.ts.net" });
    backend.tailscaleDevices = null;
    const report = await hermetic.doctor();
    const stale = report.tailscale.stale.find((s) => s.agent === "atlas")!;
    expect(stale.note).toContain("Machines → atlas");
    expect(stale.note).not.toContain("agent recreate");
  });

  /**
   * The stale check is a comparison of two strings on the row, so it must keep
   * working on the fleets that cannot read the device list — which, until the
   * OAuth client is re-scoped, is all of them.
   */
  test("a stale device is still named when the device list is unreadable", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", { ...atlas, tailscale_dns_name: "fxtr0001-atlas-2.hermetic.ts.net" });
    backend.tailscaleDevices = null;
    const report = await hermetic.doctor();
    expect(report.tailscale.available).toBe(false);
    expect(report.tailscale.stale.map((s) => s.note).join(" ")).toContain("tailscale_stale_device");
  });

  /**
   * The regression this kind exists to prevent. `doctor` used to tell an
   * operator to go and delete `atlas` in the Tailscale admin console whenever
   * the fleet's naming rule had moved on since the box was built — and that
   * device is the machine the agent is running on. A node wearing a spelling
   * hermetic itself handed out is `legacy`: reported, explained, never
   * nominated for deletion.
   */
  describe("a node built before the naming rule moved", () => {
    test("the v3 `<fleet name>-<agent>` spelling is legacy, not a stale device", async () => {
      const { backend, hermetic } = seeded();
      const atlas = backend.agents.get("atlas")!;
      backend.agents.set("atlas", { ...atlas, tailscale_dns_name: "main-atlas.hermetic.ts.net" });
      const report = await hermetic.doctor();
      const entry = report.tailscale.stale.find((s) => s.agent === "atlas")!;
      expect(entry.kind).toBe("legacy");
      expect(entry.real).toBe("main-atlas.hermetic.ts.net");
      expect(entry.canonical).toBe("fxtr0001-atlas.hermetic.ts.net");
      // The two things it must never say about a live machine.
      expect(entry.note).not.toContain("Machines → atlas");
      expect(entry.note).not.toContain("stale device");
      // And what it says instead: why, and what clears it.
      expect(entry.note).toContain("hermetic agent recreate atlas");
      expect(entry.note).toContain("nothing answers to fxtr0001-atlas.hermetic.ts.net");
      expect(entry.note).toContain("tailscale_legacy_name");
    });

    test("the pre-v3 bare spelling is legacy too", async () => {
      const { backend, hermetic } = seeded();
      const atlas = backend.agents.get("atlas")!;
      backend.agents.set("atlas", { ...atlas, tailscale_dns_name: "atlas.hermetic.ts.net" });
      const report = await hermetic.doctor();
      expect(report.tailscale.stale.find((s) => s.agent === "atlas")?.kind).toBe("legacy");
    });

    /**
     * A legacy node is still not a finding — but neither was a stale one, and
     * for a stronger reason here: on the day a fleet moves to v4 *every* box in
     * it is legacy, and a `doctor` that answered PROBLEMS for a fleet in which
     * nothing is wrong is a `doctor` an operator learns to ignore.
     *
     * "Moves to v4" is the load-bearing half, and it is now stated rather than
     * assumed: these boxes predate the fleet's adoption of the rule, which is
     * what makes their names history instead of a defect (the case below).
     */
    test("a fleet that has just migrated still answers ok", async () => {
      const { backend, hermetic } = seeded();
      // The migration is *after* every box in the fixture was built, which is
      // what "just migrated" means: they all predate the rule they are not
      // following.
      backend.fleetItem = {
        ...backend.fleetItem!,
        foundation_updated_at: "2026-09-01T00:00:00.000Z",
      };
      for (const [name, row] of [...backend.agents.entries()]) {
        if (row.tailscale_dns_name === null) continue;
        backend.agents.set(name, { ...row, tailscale_dns_name: `main-${name}.hermetic.ts.net` });
      }
      const report = await hermetic.doctor();
      expect(report.findings.join(" ")).not.toContain("tailscale_stale_device");
      expect(report.findings.join(" ")).not.toContain("tailscale_legacy_name");
      expect(report.findings.join(" ")).not.toContain("tailscale_misnamed");
      // The seeded stale heartbeat is the only thing wrong with this fleet.
      expect(report.findings).toEqual(["lumen is ready but has not heartbeated recently"]);
    });

    /**
     * The other side of the same comparison, and the incident that put it here.
     * A node created *after* its fleet adopted fleet-id naming, wearing the old
     * spelling anyway, is not an old box: it is a fleet whose published release
     * is older than the rule its laptop renders for, so every new box it builds
     * comes up misnamed. Nothing about it is visible in `agent ps`, the plan or
     * the instance tag — all three say the name it was supposed to get.
     */
    test("a node built after the rule moved is a finding, not a note", async () => {
      const { backend, hermetic } = seeded();
      backend.fleetItem = {
        ...backend.fleetItem!,
        foundation_updated_at: "2026-07-21T00:00:00.000Z",
      };
      const atlas = backend.agents.get("atlas")!;
      backend.agents.set("atlas", {
        ...atlas,
        created_at: "2026-07-22T14:05:00.000Z",
        tailscale_dns_name: "atlas.hermetic.ts.net",
      });
      const report = await hermetic.doctor();

      const entry = report.tailscale.stale.find((s) => s.agent === "atlas")!;
      expect(entry.kind).toBe("legacy");
      expect(entry.misnamed).toBe(true);
      const finding = report.findings.find((f) => f.includes("tailscale_misnamed"));
      expect(finding).toContain("atlas.hermetic.ts.net");
      expect(finding).toContain("fxtr0001-atlas.hermetic.ts.net");
      expect(finding).toContain("hermetic artifacts push");
      expect(finding).toContain("hermetic agent recreate atlas");
      expect(report.ok).toBe(false);
      // Still never the sentence that would evict the live machine.
      expect(entry.note).not.toContain("Machines → atlas");
    });

    /**
     * A `recreate` builds a new box and leaves `created_at` where it was, so the
     * row's own age is the wrong clock: an agent from before the migration,
     * rebuilt today against a stale release, would look like history. What the
     * box actually did is `bootstrap.started_at`.
     */
    test("a recreated box is judged on when it booted, not when the row was made", async () => {
      const { backend, hermetic } = seeded();
      backend.fleetItem = {
        ...backend.fleetItem!,
        foundation_updated_at: "2026-09-01T00:00:00.000Z",
      };
      const atlas = backend.agents.get("atlas")!;
      backend.agents.set("atlas", {
        ...atlas,
        // Older than the migration…
        created_at: "2026-07-22T14:05:00.000Z",
        // …but this box was built after it, and came up with the old name.
        bootstrap: { ...atlas.bootstrap!, started_at: "2026-09-05T00:00:00.000Z" },
        tailscale_dns_name: "atlas.hermetic.ts.net",
      });
      const report = await hermetic.doctor();
      expect(report.tailscale.stale.find((s) => s.agent === "atlas")?.misnamed).toBe(true);
      expect(report.findings.join(" ")).toContain("tailscale_misnamed");
    });

    /**
     * A *stale* device is never "misnamed": the node took a suffixed name
     * because a corpse held the canonical one, which is a tailnet problem with a
     * different fix, and folding the two together would send an operator to
     * publish a release that changes nothing.
     */
    test("a stale device is not reported as misnamed", async () => {
      const { backend, hermetic } = seeded();
      const atlas = backend.agents.get("atlas")!;
      backend.agents.set("atlas", {
        ...atlas,
        tailscale_dns_name: "fxtr0001-atlas-2.hermetic.ts.net",
      });
      const report = await hermetic.doctor();
      expect(report.tailscale.stale.find((s) => s.agent === "atlas")?.misnamed).toBeUndefined();
      expect(report.findings.join(" ")).not.toContain("tailscale_misnamed");
    });

    /**
     * `tailscale_missing` is decided on the device list, not on the row, so it
     * has to accept the legacy spellings too — a box built under v3 registered
     * its device as `main-atlas` and will never be called `fxtr0001-atlas`
     * without a recreate.
     */
    test("a legacy device is found rather than reported missing", async () => {
      const { backend, hermetic } = seeded();
      backend.tailscaleDevices = (backend.tailscaleDevices ?? []).map((d) =>
        d.hostname === "fxtr0001-atlas" ? { ...d, hostname: "main-atlas" } : d,
      );
      const report = await hermetic.doctor();
      expect(report.tailscale.missing).toEqual([]);
      expect(report.findings.join(" ")).not.toContain("tailscale_missing");
    });
  });

  test("a row that reports its canonical name is not stale", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", { ...atlas, tailscale_dns_name: "fxtr0001-atlas.hermetic.ts.net" });
    const report = await hermetic.doctor();
    // `corvid` is the fixture's own recreated agent; `atlas` must not join it.
    expect(report.tailscale.stale.map((s) => s.agent)).toEqual(["corvid"]);
  });

  test("listDevices() returning null is reported as unavailable, not a finding", async () => {
    const { backend, hermetic } = seeded();
    backend.tailscaleDevices = null;
    const report = await hermetic.doctor();
    expect(report.tailscale.available).toBe(false);
    expect(report.tailscale.missing).toEqual([]);
    // No *device* finding: the only tailscale line left is the fixture's own
    // seeded stale device, which is a row read and needs no device list.
    expect(report.findings.join(" ")).not.toContain("tailscale_missing");
    // Informational, not a finding — but *said*, because an unchecked list and
    // a clean one are indistinguishable from the outside.
    expect(report.tailscale.detail).toContain("devices:core");
  });

  /**
   * Every ready agent's device is present — including `corvid`, which the
   * fixture seeds as a recreated agent whose predecessor still holds the
   * canonical name, so the stale-device path has a fleet to be seen on.
   */
  test("a clean fixture has every ready agent's device present", async () => {
    const { hermetic } = seeded();
    const report = await hermetic.doctor();
    expect(report.tailscale).toEqual({
      available: true,
      missing: [],
      stale: [
        {
          agent: "corvid",
          real: "fxtr0001-corvid-2.hermetic.ts.net",
          canonical: "fxtr0001-corvid.hermetic.ts.net",
          kind: "stale",
          note: report.tailscale.stale[0]!.note,
        },
      ],
      detail: null,
      // §4.7: the fixture policy carries the operator's own `tag:hermetic`
      // owner and none of hermetic's blocks, so the two hermetic *would* write
      // read as drift — informational, and not a finding.
      policy: { scope: "write", managed: "absent", blocks_drifted: ["ssh", "acls"] },
    });
    expect(report.tailscale.stale[0]!.note).toContain("Machines → corvid");
    expect(report.findings.join("\n")).not.toContain("policy");
  });
});

/**
 * §4.7 through §9: the two tailnet-wide settings that break *every* create,
 * about twenty minutes in, on the box. `init` checks them and `agents.create`
 * deliberately does not, so an already-initialised fleet has nowhere else to
 * learn that HTTPS Certificates or MagicDNS was turned off after the fact.
 */
describe("doctor: this machine's tailscale", () => {
  /** As the daemon reports it, so the message under test is the real one. */
  function status(over: Record<string, unknown> = {}): TailscalePreflight {
    return parseTailscaleStatus(
      JSON.stringify({
        BackendState: "Running",
        MagicDNSSuffix: "acme.ts.net",
        Self: { HostName: "laptop" },
        TailscaleIPs: ["100.64.0.2"],
        CertDomains: ["laptop.acme.ts.net"],
        ...over,
      }),
      "tailscale",
    );
  }

  function withProbe(localTailscale: () => Promise<TailscalePreflight>) {
    const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
    return testHermetic({ backend, config: FIXTURE_CONFIG, localTailscale });
  }

  test("HTTPS certificates off is a finding, verbatim, with the admin DNS link", async () => {
    const certsOff = status({ CertDomains: null });
    const report = await withProbe(async () => certsOff).doctor();

    expect(report.local_tailscale.ok).toBe(false);
    expect(report.local_tailscale.https_certificates).toBe(false);
    // Verbatim: the preflight already names the toggle and the page.
    expect(report.local_tailscale.detail).toBe(certsOff.problem!);
    expect(report.findings).toContain(certsOff.problem!);
    expect(report.findings.join(" ")).toContain("HTTPS certificates");
    expect(report.findings.join(" ")).toContain(TAILSCALE_ADMIN_DNS_URL);
    expect(report.ok).toBe(false);
  });

  test("MagicDNS off is a finding too", async () => {
    const noMagicDns = status({ MagicDNSSuffix: "", Self: { HostName: "laptop" } });
    const report = await withProbe(async () => noMagicDns).doctor();

    expect(report.local_tailscale.ok).toBe(false);
    expect(report.findings).toContain(noMagicDns.problem!);
    expect(report.findings.join(" ")).toContain("MagicDNS");
  });

  test("a healthy tailnet is reported, and is not a finding", async () => {
    const report = await withProbe(async () => status()).doctor();

    expect(report.local_tailscale).toEqual({
      ok: true,
      tailnet: "acme.ts.net",
      https_certificates: true,
      detail: "tailscale: acme.ts.net, HTTPS certificates on",
    });
    expect(report.findings.join(" ")).not.toContain("HTTPS certificates");
    expect(report.findings.join(" ")).not.toContain(TAILSCALE_ADMIN_DNS_URL);
  });

  test("a probe that throws is a finding, not the end of doctor", async () => {
    const report = await withProbe(async () => {
      throw new Error("tailscaled socket is gone");
    }).doctor();

    // Everything above the probe is still true and still worth printing.
    expect(report.account.ok).toBe(true);
    expect(report.local_tailscale.ok).toBe(false);
    expect(report.findings.join(" ")).toContain("tailscaled socket is gone");
    expect(report.ok).toBe(false);
  });

  test("a missing probe is a finding naming the fix, not a TypeError", async () => {
    const result = await checkLocalTailscale(undefined as unknown as () => Promise<TailscalePreflight>);

    expect(result.ok).toBe(false);
    expect(result.https_certificates).toBe(false);
    expect(result.detail).toContain("restart it");
    expect(result.detail).toContain("stale");
  });

  test("a probe that never answers is bounded, so doctor cannot hang", async () => {
    // A wedged `tailscaled` blocks rather than failing; `doctor` is the
    // command run *because* something is wrong, so the same real timeout path
    // is exercised at a test-sized duration. Production callers omit the
    // second argument and retain the full probe budget.
    const timeoutMs = 10;
    const report = await checkLocalTailscale(
      () => new Promise<TailscalePreflight>(() => {}),
      timeoutMs,
    );

    expect(report.ok).toBe(false);
    expect(report.detail).toContain(`${timeoutMs}ms`);
  }, 1000);
});
