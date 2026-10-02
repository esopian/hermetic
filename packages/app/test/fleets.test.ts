/**
 * §4.8 through the head: the account's fleets, the default this laptop records,
 * and the head's own fleet switch.
 *
 * Every harness here gets its own `HERMETIC_HOME` (`testHome()`, `./home.ts`).
 * `fleet use` writes a real row — into `hermetic-fixture.db`, never the
 * operator's real `hermetic.db`, but still a file — and a suite that shared one
 * home would have each test deciding what the next one starts from. The
 * *directory* half of the fixture is process-global by design
 * (`__hermeticFixtureDirectory`), which is what makes `main` and `staging`
 * visible from every session.
 *
 * `openState` rather than `new AppState(...)`: the switch is the thing under
 * test, and it goes through the same `openHermetic({ fleet })` the app uses.
 */
import { describe, expect, test } from "bun:test";
import {
  FOUNDATION_VERSION,
  isHermeticError,
  openHermetic,
  openLocalDb,
  setDefaultFleet,
  type OpEvent,
} from "@hermetic/core";
import { createChatOwner } from "../src/chat-owner.ts";
import type { HandlerContext } from "../src/handlers/ctx.ts";
import { dispatch } from "../src/handlers/dispatch.ts";
import { createStreamRegistry } from "../src/handlers/streams.ts";
import { memoryLog, type AppLog } from "../src/log.ts";
import { OpRegistry } from "../src/ops.ts";
import { RequestValidationError } from "../src/validation.ts";
import {
  FLEETS_CACHE_MS,
  RECOVERABLE_FLEET_CODES,
  AppState,
  openState,
  fixedInstance,
  pollerKeyFor,
} from "../src/state.ts";
import { testHome } from "./home.ts";

function contextFor(state: AppState, ops = new OpRegistry(), log?: AppLog): HandlerContext {
  return {
    state,
    hermetic: () => state.hermetic,
    ops,
    poller: () => state.poller,
    chatOwner: createChatOwner({ hermetic: () => state.hermetic }),
    fixture: true,
    opts: { fixture: true, ...(log ? { log } : {}) },
    ...(log ? { log } : {}),
    streams: createStreamRegistry(),
  };
}

async function harness() {
  /**
   * Each `openState` stands in a fixture account of its own, so `wizard.test.ts`
   * emptying its account for an `init --create` (as `openForInit` does on
   * purpose) never reaches a harness here, whichever file ran first.
   */
  const home = testHome("hermetic-fleets-");
  const state = await openState({ fixture: true, home });
  const ops = new OpRegistry();
  const log = memoryLog();
  return { home, state, ops, log, ctx: contextFor(state, ops, log) };
}

/** The refusal a call threw: core's code, or the head's own validation code. */
async function refusal(run: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run;
  } catch (e) {
    if (isHermeticError(e) || e instanceof RequestValidationError) return e;
    throw e;
  }
  throw new Error("expected a refusal; the call resolved");
}

interface FleetRow {
  name: string | null;
  fleet_id: string | null;
  region: string | null;
  local: boolean;
  registered: boolean;
  default: boolean;
  current: boolean;
  foundation_version: number | null;
  update_available: boolean;
}

interface MetaBody {
  initialized: boolean;
  fleet: {
    id: string | null;
    alias: string | null;
    default: string | null;
    directory_region: string | null;
  };
  fleet_error: { code: string; message: string } | null;
}

/** The fixture fleets' immutable ids: what every §4.6 comparison is against. */
const MAIN_ID = "fxtr0001";
const STAGING_ID = "sg7k2m4p";

const meta = (ctx: HandlerContext) => dispatch(ctx, "meta.get", {}) as Promise<MetaBody>;

const fleets = (ctx: HandlerContext) =>
  dispatch(ctx, "fleets.list", {}) as Promise<{
    directory_region: string;
    directory_error: string | null;
    fleets: FleetRow[];
  }>;

/** The fleet board as the dashboard would render it, by name. */
async function agentNames(ctx: HandlerContext): Promise<string[]> {
  const agents = (await dispatch(ctx, "agents.list", {})) as Array<{ name: string }>;
  return agents.map((a) => a.name).sort();
}

/**
 * §4.6: a fleet without a display alias is not anonymous — its `fleet_id` is
 * what it is called. Everything the head keys on has to use that, because two
 * aliasless fleets keyed by `name ?? ""` would share one poller, one op-registry
 * scope and one resume filter.
 */
describe("head state is keyed by fleet id, never by the display alias", () => {
  const base = {
    account_id: "123456789012",
    region: "us-west-2",
    stack_id: null,
    schema_version: 1 as const,
    account_alias: null,
    org_id: null,
    profile: "acme-dev",
    frozen_at: "2026-09-01T00:00:00.000Z",
    frozen_by: "evan",
  };

  test("two aliasless fleets do not share a poller key", () => {
    const one = pollerKeyFor({ ...base, name: null, fleet_id: MAIN_ID }, true);
    const two = pollerKeyFor({ ...base, name: null, fleet_id: STAGING_ID }, true);
    expect(one).not.toBe(two);
    expect(one).toContain(MAIN_ID);
  });

  test("relabelling a fleet does not move its poller key", () => {
    expect(pollerKeyFor({ ...base, name: "prod", fleet_id: MAIN_ID }, true)).toBe(
      pollerKeyFor({ ...base, name: null, fleet_id: MAIN_ID }, true),
    );
  });

  test("the op registry and the resume filter are scoped by the same id", async () => {
    const { ctx, state } = await harness();
    expect(state.fleetId).toBe(MAIN_ID);
    await dispatch(ctx, "fleets.switch", { fleet: STAGING_ID });
    expect(state.fleetId).toBe(STAGING_ID);
  });
});

describe("fleets.list", () => {
  test("lists both fixture fleets, saying which is current, default and behind", async () => {
    const { ctx } = await harness();
    const body = await fleets(ctx);

    expect(body.fleets.map((f) => f.name).sort()).toEqual(["main", "staging"]);
    expect(body.directory_region).toBe("us-east-1");

    const main = body.fleets.find((f) => f.name === "main") as FleetRow;
    const staging = body.fleets.find((f) => f.name === "staging") as FleetRow;
    // The fixture home freezes both, and the process-global fixture directory
    // registers both, so every row is local *and* registered.
    for (const row of [main, staging]) {
      expect(row.local).toBe(true);
      expect(row.registered).toBe(true);
      expect(row.region).toBe("us-west-2");
    }
    expect(main.current).toBe(true);
    expect(main.default).toBe(true);
    expect(staging.current).toBe(false);

    // `staging` sits one foundation version behind on purpose: exactly one
    // fixture fleet has an update waiting, so the badge has something to show.
    expect(main.foundation_version).toBe(FOUNDATION_VERSION);
    expect(main.update_available).toBe(false);
    expect(staging.foundation_version).toBe(FOUNDATION_VERSION - 1);
    expect(staging.update_available).toBe(true);

    // "You are here" first: a list whose first line is the current fleet reads
    // as an answer rather than as a table to search.
    expect(body.fleets[0]?.name).toBe("main");
  });

  /**
   * The wizard's very first screen may ask what is here before anything is
   * frozen. Core answers rather than refusing — an unreachable directory is
   * reported through `directory_error`, not thrown — so this method works in
   * both head states and needs no `NOT_INITIALIZED` catch of its own.
   */
  test("answers on an uninitialized home instead of refusing", async () => {
    const home = testHome("hermetic-fleets-uninit-");
    const state = await openState({ fixture: true, uninitialized: true, home });
    expect(state.initialized).toBe(false);
    const ctx = contextFor(state);

    const body = await fleets(ctx);
    expect(body.fleets).toEqual([]);
    expect(body.directory_error).toBe("not initialized");

    // And `meta.get` says so in the same words the dashboard reads.
    const m = await meta(ctx);
    expect(m.initialized).toBe(false);
    expect(m.fleet).toEqual({ id: null, alias: null, default: null, directory_region: "us-east-1" });
  });
});

describe("fleets.use", () => {
  test("records the default without moving the head off the fleet it is serving", async () => {
    const { ctx } = await harness();
    // §4.6: an alias goes in and the fleet's own id comes back — that is what
    // gets recorded, and what every later comparison is against.
    expect(await dispatch(ctx, "fleets.use", { fleet: "staging" })).toMatchObject({
      fleet_id: STAGING_ID,
      previous: MAIN_ID,
    });

    const body = await meta(ctx);
    expect(body.fleet.default).toBe(STAGING_ID);
    // Local preference, not a switch: this head is still on `main`.
    expect(body.fleet.id).toBe(MAIN_ID);
    expect(body.fleet.alias).toBe("main");
    expect(body.fleet.directory_region).toBe("us-east-1");
  });

  test("a fleet this home has not frozen is NOT_FOUND, and the default is unmoved", async () => {
    const { ctx } = await harness();
    expect((await refusal(dispatch(ctx, "fleets.use", { fleet: "nope" }))).code).toBe("NOT_FOUND");
    expect((await meta(ctx)).fleet.default).toBe(MAIN_ID);
  });
});

describe("fleets.switch", () => {
  test("repoints the head: the fleet board, the header and meta all move", async () => {
    const { ctx, state, log } = await harness();
    expect(await agentNames(ctx)).toHaveLength(11);

    const body = (await dispatch(ctx, "fleets.switch", { fleet: "staging" })) as {
      fleet_id: string | null;
      meta: MetaBody;
    };
    expect(body.fleet_id).toBe(STAGING_ID);
    // The answer carries the whole of `meta.get`, taken after the switch, so
    // the page needs no second round trip that could disagree with it.
    expect(body.meta.fleet.id).toBe(STAGING_ID);
    expect(body.meta.fleet.alias).toBe("staging");

    expect(state.fleetId).toBe(STAGING_ID);
    // `staging` is the two-agent fleet; the board really moved.
    expect(await agentNames(ctx)).toEqual(["ember", "quill"]);
    expect((await meta(ctx)).fleet.id).toBe(STAGING_ID);
    expect(log.lines.join("")).toContain(`switch fleet ${MAIN_ID} -> staging`);
  });

  test("the poller moves with it, so the fleet stream stops describing the old fleet", async () => {
    const { ctx, state } = await harness();
    const before = state.poller;
    await dispatch(ctx, "fleets.switch", { fleet: "staging" });
    expect(state.poller).not.toBe(before);
    await state.poller?.poll();
    expect(
      state.poller
        ?.snapshot()
        .agents.map((a) => a.name)
        .sort(),
    ).toEqual(["ember", "quill"]);
  });

  test("switching while an op is running is refused, and nothing moves", async () => {
    const { ctx, state, ops } = await harness();
    ops.start("agents.create", "atlas", () => ({
      async *[Symbol.asyncIterator](): AsyncIterator<OpEvent> {
        await new Promise(() => {
          /* an op that is still running when the switch arrives */
        });
      },
    }));

    expect((await refusal(dispatch(ctx, "fleets.switch", { fleet: "staging" }))).code).toBe("CONFLICT");
    expect(state.fleetId).toBe(MAIN_ID);
  });

  test("a fleet that is not frozen here is NOT_FOUND and leaves the head where it was", async () => {
    const { ctx, state } = await harness();
    expect((await refusal(dispatch(ctx, "fleets.switch", { fleet: "nope" }))).code).toBe("NOT_FOUND");
    expect(state.fleetId).toBe(MAIN_ID);
    expect((await meta(ctx)).fleet.id).toBe(MAIN_ID);
  });

  /** §4.6: the fleet id addresses it as well as the alias does. */
  test("switching by fleet id lands on the same fleet", async () => {
    const { ctx, state } = await harness();
    await dispatch(ctx, "fleets.switch", { fleet: STAGING_ID });
    expect(state.fleetId).toBe(STAGING_ID);
  });

  test("an empty fleet selector is refused before anything opens", async () => {
    const { ctx } = await harness();
    expect((await refusal(dispatch(ctx, "fleets.switch", { fleet: "" }))).code).toBe("VALIDATION");
  });
});

describe("directory.status", () => {
  test("reports the table, its billing and its bounded recovery window", async () => {
    const { ctx } = await harness();
    const body = (await dispatch(ctx, "directory.status", {})) as {
      table: string;
      exists: boolean;
      billing_mode: string | null;
      pitr_enabled: boolean;
      pitr_recovery_days: number | null;
      deletion_protection: boolean;
      unparseable: number;
      fleets: Array<{ name: string }>;
    };
    expect(body.exists).toBe(true);
    expect(body.table).toBe("hermetic-directory");
    expect(body.billing_mode).toBe("PAY_PER_REQUEST");
    // §4.8: point-in-time recovery is the *only* backup, and it is bounded to
    // seven days so the directory cannot quietly become a cost centre.
    expect(body.pitr_enabled).toBe(true);
    expect(body.pitr_recovery_days).toBe(7);
    expect(body.deletion_protection).toBe(true);
    expect(body.fleets.map((f) => f.name).sort()).toEqual(["main", "staging"]);
    // `fleets.length + unparseable` is what the table actually holds, so a row
    // this build cannot read is counted rather than silently dropped.
    expect(body.unparseable).toBe(0);
  });
});

/**
 * §4.8: a home with fleets in it that names none. The head used to die on
 * exactly this — `teardown --reset-local` removes the row that was the default
 * and leaves the others behind, and a stale `HERMETIC_FLEET` names one that is
 * gone — with the error the app is the best-placed thing to fix, since the
 * fleet switcher is in it.
 */
describe("booting with no fleet selected", () => {
  test("the two codes that are a choice rather than an absence are both recovered", () => {
    // Named as a set so the `NOT_FOUND` path below is evidence for both: one
    // branch in `openState` handles them, and this is what it handles.
    expect([...RECOVERABLE_FLEET_CODES].sort()).toEqual(["FLEET_REQUIRED", "NOT_FOUND"]);
  });

  test("a stale HERMETIC_FLEET boots the switcher instead of killing the head", async () => {
    const home = testHome("hermetic-fleets-stale-");
    // Freeze both fixture fleets in this home first, so what follows is "two
    // fleets, none of them the one that was named" rather than an empty home.
    await openHermetic({ fixture: true, home, fleet: "main" });

    const previous = process.env["HERMETIC_FLEET"];
    process.env["HERMETIC_FLEET"] = "nope";
    let state: AppState;
    try {
      state = await openState({ fixture: true, home });
    } finally {
      if (previous === undefined) delete process.env["HERMETIC_FLEET"];
      else process.env["HERMETIC_FLEET"] = previous;
    }
    const ctx = contextFor(state);

    expect(state.initialized).toBe(false);
    expect(state.fleetError?.code).toBe("NOT_FOUND");

    const m = await meta(ctx);
    expect(m.initialized).toBe(false);
    expect(m.fleet_error).toMatchObject({ code: "NOT_FOUND" });

    // The list is real here — that is the whole point of the state, and it is
    // what the switcher renders. Core answers from the local rows and says why
    // the directory half is missing: nothing is selected, so there is no account
    // guard to make the directory read with.
    const listed = await fleets(ctx);
    expect(listed.directory_error).toBe("no fleet selected");
    expect(listed.fleets.map((f) => f.name).sort()).toEqual(["main", "staging"]);
    // No row is `current`: that is exactly what the operator has to choose.
    expect(listed.fleets.filter((f) => f.current)).toEqual([]);

    // And the switch is how the operator leaves it.
    await dispatch(ctx, "fleets.switch", { fleet: "staging" });
    expect(state.initialized).toBe(true);
    expect(state.fleetId).toBe(STAGING_ID);
    expect(state.fleetError).toBeNull();
    expect(await agentNames(ctx)).toEqual(["ember", "quill"]);
    expect((await meta(ctx)).fleet_error).toBeNull();
  });

  test("a home with two fleets and no default is FLEET_REQUIRED, not a dead head", async () => {
    const home = testHome("hermetic-fleets-nodefault-");
    await openHermetic({ fixture: true, home, fleet: "main" });
    // What `teardown --reset-local` leaves behind when the fleet it removed was
    // the default: rows, and nothing saying which of them a bare command means.
    const local = openLocalDb({ home, fixture: true });
    setDefaultFleet(local.db, null);
    local.close();

    // Fixture mode runs the same selection rule real mode does, so this really
    // is `FLEET_REQUIRED` and not a stand-in for it: the head boots, and boots
    // into the picker.
    const state = await openState({ fixture: true, home });
    const ctx = contextFor(state);

    expect(state.initialized).toBe(false);
    expect(state.fleetError?.code).toBe("FLEET_REQUIRED");
    expect((await meta(ctx)).fleet_error?.code).toBe("FLEET_REQUIRED");

    const listed = await fleets(ctx);
    expect(listed.directory_error).toBe("no fleet selected");
    expect(listed.fleets.map((f) => f.name).sort()).toEqual(["main", "staging"]);
    // Nothing is current and nothing is the default — that is the choice this
    // state is waiting on, and both halves of it have to be visible to be made.
    expect(listed.fleets.filter((f) => f.current)).toEqual([]);
    expect(listed.fleets.filter((f) => f.default)).toEqual([]);

    await dispatch(ctx, "fleets.switch", { fleet: "main" });
    expect(state.initialized).toBe(true);
    expect(state.fleetId).toBe(MAIN_ID);
    expect((await meta(ctx)).fleet_error).toBeNull();
    expect(await agentNames(ctx)).toHaveLength(11);
  });

  test("init stays reachable: a home that named no fleet may still attach one", async () => {
    const home = testHome("hermetic-fleets-init-");
    const session = await openState({ fixture: true, home, uninitialized: true });
    const state = new AppState({
      fixture: true,
      home,
      reopen: (fleet?: string) => openHermetic({ fixture: true, home, ...(fleet ? { fleet } : {}) }),
      session: session.session,
      fleetError: { code: "FLEET_REQUIRED", message: "more than one fleet is frozen here" },
    });
    // Not refused: `initBlocked` refuses an *initialized* head, and this one is
    // not — `init --attach --fleet <id>` is a legitimate way out of this state.
    expect(await dispatch(contextFor(state), "init.profiles", {})).toMatchObject({
      profiles: expect.anything(),
    });
  });
});

describe("a head built around one instance says so rather than pretending", () => {
  test("switching is UNSUPPORTED when there is no home to reopen from", async () => {
    const hermetic = await openHermetic({ fixture: true, home: testHome() });
    const state = new AppState({
      fixture: true,
      home: ":memory:",
      reopen: fixedInstance(hermetic),
      hermetic,
    });
    expect(
      (await refusal(dispatch(contextFor(state), "fleets.switch", { fleet: "staging" }))).code,
    ).toBe("UNSUPPORTED");
  });

  test("`fixedInstance` hands back the one instance and refuses any other fleet", async () => {
    const hermetic = await openHermetic({ fixture: true, home: testHome() });
    const reopen = fixedInstance(hermetic);
    expect(await reopen()).toBe(hermetic);
    expect(reopen("staging")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});

describe("the fleet list meta.get reads is cached, and every write drops it", () => {
  test("a second meta inside the window costs no second read", async () => {
    const { ctx, state } = await harness();
    let reads = 0;
    const real = state.hermetic.fleets.list;
    state.hermetic.fleets.list = async () => {
      reads += 1;
      return real();
    };
    await meta(ctx);
    await meta(ctx);
    expect(reads).toBe(1);
    expect(FLEETS_CACHE_MS).toBeGreaterThan(0);
  });

  test("`fleet use` drops it, so the next meta names the new default", async () => {
    const { ctx } = await harness();
    expect((await meta(ctx)).fleet.default).toBe(MAIN_ID);
    await dispatch(ctx, "fleets.use", { fleet: "staging" });
    // Well inside the cache window: this is the invalidation, not the clock.
    expect((await meta(ctx)).fleet.default).toBe(STAGING_ID);
  });

  test("fleets.list is always fresh, and warms what meta reads", async () => {
    const { ctx, state } = await harness();
    await meta(ctx);
    let reads = 0;
    const real = state.hermetic.fleets.list;
    state.hermetic.fleets.list = async () => {
      reads += 1;
      return real();
    };
    await fleets(ctx);
    expect(reads).toBe(1);
    // The fresh answer became the cached one, rather than a third read.
    await meta(ctx);
    expect(reads).toBe(1);
  });
});

describe("the switch latch closes the window between the check and the install", () => {
  test("a mutation is refused while a switch is in flight", async () => {
    const { state } = await harness();
    // The latch is what the handlers read; holding it directly is the honest
    // way to test the window, since winning a race against the fixture's own
    // speed is a test that will eventually lose one.
    const slow = new AppState({
      fixture: true,
      home: state.home,
      reopen: () =>
        new Promise(() => {
          /* a reopen that never lands: the switch is mid-flight */
        }),
      hermetic: state.hermetic,
      fleetId: MAIN_ID,
    });
    const slowCtx = contextFor(slow);
    void slow.switchFleet("staging");
    expect(slow.switching).toBe(true);

    const blocked = await refusal(dispatch(slowCtx, "agents.create", { name: "newbie" }));
    expect([blocked.code, blocked.message]).toEqual(["CONFLICT", "fleet switch in progress"]);

    // And a second switch is refused for the same reason.
    expect((await refusal(dispatch(slowCtx, "fleets.switch", { fleet: "main" }))).code).toBe(
      "CONFLICT",
    );
  });
});
