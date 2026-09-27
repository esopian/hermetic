import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FIXTURE_CONFIG,
  MemoryBackend,
  fixtureConfigFor,
  seedFixtureFoundation,
} from "../src/backend/memory.ts";
import { testHermetic } from "./helpers.ts";
import { isHermeticError } from "../src/errors.ts";
import { FOUNDATION_VERSION } from "../src/version.ts";
import { openHermetic, openForInit } from "../src/open.ts";
import { listConfigs, openLocalDb, setDefaultFleet } from "../src/local/db/index.ts";
import type { ConfigStore } from "../src/hermetic.ts";
import type { LocalConfig } from "../src/schema/index.ts";

/**
 * §4.8. The fixture directory is process-global — it stands for "the account" —
 * so every test here says which account it is in rather than inheriting
 * whichever file ran last.
 */
/**
 * A local `fleets` table, in memory: what a home has frozen and what it
 * prefers. Keyed by `fleet_id` throughout, exactly as SQLite is (§4.6) — the
 * alias is a cached label on the row, never its key.
 */
function store(rows: LocalConfig[], preferred: string | null = null): ConfigStore {
  const frozen = [...rows];
  let deflt = preferred;
  return {
    write: async (config) => {
      const at = frozen.findIndex((c) => c.fleet_id === config.fleet_id);
      if (at === -1) frozen.push(config);
      else frozen[at] = config;
    },
    list: async () => [...frozen],
    read: async (fleetId) => frozen.find((c) => c.fleet_id === (fleetId ?? deflt)) ?? null,
    defaultFleet: async () => deflt,
    setDefaultFleet: async (fleetId) => {
      deflt = fleetId;
    },
  };
}

const MAIN_ID = FIXTURE_CONFIG.fleet_id;
const STAGING_ID = fixtureConfigFor("staging").fleet_id;

function core(backend: MemoryBackend, config: LocalConfig | null, configStore?: ConfigStore) {
  return testHermetic({
    backend,
    config,
    ...(configStore !== undefined ? { configStore } : {}),
  });
}

describe("fleets.list", () => {
  test("unions the local rows with the directory, one entry per name", async () => {
    const hermetic = core(
      seedFixtureFoundation(new MemoryBackend({ directory: "seeded" })),
      FIXTURE_CONFIG,
      store([FIXTURE_CONFIG], MAIN_ID),
    );
    const result = await hermetic.fleets.list();

    expect(result.directory_error).toBeNull();
    expect(result.fleets.map((f) => f.name)).toEqual(["main", "staging"]);

    const [main, staging] = result.fleets;
    // `main` is both frozen here and registered; `staging` is only registered —
    // this laptop can see it but has no credentials frozen for it.
    expect(main).toMatchObject({ local: true, registered: true, current: true, default: true });
    expect(staging).toMatchObject({ local: false, registered: true, current: false, default: false });
    expect(staging!.fleet_id).toBe(fixtureConfigFor("staging").fleet_id);
  });

  /** §6.6: the directory carries `foundation_version`, so "behind" is visible without opening a fleet. */
  test("flags the fleet whose foundation version is behind this build", async () => {
    const hermetic = core(
      seedFixtureFoundation(new MemoryBackend({ directory: "seeded" })),
      FIXTURE_CONFIG,
    );
    const { fleets } = await hermetic.fleets.list();
    const byName = new Map(fleets.map((f) => [f.name, f]));

    expect(byName.get("main")!.foundation_version).toBe(FOUNDATION_VERSION);
    expect(byName.get("main")!.update_available).toBe(false);
    expect(byName.get("staging")!.foundation_version).toBe(FOUNDATION_VERSION - 1);
    expect(byName.get("staging")!.update_available).toBe(true);
  });

  test("the fleet this core was opened as comes first, then the default, then by label", async () => {
    const staging = fixtureConfigFor("staging");
    const hermetic = core(
      seedFixtureFoundation(new MemoryBackend({ directory: "seeded" })),
      staging,
      store([FIXTURE_CONFIG, staging], MAIN_ID),
    );
    const { fleets } = await hermetic.fleets.list();
    expect(fleets.map((f) => f.name)).toEqual(["staging", "main"]);
    expect(fleets[0]).toMatchObject({ current: true, default: false });
    expect(fleets[1]).toMatchObject({ current: false, default: true });
  });

  /**
   * `fleet ls` is the command an operator reaches for when they are not sure
   * what they have. A directory it cannot read is reported *beside* the local
   * rows rather than instead of them.
   */
  test("a directory that cannot be read is reported, and the local rows still come back", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend({ directory: "seeded" }));
    backend.directory.list = async () => {
      throw new Error("AccessDeniedException: dynamodb:Scan");
    };
    const hermetic = core(backend, FIXTURE_CONFIG, store([FIXTURE_CONFIG], MAIN_ID));

    const result = await hermetic.fleets.list();
    expect(result.directory_error).toContain("AccessDeniedException");
    expect(result.fleets.map((f) => f.name)).toEqual(["main"]);
    expect(result.fleets[0]).toMatchObject({ local: true, registered: false });
    expect(result.fleets[0]!.update_available).toBe(false);
  });

  test("a home with nothing frozen does not go near the directory", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend({ directory: "seeded" }));
    let asked = false;
    backend.directory.list = async () => {
      asked = true;
      return [];
    };
    const result = await core(backend, null).fleets.list();
    expect(asked).toBe(false);
    expect(result.directory_error).toBe("not initialized");
    expect(result.fleets).toEqual([]);
  });
});

describe("fleets.use", () => {
  test("records the default as a fleet id and reports what it was", async () => {
    const staging = fixtureConfigFor("staging");
    const configStore = store([FIXTURE_CONFIG, staging], MAIN_ID);
    const hermetic = core(
      seedFixtureFoundation(new MemoryBackend({ directory: "seeded" })),
      FIXTURE_CONFIG,
      configStore,
    );

    expect(await hermetic.fleets.use({ fleet: "staging" })).toEqual({
      fleet_id: STAGING_ID,
      previous: MAIN_ID,
    });
    expect(await configStore.defaultFleet?.()).toBe(STAGING_ID);
    const { fleets } = await hermetic.fleets.list();
    expect(fleets.find((f) => f.fleet_id === STAGING_ID)!.default).toBe(true);
  });

  /**
   * Local only, and deliberately: a fleet this home has not frozen has no
   * profile, no region and no credentials here to mean. The refusal names the
   * *id* to attach to, because that is what `init --attach` takes.
   */
  test("a fleet that is in the directory but not frozen here is NOT_FOUND", async () => {
    const hermetic = core(
      seedFixtureFoundation(new MemoryBackend({ directory: "seeded" })),
      FIXTURE_CONFIG,
      store([FIXTURE_CONFIG], MAIN_ID),
    );
    try {
      await hermetic.fleets.use({ fleet: "staging" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(isHermeticError(e) && e.code).toBe("NOT_FOUND");
      expect((e as Error).message).toContain(`hermetic init --attach --fleet ${STAGING_ID}`);
    }
  });

  /**
   * §4.6: a fleet answers to its id as well as to its alias, through the same
   * `matchFleet` rule `--fleet` uses. What is *recorded* is always the id — an
   * alias may be reassigned by another laptop between two commands.
   */
  test("a fleet id selects the fleet and the id is what gets recorded", async () => {
    const staging = fixtureConfigFor("staging");
    const configStore = store([FIXTURE_CONFIG, staging], MAIN_ID);
    const hermetic = core(
      seedFixtureFoundation(new MemoryBackend({ directory: "seeded" })),
      FIXTURE_CONFIG,
      configStore,
    );

    expect(await hermetic.fleets.use({ fleet: staging.fleet_id })).toEqual({
      fleet_id: STAGING_ID,
      previous: MAIN_ID,
    });
    expect(await configStore.defaultFleet?.()).toBe(STAGING_ID);
  });

  /**
   * §4.7: a torn-down fleet keeps its alias reserved so nothing else can take
   * the label, and must never be *selected* by it. Without this a `fleet use
   * staging` lands on the fleet that used to be called `staging`.
   */
  test("a stale alias held by a torn-down fleet selects nothing", async () => {
    const staging = fixtureConfigFor("staging");
    const backend = seedFixtureFoundation(new MemoryBackend({ directory: "seeded" }));
    const entry = (await backend.directory.get(STAGING_ID))!;
    await backend.directory.update({ ...entry, status: "torn_down" });
    const hermetic = core(backend, FIXTURE_CONFIG, store([FIXTURE_CONFIG, staging], MAIN_ID));

    try {
      await hermetic.fleets.use({ fleet: "staging" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(isHermeticError(e) && e.code).toBe("NOT_FOUND");
    }
    // The id still selects it: a torn-down row is history, not a forbidden one.
    expect(await hermetic.fleets.use({ fleet: STAGING_ID })).toMatchObject({
      fleet_id: STAGING_ID,
    });
  });

  /** An alias whose fleet this home never froze names the id to attach to. */
  test("an alias pointing at a fleet not frozen here names that fleet's id", async () => {
    const hermetic = core(
      seedFixtureFoundation(new MemoryBackend({ directory: "seeded" })),
      FIXTURE_CONFIG,
      store([FIXTURE_CONFIG], MAIN_ID),
    );
    try {
      await hermetic.fleets.use({ fleet: "staging" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(isHermeticError(e) && e.code).toBe("NOT_FOUND");
      expect((e as Error).message).toContain(STAGING_ID);
    }
  });

  /** The refusal names each fleet's id, with its alias beside it. */
  test("an unknown token is refused with each fleet's id and alias", async () => {
    const hermetic = core(
      seedFixtureFoundation(new MemoryBackend({ directory: "seeded" })),
      FIXTURE_CONFIG,
      store([FIXTURE_CONFIG], MAIN_ID),
    );
    try {
      await hermetic.fleets.use({ fleet: "zzzzzzzz" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(isHermeticError(e) && e.code).toBe("NOT_FOUND");
      expect((e as Error).message).toContain(`${FIXTURE_CONFIG.fleet_id} (main)`);
    }
  });

  /**
   * A token that is neither an id nor an alias is simply not here. There is no
   * separate "that is not a legal name" refusal any more: the argument is not a
   * name being minted, it is a selector being matched.
   */
  test("a reserved token is NOT_FOUND like any other miss", async () => {
    const hermetic = core(
      seedFixtureFoundation(new MemoryBackend({ directory: "seeded" })),
      FIXTURE_CONFIG,
      store([FIXTURE_CONFIG]),
    );
    try {
      await hermetic.fleets.use({ fleet: "_fleet" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(isHermeticError(e) && e.code).toBe("NOT_FOUND");
    }
  });
});

describe("directory.status", () => {
  test("reports the table, its bounded backup window and every fleet in it", async () => {
    const status = await core(
      seedFixtureFoundation(new MemoryBackend({ directory: "seeded" })),
      FIXTURE_CONFIG,
    ).directory.status();

    expect(status.exists).toBe(true);
    expect(status.table).toBe("hermetic-directory");
    expect(status.billing_mode).toBe("PAY_PER_REQUEST");
    // §4.8: point-in-time recovery is the only backup, and it is bounded.
    expect(status.pitr_enabled).toBe(true);
    expect(status.pitr_recovery_days).toBe(7);
    expect(status.deletion_protection).toBe(true);
    expect(status.fleets.map((f) => f.name)).toEqual(["main", "staging"]);
    expect(status.item_count).toBe(2);
  });
});

/**
 * §4.8 through the door every head uses. Fixture mode has two fleets for the
 * same reason the fixture has twelve agents: so the switcher, the second board
 * and the "update available" badge all have something real to render offline.
 */
describe("fixture mode", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hermetic-fleets-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("opens `main` by default and `staging` when asked", async () => {
    const main = await openHermetic({ fixture: true, home });
    expect((await main.config.show()).fleet_id).toBe(MAIN_ID);
    expect((await main.agents.list()).length).toBeGreaterThan(2);

    const staging = await openHermetic({ fixture: true, home, fleet: "staging" });
    expect((await staging.config.show()).fleet_id).toBe(STAGING_ID);
    expect((await staging.agents.list()).map((a) => a.name).sort()).toEqual(["ember", "quill"]);
  });

  test("a fixture fleet that does not exist is NOT_FOUND, never a silent fall back", async () => {
    try {
      await openHermetic({ fixture: true, home, fleet: "prod" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(isHermeticError(e) && e.code).toBe("NOT_FOUND");
    }
  });

  test("`fleet use` in fixture mode survives the next open", async () => {
    const first = await openHermetic({ fixture: true, home });
    expect(await first.fleets.use({ fleet: "staging" })).toEqual({
      fleet_id: STAGING_ID,
      previous: MAIN_ID,
    });

    const second = await openHermetic({ fixture: true, home });
    expect((await second.config.show()).fleet_id).toBe(STAGING_ID);
    expect((await second.config.show()).default).toBe(true);
  });

  /**
   * §4.8: `FLEET_REQUIRED` has to be reachable in fixture mode. The CLI's
   * refusal and the portal's fleet picker are both developed against
   * `--fixture`, and a fixture that silently re-pointed the default at `main`
   * on every open would make the state they exist for impossible to get into.
   */
  test("a fixture home whose default was cleared refuses rather than guessing", async () => {
    await openHermetic({ fixture: true, home });
    const local = openLocalDb({ home, fixture: true });
    expect(listConfigs(local.db).map((c) => c.name)).toEqual(["main", "staging"]);
    setDefaultFleet(local.db, null);
    local.close();

    try {
      await openHermetic({ fixture: true, home });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(isHermeticError(e) && e.code).toBe("FLEET_REQUIRED");
      // Both ids, each with the alias it also answers to (§4.6).
      expect((e as Error).message).toMatch(/\w{8} \(main\), \w{8} \(staging\)/);
    }

    // Naming one still works, and the rows were not rewritten by the refusal.
    const chosen = await openHermetic({ fixture: true, home, fleet: "staging" });
    expect((await chosen.config.show()).fleet_id).toBe(STAGING_ID);

    /**
     * And its id names it just as well: `--fleet` takes either, because the id
     * is what the fleet *is* and the alias is a label over it (§4.6).
     */
    const byId = await openHermetic({ fixture: true, home, fleet: STAGING_ID });
    expect((await byId.config.show()).fleet_id).toBe(STAGING_ID);
  });

  /**
   * And the instance a portal falls back to when it *has* refused: no fleet is
   * selected, so there is no account to guard the directory read with — but the
   * local rows are exactly what the picker needs, and they come back.
   */
  test("the pre-init instance lists the home's fleets so a picker has something to draw", async () => {
    await openHermetic({ fixture: true, home });
    const local = openLocalDb({ home, fixture: true });
    setDefaultFleet(local.db, null);
    local.close();

    const session = await openForInit({ fixture: true, home });
    const result = await session.hermetic.fleets.list();
    expect(result.directory_error).toBe("no fleet selected");
    expect(result.fleets.map((f) => f.name)).toEqual(["main", "staging"]);
    expect(result.fleets.every((f) => f.local)).toBe(true);
    expect(result.fleets.every((f) => !f.current)).toBe(true);
    expect(result.fleets.every((f) => !f.default)).toBe(true);
    session.close();
  });

  test("both fixture fleets are listed, and both are frozen locally", async () => {
    const hermetic = await openHermetic({ fixture: true, home });
    const { fleets } = await hermetic.fleets.list();
    expect(fleets.map((f) => f.name)).toEqual(["main", "staging"]);
    expect(fleets.every((f) => f.local && f.registered)).toBe(true);
  });
});
