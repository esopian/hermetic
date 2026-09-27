/**
 * The re-run contract the migration hooks make (§6.6 step 5).
 *
 * `FOUNDATION_MIGRATIONS` has one entry and that entry has no hooks, so the
 * promise `foundation-migrations.ts` makes in prose — *"Must be idempotent: a
 * `foundation.update` that fails in a later phase is re-run from the start, and
 * this hook runs again"* — had never been executed by anything. These tests
 * hand the runner throwaway migrations with real `remote` and `local` hooks and
 * hold it to that sentence.
 *
 * Nothing here touches `FOUNDATION_VERSION` or the template digest table: the
 * throwaway entries are numbered above the shipped one and reached through
 * `FoundationDeps.migrations`, which exists for exactly this and which nothing
 * in production passes.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFoundation } from "../src/backend/memory.ts";
import type { FleetItem, OpEvent } from "../src/schema/index.ts";
import { FOUNDATION_VERSION } from "../src/version.ts";
import { createFoundation, type FoundationDeps } from "../src/fleet/foundation/index.ts";
import type { FoundationMigration } from "../src/fleet/foundation-migrations.ts";
import { HermeticError } from "../src/errors.ts";
import { OFFLINE_HERMES_RELEASE, drain, testContext } from "./helpers.ts";

/**
 * Two versions past whatever this build ships, so both entries always apply —
 * derived from `FOUNDATION_VERSION` rather than written down, because the
 * shipped version moves (AGENTS.md rule 7) and a hard-coded pair silently stops
 * being "above it" the next time it does.
 */
const V2 = FOUNDATION_VERSION + 1;
const V3 = FOUNDATION_VERSION + 2;

function deps(backend: MemoryBackend, over: Partial<FoundationDeps> = {}): FoundationDeps {
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
    foundationVersion: V3,
    hermesFetch: OFFLINE_HERMES_RELEASE,
    lockTtlMs: 60_000,
    changeSetPollMs: 0,
    rolloutPollMs: 1,
    rolloutWaitMs: 0,
    heartbeatMs: 60_000,
    ...over,
  };
}

/**
 * A pair of throwaway migrations whose `remote` hooks write to a store that is
 * safe to write twice — a keyed put, not an append — which is what "idempotent"
 * means for a real one (back-fill this attribute, move that key).
 */
function throwaway(options: { failV3?: () => boolean } = {}) {
  const remote = new Map<string, string>();
  const calls: number[] = [];
  const seenFleetVersions: Array<number | undefined> = [];
  const migrations: FoundationMigration[] = [
    {
      version: V2,
      describe: "back-fill a thing",
      remote: async ({ fleet, actor, nowIso }) => {
        calls.push(V2);
        seenFleetVersions.push(fleet.foundation_version);
        remote.set("thing", `${actor}@${nowIso().slice(0, 4)}`);
      },
    },
    {
      version: V3,
      describe: "move a key",
      remote: async ({ backend }) => {
        calls.push(V3);
        if (options.failV3?.()) {
          throw new HermeticError("INTERNAL", "the migration blew up halfway");
        }
        remote.set("fleet_id", (await backend.store.fleet.get())!.fleet_id);
      },
    },
  ];
  return { migrations, remote, calls, seenFleetVersions };
}

function seeded(): MemoryBackend {
  return seedFixtureFoundation(new MemoryBackend());
}

function fleetOf(backend: MemoryBackend): FleetItem {
  return backend.fleetItem!;
}

function messages(events: readonly OpEvent[], phase: string): string[] {
  return events.filter((e) => e.phase === phase).map((e) => e.message);
}

describe("foundation migrations", () => {
  test("every entry above the fleet's version runs, in order, against the pre-stamp row", async () => {
    const backend = seeded();
    const before = fleetOf(backend).foundation_version;
    const { migrations, remote, calls, seenFleetVersions } = throwaway();

    const events = await drain(createFoundation(deps(backend, { migrations })).update({ yes: true }));

    expect(calls).toEqual([V2, V3]);
    // §6.6: the hooks see the row as it stands *before* the stamp of step 5.
    expect(seenFleetVersions).toEqual([before]);
    expect([...remote.keys()].sort()).toEqual(["fleet_id", "thing"]);
    // And each one named itself in the stream the operator is watching.
    expect(messages(events, "migrate").join("\n")).toContain(`v${V3}: move a key`);
    expect(fleetOf(backend).foundation_version).toBe(V3);
  });

  /**
   * The contract itself. A hook that throws takes the whole op down *before*
   * the stamp, so the fleet is still on the old version, the lock is released,
   * and the same command run again re-applies every entry from the start —
   * including the one that already succeeded, which is why they must be safe to
   * run twice. The end state must be indistinguishable from one clean run.
   */
  test("a hook that throws halfway leaves the fleet re-runnable, and the re-run is idempotent", async () => {
    const backend = seeded();
    const before = fleetOf(backend).foundation_version;
    let blowUp = true;
    const { migrations, remote, calls } = throwaway({ failV3: () => blowUp });
    const core = createFoundation(deps(backend, { migrations }));

    let code: string | null = null;
    try {
      await drain(core.update({ yes: true }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).not.toBeNull();
    // Not stamped, not locked: the op is re-runnable rather than wedged.
    expect(fleetOf(backend).foundation_version).toBe(before);
    expect(fleetOf(backend).lock).toBeNull();
    expect(calls).toEqual([V2, V3]);
    // The half that did run left its state behind, as a real one would.
    expect(remote.get("thing")).toBeDefined();
    const afterFailure = remote.get("thing");

    blowUp = false;
    await drain(core.update({ yes: true }));

    // Both hooks ran again — and writing the same thing twice changed nothing.
    expect(calls).toEqual([V2, V3, V2, V3]);
    expect(remote.get("thing")).toBe(afterFailure!);
    expect([...remote.keys()].sort()).toEqual(["fleet_id", "thing"]);
    expect(fleetOf(backend).foundation_version).toBe(V3);
  });

  test("a fleet already at this version runs no migration at all", async () => {
    const backend = seeded();
    const { migrations, calls } = throwaway();
    await drain(createFoundation(deps(backend, { migrations })).update({ yes: true }));
    expect(calls).toEqual([V2, V3]);

    await drain(createFoundation(deps(backend, { migrations })).update({ yes: true }));
    expect(calls).toEqual([V2, V3]);
  });

  /**
   * §6.6: a `before` hook is best effort, exactly as its doc comment says. It
   * runs before CloudFormation is touched, so a failure there has changed
   * nothing — and stopping the update would strand the operator with a
   * half-run op and no way to re-run it. The reason is said, on a `warn`, and
   * the update carries on.
   */
  test("a pre-stack hook that throws is reported and does not stop the update", async () => {
    const migrations: FoundationMigration[] = [
      {
        version: V2,
        describe: "move something before the stack",
        before: async () => {
          throw new HermeticError("INTERNAL", "the pre-stack step blew up");
        },
      },
    ];
    const backend = seeded();
    const events = await drain(createFoundation(deps(backend, { migrations })).update({ yes: true }));

    const warned = events.filter((e) => e.phase === "archive" && e.level === "warn");
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toContain("the pre-stack step blew up");
    expect(warned[0]!.message).toContain("re-runs it");
    // Carried on: the stack was updated and the fleet reached the new version.
    expect(events.at(-1)).toMatchObject({ phase: "done" });
    expect(fleetOf(backend).foundation_version).toBe(V3);
  });

  /**
   * The `local` hook runs against the laptop's own database, which a fixture or
   * a test process does not have. That is a *warning*, not a failure — the
   * remote half of the migration has still happened, and the local half runs on
   * the next real-mode update.
   */
  test("a local hook re-runs with the rest, and is skipped with a warning where there is no database", async () => {
    const db = new Database(":memory:");
    let localCalls = 0;
    let blowUp = true;
    const migrations: FoundationMigration[] = [
      {
        version: V2,
        describe: "add a local column",
        local: (open) => {
          localCalls += 1;
          open.run(`CREATE TABLE IF NOT EXISTS migrated (version INTEGER PRIMARY KEY)`);
          open.run(`INSERT OR REPLACE INTO migrated (version) VALUES (?)`, [V2]);
        },
      },
      {
        version: V3,
        describe: "and something remote that fails the first time",
        remote: async () => {
          if (blowUp) throw new HermeticError("INTERNAL", "the migration blew up halfway");
        },
      },
    ];

    const withDb = seeded();
    const core = createFoundation(deps(withDb, { migrations, localDb: db }));
    await expect(drain(core.update({ yes: true }))).rejects.toThrow();
    expect(localCalls).toBe(1);

    // The re-run applies it a second time, over a database that already has it:
    // `IF NOT EXISTS` + `OR REPLACE` is what makes that a no-op rather than a
    // duplicate row, and it is why the contract demands idempotence.
    blowUp = false;
    await drain(core.update({ yes: true }));
    expect(localCalls).toBe(2);
    expect(db.query(`SELECT version FROM migrated`).all()).toEqual([{ version: V2 }]);
    expect(fleetOf(withDb).foundation_version).toBe(V3);

    const noDb = seeded();
    const events = await drain(createFoundation(deps(noDb, { migrations })).update({ yes: true }));
    // The one warning this test is about. The `migrate` phase also warns when
    // the account's directory has no entry for this fleet — process-global
    // state another file may have left — and that is a different sentence.
    const warned = events.filter(
      (e) => e.phase === "migrate" && e.level === "warn" && e.message.includes("local database"),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toContain("no local database");
    // Warned, not failed: the update still reached the stamp.
    expect(fleetOf(noDb).foundation_version).toBe(V3);
  });
});
