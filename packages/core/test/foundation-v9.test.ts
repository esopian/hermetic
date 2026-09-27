/**
 * The v9 foundation migration (§4.6/§4.8): the account directory moves off the
 * fleet's *name* and onto its `fleet_id`, and the name it carried becomes a
 * reserved display alias.
 *
 * Same shape as `foundation-v3.test.ts` — the migration entry is pulled out of
 * the shipped list and run directly, because what is under test is the hook and
 * not the twelve phases of `foundation.update` around it.
 *
 * The directory is account-global (§4.8): it is not owned by any fleet's stack,
 * so this hook runs once per account and reports "already keyed by fleet id"
 * for every fleet after the first — which is also what a re-run of a failed
 * update has to report, and the only reason it is safe to run on every one.
 */
import { describe, expect, test } from "bun:test";
import { FIXTURE_CONFIG, MemoryBackend } from "../src/backend/memory.ts";
import { FOUNDATION_MIGRATIONS } from "../src/fleet/foundation-migrations.ts";
import type { FoundationMigrationDeps } from "../src/fleet/foundation-migrations.ts";
import { HermeticError } from "../src/errors.ts";
import { seedFixtureFleet } from "../src/backend/memory.ts";

const V9 = FOUNDATION_MIGRATIONS.find((m) => m.version === 9)!;
const NOW = "2026-09-14T00:00:00.000Z";

function depsFor(backend: MemoryBackend): FoundationMigrationDeps & { notes: string[] } {
  return {
    backend,
    fleet: backend.fleetItem!,
    actor: FIXTURE_CONFIG.frozen_by,
    nowIso: () => NOW,
    notes: [],
  };
}

async function run(backend: MemoryBackend): Promise<string[]> {
  const deps = depsFor(backend);
  await V9.remote?.(deps);
  backend.fleetItem = deps.fleet;
  return deps.notes;
}

describe("the v9 foundation migration", () => {
  test("is in the shipped list, with a hook and a sentence", () => {
    expect(V9.describe).toContain("display aliases");
    expect(typeof V9.remote).toBe("function");
    // Nothing moves on the laptop, and nothing has to move before the stack.
    expect(V9.local).toBeUndefined();
    expect(V9.before).toBeUndefined();
  });

  test("asks the directory to move its rows, and says what moved", async () => {
    const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
    let asked = 0;
    backend.directory.migrate = async () => {
      asked += 1;
      return { fleets: 2, aliases: 2, duplicates: 0 };
    };
    const notes = await run(backend);
    expect(asked).toBe(1);
    expect(notes.join("\n")).toContain("moved 2 directory row(s) onto their fleet id");
    expect(notes.join("\n")).toContain("reserved 2 display alias(es)");
  });

  /**
   * Idempotent, and it says so rather than saying nothing: the hook runs on
   * every fleet's update in the account and on every re-run of one that failed
   * later, so "there was nothing to do" has to be a reportable outcome.
   */
  test("a directory already keyed by fleet id is a reported no-op", async () => {
    const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
    const notes = await run(backend);
    expect(notes.join("\n")).toContain("already keyed by fleet id");
    // A second pass says exactly the same thing.
    expect((await run(backend)).join("\n")).toContain("already keyed by fleet id");
  });

  test("an interrupted pre-v9 rename's leftover row is reported as history", async () => {
    const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
    backend.directory.migrate = async () => ({ fleets: 1, aliases: 1, duplicates: 1 });
    const notes = await run(backend);
    expect(notes.join("\n")).toContain("kept 1 older row(s) as history");
  });

  /**
   * Best effort, like every other hook here. A fleet whose stack has already
   * taken the new template must not be left on the old contract version because
   * one account-level table could not be read — so the failure is a note and
   * the operator is told to run the update again.
   */
  test("a directory that cannot be reached is a note, not a failed update", async () => {
    const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
    backend.directory.migrate = async () => {
      throw new HermeticError("DIRECTORY_UNAVAILABLE", "dynamodb:Scan denied");
    };
    const notes = await run(backend);
    expect(notes.join("\n")).toContain("could not migrate the account's fleet directory");
    expect(notes.join("\n")).toContain("dynamodb:Scan denied");
  });
});
