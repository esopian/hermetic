/**
 * §8.3: which Bedrock models a fleet's instance role may invoke, and how that
 * set stops being a decision `init` made once.
 *
 * Three pure functions and one migration, and the property under all of them is
 * the same: **a grant widens, and never narrows.** A fleet that was given a
 * model by an older build keeps it, because an agent may still be serving on it
 * — so every computation here unions with what the fleet already holds, and the
 * v10 migration exists only to discover what that is on a fleet that never
 * recorded it.
 *
 * The migration entry is pulled out of the shipped list and run directly, the
 * same way `foundation-v3.test.ts` and `foundation-v9.test.ts` do it: what is
 * under test is the hook, not the twelve phases of `foundation.update` around
 * it. The last block is the exception, because the fallback it holds lives in
 * `foundation.update` itself rather than in a migration.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  FIXTURE_PROFILE_IDS,
  MemoryBackend,
  seedFixtureAgents,
  seedFixtureFleet,
  seedFixtureFoundation,
} from "../src/backend/memory.ts";
import {
  bedrockIdsFromArns,
  desiredBedrockModelIds,
  staleBedrockGrants,
} from "../src/profiles/bedrock-grants.ts";
import { DEFAULT_BEDROCK_MODEL_IDS, bedrockModelArns } from "../src/aws/index.ts";
import { FOUNDATION_MIGRATIONS } from "../src/fleet/foundation-migrations.ts";
import type { FoundationMigrationDeps } from "../src/fleet/foundation-migrations.ts";
import { HermeticError } from "../src/errors.ts";
import { FOUNDATION_VERSION } from "../src/version.ts";
import type { Agent, FleetSettings, ProviderProfile } from "../src/schema/index.ts";
import type { HermeticDeps } from "../src/hermetic.ts";
import { drain, testHermetic } from "./helpers.ts";

const V10 = FOUNDATION_MIGRATIONS.find((m) => m.version === 10)!;
const NOW = "2026-09-15T00:00:00.000Z";

/** A model no build of hermetic has ever defaulted to — "somebody else's grant". */
const FOREIGN = "meta.llama4-maverick-17b-instruct-v1:0";

/** The fixture fleet's own settings, which already state five real profiles. */
function fixtureSettings(): FleetSettings {
  return seedFixtureFleet(new MemoryBackend()).fleetItem!.settings!;
}

/** The fixture's Bedrock profile, re-pointed at whatever model a case needs. */
function bedrockProfileOn(settings: FleetSettings, model: string): ProviderProfile {
  return { ...settings.profiles![FIXTURE_PROFILE_IDS.bedrock]!, model };
}

function withProfiles(settings: FleetSettings, profiles: readonly ProviderProfile[]): FleetSettings {
  return { ...settings, profiles: Object.fromEntries(profiles.map((p) => [p.id, p])) };
}

/** One seeded agent row, since a hand-built literal would be a fifth copy of the shape. */
function agentRow(backend: MemoryBackend, name: string): Agent {
  return backend.agents.get(name)!;
}

describe("desiredBedrockModelIds", () => {
  test("this build's defaults are always in it, sorted and deduplicated", () => {
    const settings = withProfiles(fixtureSettings(), []);
    const ids = desiredBedrockModelIds({ settings, agents: [] });
    expect(ids).toEqual([...DEFAULT_BEDROCK_MODEL_IDS].sort());
    // Sorted rather than in declaration order: the value becomes a stack
    // parameter, and a set that reordered itself would show as a change.
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a Bedrock profile's model joins the set; another provider's does not", () => {
    const base = fixtureSettings();
    const settings = withProfiles(base, [
      bedrockProfileOn(base, FOREIGN),
      // An OpenRouter profile naming a Bedrock-shaped id must not be granted:
      // the grant is about what the *role* may invoke, not about strings.
      { ...base.profiles![FIXTURE_PROFILE_IDS.openrouter]!, model: "amazon.nova-pro-v1:0" },
    ]);
    const ids = desiredBedrockModelIds({ settings, agents: [] });
    expect(ids).toContain(FOREIGN);
    expect(ids).not.toContain("amazon.nova-pro-v1:0");
  });

  /**
   * A staged model counts as much as a running one. An operator who stages a
   * Bedrock model and then runs `foundation update` before the apply is doing
   * exactly the right thing, and refusing to grant what is staged would make the
   * order of those two commands a trap.
   */
  test("a pinned Bedrock model and a staged one both count", () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const settings = withProfiles(fixtureSettings(), []);
    const pinned: Agent = {
      ...agentRow(backend, "atlas"),
      provider: "bedrock",
      hermes: { model: "us.amazon.nova-premier-v1:0" },
    };
    const staged: Agent = {
      ...agentRow(backend, "granite"),
      pending: {
        profile_id: FIXTURE_PROFILE_IDS.bedrock,
        profile_revision: 2,
        provider: "bedrock",
        model: FOREIGN,
        staged_at: NOW,
        staged_by: FIXTURE_CONFIG.frozen_by,
      },
    };

    const ids = desiredBedrockModelIds({ settings, agents: [pinned, staged] });
    expect(ids).toContain("us.amazon.nova-premier-v1:0");
    expect(ids).toContain(FOREIGN);
  });

  test("an agent on another provider contributes nothing, whatever its model says", () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const settings = withProfiles(fixtureSettings(), []);
    const openrouter: Agent = {
      ...agentRow(backend, "corvid"),
      provider: "openrouter",
      pending: null,
      hermes: { model: "amazon.titan-text-premier-v1:0" },
    };
    expect(desiredBedrockModelIds({ settings, agents: [openrouter] })).toEqual(
      [...DEFAULT_BEDROCK_MODEL_IDS].sort(),
    );
  });

  /**
   * A destroyed row is a box that no longer exists. Granting for it would keep
   * a model in the policy forever on the strength of a row nothing reads.
   */
  test("a destroyed agent's model is not granted", () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const settings = withProfiles(fixtureSettings(), []);
    const gone: Agent = {
      ...agentRow(backend, "atlas"),
      status: "destroyed",
      provider: "bedrock",
      hermes: { model: FOREIGN },
    };
    expect(desiredBedrockModelIds({ settings, agents: [gone] })).not.toContain(FOREIGN);
  });

  /**
   * The rule the whole module rests on. `granted` is what the fleet's stack
   * already says, and an update that dropped a model out of it would take it
   * away from a box that is serving on it.
   */
  test("what the fleet already holds is never dropped", () => {
    const settings = withProfiles(fixtureSettings(), []);
    const ids = desiredBedrockModelIds({ settings, agents: [], granted: [FOREIGN] });
    expect(ids).toContain(FOREIGN);
    for (const id of DEFAULT_BEDROCK_MODEL_IDS) expect(ids).toContain(id);
  });

  test("an absent `granted` is not the same as an empty one, and neither loses a default", () => {
    const settings = withProfiles(fixtureSettings(), []);
    expect(desiredBedrockModelIds({ settings, agents: [], granted: [] })).toEqual(
      desiredBedrockModelIds({ settings, agents: [] }),
    );
  });
});

/**
 * §5.1: the two ARNs one id becomes, and the normalisation that has to happen
 * before they are spelled.
 */
describe("bedrockModelArns", () => {
  const PREFIXED = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
  const BARE = "anthropic.claude-sonnet-4-5-20250929-v1:0";

  /**
   * The catalog lists cross-region inference profiles under their prefixed
   * names (`model-catalog.ts`), so a profile or an agent row can perfectly well
   * pin `us.anthropic.…` — and `desiredBedrockModelIds` records what they
   * pinned. Passed through verbatim that id produces a `foundation-model/us.…`
   * that names no resource at all, and an `inference-profile/*.us.…` whose
   * wildcard would have to match a `.` the real profile ARN does not contain.
   * The grant would then cover neither spelling, and every turn on that model
   * would fail with `AccessDeniedException` from a policy that looks right.
   */
  test("a region-prefixed id is granted as the model it names, not as a literal", () => {
    const arns = bedrockModelArns("us-west-2", "111122223333", [PREFIXED]);
    expect(arns).toEqual([
      `arn:aws:bedrock:us-west-2::foundation-model/${BARE}`,
      `arn:aws:bedrock:us-west-2:111122223333:inference-profile/*.${BARE}`,
    ]);
    // The wildcard is the region prefix, so the `us.` profile's own ARN is what
    // this pattern matches — which is the whole reason it is a wildcard.
    expect(arns.some((a) => a.includes(`foundation-model/${PREFIXED}`))).toBe(false);
    expect(arns.some((a) => a.includes(`*.${PREFIXED}`))).toBe(false);
  });

  test("both spellings of one model produce one pair of ARNs", () => {
    expect(bedrockModelArns("us-west-2", "111122223333", [PREFIXED, BARE])).toEqual(
      bedrockModelArns("us-west-2", "111122223333", [BARE]),
    );
  });

  test("a prefixed id still round-trips through `bedrockIdsFromArns`", () => {
    const parameter = bedrockModelArns("us-west-2", "111122223333", [PREFIXED]).join(",");
    expect(bedrockIdsFromArns(parameter)).toEqual([BARE]);
  });
});

describe("bedrockIdsFromArns", () => {
  test("reads back exactly what `bedrockModelArns` wrote", () => {
    const ids = ["zai.glm-4.7-flash", FOREIGN];
    const parameter = bedrockModelArns("us-west-2", "111122223333", ids).join(",");
    expect(bedrockIdsFromArns(parameter)).toEqual([...ids].sort());
  });

  test("both spellings of one model collapse to the one id they name", () => {
    const parameter = [
      "arn:aws:bedrock:us-west-2::foundation-model/zai.glm-4.7-flash",
      "arn:aws:bedrock:us-west-2:111122223333:inference-profile/*.zai.glm-4.7-flash",
    ].join(",");
    expect(bedrockIdsFromArns(parameter)).toEqual(["zai.glm-4.7-flash"]);
  });

  test("nothing to read is an empty list rather than a guess", () => {
    expect(bedrockIdsFromArns(undefined)).toEqual([]);
    expect(bedrockIdsFromArns("")).toEqual([]);
    expect(bedrockIdsFromArns("   ")).toEqual([]);
    // Trailing and repeated separators are CloudFormation's, not a model id.
    expect(bedrockIdsFromArns(",,arn:aws:bedrock:us-west-2::foundation-model/a.b,,")).toEqual(["a.b"]);
  });

  /**
   * An ARN shape this build does not recognise is skipped, not guessed at. The
   * answer feeds a policy; inventing an id from a string nobody parsed would
   * grant something nobody asked for.
   */
  test("an ARN shape it does not recognise is skipped, not guessed", () => {
    const parameter = [
      "arn:aws:bedrock:us-west-2:111122223333:custom-model/something",
      "not-an-arn-at-all",
      "arn:aws:bedrock:us-west-2::foundation-model/zai.glm-4.7-flash",
    ].join(",");
    expect(bedrockIdsFromArns(parameter)).toEqual(["zai.glm-4.7-flash"]);
  });

  test("whitespace around an entry is CloudFormation's formatting, not part of the id", () => {
    expect(bedrockIdsFromArns("  arn:aws:bedrock:us-west-2::foundation-model/a.b  ")).toEqual(["a.b"]);
  });
});

describe("staleBedrockGrants", () => {
  test("a model the fleet's own stack does not cover is reported", () => {
    const base = fixtureSettings();
    const settings = withProfiles(base, [bedrockProfileOn(base, FOREIGN)]);
    const stale = staleBedrockGrants({
      settings,
      agents: [],
      granted: [...DEFAULT_BEDROCK_MODEL_IDS],
    });
    expect(stale).toEqual([FOREIGN]);
  });

  /**
   * `bedrockModelArns` grants both the bare foundation model and the `us.`
   * inference profile, so a profile whose only difference is the region prefix
   * is granted — and reporting it as stale would send an operator to a
   * `foundation update` that changes nothing.
   */
  test("a region-prefixed id is covered by the bare grant, and vice versa", () => {
    const base = fixtureSettings();
    const settings = withProfiles(base, [bedrockProfileOn(base, "us.zai.glm-4.7-flash")]);
    // The defaults are wanted too, so they are granted here; the id under test
    // is the one whose only difference from the grant is the region prefix.
    const defaults = [...DEFAULT_BEDROCK_MODEL_IDS];
    expect(staleBedrockGrants({ settings, agents: [], granted: defaults })).toEqual([]);
    expect(
      staleBedrockGrants({
        settings,
        agents: [],
        granted: defaults.map((id) => (id === "zai.glm-4.7-flash" ? "eu.zai.glm-4.7-flash" : id)),
      }),
    ).toEqual([]);
  });

  /**
   * Computed against what `_fleet` records, not against this build's defaults:
   * a newer laptop's default list is not evidence about somebody else's stack.
   */
  test("a fleet granted nothing is stale in every model it names, defaults included", () => {
    const settings = withProfiles(fixtureSettings(), []);
    expect(staleBedrockGrants({ settings, agents: [], granted: [] })).toEqual(
      [...DEFAULT_BEDROCK_MODEL_IDS].sort(),
    );
  });

  test("a grant that covers everything named reports nothing", () => {
    const base = fixtureSettings();
    const settings = withProfiles(base, [bedrockProfileOn(base, FOREIGN)]);
    const granted = desiredBedrockModelIds({ settings, agents: [] });
    expect(staleBedrockGrants({ settings, agents: [], granted })).toEqual([]);
  });
});

/* ── the v10 migration ─────────────────────────────────────────────────────── */

function depsFor(backend: MemoryBackend): FoundationMigrationDeps & { notes: string[] } {
  return {
    backend,
    fleet: backend.fleetItem!,
    actor: FIXTURE_CONFIG.frozen_by,
    nowIso: () => NOW,
    notes: [],
  };
}

async function runV10(backend: MemoryBackend): Promise<string[]> {
  const deps = depsFor(backend);
  await V10.before?.(deps);
  backend.fleetItem = deps.fleet;
  return deps.notes;
}

/** A fleet that has never recorded its grant — every fleet before v10. */
function unrecorded(backend: MemoryBackend): MemoryBackend {
  const { bedrock_model_ids: _ids, ...rest } = backend.fleetItem!;
  backend.fleetItem = rest;
  return backend;
}

/**
 * Let the first `ok` describes through and throttle every one after them — the
 * shape of a real transient failure, and the only shape that reaches the grant
 * read at all, since the account/fleet guard describes the stack first.
 */
function throttleAfter(backend: MemoryBackend, ok: number): void {
  const real = backend.foundation.describeStack.bind(backend.foundation);
  let seen = 0;
  backend.foundation.describeStack = async () => {
    seen += 1;
    if (seen > ok) throw new HermeticError("INTERNAL", "DescribeStacks was throttled", {});
    return await real();
  };
}

function armStack(backend: MemoryBackend, ids: readonly string[]): void {
  backend.stack!.parameters["BedrockModelArns"] = bedrockModelArns(
    backend.fleetItem!.region,
    FIXTURE_CONFIG.account_id,
    ids,
  ).join(",");
}

describe("the v10 foundation migration", () => {
  test("is in the shipped list, as a pre-stack hook and nothing else", () => {
    expect(V10.describe).toContain("Bedrock model grant");
    // §6.6: the ordering is the point. Run after the change set it would read
    // back the value this very update wrote, and a fleet granted something no
    // build defaults to would have lost it.
    expect(typeof V10.before).toBe("function");
    expect(V10.remote).toBeUndefined();
    expect(V10.local).toBeUndefined();
  });

  test("records the grant the stack actually holds, and says what it read", async () => {
    const backend = unrecorded(seedFixtureFleet(new MemoryBackend()));
    armStack(backend, ["anthropic.claude-sonnet-4-5-20250929-v1:0", FOREIGN]);

    const notes = await runV10(backend);

    expect(backend.fleetItem!.bedrock_model_ids).toEqual(
      ["anthropic.claude-sonnet-4-5-20250929-v1:0", FOREIGN].sort(),
    );
    expect(notes.join("\n")).toContain("read this fleet's existing Bedrock grant off its stack");
    expect(notes.join("\n")).toContain(FOREIGN);
  });

  /**
   * Idempotent, and it *says* so rather than saying nothing: the hook re-runs on
   * every retry of an update that failed later (§6.6 step 5), and a second pass
   * must not overwrite a field the first one filled.
   */
  test("a fleet that already records its grant is a reported no-op", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const before = [...backend.fleetItem!.bedrock_model_ids!];
    armStack(backend, [FOREIGN]);

    const notes = await runV10(backend);

    expect(backend.fleetItem!.bedrock_model_ids).toEqual(before);
    expect(notes.join("\n")).toContain("_fleet already records this fleet's Bedrock grant");
    // And a third pass says exactly the same thing.
    expect((await runV10(backend)).join("\n")).toContain("already records");
  });

  /**
   * "Not recorded" is a fact a head can report; a guessed empty grant is not.
   * So a stack this build cannot read the parameter off leaves the field alone
   * and the update computes the grant from the documents it does have.
   */
  test("a stack with no readable parameter leaves the field absent and explains it", async () => {
    const backend = unrecorded(seedFixtureFleet(new MemoryBackend()));
    delete backend.stack!.parameters["BedrockModelArns"];

    const notes = await runV10(backend);

    expect(backend.fleetItem!.bedrock_model_ids).toBeUndefined();
    expect(notes.join("\n")).toContain("reports no `BedrockModelArns` parameter");
  });

  test("a parameter that parses to nothing is treated as no parameter at all", async () => {
    const backend = unrecorded(seedFixtureFleet(new MemoryBackend()));
    backend.stack!.parameters["BedrockModelArns"] = "arn:aws:bedrock:us-west-2:1:custom-model/x";

    await runV10(backend);

    expect(backend.fleetItem!.bedrock_model_ids).toBeUndefined();
  });

  /**
   * Best effort, like every other pre-stack hook: it runs before CloudFormation
   * is touched, so a failure here has changed nothing, and taking the whole
   * update down would strand the operator over a read.
   */
  test("a describe that throws is a note, not a failure", async () => {
    const backend = unrecorded(seedFixtureFleet(new MemoryBackend()));
    backend.foundation.describeStack = async () => {
      throw new HermeticError("INTERNAL", "DescribeStacks was throttled", {});
    };

    const notes = await runV10(backend);

    expect(backend.fleetItem!.bedrock_model_ids).toBeUndefined();
    expect(notes.join("\n")).toContain("could not describe the foundation stack");
    expect(notes.join("\n")).toContain("throttled");
  });
});

/* ── the same fallback, inside `foundation.update` ─────────────────────────── */

/** Milliseconds, not seconds: no test waits on a change set or a rollout poll. */
const FAST: NonNullable<HermeticDeps["foundation"]> = {
  changeSetPollMs: 0,
  rolloutPollMs: 1,
  heartbeatMs: 60_000,
};

function updatable(): MemoryBackend {
  return seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
}

/**
 * The field is a cache and the stack is the register of record, so
 * `foundation.update` reads the stack whenever the cache is absent — on a fleet
 * that predates v10, and on a `_fleet` restored from an older archive. Without
 * it the grant would be recomputed from this build's defaults, which is the
 * narrowing the whole of §8.3 exists to prevent.
 */
describe("foundation.update with no recorded grant", () => {
  test("keeps a model an older build granted, and records the union on _fleet", async () => {
    const backend = unrecorded(updatable());
    armStack(backend, [FOREIGN]);
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, foundation: FAST });

    const events = await drain(hermetic.foundation.update({ yes: true }));

    const recorded = backend.fleetItem!.bedrock_model_ids!;
    expect(recorded).toContain(FOREIGN);
    for (const id of DEFAULT_BEDROCK_MODEL_IDS) expect(recorded).toContain(id);
    // The stack was told the same set, in both spellings of every id.
    expect(bedrockIdsFromArns(backend.stack!.parameters["BedrockModelArns"])).toEqual(recorded);
    // …and the operator was told which models were added rather than left to
    // find an IAM policy change in the console.
    const said = events.map((e) => e.message).join("\n");
    expect(said).toContain("granted");
    expect(backend.fleetItem!.foundation_version).toBe(FOUNDATION_VERSION);
  });

  /**
   * The negative half. A fleet whose stack this build cannot read the parameter
   * off still gets a grant — computed from the defaults, the profiles and the
   * agents — rather than an empty one.
   */
  test("an unreadable parameter still yields this build's defaults, never an empty grant", async () => {
    const backend = unrecorded(updatable());
    delete backend.stack!.parameters["BedrockModelArns"];
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, foundation: FAST });

    await drain(hermetic.foundation.update({ yes: true }));

    expect(backend.fleetItem!.bedrock_model_ids).toEqual([...DEFAULT_BEDROCK_MODEL_IDS].sort());
  });

  /**
   * A *transient* read failure is the case the fallback must not swallow.
   *
   * `backfillBedrockGrant` tolerates a failed `DescribeStacks` because it only
   * caches the answer, so the update reaches the grant computation with the
   * field still absent and has to read the stack itself. Swallowing that read
   * would turn "I could not find out" into "nothing is granted", and the change
   * set would restate `BedrockModelArns` as the defaults alone — narrowing the
   * agent role's policy under every box now serving, over a throttle. The
   * update refuses instead, and refuses before CloudFormation is touched.
   */
  test("a DescribeStacks failure refuses the update rather than narrowing the grant", async () => {
    const backend = unrecorded(updatable());
    armStack(backend, [FOREIGN]);
    // What the stack says now, which a narrowed update would drop.
    const before = backend.stack!.parameters["BedrockModelArns"];
    // Transient, and after the guard: the account/fleet guard describes the
    // stack too, so a blanket failure would never reach the grant read. This is
    // the throttle that lands between the two, which is the one the swallowed
    // `.catch(() => null)` turned into an empty grant.
    throttleAfter(backend, 1);
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, foundation: FAST });

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.foundation.update({ yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toContain("Bedrock grant");
    expect(error?.message).toContain("throttled");
    // Nothing was narrowed: the stack still states the grant it stated, and
    // `_fleet` still records no grant rather than an empty one.
    expect(backend.stack!.parameters["BedrockModelArns"]).toBe(before!);
    expect(backend.fleetItem!.bedrock_model_ids).toBeUndefined();
  });

  /**
   * The rows are the other input the grant is computed from. They can only
   * widen it, so a swallowed scan would not narrow the policy — it would leave
   * a model only an agent row names out of the grant and call the update done.
   */
  test("an agent scan failure refuses the update rather than under-stating the grant", async () => {
    const backend = updatable();
    const before = backend.stack!.parameters["BedrockModelArns"];
    // The update scans the rows more than once (the stateful-replacement
    // guard, the rollout), each with its own failure handling; the one under
    // test is the scan the grant computation makes. Fail that one only, found
    // by the frame that made it, so the assertion is about `bedrockGrant`'s
    // handling and not about how many scans precede it today.
    const realScan = backend.store.agents.scan.bind(backend.store.agents);
    backend.store.agents.scan = async () => {
      if (new Error().stack?.includes("bedrockGrant")) {
        throw new HermeticError("INTERNAL", "Scan was throttled", {});
      }
      return realScan();
    };
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, foundation: FAST });

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.foundation.update({ yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }

    expect(error?.code).toBe("FOUNDATION_UPDATE_FAILED");
    expect(error?.message).toContain("Scan was throttled");
    expect(backend.stack!.parameters["BedrockModelArns"]).toBe(before!);
  });

  /**
   * The same refusal from `plan.foundation`, which reads the grant twice to
   * describe the delta. A plan that guessed an empty grant would list every
   * model the update *keeps* as a model it adds.
   */
  test("plan.foundation refuses the same read rather than reporting a false delta", async () => {
    const backend = unrecorded(updatable());
    armStack(backend, [FOREIGN]);
    throttleAfter(backend, 1);
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, foundation: FAST });

    await expect(hermetic.plan.foundation()).rejects.toThrow(/Bedrock grant/);
  });

  test("a fleet that already records its grant does not re-read the stack for it", async () => {
    const backend = updatable();
    armStack(backend, [FOREIGN]);
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, foundation: FAST });

    await drain(hermetic.foundation.update({ yes: true }));

    // The recorded field won: `FOREIGN` was on the stack and is not adopted,
    // because `_fleet` is the answer once it exists (§8.3).
    expect(backend.fleetItem!.bedrock_model_ids).not.toContain(FOREIGN);
  });
});

/**
 * §8.3: the recorded grant has **three** states, and `doctor` reports all three.
 *
 * A non-empty stale list is a finding; an empty one is "compared, nothing
 * stale"; and an absent field is *unchecked*, which is the state a fleet the
 * v10 migration has not reached is in. Silence on the third would mean the one
 * fleet nobody has checked is the one `doctor` calls clean.
 */
describe("doctor and the recorded grant", () => {
  test("a fleet that has never recorded a grant reports bedrock_grant_unrecorded", async () => {
    const backend = unrecorded(seedFixtureFleet(new MemoryBackend()));
    const report = await testHermetic({ backend, config: FIXTURE_CONFIG }).doctor();
    const finding = report.findings.find((f) => f.includes("bedrock_grant_unrecorded"));
    expect(finding).toBeDefined();
    // The remedy is the command that records it, named the way every other
    // finding names its fix.
    expect(finding).toContain("hermetic foundation update");
  });

  test("a fleet that records one says nothing about it when nothing is stale", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const report = await testHermetic({ backend, config: FIXTURE_CONFIG }).doctor();
    expect(report.findings.filter((f) => f.includes("bedrock_grant"))).toEqual([]);
  });

  test("a recorded grant that misses a named model is still the stale finding", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    backend.fleetItem = { ...backend.fleetItem!, bedrock_model_ids: [] };
    const report = await testHermetic({ backend, config: FIXTURE_CONFIG }).doctor();
    expect(report.findings.some((f) => f.includes("bedrock_grant_stale"))).toBe(true);
    expect(report.findings.some((f) => f.includes("bedrock_grant_unrecorded"))).toBe(false);
  });
});
