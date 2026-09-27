import { describe, expect, test } from "bun:test";
import type { ConfigStore } from "../src/hermetic.ts";
import { HermeticError } from "../src/errors.ts";
import {
  FIXTURE_CONFIG,
  FIXTURE_NAT_EGRESS_IP,
  FIXTURE_PROFILE_IDS,
  FIXTURE_TS_KEY,
  fixtureConfigFor,
  MemoryBackend,
  seedFixtureFleet,
  seedFixtureFoundation,
  createFixtureAccount,
} from "../src/backend/memory.ts";
import type { FixtureAccount } from "../src/backend/fixture/fixture-directory.ts";
import type { Backend } from "../src/backend/types.ts";
import type { Agent } from "../src/schema/index.ts";
import {
  FLEET_ID_TAG,
  ROLE_DATA,
  ROLE_TAG,
  VERSION_TAG,
  agentParamPrefix,
  hermeticParamPrefix,
} from "../src/backend/constants.ts";

/**
 * The two prefixes `--purge` sweeps. Fleet-scoped since v3: the account roots
 * hold other fleets' parameters, and a teardown never touches those (§8.2).
 */
const HERMETIC_PARAM_PREFIX = hermeticParamPrefix(FIXTURE_CONFIG.fleet_id);
const AGENT_PARAM_PREFIX = agentParamPrefix(FIXTURE_CONFIG.fleet_id);
import {
  FLEET_KEY,
  type PlanTeardownInput,
  type TeardownInput,
  type TeardownReceipt,
} from "../src/schema/index.ts";
import { TeardownReceipt as TeardownReceiptSchema, groupByDisposition } from "../src/schema/index.ts";
import type { TeardownStore } from "../src/hermetic.ts";
import {
  clearConfig,
  SqliteTeardownStore,
  openMemoryDb,
  readConfig,
  recordRun,
  writeConfig,
  archiveRuns,
} from "../src/local/db/index.ts";
import { POLICY_RETAINED_NOTICE } from "../src/fleet/policy.ts";
import { LOCK_TTL_MS } from "../src/fleet/fleet-lock.ts";
import { drain, testHermetic } from "./helpers.ts";

/**
 * §9, `hermetic teardown --yes`: the command that unmakes a fleet. Everything
 * here is about what it takes with it and what it deliberately leaves — the
 * flags are the difference between "the stack is gone" and "the account is
 * empty", and an operator has to be able to see which one they asked for.
 */

/** The four SSM parameters teardown --purge must find: two under each prefix. */
const SEEDED_PARAMS = [
  `${HERMETIC_PARAM_PREFIX}tailscale/oauth-secret`,
  `${HERMETIC_PARAM_PREFIX}tailscale/oauth-client-id`,
  // The fleet's shared secret slots (§8.3). They live under `/hermetic/` like
  // the OAuth client, so `--purge` takes them by the same sweep — a fleet being
  // torn down must not leave a provider key behind in an account nobody is
  // watching any more.
  `${HERMETIC_PARAM_PREFIX}secrets/nous-key`,
  `${HERMETIC_PARAM_PREFIX}secrets/openrouter-key`,
  // The four slots the fixture's keyed provider profiles own (§8.3). Same
  // prefix, same sweep: a profile's credential is a fleet secret like any other.
  `${HERMETIC_PARAM_PREFIX}secrets/profile-${FIXTURE_PROFILE_IDS.anthropic}`,
  `${HERMETIC_PARAM_PREFIX}secrets/profile-${FIXTURE_PROFILE_IDS.openrouter}`,
  `${HERMETIC_PARAM_PREFIX}secrets/profile-${FIXTURE_PROFILE_IDS.nous}`,
  `${HERMETIC_PARAM_PREFIX}secrets/profile-${FIXTURE_PROFILE_IDS.vercel}`,
  `${AGENT_PARAM_PREFIX}gone-one/ts-key`,
  `${AGENT_PARAM_PREFIX}gone-two/bws-token`,
];

/**
 * A foundation whose agents are all long destroyed, but whose *resources* are
 * not: `destroy` keeps a data volume by default (§6.6) and the DLM policy has
 * been snapshotting them daily (§7.1), so this is what a real account looks like
 * on teardown day.
 */
function leftovers(account: ConstructorParameters<typeof MemoryBackend>[0] = {}) {
  const backend = seedFixtureFoundation(new MemoryBackend(account));

  // Every volume here is this fleet's; one carrying no `hermetic:fleet_id` tag
  // is invisible to every filter, exactly as it is to EC2 (`inFleet`).
  backend.volumes.set("vol-gone-one", {
    volume_id: "vol-gone-one",
    size_gib: 100,
    state: "available",
    agent: "gone-one",
    role: "data",
    fleet_id: FIXTURE_CONFIG.fleet_id,
  });
  backend.volumes.set("vol-gone-two", {
    volume_id: "vol-gone-two",
    size_gib: 200,
    state: "available",
    agent: "gone-two",
    role: "data",
    fleet_id: FIXTURE_CONFIG.fleet_id,
  });
  /**
   * F7: a volume carrying `hermetic:managed=true` and no `hermetic:role` tag —
   * one made by a build from before that tag existed. `Ec2Compute` selects on
   * the managed tag alone and reports it, so the fixture backend must too, and
   * `--delete-volumes` has to take it with the rest.
   */
  backend.volumes.set("vol-no-role", {
    volume_id: "vol-no-role",
    size_gib: 50,
    state: "available",
    agent: "gone-three",
    role: null,
    fleet_id: FIXTURE_CONFIG.fleet_id,
  });

  const tags = { [ROLE_TAG]: ROLE_DATA };
  backend.snapshots.set("snap-1", {
    snapshot_id: "snap-1",
    volume_id: "vol-gone-one",
    size_gib: 100,
    started_at: "2026-08-30T05:00:00.000Z",
    tags,
  });
  backend.snapshots.set("snap-2", {
    snapshot_id: "snap-2",
    volume_id: "vol-gone-one",
    size_gib: 100,
    started_at: "2026-08-31T05:00:00.000Z",
    tags,
  });
  backend.snapshots.set("snap-3", {
    snapshot_id: "snap-3",
    volume_id: "vol-gone-two",
    size_gib: 200,
    started_at: "2026-08-31T05:00:00.000Z",
    tags,
  });
  // Not hermetic's: nothing teardown does may touch it.
  backend.snapshots.set("snap-foreign", {
    snapshot_id: "snap-foreign",
    volume_id: "vol-someone-else",
    size_gib: 8,
    started_at: "2026-08-31T05:00:00.000Z",
    tags: {},
  });

  for (const path of SEEDED_PARAMS) backend.params.set(path, `${FIXTURE_TS_KEY}-leftover`);
  backend.resetMutations();
  return backend;
}

/** A `ConfigStore` that only counts, for asserting the local phase ran or did not. */
function countingConfigStore() {
  const calls = { archived: 0, cleared: 0 };
  const store: ConfigStore = {
    write: async () => {},
    archiveRuns: async () => {
      calls.archived += 1;
    },
    clear: async () => {
      calls.cleared += 1;
    },
  };
  return { calls, store };
}

function open(backend: MemoryBackend, configStore?: ConfigStore) {
  return testHermetic({
    backend,
    config: FIXTURE_CONFIG,
    ...(configStore ? { configStore } : {}),
  });
}

/**
 * §4.6: the permanent record. Written whether the teardown succeeded or failed,
 * and to a table `--reset-local` deliberately does not clear.
 */
function recordingTeardowns() {
  const receipts: TeardownReceipt[] = [];
  const store: TeardownStore = {
    record: async (receipt) => {
      receipts.push(TeardownReceiptSchema.parse(receipt));
    },
    list: async (input) => receipts.slice(0, input.last ? 1 : (input.limit ?? 20)),
  };
  return { receipts, store };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof HermeticError ? e.code : `not-a-HermeticError:${String(e)}`;
  }
}

const events0 = (events: Array<{ message: string }>) => events[0]!.message;

const phases = (events: Array<{ phase: string }>) =>
  events.map((e) => e.phase).filter((p) => p !== "done");

describe("teardown confirmation", () => {
  test("refuses without yes and mutates nothing", async () => {
    const backend = leftovers();
    expect(await codeOf(() => drain(open(backend).teardown({ yes: false })))).toBe(
      "CONFIRMATION_REQUIRED",
    );
    expect(backend.mutations).toEqual([]);
    expect(backend.stack).not.toBeNull();
  });

  test("refuses while any non-destroyed agent exists, and names them", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    let error: HermeticError | null = null;
    try {
      await drain(open(backend).teardown({ yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("AGENTS_EXIST");
    expect(error!.details!["agents"]).toContain("atlas");
    expect((error!.details!["agents"] as string[]).length).toBe(11);
    // Nothing was emptied, deleted or recorded on the way to refusing. The
    // fleet lock is the one write: taken before the check (§4.4) and given
    // straight back when the check says no.
    expect(backend.mutations).toEqual(["store.fleet.lockFleet", "store.fleet.unlockFleet"]);
    expect(backend.stack).not.toBeNull();
  });

  test("the plan names the surviving agents rather than throwing", async () => {
    const plan = await open(seedFixtureFleet(new MemoryBackend())).plan.teardown();
    expect(plan.warnings.some((w) => w.includes("teardown will refuse"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes("atlas"))).toBe(true);
  });

  /**
   * §6.6's other in-flight operation. `guardFleet` proves this is the right
   * account and the right fleet; it says nothing about whether somebody is
   * rewriting that fleet right now. Emptying the bucket and calling
   * `DeleteStack` underneath a running `foundation.update` would delete the
   * release it had just pushed and the stack it was mid-change-set on.
   */
  test("refuses while a foundation update holds the fleet lock, and touches nothing", async () => {
    const backend = leftovers();
    // Through `lockFleet`, the only door onto the lock: `put` creates `_fleet`
    // and refuses a row that is already there (§4.4).
    await backend.store.fleet.lockFleet(
      "arn:aws:iam::123456789012:user/other#op-1",
      new Date(backend.now().getTime() + 60_000).toISOString(),
      backend.now(),
    );
    backend.resetMutations();

    expect(await codeOf(() => drain(open(backend).teardown({ yes: true })))).toBe("LOCKED");
    expect(backend.mutations).toEqual([]);
    expect(backend.stack).not.toBeNull();
  });

  /**
   * H4, the other direction: the fleet lock teardown takes is held for the
   * whole run, not read once at the door.
   *
   * The agent check is a `Scan` taken at one instant. Without the lock, an
   * `agents.create` on another laptop passed its own `assertFleetUnlocked`,
   * claimed a name and pushed a config prefix into the bucket in the window
   * between that scan and `emptyBucket` — and the sweep then took the new
   * agent's configuration with it, while the teardown carried on believing the
   * fleet was empty. Holding the lock across the destructive phases is what
   * turns the check into a guarantee: every fleet-scoped mutation that starts
   * after it is refused at the door (`assertFleetUnlocked`).
   */
  test("create during teardown's final checks is refused", async () => {
    const backend = leftovers();
    const hermetic = open(backend);
    const teardown = hermetic.teardown({ yes: true })[Symbol.asyncIterator]();

    // Pump the teardown to the start of its first destructive phase. The agent
    // check has passed by here, and the bucket is about to be emptied.
    let step = await teardown.next();
    while (!step.done && step.value.phase !== "bucket") step = await teardown.next();
    expect(step.done).toBe(false);

    // The other laptop, arriving one moment too late.
    const error = await codeOf(() => drain(hermetic.agents.create({ name: "corvid" })));
    expect(error).toBe("LOCKED");
    // Nothing of the refused create reached the fleet: no row, no name taken.
    expect(await backend.store.agents.get("corvid")).toBeNull();

    // And the teardown it could not interrupt finishes.
    while (!(await teardown.next()).done) {
      // drain
    }
    expect(backend.stack).toBeNull();
  });

  /**
   * The same race from the create's side. A create that passed its own
   * `assertFleetUnlocked` before teardown took the lock can still write its row
   * after teardown's scan has run — the scan would miss it, and teardown would
   * empty the bucket believing the fleet empty. The recheck under the fresh
   * claim is what makes the two mutually exclusive: either teardown's scan sees
   * the row, or the create sees the lock. Here the create loses, and the name it
   * claimed is given back rather than left behind as a half-made agent.
   */
  test("a create that claimed its row after teardown locked the fleet gives the row back", async () => {
    const backend = leftovers();
    const hermetic = open(backend);

    const claim = backend.store.agents.putIfAbsent;
    backend.store.agents.putIfAbsent = async (agent: Agent) => {
      // Teardown arrives in the gap: it takes the fleet lock after this create
      // read the gate, so the claim below lands behind a scan already taken.
      await backend.store.fleet.lockFleet(
        "arn:aws:iam::123456789012:user/other#op-teardown",
        new Date(backend.now().getTime() + 60_000).toISOString(),
        backend.now(),
      );
      return claim(agent);
    };

    expect(await codeOf(() => drain(hermetic.agents.create({ name: "corvid" })))).toBe("LOCKED");
    expect(await backend.store.agents.get("corvid")).toBeNull();
  });

  /**
   * The lock is a lease, not a flag: a teardown that ends — however it ends —
   * gives it back, so nothing is left waiting out the ten-minute TTL. The
   * refusal above proves the release on the failure path; this is the success
   * path, where there is nothing left to release. `_fleet` is a row in the
   * `agents` table and the table is in the stack (§4.2), so a teardown that
   * reaches `DeleteStack` takes the lock's own row with it — which is why the
   * release is best effort rather than an outcome the run depends on.
   */
  test("the fleet lock does not outlive the teardown that took it", async () => {
    const backend = leftovers();
    await drain(open(backend).teardown({ yes: true }));
    expect(await backend.store.fleet.get()).toBeNull();
  });

  test("an expired fleet lock is not a lock, here as everywhere", async () => {
    const backend = leftovers();
    await backend.store.fleet.lockFleet(
      "a-dead-run",
      new Date(backend.now().getTime() - 1).toISOString(),
      backend.now(),
    );

    await drain(open(backend).teardown({ yes: true }));
    expect(backend.stack).toBeNull();
  });
});

describe("teardown defaults", () => {
  test("purges SSM, keeps the snapshots and the volumes", async () => {
    const backend = leftovers();
    const events = await drain(open(backend).teardown({ yes: true }));

    expect(phases(events)).toEqual([
      "agents_check",
      "bucket",
      "stack",
      "directory",
      "tailscale",
      "ssm",
      "local",
    ]);
    expect(backend.params.size).toBe(0);
    expect(backend.stack).toBeNull();
    expect(backend.objects.size).toBe(0);
    // Volumes are precious (§1): nothing removes them unless asked.
    expect([...backend.volumes.keys()].sort()).toEqual(["vol-gone-one", "vol-gone-two", "vol-no-role"]);
    expect(backend.snapshots.size).toBe(4);
    expect(backend.mutations).not.toContain("compute.deleteVolume");
    expect(backend.mutations).not.toContain("compute.deleteSnapshot");

    const ssm = events.find((e) => e.phase === "ssm")!;
    expect(ssm.message).toContain(`${SEEDED_PARAMS.length} SSM parameter(s)`);
  });

  test("the phases run in the plan's order, and the plan's steps are exactly them", async () => {
    const backend = leftovers();
    const hermetic = open(backend);
    const plan = await hermetic.plan.teardown();
    const events = await drain(hermetic.teardown({ yes: true }));
    expect(phases(events)).toEqual(plan.steps.map((s) => s.id));
  });

  test("the destructive phases are marked destructive and the check is not", async () => {
    const plan = await open(leftovers()).plan.teardown({
      delete_snapshots: true,
      delete_volumes: true,
    });
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    expect([...byId.keys()]).toEqual([
      "agents_check",
      "bucket",
      "stack",
      "directory",
      "tailscale",
      "ssm",
      "snapshots",
      "volumes",
      "local",
    ]);
    expect(byId.get("agents_check")!.destructive).toBe(false);
    // Taking hermetic's own blocks back out of the operator's policy file is
    // not in the destructive column: it removes what `init` put there and
    // returns every other byte unchanged (§4.7).
    expect(byId.get("tailscale")!.destructive).toBe(false);
    // Nor is the directory entry: it is *kept* and marked torn_down (§4.8).
    expect(byId.get("directory")!.destructive).toBe(false);
    for (const id of ["bucket", "stack", "ssm", "snapshots", "volumes", "local"]) {
      expect(byId.get(id)!.destructive, id).toBe(true);
    }
  });

  test("the plan counts what it found and summarises the target", async () => {
    const plan = await open(leftovers()).plan.teardown({
      delete_snapshots: true,
      delete_volumes: true,
    });
    const byId = new Map(plan.steps.map((s) => [s.id, s.description]));
    expect(byId.get("ssm")).toContain(`${SEEDED_PARAMS.length} SSM parameter(s)`);
    expect(byId.get("snapshots")).toContain("3 DLM snapshot(s)");
    expect(byId.get("snapshots")).toContain("400 GiB");
    expect(byId.get("volumes")).toContain("350 GiB");
    expect(byId.get("volumes")).toContain("vol-gone-one");
    expect(byId.get("volumes")).toContain("vol-gone-two");
    // The role-less one is hermetic's too, and the plan has to say so.
    expect(byId.get("volumes")).toContain("vol-no-role");
    // Named for the stack, which is named for the fleet (§5).
    expect(byId.get("stack")).toContain("hermetic-fxtr0001");
    expect(byId.get("stack")).toContain("hermetic-fxtr0001-agents");

    expect(plan.options).toEqual({
      purge: true,
      delete_snapshots: true,
      delete_volumes: true,
      reset_local: true,
    });
    expect(plan.summary).toEqual({
      account_id: FIXTURE_CONFIG.account_id,
      region: FIXTURE_CONFIG.region,
      fleet_id: FIXTURE_CONFIG.fleet_id,
      stack_id: expect.stringContaining("stack/hermetic-fxtr0001/"),
    });
  });

  /**
   * §4.7: hermetic has no credential that reaches the tailnet's own settings.
   * The OAuth client and the devices stay on the by-hand list; the policy file
   * is not on it at all, because it is not something teardown half-did — it is
   * deliberately left exactly as it was (§5.2), and that is its own notice.
   */
  test("the plan and the final event both name what stays behind by hand", async () => {
    const hermetic = open(leftovers());
    const plan = await hermetic.plan.teardown();
    const warnings = plan.warnings.join(" | ");
    expect(warnings).toContain("Tailscale OAuth client");
    expect(warnings).toContain("devices still on the tailnet");
    expect(plan.steps.map((s) => s.id)).toContain("tailscale");

    const events = await drain(hermetic.teardown({ yes: true }));
    const done = events.at(-1)!;
    expect(done.phase).toBe("done");
    expect(done.message).toContain("Tailscale OAuth client");
    expect(done.message).toContain("devices still on the tailnet");
    expect(done.message).not.toContain("tailnet policy");
  });

  /**
   * §5.2, the one-directional rule. hermetic's managed entries go in on `init`
   * and never come back out on the way down: the tailnet outlives any one
   * foundation, and the fleet coming down has no way to know it is the last one
   * that those rules serve. So the whole policy file — hermetic's blocks and
   * the operator's own bytes alike — is identical before and after.
   */
  test("the tailnet policy is byte-identical before and after a teardown", async () => {
    const backend = leftovers();
    const hermetic = open(backend);
    // Put hermetic's blocks in the way `init` would, so there is something a
    // removal could take. This is the state a real teardown day starts from.
    const planned = await hermetic.plan.policy();
    await drain(hermetic.apply({ plan: planned, yes: true }));
    const before = backend.policyText;
    backend.resetMutations();

    await drain(hermetic.teardown({ yes: true, purge: true }));

    expect(backend.policyText).toBe(before);
    // Not "wrote the same bytes back" — never wrote at all.
    expect(backend.mutations).not.toContain("tailscale.setPolicy");
  });

  /**
   * The notice is the deliverable, so it has to be in all three of the places
   * §5.2 names, in the same words: the plan an operator confirms, the stream
   * they watch, and the receipt they still have months later.
   */
  test("the retained-policy notice appears in the plan, the stream and the receipt", async () => {
    const backend = leftovers();
    const teardowns = recordingTeardowns();
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      teardowns: teardowns.store,
    });

    const plan = await hermetic.plan.teardown();
    const step = plan.steps.find((s) => s.id === "tailscale")!;
    expect(step.description).toBe(POLICY_RETAINED_NOTICE);
    expect(step.destructive).toBe(false);
    expect(plan.warnings).toContain(POLICY_RETAINED_NOTICE);

    const events = await drain(hermetic.teardown({ yes: true }));
    const tailscale = events.filter((e) => e.phase === "tailscale");
    expect(tailscale.map((e) => e.message)).toEqual([POLICY_RETAINED_NOTICE]);
    // Informational, not a warning: nothing failed and nothing is owed.
    expect(tailscale[0]!.level).toBeUndefined();

    const outcome = teardowns.receipts[0]!.resources.find(
      (r) => r.phase === "tailscale" && r.disposition === "retained",
    )!;
    expect(outcome.what).toBe("the hermetic entries in the tailnet policy");
    expect(outcome.detail).toBe(POLICY_RETAINED_NOTICE);
    // And nothing about the policy is reported as a manual chore any more.
    expect(
      teardowns.receipts[0]!.resources.filter(
        (r) => r.disposition === "manual" && r.what.includes("policy"),
      ),
    ).toEqual([]);
  });

  /**
   * The two shapes that used to produce a different answer, and now produce the
   * same one: a client with no `policy_file` scope, and a tailnet API that is
   * not answering at all. Neither is consulted, so neither can change the
   * words — which is what makes the notice something a head can rely on.
   */
  test("no policy scope and an unreachable policy API give the identical notice", async () => {
    const noScope = leftovers();
    noScope.policyScope = "none";
    const scopeEvents = await drain(open(noScope).teardown({ yes: true }));

    const unreachable = leftovers();
    unreachable.tailscale.getPolicy = async () => {
      throw new Error("api.tailscale.com is unreachable");
    };
    unreachable.tailscale.setPolicy = async () => {
      throw new Error("api.tailscale.com is unreachable");
    };
    const downEvents = await drain(open(unreachable).teardown({ yes: true }));

    for (const events of [scopeEvents, downEvents]) {
      const tailscale = events.find((e) => e.phase === "tailscale")!;
      expect(tailscale.message).toBe(POLICY_RETAINED_NOTICE);
      expect(tailscale.level).toBeUndefined();
      // Not a manual chore and not a failure: the phase asked nothing of the
      // API, so an API that cannot answer changes nothing.
      expect(events.at(-1)!.phase).toBe("done");
      expect(events.at(-1)!.message).not.toContain("tailnet policy");
    }
  });

  /**
   * The reason the rule exists, exercised: an account with a second live fleet
   * is exactly the case where removing the entries would cut the other fleet
   * off. The notice does not change — a teardown never claims to know whether
   * it is the last one — and neither does the policy.
   */
  test("a second fleet sharing the tailnet changes neither the policy nor the notice", async () => {
    const backend = leftovers({ directory: "seeded" });
    expect(backend.account.entries.size).toBeGreaterThan(1);
    const hermetic = open(backend);
    const planned = await hermetic.plan.policy();
    await drain(hermetic.apply({ plan: planned, yes: true }));
    const before = backend.policyText;
    backend.resetMutations();

    const events = await drain(hermetic.teardown({ yes: true, purge: true }));

    expect(backend.policyText).toBe(before);
    expect(backend.mutations).not.toContain("tailscale.setPolicy");
    expect(events.find((e) => e.phase === "tailscale")!.message).toBe(POLICY_RETAINED_NOTICE);
  });

  test("a flag left off is listed as kept, in the plan and in the done event", async () => {
    const hermetic = open(leftovers());
    const plan = await hermetic.plan.teardown({ purge: false, reset_local: false });
    const warnings = plan.warnings.join(" | ");
    expect(warnings).toContain(HERMETIC_PARAM_PREFIX);
    expect(warnings).toContain("still points at the deleted fleet");
    expect(plan.steps.map((s) => s.id)).toEqual([
      "agents_check",
      "bucket",
      "stack",
      "directory",
      "tailscale",
    ]);

    const events = await drain(hermetic.teardown({ yes: true, purge: false, reset_local: false }));
    expect(phases(events)).toEqual(["agents_check", "bucket", "stack", "directory", "tailscale"]);
    expect(events.at(-1)!.message).toContain("SSM parameters under");
  });
});

describe("teardown --purge", () => {
  /** An account whose directory proves this fleet is the last live one. */
  function soleLiveFleet(): FixtureAccount {
    const account = createFixtureAccount("seeded");
    const entries = account.entries;
    // §4.6: the directory is keyed by `fleet_id`, not by the display alias.
    const stagingId = fixtureConfigFor("staging").fleet_id;
    const staging = entries.get(stagingId)!;
    entries.set(stagingId, { ...staging, status: "torn_down", torn_down_at: staging.updated_at });
    return account;
  }

  /**
   * §4.3: what `destroy` leaves behind — the row, for ever. Its *name* is the
   * only record that `/hermes/<name>/` was ever this fleet's, which is what the
   * purge enumerates from. Cloned off a seeded agent so it is a complete row
   * rather than a hand-built approximation of one.
   */
  function destroyedRow(name: string): Agent {
    const template = seedFixtureFleet(new MemoryBackend()).agents.get("atlas")!;
    return {
      ...template,
      name,
      status: "destroyed",
      instance_id: null,
      resources: { ssm_paths: [] },
    };
  }

  test("off, every parameter under both prefixes survives", async () => {
    const backend = leftovers();
    await drain(open(backend).teardown({ yes: true, purge: false }));
    expect([...backend.params.keys()].sort()).toEqual([...SEEDED_PARAMS].sort());
    expect(backend.mutations).not.toContain("secrets.deleteByPrefix");
  });

  test("on, both prefixes go and the fleet event carries the count", async () => {
    const backend = leftovers();
    await drain(open(backend).teardown({ yes: true, purge: true }));
    expect(backend.params.size).toBe(0);
    const details = backend.events.filter((e) => e.name === FLEET_KEY).map((e) => e.detail);
    expect(details).toContain(`ssm: deleted ${SEEDED_PARAMS.length} parameter(s)`);
  });

  /**
   * §6.6: the v3 migration *copies* parameters under the fleet id and keeps the
   * originals, so a fleet that has been through it has two sets. Tearing the
   * account's last fleet down has to take both, or `--purge` leaves the very
   * keys it exists to remove sitting on the account roots for ever.
   */
  test("on, this fleet's pre-v3 paths go too when it is the account's only fleet", async () => {
    const backend = leftovers({ account: soleLiveFleet() });
    /**
     * §4.3: a destroyed row is kept for ever, and its name is the only thing
     * that can say `/hermes/gone-one/` was ever this fleet's — the enumeration
     * is what makes the sweep precise instead of a recursive `deleteByPrefix`
     * on `/hermes/`, which would take every migrated fleet's parameters too.
     */
    await backend.store.agents.putIfAbsent(destroyedRow("gone-one"));
    backend.params.set("/hermes/gone-one/ts-key", FIXTURE_TS_KEY);
    backend.params.set("/hermetic/tailscale/oauth-secret", FIXTURE_TS_KEY);
    backend.params.set("/hermetic/secrets/legacy-key", FIXTURE_TS_KEY);

    const events = await drain(open(backend).teardown({ yes: true, purge: true }));
    expect(backend.params.size).toBe(0);
    const ssm = events.find((e) => e.phase === "ssm")!;
    expect(ssm.message).toContain("/hermes/gone-one/");
    expect(ssm.message).toContain("/hermetic/secrets/");
  });

  /**
   * §9: a plan is a promise, and this is the one step whose blast radius can
   * reach outside the fleet — so the set `plan.teardown` names and the set
   * `teardown` deletes are asserted to be the same string, built by the same
   * code (`legacy-params.ts`) from the same list of rows.
   */
  test("the plan's purge scope is exactly the scope the teardown executes", async () => {
    const backend = leftovers({ account: soleLiveFleet() });
    // A destroyed row: in scope, and filtered out of the plan's *refusal* list,
    // which is what made the two disagree before.
    await backend.store.agents.putIfAbsent(destroyedRow("gone-one"));
    backend.params.set("/hermes/gone-one/ts-key", FIXTURE_TS_KEY);

    const hermetic = open(backend);
    const plan = await hermetic.plan.teardown({ purge: true });
    const planned = plan.steps.find((s) => s.id === "ssm")!.description;

    const events = await drain(hermetic.teardown({ yes: true, purge: true }));
    const executed = events.find((e) => e.phase === "ssm")!.message;

    // Both spell the same prefix list; only the verb and the count differ.
    const scopeOf = (text: string): string => text.slice(text.indexOf("under "));
    expect(scopeOf(executed)).toBe(scopeOf(planned));
    expect(planned).toContain("/hermes/gone-one/");
  });

  /**
   * The precision that makes the sweep safe: another fleet that has already
   * taken v3 keeps its parameters *under the same root*, and a recursive
   * `deleteByPrefix("/hermes/")` would take them.
   */
  test("on, another fleet's scoped parameters are never in scope", async () => {
    const backend = leftovers({ account: soleLiveFleet() });
    await backend.store.agents.putIfAbsent(destroyedRow("gone-one"));
    backend.params.set("/hermes/gone-one/ts-key", FIXTURE_TS_KEY);
    backend.params.set("/hermes/sg7k2m4p/ember/ts-key", FIXTURE_TS_KEY);
    backend.params.set("/hermetic/sg7k2m4p/tailscale/oauth-secret", FIXTURE_TS_KEY);

    await drain(open(backend).teardown({ yes: true, purge: true }));
    expect([...backend.params.keys()].sort()).toEqual([
      "/hermes/sg7k2m4p/ember/ts-key",
      "/hermetic/sg7k2m4p/tailscale/oauth-secret",
    ]);
  });

  /**
   * An agent of this fleet whose *name* is another fleet's id: `/hermes/<that>/`
   * is then ambiguous with that fleet's scoped root, so it is left alone rather
   * than guessed about.
   */
  test("on, an agent named like another fleet's id is left alone", async () => {
    const backend = leftovers({ account: soleLiveFleet() });
    await backend.store.agents.putIfAbsent(destroyedRow("sg7k2m4p"));
    backend.params.set("/hermes/sg7k2m4p/ts-key", FIXTURE_TS_KEY);

    // The plan warns about the omission first — before the teardown marks this
    // fleet `torn_down` and the account stops having a live one at all.
    const plan = await open(backend).plan.teardown({ purge: true });
    expect(plan.warnings.join("\n")).toContain("is also a fleet id in this account's directory");

    const events = await drain(open(backend).teardown({ yes: true, purge: true }));
    expect([...backend.params.keys()]).toContain("/hermes/sg7k2m4p/ts-key");
    // Said out loud rather than silently narrowed: an operator who expected
    // that agent's slots to go needs to know why they did not.
    expect(events.find((e) => e.phase === "ssm")!.message).toContain(
      "is also a fleet id in this account's directory",
    );
  });

  /**
   * The directory is an index, not the truth. A fleet created before it existed
   * has a stack and no entry — and it is exactly that fleet whose parameters
   * are sitting on the pre-v3 roots — so CloudFormation is asked too, and a
   * second live stack is a second fleet whatever the directory says.
   */
  test("on, a second hermetic stack means no legacy sweep even when the directory says one", async () => {
    const backend = leftovers({ account: soleLiveFleet() });
    await backend.store.agents.putIfAbsent(destroyedRow("gone-one"));
    backend.params.set("/hermes/gone-one/ts-key", FIXTURE_TS_KEY);
    const real = backend.foundation.listStacks;
    backend.foundation.listStacks = async () => [
      ...(await real()),
      {
        stack_name: "hermetic-sg7k2m4p",
        stack_id: "arn:aws:cloudformation:us-west-2:123456789012:stack/hermetic-sg7k2m4p/x",
        fleet_id: "sg7k2m4p",
        status: "CREATE_COMPLETE",
      },
    ];

    const events = await drain(open(backend).teardown({ yes: true, purge: true }));
    expect([...backend.params.keys()]).toContain("/hermes/gone-one/ts-key");
    expect(events.find((e) => e.phase === "ssm")!.message).toContain("CloudFormation shows 2");
  });

  /**
   * A directory that cannot be read is "cannot tell", never permission: the
   * pre-v3 paths stay, and the receipt says why rather than leaving an operator
   * to wonder whether `--purge` worked.
   */
  test("on, a directory that cannot be read means no legacy sweep, and says so", async () => {
    const backend = leftovers({ directory: "seeded" });
    await backend.store.agents.putIfAbsent(destroyedRow("gone-one"));
    backend.params.set("/hermes/gone-one/ts-key", FIXTURE_TS_KEY);
    backend.directory.list = async () => {
      throw new HermeticError("DIRECTORY_UNAVAILABLE", "the directory table is not readable");
    };

    const events = await drain(open(backend).teardown({ yes: true, purge: true }));
    expect([...backend.params.keys()]).toContain("/hermes/gone-one/ts-key");
    const ssm = events.find((e) => e.phase === "ssm")!;
    expect(ssm.message).toContain("could not be read");
  });

  /**
   * The refusal that makes the sweep above safe: with a second fleet in the
   * account, a parameter on the roots may be *its* Tailscale client or provider
   * key, and this teardown has no way to tell.
   */
  test("on, the account roots are left alone while another fleet is live", async () => {
    const backend = leftovers({ directory: "seeded" });
    backend.params.set("/hermes/gone-one/ts-key", FIXTURE_TS_KEY);

    await drain(open(backend).teardown({ yes: true, purge: true }));
    expect([...backend.params.keys()]).toEqual(["/hermes/gone-one/ts-key"]);
  });
});

describe("teardown --delete-snapshots", () => {
  test("off, the DLM snapshots are left alone", async () => {
    const backend = leftovers();
    const events = await drain(open(backend).teardown({ yes: true, delete_snapshots: false }));
    expect(phases(events)).not.toContain("snapshots");
    expect(backend.snapshots.size).toBe(4);
  });

  test("on, only the hermetic:role=data snapshots go, with a total in GiB", async () => {
    const backend = leftovers();
    const events = await drain(open(backend).teardown({ yes: true, delete_snapshots: true }));
    const snapshots = events.find((e) => e.phase === "snapshots")!;
    expect(snapshots.message).toContain("3 DLM snapshot(s)");
    expect(snapshots.message).toContain("400 GiB");
    expect(snapshots.level).toBe("warn");
    expect([...backend.snapshots.keys()]).toEqual(["snap-foreign"]);

    const details = backend.events.filter((e) => e.name === FLEET_KEY).map((e) => e.detail);
    expect(details).toContain("snapshots: deleted 3 snapshot(s), 400 GiB");
  });
});

describe("teardown --delete-volumes", () => {
  test("off, the leftover volumes survive the fleet", async () => {
    const backend = leftovers();
    const events = await drain(open(backend).teardown({ yes: true, delete_volumes: false }));
    expect(phases(events)).not.toContain("volumes");
    expect(backend.volumes.size).toBe(3);
  });

  test("on, every managed volume goes and the event says the memory is lost", async () => {
    const backend = leftovers();
    const events = await drain(open(backend).teardown({ yes: true, delete_volumes: true }));
    const volumes = events.find((e) => e.phase === "volumes")!;
    // Three, not two: the role-less volume is managed as well (F7).
    expect(volumes.message).toContain("3 leftover volume(s)");
    expect(volumes.message).toContain("350 GiB");
    expect(volumes.message).toContain("memory, episode log and skill library");
    expect(volumes.level).toBe("warn");
    expect(backend.volumes.size).toBe(0);

    const details = backend.events.filter((e) => e.name === FLEET_KEY).map((e) => e.detail);
    expect(details).toContain("volumes: deleted 3 volume(s), 350 GiB");
  });

  test("the plan warns that the volumes are the agents' memory", async () => {
    const plan = await open(leftovers()).plan.teardown({ delete_volumes: true });
    expect(plan.warnings.join(" | ")).toContain("memory, episode log and skill library");
  });
});

describe("teardown --reset-local", () => {
  test("archives the runs log and removes the frozen config row", async () => {
    const local = openMemoryDb();
    writeConfig(local.db, FIXTURE_CONFIG);
    recordRun(local.db, { command: "agent ps", exit_code: 0 });
    recordRun(local.db, { command: "teardown", exit_code: 0 });

    const configStore: ConfigStore = {
      write: async () => {},
      archiveRuns: async () => {
        archiveRuns(local.db);
      },
      clear: async () => {
        clearConfig(local.db);
      },
    };

    const backend = leftovers();
    const events = await drain(open(backend, configStore).teardown({ yes: true }));
    expect(events.some((e) => e.phase === "local")).toBe(true);

    expect(readConfig(local.db)).toBeNull();
    expect((local.db.query(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n).toBe(0);
    // Archived, not dropped (§4.7).
    expect((local.db.query(`SELECT COUNT(*) AS n FROM runs_archive`).get() as { n: number }).n).toBe(2);
    local.close();
  });

  test("runs last: the local row is still there when an earlier phase throws", async () => {
    const backend = leftovers();
    const { calls, store } = countingConfigStore();
    const failing: Backend = {
      ...backend,
      foundation: {
        ...backend.foundation,
        deleteStack: async () => {
          throw new HermeticError("INTERNAL", "DeleteStack failed", {});
        },
      },
    };
    const hermetic = testHermetic({ backend: failing, config: FIXTURE_CONFIG, configStore: store });

    expect(await codeOf(() => drain(hermetic.teardown({ yes: true })))).toBe("INTERNAL");
    expect(calls).toEqual({ archived: 0, cleared: 0 });
    // The bucket did go: the phases before the failure are not rolled back.
    expect(backend.objects.size).toBe(0);
    expect(backend.params.size).toBe(SEEDED_PARAMS.length);
  });

  test("off, nothing local is touched", async () => {
    const { calls, store } = countingConfigStore();
    const events = await drain(open(leftovers(), store).teardown({ yes: true, reset_local: false }));
    expect(phases(events)).not.toContain("local");
    expect(calls).toEqual({ archived: 0, cleared: 0 });
  });

  test("on, both local writes happen exactly once", async () => {
    const { calls, store } = countingConfigStore();
    await drain(open(leftovers(), store).teardown({ yes: true }));
    expect(calls).toEqual({ archived: 1, cleared: 1 });
  });
});

describe("teardown honours the abort signal between phases", () => {
  test("aborting after the bucket stops before the stack is deleted", async () => {
    const backend = leftovers();
    const controller = new AbortController();
    const seen: string[] = [];
    let code: string | null = null;
    try {
      for await (const event of open(backend).teardown({ yes: true }, { signal: controller.signal })) {
        seen.push(event.phase);
        if (event.phase === "bucket") controller.abort();
      }
    } catch (e) {
      code = e instanceof HermeticError ? e.code : String(e);
    }
    expect(code).toBe("ABORTED");
    expect(seen).toEqual(["agents_check", "bucket"]);
    // The mutation the next phase would have made did not happen.
    expect(backend.stack).not.toBeNull();
    expect(backend.mutations).not.toContain("foundation.deleteStack");
    expect(backend.params.size).toBe(SEEDED_PARAMS.length);
  });

  test("a signal already aborted stops before the bucket is emptied", async () => {
    const backend = leftovers();
    const controller = new AbortController();
    controller.abort();
    expect(
      await codeOf(() => drain(open(backend).teardown({ yes: true }, { signal: controller.signal }))),
    ).toBe("ABORTED");
    expect(backend.objects.size).toBeGreaterThan(0);
    expect(backend.mutations).not.toContain("artifacts.emptyBucket");
  });
});

describe("apply(plan.teardown(...))", () => {
  test("carries the plan's flags rather than the defaults", async () => {
    const backend = leftovers();
    const hermetic = open(backend);
    const plan = await hermetic.plan.teardown({
      purge: false,
      delete_snapshots: true,
      delete_volumes: true,
    });
    const events = await drain(
      hermetic.apply({ plan, yes: true, confirm_account_id: FIXTURE_CONFIG.account_id }),
    );

    expect(phases(events)).toEqual(plan.steps.map((s) => s.id));
    // purge off: the parameters are still there. Both delete flags on: gone.
    expect(backend.params.size).toBe(SEEDED_PARAMS.length);
    expect(backend.volumes.size).toBe(0);
    expect([...backend.snapshots.keys()]).toEqual(["snap-foreign"]);
  });

  test("a default plan keeps the volumes and the snapshots", async () => {
    const backend = leftovers();
    const hermetic = open(backend);
    await drain(
      hermetic.apply({
        plan: await hermetic.plan.teardown(),
        yes: true,
        confirm_account_id: FIXTURE_CONFIG.account_id,
      }),
    );
    expect(backend.volumes.size).toBe(3);
    expect(backend.snapshots.size).toBe(4);
    expect(backend.params.size).toBe(0);
  });

  test("refuses without yes", async () => {
    const hermetic = open(leftovers());
    const plan = await hermetic.plan.teardown();
    expect(await codeOf(() => drain(hermetic.apply({ plan, yes: false })))).toBe(
      "CONFIRMATION_REQUIRED",
    );
  });

  /**
   * F1/F2: `apply` was the way *round* the §4.7 ceremony. `hermetic apply
   * plan.json --yes` and `POST /api/apply {plan, yes: true}` both landed here,
   * and here `yes` alone was enough to delete a whole foundation. The typed
   * twelve digits are now required for a teardown plan, at the core, so no head
   * can be the one that forgets to ask.
   */
  test("refuses a teardown plan with no typed account id, and mutates nothing", async () => {
    const backend = leftovers();
    const hermetic = open(backend);
    const plan = await hermetic.plan.teardown();
    expect(await codeOf(() => drain(hermetic.apply({ plan, yes: true })))).toBe(
      "CONFIRMATION_REQUIRED",
    );
    expect(backend.mutations).toEqual([]);
    expect(backend.stack).not.toBeNull();
    expect(backend.objects.size).toBeGreaterThan(0);
  });

  test("refuses a teardown plan whose typed account id names another account", async () => {
    const backend = leftovers();
    const hermetic = open(backend);
    const plan = await hermetic.plan.teardown();
    expect(
      await codeOf(() =>
        drain(hermetic.apply({ plan, yes: true, confirm_account_id: "999999999999" })),
      ),
    ).toBe("CONFIRMATION_REQUIRED");
    expect(backend.mutations).toEqual([]);
    expect(backend.stack).not.toBeNull();
  });

  /** The comparison is against the frozen config, never the plan document. */
  test("a plan document claiming another account cannot move the target", async () => {
    const backend = leftovers();
    const hermetic = open(backend);
    const plan = await hermetic.plan.teardown();
    const forged = {
      ...plan,
      summary: {
        account_id: "999999999999",
        region: FIXTURE_CONFIG.region,
        fleet_id: FIXTURE_CONFIG.fleet_id,
        stack_id: null,
      },
    };
    expect(
      await codeOf(() =>
        drain(hermetic.apply({ plan: forged, yes: true, confirm_account_id: "999999999999" })),
      ),
    ).toBe("CONFIRMATION_REQUIRED");
    expect(backend.stack).not.toBeNull();
  });

  test("runs with the right twelve digits", async () => {
    const backend = leftovers();
    const hermetic = open(backend);
    const plan = await hermetic.plan.teardown();
    const events = await drain(
      hermetic.apply({ plan, yes: true, confirm_account_id: FIXTURE_CONFIG.account_id }),
    );
    expect(phases(events)).toEqual(plan.steps.map((s) => s.id));
    expect(backend.stack).toBeNull();
  });

  /** The agent-level plans keep their own confirmation: `yes`, not the digits. */
  test("a destroy plan still applies with yes alone", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = open(backend);
    const plan = await hermetic.plan.destroy({ name: "atlas" });
    await drain(hermetic.apply({ plan, yes: true }));
    expect((await hermetic.agents.get("atlas")).status).toBe("destroyed");
  });
});

/** §4.7 step 3, in core: a typed account id that disagrees stops the command. */
describe("teardown's typed account id", () => {
  test("a mismatch is CONFIRMATION_REQUIRED before anything is touched", async () => {
    const backend = leftovers();
    expect(
      await codeOf(() =>
        drain(open(backend).teardown({ yes: true, confirm_account_id: "999999999999" })),
      ),
    ).toBe("CONFIRMATION_REQUIRED");
    expect(backend.mutations).toEqual([]);
    expect(backend.stack).not.toBeNull();
  });

  test("the frozen account's own digits are accepted", async () => {
    const backend = leftovers();
    const events = await drain(
      open(backend).teardown({ yes: true, confirm_account_id: FIXTURE_CONFIG.account_id }),
    );
    expect(events.at(-1)?.phase).toBe("done");
    expect(backend.stack).toBeNull();
  });

  /** Interactive heads compare it themselves, so its absence is not a refusal. */
  test("omitting it leaves `teardown` working as it did", async () => {
    const backend = leftovers();
    await drain(open(backend).teardown({ yes: true }));
    expect(backend.stack).toBeNull();
  });
});

/**
 * H4's follow-ups: the lock is held for the whole run, so every way a run can
 * end or a heartbeat can fail is a way the fleet can be left locked, unlocked,
 * or — worst of the three — believed locked while somebody else holds it.
 */
describe("the fleet lock across a teardown's phases", () => {
  /**
   * A consumer that walks away: a closed browser tab, a `break` in a `for
   * await`, an op the portal cancels. The generator is resumed with a `return`
   * completion at the yield it is suspended on, which runs no `catch` and
   * nothing after the `try` — so a release that is not in a `finally` never
   * happens, and the fleet stays locked for the whole ten-minute TTL with
   * nothing running to renew or release it.
   */
  test("abandoning the teardown part-way gives the fleet lock back", async () => {
    const backend = leftovers();
    const teardown = open(backend).teardown({ yes: true })[Symbol.asyncIterator]();
    let step = await teardown.next();
    while (!step.done && step.value.phase !== "bucket") step = await teardown.next();
    expect(step.done).toBe(false);

    await teardown.return?.(undefined);

    expect((await backend.store.fleet.get())?.lock ?? null).toBeNull();
    expect(backend.mutations).toContain("store.fleet.unlockFleet");
    // And it really did stop where it was asked to: the stack is still there.
    expect(backend.stack).not.toBeNull();
  });

  /**
   * The sweep is one call, and on a bucket with a release history in it that
   * one call pages for a long time. A heartbeat only between phases would let
   * the lock expire in the middle of exactly the phase it was taken to protect.
   */
  test("the lock is renewed from inside a multi-page bucket sweep", async () => {
    const backend = leftovers();
    const paged = {
      ...backend,
      artifacts: {
        ...backend.artifacts,
        emptyBucket: async (onPage?: () => Promise<void>): Promise<number> => {
          for (let page = 0; page < 3; page++) {
            // Each page costs half the lock's life; three of them outlive it.
            backend.advance(LOCK_TTL_MS / 2);
            await onPage?.();
          }
          return 3000;
        },
      },
    } as Backend;
    backend.resetMutations();

    await drain(testHermetic({ backend: paged, config: FIXTURE_CONFIG }).teardown({ yes: true }));

    // One renew for each page that aged the lock past a third of its life.
    // Without the heartbeat inside the sweep this is zero.
    const renews = backend.mutations.filter((m) => m === "store.fleet.renewFleetLock").length;
    expect(renews).toBe(3);
    // And every one of them was a renew: the lock is taken exactly once, because
    // a heartbeat that re-acquired would take back a lock that had expired and
    // hide the window somebody else could have walked through (§4.4).
    const takes = backend.mutations.filter((m) => m === "store.fleet.lockFleet").length;
    expect(takes).toBe(1);
  });

  /**
   * A heartbeat that could not reach the store has not learned anything about
   * who holds the lock. Reading a throttle or an unreachable table as "the lock
   * is gone" dropped this run's claim on a fleet whose lock was still live and
   * still ours, and left the rest of the teardown running unprotected.
   */
  test("a store failure while the stack deletes is not a lost lock", async () => {
    const backend = leftovers();
    let failRenew = false;
    const throttling = {
      ...backend,
      store: {
        ...backend.store,
        fleet: {
          ...backend.store.fleet,
          // The heartbeat renews, never re-acquires (§4.4), so this is the door
          // it knocks on — and the one a throttled table stops answering.
          renewFleetLock: async (owner: string, expires: string, now: Date): Promise<boolean> => {
            if (failRenew) throw new HermeticError("INTERNAL", "throughput exceeded for the table");
            return backend.store.fleet.renewFleetLock(owner, expires, now);
          },
        },
      },
      foundation: {
        ...backend.foundation,
        deleteStack: async (): Promise<void> => {
          // The delete outlives the lock, and the store stops answering as it
          // does — so the next heartbeat both is due and cannot be made.
          backend.advance(LOCK_TTL_MS);
          failRenew = true;
          await Bun.sleep(20);
          backend.stack = null;
        },
      },
    } as Backend;

    const hermetic = testHermetic({
      backend: throttling,
      config: FIXTURE_CONFIG,
      stackWaitProgressMs: 1,
    });
    let error: HermeticError | null = null;
    try {
      await drain(hermetic.teardown({ yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    // The store's own failure, not `LOCKED` — and the run stopped rather than
    // carrying on without the lock it believes it no longer has.
    expect(error?.code).toBe("INTERNAL");
    expect(error?.message).toContain("throughput exceeded");
    expect(backend.params.size).toBe(SEEDED_PARAMS.length);
  });

  /**
   * Having called `DeleteStack` is not a reason to tolerate a lost lock. A
   * stack that ends `DELETE_FAILED` is still there, with its tables and its
   * `_fleet` row still in it, so a renew refused by *another operator's* lock
   * during the wait is a genuine steal — and treating it as "the table went
   * with the stack" reported the run as a success while somebody else was free
   * to create agents into the fleet this run was still deleting.
   */
  test("a lock stolen while the stack deletes ends the run as a loss", async () => {
    const backend = leftovers();
    const thief = "arn:aws:iam::123456789012:user/other#op-2";
    const stealing = {
      ...backend,
      foundation: {
        ...backend.foundation,
        deleteStack: async (): Promise<void> => {
          /**
           * This run's lock expired, and another operator took it — through the
           * one door that takes a lock, since `put` is create-only (§4.4). Past
           * the TTL rather than exactly to it: a lock is live *through* the
           * instant it names, in the store and in its double alike, so a take
           * at the expiry itself is still refused.
           */
          backend.advance(LOCK_TTL_MS + 1);
          await backend.store.fleet.lockFleet(
            thief,
            new Date(backend.now().getTime() + 60_000).toISOString(),
            backend.now(),
          );
          await Bun.sleep(20);
          backend.stack = null;
        },
      },
    } as Backend;

    const hermetic = testHermetic({
      backend: stealing,
      config: FIXTURE_CONFIG,
      stackWaitProgressMs: 1,
    });
    let error: HermeticError | null = null;
    try {
      await drain(hermetic.teardown({ yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("LOCKED");
    expect(error?.message).toContain(thief);
    // Named for what it costs the operator: the bucket is already empty.
    expect(error?.message).toContain("fleet bucket may already be empty");
  });

  /**
   * The other half of F3. A `_fleet` whose table is gone is not a `_fleet`
   * somebody else is holding, so the retry of a teardown that died after
   * `DeleteStack` proceeds lockless rather than being refused by a lock nobody
   * can take.
   */
  test("a `_fleet` whose table is gone is nothing to lock, and the run goes on", async () => {
    const backend = leftovers();
    const gone = new HermeticError("NOT_FOUND", `could not take the ${FLEET_KEY} lock`, {
      aws_error: "ResourceNotFoundException",
    });
    const tablesGone = {
      ...backend,
      store: {
        ...backend.store,
        agents: {
          ...backend.store.agents,
          scan: async (): Promise<never> => {
            throw gone;
          },
        },
        fleet: {
          ...backend.store.fleet,
          lockFleet: async (): Promise<never> => {
            throw gone;
          },
        },
      },
    } as Backend;

    const events = await drain(
      testHermetic({ backend: tablesGone, config: FIXTURE_CONFIG }).teardown({ yes: true }),
    );
    expect(events[0]!.message).toContain("already gone");
    expect(phases(events)).toEqual([
      "agents_check",
      "bucket",
      "stack",
      "directory",
      "tailscale",
      "ssm",
      "local",
    ]);
    expect(backend.stack).toBeNull();
  });

  /**
   * And the failure that is *not* a missing table still refuses at the door,
   * with the whole foundation untouched.
   */
  test("a lock take that fails for any other reason stops the teardown", async () => {
    const backend = leftovers();
    const refusing = {
      ...backend,
      store: {
        ...backend.store,
        fleet: {
          ...backend.store.fleet,
          lockFleet: async (): Promise<never> => {
            throw new HermeticError("FORBIDDEN", "user is not authorized to UpdateItem");
          },
        },
      },
    } as Backend;
    backend.resetMutations();

    expect(
      await codeOf(() =>
        drain(testHermetic({ backend: refusing, config: FIXTURE_CONFIG }).teardown({ yes: true })),
      ),
    ).toBe("FORBIDDEN");
    expect(backend.mutations).toEqual([]);
    expect(backend.stack).not.toBeNull();
  });

  /**
   * A refusal with no `_fleet` behind it is a fleet with no record, not a fleet
   * somebody is holding — and the two are fixed by different things, so they say
   * different things (`withFleetLock` in `artifacts.ts` splits the same pair).
   */
  test("a missing `_fleet` row is NOT_FOUND with the doctor hint, not LOCKED", async () => {
    const backend = leftovers();
    const noRow = {
      ...backend,
      store: {
        ...backend.store,
        fleet: {
          ...backend.store.fleet,
          // `guardFleet` read it; it is gone by the time the lock is taken.
          lockFleet: async (): Promise<boolean> => false,
          get: (() => {
            let reads = 0;
            return async () => {
              reads += 1;
              return reads > 1 ? null : backend.store.fleet.get();
            };
          })(),
        },
      },
    } as Backend;

    let error: HermeticError | null = null;
    try {
      await drain(testHermetic({ backend: noRow, config: FIXTURE_CONFIG }).teardown({ yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("NOT_FOUND");
    expect(error?.message).toContain("hermetic doctor");
  });
});

/**
 * F4: `deleteStack` now resolves only when the stack is really gone, which on a
 * real account is minutes. Teardown emits a heartbeat under the `stack` phase
 * for the duration so a head has something to show.
 */
describe("teardown waits for the stack deletion", () => {
  /** A foundation whose `DeleteStack` takes a while, as CloudFormation's does. */
  function slowStack(backend: MemoryBackend, ms: number, opts: { fail?: string } = {}): Backend {
    return {
      ...backend,
      foundation: {
        ...backend.foundation,
        deleteStack: async (o: { signal?: AbortSignal } = {}) => {
          await Bun.sleep(ms);
          if (o.signal?.aborted) throw new HermeticError("ABORTED", "stopped waiting");
          if (opts.fail !== undefined) throw new HermeticError("INTERNAL", opts.fail);
          backend.stack = null;
        },
      },
    } as Backend;
  }

  test("it emits progress under the stack phase while it waits", async () => {
    const backend = leftovers();
    const hermetic = testHermetic({
      backend: slowStack(backend, 60),
      config: FIXTURE_CONFIG,
      stackWaitProgressMs: 5,
    });
    const events = await drain(hermetic.teardown({ yes: true }));

    const stackEvents = events.filter((e) => e.phase === "stack");
    expect(stackEvents.length).toBeGreaterThan(1);
    expect(stackEvents[0]!.message).toContain("deleting the hermetic-fxtr0001 stack");
    expect(stackEvents.at(-1)!.message).toContain("still waiting");
    // The phases either side of it are unchanged — the wait repeats the `stack`
    // id rather than inventing one — and the deletion really finished.
    expect([...new Set(phases(events))]).toEqual([
      "agents_check",
      "bucket",
      "stack",
      "directory",
      "tailscale",
      "ssm",
      "local",
    ]);
    expect(backend.stack).toBeNull();
  });

  test("a deletion that fails stops the teardown before the SSM purge", async () => {
    const backend = leftovers();
    const hermetic = testHermetic({
      backend: slowStack(backend, 5, { fail: "the hermetic stack finished in DELETE_FAILED" }),
      config: FIXTURE_CONFIG,
      stackWaitProgressMs: 1,
    });
    let error: HermeticError | null = null;
    try {
      await drain(hermetic.teardown({ yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.message).toContain("DELETE_FAILED");
    // Nothing downstream of the stack phase ran: the parameters are still there.
    expect(backend.params.size).toBe(SEEDED_PARAMS.length);
  });

  test("the caller's signal reaches the wait", async () => {
    const backend = leftovers();
    const hermetic = testHermetic({
      backend: slowStack(backend, 30),
      config: FIXTURE_CONFIG,
      stackWaitProgressMs: 1,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    expect(
      await codeOf(() => drain(hermetic.teardown({ yes: true }, { signal: controller.signal }))),
    ).toBe("ABORTED");
  });
});

/**
 * F3: the `agents` table goes with the stack, so the retry of a teardown that
 * died between phases reads a table that is not there any more. A missing table
 * means "no agents", not "stop" — otherwise a half-torn-down account can never
 * be finished off.
 */
describe("teardown after the tables are already gone", () => {
  /** What `aws/dynamo.ts` throws once DynamoDB says ResourceNotFoundException. */
  function tableGone(): HermeticError {
    return new HermeticError(
      "NOT_FOUND",
      "could not read the hermetic-agents table: the table does not exist",
      {
        aws_error: "ResourceNotFoundException",
      },
    );
  }

  function withMissingTable(backend: MemoryBackend, thrown: unknown): Backend {
    return {
      ...backend,
      store: {
        ...backend.store,
        agents: {
          ...backend.store.agents,
          scan: async () => {
            throw thrown;
          },
        },
      },
    } as Backend;
  }

  test("the agents check passes and the teardown finishes", async () => {
    const backend = leftovers();
    const hermetic = testHermetic({
      backend: withMissingTable(backend, tableGone()),
      config: FIXTURE_CONFIG,
    });
    const events = await drain(hermetic.teardown({ yes: true }));
    expect(events[0]!.phase).toBe("agents_check");
    expect(events[0]!.message).toContain("already gone");
    expect(phases(events)).toEqual([
      "agents_check",
      "bucket",
      "stack",
      "directory",
      "tailscale",
      "ssm",
      "local",
    ]);
    expect(backend.stack).toBeNull();
  });

  /** The raw AWS name is accepted as well as the typed code. */
  test("an INTERNAL wrapping carrying the AWS name is understood too", async () => {
    const backend = leftovers();
    const raw = new HermeticError("INTERNAL", "could not read the hermetic-agents table", {
      aws_error: "ResourceNotFoundException",
    });
    const hermetic = testHermetic({
      backend: withMissingTable(backend, raw),
      config: FIXTURE_CONFIG,
    });
    expect(events0(await drain(hermetic.teardown({ yes: true })))).toContain("already gone");
  });

  test("the plan is still plannable, and says which situation this is", async () => {
    const backend = leftovers();
    const hermetic = testHermetic({
      backend: withMissingTable(backend, tableGone()),
      config: FIXTURE_CONFIG,
    });
    const plan = await hermetic.plan.teardown();
    expect(plan.kind).toBe("teardown");
    expect(plan.warnings.join(" | ")).toContain("no longer exists");
    expect(plan.warnings.some((w) => w.includes("teardown will refuse"))).toBe(false);
  });

  test("doctor reports it as a finding rather than throwing", async () => {
    const backend = leftovers();
    const hermetic = testHermetic({
      backend: withMissingTable(backend, tableGone()),
      config: FIXTURE_CONFIG,
    });
    const report = await hermetic.doctor();
    expect(report.ok).toBe(false);
    // The table is named for this fleet's stack (§5), so the finding names it too.
    expect(report.findings.join(" | ")).toContain(
      `${FIXTURE_CONFIG.fleet_id}-agents table does not exist`,
    );
  });

  /** Any other failure is still a failure: an IAM denial must not read as empty. */
  test("a different error is not mistaken for an empty fleet", async () => {
    const backend = leftovers();
    const denied = new HermeticError("FORBIDDEN", "user is not authorized to Scan");
    const hermetic = testHermetic({
      backend: withMissingTable(backend, denied),
      config: FIXTURE_CONFIG,
    });
    expect(await codeOf(() => drain(hermetic.teardown({ yes: true })))).toBe("FORBIDDEN");
    expect(backend.stack).not.toBeNull();
  });
});

/**
 * F7: the fixture backend and `Ec2Compute` have to agree about what a *managed*
 * volume is, or teardown is exercised against a narrower fleet than it will meet.
 */
describe("the fixture backend's managed volumes match EC2's", () => {
  test("a volume with no role tag is managed; a root volume and a dying one are not", async () => {
    const backend = leftovers();
    backend.volumes.set("vol-root", {
      volume_id: "vol-root",
      size_gib: 16,
      state: "in-use",
      agent: "gone-one",
      role: "root",
      fleet_id: FIXTURE_CONFIG.fleet_id,
    });
    backend.volumes.set("vol-dying", {
      volume_id: "vol-dying",
      size_gib: 100,
      state: "deleting",
      agent: "gone-two",
      role: "data",
      fleet_id: FIXTURE_CONFIG.fleet_id,
    });

    const listed = (await backend.compute.listManagedVolumes()).map((v) => v.volume_id);
    expect(listed).toEqual(["vol-gone-one", "vol-gone-two", "vol-no-role"]);
  });
});

/** §8.3: a teardown reads secret *paths* and never a value. */
describe("teardown leaks nothing", () => {
  test("neither the plan, the event stream nor the fleet event rows carry a value", async () => {
    const backend = leftovers();
    const hermetic = open(backend);
    const plan = await hermetic.plan.teardown({ delete_snapshots: true, delete_volumes: true });
    const events = await drain(
      hermetic.teardown({ yes: true, delete_snapshots: true, delete_volumes: true }),
    );
    const rows = backend.events.filter((e) => e.name === FLEET_KEY);

    for (const haystack of [JSON.stringify(plan), JSON.stringify(events), JSON.stringify(rows)]) {
      expect(haystack).not.toInclude(FIXTURE_TS_KEY);
      expect(haystack).not.toMatch(/tskey-[A-Za-z0-9-]+/);
    }
  });
});

/** The schema's defaults are the documented ones, whatever a head passes. */
describe("TeardownInput defaults", () => {
  test("`{ yes: true }` alone means purge, keep, keep, reset", async () => {
    const backend = leftovers();
    const input: TeardownInput = { yes: true };
    await drain(open(backend).teardown(input));
    expect(backend.params.size).toBe(0);
    expect(backend.volumes.size).toBe(3);
    expect(backend.snapshots.size).toBe(4);
  });
});

/**
 * §4.6: an event stream scrolls past and a portal can be closed mid-op. The
 * receipt is the same run as data — what went, what stayed, and why — kept in
 * the one local table nothing clears.
 */
describe("the teardown receipt", () => {
  test("records every resource, sorted into what went and what stayed", async () => {
    const { receipts, store } = recordingTeardowns();
    const backend = leftovers();
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, teardowns: store });

    // `opId` is the head's, passed as an option: core neither makes nor reads it.
    await drain(hermetic.teardown({ yes: true, purge: true }, { opId: "op-1" }));

    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt.outcome).toBe("ok");
    expect(receipt.error).toBeNull();
    expect(receipt.stack_name).toBe("hermetic-fxtr0001");
    expect(receipt.fleet_id).toBe(FIXTURE_CONFIG.fleet_id);
    expect(receipt.account_id).toBe(FIXTURE_CONFIG.account_id);

    const groups = groupByDisposition(receipt);
    const what = (list: typeof receipt.resources) => list.map((r) => r.what);

    // Removed: the bucket's contents, everything the stack owned, the params.
    expect(what(groups.removed)).toContain("the hermetic-fxtr0001 CloudFormation stack");
    expect(what(groups.removed)).toContain("the hermetic-fxtr0001-agents DynamoDB table");
    expect(what(groups.removed)).toContain("the hermetic-fxtr0001-events DynamoDB table");
    expect(what(groups.removed).join(" ")).toContain("SSM parameters under");

    // Retained: exactly the things the flags left alone, each saying which flag.
    const retained = groups.retained;
    expect(what(retained).join(" ")).toContain("EBS snapshots");
    expect(what(retained).join(" ")).toContain("EBS volumes");
    expect(retained.every((r) => (r.detail ?? "").length > 0)).toBe(true);
    expect(retained.find((r) => r.what.includes("volumes"))?.detail).toContain("--delete-volumes");

    // Manual: what no flag reaches, and hermetic has no credential for.
    expect(what(groups.manual)).toContain("the Tailscale OAuth client");

    // The full event log rides along, in order.
    expect(receipt.events.map((e) => e.phase)).toEqual([
      "agents_check",
      "bucket",
      "stack",
      "directory",
      "tailscale",
      "ssm",
      "local",
      "done",
    ]);
    expect(receipt.op_id).toBe("op-1");
  });

  test("counts are the counts, not a guess from the prose", async () => {
    const { receipts, store } = recordingTeardowns();
    const hermetic = testHermetic({
      backend: leftovers(),
      config: FIXTURE_CONFIG,
      teardowns: store,
    });

    await drain(
      hermetic.teardown({ yes: true, purge: true, delete_snapshots: true, delete_volumes: true }),
    );

    const by = (what: string) => receipts[0]!.resources.find((r) => r.what.includes(what));
    expect(by("SSM parameters")?.count).toBe(SEEDED_PARAMS.length);
    expect(by("EBS volumes")?.count).toBeGreaterThan(0);
    expect(by("EBS volumes")?.disposition).toBe("removed");
    expect(by("EBS snapshots")?.disposition).toBe("removed");
  });

  test("a teardown that failed is recorded too, with what it had already done", async () => {
    const { receipts, store } = recordingTeardowns();
    const backend = leftovers();
    const failing: Backend = {
      ...backend,
      foundation: {
        ...backend.foundation,
        deleteStack: async () => {
          throw new HermeticError("INTERNAL", "DeleteStack refused");
        },
      },
    };
    const hermetic = testHermetic({ backend: failing, config: FIXTURE_CONFIG, teardowns: store });

    expect(await codeOf(() => drain(hermetic.teardown({ yes: true })))).toBe("INTERNAL");

    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt.outcome).toBe("failed");
    expect(receipt.error).toMatchObject({ code: "INTERNAL", message: "DeleteStack refused" });
    // The bucket really was emptied before the stack refused, and the receipt
    // says so: a failed teardown is not a no-op, and pretending otherwise is
    // how an operator loses track of what is in the account.
    expect(
      groupByDisposition(receipt)
        .removed.map((r) => r.what)
        .join(" "),
    ).toContain("object versions");
    expect(
      groupByDisposition(receipt)
        .removed.map((r) => r.what)
        .join(" "),
    ).not.toContain("CloudFormation stack");
  });

  test("a refusal is not a teardown, and leaves no record", async () => {
    const { receipts, store } = recordingTeardowns();
    // A fleet with agents on it: `agents_check` throws before anything is
    // touched, so there is nothing to record and recording it would bury the
    // runs that did change the account.
    const hermetic = testHermetic({
      backend: seedFixtureFleet(new MemoryBackend()),
      config: FIXTURE_CONFIG,
      teardowns: store,
    });

    expect(await codeOf(() => drain(hermetic.teardown({ yes: true })))).toBe("AGENTS_EXIST");
    expect(receipts).toEqual([]);
  });

  test("it survives --reset-local: the home forgets the fleet, not what it left", async () => {
    const db = openMemoryDb().db;
    writeConfig(db, FIXTURE_CONFIG);
    const teardowns = new SqliteTeardownStore(db);
    const store: ConfigStore = {
      write: async () => {},
      archiveRuns: async () => {
        archiveRuns(db);
      },
      clear: async () => {
        clearConfig(db);
      },
    };
    const hermetic = testHermetic({
      backend: leftovers(),
      config: FIXTURE_CONFIG,
      configStore: store,
      teardowns,
    });

    await drain(hermetic.teardown({ yes: true, reset_local: true }));

    // The config row is gone — this home is uninitialized…
    expect(readConfig(db)).toBeNull();
    // …and the receipt is still there, which is the whole point of the table.
    const kept = await teardowns.list({ last: true });
    expect(kept).toHaveLength(1);
    expect(kept[0]!.fleet_id).toBe(FIXTURE_CONFIG.fleet_id);
    expect(kept[0]!.resources.length).toBeGreaterThan(5);
  });

  test("nothing in it is a secret", async () => {
    const { receipts, store } = recordingTeardowns();
    const backend = leftovers();
    backend.params.set(`${AGENT_PARAM_PREFIX}gone-one/ts-key`, FIXTURE_TS_KEY);
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, teardowns: store });

    await drain(hermetic.teardown({ yes: true, purge: true }));

    const serialised = JSON.stringify(receipts[0]);
    expect(serialised).not.toInclude(FIXTURE_TS_KEY);
    expect(serialised).not.toMatch(/tskey-[A-Za-z0-9-]+/);
  });
});

/**
 * §4.6: the allocation that can outlive the stack. CloudFormation deletes an
 * `AWS::EC2::EIP` only once its association has released — an association that
 * will not release is what puts the stack in `DELETE_FAILED`, and the way out
 * of that (`DeleteStack --retain-resources NatEip`) is what leaves an unowned
 * address behind: $3.65 a month for ever, named by nothing else a teardown
 * prints.
 */
describe("teardown's Elastic IP sweep", () => {
  const NAT_CONFIG = fixtureConfigFor("staging");

  /** The fixture's `nat` fleet: one stack, one `NatEip`, no agents. */
  function natFleet(): MemoryBackend {
    const backend = seedFixtureFoundation(new MemoryBackend({ directory: "seeded" }), {
      fleet: "staging",
    });
    backend.resetMutations();
    return backend;
  }

  function openNat(backend: Backend, store?: TeardownStore) {
    return testHermetic({ backend, config: NAT_CONFIG, ...(store ? { teardowns: store } : {}) });
  }

  /** Every event the sweep emits is its own phase; the `done` line repeats it. */
  const addressEvents = (events: Array<{ phase: string; message: string; level?: string }>) =>
    events.filter((e) => e.phase === "addresses");

  /**
   * The fixture's allocation has to carry what the template's `tags()` helper
   * stamps on the real one, or a filter that works here finds nothing on a real
   * account — `hermetic:fleet_id` is what the sweep selects on and
   * `hermetic:version` goes on every taggable resource in the stack (§5).
   */
  test("the fixture's NAT address carries the tags the template stamps", () => {
    const backend = natFleet();
    const [address] = [...backend.addresses.values()];
    expect(Object.keys(address!.tags).sort()).toEqual([FLEET_ID_TAG, "Name", VERSION_TAG].sort());
    expect(address!.tags[FLEET_ID_TAG]).toBe(NAT_CONFIG.fleet_id);
    expect(address!.tags["Name"]).toBe(`hermetic-${NAT_CONFIG.fleet_id}-nat`);
  });

  test("a public fleet has no address to sweep, and says nothing about one", async () => {
    const { receipts, store } = recordingTeardowns();
    const backend = leftovers();
    const events = await drain(
      testHermetic({ backend, config: FIXTURE_CONFIG, teardowns: store }).teardown({ yes: true }),
    );

    expect(receipts[0]!.addresses).toEqual({ kept: [], released: [] });
    expect(addressEvents(events)).toEqual([]);
    expect(backend.mutations).not.toContain("compute.releaseAddress");
  });

  test("a nat fleet whose stack took its address with it says so, and keeps nothing", async () => {
    const { receipts, store } = recordingTeardowns();
    const backend = natFleet();
    expect(backend.addresses.size).toBe(1);

    const events = await drain(openNat(backend, store).teardown({ yes: true }));

    expect(backend.addresses.size).toBe(0);
    expect(receipts[0]!.addresses).toEqual({ kept: [], released: [] });
    // The stack deleted it, not the sweep.
    expect(backend.mutations).not.toContain("compute.releaseAddress");

    const said = addressEvents(events);
    expect(said).toHaveLength(1);
    expect(said[0]!.message).toContain("no Elastic IP outlived");
    // Reassurance, not a warning: nothing is left and nothing is owed.
    expect(said[0]!.level).toBeUndefined();
  });

  /**
   * The contract §3.2 rule 3 rests on: the phases a head watches are exactly
   * the steps the operator confirmed, in the same order. The sweep is a step
   * for a `nat` fleet, so it has to be a phase for one too.
   */
  test("the nat fleet's phases are exactly the plan's steps, addresses included", async () => {
    const backend = natFleet();
    const hermetic = openNat(backend);
    const plan = await hermetic.plan.teardown();
    const events = await drain(hermetic.teardown({ yes: true }));

    expect(plan.steps.map((step) => step.id)).toContain("addresses");
    expect(phases(events)).toEqual(plan.steps.map((step) => step.id));
  });

  test("an allocation the stack left behind is in the receipt and in a warning", async () => {
    const { receipts, store } = recordingTeardowns();
    const backend = natFleet();
    backend.retainAddressOnDeleteStack = true;
    const [leftover] = [...backend.addresses.values()];

    const events = await drain(openNat(backend, store).teardown({ yes: true, purge: false }));

    expect(receipts[0]!.addresses).toEqual({
      kept: [
        {
          allocation_id: leftover!.allocation_id,
          public_ip: leftover!.public_ip,
          associated: false,
        },
      ],
      released: [],
    });
    // Still there: without `--purge` the sweep reports and never releases.
    expect(backend.addresses.size).toBe(1);
    expect(backend.mutations).not.toContain("compute.releaseAddress");

    const warned = addressEvents(events);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.level).toBe("warn");
    expect(warned[0]!.message).toContain(leftover!.allocation_id);
    expect(warned[0]!.message).toContain("$3.65 a month");
    expect(warned[0]!.message).toContain("--purge");

    // And the receipt's own sections say the same thing, for the heads that
    // render dispositions rather than the block.
    const retained = groupByDisposition(receipts[0]!).retained.map((r) => r.what);
    expect(retained).toContain("Elastic IP allocation(s) the stack left behind");
  });

  test("the done event lists a kept allocation among what is still yours to remove", async () => {
    const backend = natFleet();
    backend.retainAddressOnDeleteStack = true;
    const [leftover] = [...backend.addresses.values()];

    const events = await drain(openNat(backend).teardown({ yes: true, purge: false }));
    const done = events.find((e) => e.phase === "done")!;
    expect(done.message).toContain(leftover!.allocation_id);
  });

  test("--purge releases the unassociated one and names it", async () => {
    const { receipts, store } = recordingTeardowns();
    const backend = natFleet();
    backend.retainAddressOnDeleteStack = true;
    const [leftover] = [...backend.addresses.values()];

    const events = await drain(openNat(backend, store).teardown({ yes: true, purge: true }));

    expect(receipts[0]!.addresses).toEqual({ kept: [], released: [leftover!.allocation_id] });
    expect(backend.addresses.size).toBe(0);
    expect(backend.mutations).toContain("compute.releaseAddress");

    const released = addressEvents(events);
    expect(released).toHaveLength(1);
    expect(released[0]!.level).toBe("warn");
    expect(released[0]!.message).toContain(leftover!.allocation_id);

    const removed = groupByDisposition(receipts[0]!).removed.map((r) => r.what);
    expect(removed).toContain("Elastic IP allocation(s) the stack left behind");
  });

  /**
   * The run that most needs the address named is the one that never gets past
   * the stack: an EIP whose association will not release is *why*
   * CloudFormation ends in DELETE_FAILED, and the generator would otherwise die
   * before the sweep ever ran.
   */
  test("an address that blocked the stack delete is named before the failure is rethrown", async () => {
    const { receipts, store } = recordingTeardowns();
    const backend = natFleet();
    const [leftover] = [...backend.addresses.values()];
    backend.addresses.set(leftover!.allocation_id, {
      ...leftover!,
      association_id: "eipassoc-stuck",
      instance_id: "i-natbox",
    });

    const events: Array<{ phase: string; message: string; level?: string }> = [];
    let error: HermeticError | null = null;
    try {
      // `--purge` on, which is the default: an associated address is still
      // never released, whatever the flags said.
      for await (const event of openNat(backend, store).teardown({ yes: true, purge: true })) {
        events.push(event);
      }
    } catch (e) {
      error = e as HermeticError;
    }

    expect(error!.message).toContain("DELETE_FAILED");
    expect(backend.stack).not.toBeNull();
    expect(backend.mutations).not.toContain("compute.releaseAddress");

    // The receipt is written on the failure path too (§4.6), and it names the
    // allocation that CloudFormation could not get rid of.
    expect(receipts[0]!.outcome).toBe("failed");
    expect(receipts[0]!.addresses).toEqual({
      kept: [
        {
          allocation_id: leftover!.allocation_id,
          public_ip: leftover!.public_ip,
          associated: true,
        },
      ],
      released: [],
    });
    const manual = groupByDisposition(receipts[0]!).manual;
    expect(manual.map((r) => r.what)).toContain(
      "Elastic IP allocation(s) still associated with an instance",
    );
    expect(manual.find((r) => r.what.includes("still associated"))!.detail).toContain("i-natbox");

    const warned = addressEvents(events);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toContain("i-natbox");
    expect(warned[0]!.message).toContain("console");
  });

  /**
   * The sweep runs after the destructive point, so a read it is not permitted
   * to make must not abort the teardown: the directory would stay
   * `tearing_down` for ever, and every other laptop's `fleet ls` would go on
   * calling a deleted fleet live.
   */
  test("an unreadable address list is reported, not fatal", async () => {
    const { receipts, store } = recordingTeardowns();
    const backend = natFleet();
    const blind: Backend = {
      ...backend,
      compute: {
        ...backend.compute,
        listAddresses: async () => {
          throw new HermeticError("FORBIDDEN", "not authorized to perform: ec2:DescribeAddresses");
        },
      },
    } as Backend;

    const events = await drain(openNat(blind, store).teardown({ yes: true }));

    // It finished: the stack is gone, the parameters are gone, and — the point
    // — the directory says so.
    expect(backend.stack).toBeNull();
    expect((await backend.directory.get(NAT_CONFIG.fleet_id))!.status).toBe("torn_down");
    expect(receipts[0]!.outcome).toBe("ok");
    expect(receipts[0]!.addresses).toEqual({ kept: [], released: [] });

    const said = addressEvents(events);
    expect(said).toHaveLength(1);
    expect(said[0]!.level).toBe("warn");
    expect(said[0]!.message).toContain("ec2:DescribeAddresses");
    const manual = groupByDisposition(receipts[0]!).manual;
    expect(manual.find((r) => r.what.includes("Elastic IP"))!.detail).toContain("could not be checked");
  });
});

/**
 * §4.6: `--purge` releases the fleet's NAT address, and a release is
 * irreversible. The plan is where an operator sees that before they confirm.
 */
describe("plan.teardown names the NAT Elastic IP", () => {
  const NAT_CONFIG = fixtureConfigFor("staging");

  function natPlan(input: PlanTeardownInput = {}) {
    const backend = seedFixtureFoundation(new MemoryBackend({ directory: "seeded" }), {
      fleet: "staging",
    });
    return testHermetic({ backend, config: NAT_CONFIG }).plan.teardown(input);
  }

  test("a nat fleet's plan has the step, marked destructive, and warns it is permanent", async () => {
    const plan = await natPlan({ purge: true });
    const step = plan.steps.find((s) => s.id === "addresses")!;
    expect(step).toBeDefined();
    expect(step.destructive).toBe(true);
    expect(step.description).toContain("release the fleet's NAT Elastic IP");
    // The stack still reports the address, so the plan can name it.
    expect(step.description).toContain(FIXTURE_NAT_EGRESS_IP);

    const warning = plan.warnings.find((w) => w.includes("NAT Elastic IP"))!;
    expect(warning).toContain("permanent");
    expect(warning).toContain("allow-list");
  });

  test("with --no-purge the step only reports, and the warning says what it costs", async () => {
    const plan = await natPlan({ purge: false });
    const step = plan.steps.find((s) => s.id === "addresses")!;
    expect(step.destructive).toBe(false);
    expect(step.description).toContain("report");

    const warning = plan.warnings.find((w) => w.includes("NAT Elastic IP"))!;
    expect(warning).toContain("$3.65 a month");
    expect(warning).toContain("--purge");
  });

  test("a public fleet has no address step and no address warning", async () => {
    const plan = await open(leftovers()).plan.teardown({ purge: true });
    expect(plan.steps.map((s) => s.id)).not.toContain("addresses");
    expect(plan.warnings.some((w) => w.includes("Elastic IP"))).toBe(false);
  });
});
