/**
 * The shipped v13 foundation migration (§6.6): the `_fleet` revision counter,
 * and the repair of the fleet-scoped secret copies v3 was allowed to leave half
 * done.
 *
 * v3's copy is required *now*, so a slot it cannot finish fails the update with
 * nothing stamped. That does nothing for a fleet the older, best-effort path
 * already carried past v3: there the failure became a note under a stamped
 * version, `migrationsBetween` has not offered v3 since, and the destination is
 * still absent or still holds hermetic's placeholder while the legacy source
 * still holds the value. v13 is the first version after the fix, so it carries
 * it — the same routine in `repair` mode, filling only what is empty, from
 * sources that are not, and silent on a fleet with nothing of the kind.
 *
 * The fixture fleet is seeded *post*-v3 (scoped paths, no legacy ones), which
 * is the shape this is pointed at; `foundation-v3.test.ts` owns the pre-v3
 * shape and the copy's own contract.
 */
import { describe, expect, test } from "bun:test";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { FOUNDATION_MIGRATIONS } from "../src/fleet/foundation-migrations.ts";
import type { FoundationMigrationDeps } from "../src/fleet/foundation-migrations.ts";
import { FOUNDATION_VERSION } from "../src/version.ts";
import { HermeticError } from "../src/errors.ts";
import type { OpEvent } from "../src/schema/index.ts";
import { createFoundation, type FoundationDeps } from "../src/fleet/foundation/index.ts";
import { OFFLINE_HERMES_RELEASE, drain, testContext } from "./helpers.ts";

/** The real `foundation.update`, wired to a fixture backend and the shipped migrations. */
function foundationDeps(backend: MemoryBackend): FoundationDeps {
  return {
    ctx: testContext(backend, {
      guardAccount: async () => {},
      guardFleet: async () => ({
        config: FIXTURE_CONFIG,
        fleet: backend.fleetItem!,
        stack: backend.stack!,
      }),
      actor: async () => FIXTURE_CONFIG.frozen_by,
      appendEvent: async () => {},
      nowIso: () => backend.now().toISOString(),
    }),
    hermesFetch: OFFLINE_HERMES_RELEASE,
    lockTtlMs: 60_000,
    changeSetPollMs: 0,
    rolloutPollMs: 1,
    rolloutWaitMs: 0,
    heartbeatMs: 60_000,
  };
}

const V13 = FOUNDATION_MIGRATIONS.find((m) => m.version === 13)!;
const FLEET_ID = FIXTURE_CONFIG.fleet_id;
const NOW = "2026-09-16T00:00:00.000Z";
const SOURCE = "/hermes/atlas/ts-key";
const TARGET = `/hermes/${FLEET_ID}/atlas/ts-key`;
/** Never a real key: the leak-grep owns the rest of this (§8.3). */
const LEFT_BEHIND = "tskey-FIXTURE-LEFT-BEHIND";

/**
 * A fleet the old best-effort path stamped past v3, as `secrets verify` finds
 * it today: the legacy source still holds the value, and the fleet-scoped
 * destination holds nothing but the placeholder `ensureSlot` wrote.
 */
async function strandedCopy(): Promise<MemoryBackend> {
  const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
  backend.fleetItem = { ...backend.fleetItem!, foundation_version: 11 };
  backend.params.set(SOURCE, LEFT_BEHIND);
  // Exactly what a copy interrupted between the slot and the value leaves: the
  // destination declared, and nothing in it.
  backend.params.delete(TARGET);
  await backend.secrets.ensureSlot(TARGET);
  expect(await backend.secrets.isPlaceholder(TARGET)).toBe(true);
  backend.resetMutations();
  return backend;
}

function depsFor(backend: MemoryBackend): FoundationMigrationDeps & { notes: string[] } {
  return {
    backend,
    fleet: backend.fleetItem!,
    actor: FIXTURE_CONFIG.frozen_by,
    nowIso: () => NOW,
    notes: [],
    // The only thing the repair waits for is a re-read of a slot it has just
    // written, and a suite must not spend real seconds proving it gave up.
    sleep: async () => {},
  };
}

/** Both halves, in the order `foundation.update` runs them. */
async function run(backend: MemoryBackend): Promise<string[]> {
  const deps = depsFor(backend);
  await V13.before?.(deps);
  await V13.remote?.(deps);
  // The hooks patch `deps.fleet` in place; the stamp writes it back (§6.6).
  backend.fleetItem = deps.fleet;
  return deps.notes;
}

describe("the v13 foundation migration", () => {
  test("it is an entry with a required pre-stack step", () => {
    expect(V13.version).toBe(13);
    expect(V13.before).toBeDefined();
    // Not because a template depends on it — because the stamp does. A failure
    // recorded as a note under a stamped v13 is one nothing ever retries, which
    // is the shape this entry exists to undo.
    expect(V13.beforeRequired).toBe(true);
  });

  /**
   * The repair itself, through the real op rather than the hook: a fleet on v11
   * whose destination the old path left as a placeholder comes out of the
   * update holding the value, and the event that says so names the slot.
   */
  test("a fleet stamped past v3 with a placeholder left behind is repaired by v13", async () => {
    const backend = await strandedCopy();

    const events: OpEvent[] = await drain(
      createFoundation(foundationDeps(backend)).update({ yes: true }),
    );

    expect(backend.params.get(TARGET)).toBe(LEFT_BEHIND);
    expect(await backend.secrets.isPlaceholder(TARGET)).toBe(false);
    // Kept, not moved: a rolled-back hermetic still reads the legacy path.
    expect(backend.params.get(SOURCE)).toBe(LEFT_BEHIND);
    expect(backend.fleetItem!.foundation_version).toBe(FOUNDATION_VERSION);

    const said = events.map((e) => e.message).join("\n");
    expect(said).toContain(TARGET);
    expect(said).toContain("an earlier update left empty");
    // The path, never the value (§8.3).
    expect(said).not.toContain(LEFT_BEHIND);

    // And the repair landed before the stack update, like every pre-stack step.
    const put = backend.mutations.indexOf("secrets.put");
    const execute = backend.mutations.indexOf("foundation.executeChangeSet");
    expect(put).toBeGreaterThanOrEqual(0);
    expect(put).toBeLessThan(execute);
  });

  /**
   * The keep rule, which is v3's and unchanged: a destination holding a value
   * may hold a key rotated since the copy, and the stale original must never be
   * written over it.
   */
  test("v13 leaves a destination that already holds a value alone", async () => {
    const backend = await strandedCopy();
    // A second slot, this one copied successfully long ago and pushed to since:
    // the legacy original is stale and must not be written back over it.
    const rotatedSource = "/hermetic/secrets/nous-key";
    const rotatedTarget = `/hermetic/${FLEET_ID}/secrets/nous-key`;
    backend.params.set(rotatedSource, "FIXTURE-STALE-ORIGINAL");
    backend.params.set(rotatedTarget, "FIXTURE-ROTATED-SINCE");

    const notes = await run(backend);

    expect(backend.params.get(rotatedTarget)).toBe("FIXTURE-ROTATED-SINCE");
    // And the repair did run, so the keep is a decision rather than an absence.
    expect(backend.params.get(TARGET)).toBe(LEFT_BEHIND);
    expect(notes.join("\n")).toContain(TARGET);
    expect(notes.join("\n")).not.toContain(rotatedTarget);
  });

  /**
   * And the fleet every other fleet is: nothing stranded, nothing to say. The
   * repair runs on every update from here on, so a note on each of them would
   * bury the one fleet that had something wrong with it.
   */
  test("v13 with nothing to repair is silent", async () => {
    const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
    backend.fleetItem = { ...backend.fleetItem!, foundation_version: 11, version: 3 };
    const before = new Map(backend.params);

    const deps = depsFor(backend);
    expect(V13.before).toBeDefined();
    await V13.before!(deps);

    expect(new Map(backend.params)).toEqual(before);
    expect(deps.notes).toEqual([]);
  });

  /**
   * The refusals are v3's too. Without the directory there is no list of fleet
   * ids to check an agent name against, so `/hermes/<agent>/` cannot be told
   * apart from another fleet's scoped root — and a step that cannot prove whose
   * a path is must stop rather than guess, before anything is stamped.
   */
  test("an unreadable directory stops the repair rather than guessing", async () => {
    const backend = await strandedCopy();
    backend.directory.list = async () => {
      throw new HermeticError("DIRECTORY_UNAVAILABLE", "the directory table is not readable");
    };

    let failure: HermeticError | null = null;
    try {
      await run(backend);
    } catch (e) {
      failure = e as HermeticError;
    }
    expect(failure?.code).toBe("FOUNDATION_UPDATE_FAILED");
    expect(await backend.secrets.isPlaceholder(TARGET)).toBe(true);
    expect(backend.fleetItem!.foundation_version).toBe(11);
  });

  /** The counter, which is the rest of the entry and unchanged by the repair. */
  test("seeds the _fleet revision counter at 0 and leaves an existing one alone", async () => {
    const backend = await strandedCopy();
    backend.fleetItem = { ...backend.fleetItem!, version: undefined };

    const notes = await run(backend);
    expect(backend.fleetItem!.version).toBe(0);
    expect(notes.join("\n")).toContain("had no revision counter");

    backend.fleetItem = { ...backend.fleetItem!, version: 7 };
    const again = await run(backend);
    expect(backend.fleetItem!.version).toBe(7);
    expect(again.join("\n")).not.toContain("had no revision counter");
  });
});
