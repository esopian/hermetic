import { describe, expect, test } from "bun:test";
import {
  FIXTURE_FLEETS,
  FIXTURE_TAILNET,
  MemoryBackend,
  createFixtureAccount,
  fixtureBackend,
  fixtureConfigFor,
  isFixtureFleet,
  resetFixtureAccount,
} from "../src/backend/memory.ts";
import { DEFAULT_DIRECTORY_REGION, DIRECTORY_PITR_DAYS, DIRECTORY_TABLE } from "../src/schema/index.ts";
import { FOUNDATION_VERSION } from "../src/version.ts";
import { HermeticError } from "../src/errors.ts";

/**
 * The fixture directory is a `FixtureAccount` the backend is handed (the portal
 * builds a fresh `MemoryBackend` per fleet switch and passes the same account
 * to each), so two backends share one only when a test says so, and nothing
 * leaks from one test into the next.
 */
/** The fixture fleets' immutable ids: what the directory is keyed by (§4.6). */
const MAIN_ID = "fxtr0001";

describe("the seeded directory", () => {
  test("holds both fixture fleets, active, sorted by label", async () => {
    const fleets = await new MemoryBackend({ directory: "seeded" }).directory.list();
    expect(fleets.map((f) => f.name)).toEqual(["main", "staging"]);
    expect(fleets.every((f) => f.status === "active")).toBe(true);
    expect(fleets.every((f) => f.tailnet === FIXTURE_TAILNET)).toBe(true);
  });

  test("staging is one foundation version behind, so exactly one fleet has an update", async () => {
    const fleets = await new MemoryBackend({ directory: "seeded" }).directory.list();
    const byName = Object.fromEntries(fleets.map((f) => [f.name, f]));
    expect(byName["main"]?.foundation_version).toBe(FOUNDATION_VERSION);
    expect(byName["staging"]?.foundation_version).toBe(FOUNDATION_VERSION - 1);
  });

  test("each entry names the stack of the fleet it describes", async () => {
    // §4.6: the directory is read by `fleet_id`, never by the display alias.
    const staging = await new MemoryBackend({ directory: "seeded" }).directory.get("sg7k2m4p");
    expect(staging?.fleet_id).toBe("sg7k2m4p");
    expect(staging?.stack_id).toContain("hermetic-sg7k2m4p");
    expect(staging?.region).toBe(fixtureConfigFor("staging").region);
  });

  test("status reports the table facts a head renders in Diagnostics", async () => {
    const status = await new MemoryBackend({ directory: "seeded" }).directory.status();
    expect(status).toMatchObject({
      region: DEFAULT_DIRECTORY_REGION,
      table: DIRECTORY_TABLE,
      exists: true,
      billing_mode: "PAY_PER_REQUEST",
      pitr_enabled: true,
      pitr_recovery_days: DIRECTORY_PITR_DAYS,
      deletion_protection: true,
      item_count: 2,
    });
  });

  test("is shared across backends given the same account, because it describes the account and not a fleet", async () => {
    const account = createFixtureAccount("seeded");
    const first = new MemoryBackend({ account });
    const second = new MemoryBackend({ account });
    const main = await first.directory.get(MAIN_ID);
    expect(main).not.toBeNull();
    if (!main) return;
    await first.directory.update({ ...main, status: "tearing_down" });
    expect((await second.directory.get(MAIN_ID))?.status).toBe("tearing_down");
  });
});

describe("register / update", () => {
  test("register refuses an alias that is already in the directory", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const main = await backend.directory.get(MAIN_ID);
    if (!main) throw new Error("unreachable: the fixture seeds main");
    expect(await backend.directory.register(main)).toBe(false);
    // A second fleet may not take `main`'s alias, whatever its own id.
    expect(await backend.directory.register({ ...main, fleet_id: "scr4tch1" })).toBe(false);
    expect(await backend.directory.register({ ...main, fleet_id: "scr4tch1", name: "scratch" })).toBe(
      true,
    );
    expect((await backend.directory.list()).map((f) => f.name)).toEqual(["main", "scratch", "staging"]);
  });

  test("update refuses a fleet nobody registered", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const main = await backend.directory.get(MAIN_ID);
    if (!main) throw new Error("unreachable: the fixture seeds main");
    expect(await backend.directory.update({ ...main, fleet_id: "gh0stgh0", name: "ghost" })).toBe(
      false,
    );
  });

  test("the three mutations are recorded; the reads are not", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const main = await backend.directory.get(MAIN_ID);
    if (!main) throw new Error("unreachable: the fixture seeds main");
    backend.resetMutations();
    await backend.directory.list();
    await backend.directory.status();
    await backend.directory.ensure();
    await backend.directory.register({ ...main, fleet_id: "scr4tch1", name: "scratch" });
    await backend.directory.update({ ...main, name: "scratch" });
    expect(backend.mutations).toEqual(["directory.ensure", "directory.register", "directory.update"]);
  });

  test("entries are copied in and out, so a caller cannot mutate the directory by reference", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const main = await backend.directory.get(MAIN_ID);
    if (!main) throw new Error("unreachable: the fixture seeds main");
    main.status = "torn_down";
    expect((await backend.directory.get(MAIN_ID))?.status).toBe("active");
  });

  test("resetFixtureAccount puts the seed back, in place, for every backend holding the account", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const main = await backend.directory.get(MAIN_ID);
    if (!main) throw new Error("unreachable: the fixture seeds main");
    await backend.directory.register({ ...main, fleet_id: "scr4tch1", name: "scratch" });
    resetFixtureAccount(backend.account);
    expect((await backend.directory.list()).map((f) => f.name)).toEqual(["main", "staging"]);
  });

  test("two backends without a shared account are two accounts", async () => {
    const first = new MemoryBackend({ directory: "seeded" });
    const second = new MemoryBackend({ directory: "seeded" });
    const main = await first.directory.get(MAIN_ID);
    if (!main) throw new Error("unreachable: the fixture seeds main");
    await first.directory.update({ ...main, status: "tearing_down" });
    expect((await second.directory.get(MAIN_ID))?.status).toBe("active");
    // And a bare backend is the pristine account `init --create` walks.
    expect((await new MemoryBackend().directory.status()).exists).toBe(false);
  });
});

describe("fixtureBackend by fleet", () => {
  test("main is unchanged: the twelve seeded agents and the fixture config", async () => {
    const { backend, config } = fixtureBackend();
    expect(config).toEqual(fixtureConfigFor("main"));
    expect(config.name).toBe("main");
    expect(config.fleet_id).toBe("fxtr0001");
    expect(backend.fleetItem?.foundation_version).toBe(FOUNDATION_VERSION);
    expect((await backend.store.agents.scan()).length).toBeGreaterThan(2);
  });

  test("staging is two agents on a fleet one foundation version behind", async () => {
    const { backend, config } = fixtureBackend({ fleet: "staging" });
    expect(config.name).toBe("staging");
    expect(config.fleet_id).toBe("sg7k2m4p");
    expect(backend.fleetItem?.fleet_id).toBe("sg7k2m4p");
    expect(backend.fleetItem?.foundation_version).toBe(FOUNDATION_VERSION - 1);

    const agents = await backend.store.agents.scan();
    expect(agents.map((a) => a.name).sort()).toEqual(["ember", "quill"]);
    expect(agents.find((a) => a.name === "ember")?.status).toBe("ready");
    expect(agents.find((a) => a.name === "quill")?.status).toBe("stopped");
  });

  test("the two fleets do not share a stack", () => {
    const main = fixtureBackend().backend.stack?.stack_name;
    const staging = fixtureBackend({ fleet: "staging" }).backend.stack?.stack_name;
    expect(main).toBe("hermetic-fxtr0001");
    expect(staging).toBe("hermetic-sg7k2m4p");
  });

  test("an unknown fleet is NOT_FOUND and names the ones that exist", () => {
    const e = (() => {
      try {
        fixtureConfigFor("prod");
        return null;
      } catch (err: unknown) {
        return err;
      }
    })();
    expect(e).toBeInstanceOf(HermeticError);
    expect((e as HermeticError).code).toBe("NOT_FOUND");
    expect((e as HermeticError).message).toContain("main, staging");
  });

  test("isFixtureFleet narrows an operator-supplied name", () => {
    expect(FIXTURE_FLEETS).toEqual(["main", "staging"]);
    expect(isFixtureFleet("staging")).toBe(true);
    expect(isFixtureFleet("prod")).toBe(false);
  });

  /**
   * §4.6: `--fleet` and `HERMETIC_FLEET` take either spelling, and everything a
   * seeder varies between the two fixture fleets is keyed on the canonical
   * name — so an id has to resolve to it rather than quietly seeding `main`.
   */
  test("a fixture fleet id seeds that fleet, not the default one", async () => {
    const { backend, config } = fixtureBackend({ fleet: "sg7k2m4p" });
    expect(config).toEqual(fixtureConfigFor("staging"));
    expect(backend.fleetItem?.foundation_version).toBe(FOUNDATION_VERSION - 1);
    expect((await backend.store.agents.scan()).map((a) => a.name).sort()).toEqual(["ember", "quill"]);
  });
});
