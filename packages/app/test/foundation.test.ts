/**
 * §6.6 through the head: the two reads, the op, and the mutual exclusion
 * between a running foundation update and everything else that writes to the
 * fleet.
 *
 * Driven through `dispatch`, so a refusal is asserted as the code the handler
 * threw rather than as a status a table happened to map it to — the same move
 * `handlers/dispatch.test.ts` explains at length.
 *
 * The guard tests drive `AppState` directly rather than racing a real op.
 * `updateBlocked` is a pure function of `state.foundationUpdateOpId`, and a test
 * that has to win a race against the fixture backend's own speed is a test that
 * will eventually lose one.
 */
import { describe, expect, test } from "bun:test";
import { HermeticError, isHermeticError, openHermetic } from "@hermetic/core";
import { Run as RunSchema } from "@hermetic/core";
import type { Hermetic, RecordRunInput, RunRecorder } from "@hermetic/core";
import { createChatOwner } from "../src/chat-owner.ts";
import type { HandlerContext } from "../src/handlers/ctx.ts";
import { dispatch } from "../src/handlers/dispatch.ts";
import { createStreamRegistry } from "../src/handlers/streams.ts";
import { OpRegistry } from "../src/ops.ts";
import { AppState } from "../src/state.ts";
import { testHome } from "./home.ts";

/** The context the bridge builds, over one instance and one op registry. */
function contextFor(state: AppState, ops: OpRegistry): HandlerContext {
  return {
    state,
    hermetic: () => state.hermetic,
    ops,
    poller: () => state.poller,
    chatOwner: createChatOwner({ hermetic: () => state.hermetic }),
    fixture: true,
    opts: { fixture: true },
    streams: createStreamRegistry(),
  };
}

async function harness() {
  const hermetic: Hermetic = await openHermetic({ fixture: true, home: testHome() });
  const ops = new OpRegistry();
  const state = new AppState({
    fixture: true,
    home: testHome(),
    reopen: () => Promise.resolve(hermetic),
    hermetic,
  });
  return { hermetic, ops, state, ctx: contextFor(state, ops) };
}

/** A harness over an instance somebody else built, for the doubled cases. */
function harnessOver(hermetic: Hermetic, ops = new OpRegistry()) {
  const state = new AppState({
    fixture: true,
    home: testHome(),
    reopen: () => Promise.resolve(hermetic),
    hermetic,
  });
  return { ops, state, ctx: contextFor(state, ops) };
}

/** The `HermeticError` a call threw, or a failure saying it did not throw one. */
async function refusal(run: Promise<unknown>): Promise<HermeticError> {
  try {
    await run;
  } catch (e) {
    if (isHermeticError(e)) return e;
    throw e;
  }
  throw new Error("expected a refusal; the call resolved");
}

interface StatusBody {
  fleet: { foundation_version: number; hermeticd_version: string };
  available: { foundation_version: number; hermeticd_version: string };
  update_available: boolean;
  tool_outdated: boolean;
  in_progress: unknown;
  agents: Array<{ name: string; current: boolean }>;
}

describe("the foundation reads", () => {
  test("foundation.status answers the whole status", async () => {
    const { ctx } = await harness();
    const body = (await dispatch(ctx, "foundation.status", {})) as StatusBody;
    expect(body.fleet.foundation_version).toBeNumber();
    expect(body.available.hermeticd_version).toBeString();
    expect(body.update_available).toBeBoolean();
    expect(body.tool_outdated).toBeBoolean();
    expect(body.in_progress).toBeNull();
    expect(body.agents.length).toBeGreaterThan(0);
  });

  test("plan.foundation answers a foundation-kind plan and executes nothing", async () => {
    const { ctx, hermetic } = await harness();
    const before = await hermetic.foundation.status();
    const plan = (await dispatch(ctx, "plan.foundation", {})) as {
      kind: string;
      steps: Array<{ id: string }>;
    };
    expect(plan.kind).toBe("foundation");
    expect(plan.steps.map((s) => s.id)).toEqual([
      "preflight",
      "archive",
      "stack",
      "bedrock-grant",
      "artifacts",
      "migrate",
      "rollout",
    ]);
    // A plan is a read: nothing about the fleet moved.
    expect(await hermetic.foundation.status()).toEqual(before);
  });
});

describe("foundation.update", () => {
  test("starts the op core declares", async () => {
    const { ctx, ops } = await harness();
    const { op } = (await dispatch(ctx, "foundation.update", { yes: true })) as {
      op: { id: string };
    };
    const summary = await ops.wait(op.id);
    expect(summary?.method).toBe("foundation.update");
    expect(summary?.status).toBe("ok");
  }, 30_000);

  test("the slot is claimed for the op and released when it settles", async () => {
    const { ctx, ops, state } = await harness();
    const { op } = (await dispatch(ctx, "foundation.update", { yes: true })) as {
      op: { id: string };
    };
    // Claimed synchronously, before the handler returned.
    expect(state.foundationUpdateOpId).toBe(op.id);
    await ops.wait(op.id);
    // `ops.wait` resolves from the same promise the release is chained to, so
    // yield once before reading it back.
    await Promise.resolve();
    expect(state.foundationUpdateOpId).toBeNull();
  }, 30_000);
});

describe("the update confirms before it starts", () => {
  test("an empty request is CONFIRMATION_REQUIRED, not a fleet-wide update", async () => {
    const { ctx, ops, state } = await harness();
    expect((await refusal(dispatch(ctx, "foundation.update", {}))).code).toBe("CONFIRMATION_REQUIRED");
    // Nothing started, and nothing claimed the slot.
    expect(state.foundationUpdateOpId).toBeNull();
    expect(ops.list({}).ops.length).toBe(0);
  });

  test("`yes: false` is refused as plainly as an absent one", async () => {
    const { ctx } = await harness();
    expect((await refusal(dispatch(ctx, "foundation.update", { yes: false }))).code).toBe(
      "CONFIRMATION_REQUIRED",
    );
  });
});

/**
 * B10, §4.6/§4.9: an applied plan's run row — and so the `operation.done` row
 * core raises from it — names an agent only when the plan is about one. A
 * `tailnet` policy plan once landed as agent `tailnet`, which the inbox's
 * listening filter then hid as an unlistened instance.
 */
describe("apply records the plan's agent, not a fleet-level target", () => {
  function recordingHarness(hermetic: Hermetic) {
    const rows: RecordRunInput[] = [];
    const runs: RunRecorder = {
      start: (input) => {
        rows.push(input);
        return RunSchema.parse({
          id: input.id ?? "row",
          command: input.command,
          args: input.args ?? [],
          agent: input.agent ?? null,
          started_at: input.started_at ?? new Date(0).toISOString(),
          finished_at: null,
          exit_code: null,
          log: "",
          fleet: null,
          account_id: null,
          region: null,
          fleet_name: null,
        });
      },
      annotate: () => {},
      finish: () => {},
      list: async () => [],
      close: () => {},
    };
    return { rows, ...harnessOver(hermetic, new OpRegistry({ runs })) };
  }

  const cases = [
    { kind: "policy", target: "tailnet", agent: null },
    { kind: "destroy", target: "atlas", agent: "atlas" },
  ] as const;
  for (const c of cases) {
    test(`a ${c.kind} plan records agent ${String(c.agent)}`, async () => {
      const hermetic = await openHermetic({ fixture: true, home: testHome() });
      const { ctx, ops, rows } = recordingHarness(hermetic);
      const plan = { kind: c.kind, target: c.target, options: {}, steps: [], warnings: [] };
      const { op } = (await dispatch(ctx, "apply", { plan, yes: true })) as { op: { id: string } };
      await ops.wait(op.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ command: "apply", args: [c.target], agent: c.agent });
    });
  }
});

/**
 * §6.6 through `apply`: core dispatches a `foundation`-kind plan straight into
 * `foundation.update`, so this method *is* the update method wearing a plan and
 * owes the same bookkeeping.
 */
describe("apply of a foundation plan is a foundation update", () => {
  const foundationPlan = {
    plan: { kind: "foundation", target: "hermetic-fxtr0001", options: {}, steps: [], warnings: [] },
    yes: true,
  };
  const destroyPlan = {
    plan: { kind: "destroy", target: "atlas", options: {}, steps: [], warnings: [] },
    yes: true,
  };

  test("claims the same slot the update does, and releases it", async () => {
    const { ctx, ops, state } = await harness();
    const { op } = (await dispatch(ctx, "apply", foundationPlan)) as { op: { id: string } };
    expect(state.foundationUpdateOpId).toBe(op.id);
    await ops.wait(op.id);
    await Promise.resolve();
    expect(state.foundationUpdateOpId).toBeNull();
  }, 30_000);

  test("a non-foundation plan claims nothing", async () => {
    const { ctx, state } = await harness();
    await dispatch(ctx, "apply", destroyPlan);
    expect(state.foundationUpdateOpId).toBeNull();
  });
});

describe("a running foundation update excludes every other write", () => {
  const guarded: Array<{ name: string; params: Record<string, unknown> }> = [
    { name: "agents.create", params: { name: "probe" } },
    { name: "agents.stop", params: { name: "atlas" } },
    { name: "agents.start", params: { name: "atlas" } },
    { name: "agents.set", params: { name: "atlas", size: "large" } },
    { name: "agents.recreate", params: { name: "atlas", yes: true } },
    { name: "agents.destroy", params: { name: "atlas", yes: true } },
    { name: "agents.rerun", params: { name: "heron" } },
    { name: "secrets.push", params: { name: "kestrel", bws_token: true, value: "bws-probe" } },
    { name: "upgrade", params: { name: "atlas", hermes: "0.15.1" } },
    { name: "teardown", params: { yes: true, confirm_account_id: "123456789012" } },
  ];

  for (const g of guarded) {
    test(`${g.name} is refused while a foundation update is running`, async () => {
      const { ctx, state } = await harness();
      state.beginFoundationUpdate("op-probe");
      const e = await refusal(dispatch(ctx, g.name, g.params));
      expect([e.code, e.message]).toEqual(["CONFLICT", "foundation update in progress"]);
    });
  }

  test("the reads stay open — watching an update is the point", async () => {
    const { ctx, state } = await harness();
    state.beginFoundationUpdate("op-probe");
    for (const name of ["agents.list", "foundation.status", "meta.get"]) {
      expect(await dispatch(ctx, name, {})).toBeDefined();
    }
  });

  /**
   * `plan.foundation` is the exception among the reads: it asks CloudFormation
   * to compute a real change set against the stack the update is in the middle
   * of changing, which CloudFormation refuses. Better to name the op than to
   * relay a raw CFN error.
   */
  test("plan.foundation is refused and names the running op", async () => {
    const { ctx, state } = await harness();
    state.beginFoundationUpdate("op-probe");
    const e = await refusal(dispatch(ctx, "plan.foundation", {}));
    expect([e.code, e.message, e.details]).toEqual([
      "CONFLICT",
      "foundation update in progress",
      { op_id: "op-probe" },
    ]);
  });

  test("artifacts.push is refused too — the update prunes release prefixes", async () => {
    const { ctx, state } = await harness();
    state.beginFoundationUpdate("op-probe");
    const e = await refusal(dispatch(ctx, "artifacts.push", { version: "9.9.9" }));
    expect([e.code, e.message]).toEqual(["CONFLICT", "foundation update in progress"]);
  });

  test("apply is refused too — a plan must not be the way around the guard", async () => {
    const { ctx, state } = await harness();
    state.beginFoundationUpdate("op-probe");
    const e = await refusal(
      dispatch(ctx, "apply", {
        plan: { kind: "destroy", target: "atlas", options: {}, steps: [], warnings: [] },
        yes: true,
      }),
    );
    expect(e.code).toBe("CONFLICT");
  });

  test("and a running teardown blocks the update, so the two exclude each other", async () => {
    const { ctx, state } = await harness();
    state.beginTeardown("op-teardown");
    const e = await refusal(dispatch(ctx, "foundation.update", { yes: true }));
    expect([e.code, e.message]).toEqual(["CONFLICT", "teardown in progress"]);
  });
});

describe("the slot is released however the op ends", () => {
  /**
   * The `.finally` contract, proved against the case that matters: an op that
   * *fails* must not leave the fleet looking permanently mid-update. Without
   * the `finally` this is the bug where one failed update wedges every agent
   * mutation until the app is restarted.
   */
  test("a rejecting foundation.update still clears the slot", async () => {
    const { hermetic } = await harness();
    const broken: Hermetic = {
      ...hermetic,
      foundation: {
        ...hermetic.foundation,
        // biome-ignore lint/correctness/useYield: a test double for a long op that fails before its first event.
        update: async function* () {
          throw new Error("CreateChangeSet refused");
        },
      },
    };
    const { ctx, ops, state } = harnessOver(broken);
    const { op } = (await dispatch(ctx, "foundation.update", { yes: true })) as {
      op: { id: string };
    };
    // Deliberately no mid-flight assertion here: this generator throws on its
    // first pull, which can happen before the handler has even returned, so
    // "the slot is set right now" is a race. That the slot is *claimed* is
    // proved by the abort case below, which blocks; what this pins is the
    // release.
    const summary = await ops.wait(op.id);
    expect(summary?.status).toBe("error");
    await Promise.resolve();
    expect(state.foundationUpdateOpId).toBeNull();
  });

  test("an aborted one clears it too", async () => {
    const { hermetic } = await harness();
    const broken: Hermetic = {
      ...hermetic,
      foundation: {
        ...hermetic.foundation,
        update: async function* (_input: unknown, opts: { signal?: AbortSignal } = {}) {
          yield {
            phase: "preflight",
            progress: 0,
            message: "started",
            at: new Date().toISOString(),
          };
          await new Promise<void>((resolve) => {
            opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new HermeticError("ABORTED", "cancelled");
        },
      },
    } as Hermetic;
    const { ctx, ops, state } = harnessOver(broken);
    const { op } = (await dispatch(ctx, "foundation.update", { yes: true })) as {
      op: { id: string };
    };
    expect(state.foundationUpdateOpId).toBe(op.id);
    ops.abort(op.id);
    await ops.wait(op.id);
    await Promise.resolve();
    expect(state.foundationUpdateOpId).toBeNull();
  });
});

describe("meta.get carries the foundation status", () => {
  test("initialized: the same document foundation.status answers", async () => {
    const { ctx } = await harness();
    const meta = (await dispatch(ctx, "meta.get", {})) as {
      initialized: boolean;
      foundation: StatusBody | null;
    };
    expect(meta.initialized).toBe(true);
    expect(meta.foundation).not.toBeNull();
    expect(meta.foundation).toEqual((await dispatch(ctx, "foundation.status", {})) as StatusBody);
  });

  test("a failing status read is null, not a failed meta.get", async () => {
    const { hermetic } = await harness();
    // The whole dashboard boots from `meta.get`; a `_fleet` it cannot read must
    // degrade the pill, not the page.
    const broken: Hermetic = {
      ...hermetic,
      foundation: {
        ...hermetic.foundation,
        status: () => Promise.reject(new Error("no _fleet item")),
      },
    };
    const { ctx } = harnessOver(broken);
    expect(await dispatch(ctx, "meta.get", {})).toMatchObject({ foundation: null });
  });
});
