import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  MemoryBackend,
  seedFixtureFleet,
  seedFixtureFoundation,
} from "../src/backend/memory.ts";
import { HermeticError } from "../src/errors.ts";
import { drain, freshFleet, testHermetic } from "./helpers.ts";
import { FOUNDATION_VERSION } from "../src/version.ts";

/**
 * §11.3: the tests that justify the account-safety design and must never be
 * skipped. `ACCOUNT_MISMATCH` against a real STS client lives in
 * `aws-client.test.ts`; everything here is the layer above it.
 */

function seeded() {
  const backend = seedFixtureFleet(new MemoryBackend());
  return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG }) };
}

/** The thrown `HermeticError` itself, for the assertions that read its message. */
async function errorOf(fn: () => Promise<unknown>): Promise<HermeticError> {
  try {
    await fn();
    throw new Error("expected a HermeticError");
  } catch (e) {
    if (!(e instanceof HermeticError)) throw e;
    return e;
  }
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof HermeticError ? e.code : `not-a-HermeticError:${String(e)}`;
  }
}

describe("ACCOUNT_MISMATCH", () => {
  test("fires when the credentials resolve to a different account", async () => {
    const { backend, hermetic } = seeded();
    backend.accountId = "999999999999";
    expect(await codeOf(() => hermetic.agents.list())).toBe("ACCOUNT_MISMATCH");
    expect(await codeOf(() => drain(hermetic.agents.create({ name: "new-one" })))).toBe(
      "ACCOUNT_MISMATCH",
    );
  });
});

describe("FLEET_MISMATCH", () => {
  test("fires when the stack tag disagrees with the local config", async () => {
    const { backend, hermetic } = seeded();
    backend.stack!.tags["fleet_id"] = "11111111-1111-4111-8111-111111111111";

    const code = await codeOf(() => drain(hermetic.agents.create({ name: "new-one" })));
    expect(code).toBe("FLEET_MISMATCH");

    // Reads that only need the account guard still work — `doctor` must be able
    // to report the disagreement rather than fail on it (§4.7).
    const report = await hermetic.doctor();
    expect(report.fleet.ok).toBe(false);
    expect(report.fleet.stack_tag).toBe("11111111-1111-4111-8111-111111111111");
    expect(report.findings).toContain("stack fleet_id tag disagrees with local config");
  });

  test("fires when the _fleet item disagrees with the local config", async () => {
    const { backend, hermetic } = seeded();
    backend.fleetItem!.fleet_id = "22222222-2222-4222-8222-222222222222";
    expect(await codeOf(() => hermetic.agents.rerun({ name: "heron" }))).toBe("FLEET_MISMATCH");
  });

  test("fires when there is no foundation at all", async () => {
    const backend = new MemoryBackend();
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
    expect(await codeOf(() => drain(hermetic.teardown({ yes: true })))).toBe("FLEET_MISMATCH");
  });

  test("doctor reports the three-way disagreement rather than throwing", async () => {
    const { backend, hermetic } = seeded();
    backend.stack!.tags["fleet_id"] = "11111111-1111-4111-8111-111111111111";
    backend.fleetItem!.fleet_id = "22222222-2222-4222-8222-222222222222";
    const report = await hermetic.doctor();
    expect(report.fleet).toMatchObject({
      local: FIXTURE_CONFIG.fleet_id,
      stack_tag: "11111111-1111-4111-8111-111111111111",
      fleet_item: "22222222-2222-4222-8222-222222222222",
      ok: false,
    });
  });
});

/**
 * §6.6: an older build must not write to a fleet whose foundation contract it
 * does not know.
 *
 * `init --attach`, `plan.foundation` and `foundation.update` already refused,
 * which covered the commands that would apply an older *template*. It left the
 * ordinary writes, and those are the dangerous ones precisely because they look
 * harmless: a build whose `FleetItem` has never heard of an attribute parses a
 * row carrying it, drops it, and writes the item back without it. `_fleet`'s
 * revision counter (v12) is the worked example — rewind it to absent and two
 * replacements composed against the same revision both pass their condition.
 */
describe("FOUNDATION_NEWER", () => {
  test("a fleet ahead of this build refuses every mutating command", async () => {
    const { backend, hermetic } = seeded();
    backend.fleetItem!.foundation_version = FOUNDATION_VERSION + 1;

    expect(await codeOf(() => drain(hermetic.agents.create({ name: "new-one" })))).toBe(
      "FOUNDATION_NEWER",
    );
    expect(await codeOf(() => hermetic.settings.set({ defaults: { size: "large" } }))).toBe(
      "FOUNDATION_NEWER",
    );
    expect(await codeOf(() => drain(hermetic.teardown({ yes: true })))).toBe("FOUNDATION_NEWER");
    // Nothing moved: the refusal is before the first write, not after it.
    expect(backend.stack).not.toBeNull();
  });

  test("reads still answer, because the skew warning is what explains the refusal", async () => {
    const { backend, hermetic } = seeded();
    backend.fleetItem!.foundation_version = FOUNDATION_VERSION + 1;

    const status = await hermetic.foundation.status();
    expect(status.tool_outdated).toBe(true);
    expect(status.skew?.severity).toBe("blocked");
    expect((await hermetic.agents.list()).length).toBeGreaterThan(0);
  });
});

/** §5: no inbound rules, ever. The sealing invariant, enforced twice. */
describe("SG_INBOUND_RULE", () => {
  test("create refuses when the security group has an inbound rule", async () => {
    const { backend, hermetic } = freshFleet();
    backend.sgInbound = [{ protocol: "tcp", from: 22, to: 22, cidr: "0.0.0.0/0" }];

    const code = await codeOf(() => drain(hermetic.agents.create({ name: "atlas" })));
    expect(code).toBe("SG_INBOUND_RULE");
    // It refuses before claiming the name, so nothing is left half-created.
    expect(await backend.store.agents.get("atlas")).toBeNull();
    expect(backend.mutations).toEqual([]);
  });

  test("create proceeds once the rule is gone", async () => {
    const { backend, hermetic } = freshFleet();
    backend.sgInbound = [{ protocol: "tcp", from: 22, to: 22, cidr: "0.0.0.0/0" }];
    await codeOf(() => drain(hermetic.agents.create({ name: "atlas" })));

    backend.sgInbound = [];
    await drain(hermetic.agents.create({ name: "atlas" }));
    expect((await backend.store.agents.get("atlas"))!.resources.instance_id).toBeString();
  });

  test("doctor reports the drift and marks the group not ok", async () => {
    const { backend, hermetic } = seeded();
    backend.sgInbound = [
      { protocol: "tcp", from: 22, to: 22, cidr: "0.0.0.0/0" },
      { protocol: "tcp", from: 443, to: 443, cidr: "10.0.0.0/8" },
    ];
    const report = await hermetic.doctor();
    expect(report.security_group).toEqual({ inbound_rules: 2, ok: false });
    expect(report.findings.join(" ")).toContain("it must have none");
  });
});

describe("confirmation and teardown", () => {
  test("destroy refuses without --yes", async () => {
    const { hermetic } = seeded();
    expect(await codeOf(() => drain(hermetic.agents.destroy({ name: "atlas", yes: false })))).toBe(
      "CONFIRMATION_REQUIRED",
    );
  });

  test("teardown refuses without --yes", async () => {
    const { hermetic } = seeded();
    expect(await codeOf(() => drain(hermetic.teardown({ yes: false })))).toBe("CONFIRMATION_REQUIRED");
  });

  test("teardown refuses while agents exist, and names them", async () => {
    const { backend, hermetic } = seeded();
    let error: HermeticError | null = null;
    try {
      await drain(hermetic.teardown({ yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("AGENTS_EXIST");
    expect((error!.details!["agents"] as string[]).length).toBeGreaterThan(0);
    // The stack is untouched. The fleet lock is the only write: teardown takes
    // it before the agent check (§4.4) and gives it straight back when the
    // check says no.
    expect(backend.stack).not.toBeNull();
    expect(backend.mutations).toEqual(["store.fleet.lockFleet", "store.fleet.unlockFleet"]);
  });

  test("teardown proceeds once every agent is destroyed", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
    await drain(hermetic.agents.create({ name: "atlas" }));
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    await drain(hermetic.teardown({ yes: true }));
    expect(backend.stack).toBeNull();
  });
});

describe("NOT_INITIALIZED", () => {
  test("every method except init refuses without a frozen config row", async () => {
    // The fixture directory is process-global, so the account this attach lands
    // in is whatever an earlier test left: put it back to the seeded account
    // that actually holds this fleet, or the attach below names a fleet some
    // other test already registered under `main`.
    const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
    const hermetic = testHermetic({ backend, config: null });
    expect(await codeOf(() => hermetic.agents.list())).toBe("NOT_INITIALIZED");
    expect(await codeOf(() => hermetic.config.show())).toBe("NOT_INITIALIZED");
    expect(await codeOf(() => hermetic.doctor())).toBe("NOT_INITIALIZED");
    // `init` is the exception: it is what writes the row.
    expect(await codeOf(() => drain(hermetic.init({ attach: true })))).toBeNull();
  });

  test("the pre-init helpers are unsupported without an init session", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: null });
    expect(await codeOf(() => hermetic.init.listProfiles())).toBe("UNSUPPORTED");
    expect(await codeOf(() => hermetic.init.resolveIdentity("p", "us-west-2"))).toBe("UNSUPPORTED");
    expect(await codeOf(() => hermetic.init.describeFoundation("p", "us-west-2"))).toBe("UNSUPPORTED");
  });

  test("they are wired when an init session supplies them", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: null,
      initSupport: {
        listProfiles: async () => [
          { name: "acme-dev", region: "us-west-2", credential_type: "sso", source: "config" },
        ],
        resolveIdentity: async (profile, region) => ({
          account_id: "123456789012",
          arn: "arn:aws:iam::123456789012:user/e",
          alias: "acme-dev",
          org_id: null,
          region,
          profile,
        }),
        describeFoundation: async () => ({
          found: true,
          fleet_id: FIXTURE_CONFIG.fleet_id,
          region: "us-west-2",
          tailnet: "hermetic.ts.net",
          stack_status: "CREATE_COMPLETE",
        }),
      },
    });
    expect((await hermetic.init.listProfiles())[0]!.credential_type).toBe("sso");
    expect((await hermetic.init.resolveIdentity("acme-dev", "us-west-2")).account_id).toBe(
      "123456789012",
    );
    expect((await hermetic.init.describeFoundation("acme-dev", "us-west-2")).fleet_id).toBe(
      FIXTURE_CONFIG.fleet_id,
    );
  });
});

/** §5, again: a recreate is a fresh boot into the same shared group. */
describe("recreate", () => {
  test("refuses without --yes: it terminates a running instance", async () => {
    const { backend, hermetic } = seeded();
    expect(await codeOf(() => drain(hermetic.agents.recreate({ name: "atlas", yes: false })))).toBe(
      "CONFIRMATION_REQUIRED",
    );
    expect(backend.mutations).toEqual([]);
  });

  test("refuses when the security group has an inbound rule", async () => {
    const { backend, hermetic } = seeded();
    backend.sgInbound = [{ protocol: "tcp", from: 22, to: 22, cidr: "0.0.0.0/0" }];
    expect(await codeOf(() => drain(hermetic.agents.recreate({ name: "atlas", yes: true })))).toBe(
      "SG_INBOUND_RULE",
    );
    expect(backend.mutations).toEqual([]);
  });

  test("keeps the data volume and never picks up a root volume", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "atlas" }));
    const dataVolume = (await backend.store.agents.get("atlas"))!.resources.volume_id!;

    // Launching produced a root volume tagged for the same agent; the data
    // volume is the one with `hermetic:role=data`, and only it is looked up.
    expect([...backend.volumes.values()].filter((v) => v.agent === "atlas")).toHaveLength(2);
    expect(await backend.compute.findVolumeByTag("atlas")).toMatchObject({
      volume_id: dataVolume,
    });
    expect(backend.volumes.get(dataVolume)!.role).toBe("data");

    backend.resetMutations();
    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));
    expect((await backend.store.agents.get("atlas"))!.resources.volume_id).toBe(dataVolume);
    expect(backend.mutations.filter((m) => m === "compute.createVolume")).toEqual([]);
  });

  test("RunInstances tags the instance, never a volume", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "atlas" }));
    expect(backend.instanceTags).toHaveLength(1);
    expect(backend.instanceTags[0]).toMatchObject({ agent: "atlas" });
  });
});

/** §3.2 rule 3: core never asks "are you sure" — it insists the head did. */
describe("apply", () => {
  test("refuses a plan the head did not confirm", async () => {
    const { hermetic } = seeded();
    const plan = await hermetic.plan.destroy({ name: "atlas" });
    expect(await codeOf(() => drain(hermetic.apply({ plan, yes: false })))).toBe(
      "CONFIRMATION_REQUIRED",
    );
  });

  test("reads delete_volume from the plan's typed options, not its prose", async () => {
    const { backend, hermetic } = seeded();
    const volumeId = (await backend.store.agents.get("granite"))!.resources.volume_id!;
    const plan = await hermetic.plan.destroy({ name: "granite", delete_volume: true });
    // The flag, beside the row the plan was computed against (`apply` refuses a
    // plan whose agent has moved since).
    expect(plan.options).toMatchObject({ delete_volume: true });

    // Rewriting every human-readable step must not change what apply does.
    const disguised = {
      ...plan,
      steps: plan.steps.map((s) => ({ ...s, description: "an opaque step" })),
    };
    await drain(hermetic.apply({ plan: disguised, yes: true }));
    expect(backend.volumes.has(volumeId)).toBe(false);
  });

  test("a recreate plan applies as a recreate", async () => {
    const { backend, hermetic } = seeded();
    const plan = await hermetic.plan.recreate({ name: "atlas" });
    expect(plan.kind).toBe("recreate");
    // The tailnet delete sits before the mint, as §6.5 requires it to.
    expect(plan.steps.map((s) => s.id)).toEqual([
      "terminate",
      "tailnet",
      "secrets",
      "launch",
      "volume",
    ]);
    expect(plan.steps.find((s) => s.id === "tailnet")!.destructive).toBe(true);
    expect(plan.warnings.join(" ")).toContain("never on the root volume");

    await drain(hermetic.apply({ plan, yes: true }));
    expect((await backend.store.agents.get("atlas"))!.status).toBe("bootstrapping");
  });
});

/** §4.7: `logs` reads the fleet, so it guards like everything else that does. */
describe("logs and rerun guards", () => {
  test("logs refuses on the wrong account", async () => {
    const { backend, hermetic } = seeded();
    backend.accountId = "999999999999";
    expect(
      await codeOf(async () => {
        for await (const line of hermetic.logs({ name: "atlas" })) void line;
      }),
    ).toBe("ACCOUNT_MISMATCH");
  });

  test("logs refuses when the stack belongs to another fleet", async () => {
    const { backend, hermetic } = seeded();
    backend.stack!.tags["fleet_id"] = "11111111-1111-4111-8111-111111111111";
    expect(
      await codeOf(async () => {
        for await (const line of hermetic.logs({ name: "atlas" })) void line;
      }),
    ).toBe("FLEET_MISMATCH");
  });

  test("logs refuses an agent that does not exist", async () => {
    const { hermetic } = seeded();
    expect(
      await codeOf(async () => {
        for await (const line of hermetic.logs({ name: "nobody" })) void line;
      }),
    ).toBe("NOT_FOUND");
  });

  /**
   * The fallback source (§6.3). Its whole point is that it answers when the RPC
   * cannot — a boot that never reached the tailnet — so it must not depend on
   * anything the box does, and "the box has said nothing yet" must read as an
   * empty stream rather than an error.
   */
  test("logs --console reads the instance's serial console", async () => {
    const { hermetic } = seeded();
    const lines = [];
    for await (const line of hermetic.logs({ name: "atlas", source: "console" })) lines.push(line);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.unit === "console")).toBe(true);
    expect(lines.map((l) => l.message).join("\n")).toContain("hermeticd-bootstrap.service");
  });

  test("logs --console is empty, not an error, for an agent with no instance", async () => {
    const { backend, hermetic } = seeded();
    const agent = (await backend.store.agents.get("juniper"))!;
    await backend.store.agents.update(agent.name, agent.version, { instance_id: null });
    const lines = [];
    for await (const line of hermetic.logs({ name: "juniper", source: "console" })) lines.push(line);
    expect(lines).toEqual([]);
  });

  test("rerun refuses every status but error", async () => {
    const { hermetic } = seeded();
    // Nothing to resume: `atlas` finished its stages, `juniper` never started.
    for (const name of ["atlas", "ember", "juniper"]) {
      expect(await codeOf(() => hermetic.agents.rerun({ name }))).toBe("INVALID_TRANSITION");
    }
  });

  test("rerun accepts the agent whose bootstrap failed", async () => {
    const { hermetic } = seeded();
    expect(await codeOf(() => hermetic.agents.rerun({ name: "heron" }))).toBeNull();
  });
});

/** §4.4: locks are TTL locks, and a live operation keeps pushing the TTL out. */
/**
 * §6.6: the fleet-wide lock. A foundation update rewrites the stack, the release
 * and every agent row, so while it holds `_fleet.lock` nothing per-agent may
 * start — and the refusal has to name what is holding it, or the operator has
 * no way to know it is not a stuck agent lock.
 */
describe("LOCKED by a foundation update", () => {
  function locked(): { backend: MemoryBackend; hermetic: ReturnType<typeof testHermetic> } {
    const { backend, hermetic } = seeded();
    backend.fleetItem = {
      ...backend.fleetItem!,
      lock: {
        owner: "arn:aws:sts::123456789012:assumed-role/hermetic-operator/someone#op-1",
        expires: new Date(backend.now().getTime() + 600_000).toISOString(),
      },
    };
    return { backend, hermetic };
  }

  test("every agent operation that takes a lock refuses while `_fleet.lock` is live", async () => {
    const { hermetic } = locked();
    expect(await codeOf(() => drain(hermetic.agents.stop("atlas")))).toBe("LOCKED");
    expect(await codeOf(() => drain(hermetic.agents.start("juniper")))).toBe("LOCKED");
    expect(await codeOf(() => drain(hermetic.agents.destroy({ name: "atlas", yes: true })))).toBe(
      "LOCKED",
    );
    expect(await codeOf(() => drain(hermetic.agents.create({ name: "newcomer" })))).toBe("LOCKED");
  });

  /**
   * The mutations that take *no* lock of their own, and so had nothing to make
   * them notice a fleet-wide one. Each is a single write — a row patch, a
   * command, one EC2 call, an SSM slot, a `DeleteVolume` — which is exactly why
   * each was left out, and exactly why a teardown's agent check could be true
   * when it was taken and false by the time the bucket was swept.
   */
  test("the lock-free mutations are refused too, not only the ones that lock", async () => {
    const { hermetic } = locked();
    expect(await codeOf(() => hermetic.agents.set({ name: "atlas", secrets: "none" }))).toBe("LOCKED");
    expect(await codeOf(() => hermetic.agents.rerun({ name: "atlas" }))).toBe("LOCKED");
    expect(await codeOf(() => hermetic.agents.reboot({ name: "atlas" }))).toBe("LOCKED");
    expect(
      await codeOf(() => hermetic.volumes.delete({ volume_id: "vol-0c85d3b7f1a94e620", yes: true })),
    ).toBe("LOCKED");
    expect(
      await codeOf(() => hermetic.secrets.push({ name: "atlas", bws_token: true, value: "x" })),
    ).toBe("LOCKED");
  });

  /**
   * A teardown is not an operation to wait out: when it finishes there is no
   * fleet left to operate on, so the sentence that is right for an update and a
   * profile rotation is a lie for this holder.
   */
  test("a teardown holding the lock says so, and does not promise a resumption", async () => {
    const { backend, hermetic } = locked();
    backend.fleetItem = {
      ...backend.fleetItem!,
      lock: {
        owner: "arn:aws:sts::123456789012:assumed-role/hermetic-operator/someone#op-1 teardown",
        expires: new Date(backend.now().getTime() + 600_000).toISOString(),
      },
    };
    const error = await errorOf(() => hermetic.agents.set({ name: "atlas", secrets: "none" }));
    expect(error.code).toBe("LOCKED");
    expect(error.message).toContain("teardown is in progress");
    expect(error.message).toContain("being torn down");
    expect(error.message).not.toContain("resume when it finishes");
  });

  /**
   * An owner string is an actor and a run id, and neither is hermetic's to
   * constrain. A trailing word that is not an operation is not one.
   */
  test("a trailing word that is not an operation is not read as one", async () => {
    const { backend, hermetic } = locked();
    backend.fleetItem = {
      ...backend.fleetItem!,
      lock: {
        owner: "arn:aws:sts::123456789012:assumed-role/hermetic-operator/someone#op-1 developer",
        expires: new Date(backend.now().getTime() + 600_000).toISOString(),
      },
    };
    const error = await errorOf(() => drain(hermetic.agents.stop("atlas")));
    expect(error.message).toContain("a foundation update is in progress");
    expect(error.message).not.toContain("developer is in progress");
  });

  test("the message names the foundation update rather than an agent's own lock", async () => {
    const { hermetic } = locked();
    try {
      await drain(hermetic.agents.stop("atlas"));
      throw new Error("expected LOCKED");
    } catch (e) {
      expect(e).toBeInstanceOf(HermeticError);
      expect((e as HermeticError).message).toContain("foundation update is in progress");
      expect((e as HermeticError).details?.["scope"]).toBe("fleet");
    }
  });

  test("reads are unaffected: a locked fleet is still readable", async () => {
    const { hermetic } = locked();
    expect((await hermetic.agents.list()).length).toBeGreaterThan(0);
    expect((await hermetic.foundation.status()).in_progress).not.toBeNull();
  });

  test("an expired fleet lock lets agent operations through again", async () => {
    const { backend, hermetic } = locked();
    backend.fleetItem = {
      ...backend.fleetItem!,
      lock: { owner: "a-dead-run", expires: new Date(backend.now().getTime() - 1).toISOString() },
    };
    expect(await codeOf(() => drain(hermetic.agents.stop("atlas")))).not.toBe("LOCKED");
  });
});

describe("locking", () => {
  test("upgrade takes and releases the per-agent lock", async () => {
    const { backend, hermetic } = seeded();
    // The per-agent work is the render and the upload; the lock has to be held
    // across it and released after (§4.4).
    let lockedDuringUpload: string | null = null;
    const real = backend.artifacts.putObject;
    backend.artifacts.putObject = async (key: string, body: Uint8Array) => {
      lockedDuringUpload ??= (await backend.store.agents.get("atlas"))!.lock?.owner ?? null;
      await real.call(backend.artifacts, key, body);
    };

    await drain(hermetic.upgrade({ name: "atlas", hermes: "0.16.0" }));
    expect(lockedDuringUpload).toBeString();
    expect((await backend.store.agents.get("atlas"))!.lock).toBeNull();
  });

  test("upgrade --all skips an agent another operator holds, and says so", async () => {
    const { backend, hermetic } = seeded();
    const held = (await backend.store.agents.get("corvid"))!;
    await backend.store.agents.update("corvid", held.version, {
      lock: {
        owner: "someone-else",
        expires: new Date(backend.now().getTime() + 600_000).toISOString(),
      },
    });

    const events = await drain(hermetic.upgrade({ all: true, hermes: "0.16.0" }));
    expect(events.some((e) => e.phase === "corvid:skipped")).toBe(true);
    expect(events.at(-1)!.message).toContain("skipped 1");
    // Everything else still moved.
    expect((await backend.store.agents.get("atlas"))!.hermes_version).toBe("0.16.0");
    expect((await backend.store.agents.get("corvid"))!.hermes_version).not.toBe("0.16.0");
  });

  test("upgrading a single locked agent is a hard LOCKED, not a skip", async () => {
    const { backend, hermetic } = seeded();
    const held = (await backend.store.agents.get("corvid"))!;
    await backend.store.agents.update("corvid", held.version, {
      lock: {
        owner: "someone-else",
        expires: new Date(backend.now().getTime() + 600_000).toISOString(),
      },
    });
    expect(await codeOf(() => drain(hermetic.upgrade({ name: "corvid", hermes: "0.16.0" })))).toBe(
      "LOCKED",
    );
  });

  test("a long create keeps renewing its lock rather than letting it lapse", async () => {
    const { backend, hermetic } = freshFleet();
    const expiries: string[] = [];
    const realCreateVolume = backend.compute.createVolume;
    backend.compute.createVolume = async (name, size) => {
      // Time passes inside the operation, as it does on a real create.
      backend.advance(9 * 60_000);
      expiries.push((await backend.store.agents.get(name))!.lock!.expires);
      return realCreateVolume(name, size);
    };

    await drain(hermetic.agents.create({ name: "atlas" }));
    const expiry = Date.parse(expiries[0]!);
    // The lock was renewed after the clock moved, so it still had life left.
    expect(expiry).toBeGreaterThan(backend.now().getTime() - 60_000);
  });
});

/** §5: the bucket is versioned, so teardown must empty it or DeleteStack fails. */
describe("teardown empties the bucket", () => {
  test("every object version is removed before the stack is deleted", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
    await drain(hermetic.agents.create({ name: "atlas" }));
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    expect(backend.objects.size).toBeGreaterThan(0);

    const events = await drain(hermetic.teardown({ yes: true }));
    expect(events.some((e) => e.phase === "bucket" && e.level === "warn")).toBe(true);
    expect(backend.objects.size).toBe(0);
    expect(backend.stack).toBeNull();
    expect(backend.mutations.indexOf("artifacts.emptyBucket")).toBeLessThan(
      backend.mutations.indexOf("foundation.deleteStack"),
    );
  });
});

/** §4.5, §9: a row that does not parse is hidden from reads, so doctor names it. */
describe("doctor reports unparseable rows", () => {
  test("names them and marks the report not ok", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    backend.unparseableRows = ["atlas", "(unnamed row)"];
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
    const report = await hermetic.doctor();

    expect(report.unparseable_rows).toEqual(["atlas", "(unnamed row)"]);
    expect(report.findings.join(" ")).toContain("2 agent row(s) do not parse");
    expect(report.findings.join(" ")).toContain("atlas, (unnamed row)");
    expect(report.ok).toBe(false);
    // The hidden row really is hidden from every fleet read.
    expect((await hermetic.agents.list()).map((a) => a.name)).not.toContain("atlas");
  });

  test("a store that tracks nothing reports an empty list and no finding", async () => {
    const { hermetic } = seeded();
    const report = await hermetic.doctor();
    expect(report.unparseable_rows).toEqual([]);
    expect(report.findings.join(" ")).not.toContain("do not parse");
  });
});
