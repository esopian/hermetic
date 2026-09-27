/**
 * The head's surface, called with no transport at all (§11.6).
 *
 * `dispatch(ctx, name, params)` is the whole of it: a name and a params object
 * in, a value or a thrown refusal out. That is exactly what the desktop bridge
 * hands it, so what these assert is what the handlers do rather than how one
 * transport rendered it — a status assertion passes for a handler that throws
 * the right code and for one that throws the wrong code into a table that maps
 * it to the same number.
 */
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { z } from "zod";
import {
  BUILD_VERSIONS,
  CreateAgentInput,
  FIXTURE_CONFIG,
  FIXTURE_PROFILE_IDS,
  HermeticError,
  SecretsPushInput,
  clearConfig,
  fixtureConfigFor,
  fleetTargetOf,
  isHermeticError,
  openHermetic,
  openLocalDb,
} from "@hermetic/core";
import type { Hermetic } from "@hermetic/core";
import { RequestValidationError } from "../src/validation.ts";
import { INTERNAL_MESSAGE } from "../src/errors.ts";
import { createChatOwner } from "../src/chat-owner.ts";
import type { AppLog } from "../src/log.ts";
import type { HandlerContext } from "../src/handlers/ctx.ts";
import { dispatch } from "../src/handlers/dispatch.ts";
import { KEEPALIVE_EVENT, createStreamRegistry, type StreamFrame } from "../src/handlers/streams.ts";
import { formatLine, memoryLog } from "../src/log.ts";
import { OpRegistry } from "../src/ops.ts";
import { FleetPoller } from "../src/poller.ts";
import { AppState, fixedInstance, openState } from "../src/state.ts";
import { testHome } from "./home.ts";

/** The context the bridge builds, over one instance and one op registry. */
function contextFor(
  hermetic: Hermetic,
  extra: { ops?: OpRegistry; poller?: FleetPoller | null; log?: AppLog } = {},
): HandlerContext {
  const ops = extra.ops ?? new OpRegistry();
  const poller = extra.poller ?? null;
  const state = new AppState({
    fixture: true,
    home: ":memory:",
    reopen: fixedInstance(hermetic),
    hermetic,
    target: hermetic.target === null ? null : fleetTargetOf(hermetic.target),
    poller,
  });
  return {
    state,
    hermetic: () => state.hermetic,
    ops,
    poller: () => poller,
    chatOwner: createChatOwner({ hermetic: () => state.hermetic }),
    fixture: true,
    opts: { fixture: true, ...(extra.log ? { log: extra.log } : {}) },
    ...(extra.log ? { log: extra.log } : {}),
    streams: createStreamRegistry(),
  };
}

/**
 * Every harness gets its own `HERMETIC_HOME` under `tmpdir()`, passed as `home`
 * rather than set in the environment. Fixture mode keeps no AWS state, but it
 * does write a real `hermetic-fixture.db` — the default-fleet pointer and
 * notification rows (mutes, read marks) both persist there. Without an override
 * these tests read and write the operator's own fixture db, so the suite passes
 * or fails depending on what a dev session last left in it.
 */
async function harness() {
  const hermetic = await openHermetic({ fixture: true, home: testHome() });
  const ops = new OpRegistry();
  const poller = new FleetPoller(hermetic);
  return { hermetic, ops, poller, ctx: contextFor(hermetic, { ops, poller }) };
}

/** The account the fixture home is frozen to (`FIXTURE_CONFIG`), typed back. */
const FIXTURE_ACCOUNT_ID = "123456789012";

/**
 * All eleven fixture agents destroyed, so `teardown` clears the AGENTS_EXIST
 * guard and actually runs its several async phases — which is both what the
 * in-progress guard needs to observe and what the confirmation tests need in
 * order to get past the first phase at all.
 */
async function harnessWithNoAgents() {
  const h = await harness();
  for (const agent of await h.hermetic.agents.list()) {
    for await (const _e of h.hermetic.agents.destroy({ name: agent.name, yes: true })) {
      // drain to completion
    }
  }
  return h;
}

/** `doctor` is the read that says whether the foundation stack is still there. */
async function foundationPresent(h: Awaited<ReturnType<typeof harness>>): Promise<boolean> {
  return (await h.hermetic.doctor()).foundation.present;
}

/**
 * §4.7: the fleet every mutation in this file is for.
 *
 * Fleet selection lives in the head, so a fleet-scoped write names the fleet it
 * means and an absent target is refused exactly as firmly as a wrong one
 * (`src/target.ts`). Every harness here is built around the seeded fixture
 * fleet, so the helper that builds params adds its target — the tests that are
 * *about* the guard live in `fleet-target.test.ts` and spell theirs out one by
 * one.
 */
const FIXTURE_TARGET = fleetTargetOf(FIXTURE_CONFIG);

/** Params for a fleet-scoped write. `target` first, so a caller's own wins. */
const write = (params: Record<string, unknown> = {}): Record<string, unknown> => ({
  target: FIXTURE_TARGET,
  ...params,
});

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

const codeOf = async (run: Promise<unknown>): Promise<string> => (await refusal(run)).code;

/** Drains a streaming request to exhaustion, bounded, and returns its frames. */
async function drain(
  ctx: HandlerContext,
  name: string,
  params: Record<string, unknown> = {},
  ms = 2000,
): Promise<StreamFrame[]> {
  const frames: StreamFrame[] = [];
  const { stream_id } = (await dispatch(ctx, name, params, (f) => void frames.push(f))) as {
    stream_id: string;
  };
  await Promise.race([ctx.streams.get(stream_id)?.done ?? Promise.resolve(), Bun.sleep(ms)]);
  ctx.streams.close(stream_id);
  return frames;
}

describe("the reads", () => {
  test("agents.list returns the fixture fleet with derived state", async () => {
    const { ctx } = await harness();
    const agents = (await dispatch(ctx, "agents.list", {})) as Array<Record<string, unknown>>;
    expect(agents.length).toBe(12);
    expect(agents.map((a) => a["name"])).toContain("atlas");
    // `unreachable` is derived from heartbeat age, never stored (§4.3).
    expect(agents.find((a) => a["name"] === "lumen")?.["display_status"]).toBe("unreachable");
  });

  test("agents.get on an unknown agent is NOT_FOUND", async () => {
    const { ctx } = await harness();
    expect(await codeOf(dispatch(ctx, "agents.get", { name: "nosuchagent" }))).toBe("NOT_FOUND");
  });

  /**
   * `agents.probe` (§9). Read-only, so it answers once rather than streaming:
   * it can take a few seconds when a layer times out, but that is the answer,
   * not a phase sequence to follow.
   */
  test("agents.probe returns a report with a verdict", async () => {
    const { ctx } = await harness();
    const report = (await dispatch(ctx, "agents.probe", { name: "atlas" })) as {
      name: string;
      instance: { outcome: string };
      hermeticd: { outcome: string };
      verdict: { level: string; summary: string; hints: string[] };
    };
    expect(report.name).toBe("atlas");
    expect(report.instance.outcome).toBe("ok");
    expect(report.hermeticd.outcome).toBe("ok");
    expect(report.verdict.level).toBe("ok");
    expect(report.verdict.summary.length).toBeGreaterThan(0);
  });

  /** A silent layer is a report with a `fail` in it, not a refusal. */
  test("a probe whose hermeticd does not answer still answers", async () => {
    const { ctx } = await harness();
    const report = (await dispatch(ctx, "agents.probe", { name: "lumen" })) as {
      hermeticd: { outcome: string };
      verdict: { level: string; hints: string[] };
    };
    expect(report.hermeticd.outcome).toBe("fail");
    expect(report.verdict.level).toBe("bad");
    expect(report.verdict.hints.length).toBeGreaterThan(0);
  });

  test("agents.probe on an unknown agent is NOT_FOUND", async () => {
    const { ctx } = await harness();
    expect(await codeOf(dispatch(ctx, "agents.probe", { name: "nosuchagent" }))).toBe("NOT_FOUND");
  });

  test("a provider key sent to create never comes back out of the head", async () => {
    const { ctx } = await harness();
    const KEY = "sk-or-v1-FIXTURE-PROVIDER-KEY";
    const { op } = (await dispatch(
      ctx,
      "agents.create",
      write({ name: "vireo", provider: "openrouter", api_key: KEY }),
    )) as { op: { id: string } };
    expect(JSON.stringify(op)).not.toInclude(KEY);

    // The op registry is what the UI polls and what `app.log` mirrors: the
    // request that carried the key must not survive in either (§8.3).
    expect(JSON.stringify(await dispatch(ctx, "ops.list", {}))).not.toInclude(KEY);
    expect(JSON.stringify(await dispatch(ctx, "ops.get", { id: op.id }))).not.toInclude(KEY);
  });

  /**
   * The opposite of `api_key`: `rollback_on_failure` is not a secret, and it
   * has to survive into the recorded input — `resume.ts` restarts an op from
   * exactly that, and a resumed create must keep the operator's choice about
   * what happens when it fails (§6.2).
   */
  test("a create's rollback choice survives into the op's recorded input", async () => {
    const { ctx } = await harness();
    const { op } = (await dispatch(
      ctx,
      "agents.create",
      write({ name: "basalt", rollback_on_failure: true }),
    )) as { op: { id: string } };
    const recorded = (await dispatch(ctx, "ops.get", { id: op.id })) as {
      input?: Record<string, unknown>;
    };
    expect(recorded.input).toMatchObject({ name: "basalt", rollback_on_failure: true });
  });

  test("an invalid agent name is NAME_INVALID", async () => {
    const { ctx } = await harness();
    expect(await codeOf(dispatch(ctx, "agents.create", write({ name: "BAD_NAME" })))).toBe(
      "NAME_INVALID",
    );
  });

  test("a request that is the wrong shape somewhere else is a plain VALIDATION", async () => {
    const { ctx } = await harness();
    expect(
      await codeOf(dispatch(ctx, "agents.create", write({ name: "atlas", size: "enormous" }))),
    ).toBe("VALIDATION");
  });

  /**
   * The code comes from the *schema* the field was built from, not from the
   * fact that the field is spelled `name`. The first future request object with
   * a profile name, a stack name or a tag name in it would otherwise inherit
   * `NAME_INVALID` — and with it exit status 5 and a sentence about agent names.
   */
  test("a `name` that is not an agent name does not become NAME_INVALID", () => {
    expect(new RequestValidationError([{ path: "name", message: "bad" }], CreateAgentInput).code).toBe(
      "NAME_INVALID",
    );
    // `_fleet` or an agent name (§8.3); still a name complaint.
    expect(new RequestValidationError([{ path: "name", message: "bad" }], SecretsPushInput).code).toBe(
      "NAME_INVALID",
    );
    const NotAnAgentName = z.object({ name: z.string().min(3) });
    expect(
      new RequestValidationError([{ path: "name", message: "too short" }], NotAnAgentName).code,
    ).toBe("VALIDATION");
    // No schema at all is a VALIDATION too.
    expect(new RequestValidationError([{ path: "name", message: "bad" }]).code).toBe("VALIDATION");
  });

  test("meta.get carries the header line the UI pins to its bar", async () => {
    const { ctx } = await harness();
    const meta = (await dispatch(ctx, "meta.get", {})) as { header: string; fixture: boolean };
    expect(meta.fixture).toBe(true);
    // §4.8: the fleet name leads the header line, because one account may hold
    // several fleets and the account alone no longer says which.
    expect(meta.header).toBe(
      "▸ main · acme-dev · 123456789012 · us-west-2 · profile acme-dev · FIXTURE",
    );
  });

  test("meta.get says this home is initialized", async () => {
    const { ctx } = await harness();
    const meta = (await dispatch(ctx, "meta.get", {})) as {
      initialized: boolean;
      home: string;
      config: unknown;
    };
    expect(meta.initialized).toBe(true);
    expect(meta.home).toBeString();
    expect(meta.config).not.toBeNull();
  });

  test("meta.get reports the versions this build ships", async () => {
    const { ctx } = await harness();
    const meta = (await dispatch(ctx, "meta.get", {})) as {
      hermes_version: string | null;
      hermeticd_version: string | null;
      tailnet: string | null;
    };
    // The UI renders these; null would show as a blank in the header bar.
    expect(meta.hermes_version).toBe(BUILD_VERSIONS.hermes);
    expect(meta.hermeticd_version).toBe(BUILD_VERSIONS.hermeticd);
    // Lifted out of the frozen config so the header bar need not know its shape.
    expect(meta.tailnet).toBe("hermetic.ts.net");
  });

  /**
   * §4.6: the settings ride on `meta.get` so the UI paints the fleet's own
   * defaults on its first render rather than `—` followed by a correction.
   */
  test("meta.get carries the fleet's shared settings", async () => {
    const { ctx } = await harness();
    const meta = (await dispatch(ctx, "meta.get", {})) as {
      settings: { persisted: boolean; settings: { defaults: { provider: string } } } | null;
    };
    expect(meta.settings?.persisted).toBe(true);
    expect(meta.settings?.settings.defaults.provider).toBe("bedrock");
  });

  /**
   * Typed fields are validated rather than coerced. Over HTTP this was about a
   * query string, where everything arrives as text; over the bridge the value
   * arrives typed and the schema is what refuses the wrong type — the same
   * property, one layer earlier.
   */
  test("typed fields are validated, not read raw", async () => {
    const { ctx } = await harness();
    expect(await dispatch(ctx, "agents.history", { name: "atlas", limit: 2 })).toBeDefined();
    expect(await codeOf(dispatch(ctx, "agents.history", { name: "atlas", limit: "lots" }))).toBe(
      "VALIDATION",
    );
    expect(await dispatch(ctx, "plan.destroy", { name: "atlas", delete_volume: true })).toBeDefined();
    expect(await codeOf(dispatch(ctx, "plan.destroy", { name: "atlas", delete_volume: "maybe" }))).toBe(
      "VALIDATION",
    );
    expect(await codeOf(dispatch(ctx, "runs.list", { limit: "nope" }))).toBe("VALIDATION");
  });

  test("`delete_volume: true` reaches the plan", async () => {
    const { ctx } = await harness();
    const plan = (await dispatch(ctx, "plan.destroy", { name: "atlas", delete_volume: true })) as {
      steps: Array<{ id: string; destructive: boolean }>;
    };
    expect(plan.steps.find((s) => s.id === "volume")?.destructive).toBe(true);
  });
});

describe("destructive methods insist the head confirmed", () => {
  /**
   * The params here carry the fleet and nothing else. A request naming no fleet
   * at all is refused one step earlier — §4.7's guard runs before the
   * confirmation question — which is what `fleet-target.test.ts` pins. What is
   * pinned here is the next refusal along: a request that named its fleet and
   * still did not say `yes` is answered with the question, not with a doomed
   * background op.
   */
  test("destroy without yes is the question, not a doomed background op", async () => {
    const { ctx } = await harness();
    expect(await codeOf(dispatch(ctx, "agents.destroy", write({ name: "atlas" })))).toBe(
      "CONFIRMATION_REQUIRED",
    );
  });

  test("recreate without yes asks too", async () => {
    const { ctx } = await harness();
    expect(await codeOf(dispatch(ctx, "agents.recreate", write({ name: "atlas" })))).toBe(
      "CONFIRMATION_REQUIRED",
    );
  });

  test("teardown without yes asks too", async () => {
    const { ctx } = await harness();
    expect(await codeOf(dispatch(ctx, "teardown", write()))).toBe("CONFIRMATION_REQUIRED");
  });

  /**
   * §4.7 step 3 over a transport: there is no prompt on this side, so the
   * twelve digits have to be in the request. The UI is what types them.
   */
  test("teardown with yes but no typed account id asks for the digits", async () => {
    const { ctx } = await harness();
    expect(await codeOf(dispatch(ctx, "teardown", write({ yes: true })))).toBe("CONFIRMATION_REQUIRED");
  });

  test("teardown with a malformed typed account id is refused, not started", async () => {
    const { ctx } = await harness();
    // The schema rejects anything that is not twelve digits; a *valid* twelve
    // digits that names the wrong account is core's confirmation refusal.
    expect(
      await codeOf(dispatch(ctx, "teardown", write({ yes: true, confirm_account_id: "12345" }))),
    ).toBeOneOf(["VALIDATION", "CONFIRMATION_REQUIRED"]);
  });

  test("teardown with the wrong twelve digits fails the op rather than tearing down", async () => {
    const h = await harnessWithNoAgents();
    const { op } = (await dispatch(
      h.ctx,
      "teardown",
      write({ yes: true, confirm_account_id: "999999999999" }),
    )) as { op: { id: string } };
    expect((await h.ops.wait(op.id))?.status).toBe("error");
    expect(await foundationPresent(h)).toBe(true);
  });

  test("apply without yes asks", async () => {
    const { ctx } = await harness();
    expect(
      await codeOf(
        dispatch(
          ctx,
          "apply",
          write({ plan: { kind: "teardown", target: "t", options: {}, steps: [], warnings: [] } }),
        ),
      ),
    ).toBe("CONFIRMATION_REQUIRED");
  });

  /**
   * `apply` passes the field through and core enforces it: a teardown plan with
   * `yes` and nothing else is accepted as an op and then refuses, which is the
   * F1/F2 hole closed at the only place that can close it for every head.
   */
  test("apply of a teardown plan with no typed account id fails the op", async () => {
    const h = await harnessWithNoAgents();
    const plan = await dispatch(h.ctx, "plan.teardown", {});
    const { op } = (await dispatch(h.ctx, "apply", write({ plan, yes: true }))) as {
      op: { id: string };
    };
    expect((await h.ops.wait(op.id))?.status).toBe("error");
    expect(await foundationPresent(h)).toBe(true);
  });

  test("apply of a teardown plan with the typed account id runs it", async () => {
    const h = await harnessWithNoAgents();
    const plan = await dispatch(h.ctx, "plan.teardown", {});
    const { op } = (await dispatch(
      h.ctx,
      "apply",
      write({ plan, yes: true, confirm_account_id: FIXTURE_ACCOUNT_ID }),
    )) as { op: { id: string } };
    expect((await h.ops.wait(op.id))?.status).toBe("ok");
    expect(await foundationPresent(h)).toBe(false);
  });

  /**
   * `PlanOptions.reset_local` is optional (`core/schema/ops.ts`), and core's
   * apply dispatch reads it as `?? true`: a teardown plan that simply omits the
   * flag still resets local state. The head used to read `=== true` for the
   * same field, so such a plan tore the fleet down while leaving the dashboard
   * on a fleet that no longer existed.
   */
  test("an apply of a teardown plan with reset_local absent resets the head like core does", async () => {
    /**
     * Its own `HERMETIC_HOME`, the way `fleets.test.ts` does it: the reset this
     * asserts is a real local one — it archives the runs log and drops the
     * frozen config row — so a test sharing the default home would decide what
     * every later test starts from. The fixture account is this state's own,
     * so the reset reaching `openForInit` — which empties the account on
     * purpose — leaves no other test's fleet list touched.
     */
    const home = testHome("apply-reset");
    try {
      const state = await openState({ fixture: true, home });
      // One frozen fleet, so the reset is the whole answer: a home that still
      // held the other seeded fleet would move the head onto it instead (§4.6),
      // which `wizard.test.ts` covers.
      const local = openLocalDb({ home, fixture: true });
      clearConfig(local.db, fixtureConfigFor("staging").fleet_id);
      local.close();
      const ops = new OpRegistry();
      const ctx: HandlerContext = {
        state,
        hermetic: () => state.hermetic,
        ops,
        poller: () => state.poller,
        chatOwner: createChatOwner({ hermetic: () => state.hermetic }),
        fixture: true,
        opts: { fixture: true },
        streams: createStreamRegistry(),
      };
      // Teardown refuses while any agent is still alive (§9).
      for (const agent of await state.hermetic.agents.list()) {
        for await (const _e of state.hermetic.agents.destroy({ name: agent.name, yes: true })) {
          // drain to completion
        }
      }

      const plan = (await dispatch(ctx, "plan.teardown", {})) as {
        options: Record<string, unknown>;
      };
      // The defect in one line: core reads this field as `?? true`, so the plan
      // means "reset" whether or not it carries the flag.
      delete plan.options["reset_local"];
      // §4.7: the mutation names the fleet this head actually opened.
      const { op } = (await dispatch(ctx, "apply", {
        plan,
        yes: true,
        confirm_account_id: state.target?.account_id ?? "",
        target: state.target,
      })) as { op: { id: string } };
      expect((await ops.wait(op.id))?.status).toBe("ok");

      // The reset is scheduled off the op's completion rather than awaited by
      // the handler, and the teardown block is released only once it has
      // finished.
      for (let i = 0; i < 50 && (state.initialized || state.teardownOpId !== null); i += 1) {
        await Bun.sleep(10);
      }
      expect(state.initialized).toBe(false);

      const meta = (await dispatch(ctx, "meta.get", {})) as {
        initialized: boolean;
        last_teardown: { fleet_id: string } | null;
      };
      expect(meta.initialized).toBe(false);
      expect(meta.last_teardown).not.toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("init on an already-initialized home is CONFLICT, typed digits or not", async () => {
    // Re-freezing a live home from a window is not on offer (§4.6); the
    // missing-digits path lives in the wizard tests, which boot uninitialized.
    const { ctx } = await harness();
    expect(await codeOf(dispatch(ctx, "init", { account_id_typed: "123456789012" }))).toBe("CONFLICT");
  });
});

describe("plan.teardown's options", () => {
  test("defaults match TeardownInput's own defaults", async () => {
    const { ctx } = await harness();
    const plan = (await dispatch(ctx, "plan.teardown", {})) as {
      options: {
        purge: boolean;
        delete_snapshots: boolean;
        delete_volumes: boolean;
        reset_local: boolean;
      };
    };
    expect(plan.options).toEqual({
      purge: true,
      delete_snapshots: false,
      delete_volumes: false,
      reset_local: true,
    });
  });

  test("every flag the caller sets reaches core", async () => {
    const { ctx } = await harness();
    const plan = (await dispatch(ctx, "plan.teardown", {
      purge: false,
      delete_snapshots: true,
      delete_volumes: true,
      reset_local: false,
    })) as {
      options: {
        purge: boolean;
        delete_snapshots: boolean;
        delete_volumes: boolean;
        reset_local: boolean;
      };
      summary?: { account_id: string; region: string; fleet_id: string };
    };
    expect(plan.options).toEqual({
      purge: false,
      delete_snapshots: true,
      delete_volumes: true,
      reset_local: false,
    });
    expect(plan.summary?.account_id).toBeString();
  });

  test("a value the schema does not accept is refused, not silently defaulted", async () => {
    const { ctx } = await harness();
    expect(await codeOf(dispatch(ctx, "plan.teardown", { purge: "maybe" }))).toBe("VALIDATION");
  });
});

/**
 * `logs` carries three sources and picks none of them itself: `unit` is
 * journald, `file` is one of Hermes's own rotating logs on the data volume, and
 * `source=console` is EC2's serial buffer.
 */
describe("the logs sources", () => {
  /**
   * Whichever fleet this fixture home currently defaults to — the switcher's
   * own tests move it, and an agent name hard-coded here would read as a logs
   * failure when it is really a fleet that no longer holds that agent.
   */
  async function anAgent(h: Awaited<ReturnType<typeof harness>>): Promise<string> {
    const [first] = await h.hermetic.agents.list();
    expect(first).toBeDefined();
    return first!.name;
  }

  test("file= reaches core and the lines come back labelled with the file", async () => {
    const h = await harness();
    const name = await anAgent(h);
    const frames = await drain(h.ctx, "logs", { name, file: "errors" });
    expect(frames.some((f) => f.event === "line")).toBe(true);
    expect(JSON.stringify(frames)).toContain("errors.log");
  });

  test.each(["unit", "console"])("a request naming two sources is refused: %s", async (other) => {
    const h = await harness();
    const name = await anAgent(h);
    const params =
      other === "unit"
        ? { name, unit: "hermes-dashboard.service", file: "agent" }
        : { name, file: "agent", source: "console" };
    expect(await codeOf(dispatch(h.ctx, "logs", params, () => {}))).toBe("VALIDATION");
  });

  test("a file the enum does not name is refused, not read as a path", async () => {
    const h = await harness();
    const name = await anAgent(h);
    expect(await codeOf(dispatch(h.ctx, "logs", { name, file: "/etc/shadow" }, () => {}))).toBe(
      "VALIDATION",
    );
  });
});

describe("the teardown-in-progress guard", () => {
  const guarded: Array<{ name: string; params: Record<string, unknown> }> = [
    { name: "agents.create", params: { name: "probe" } },
    { name: "agents.recreate", params: { name: "atlas", yes: true } },
    { name: "agents.rerun", params: { name: "heron" } },
    // F6: every remaining *mutating* agent method, plus the one secrets write.
    { name: "agents.stop", params: { name: "atlas" } },
    { name: "agents.start", params: { name: "atlas" } },
    { name: "agents.set", params: { name: "atlas", size: "large" } },
    { name: "agents.destroy", params: { name: "atlas", yes: true } },
    { name: "secrets.push", params: { name: "atlas", bws_token: true, value: "bws-probe" } },
    { name: "upgrade", params: { name: "atlas", hermes: "0.15.1" } },
  ];

  for (const g of guarded) {
    test(`${g.name} is CONFLICT while a teardown op is running`, async () => {
      const { ctx } = await harnessWithNoAgents();
      await dispatch(ctx, "teardown", write({ yes: true, confirm_account_id: FIXTURE_ACCOUNT_ID }));

      // No intervening await: `state.beginTeardown` ran synchronously inside the
      // call above, and `endTeardown` only runs once the op's several async
      // phases settle — this request lands inside that window.
      expect(await codeOf(dispatch(ctx, g.name, write(g.params)))).toBe("CONFLICT");
    });
  }
});

describe("an unclassified failure", () => {
  /**
   * A `HermeticError` message is written to be read (§3.2 rule 1) and is
   * forwarded. Anything else is a bug, an SDK internal, or a message built out
   * of whatever the caller sent — the page gets a sentence, the operator gets
   * the truth in `app.log`.
   */
  const leaky = new Error(
    "connect ECONNREFUSED 10.11.12.13:443 assuming arn:aws:iam::123456789012:role/hermetic-internal",
  );

  async function throwingContext(e: unknown) {
    const { hermetic, ops, poller } = await harness();
    const log = memoryLog();
    const stub = {
      ...hermetic,
      agents: { ...hermetic.agents, list: () => Promise.reject(e) },
    } as Hermetic;
    return { ctx: contextFor(stub, { ops, poller, log }), log };
  }

  /**
   * The masking itself lives in `errors.ts` and is applied by whatever binds
   * `dispatch` to a transport (`rpc/bind.ts`, and `chat-owner.ts` for a stream
   * frame). What `dispatch` owes is the throw, unchanged, so the binding has
   * something to classify.
   */
  test("the refusal reaches the binding, which is where masking happens", async () => {
    const { ctx } = await throwingContext(leaky);
    const thrown = await dispatch(ctx, "agents.list", {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBe(leaky);
    const { classifyFailure } = await import("../src/errors.ts");
    const failure = classifyFailure(thrown);
    expect(failure.body.error).toEqual({ code: "INTERNAL", message: INTERNAL_MESSAGE });
    expect(JSON.stringify(failure.body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(failure.body)).not.toContain("arn:aws:iam");
    // The operator's copy, kept out of the body and handed to the caller that
    // does the logging.
    expect(failure.internal).toContain("ECONNREFUSED");
  });

  test("a core error still says what it said", async () => {
    const { ctx } = await throwingContext(new HermeticError("NOT_FOUND", "no agent named atlas"));
    const e = await refusal(dispatch(ctx, "agents.list", {}));
    expect([e.code, e.message]).toEqual(["NOT_FOUND", "no agent named atlas"]);
  });
});

describe("an unclassified failure inside an op", () => {
  /**
   * The op record is not a log line: `ops.list`, `ops.get` and the stream's
   * `done` frame all serve `error.message` to the page verbatim. An
   * unclassified throw's message gets the same treatment there as on the
   * request path — the caller is told the code, the log is told the truth.
   */
  const leaky = new Error(
    "connect ECONNREFUSED 10.11.12.13:443 assuming arn:aws:iam::123456789012:role/x",
  );

  async function stoppingContext() {
    const { hermetic, poller } = await harness();
    const log = memoryLog();
    // The registry gets the log too: op outcomes are recorded by `ops.ts`, not
    // by the request path.
    const ops = new OpRegistry({ log });
    const stub = {
      ...hermetic,
      agents: {
        ...hermetic.agents,
        // biome-ignore lint/correctness/useYield: a test double for a long op that fails before its first event.
        stop: async function* (): AsyncGenerator<never> {
          await Promise.resolve();
          throw leaky;
        },
      },
    } as Hermetic;
    return { ctx: contextFor(stub, { ops, poller, log }), ops, log };
  }

  test("neither the op list, the op, nor the done frame carries the raw message", async () => {
    const { ctx, ops, log } = await stoppingContext();
    const { op } = (await dispatch(ctx, "agents.stop", write({ name: "atlas" }))) as {
      op: { id: string };
    };
    expect((await ops.wait(op.id))?.status).toBe("error");

    const one = JSON.stringify(await dispatch(ctx, "ops.get", { id: op.id }));
    const all = JSON.stringify(await dispatch(ctx, "ops.list", {}));
    const frames = await drain(ctx, "ops.subscribe", { op_id: op.id });
    const stream = JSON.stringify(frames);

    for (const [label, body] of [
      ["op", one],
      ["list", all],
      ["stream", stream],
    ] as const) {
      expect({ label, leaked: body.includes("ECONNREFUSED") || body.includes("arn:aws:iam") }).toEqual({
        label,
        leaked: false,
      });
      expect({ label, says: body.includes(INTERNAL_MESSAGE) }).toEqual({ label, says: true });
    }
    // The `done` frame is the one the page acts on, and it carries the code.
    expect(frames.at(-1)?.event).toBe("done");
    expect(stream).toContain('"code":"INTERNAL"');

    // The operator's copy: message on the ERROR line, stack at debug.
    const text = log.lines.join("");
    expect(text).toContain("ECONNREFUSED");
    expect(text).toContain("ERROR op:agents.stop error INTERNAL:");
    expect(text).toContain("DEBUG op:agents.stop");
  });
});

describe("background ops", () => {
  test("create answers an op id and streams to a done frame", async () => {
    const { ctx, ops } = await harness();
    const { op } = (await dispatch(ctx, "agents.create", write({ name: "nova" }))) as {
      op: { id: string };
    };
    expect(op.id).toBeString();

    await ops.wait(op.id);
    const frames = await drain(ctx, "ops.subscribe", { op_id: op.id });
    // The buffer is replayed in full, so a late subscriber misses nothing.
    expect(frames.some((f) => f.event === "event")).toBe(true);
    expect(JSON.stringify(frames)).toContain('"phase":"validate"');
    // The last frame is `done`, and like every frame it carries the attempt it
    // belongs to and its sequence number within that attempt.
    expect(frames.at(-1)).toMatchObject({ event: "done", data: { ok: true, error: null } });
    expect(frames.at(-1)?.id).toMatch(/^0:\d+$/);
  });

  /**
   * The bug this guards: a long silent phase (CloudFormation create) let a
   * dropped connection resume from nothing, the head replayed from the start,
   * and the wizard showed the same two lines over and over. Every frame carries
   * a cursor, and a reader hands the last one it saw back as `after`.
   */
  test("frames carry sequence ids and `after` resumes past them", async () => {
    const { ctx, ops } = await harness();
    const { op } = (await dispatch(ctx, "agents.create", write({ name: "sable" }))) as {
      op: { id: string };
    };
    await ops.wait(op.id);

    const full = await drain(ctx, "ops.subscribe", { op_id: op.id });
    // Generation 0: this op was started here and has been resumed by nothing.
    const ids = full.map((f) => Number(f.id?.split(":")[1]));
    expect(ids.length).toBeGreaterThan(3);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);

    // A reconnect claiming everything but the last event and `done` was seen.
    const resumeAfter = ids[ids.length - 3]!;
    const resumed = await drain(ctx, "ops.subscribe", {
      op_id: op.id,
      after: { generation: 0, seq: resumeAfter },
    });
    expect(resumed.map((f) => Number(f.id?.split(":")[1]))).toEqual(ids.filter((i) => i > resumeAfter));
    expect(JSON.stringify(resumed)).not.toContain('"phase":"validate"');
    expect(resumed.at(-1)).toMatchObject({ event: "done", data: { ok: true, error: null } });
  });

  test("a quiet op is kept alive with keepalive frames", async () => {
    const hermetic = await openHermetic({ fixture: true, home: testHome() });
    const ops = new OpRegistry({ keepaliveMs: 20 });
    const ctx = contextFor(hermetic, { ops });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* stalled() {
      yield {
        phase: "foundation",
        progress: 0.3,
        message: "creating stack",
        at: new Date().toISOString(),
      };
      await gate;
      yield { phase: "done", progress: 1, message: "ok", at: new Date().toISOString() };
    }
    const op = ops.start("init", null, () => stalled());

    const frames: StreamFrame[] = [];
    const { stream_id } = (await dispatch(
      ctx,
      "ops.subscribe",
      { op_id: op.id },
      (f) => void frames.push(f),
    )) as { stream_id: string };
    for (let i = 0; i < 200; i += 1) {
      const quiet = frames.filter((f) => f.event === KEEPALIVE_EVENT).length;
      const said = frames.some((f) => JSON.stringify(f.data).includes("creating stack"));
      if (quiet > 0 && said) break;
      await Bun.sleep(5);
    }
    expect(JSON.stringify(frames)).toContain('"phase":"foundation"');
    expect(frames.filter((f) => f.event === KEEPALIVE_EVENT).length).toBeGreaterThan(0);
    // A keepalive carries nothing: what a transport does with one is its own
    // business (`streams.ts`), and there is no event for a reader to act on.
    expect(frames.filter((f) => f.event === KEEPALIVE_EVENT).every((f) => f.data === null)).toBe(true);

    release();
    ctx.streams.close(stream_id);
    await ops.wait(op.id);
  });

  test("the op survives the request that started it", async () => {
    const { ctx, ops } = await harness();
    const { op } = (await dispatch(ctx, "agents.create", write({ name: "vireo" }))) as {
      op: { id: string };
    };
    await ops.wait(op.id);
    const page = (await dispatch(ctx, "ops.list", {})) as {
      ops: Array<{ id: string; status: string; method: string }>;
      next_cursor: string | null;
    };
    expect(page.ops.find((o) => o.id === op.id)).toMatchObject({
      status: "ok",
      method: "agents.create",
    });
  });

  test("the op list is paged", async () => {
    const { ctx, ops } = await harness();
    for (const name of ["one", "two", "three"]) {
      const { op } = (await dispatch(ctx, "agents.create", write({ name }))) as {
        op: { id: string };
      };
      await ops.wait(op.id);
    }
    const first = (await dispatch(ctx, "ops.list", { limit: 2 })) as {
      ops: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(first.ops.length).toBe(2);
    expect(first.next_cursor).toBeString();
    const second = (await dispatch(ctx, "ops.list", {
      limit: 2,
      cursor: first.next_cursor,
    })) as { ops: Array<{ id: string }>; next_cursor: string | null };
    expect(second.ops.length).toBe(1);
    expect(second.next_cursor).toBeNull();
    expect(second.ops[0]?.id).not.toBe(first.ops[0]?.id);
  });

  test("the op list filters by target and status, so a reload can re-attach", async () => {
    const { ctx, ops } = await harness();
    const { op } = (await dispatch(ctx, "agents.stop", write({ name: "atlas" }))) as {
      op: { id: string };
    };
    await ops.wait(op.id);
    const mine = (await dispatch(ctx, "ops.list", { target: "atlas", status: "ok" })) as {
      ops: Array<{ id: string }>;
    };
    expect(mine.ops.map((o) => o.id)).toContain(op.id);
    expect(((await dispatch(ctx, "ops.list", { target: "corvid" })) as { ops: unknown[] }).ops).toEqual(
      [],
    );
    expect(
      ((await dispatch(ctx, "ops.list", { status: "running" })) as { ops: unknown[] }).ops,
    ).toEqual([]);
  });

  test("aborting an op that does not exist is reported, not an error", async () => {
    const { ctx } = await harness();
    expect(await dispatch(ctx, "ops.abort", { id: "nosuchop" })).toEqual({ aborted: false });
  });
});

describe("the fleet stream", () => {
  test("sends a snapshot before anything else", async () => {
    const { ctx, poller } = await harness();
    await poller.poll();
    const frames = await drain(ctx, "fleet.subscribe", {}, 200);
    expect(frames[0]?.event).toBe("snapshot");
    const first = JSON.stringify(frames[0]?.data);
    expect(first).toContain('"name":"atlas"');
    expect(first).toContain('"scanned":true');
  });

  // An empty snapshot from a poller that has not run is not an empty fleet, and
  // the dashboard cannot tell the two apart without being told.
  test("a snapshot sent before the first scan says it has not scanned", async () => {
    const { ctx } = await harness();
    const frames = await drain(ctx, "fleet.subscribe", {}, 200);
    expect(frames[0]?.event).toBe("snapshot");
    const first = JSON.stringify(frames[0]?.data);
    expect(first).toContain('"agents":[]');
    expect(first).toContain('"scanned":false');
  });

  // A reader dispatches its own `error` for a dead channel; a scan failure sent
  // under that name would read as a dropped connection.
  test("a failed scan is emitted as scan_error, not error", async () => {
    const { hermetic, poller } = await harness();
    const seen: string[] = [];
    poller.subscribe((e) => seen.push(e.type));
    hermetic.agents.list = () => Promise.reject(new Error("throttled"));
    await poller.poll();
    expect(seen).toContain("scan_error");
    expect(seen).not.toContain("error");
    expect(poller.snapshot().scanned).toBe(true);
  });

  /**
   * The fleet stream's subscription is the poller's, and it has to come back
   * however the handler leaves.
   *
   * `unsubscribe()` used to run only on the abort path and after the loop —
   * neither of which is on the path a throw takes. One failed write and the
   * listener stayed attached to the poller for the life of the process, called
   * for every scan, writing to a stream nobody would ever read.
   */
  test("a handler that throws before its loop still lets the poller go", async () => {
    const { hermetic, ops } = await harness();
    const listeners = new Set<unknown>();
    // A snapshot that cannot be serialised: the first thing the handler does
    // after subscribing is write one, and this makes that throw.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const poller = {
      subscribe(listener: unknown) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => circular,
    } as unknown as FleetPoller;
    const ctx = contextFor(hermetic, { ops, poller });

    // Deliberately not closed: a close is the path that already released the
    // listener, and it is the *other* path this is about.
    await dispatch(ctx, "fleet.subscribe", {}, (frame) => {
      JSON.stringify(frame.data);
    });
    await Bun.sleep(10);

    expect(listeners.size).toBe(0);
  });
});

/**
 * §4.6. Both writes are patches: what a request does not name it does not
 * change, and what it names it changes only if the version it composed against
 * is still the stored one.
 */
describe("the settings methods", () => {
  test("settings.get answers with the settings, the flag and the catalog", async () => {
    const { ctx } = await harness();
    const body = (await dispatch(ctx, "settings.get", {})) as {
      persisted: boolean;
      settings: { version: number; defaults: { provider: string } };
      catalog: Record<string, unknown>;
    };
    expect(body.persisted).toBe(true);
    expect(body.settings.version).toBe(1);
    expect(Object.keys(body.catalog)).toContain("nous");
  });

  test("settings.set moves the default profile and bumps the version", async () => {
    const { ctx } = await harness();
    const body = (await dispatch(
      ctx,
      "settings.set",
      write({ default_profile: "openrouter-cheap" }),
    )) as { settings: { version: number; default_profile: string } };
    expect(body.settings.default_profile).toBe(FIXTURE_PROFILE_IDS.openrouter);
    expect(body.settings.version).toBe(2);
    // And the read agrees, which is the whole point of a shared object.
    const after = (await dispatch(ctx, "settings.get", {})) as {
      settings: { default_profile: string };
    };
    expect(after.settings.default_profile).toBe(FIXTURE_PROFILE_IDS.openrouter);
  });

  test("a stale expected_version is CONFLICT, not a silent overwrite", async () => {
    const { ctx } = await harness();
    expect(
      await codeOf(
        dispatch(ctx, "settings.set", write({ defaults: { size: "large" }, expected_version: 42 })),
      ),
    ).toBe("CONFLICT");
  });

  test("making a disabled profile the fleet default is refused", async () => {
    const { ctx } = await harness();
    // `vercel-gw` is the fixture's disabled profile.
    expect(await codeOf(dispatch(ctx, "settings.set", write({ default_profile: "vercel-gw" })))).toBe(
      "VALIDATION",
    );
  });
});

/**
 * §8.2's fleet-level shared slots. Same three properties as the CLI's half: the
 * read never carries a value, the delete is refused while a provider still
 * names the slug, and a push's *value* survives nowhere — not the answer, not
 * the app log.
 */
describe("the shared secrets methods", () => {
  test("secrets.list lists the slots and their readers, with no values", async () => {
    const { ctx } = await harness();
    const body = (await dispatch(ctx, "secrets.list", {})) as {
      secrets: Array<{ slug: string; used_by: string[]; placeholder: boolean }>;
    };
    // The two hand-pushed slots, then the four the fixture's keyed provider
    // profiles own (§8.3) — listed in slug order like everything else here.
    expect(body.secrets.map((s) => s.slug)).toEqual(
      [
        "nous-key",
        "openrouter-key",
        ...(["anthropic", "openrouter", "nous", "vercel"] as const).map(
          (p) => `profile-${FIXTURE_PROFILE_IDS[p]}`,
        ),
      ].sort(),
    );
    expect(body.secrets.find((s) => s.slug === "nous-key")?.used_by).toEqual(["nous"]);
    expect(JSON.stringify(body)).not.toContain("sk-nous-FIXTURE");
  });

  test("a shared push writes the slot and answers with the path alone", async () => {
    const { ctx } = await harness();
    const secret = "sk-or-v1-FIXTURE-SHARED-BRIDGE";
    const body = (await dispatch(
      ctx,
      "secrets.push",
      write({ name: "_fleet", shared: "openrouter-key", label: "OpenRouter", value: secret }),
    )) as { path: string; rekeyed: string[] };
    // Fleet-scoped since foundation v3: two fleets in one account do not share
    // a shared-secret slot (§8.2). `fxtr0001` is the fixture fleet's id.
    expect(body.path).toBe("/hermetic/fxtr0001/secrets/openrouter-key");
    expect(body.rekeyed).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  test("what the app log records about a push is the slot, never the value", async () => {
    const lines: string[] = [];
    const hermetic = await openHermetic({ fixture: true, home: testHome() });
    const ctx = contextFor(hermetic, {
      // The real `formatLine`, not a test-only stringifier: this is what caught
      // the line printing `input=[object Object]` when the redacted input was
      // nested under one `input` key instead of spread as fields.
      log: {
        path: null,
        line: (level, scope, message, fields) => lines.push(formatLine(level, scope, message, fields)),
      },
    });
    const secret = "sk-or-v1-FIXTURE-SHARED-LOGGED";
    await dispatch(
      ctx,
      "secrets.push",
      write({ name: "_fleet", shared: "openrouter-key", value: secret }),
    );
    const recorded = lines.filter((l) => l.includes(" secrets "));
    expect(recorded.length).toBe(1);
    expect(recorded[0]).toContain("openrouter-key");
    expect(recorded[0]).not.toContain("[object Object]");
    // Never even a redacted placeholder under a `value` key: the line names the
    // slot and its flags, and that key does not appear at all.
    expect(recorded[0]).not.toMatch(/\bvalue=/);
    expect(lines.join("\n")).not.toContain(secret);
  });

  test("secrets.delete is refused while a provider names the slug", async () => {
    const { ctx } = await harness();
    const e = await refusal(dispatch(ctx, "secrets.delete", write({ slug: "nous-key", yes: true })));
    expect(e.code).toBe("CONFLICT");
    expect(e.message).toContain("nous");
  });

  /** A request that says which fleet and nothing else is a question, not a shape error. */
  test("secrets.delete with nothing but a target asks for confirmation", async () => {
    const { ctx } = await harness();
    expect(await codeOf(dispatch(ctx, "secrets.delete", write({ slug: "openrouter-key" })))).toBe(
      "CONFIRMATION_REQUIRED",
    );
  });

  test("secrets.delete removes a slug nothing names", async () => {
    const { ctx, hermetic } = await harness();
    expect(await dispatch(ctx, "secrets.delete", write({ slug: "openrouter-key", yes: true }))).toEqual(
      { slug: "openrouter-key", deleted: true },
    );
    const after = await hermetic.secrets.list();
    expect(after.secrets.map((s) => s.slug)).not.toContain("openrouter-key");
    expect(after.secrets.map((s) => s.slug)).toContain("nous-key");
  });
});

/**
 * §8.3's provider profiles. The two things worth asserting: that a draft
 * credential reaches core and nothing else, and that the delete demands its
 * confirmation the way every other destructive method does.
 */
describe("the provider profile methods", () => {
  test("providers.list lists the profiles with no slot value anywhere", async () => {
    const { ctx } = await harness();
    const listed = await dispatch(ctx, "providers.list", {});
    expect(listed).toMatchObject({ default_profile: FIXTURE_PROFILE_IDS.anthropic });
    expect(JSON.stringify(listed)).not.toContain("sk-profile-FIXTURE");
  });

  test("providers.delete without a confirmation is a question, not a deletion", async () => {
    const { ctx, hermetic } = await harness();
    expect(
      await codeOf(dispatch(ctx, "providers.delete", write({ profile: FIXTURE_PROFILE_IDS.vercel }))),
    ).toBe("CONFIRMATION_REQUIRED");
    const after = await hermetic.providers.list();
    expect(after.profiles.map((p) => p.id)).toContain(FIXTURE_PROFILE_IDS.vercel);
  });

  test("what the app log records about a catalog read is the provider, never the key", async () => {
    const lines: string[] = [];
    const hermetic = await openHermetic({ fixture: true, home: testHome() });
    const ctx = contextFor(hermetic, {
      log: {
        path: null,
        line: (level, scope, message, fields) => lines.push(formatLine(level, scope, message, fields)),
      },
    });
    const key = "sk-FIXTURE-DRAFT-CATALOG-KEY";
    const answer = await dispatch(ctx, "providers.models", { provider: "openai", api_key: key });
    const text = lines.join("");
    expect(text).toContain("providers.models");
    expect(text).toContain('provider="openai"');
    expect(text).toContain('api_key="(redacted)"');
    expect(text).not.toContain(key);
    expect(JSON.stringify(answer)).not.toContain(key);
  });
});

describe("instance listening", () => {
  test("fresh homes are disconnected until explicitly listened, and unlisten restores refusal", async () => {
    const { ctx } = await harness();
    expect(await dispatch(ctx, "chat.listening", {})).toEqual({ instances: [] });
    expect(await dispatch(ctx, "chat.swarms", {})).toEqual({ swarms: [] });
    expect(
      await codeOf(dispatch(ctx, "chat.history", { instance: "atlas", bot: "default" })),
    ).toBeString();
    const set = (listening: boolean) =>
      dispatch(ctx, "chat.listen", write({ instance: "atlas", listening }));
    expect(await set(true)).toEqual({ instances: ["atlas"] });
    const watched = (await dispatch(ctx, "chat.swarms", {})) as { swarms: { instance: string }[] };
    expect(watched.swarms.map((swarm) => swarm.instance)).toEqual(["atlas"]);
    expect(await set(false)).toEqual({ instances: [] });
    expect(await dispatch(ctx, "chat.swarms", {})).toEqual({ swarms: [] });
    expect(
      await codeOf(dispatch(ctx, "chat.sessions", { instance: "atlas", bot: "default" })),
    ).toBeString();
  });
});

describe("Bot Mode flows", () => {
  test("creates a profile, keeps its canonical identity and scopes room and routine writes", async () => {
    const { ctx, hermetic } = await harness();
    await hermetic.chat.listen({ instance: "atlas", listening: true });
    const call = (name: string, params: Record<string, unknown>) =>
      dispatch(ctx, name, write(params)) as Promise<Record<string, unknown>>;
    const ref = { instance: "atlas", bot: "reviewer" };
    await call("bots.create", { instance: "atlas", name: "reviewer", soul: "Review changes" });
    const canonical = await call("chat.open", ref);
    const separate = await call("chat.open", { ...ref, new_session: true });
    expect(separate.session).not.toBe(canonical.session);
    expect((await call("chat.open", ref)).session).toBe(canonical.session);
    const job = await call("routines.create", {
      ...ref,
      name: "Review",
      prompt: "Read changes",
      schedule: "0 8 * * *",
      deliver: "bot",
    });
    expect(job.deliver).toBe("bot");
    expect((await call("routines.list", { instance: "atlas", bot: "default" })).jobs).toEqual([]);
    await call("rooms.create", {
      instance: "atlas",
      room: "review",
      name: "Review",
      members: [ref, { instance: "atlas", bot: "default" }],
    });
    await call("rooms.send", {
      instance: "atlas",
      room: "review",
      text: "Discuss",
      event_id: "bridge-message",
    });
    expect((await call("rooms.history", { instance: "atlas", room: "review" })).events).toHaveLength(3);
    await hermetic.chat.listen({ instance: "atlas", listening: false });
    await expect(call("routines.list", ref)).rejects.toBeDefined();
  });
});
