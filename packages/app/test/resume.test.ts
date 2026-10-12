/**
 * Ops that outlive the process that started them (§4.6).
 *
 * `agents.create` waits for an instance to boot with no deadline
 * (`core/attach.ts`), so a portal closed mid-create is ordinary rather than
 * exceptional. These cover the durable half of that: a pending row written when
 * a resumable op starts, deleted the moment it settles, and replayed at the
 * next boot.
 */
import { describe, expect, test } from "bun:test";
import { MemoryPendingOpStore, openHermetic, type OpEvent } from "@hermetic/core";
import { memoryLog } from "../src/log.ts";
import { OpRegistry } from "../src/ops.ts";
import { isResumable, resumePendingOps } from "../src/resume.ts";
import { testHome } from "./home.ts";

/**
 * §4.7: a boot replays only the rows that name the fleet it opened, in full, so
 * every row written here says which fleet it was against and every call says
 * which fleet the boot came up on. A test that said neither used to exercise
 * the path where a resume claims every row in the home.
 */
const FLEET = { account_id: "123456789012", region: "us-east-1", fleet_id: "fxtr0001" };
const OF_FLEET = { fleet: FLEET.fleet_id, account_id: FLEET.account_id, region: FLEET.region };

function never(): AsyncIterable<OpEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {
        /* an op that is still running when the process dies */
      });
    },
  };
}

async function* onePhase(): AsyncIterable<OpEvent> {
  yield { phase: "done", progress: 1, message: "ok", at: new Date().toISOString() };
}

describe("the pending op log", () => {
  test("a resumable op claims a row while it runs and clears it when it settles", async () => {
    const pending = new MemoryPendingOpStore();
    const ops = new OpRegistry({ pending });

    const op = ops.start("agents.create", "atlas", () => onePhase(), {
      input: { name: "atlas" },
      resumable: true,
    });
    await ops.wait(op.id);

    expect(pending.list()).toEqual([]);
  });

  test("an op that never settles leaves its row behind", () => {
    const pending = new MemoryPendingOpStore();
    const ops = new OpRegistry({ pending });

    ops.start("agents.create", "atlas", () => never(), {
      input: { name: "atlas", size: "M" },
      resumable: true,
    });

    const rows = pending.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe("agents.create");
    expect(rows[0]!.target).toBe("atlas");
    expect(rows[0]!.input).toEqual({ name: "atlas", size: "M" });
  });

  test("an op that failed still clears its row: a pending row means a dead process, not a bad run", async () => {
    const pending = new MemoryPendingOpStore();
    const ops = new OpRegistry({ pending });

    const op = ops.start(
      "agents.create",
      "atlas",
      // biome-ignore lint/correctness/useYield: a test double for a long op that fails before its first event.
      async function* (): AsyncIterable<OpEvent> {
        throw new Error("quota exceeded");
      },
      { input: { name: "atlas" }, resumable: true },
    );
    await ops.wait(op.id);

    expect(pending.list()).toEqual([]);
  });

  test("ops that are not marked resumable claim nothing", async () => {
    const pending = new MemoryPendingOpStore();
    const ops = new OpRegistry({ pending });
    ops.start("teardown", null, () => never());
    expect(pending.list()).toEqual([]);
  });
});

describe("resumePendingOps", () => {
  test("restarts an interrupted create under its original id", async () => {
    const hermetic = await openHermetic({ fixture: true, home: testHome() });
    const pending = new MemoryPendingOpStore();
    pending.claim({
      ...OF_FLEET,
      id: "op-1",
      method: "agents.create",
      target: "resumed",
      input: { name: "resumed" },
      started_at: new Date().toISOString(),
    });
    const ops = new OpRegistry({ pending });

    const outcome = await resumePendingOps({ ops, pending, hermetic: () => hermetic, fleet: FLEET });
    expect(outcome.resumed).toEqual(["op-1"]);
    // The id survives, so a browser that was following this op before the
    // restart reattaches to the same stream.
    expect(ops.get("op-1")?.method).toBe("agents.create");

    const summary = await ops.wait("op-1");
    expect(summary?.status).toBe("ok");
    expect((await hermetic.agents.get("resumed")).name).toBe("resumed");
    // Settled, so it is no longer pending.
    expect(pending.list()).toEqual([]);
  });

  test("drops a row whose method is not resumable", async () => {
    const pending = new MemoryPendingOpStore();
    pending.claim({
      ...OF_FLEET,
      id: "op-2",
      method: "init",
      target: null,
      input: {},
      started_at: new Date().toISOString(),
    });
    const ops = new OpRegistry({ pending });

    const outcome = await resumePendingOps({
      ops,
      pending,
      hermetic: () => ({}) as never,
      fleet: FLEET,
    });
    expect(outcome).toEqual({ resumed: [], dropped: ["op-2"], skipped: [], deferred: [], manual: [] });
    expect(pending.list()).toEqual([]);
  });

  test("drops a row whose recorded input no longer validates", async () => {
    const pending = new MemoryPendingOpStore();
    pending.claim({
      ...OF_FLEET,
      id: "op-3",
      method: "agents.create",
      target: "x",
      input: { name: 42 },
      started_at: new Date().toISOString(),
    });
    const ops = new OpRegistry({ pending });

    const outcome = await resumePendingOps({
      ops,
      pending,
      hermetic: () => ({}) as never,
      fleet: FLEET,
    });
    expect(outcome.dropped).toEqual(["op-3"]);
  });

  /** An op that takes the process down with it must not do so forever. */
  test("gives up after the attempt cap", async () => {
    const pending = new MemoryPendingOpStore();
    pending.claim({
      ...OF_FLEET,
      id: "op-4",
      method: "agents.create",
      target: "atlas",
      input: { name: "atlas" },
      started_at: new Date().toISOString(),
      attempts: 3,
    });
    const ops = new OpRegistry({ pending });

    const outcome = await resumePendingOps({
      ops,
      pending,
      hermetic: () => ({}) as never,
      fleet: FLEET,
      maxAttempts: 3,
    });
    expect(outcome).toEqual({ resumed: [], dropped: ["op-4"], skipped: [], deferred: [], manual: [] });
    expect(pending.list()).toEqual([]);
  });

  /**
   * A resume finishes what the operator asked for; a portal opened a week later
   * is a different moment, and the one destructive method in the table makes
   * that distinction matter.
   */
  test("drops a row too old to finish unattended", async () => {
    const pending = new MemoryPendingOpStore();
    pending.claim({
      ...OF_FLEET,
      id: "op-5",
      method: "agents.destroy",
      target: "atlas",
      input: { name: "atlas", yes: true },
      started_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      // Its age is what this test is about, so the row is otherwise beyond
      // reproach: it says which agent it was confirmed against — both halves,
      // which is what a destroy needs — and a boot would have finished it an
      // hour after it stopped.
      target_identity: {
        instance_id: "i-0123456789abcdef0",
        created_at: "2026-09-01T00:00:00.000Z",
      },
    });
    const ops = new OpRegistry({ pending });

    const outcome = await resumePendingOps({
      ops,
      pending,
      hermetic: () => ({}) as never,
      fleet: FLEET,
    });
    expect(outcome).toEqual({ resumed: [], dropped: ["op-5"], skipped: [], deferred: [], manual: [] });
    expect(pending.list()).toEqual([]);
  });

  test("a destroy interrupted a moment ago is finished", async () => {
    const hermetic = await openHermetic({ fixture: true, home: testHome() });
    const name = (await hermetic.agents.list())[0]!.name;
    const confirmed = await hermetic.agents.get(name);
    const pending = new MemoryPendingOpStore();
    pending.claim({
      ...OF_FLEET,
      id: "op-6",
      method: "agents.destroy",
      target: name,
      input: { name, yes: true },
      started_at: new Date().toISOString(),
      // §4.6: which agent it was confirmed against. Without it the row is one
      // no boot finishes for the operator (`core/local/recovery.ts`).
      target_identity: {
        instance_id: confirmed.instance_id ?? null,
        created_at: confirmed.created_at ?? null,
      },
    });
    const ops = new OpRegistry({ pending });

    expect(
      (await resumePendingOps({ ops, pending, hermetic: () => hermetic, fleet: FLEET })).resumed,
    ).toEqual(["op-6"]);
    expect((await ops.wait("op-6"))?.status).toBe("ok");
    // §6.7: finished means released — the row is gone and a tombstone names it.
    expect((await hermetic.agents.list({})).map((a) => a.name)).not.toContain(name);
    expect((await hermetic.agents.destroyed({ name })).map((t) => t.name)).toEqual([name]);
  });

  test("only idempotent, secret-free methods are resumable", () => {
    expect(isResumable("agents.create")).toBe(true);
    // Not recreate: it replaces a live instance unconditionally, so a replay
    // can destroy the replacement the interrupted attempt already built.
    expect(isResumable("agents.recreate")).toBe(false);
    // Destructive, but every step checks reality before acting, so finishing an
    // interrupted destroy is safe — and leaving one half-done is not (§6.6).
    expect(isResumable("agents.destroy")).toBe(true);
    // `init` carries the Tailscale OAuth client secret (§8.3); `teardown` is
    // not idempotent against reality.
    expect(isResumable("init")).toBe(false);
    expect(isResumable("teardown")).toBe(false);
  });
});

/**
 * §4.7: what a boot has to believe before it finishes somebody's interrupted
 * work — that the row was this fleet's, and that the agent it names is still
 * the agent it was confirmed against.
 *
 * Both are ways of replaying an instruction onto the wrong thing, and neither
 * needs a race to happen: the first is a laptop that has two fleets and opens
 * the other one, the second is an operator who destroys `atlas` and makes a new
 * `atlas` before the portal comes back.
 */
describe("resumePendingOps, bound to the fleet it booted on", () => {
  const TARGET = FLEET;
  const ELSEWHERE = { ...TARGET, account_id: "210987654321" };

  function claim(pending: MemoryPendingOpStore, id: string, row: object): void {
    pending.claim({
      id,
      method: "agents.create",
      target: "atlas",
      input: { name: "atlas" },
      started_at: new Date().toISOString(),
      ...row,
    });
  }

  test("a row that cannot say which fleet it was against is replayed by nobody", async () => {
    const pending = new MemoryPendingOpStore();
    // From before pending rows named a fleet at all.
    claim(pending, "op-null", {});
    // From after they named one, and before naming one meant naming all three:
    // the same eight characters can be minted in any account.
    claim(pending, "op-partial", { fleet: TARGET.fleet_id });
    claim(pending, "op-other", {
      fleet: ELSEWHERE.fleet_id,
      account_id: ELSEWHERE.account_id,
      region: ELSEWHERE.region,
    });
    const ops = new OpRegistry({ pending });

    const outcome = await resumePendingOps({
      ops,
      pending,
      hermetic: () => ({}) as never,
      fleet: TARGET,
    });
    expect(outcome).toEqual({ resumed: [], dropped: [], skipped: [], deferred: [], manual: [] });
    // Not dropped either: every one of them is still somebody's unfinished
    // work, and this boot is only saying it is not the one to finish it.
    expect(
      pending
        .list()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["op-null", "op-other", "op-partial"]);
  });

  test("a row naming this fleet in full is the one that runs", async () => {
    const hermetic = await openHermetic({ fixture: true, home: testHome() });
    const pending = new MemoryPendingOpStore();
    claim(pending, "op-mine", {
      target: "resumed-here",
      input: { name: "resumed-here" },
      fleet: TARGET.fleet_id,
      account_id: TARGET.account_id,
      region: TARGET.region,
    });
    const ops = new OpRegistry({ pending });

    const outcome = await resumePendingOps({
      ops,
      pending,
      hermetic: () => hermetic,
      fleet: TARGET,
    });
    expect(outcome.resumed).toEqual(["op-mine"]);
    await ops.wait("op-mine");
  });
});

describe("resumePendingOps, bound to the agent it was confirmed against", () => {
  /**
   * The row records what the agent looked like when the operator confirmed. A
   * name is a label that can be freed and taken again, so a destroy confirmed
   * against one `atlas` and replayed a boot later would otherwise land on its
   * successor — a different machine, a different disk, and an instruction
   * nobody gave about it.
   */
  test("a destroy is not replayed onto an agent created after it was confirmed", async () => {
    const hermetic = await openHermetic({ fixture: true, home: testHome() });
    const name = (await hermetic.agents.list())[0]!.name;
    const live = await hermetic.agents.get(name);
    const pending = new MemoryPendingOpStore();
    pending.claim({
      ...OF_FLEET,
      id: "op-reused",
      method: "agents.destroy",
      target: name,
      input: { name, yes: true },
      started_at: new Date().toISOString(),
      // The predecessor: same name, made earlier, and gone by the time this
      // boot reads the table.
      target_identity: { instance_id: "i-00000000000000000", created_at: "2020-01-01T00:00:00Z" },
    });
    const ops = new OpRegistry({ pending });

    const outcome = await resumePendingOps({ ops, pending, hermetic: () => hermetic, fleet: FLEET });
    expect(outcome).toEqual({
      resumed: [],
      dropped: [],
      skipped: ["op-reused"],
      deferred: [],
      manual: [],
    });
    // The agent the operator never asked about is untouched, and the row stays
    // on disk as the only local record that the command was ever given.
    expect((await hermetic.agents.get(name)).status).toBe(live.status);
    expect(pending.list().map((r) => r.id)).toEqual(["op-reused"]);
  });

  test("a destroy is not replayed onto an agent recreated since it was confirmed", async () => {
    const hermetic = await openHermetic({ fixture: true, home: testHome() });
    const name = (await hermetic.agents.list())[1]!.name;
    const live = await hermetic.agents.get(name);
    const pending = new MemoryPendingOpStore();
    pending.claim({
      ...OF_FLEET,
      id: "op-moved",
      method: "agents.destroy",
      target: name,
      input: { name, yes: true },
      started_at: new Date().toISOString(),
      // Same row, same `created_at`; a different machine under it.
      target_identity: { instance_id: "i-00000000000000000", created_at: live.created_at ?? null },
    });
    const ops = new OpRegistry({ pending });

    const outcome = await resumePendingOps({ ops, pending, hermetic: () => hermetic, fleet: FLEET });
    expect(outcome.skipped).toEqual(["op-moved"]);
    expect((await hermetic.agents.get(name)).status).toBe(live.status);
  });

  test("a destroy whose agent is the one it was confirmed against is finished", async () => {
    const hermetic = await openHermetic({ fixture: true, home: testHome() });
    const name = (await hermetic.agents.list())[2]!.name;
    const live = await hermetic.agents.get(name);
    const pending = new MemoryPendingOpStore();
    pending.claim({
      ...OF_FLEET,
      id: "op-same",
      method: "agents.destroy",
      target: name,
      input: { name, yes: true },
      started_at: new Date().toISOString(),
      target_identity: {
        instance_id: live.instance_id ?? null,
        created_at: live.created_at ?? null,
      },
    });
    const ops = new OpRegistry({ pending });

    const outcome = await resumePendingOps({ ops, pending, hermetic: () => hermetic, fleet: FLEET });
    expect(outcome.resumed).toEqual(["op-same"]);
    expect((await ops.wait("op-same"))?.status).toBe("ok");
    expect((await hermetic.agents.list({})).map((a) => a.name)).not.toContain(name);
    expect((await hermetic.agents.destroyed({ name })).map((t) => t.name)).toEqual([name]);
  });
});

/**
 * §4.7: a boot that cannot name its fleet replays nothing.
 *
 * `fleet` used to be optional and to fall through to "every row in this home",
 * so the one caller that could not say which fleet it was on — a portal whose
 * `state.target` is null — got the widest replay there is rather than none.
 * Fleet-wide state is not a default to fail open into.
 */
describe("resumePendingOps, on a server serving no fleet", () => {
  test("replays nothing at all, and leaves every row where it is", async () => {
    const pending = new MemoryPendingOpStore();
    pending.claim({
      ...OF_FLEET,
      id: "op-somebodys",
      method: "agents.create",
      target: "atlas",
      input: { name: "atlas" },
      started_at: new Date().toISOString(),
    });
    const ops = new OpRegistry({ pending });
    const log = memoryLog();

    const outcome = await resumePendingOps({
      ops,
      pending,
      hermetic: () => ({}) as never,
      fleet: null,
      log,
    });
    expect(outcome).toEqual({ resumed: [], dropped: [], skipped: [], deferred: [], manual: [] });
    expect(ops.list({ limit: 10 }).ops).toHaveLength(0);
    expect(pending.list().map((r) => r.id)).toEqual(["op-somebodys"]);
    expect(log.lines.join("\n")).toContain("serving no fleet");
  });
});
