/**
 * §4.6/§4.8: the display alias — optional, mutable, account-unique, and never
 * the thing anything is keyed on.
 *
 * `fleets.alias` is the only write that changes what a fleet is *called*, and
 * these are the rules it has to keep: a fleet is created without one, a label
 * may be assigned, replaced and cleared without touching the fleet, and a label
 * belongs to exactly one fleet in the account — including a fleet that has been
 * torn down, whose label stays reserved so it cannot silently start meaning
 * something else.
 */
import { describe, expect, test } from "bun:test";
import { MemoryBackend } from "../src/backend/memory.ts";
import { fixtureConfigFor } from "../src/backend/fixture/memory-fixture.ts";
import { createFleets } from "../src/fleet/fleets.ts";
import { isHermeticError } from "../src/errors.ts";
import type { ConfigStore } from "../src/hermetic.ts";
import type { LocalConfig } from "../src/schema/index.ts";

const MAIN = fixtureConfigFor("main");
const STAGING = fixtureConfigFor("staging");

/** A home holding the rows it is given, keyed by `fleet_id` as SQLite is. */
function home(rows: LocalConfig[], preferred: string | null = null) {
  let frozen = [...rows];
  let deflt = preferred;
  const configStore: ConfigStore = {
    list: async () => [...frozen],
    read: async (fleetId) => frozen.find((r) => r.fleet_id === (fleetId ?? deflt)) ?? null,
    defaultFleet: async () => deflt,
    setDefaultFleet: async (fleetId) => {
      deflt = fleetId;
    },
    write: async (next) => {
      frozen = frozen.some((r) => r.fleet_id === next.fleet_id)
        ? frozen.map((r) => (r.fleet_id === next.fleet_id ? next : r))
        : [...frozen, next];
    },
  };
  return {
    configStore,
    get rows(): LocalConfig[] {
      return frozen;
    },
    get default(): string | null {
      return deflt;
    },
  };
}

function fleetsOver(backend: MemoryBackend, store: ReturnType<typeof home>, config = MAIN) {
  return createFleets({ backend, config, foundationVersion: 9, configStore: store.configStore });
}

describe("assigning, replacing and clearing an alias", () => {
  test("assigns a label without moving the default, which is a fleet id", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const store = home([MAIN, STAGING], MAIN.fleet_id);
    const fleets = fleetsOver(backend, store);

    const changed = await fleets.alias({ fleet: MAIN.fleet_id, alias: "production" });
    expect(changed.name).toBe("production");
    expect(changed.fleet_id).toBe(MAIN.fleet_id);
    // The default is an id, so relabelling the fleet cannot move it (§4.6).
    expect(store.default).toBe(MAIN.fleet_id);
    expect((await fleets.list()).fleets.find((f) => f.fleet_id === MAIN.fleet_id)?.name).toBe(
      "production",
    );
    // And the local row's cached label was refreshed from the write that won.
    expect(store.rows.find((r) => r.fleet_id === MAIN.fleet_id)?.name).toBe("production");
  });

  test("replaces one label with another, releasing the first", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const store = home([MAIN, STAGING], MAIN.fleet_id);
    const fleets = fleetsOver(backend, store);

    await fleets.alias({ fleet: MAIN.fleet_id, alias: "production" });
    await fleets.alias({ fleet: MAIN.fleet_id, alias: "prod" });
    expect((await backend.directory.get(MAIN.fleet_id))?.name).toBe("prod");
    // `production` is free again, so another fleet may take it.
    await fleets.alias({ fleet: STAGING.fleet_id, alias: "production" });
    expect((await backend.directory.get(STAGING.fleet_id))?.name).toBe("production");
  });

  test("clears a label, and the fleet then shows as its own id", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const store = home([MAIN, STAGING], MAIN.fleet_id);
    const fleets = fleetsOver(backend, store);

    await fleets.alias({ fleet: MAIN.fleet_id, clear: true });
    expect((await backend.directory.get(MAIN.fleet_id))?.name).toBeNull();
    const row = (await fleets.list()).fleets.find((f) => f.fleet_id === MAIN.fleet_id);
    expect(row?.name).toBeNull();
    // Nothing invented the word "unnamed": the id *is* the display name.
    expect(row?.name ?? row?.fleet_id).toBe(MAIN.fleet_id);
  });

  test("an alias and --clear together is a VALIDATION refusal, and so is neither", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const fleets = fleetsOver(backend, home([MAIN], MAIN.fleet_id));
    for (const input of [
      { fleet: MAIN.fleet_id, alias: "prod", clear: true },
      { fleet: MAIN.fleet_id },
    ]) {
      const e = await fleets.alias(input).catch((err: unknown) => err);
      expect(isHermeticError(e) && e.code).toBe("VALIDATION");
    }
  });
});

describe("uniqueness", () => {
  test("a label another live fleet holds is NAME_TAKEN", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const fleets = fleetsOver(backend, home([MAIN, STAGING], MAIN.fleet_id));

    await fleets.alias({ fleet: MAIN.fleet_id, alias: "production" });
    const e = await fleets
      .alias({ fleet: STAGING.fleet_id, alias: "production" })
      .catch((err: unknown) => err);
    expect(isHermeticError(e) && e.code).toBe("NAME_TAKEN");
    // The loser keeps whatever it had; nothing is half-applied.
    expect((await backend.directory.get(STAGING.fleet_id))?.name).toBe("staging");
  });

  /**
   * §4.7: a torn-down fleet's row is kept on purpose — it is the account's
   * record that the fleet existed — and its label is kept with it. Recycling
   * the label onto a different fleet would make every old log line, dashboard
   * screenshot and runbook name the wrong fleet.
   */
  test("a label a torn-down fleet still holds is NAME_TAKEN", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const fleets = fleetsOver(backend, home([MAIN, STAGING], MAIN.fleet_id));
    const staging = (await backend.directory.get(STAGING.fleet_id))!;
    await backend.directory.update({ ...staging, status: "torn_down" });

    const e = await fleets
      .alias({ fleet: MAIN.fleet_id, alias: "staging" })
      .catch((err: unknown) => err);
    expect(isHermeticError(e) && e.code).toBe("NAME_TAKEN");
  });

  /** And clearing it on the fleet that holds it is what releases it. */
  test("clearing a torn-down fleet's alias frees the label", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const fleets = fleetsOver(backend, home([MAIN, STAGING], MAIN.fleet_id));
    const staging = (await backend.directory.get(STAGING.fleet_id))!;
    await backend.directory.update({ ...staging, status: "torn_down" });

    await fleets.alias({ fleet: STAGING.fleet_id, clear: true });
    const changed = await fleets.alias({ fleet: MAIN.fleet_id, alias: "staging" });
    expect(changed.name).toBe("staging");
  });

  /**
   * Two operators racing the same label get one winner: the directory's
   * conditional write decides, not whoever read the list last.
   */
  test("two concurrent reservations of one label produce one winner", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const fleets = fleetsOver(backend, home([MAIN, STAGING], MAIN.fleet_id));
    const results = await Promise.allSettled([
      fleets.alias({ fleet: MAIN.fleet_id, alias: "prod" }),
      fleets.alias({ fleet: STAGING.fleet_id, alias: "prod" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const listed = await backend.directory.list();
    expect(listed.filter((e) => e.name === "prod")).toHaveLength(1);
  });
});

describe("core validates its own input", () => {
  /**
   * §1: the SDK is the surface. The heads validate with the same schema before
   * they call, but a caller holding `Hermetic` directly has no head in front of
   * it — and `FleetName`'s shape is not a rule a head may be the only keeper of.
   */
  test("an alias that is not a legal label is VALIDATION, whatever called", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const fleets = fleetsOver(backend, home([MAIN], MAIN.fleet_id));
    for (const bad of ["Not A Label", "-leading", "_fleet", "x".repeat(40)]) {
      const e = await fleets.alias({ fleet: MAIN.fleet_id, alias: bad }).catch((err: unknown) => err);
      expect(isHermeticError(e) && e.code).toBe("VALIDATION");
    }
    // And the directory was never asked: the refusal is before any AWS work.
    expect((await backend.directory.get(MAIN.fleet_id))?.name).toBe("main");
  });

  test("an empty fleet selector is VALIDATION on both methods", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const fleets = fleetsOver(backend, home([MAIN], MAIN.fleet_id));
    for (const call of [fleets.alias({ fleet: "", alias: "prod" }), fleets.use({ fleet: "" })]) {
      const e = await call.catch((err: unknown) => err);
      expect(isHermeticError(e) && e.code).toBe("VALIDATION");
    }
  });
});

describe("a lost conditional write says which race it lost", () => {
  /**
   * §4.7: `update()` answers `false` for two different situations — the label
   * belongs to somebody else, or this fleet's row moved between the read and
   * the write. They have different fixes, so they get different codes.
   */
  test("a label somebody else holds is NAME_TAKEN", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const fleets = fleetsOver(backend, home([MAIN, STAGING], MAIN.fleet_id));
    const e = await fleets
      .alias({ fleet: MAIN.fleet_id, alias: "staging" })
      .catch((err: unknown) => err);
    expect(isHermeticError(e) && e.code).toBe("NAME_TAKEN");
  });

  /**
   * The optimistic guard: another laptop relabelled this fleet between the read
   * and the write. The label asked for is still free, so this is not
   * `NAME_TAKEN` — it is "read it again".
   */
  test("a row that moved underneath is CONFLICT, not NAME_TAKEN", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const fleets = fleetsOver(backend, home([MAIN, STAGING], MAIN.fleet_id));
    const real = backend.directory.get.bind(backend.directory);
    backend.directory.get = async (fleetId: string) => {
      const entry = await real(fleetId);
      // What this call *read*: an alias the directory no longer holds.
      return entry ? { ...entry, name: "stale" } : entry;
    };
    const e = await fleets.alias({ fleet: MAIN.fleet_id, alias: "prod" }).catch((err: unknown) => err);
    expect(isHermeticError(e) && e.code).toBe("CONFLICT");
    expect((e as Error).message).toContain("read it again");
  });

  /** Clearing can only ever lose the second race: there is no label to be taken. */
  test("a clear that loses is CONFLICT and never names a null alias", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const fleets = fleetsOver(backend, home([MAIN], MAIN.fleet_id));
    const real = backend.directory.get.bind(backend.directory);
    backend.directory.get = async (fleetId: string) => {
      const entry = await real(fleetId);
      return entry ? { ...entry, name: "stale" } : entry;
    };
    const e = await fleets.alias({ fleet: MAIN.fleet_id, clear: true }).catch((err: unknown) => err);
    expect(isHermeticError(e) && e.code).toBe("CONFLICT");
    expect((e as Error).message).not.toContain("null");
  });
});

describe("the mutation target is a fleet id and only a fleet id", () => {
  test("naming the alias being replaced is NOT_FOUND, not a rename", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const fleets = fleetsOver(backend, home([MAIN], MAIN.fleet_id));
    const e = await fleets.alias({ fleet: "main", alias: "prod" }).catch((err: unknown) => err);
    expect(isHermeticError(e) && e.code).toBe("NOT_FOUND");
    expect((e as Error).message).toContain("never by the label it replaces");
  });

  test("a fleet this home has not frozen is NOT_FOUND", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const fleets = fleetsOver(backend, home([MAIN], MAIN.fleet_id));
    const e = await fleets
      .alias({ fleet: STAGING.fleet_id, alias: "prod" })
      .catch((err: unknown) => err);
    expect(isHermeticError(e) && e.code).toBe("NOT_FOUND");
  });
});

describe("selection never trusts a cached label", () => {
  /**
   * The local row's `name` is a cache another laptop can invalidate at any
   * moment, so `fleets.use` resolves a label at the directory and only ever
   * records the `fleet_id` it resolved to.
   */
  test("an alias whose fleet is not frozen here names the id to attach", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const store = home([MAIN], MAIN.fleet_id);
    const fleets = fleetsOver(backend, store);
    const e = await fleets.use({ fleet: "staging" }).catch((err: unknown) => err);
    expect(isHermeticError(e) && e.code).toBe("NOT_FOUND");
    expect((e as Error).message).toContain(STAGING.fleet_id);
  });

  /**
   * A stale cache is harmless precisely because nothing selects by it: this
   * home still thinks the fleet is called `main`, the directory has moved on,
   * and the id resolves regardless.
   */
  test("a stale cached label does not select, and the id still does", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const store = home([MAIN, STAGING], MAIN.fleet_id);
    const fleets = fleetsOver(backend, store);
    // Another laptop relabelled `main` to `prod`; this home's row still says `main`.
    const entry = (await backend.directory.get(MAIN.fleet_id))!;
    await backend.directory.update({ ...entry, name: "prod" });

    expect(await fleets.use({ fleet: MAIN.fleet_id })).toMatchObject({ fleet_id: MAIN.fleet_id });
    expect(await fleets.use({ fleet: "prod" })).toMatchObject({ fleet_id: MAIN.fleet_id });
  });

  /** Two aliasless fleets are two fleets: the list keys and sorts them by id. */
  test("two aliasless fleets are listed separately", async () => {
    const backend = new MemoryBackend({ directory: "seeded" });
    const store = home(
      [
        { ...MAIN, name: null },
        { ...STAGING, name: null },
      ],
      MAIN.fleet_id,
    );
    const fleets = fleetsOver(backend, store, { ...MAIN, name: null });
    for (const config of [MAIN, STAGING]) {
      const entry = (await backend.directory.get(config.fleet_id))!;
      await backend.directory.update({ ...entry, name: null });
    }
    const listed = await fleets.list();
    expect(listed.fleets.map((f) => f.fleet_id).sort()).toEqual(
      [MAIN.fleet_id, STAGING.fleet_id].sort(),
    );
    expect(listed.fleets.every((f) => f.name === null)).toBe(true);
  });
});
