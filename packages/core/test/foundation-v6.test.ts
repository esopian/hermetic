/**
 * The shipped v6 foundation migration (§6.6): `_fleet.network`, back-filled
 * from the `Network` parameter on the fleet's own CloudFormation stack.
 *
 * The property under test is the one the field exists for. `--network nat` has
 * been available since v1 and nothing ever read it back, so a fleet behind a
 * NAT is indistinguishable from a public one until this runs — and a migration
 * that "helpfully" defaulted the absent field to `public` would describe half
 * of those fleets as the opposite of what they are. So: `nat` back-fills to
 * `nat`, `public` back-fills to `public`, a stack that answers with no
 * `Network` parameter leaves the field absent, and a second run changes
 * nothing.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  MemoryBackend,
  seedFixtureAgents,
  seedFixtureFoundation,
} from "../src/backend/memory.ts";
import { FOUNDATION_MIGRATIONS, migrationsBetween } from "../src/fleet/foundation-migrations.ts";
import type { FoundationMigrationDeps } from "../src/fleet/foundation-migrations.ts";
import type { NetworkMode } from "../src/schema/index.ts";
import { HermeticError } from "../src/errors.ts";
import type { HermeticDeps } from "../src/hermetic.ts";
import { FOUNDATION_VERSION } from "../src/version.ts";
import { drain, testHermetic } from "./helpers.ts";

const V6 = FOUNDATION_MIGRATIONS.find((m) => m.version === 6)!;

/**
 * A fleet as it stood before v6: a real stack carrying the `Network` parameter
 * it was created with, and a `_fleet` item that has never recorded it.
 */
function preV6(parameter: string | null): MemoryBackend {
  const backend = seedFixtureFoundation(new MemoryBackend());
  const { Network: _network, ...rest } = backend.stack!.parameters;
  backend.stack = {
    ...backend.stack!,
    parameters: parameter === null ? rest : { ...rest, Network: parameter },
  };
  backend.fleetItem = { ...backend.fleetItem!, network: undefined };
  return backend;
}

function depsFor(backend: MemoryBackend): FoundationMigrationDeps & { notes: string[] } {
  return {
    backend,
    fleet: backend.fleetItem!,
    actor: FIXTURE_CONFIG.frozen_by,
    nowIso: () => "2026-09-11T00:00:00.000Z",
    notes: [],
  };
}

/** The hook, plus the stamp that writes the patched copy back (§6.6 step 5). */
async function run(backend: MemoryBackend): Promise<string[]> {
  const deps = depsFor(backend);
  await V6.remote?.(deps);
  backend.fleetItem = deps.fleet;
  return deps.notes;
}

describe("the v6 foundation migration", () => {
  test("is the entry this build's FOUNDATION_VERSION points at", () => {
    expect(V6.describe).toContain("network mode");
  });

  test("a nat fleet back-fills to nat, not public", async () => {
    const backend = preV6("nat");
    const notes = await run(backend);
    expect(backend.fleetItem!.network).toBe("nat");
    expect(notes.join("\n")).toContain("nat");
  });

  test("a public fleet back-fills to public", async () => {
    const backend = preV6("public");
    await run(backend);
    expect(backend.fleetItem!.network).toBe("public");
  });

  /**
   * Should never happen — `Network` has been a template parameter since v1 —
   * and the behaviour when it does is the whole point: unrecorded, not guessed.
   */
  test("a stack with no Network parameter leaves the field absent", async () => {
    const backend = preV6(null);
    const notes = await run(backend);
    expect(backend.fleetItem!.network).toBeUndefined();
    expect(notes.join("\n")).toContain("no `Network` parameter");
  });

  test("a parameter that is neither mode is not written through", async () => {
    const backend = preV6("private");
    await run(backend);
    expect(backend.fleetItem!.network).toBeUndefined();
  });

  /**
   * A `foundation.update` that fails in a later phase is re-run from the start,
   * so every hook runs again over its own output.
   */
  test("a second run changes nothing and says so", async () => {
    const backend = preV6("nat");
    await run(backend);
    const notes = await run(backend);
    expect(backend.fleetItem!.network).toBe("nat");
    expect(notes.join("\n")).toContain("already records");
  });

  test("a fleet already recorded as nat is untouched by a re-run", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend(), { fleet: "staging" });
    const before: NetworkMode | undefined = backend.fleetItem!.network;
    expect(before).toBe("nat");
    await run(backend);
    expect(backend.fleetItem!.network).toBe("nat");
  });

  /**
   * Best effort, like every other migration step: a `DescribeStacks` that
   * cannot be made is a note on the op, not a failed foundation update that
   * leaves the template half applied.
   */
  test("a stack that cannot be described is a note, not a failure", async () => {
    const backend = preV6("nat");
    backend.foundation.describeStack = async () => {
      throw new HermeticError("INTERNAL", "DescribeStacks is throttled");
    };
    const notes = await run(backend);
    expect(backend.fleetItem!.network).toBeUndefined();
    expect(notes.join("\n")).toContain("could not describe the foundation stack");
  });
});

/**
 * The repair path, which the migration list alone could not provide.
 *
 * A migration is keyed on the version a fleet is coming *from*, so
 * `migrationsBetween(6, 6)` is empty and the v6 hook never runs again once a
 * fleet is on v6. A cache that went stale afterwards — restored from an old
 * archive, written by a build with the bug, edited by hand — therefore had no
 * way back: `doctor` reported `network_mode_drift` and told the operator to run
 * `foundation update`, which did nothing, while `plan network --to <the stack's
 * own mode>` refused with `CONFLICT` because the stack was already there.
 * `foundation.update` now reconciles the cache on every run.
 */
describe("a stale _fleet.network on a fleet already at v6", () => {
  /** Milliseconds, not seconds: no test waits on a change set or a rollout poll. */
  const FAST: NonNullable<HermeticDeps["foundation"]> = {
    changeSetPollMs: 0,
    rolloutPollMs: 1,
    heartbeatMs: 60_000,
  };

  /**
   * The state the bug leaves behind: the stack really is `nat`, `_fleet` still
   * says `public`, and the fleet is already on the current foundation version so
   * there is no migration left to run.
   */
  function drifted(): MemoryBackend {
    const backend = seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
    backend.stack = {
      ...backend.stack!,
      parameters: { ...backend.stack!.parameters, Network: "nat" },
    };
    backend.fleetItem = { ...backend.fleetItem!, network: "public" };
    return backend;
  }

  test("is exactly the case the migration list cannot reach", () => {
    expect(migrationsBetween(FOUNDATION_VERSION, FOUNDATION_VERSION)).toEqual([]);
  });

  test("doctor sees it before the update", async () => {
    const backend = drifted();
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, foundation: FAST });
    const report = await hermetic.doctor();
    expect(report.network.consistent).toBe(false);
    expect(report.findings.some((f) => f.includes("network_mode_drift"))).toBe(true);
  });

  test("a same-version `foundation update` writes the cache back from the stack", async () => {
    const backend = drifted();
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, foundation: FAST });
    const events = await drain(hermetic.foundation.update({ yes: true }));

    expect(backend.fleetItem!.network).toBe("nat");
    // And says so, because core states and the head prints (rule 1).
    expect(events.some((e) => e.message.includes("network mode:"))).toBe(true);

    const report = await hermetic.doctor();
    expect(report.network.consistent).toBe(true);
    expect(report.findings.some((f) => f.includes("network_mode_drift"))).toBe(false);
  });

  test("a cache that already agrees is left exactly as it was", async () => {
    const backend = seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, foundation: FAST });
    await drain(hermetic.foundation.update({ yes: true }));
    expect(backend.fleetItem!.network).toBe("public");
  });
});
