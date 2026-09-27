/**
 * §5's fleet network mode: `network.status`, `plan.network`, and the `apply` of
 * a network plan.
 *
 * The properties worth a test are the ones the design rests on. CloudFormation
 * owns the answer, so `status` reports the stack beside the `_fleet` cache and
 * says whether they agree. A mode switch cannot move a running instance, so the
 * op reports drift by name and never recreates anything. And the one direction
 * that would break a fleet — removing private subnets while instances are still
 * in them — is refused twice: once when the plan is made and once when it is
 * applied, because an agent can be created in between.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  MemoryBackend,
  fixtureConfigFor,
  seedFixtureAgents,
  seedFixtureFoundation,
} from "../src/backend/memory.ts";
import { readFleetManifest } from "../src/release/artifacts.ts";
import { HermeticError } from "../src/errors.ts";
import { FLEET_KEY, type OpEvent, type Plan } from "../src/schema/index.ts";
import type { HermeticDeps } from "../src/hermetic.ts";
import { drain, testHermetic } from "./helpers.ts";

/** Milliseconds, not seconds: no test waits on a change set poll. */
const FAST: NonNullable<HermeticDeps["foundation"]> = { changeSetPollMs: 0, heartbeatMs: 60_000 };

/** The `main` fixture fleet: twelve agents, `public`. */
function publicFleet(foundation: NonNullable<HermeticDeps["foundation"]> = FAST) {
  const backend = seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
  return {
    backend,
    hermetic: testHermetic({ backend, config: FIXTURE_CONFIG, foundation }),
  };
}

/** The `staging` fixture fleet: two agents, `nat`. */
function natFleet() {
  const config = fixtureConfigFor("staging");
  const backend = seedFixtureAgents(seedFixtureFoundation(new MemoryBackend(), { fleet: "staging" }), {
    fleet: "staging",
  });
  return { backend, hermetic: testHermetic({ backend, config, foundation: FAST }) };
}

/**
 * A `nat` fleet whose private subnets really are empty: every agent row has let
 * go of its instance and every instance is gone from EC2. The distinction
 * matters now that the refusal asks EC2 rather than the agents table — a row
 * with no `instance_id` does not make a subnet deletable if the box is still
 * there.
 */
async function emptyPrivateSubnets(backend: MemoryBackend): Promise<void> {
  for (const agent of await backend.store.agents.scan()) {
    if (agent.instance_id) {
      await backend.store.agents.update(agent.name, agent.version, { instance_id: null });
    }
  }
  backend.instances.clear();
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof HermeticError ? e.code : `not-a-HermeticError:${String(e)}`;
  }
}

/** The distinct phases an op emitted, in the order they first appeared. */
function phases(events: readonly OpEvent[]): string[] {
  const seen: string[] = [];
  for (const e of events) if (seen.at(-1) !== e.phase) seen.push(e.phase);
  return seen;
}

describe("network.status", () => {
  test("a public fleet reports public, consistent, and no NAT to check", async () => {
    const { hermetic } = publicFleet();
    const report = await hermetic.network.status();
    expect(report.mode).toBe("public");
    expect(report.stack_mode).toBe("public");
    expect(report.consistent).toBe(true);
    expect(report.subnet_ids).toEqual(["subnet-fixture0", "subnet-fixture1"]);
    /**
     * `null` rather than a healthy-looking blank. A `public` fleet has no NAT
     * appliance, and a head must render that as unchecked rather than as a
     * check that passed (§9).
     */
    expect(report.nat).toBeNull();
    expect(report.egress_ip).toBeNull();
    expect(report.drifted).toBe(0);
    expect(report.agents.every((a) => a.placement === "matches" || a.placement === "unknown")).toBe(
      true,
    );
  });

  test("a nat fleet reports its NAT instance, its route and its stable egress ip", async () => {
    const { hermetic } = natFleet();
    const report = await hermetic.network.status();
    expect(report.mode).toBe("nat");
    expect(report.stack_mode).toBe("nat");
    expect(report.consistent).toBe(true);
    expect(report.subnet_ids).toEqual(["subnet-fixture-private0", "subnet-fixture-private1"]);
    expect(report.egress_ip).toBe("203.0.113.200");
    expect(report.nat?.instance_state).toBe("running");
    expect(report.nat?.route_state).toBe("active");
  });

  /**
   * The cache is only a cache. A `_fleet` that disagrees with CloudFormation is
   * a wrong answer in a report, never a wrong subnet — but it must be *said*,
   * because the two look identical from the outside.
   */
  test("a `_fleet` that disagrees with the stack is reported inconsistent", async () => {
    const { backend, hermetic } = publicFleet();
    backend.fleetItem = { ...backend.fleetItem!, network: "nat" };
    const report = await hermetic.network.status();
    expect(report.mode).toBe("nat");
    expect(report.stack_mode).toBe("public");
    expect(report.consistent).toBe(false);
  });

  test("a `_fleet` with no network at all is inconsistent, not public", async () => {
    const { backend, hermetic } = publicFleet();
    const { network: _drop, ...rest } = backend.fleetItem!;
    backend.fleetItem = rest;
    const report = await hermetic.network.status();
    expect(report.mode).toBeNull();
    expect(report.consistent).toBe(false);
  });

  test("an instance outside the stack's current subnets is drifted, by name", async () => {
    const { backend, hermetic } = publicFleet();
    const atlas = await backend.store.agents.get("atlas");
    const instance = backend.instances.get(atlas!.instance_id as string)!;
    backend.instances.set(instance.instance_id, { ...instance, subnet_id: "subnet-somewhere-else" });
    const report = await hermetic.network.status();
    expect(report.drifted).toBe(1);
    const row = report.agents.find((a) => a.name === "atlas");
    expect(row?.placement).toBe("drifted");
    expect(row?.subnet_id).toBe("subnet-somewhere-else");
  });

  /**
   * An agent with no instance is `unknown`, never `drifted`: there is nothing in
   * the wrong subnet, so there is nothing to recreate, and calling it drift
   * would put a recreate in front of an operator for a box that does not exist.
   */
  test("an agent with no instance is unknown, not drifted", async () => {
    const { backend, hermetic } = publicFleet();
    const atlas = await backend.store.agents.get("atlas");
    await backend.store.agents.update("atlas", atlas!.version, { instance_id: null });
    const report = await hermetic.network.status();
    expect(report.agents.find((a) => a.name === "atlas")?.placement).toBe("unknown");
    expect(report.drifted).toBe(0);
  });
});

describe("plan.network", () => {
  test("refuses a target the fleet is already in", async () => {
    const { hermetic } = publicFleet();
    expect(await codeOf(() => hermetic.plan.network({ to: "public" }))).toBe("CONFLICT");
  });

  /**
   * CloudFormation cannot delete a subnet that still holds an ENI. A `nat` →
   * `public` change set against a fleet with live private-subnet instances
   * would roll back part-way and leave the NAT half-removed with the default
   * route pointing at nothing — so it is refused rather than attempted.
   */
  test("refuses nat → public while agents are still in the private subnets", async () => {
    const { hermetic } = natFleet();
    const code = await codeOf(() => hermetic.plan.network({ to: "public" }));
    expect(code).toBe("AGENTS_EXIST");
    await expect(hermetic.plan.network({ to: "public" })).rejects.toThrow(/ember/);
  });

  test("allows nat → public once nothing is left in those subnets", async () => {
    const { backend, hermetic } = natFleet();
    // Destroyed properly: the rows let go of their instances *and* the boxes
    // are gone. Clearing only the rows would leave the ENIs behind, which is
    // still a subnet CloudFormation cannot delete.
    await emptyPrivateSubnets(backend);
    const plan = await hermetic.plan.network({ to: "public" });
    expect(plan.kind).toBe("network");
    expect(plan.options.network).toBe("public");
  });

  test("public → nat names every agent that will be left behind, and the DERP cost", async () => {
    const { hermetic } = publicFleet();
    const plan = await hermetic.plan.network({ to: "nat" });
    expect(plan.kind).toBe("network");
    expect(plan.target).toBe(FIXTURE_CONFIG.fleet_id);
    expect(plan.options.network).toBe("nat");
    expect(plan.steps.map((s) => s.id)).toEqual(["preflight", "archive", "stack", "stamp", "drift"]);
    // The stack update is the one destructive step: it replaces the routing.
    expect(plan.steps.filter((s) => s.destructive).map((s) => s.id)).toEqual(["stack"]);
    expect(plan.warnings.some((w) => w.includes("agent recreate"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes("atlas"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes("DERP"))).toBe(true);
    // §4.8: the plan names the fleet it was made for, so `apply` can refuse it
    // against another one.
    expect(plan.summary?.fleet_id).toBe(FIXTURE_CONFIG.fleet_id);
  });

  test("a stale `_fleet` cache is a warning on the plan, not a refusal", async () => {
    const { backend, hermetic } = publicFleet();
    backend.fleetItem = { ...backend.fleetItem!, network: "nat" };
    const plan = await hermetic.plan.network({ to: "nat" });
    expect(
      plan.warnings.some((w) => w.includes(FLEET_KEY) && w.includes("stack is authoritative")),
    ).toBe(true);
  });
});

describe("apply kind network", () => {
  async function applied(): Promise<{
    backend: MemoryBackend;
    hermetic: ReturnType<typeof testHermetic>;
    events: OpEvent[];
  }> {
    const { backend, hermetic } = publicFleet();
    const plan = await hermetic.plan.network({ to: "nat" });
    const events = await drain(hermetic.apply({ plan, yes: true }));
    return { backend, hermetic, events };
  }

  test("public → nat walks every phase, in order", async () => {
    const { events } = await applied();
    expect(phases(events)).toEqual(["preflight", "archive", "stack", "stamp", "drift", "done"]);
    expect(events.at(-1)?.progress).toBe(1);
  });

  test("the stack, the `_fleet` item and the manifest all end up saying nat", async () => {
    const { backend, hermetic } = await applied();
    expect(backend.stack?.parameters["Network"]).toBe("nat");
    expect(backend.stack?.outputs["SubnetIds"]).toBe("subnet-fixture-private0,subnet-fixture-private1");
    expect(backend.fleetItem?.network).toBe("nat");
    const manifest = await readFleetManifest(backend.artifacts);
    expect(manifest?.resources.network).toBe("nat");
    expect(manifest?.resources.subnet_ids).toEqual([
      "subnet-fixture-private0",
      "subnet-fixture-private1",
    ]);
    // The read agrees with all three afterwards, which is the whole point of it.
    const report = await hermetic.network.status();
    expect(report.mode).toBe("nat");
    expect(report.stack_mode).toBe("nat");
    expect(report.consistent).toBe(true);
    expect(report.egress_ip).toBe("203.0.113.200");
  });

  /**
   * The half a re-network deliberately does not finish. Every agent that had an
   * instance is now on the old subnets, said once per agent at `warn`, and
   * nothing was recreated.
   */
  test("every stranded agent is reported, and none is recreated", async () => {
    const { backend, events } = await applied();
    const drift = events.filter((e) => e.phase === "drift");
    expect(drift.length).toBeGreaterThan(0);
    expect(drift.every((e) => e.level === "warn")).toBe(true);
    expect(drift.some((e) => e.message.includes("hermetic agent recreate atlas"))).toBe(true);
    expect(backend.mutations.filter((m) => m === "compute.runInstance")).toEqual([]);
    // And `network.status` keeps saying it until somebody acts.
    expect((await backend.store.agents.scan()).every((a) => a.status !== "creating")).toBe(true);
  });

  test("the fleet lock is released and the move is recorded on the ledger", async () => {
    const { backend } = await applied();
    expect(backend.fleetItem?.lock).toBeNull();
    const events = await backend.store.events.query(FLEET_KEY, 50);
    const row = events.find((e) => e.action === "network.apply");
    expect(row).toBeDefined();
    expect(row?.detail).toContain("public → nat");
  });

  test("refuses when the fleet lock is already held", async () => {
    const { backend, hermetic } = publicFleet();
    const plan = await hermetic.plan.network({ to: "nat" });
    backend.fleetItem = {
      ...backend.fleetItem!,
      lock: {
        owner: "someone-else",
        expires: new Date(backend.now().getTime() + 60_000).toISOString(),
      },
    };
    expect(await codeOf(() => drain(hermetic.apply({ plan, yes: true })))).toBe("LOCKED");
    expect(backend.stack?.parameters["Network"]).toBe("public");
  });

  /**
   * The AMI is resolved in preflight, before the archive and before the lock is
   * used for anything — so a region with no published fck-nat image is a
   * refusal that leaves the fleet untouched rather than a failure half-way
   * through a re-network.
   */
  test("refuses when the fck-nat AMI cannot be resolved, having changed nothing", async () => {
    const { backend, hermetic } = publicFleet();
    const plan = await hermetic.plan.network({ to: "nat" });
    backend.fckNatAmiId = null;
    expect(await codeOf(() => drain(hermetic.apply({ plan, yes: true })))).toBe("NOT_FOUND");
    expect(backend.stack?.parameters["Network"]).toBe("public");
    expect(backend.fleetItem?.network).toBe("public");
    expect(backend.fleetItem?.lock ?? null).toBeNull();
    expect(backend.mutations.some((m) => m.startsWith("artifacts."))).toBe(false);
  });

  test("refuses a plan whose target the fleet has reached since it was made", async () => {
    const { backend, hermetic } = publicFleet();
    const plan = await hermetic.plan.network({ to: "nat" });
    await drain(hermetic.apply({ plan, yes: true }));
    // The same document, applied twice. The second one is a no-op that must be
    // refused rather than a second archive and a second change set.
    expect(await codeOf(() => drain(hermetic.apply({ plan, yes: true })))).toBe("CONFLICT");
    expect(backend.fleetItem?.network).toBe("nat");
  });

  test("refuses nat → public at apply time even when the plan was made when it was legal", async () => {
    const { backend, hermetic } = natFleet();
    await emptyPrivateSubnets(backend);
    const plan = await hermetic.plan.network({ to: "public" });
    // Somebody created an agent in between: an ENI is back in the private
    // subnets, and CloudFormation could not delete them now.
    const ember = await backend.store.agents.get("ember");
    backend.instances.set("i-raced", {
      instance_id: "i-raced",
      state: "running",
      public_ip: null,
      subnet_id: "subnet-fixture-private0",
      agent: "ember",
      fleet_id: backend.fleetItem?.fleet_id ?? null,
    });
    await backend.store.agents.update("ember", ember!.version, { instance_id: "i-raced" });
    expect(await codeOf(() => drain(hermetic.apply({ plan, yes: true })))).toBe("AGENTS_EXIST");
    expect(backend.stack?.parameters["Network"]).toBe("nat");
  });

  /**
   * The same guarantee `foundation.update` gives: an abort is a failure of the
   * op, and the lock goes back whatever happens — otherwise a closed browser
   * tab holds a fleet locked for the whole TTL (§4.4).
   */
  test("an abort stops the op, releases the lock and leaves the stack where it was", async () => {
    const { backend, hermetic } = publicFleet();
    const plan = await hermetic.plan.network({ to: "nat" });
    const controller = new AbortController();
    let code: string | null = null;
    try {
      for await (const e of hermetic.apply({ plan, yes: true }, { signal: controller.signal })) {
        if (e.phase === "preflight" && e.kind === "done") controller.abort();
      }
    } catch (e) {
      code = e instanceof HermeticError ? e.code : String(e);
    }
    expect(code).toBe("ABORTED");
    expect(backend.fleetItem?.lock ?? null).toBeNull();
    expect(backend.stack?.parameters["Network"]).toBe("public");
    expect(backend.fleetItem?.network).toBe("public");
  });

  test("a plan carrying no target mode is refused rather than guessed at", async () => {
    const { hermetic } = publicFleet();
    const plan: Plan = {
      kind: "network",
      target: FIXTURE_CONFIG.fleet_id,
      options: {},
      steps: [],
      warnings: [],
    };
    expect(await codeOf(() => drain(hermetic.apply({ plan, yes: true })))).toBe("VALIDATION");
  });
});

/**
 * The refusals and the commit point, each of which is a property about *when*
 * something is checked rather than about what it answers.
 */
describe("apply kind network, under a race", () => {
  /**
   * F2: the early `nat` → `public` check reads a `status()` taken before the
   * lock, so an `agents.create` that passed `assertFleetUnlocked` in that
   * window has an ENI in the private subnets by the time the change set runs.
   * The check has to be repeated with the lock held, which is the only reading
   * nothing can race.
   */
  test("an agent that lands while the lock is being taken is still refused", async () => {
    const { backend, hermetic } = natFleet();
    await emptyPrivateSubnets(backend);
    const plan = await hermetic.plan.network({ to: "public" });

    // Exactly the window: the box appears between the pre-lock `status()` and
    // the lock landing, which is what `lockFleet` returning true means.
    const real = backend.store.fleet.lockFleet.bind(backend.store.fleet);
    backend.store.fleet.lockFleet = async (owner, expires, now) => {
      const took = await real(owner, expires, now);
      if (took) {
        backend.instances.set("i-raced", {
          instance_id: "i-raced",
          state: "running",
          public_ip: null,
          subnet_id: "subnet-fixture-private0",
          agent: "newcomer",
          fleet_id: backend.fleetItem?.fleet_id ?? null,
        });
      }
      return took;
    };

    expect(await codeOf(() => drain(hermetic.apply({ plan, yes: true })))).toBe("AGENTS_EXIST");
    // Refused, not failed: the lock went back and nothing was archived or moved.
    expect(backend.fleetItem?.lock ?? null).toBeNull();
    expect(backend.stack?.parameters["Network"]).toBe("nat");
    expect(backend.mutations.some((m) => m === "foundation.executeChangeSet")).toBe(false);
  });

  /**
   * F5: the agents table is not the list CloudFormation runs into. An interface
   * left behind by a create that never wrote its instance id down blocks the
   * subnet delete exactly as hard as a healthy agent does, and the refusal has
   * to name something an operator can go and find.
   */
  test("an interface no agent row explains blocks the move, named by id", async () => {
    const { backend, hermetic } = natFleet();
    await emptyPrivateSubnets(backend);
    backend.strayEnis.push({
      id: "eni-0abandoned",
      subnet_id: "subnet-fixture-private0",
      instance_id: null,
      description: "orphaned by a failed create",
    });
    const code = await codeOf(() => hermetic.plan.network({ to: "public" }));
    expect(code).toBe("AGENTS_EXIST");
    await expect(hermetic.plan.network({ to: "public" })).rejects.toThrow(/eni-0abandoned/);
    await expect(hermetic.plan.network({ to: "public" })).rejects.toThrow(
      /untracked network interface/,
    );
  });

  /**
   * F3: `executeChangeSet` has already committed by the time the stamp is
   * reached — the stack is in the new mode and its `SubnetIds` are the other
   * pair. An abort honoured between the two would leave `_fleet.network`
   * claiming a mode the fleet is no longer in: exactly the drift this op exists
   * to remove, produced by cancelling it.
   */
  test("an abort after the stack phase still stamps the new mode", async () => {
    const { backend, hermetic } = publicFleet();
    const plan = await hermetic.plan.network({ to: "nat" });
    const controller = new AbortController();
    const seen: OpEvent[] = [];
    for await (const e of hermetic.apply({ plan, yes: true }, { signal: controller.signal })) {
      seen.push(e);
      if (e.phase === "stack" && e.kind === "done") controller.abort();
    }
    expect(backend.stack?.parameters["Network"]).toBe("nat");
    expect(backend.fleetItem?.network).toBe("nat");
    expect(phases(seen)).toContain("stamp");
    // And the lock still went back, which is what the `finally` is for.
    expect(backend.fleetItem?.lock ?? null).toBeNull();
  });

  /**
   * F8: `NetworkDeps.changeSetTimeoutMs` was declared and never handed in, so a
   * re-network could hang on a change set CloudFormation never finishes
   * computing while `foundation.update` could not.
   */
  test("a change set CloudFormation never finishes computing is bounded", async () => {
    const { backend, hermetic } = publicFleet({
      changeSetPollMs: 1,
      changeSetTimeoutMs: 20,
      heartbeatMs: 60_000,
    });
    const plan = await hermetic.plan.network({ to: "nat" });
    // Stuck mid-compute for ever, which is the state the timeout exists for.
    backend.changeSetStatus = "CREATE_IN_PROGRESS";
    /**
     * `NETWORK_UPDATE_FAILED`, not `FOUNDATION_UPDATE_FAILED` (F9): the shared
     * choreography reports each caller's failures under that caller's own code,
     * because a head told the foundation update failed would send the operator
     * to a template that was never the problem.
     */
    expect(await codeOf(() => drain(hermetic.apply({ plan, yes: true })))).toBe(
      "NETWORK_UPDATE_FAILED",
    );
    expect(backend.stack?.parameters["Network"]).toBe("public");
    expect(backend.fleetItem?.lock ?? null).toBeNull();
  });

  /**
   * The ordinary interleave: a `settings.set` fired while the network apply
   * holds the lock is refused, cheaply, before it has written anything, and
   * the apply goes on to stamp the new mode.
   */
  test("a settings write fired mid-apply is refused, and the apply still stamps", async () => {
    const { backend, hermetic } = publicFleet();
    const plan = await hermetic.plan.network({ to: "nat" });
    const before = backend.fleetItem!.settings!.version;

    // Collected rather than assigned to a `let`: the write happens inside a
    // callback, and a narrowed `string | null` read back outside it is `null`
    // as far as the compiler is concerned.
    const refused: (string | null)[] = [];
    const real = backend.store.fleet.lockFleet.bind(backend.store.fleet);
    backend.store.fleet.lockFleet = async (owner, expires, now) => {
      const took = await real(owner, expires, now);
      // The instant the door is shut, and only then.
      if (took && refused.length === 0) {
        refused.push(await codeOf(() => hermetic.settings.set({ defaults: { size: "large" } })));
      }
      return took;
    };

    await drain(hermetic.apply({ plan, yes: true }));
    expect(refused).toEqual(["LOCKED"]);
    expect(backend.fleetItem!.settings!.version).toBe(before);
    expect(backend.fleetItem?.network).toBe("nat");
    expect(backend.fleetItem?.lock ?? null).toBeNull();
  });

  /**
   * The same hazard `foundation.update`'s stamp has, and for the same reason:
   * this stamp replaces the whole `_fleet` item from a copy read at the lock
   * take, so a settings write that landed while the lock had lapsed would be
   * reverted by it — with the op reporting success.
   *
   * The stamp states the `settings.version` it was composed against, so a
   * record that moved refuses it. `CONFLICT` rather than `LOCKED`: nobody holds
   * the lock, the row simply is not the one this run read. The stack has
   * already moved by then and the mode is left drifted, which is the honest
   * answer and what `network.status` reports — reverting somebody's settings
   * to tidy it up would be the worse trade.
   */
  test("a settings write that lands while the lock has lapsed refuses the stamp rather than being reverted", async () => {
    const { backend, hermetic } = publicFleet();
    const plan = await hermetic.plan.network({ to: "nat" });

    let landed = false;
    const realReplace = backend.store.fleet.replaceFleet.bind(backend.store.fleet);
    backend.store.fleet.replaceFleet = async (item, owner, now, expectation) => {
      if (!landed) {
        landed = true;
        backend.fleetItem = { ...backend.fleetItem!, lock: null };
        const settings = backend.fleetItem.settings!;
        expect(
          await backend.store.fleet.putSettings(
            { ...settings, version: settings.version + 1, updated_by: "somebody-else" },
            settings.version,
            backend.clock.now(),
          ),
        ).toBe(true);
      }
      return realReplace(item, owner, now, expectation);
    };

    const before = backend.fleetItem!.settings!.version;
    expect(await codeOf(() => drain(hermetic.apply({ plan, yes: true })))).toBe("CONFLICT");
    expect(backend.fleetItem!.settings!.version).toBe(before + 1);
    expect(backend.fleetItem!.settings!.updated_by).toBe("somebody-else");
    // The stack moved and `_fleet` did not, which is drift `network.status`
    // reports rather than damage — and is strictly better than the revert.
    expect(backend.stack?.parameters["Network"]).toBe("nat");
    expect(backend.fleetItem?.network).toBe("public");
  });

  /**
   * F12: `network.status` is behind an HTTP GET and `doctor` calls it, so the
   * placement read is one round trip per agent and they must not be serial.
   * The count is what is checked; the order is not, because there is not one.
   */
  test("every agent with an instance is described exactly once", async () => {
    const { backend, hermetic } = publicFleet();
    const agents = (await backend.store.agents.scan()).filter(
      (a) => a.status !== "destroyed" && a.instance_id,
    );
    backend.mutations.length = 0;
    const reads: string[] = [];
    const real = backend.compute.describeInstance;
    backend.compute.describeInstance = async (id: string) => {
      reads.push(id);
      return real(id);
    };
    const report = await hermetic.network.status();
    expect(reads.length).toBe(agents.length);
    expect([...reads].sort()).toEqual(agents.map((a) => a.instance_id as string).sort());
    expect(report.agents.map((a) => a.name)).toEqual(
      (await backend.store.agents.scan()).filter((a) => a.status !== "destroyed").map((a) => a.name),
    );
  });
});

/**
 * F10: a stack can hold several change sets at once, and the fixture applied
 * whichever set of parameters was recorded last to whichever executed next.
 * That made a `plan network` beside a `foundation update` re-network the fleet
 * by accident, and made deleting a plan's throwaway change set disarm the one
 * an apply was about to run.
 */
describe("the fixture's change sets", () => {
  test("a network change set moves the stack only when it is the one executed", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    await backend.foundation.createNetworkChangeSet({
      name: "cs-network",
      hermeticVersion: "0.5.0",
      network: "nat",
      fckNatAmiId: "ami-0fcknat00000fixture",
    });
    await backend.foundation.createChangeSet({ name: "cs-plain", hermeticVersion: "0.5.0" });

    await backend.foundation.executeChangeSet({ name: "cs-plain" });
    expect(backend.stack?.parameters["Network"]).toBe("public");
    expect(backend.stack?.outputs["SubnetIds"]).toBe("subnet-fixture0,subnet-fixture1");

    await backend.foundation.executeChangeSet({ name: "cs-network" });
    expect(backend.stack?.parameters["Network"]).toBe("nat");
    expect(backend.stack?.outputs["SubnetIds"]).toBe("subnet-fixture-private0,subnet-fixture-private1");
  });

  test("deleting one change set leaves another's parameters armed", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    await backend.foundation.createNetworkChangeSet({
      name: "cs-apply",
      hermeticVersion: "0.5.0",
      network: "nat",
    });
    await backend.foundation.createNetworkChangeSet({
      name: "cs-plan",
      hermeticVersion: "0.5.0",
      network: "nat",
    });
    // The plan's throwaway, deleted the way `plan.foundation` deletes its own.
    await backend.foundation.deleteChangeSet("cs-plan");
    await backend.foundation.executeChangeSet({ name: "cs-apply" });
    expect(backend.stack?.parameters["Network"]).toBe("nat");
  });
});

/**
 * F11: `AssociatePublicIpAddress` is false for a `nat` fleet, so its boxes have
 * no public address at all. A fixture that handed one out anyway rendered
 * `staging` — the fixture's only `nat` fleet — as exactly the thing the mode
 * exists to prevent.
 */
describe("the fixture's public addresses", () => {
  test("a nat fleet's agents have none, a public fleet's do", async () => {
    const nat = natFleet().backend;
    const ember = await nat.store.agents.get("ember");
    expect(nat.instances.get(ember!.instance_id as string)?.public_ip).toBeNull();

    const pub = publicFleet().backend;
    const atlas = await pub.store.agents.get("atlas");
    expect(pub.instances.get(atlas!.instance_id as string)?.public_ip).toBeTruthy();
  });

  test("a launch into a nat fleet gets no address either", async () => {
    const nat = natFleet().backend;
    const launched = await nat.compute.runInstance({
      name: "newcomer",
      instance_type: "t4g.medium",
      ami_id: "ami-1",
      user_data: "#!/bin/sh",
      tags: { agent: "newcomer" },
      network: "nat",
    });
    expect(launched.public_ip).toBeNull();
  });
});

describe("doctor's network checks", () => {
  test("a public fleet skips the NAT checks rather than passing them", async () => {
    const { hermetic } = publicFleet();
    const report = await hermetic.doctor();
    expect(report.network.stack_mode).toBe("public");
    expect(report.network.checked_nat).toBe(false);
    expect(report.network.nat).toBeNull();
    expect(report.findings.filter((f) => f.includes("nat_"))).toEqual([]);
    expect(report.findings.filter((f) => f.includes("network_"))).toEqual([]);
  });

  test("a healthy nat fleet checks the NAT and finds nothing", async () => {
    const { hermetic } = natFleet();
    const report = await hermetic.doctor();
    expect(report.network.checked_nat).toBe(true);
    expect(report.network.nat?.instance_state).toBe("running");
    expect(report.findings.filter((f) => f.includes("nat_"))).toEqual([]);
  });

  test("a stopped NAT instance is a finding", async () => {
    const { backend, hermetic } = natFleet();
    backend.natHealth = { instance_state: "stopped", route_state: "active" };
    const report = await hermetic.doctor();
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.includes("nat_instance_down"))).toBe(true);
  });

  /**
   * The check that matters most: `PrivateDefaultRoute` is pinned to an instance
   * id, so a replaced NAT box leaves the route blackholed and the whole fleet
   * without egress, with no symptom but timeouts.
   */
  test("a blackholed default route is a finding", async () => {
    const { backend, hermetic } = natFleet();
    backend.natHealth = { instance_state: "running", route_state: "blackhole" };
    const report = await hermetic.doctor();
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.includes("nat_route_blackhole"))).toBe(true);
  });

  /**
   * `probeNat` never throws — a denied `DescribeInstances` comes back `null` —
   * so `null` has to mean "nobody looked", not "the box is down". Reporting the
   * fleet as having no internet because of an IAM policy would send an operator
   * to a NAT instance that is running perfectly well, and would leave `doctor`
   * permanently red over something no hermetic command can clear.
   */
  test("a NAT state that could not be read is a note, not a finding", async () => {
    const { backend, hermetic } = natFleet();
    const healthy = await hermetic.doctor();
    backend.natHealth = { instance_state: null, route_state: "active" };
    const report = await hermetic.doctor();
    // Not one finding more than the same fleet with a readable NAT: the probe
    // failing changes what is *known*, not what is wrong.
    expect(report.findings).toEqual(healthy.findings);
    expect(report.ok).toBe(healthy.ok);
    expect(report.findings.some((f) => f.includes("nat_instance_down"))).toBe(false);
    expect(report.network.notes.join("\n")).toContain("could not be read");
  });

  test("a default route that could not be read is a note, not a blackhole", async () => {
    const { backend, hermetic } = natFleet();
    const healthy = await hermetic.doctor();
    backend.natHealth = { instance_state: "running", route_state: null };
    const report = await hermetic.doctor();
    expect(report.findings).toEqual(healthy.findings);
    expect(report.findings.some((f) => f.includes("nat_route_blackhole"))).toBe(false);
    expect(report.network.notes.join("\n")).toContain("default route could not be read");
  });

  test("a `_fleet` that disagrees with the stack is a finding naming both", async () => {
    const { backend, hermetic } = publicFleet();
    backend.fleetItem = { ...backend.fleetItem!, network: "nat" };
    const report = await hermetic.doctor();
    expect(report.network.consistent).toBe(false);
    expect(report.findings.some((f) => f.includes("network_mode_drift"))).toBe(true);
  });

  test("an un-back-filled `_fleet` says so rather than reading as public", async () => {
    const { backend, hermetic } = publicFleet();
    const { network: _drop, ...rest } = backend.fleetItem!;
    backend.fleetItem = rest;
    const report = await hermetic.doctor();
    expect(report.findings.some((f) => f.includes("network_mode_unrecorded"))).toBe(true);
  });

  test("an agent left on the old subnets is a finding naming it", async () => {
    const { backend, hermetic } = publicFleet();
    const atlas = await backend.store.agents.get("atlas");
    const instance = backend.instances.get(atlas!.instance_id as string)!;
    backend.instances.set(instance.instance_id, { ...instance, subnet_id: "subnet-somewhere-else" });
    const report = await hermetic.doctor();
    expect(report.network.drifted).toEqual(["atlas"]);
    expect(report.findings.some((f) => f.includes("network_agent_drift"))).toBe(true);
  });
});
