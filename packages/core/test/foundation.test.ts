/**
 * `foundation.status`, `plan.foundation` and `foundation.update` (§6.6).
 *
 * The properties worth a test are the ones the design rests on: the stamp is the
 * *last* write, so a failure anywhere before it leaves the fleet where it was
 * and the op re-runnable; the fleet lock is taken before anything changes and
 * released whatever happens; a change set that would replace a table is refused
 * with no way to override; and a rollout is a hint on a row, so an agent that is
 * not up is deferred rather than failed.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  FIXTURE_HERMETICD_VERSION,
  MemoryBackend,
  seedFixtureAgents,
  seedFixtureFoundation,
  seedFixtureRelease,
} from "../src/backend/memory.ts";
import {
  FLEET_MANIFEST_KEY,
  FoundationStatus,
  foundationPhases,
  type Agent,
  type FleetItem,
  type OpEvent,
} from "../src/schema/index.ts";
import { readFleetManifest } from "../src/release/artifacts.ts";
import { foundationTemplateSha256 } from "../src/aws/cfn-template.ts";
import { bedrockModelArns } from "../src/aws/index.ts";
import { FOUNDATION_VERSION } from "../src/version.ts";
import { HermeticError } from "../src/errors.ts";
import { BUILD_VERSIONS, createHermetic, type HermeticDeps } from "../src/hermetic.ts";
import {
  compareReleaseTags,
  createFoundation,
  normaliseReleaseTag,
  type FoundationDeps,
} from "../src/fleet/foundation/index.ts";
import type { FetchLike } from "../src/aws/tailscale.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OFFLINE_HERMES_RELEASE,
  drain,
  installTestStages,
  testContext,
  testHermetic,
} from "./helpers.ts";

/**
 * §4.8: these walk `init --create`, so the account they describe has no fleets
 * in it yet. The fixture directory is process-global and seeded with
 * `main`/`staging` for the *populated* fixture account, and an unnamed create
 * against that one is correctly refused — so each of these says which account
 * it is in rather than inheriting whichever ran last.
 */
/** Milliseconds, not seconds: no test waits on a change set or a rollout poll. */
const FAST: NonNullable<HermeticDeps["foundation"]> = {
  changeSetPollMs: 0,
  rolloutPollMs: 1,
  heartbeatMs: 60_000,
};

function core(backend: MemoryBackend, foundation: HermeticDeps["foundation"] = FAST) {
  return testHermetic({ backend, config: FIXTURE_CONFIG, foundation: { ...FAST, ...foundation } });
}

/**
 * A fleet as it stood before `foundation.update` existed: no
 * `foundation_version` at all (which reads as 0) and an older hermeticd. This is
 * the shape every real fleet is in until the first update runs.
 */
function outdated(backend: MemoryBackend): MemoryBackend {
  const { foundation_version: _v, foundation_template_sha256: _s, ...rest } = backend.fleetItem!;
  backend.fleetItem = { ...rest, min_hermetic_version: "0.4.0" };
  return backend;
}

function fleetOf(backend: MemoryBackend): FleetItem {
  return backend.fleetItem!;
}

/**
 * A box taking the release, as the fleet actually observes one: a fresh
 * heartbeat *and* the digest of the binary it is now running.
 *
 * The digest is read out of the manifest this very op just published rather
 * than hardcoded, which is the point — `rollout` confirms by comparing the two,
 * and a test that invented its own number would pass while agreeing with
 * nothing. It polls because the manifest is written during the artifacts phase,
 * a little after the op starts and before the rollout wait begins.
 *
 * `aheadMs` is added to the fleet clock for the heartbeat, so a caller can give
 * a badly skewed box a heartbeat far in its own future.
 */
function landOn(backend: MemoryBackend, name: string, aheadMs: number): { stop: () => void } {
  const timer = setInterval(() => {
    void (async () => {
      const manifest = await readFleetManifest(backend.artifacts).catch(() => null);
      const sha256 = manifest?.hermeticd.files["hermeticd"]?.sha256;
      const row = backend.agents.get(name);
      if (!sha256 || !row) return;
      clearInterval(timer);
      backend.agents.set(name, {
        ...row,
        hermeticd_version: FIXTURE_HERMETICD_VERSION,
        running_hermeticd_sha256: sha256,
        last_heartbeat: new Date(backend.now().getTime() + aheadMs).toISOString(),
      });
    })();
  }, 2);
  return { stop: () => clearInterval(timer) };
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

describe("foundation.status", () => {
  test("a fleet this build just created is up to date", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const status = await core(backend).foundation.status();
    expect(status.fleet.foundation_version).toBe(FOUNDATION_VERSION);
    expect(status.fleet.template_sha256).toBe(foundationTemplateSha256());
    // The image the fleet was built on, straight off `_fleet` — the read that
    // already opens that item is the one that answers "which AMI?".
    expect(status.fleet.ubuntu_release).toBe(fleetOf(backend).ubuntu_release);
    expect(status.fleet.ami_id).toBe(fleetOf(backend).ami_id);
    expect(status.update_available).toBe(false);
    expect(status.tool_outdated).toBe(false);
    expect(status.in_progress).toBeNull();
  });

  test("a `_fleet` item with no foundation_version is version 0, and an update is available", async () => {
    const backend = outdated(seedFixtureAgents(seedFixtureFoundation(new MemoryBackend())));
    const status = await core(backend).foundation.status();
    expect(status.fleet.foundation_version).toBe(0);
    expect(status.fleet.hermeticd_version).toBe("0.4.0");
    expect(status.available.foundation_version).toBe(FOUNDATION_VERSION);
    expect(status.update_available).toBe(true);
    expect(status.tool_outdated).toBe(false);
    // Every non-destroyed agent, with whether its own hermeticd matches.
    expect(status.agents.length).toBeGreaterThan(0);
    expect(status.agents.every((a) => a.status !== "destroyed")).toBe(true);
    expect(status.agents.some((a) => a.current)).toBe(true);
    expect(status.agents.some((a) => !a.current)).toBe(true);
    // The Hermes pin rides along on the same scan: deciding whether to bump
    // needs to show which agents are on what, not only what a new one would get.
    expect(status.agents.every((a) => "hermes_version" in a)).toBe(true);
    expect(status.agents.some((a) => a.hermes_version !== null)).toBe(true);
  });

  /**
   * §5. The mode is a first-class fact a head can read without a
   * `DescribeStacks`, and the fixture's two fleets are the two answers:
   * `main` is `public`, `staging` is the `nat` fleet. Absent stays absent —
   * a fleet the v6 migration has not reached is unrecorded, not `public`.
   */
  test("the fleet's network mode is reported, and absence is not public", async () => {
    const main = seedFixtureFoundation(new MemoryBackend());
    expect((await core(main).foundation.status()).fleet.network).toBe("public");

    const staging = seedFixtureFoundation(new MemoryBackend(), { fleet: "staging" });
    expect((await core(staging).foundation.status()).fleet.network).toBe("nat");

    const unrecorded = seedFixtureFoundation(new MemoryBackend());
    unrecorded.fleetItem = { ...fleetOf(unrecorded), network: undefined };
    expect((await core(unrecorded).foundation.status()).fleet.network).toBeUndefined();
  });

  test("a template edit alone makes an update available, even at the same version", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    backend.fleetItem = { ...fleetOf(backend), foundation_template_sha256: "0".repeat(64) };
    const status = await core(backend).foundation.status();
    expect(status.fleet.foundation_version).toBe(FOUNDATION_VERSION);
    expect(status.update_available).toBe(true);
  });

  test("a fleet ahead of this build reports tool_outdated", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    backend.fleetItem = { ...fleetOf(backend), foundation_version: FOUNDATION_VERSION + 5 };
    const status = await core(backend).foundation.status();
    expect(status.tool_outdated).toBe(true);
    // Nothing else differs, so there is genuinely nothing to update.
    expect(status.update_available).toBe(false);
  });

  test("tool_outdated and update_available are independent and can both be true", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    /**
     * A half-upgraded team: somebody with a newer hermetic advanced the
     * foundation version, and the fleet is still pointed at an older hermeticd
     * than *this* build ships. Both facts are true, and gating one behind the
     * other made the flag lie about the second.
     */
    backend.fleetItem = {
      ...fleetOf(backend),
      foundation_version: FOUNDATION_VERSION + 1,
      min_hermetic_version: "0.4.0",
    };
    const status = await core(backend).foundation.status();
    expect(status.tool_outdated).toBe(true);
    expect(status.update_available).toBe(true);
  });

  test("a live fleet lock is reported as an update in progress", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const expires = new Date(backend.now().getTime() + 60_000).toISOString();
    backend.fleetItem = { ...fleetOf(backend), lock: { owner: "someone-else", expires } };
    expect((await core(backend).foundation.status()).in_progress).toEqual({
      owner: "someone-else",
      expires,
    });
    // An expired one is not: a TTL lock frees itself (§4.4).
    backend.fleetItem = {
      ...fleetOf(backend),
      lock: { owner: "someone-else", expires: new Date(backend.now().getTime() - 1).toISOString() },
    };
    expect((await core(backend).foundation.status()).in_progress).toBeNull();
  });
});

/**
 * §6.6's advisory upstream-Hermes check. The properties worth pinning are the
 * ones that keep it advisory: it never throws, it never orders a tag it does
 * not recognise, and it compares upstream's tag against the *ref* this build
 * pins rather than against the semver, which are two different vocabularies.
 */
describe("the upstream Hermes check", () => {
  /** A core whose GitHub is whatever the test says it is. */
  function withUpstream(hermesFetch: FetchLike): ReturnType<typeof core> {
    const backend = seedFixtureFoundation(new MemoryBackend());
    return core(backend, { ...FAST, hermesFetch });
  }

  const answering =
    (tag: unknown): FetchLike =>
    async () =>
      Response.json({ tag_name: tag });

  test("a newer upstream tag is an advisory update, and does not touch update_available", async () => {
    const status = await withUpstream(answering("v2999.1.1")).foundation.status();
    expect(status.hermes?.pinned).toBe(BUILD_VERSIONS.hermes);
    expect(status.hermes?.pinned_ref).toBe(BUILD_VERSIONS.hermes_ref);
    expect(status.hermes?.latest).toBe("2999.1.1");
    expect(status.hermes?.update_available).toBe(true);
    expect(status.hermes?.error).toBeNull();
    expect(status.hermes?.checked_at).not.toBeNull();
    // The flag `foundation update` acts on is untouched: it applies no Hermes.
    expect(status.update_available).toBe(false);
  });

  test("the tag this build already pins is up to date, with or without its `v`", async () => {
    const ref = BUILD_VERSIONS.hermes_ref;
    for (const tag of [ref, ref.replace(/^v/, "")]) {
      const status = await withUpstream(answering(tag)).foundation.status();
      expect(status.hermes?.update_available).toBe(false);
      expect(status.hermes?.error).toBeNull();
    }
  });

  test("an older upstream tag is not an update", async () => {
    const status = await withUpstream(answering("v1.0.0")).foundation.status();
    expect(status.hermes?.latest).toBe("1.0.0");
    expect(status.hermes?.update_available).toBe(false);
  });

  /**
   * The comparison is tag-against-tag on purpose. Upstream tags by date
   * (`v2026.8.31`) and its `pyproject` carries a semver (`0.21.0`); ordering
   * the tag against `pinned` would make every date newer than every semver and
   * report an update forever.
   */
  test("it compares against the pinned ref, not the pinned semver", async () => {
    const status = await withUpstream(answering(BUILD_VERSIONS.hermes_ref)).foundation.status();
    expect(status.hermes?.pinned).toBe(BUILD_VERSIONS.hermes);
    expect(status.hermes?.pinned).not.toBe(status.hermes?.latest);
    expect(status.hermes?.update_available).toBe(false);
  });

  test("a 404 is reported, not thrown", async () => {
    const status = await withUpstream(
      async () => new Response("", { status: 404 }),
    ).foundation.status();
    expect(status.hermes?.latest).toBeNull();
    expect(status.hermes?.update_available).toBe(false);
    expect(status.hermes?.error).toContain("404");
    // The rest of the report is unaffected: this is a courtesy read.
    expect(status.fleet.foundation_version).toBe(FOUNDATION_VERSION);
  });

  test("GitHub's rate limit says so in the operator's words", async () => {
    const status = await withUpstream(
      async () => new Response("", { status: 403 }),
    ).foundation.status();
    expect(status.hermes?.error).toContain("rate limit");
    expect(status.hermes?.latest).toBeNull();
  });

  test("a timeout is a reason, not a failure", async () => {
    const status = await withUpstream(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }).foundation.status();
    expect(status.hermes?.error).toBe("timeout");
    expect(status.hermes?.latest).toBeNull();
  });

  test("the request carries a deadline of its own", async () => {
    let signal: AbortSignal | null | undefined;
    await withUpstream(async (_input, init) => {
      signal = init?.signal as AbortSignal | undefined;
      return Response.json({ tag_name: "v1.0.0" });
    }).foundation.status();
    // Without one, an upstream that accepts the socket and then says nothing
    // would hang the status read — and therefore an HTTP GET — indefinitely.
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("a tag this cannot order is shown and refused, never guessed at", async () => {
    for (const tag of ["v0.22.0-rc1", "2026.8", "nightly"]) {
      const status = await withUpstream(answering(tag)).foundation.status();
      expect(status.hermes?.error).toBe("unrecognised tag");
      expect(status.hermes?.update_available).toBe(false);
      // Still reported: an operator who can read the tag can decide for
      // themselves, which is more use than hiding it.
      expect(status.hermes?.latest).toBe(tag.replace(/^v/, ""));
    }
  });

  test("a release with no tag_name at all is a reason, not a crash", async () => {
    const status = await withUpstream(answering(null)).foundation.status();
    expect(status.hermes?.latest).toBeNull();
    expect(status.hermes?.error).toContain("tag_name");
  });

  test("the answer is cached: opening Settings twice is one request to GitHub", async () => {
    let calls = 0;
    const hermetic = withUpstream(async () => {
      calls += 1;
      return Response.json({ tag_name: "v2999.1.1" });
    });
    await hermetic.foundation.status();
    await hermetic.foundation.status();
    // 60 unauthenticated requests an hour is the whole budget; a portal that
    // spent one per page view would exhaust it on a busy afternoon.
    expect(calls).toBe(1);
  });

  test("concurrent reads share one request", async () => {
    let calls = 0;
    const hermetic = withUpstream(async () => {
      calls += 1;
      return Response.json({ tag_name: "v2999.1.1" });
    });
    await Promise.all([hermetic.foundation.status(), hermetic.foundation.status()]);
    expect(calls).toBe(1);
  });

  test("`{ hermes: false }` asks nothing and reports nothing — the CLI nag's path", async () => {
    let calls = 0;
    const hermetic = withUpstream(async () => {
      calls += 1;
      return Response.json({ tag_name: "v2999.1.1" });
    });
    const status = await hermetic.foundation.status({}, { hermes: false });
    expect(status.hermes).toBeUndefined();
    expect(calls).toBe(0);
    // Everything the nag actually prints is still there.
    expect(status.update_available).toBe(false);
  });
});

describe("the FoundationStatus schema and the report agree", () => {
  test("a status with the advisory block parses, and one without it still does", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = core(backend, {
      ...FAST,
      hermesFetch: async () => Response.json({ tag_name: "v2999.1.1" }),
    });
    // The schema is the contract the server's route and the UI's inferred type
    // both rest on; a report the schema rejects is one the portal cannot show.
    const reported = await hermetic.foundation.status();
    expect(() => FoundationStatus.parse(reported)).not.toThrow();
    const skipped = await hermetic.foundation.status({}, { hermes: false });
    expect(FoundationStatus.parse(skipped).hermes).toBeUndefined();
  });
});

describe("normaliseReleaseTag / compareReleaseTags", () => {
  test("accepts three numeric fields, with or without a leading v", () => {
    expect(normaliseReleaseTag("v2026.8.31")).toBe("2026.8.31");
    expect(normaliseReleaseTag("0.21.0")).toBe("0.21.0");
    expect(normaliseReleaseTag("  v1.2.3  ")).toBe("1.2.3");
  });

  test("refuses everything it could only guess at", () => {
    for (const tag of ["v0.22.0-rc1", "1.2", "1.2.3.4", "nightly", "v", "", "1.2.x"]) {
      expect(normaliseReleaseTag(tag)).toBeNull();
    }
  });

  test("orders numerically, field by field", () => {
    expect(compareReleaseTags("0.10.0", "0.9.0")).toBe(1);
    expect(compareReleaseTags("2026.9.4", "2026.8.31")).toBe(1);
    expect(compareReleaseTags("2026.8.31", "2026.9.4")).toBe(-1);
    expect(compareReleaseTags("2026.8.31", "2026.8.31")).toBe(0);
    expect(compareReleaseTags("1.0.0", "0.99.99")).toBe(1);
  });
});

describe("plan.foundation", () => {
  test("enumerates the phases in the order the update runs them", async () => {
    const backend = outdated(seedFixtureAgents(seedFixtureFoundation(new MemoryBackend())));
    const plan = await core(backend).plan.foundation();
    expect(plan.kind).toBe("foundation");
    expect(plan.steps.map((s) => s.id)).toEqual([
      "preflight",
      "archive",
      // §6.6: the parameter copy runs before the template narrows the role to
      // the prefix it copies into, so the plan lists it where it happens.
      "pre-stack",
      "stack",
      // §8.3: the grant the update states on the change set, listed as its own
      // step because it is the one stack parameter an update redecides.
      "bedrock-grant",
      "artifacts",
      "migrate",
      "rollout",
    ]);
    expect(plan.summary?.fleet_id).toBe(FIXTURE_CONFIG.fleet_id);
    expect(plan.steps.find((s) => s.id === "stack")!.description).toContain("AgentPolicy");
    expect(plan.steps.find((s) => s.id === "migrate")!.description).toContain("v1");
  });

  /**
   * §8.3: a fleet from before v10 records no `bedrock_model_ids` — its grant
   * lives on the stack parameter, which is exactly where the update reads it
   * from. The step has to read it the same way: taking the absent field as "the
   * fleet grants nothing" listed every model the update *keeps* as a model it
   * adds, which reads as an IAM change on a fleet nothing is changing.
   */
  test("a pre-v10 fleet's grant is read off the stack, not reported as additions", async () => {
    const backend = outdated(seedFixtureAgents(seedFixtureFoundation(new MemoryBackend())));
    const fleet = fleetOf(backend);
    const granted = fleet.bedrock_model_ids ?? [];
    expect(granted.length).toBeGreaterThan(0);
    // The v9 shape: the field is gone, and the stack parameter is the truth.
    const { bedrock_model_ids: _gone, ...pre } = fleet;
    backend.fleetItem = pre as FleetItem;
    backend.stack!.parameters["BedrockModelArns"] = bedrockModelArns(
      FIXTURE_CONFIG.region,
      FIXTURE_CONFIG.account_id,
      granted,
    ).join(",");

    const plan = await core(backend).plan.foundation();

    const step = plan.steps.find((s) => s.id === "bedrock-grant")!;
    expect(step.description).toContain("already covers");
    expect(step.description).not.toContain("further Bedrock model");
  });

  test("deletes the change set it created", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    await core(backend).plan.foundation();
    expect(backend.changeSets.size).toBe(0);
    expect(backend.mutations).toContain("foundation.createChangeSet");
    expect(backend.mutations).toContain("foundation.deleteChangeSet");
    // A plan changes nothing else at all (§3.2 rule 3).
    expect(backend.mutations.some((m) => m.startsWith("artifacts."))).toBe(false);
    expect(backend.mutations.some((m) => m.startsWith("store."))).toBe(false);
  });

  test("a replacement of a stateful resource is a warning on the plan, not a throw", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    backend.changeSetChanges = [
      {
        logicalId: "AgentsTable",
        resourceType: "AWS::DynamoDB::Table",
        action: "Modify",
        replacement: "True",
      },
    ];
    const plan = await core(backend).plan.foundation();
    expect(plan.warnings.join(" ")).toContain("REPLACE AgentsTable");
    expect(plan.steps.find((s) => s.id === "stack")!.destructive).toBe(true);
  });

  test("refuses outright when the fleet is on a newer foundation than this build", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    backend.fleetItem = { ...fleetOf(backend), foundation_version: FOUNDATION_VERSION + 1 };
    expect(await codeOf(() => core(backend).plan.foundation())).toBe("FOUNDATION_NEWER");
  });
});

/**
 * §5: v6's template gives a `nat` fleet's NAT instance a stable Elastic IP, and
 * associating an EIP with a *running* instance replaces its auto-assigned
 * public address. The fleet's egress address therefore moves as the change set
 * lands and every connection open across the NAT drops once — a one-off cost,
 * but one an upstream allow-list has to be told about beforehand rather than
 * discovered by an agent that silently stops being able to reach anything.
 */
describe("plan.foundation's NAT egress warning", () => {
  /** A fleet on `version`, with the stack's `Network` parameter forced. */
  function fleetAt(version: number, network: "public" | "nat"): MemoryBackend {
    const backend = seedFixtureFoundation(new MemoryBackend());
    backend.stack = {
      ...backend.stack!,
      parameters: { ...backend.stack!.parameters, Network: network },
    };
    backend.fleetItem = { ...backend.fleetItem!, foundation_version: version, network };
    return backend;
  }

  const warned = (warnings: readonly string[]): boolean =>
    warnings.some((w) => w.includes("Elastic IP") && w.includes("NatEgressIp"));

  test("a nat fleet crossing into v6 is warned", async () => {
    const plan = await core(fleetAt(4, "nat")).plan.foundation();
    expect(warned(plan.warnings)).toBe(true);
  });

  test("a nat fleet already on v6 is not: the association has already happened", async () => {
    const plan = await core(fleetAt(FOUNDATION_VERSION, "nat")).plan.foundation();
    expect(warned(plan.warnings)).toBe(false);
  });

  test("a public fleet is never warned: it has no NAT instance to re-address", async () => {
    expect(warned((await core(fleetAt(4, "public")).plan.foundation()).warnings)).toBe(false);
    expect(warned((await core(fleetAt(FOUNDATION_VERSION, "public")).plan.foundation()).warnings)).toBe(
      false,
    );
  });
});

describe("foundation.update", () => {
  /**
   * A file standing in for the compiled binary. §3.6's clean-tree rule is about
   * the *checkout*, not about the bytes, so the bytes can be anything — and a
   * real cross-compile in a unit test would be a minute of nothing.
   */
  const standinDir = mkdtempSync(join(tmpdir(), "hermetic-foundation-standin-"));
  const HERMETICD_STANDIN = join(standinDir, "hermeticd");
  writeFileSync(HERMETICD_STANDIN, "not a real binary");
  writeFileSync(`${HERMETICD_STANDIN}.version`, `${BUILD_VERSIONS.hermeticd}\n`);
  // A release is a binary *and* its stages; both are stand-ins here.
  installTestStages();

  test("runs every phase in order and leaves the fleet on the new version", async () => {
    const backend = outdated(seedFixtureAgents(seedFixtureFoundation(new MemoryBackend())));
    backend.resetMutations();
    const events = await drain(core(backend).foundation.update({ yes: true }));

    // The same list a head seeds its progress UI from, before any event lands.
    expect(phases(events)).toEqual(foundationPhases());
    expect(events.at(-1)).toMatchObject({ phase: "done", progress: 1 });
    // Monotone: a head draws a bar from this.
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.progress).toBeGreaterThanOrEqual(events[i - 1]!.progress);
    }

    const fleet = fleetOf(backend);
    expect(fleet.foundation_version).toBe(FOUNDATION_VERSION);
    expect(fleet.foundation_template_sha256).toBe(foundationTemplateSha256());
    expect(fleet.min_hermetic_version).toBe(FIXTURE_HERMETICD_VERSION);
    expect(fleet.foundation_updated_by).toBe(FIXTURE_CONFIG.frozen_by);
    // Released, always: an update that finished holds nothing (§4.4).
    expect(fleet.lock).toBeNull();
  });

  /**
   * §3.6's clean-tree rule, and *when* it is enforced.
   *
   * The refusal was always there — `releaseFiles` raises it — but it arrived in
   * the `artifacts` phase, after the lock, the archive and an executed change
   * set. The answer it gives could not have changed in between, so the whole
   * cost was wasted: the fleet ended up on a new template with no release to
   * match it. What this pins is that nothing is spent to learn it.
   */
  test("a dirty checkout is refused in preflight, before anything is touched", async () => {
    const backend = outdated(seedFixtureAgents(seedFixtureFoundation(new MemoryBackend())));
    const before = JSON.stringify(backend.fleetItem);
    backend.resetMutations();
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      fixture: false,
      hermeticdPath: HERMETICD_STANDIN,
      git: () => ({ build_number: 35, commit: "427e7b2", dirty: true }),
      foundation: FAST,
    });

    let code: string | null = null;
    const events: OpEvent[] = [];
    try {
      for await (const e of hermetic.foundation.update({ yes: true })) events.push(e);
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("WORKING_TREE_DIRTY");

    // Not one write, of any kind. The lock is the one that matters most —
    // taking it and then throwing would leave the fleet locked against every
    // other operator until the TTL expired, for a refusal that cost nothing to
    // reach — but the archive and the change set are the expensive two.
    expect(backend.mutations).toEqual([]);
    // And the item is byte-for-byte what it was, lock included.
    expect(JSON.stringify(backend.fleetItem)).toBe(before);

    // It still failed *somewhere*: the op has a phase to attribute the error
    // to, rather than dying before it has said what it was doing.
    expect(events.map((e) => e.phase)).toEqual(["preflight"]);
  });

  test("a dirty checkout with the escape hatch set runs the whole update", async () => {
    // The same tree, the same refusal path, `HERMETIC_ALLOW_DIRTY` honoured —
    // proving the earlier check reads the override rather than only the
    // dirtiness, which is how an early guard usually goes wrong.
    const backend = outdated(seedFixtureAgents(seedFixtureFoundation(new MemoryBackend())));
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      fixture: false,
      hermeticdPath: HERMETICD_STANDIN,
      allowDirty: true,
      git: () => ({ build_number: 35, commit: "427e7b2", dirty: true }),
      foundation: FAST,
    });
    const events = await drain(hermetic.foundation.update({ yes: true }));
    expect(events.at(-1)).toMatchObject({ phase: "done", progress: 1 });
    expect(fleetOf(backend).foundation_version).toBe(FOUNDATION_VERSION);
  });

  test("the `_fleet` stamp is the last write: the manifest is already new when it lands", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    let manifestAtStamp: number | undefined;
    let stampedDuringArtifacts: number | undefined;
    for await (const e of core(backend).foundation.update({ yes: true })) {
      if (e.phase === "artifacts" && e.kind === "done") {
        // The manifest already names the new foundation…
        manifestAtStamp = (await readFleetManifest(backend.artifacts))!.foundation?.version;
        // …and `_fleet` still does not, so a crash here re-runs cleanly.
        stampedDuringArtifacts = fleetOf(backend).foundation_version;
      }
    }
    expect(manifestAtStamp).toBe(FOUNDATION_VERSION);
    expect(stampedDuringArtifacts).toBeUndefined();
    expect(fleetOf(backend).foundation_version).toBe(FOUNDATION_VERSION);
  });

  test("the fleet manifest gains a foundation block naming the version and the template", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    await drain(core(backend).foundation.update({ yes: true }));
    const manifest = (await readFleetManifest(backend.artifacts))!;
    expect(manifest.foundation).toMatchObject({
      version: FOUNDATION_VERSION,
      template_sha256: foundationTemplateSha256(),
      applied_by: FIXTURE_CONFIG.frozen_by,
    });
    expect(manifest.hermeticd.version).toBe(FIXTURE_HERMETICD_VERSION);
    expect(await backend.artifacts.exists(FLEET_MANIFEST_KEY)).toBe(true);
  });

  test("prunes release directories down to the new one and the previous one", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    // Three ancient releases nothing points at, plus the one the fleet is on.
    for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) {
      await backend.artifacts.putObject(`artifacts/${version}/hermeticd`, new Uint8Array([1]));
    }
    await drain(core(backend).foundation.update({ yes: true }));
    const versions = new Set((await backend.artifacts.list("artifacts/")).map((k) => k.split("/")[1]));
    expect([...versions].sort()).toEqual(["0.4.0", FIXTURE_HERMETICD_VERSION].sort());
  });

  test("never prunes the release the live manifest points at", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    /**
     * `upgrade --hermeticd V` moves the fleet manifest's pointer and writes
     * nothing to `_fleet` (§6.5), so a keep set built from
     * `min_hermetic_version` alone would delete the release every box in the
     * fleet is currently fetching.
     */
    seedFixtureRelease(backend, "0.7.0");
    const manifest = (await readFleetManifest(backend.artifacts))!;
    await backend.artifacts.putObject(
      FLEET_MANIFEST_KEY,
      new TextEncoder().encode(
        `${JSON.stringify({ ...manifest, hermeticd: { ...manifest.hermeticd, version: "0.7.0" } }, null, 2)}\n`,
      ),
    );
    await backend.artifacts.putObject("artifacts/0.4.0/hermeticd", new Uint8Array([1]));
    await backend.artifacts.putObject("artifacts/0.2.0/hermeticd", new Uint8Array([1]));

    await drain(core(backend).foundation.update({ yes: true }));

    const versions = new Set((await backend.artifacts.list("artifacts/")).map((k) => k.split("/")[1]));
    // The new one, `_fleet`'s previous one, and the one the manifest pointed at.
    expect([...versions].sort()).toEqual(["0.4.0", "0.7.0", FIXTURE_HERMETICD_VERSION].sort());
    expect(versions.has("0.2.0")).toBe(false);
    // Version-aware, because the bucket is versioned and a plain delete frees
    // nothing (§5).
    expect(backend.mutations).toContain("artifacts.purgeByPrefix");
  });

  test("an agent that has never heartbeated is not reported as current", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const box = await seedOne(backend, "reborn");
    /**
     * Exactly the row `recreate` leaves behind between launching the
     * replacement instance and its first heartbeat: the release this run
     * pinned is already written, and `last_heartbeat` is null because the box
     * it describes has not booted yet.
     */
    backend.agents.set("reborn", {
      ...box,
      status: "ready",
      hermeticd_version: FIXTURE_HERMETICD_VERSION,
      last_heartbeat: null,
    });

    const status = await core(backend).foundation.status();
    const row = status.agents.find((a) => a.name === "reborn")!;
    expect(row.hermeticd_version).toBe(FIXTURE_HERMETICD_VERSION);
    // `null`, not `false`. "Has reported nothing" and "reported an old release"
    // are different answers, and only the second is a straggler — collapsing
    // them counted every stopped and every still-booting box as behind.
    expect(row.current).toBeNull();
  });

  test("the plan reports a changed build at the same version", async () => {
    const backend = outdated(seedFixtureAgents(seedFixtureFoundation(new MemoryBackend())));
    // Publish a manifest whose release was pushed from some *other* checkout.
    await drain(core(backend).foundation.update({ yes: true }));
    const published = await readFleetManifest(backend.artifacts);
    await backend.artifacts.putObject(
      "manifest.json",
      new TextEncoder().encode(
        JSON.stringify({
          ...published,
          hermeticd: { ...published!.hermeticd, build: "a".repeat(64) },
        }),
      ),
    );

    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      foundation: { ...FAST, localBuild: () => "b".repeat(64) },
    });
    const plan = await hermetic.plan.foundation();

    expect(plan.release?.published_version).toBe(FIXTURE_HERMETICD_VERSION);
    expect(plan.release?.local_version).toBe(FIXTURE_HERMETICD_VERSION);
    // The versions agree and the builds do not — which is the entire case the
    // drawer's `hermeticd <from> → <to>` line is structurally unable to show.
    expect(plan.release?.published_build).toBe("a".repeat(64));
    expect(plan.release?.local_build).toBe("b".repeat(64));
    expect(plan.release?.drift).toContain("pushed from a different build");
    expect(plan.warnings.some((w) => w.includes("different build"))).toBe(true);
  });

  test("and says nothing when the two builds agree", async () => {
    const backend = outdated(seedFixtureAgents(seedFixtureFoundation(new MemoryBackend())));
    await drain(core(backend).foundation.update({ yes: true }));
    const published = await readFleetManifest(backend.artifacts);
    /**
     * Republished with a build recorded. Fixture pushes record none, so reading
     * `published.hermeticd.build` back gave `null` on both sides and the
     * assertion below passed on `releaseDrift`'s *unknown* branch rather than
     * its *agreement* branch — a test that would have held against any
     * implementation that returns null when it cannot tell.
     */
    const build = "e".repeat(64);
    await backend.artifacts.putObject(
      "manifest.json",
      new TextEncoder().encode(
        JSON.stringify({ ...published, hermeticd: { ...published!.hermeticd, build } }),
      ),
    );

    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      foundation: { ...FAST, localBuild: () => build },
    });
    const plan = await hermetic.plan.foundation();
    // Both sides present, both equal: silence means agreement here and nothing
    // else, which is the only reading that makes the drawer's silence safe.
    expect(plan.release?.published_build).toBe(build);
    expect(plan.release?.local_build).toBe(build);
    expect(plan.release?.drift).toBeNull();
  });

  test("writes update_request on ready and degraded agents only", async () => {
    const backend = outdated(seedFixtureAgents(seedFixtureFoundation(new MemoryBackend())));
    const before = await backend.store.agents.scan();
    await drain(core(backend).foundation.update({ yes: true }));
    const after = await backend.store.agents.scan();

    const asked = after
      .filter((a) => a.update_request)
      .map((a) => a.name)
      .sort();
    const expected = before
      .filter((a) => (a.status === "ready" || a.status === "degraded") && a.instance_id)
      .map((a) => a.name)
      .sort();
    expect(asked).toEqual(expected);
    expect(asked.length).toBeGreaterThan(0);
    // One request id for the whole rollout: a runner acts once per id (§4.2).
    const ids = new Set(after.flatMap((a) => (a.update_request ? [a.update_request.id] : [])));
    expect(ids.size).toBe(1);
    for (const a of after.filter((x) => x.update_request)) {
      expect(a.update_request!.hermeticd_version).toBe(FIXTURE_HERMETICD_VERSION);
      expect(a.update_request!.issued_by).toBe(FIXTURE_CONFIG.frozen_by);
    }
    // Stopped and error agents are named as deferred rather than written to.
    const deferred = after.filter((a) => !a.update_request && a.status !== "destroyed");
    expect(deferred.length).toBeGreaterThan(0);
  });

  test("with a wait budget, it finishes as soon as every agent reports the new release", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    outdated(backend);
    const ready: Agent = {
      ...(await seedOne(backend, "solo")),
    };
    expect(ready.status).toBe("ready");

    // The box takes the release a moment after being asked, and reports the
    // *digest* it is now running — the manifest's, because that is what it just
    // installed. The version label alone is not a signal: it is the same string
    // before and after, which is why `rollout` no longer looks at it.
    const land = landOn(backend, "solo", 1000);

    const events = await drain(core(backend).foundation.update({ yes: true, rollout_wait_ms: 5_000 }));
    land.stop();
    const rollout = events.filter((e) => e.phase === "rollout");
    expect(rollout.some((e) => e.message.includes("solo is running hermeticd"))).toBe(true);
    expect(rollout.at(-1)).toMatchObject({ kind: "done" });
    expect(rollout.at(-1)!.level).toBeUndefined();
  });

  test("an agent already on the release does not count as landed until it speaks again", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    outdated(backend);
    const stale = await seedOne(backend, "already-there");
    /**
     * The row says the right version *and* carries a heartbeat from before the
     * request — a box that was already on this release and has said nothing
     * since. The old criterion compared the box's `last_heartbeat` against this
     * laptop's `issued_at`, which made the answer a question about clock skew:
     * a box a few seconds ahead looked like it had landed on a heartbeat it
     * sent before it was ever asked.
     */
    backend.agents.set("already-there", {
      ...stale,
      hermeticd_version: FIXTURE_HERMETICD_VERSION,
      last_heartbeat: new Date(backend.now().getTime() + 60_000).toISOString(),
    });

    const events = await drain(core(backend).foundation.update({ yes: true, rollout_wait_ms: 20 }));
    const last = events.filter((e) => e.phase === "rollout").at(-1)!;
    // It is a straggler, correctly: nothing on that box has moved.
    expect(last.level).toBe("warn");
    expect(last.message).toContain("already-there");
  });

  test("a box that reports the new release on a fresh heartbeat lands", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    outdated(backend);
    // Its baseline heartbeat is far in the future relative to the laptop's
    // clock — a badly skewed box, which must still be measured against itself.
    const skewed = await seedOne(backend, "skewed");
    const base = backend.now().getTime() + 3_600_000;
    backend.agents.set("skewed", { ...skewed, last_heartbeat: new Date(base).toISOString() });

    const land = landOn(backend, "skewed", base - backend.now().getTime() + 1000);
    const events = await drain(core(backend).foundation.update({ yes: true, rollout_wait_ms: 5_000 }));
    land.stop();
    const rollout = events.filter((e) => e.phase === "rollout");
    expect(rollout.some((e) => e.message.includes("skewed is running hermeticd"))).toBe(true);
    expect(rollout.at(-1)!.level).toBeUndefined();
  });

  test("a heartbeat without a digest is not a landing", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    outdated(backend);
    await seedOne(backend, "mute");
    /**
     * The regression this whole comparison was rewritten for. The box speaks —
     * a fresh heartbeat carrying the version label — and says nothing about
     * which binary it is running, which is every hermeticd built before
     * `running_hermeticd_sha256` existed.
     *
     * The old criterion was `agent.hermeticd_version !== hermeticdVersion`, and
     * both sides of it were the same hardcoded constant, so this box was
     * declared landed the instant it breathed. It is now reported as what it
     * is: unconfirmable.
     */
    // It keeps heartbeating for the whole wait and never names a digest. The
    // wait is short because the point is what the *deadline* concludes: the
    // loop deliberately keeps watching such a box until then, since a box
    // mid-update reports exactly this until it restarts into the new binary.
    const land = setInterval(() => {
      const row = backend.agents.get("mute");
      if (!row) return;
      backend.agents.set("mute", {
        ...row,
        hermeticd_version: FIXTURE_HERMETICD_VERSION,
        last_heartbeat: new Date(backend.now().getTime() + 1000).toISOString(),
      });
    }, 2);
    const events = await drain(core(backend).foundation.update({ yes: true, rollout_wait_ms: 40 }));
    clearInterval(land);
    const rollout = events.filter((e) => e.phase === "rollout");
    // Never claimed as running the release…
    expect(rollout.some((e) => e.message.includes("mute is running hermeticd"))).toBe(false);
    // …and the phase does not sign off clean.
    const last = rollout.at(-1)!;
    expect(last.level).toBe("warn");
    expect(last.message).toContain("mute");
    expect(last.message).toContain("do not report which binary they are running");
  });

  test("a box that heartbeats before it lands is still waited for", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    outdated(backend);
    await seedOne(backend, "slow");
    /**
     * The real sequence, and the one an earlier version of this loop got wrong.
     * A box takes a minute to download, swap and restart; it goes on
     * heartbeating throughout on its **old** binary, which has no digest to
     * report. Classifying it the moment it first spoke — and dropping it from
     * `pending` — retired it from the very poll that was about to watch it
     * land, so the wait ended early and a rollout that worked was reported as
     * unconfirmable.
     */
    let ticks = 0;
    const timer = setInterval(() => {
      void (async () => {
        const row = backend.agents.get("slow");
        if (!row) return;
        ticks += 1;
        const beat = new Date(backend.now().getTime() + 1000 * ticks).toISOString();
        if (ticks < 3) {
          // Alive, updating, nothing to say about its binary yet.
          backend.agents.set("slow", { ...row, last_heartbeat: beat });
          return;
        }
        const manifest = await readFleetManifest(backend.artifacts).catch(() => null);
        const sha256 = manifest?.hermeticd.files["hermeticd"]?.sha256;
        if (!sha256) return;
        clearInterval(timer);
        backend.agents.set("slow", {
          ...row,
          hermeticd_version: FIXTURE_HERMETICD_VERSION,
          running_hermeticd_sha256: sha256,
          last_heartbeat: beat,
        });
      })();
    }, 3);

    const events = await drain(core(backend).foundation.update({ yes: true, rollout_wait_ms: 5_000 }));
    clearInterval(timer);
    const rollout = events.filter((e) => e.phase === "rollout");
    expect(rollout.some((e) => e.message.includes("slow is running hermeticd"))).toBe(true);
    expect(rollout.at(-1)!.level).toBeUndefined();
  });

  test("a box running a different binary stays a straggler however much it heartbeats", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    outdated(backend);
    await seedOne(backend, "stuck");
    // A real digest, of the release this box is still on — not the one being
    // rolled out. The label matches; the bytes do not, and the bytes decide.
    const land = setInterval(() => {
      const row = backend.agents.get("stuck");
      if (!row) return;
      backend.agents.set("stuck", {
        ...row,
        hermeticd_version: FIXTURE_HERMETICD_VERSION,
        running_hermeticd_sha256: "b".repeat(64),
        last_heartbeat: new Date(backend.now().getTime() + 1000).toISOString(),
      });
    }, 2);
    const events = await drain(core(backend).foundation.update({ yes: true, rollout_wait_ms: 40 }));
    clearInterval(land);
    const last = events.filter((e) => e.phase === "rollout").at(-1)!;
    expect(last.level).toBe("warn");
    expect(last.message).toContain("stuck");
    expect(last.message).toContain("have not reported");
  });

  test("an abort during the rollout wait fails the op instead of reporting success", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    outdated(backend);
    await seedOne(backend, "never-lands");
    const controller = new AbortController();
    const stream = core(backend).foundation.update(
      { yes: true, rollout_wait_ms: 60_000 },
      { signal: controller.signal },
    );

    let code: string | null = null;
    const events: OpEvent[] = [];
    try {
      for await (const e of stream) {
        events.push(e);
        if (e.phase === "rollout" && e.kind === "start") controller.abort();
      }
    } catch (e) {
      code = e instanceof HermeticError ? e.code : String(e);
    }
    /**
     * Falling out of the wait loop on `signal.aborted` used to reach the `done`
     * event and report a rollout that never happened as one that did.
     */
    expect(code).toBe("ABORTED");
    expect(events.some((e) => e.phase === "done")).toBe(false);
    expect(fleetOf(backend).lock).toBeNull();
  });

  test("no target accepting the request is an error-level event, and still not fatal", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    outdated(backend);
    await seedOne(backend, "one");
    await seedOne(backend, "two");
    // Every CAS write refused — a throttled table, permissions that no longer
    // allow it, another tool rewriting rows. One busy row is routine; all of
    // them means nothing was rolled out at all.
    const realUpdate = backend.store.agents.update;
    backend.store.agents.update = async (name, version, patch) => {
      if (patch.update_request) {
        throw new HermeticError("CONFLICT", `${name} moved underneath this operation`, { name });
      }
      return realUpdate.call(backend.store.agents, name, version, patch);
    };

    const events = await drain(core(backend).foundation.update({ yes: true }));
    const failed = events.find((e) => e.level === "error");
    expect(failed).toBeDefined();
    expect(failed!.phase).toBe("rollout");
    expect(failed!.message).toContain("not one of 2 agent(s)");
    expect(failed!.message).toContain("CONFLICT");
    // Non-fatal: the stack and the release are already updated, and the nightly
    // check finishes the job.
    expect(events.at(-1)).toMatchObject({ phase: "done", progress: 1 });
    expect(fleetOf(backend).foundation_version).toBe(FOUNDATION_VERSION);
  });

  test("counts every resource that finished, whichever verb finished it", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    /**
     * An update's change set mixes Add, Modify and Remove, and each lands under
     * its own spelling — `CREATE_COMPLETE`, `UPDATE_COMPLETE`,
     * `DELETE_COMPLETE`. Matching one of them left the progress bar at zero for
     * two thirds of a real update.
     */
    backend.changeSetChanges = [
      { logicalId: "NewThing", resourceType: "AWS::IAM::Role", action: "Add", replacement: null },
      {
        logicalId: "AgentPolicy",
        resourceType: "AWS::IAM::Policy",
        action: "Modify",
        replacement: "False",
      },
      { logicalId: "OldThing", resourceType: "AWS::IAM::Role", action: "Remove", replacement: null },
    ];
    const realExecute = backend.foundation.executeChangeSet;
    backend.foundation.executeChangeSet = async (params) => {
      for (const [logical_id, status] of [
        ["NewThing", "CREATE_COMPLETE"],
        ["AgentPolicy", "UPDATE_COMPLETE"],
        ["OldThing", "DELETE_COMPLETE"],
      ] as const) {
        params.onProgress?.({
          status: "UPDATE_IN_PROGRESS",
          elapsed_ms: 0,
          events_available: true,
          events: [
            {
              event_id: `e-${logical_id}`,
              logical_id,
              resource_type: "AWS::IAM::Role",
              status,
              reason: null,
              at: backend.now().toISOString(),
            },
          ],
        });
      }
      return realExecute.call(backend.foundation, { ...params, onProgress: undefined });
    };

    const events = await drain(core(backend).foundation.update({ yes: true }));
    const counted = events.filter((e) => /\(\d+\/3\)$/.test(e.message)).map((e) => e.message);
    expect(counted).toHaveLength(3);
    expect(counted[0]).toContain("NewThing CREATE_COMPLETE (1/3)");
    expect(counted[1]).toContain("AgentPolicy UPDATE_COMPLETE (2/3)");
    expect(counted[2]).toContain("OldThing DELETE_COMPLETE (3/3)");
  });

  test("a straggler is a warning, not a failure", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    outdated(backend);
    await seedOne(backend, "slowpoke");
    const events = await drain(core(backend).foundation.update({ yes: true, rollout_wait_ms: 20 }));
    const last = events.filter((e) => e.phase === "rollout").at(-1)!;
    expect(last.level).toBe("warn");
    expect(last.message).toContain("slowpoke");
    expect(last.message).toContain("nightly check");
    // Still `ok`: the op finishes, and the fleet is on the new version.
    expect(events.at(-1)).toMatchObject({ phase: "done", progress: 1 });
    expect(fleetOf(backend).foundation_version).toBe(FOUNDATION_VERSION);
  });

  test("a change set with no changes skips the stack update and carries on", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    backend.changeSetStatus = "FAILED";
    backend.changeSetStatusReason =
      "The submitted information didn't contain changes. Submit different information to create a change set.";
    const events = await drain(core(backend).foundation.update({ yes: true }));
    const stack = events.filter((e) => e.phase === "stack");
    expect(stack.map((e) => e.message).join("\n")).toContain("already at this template");
    expect(backend.mutations).not.toContain("foundation.executeChangeSet");
    expect(backend.mutations).toContain("foundation.deleteChangeSet");
    // The rest of the update still runs: the release and the stamp are the point.
    expect(fleetOf(backend).foundation_version).toBe(FOUNDATION_VERSION);
  });

  test("refuses FOUNDATION_UNSAFE when a stateful resource would be replaced", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    backend.changeSetChanges = [
      {
        logicalId: "AgentsTable",
        resourceType: "AWS::DynamoDB::Table",
        action: "Modify",
        replacement: "True",
      },
    ];
    let error: unknown;
    try {
      await drain(core(backend).foundation.update({ yes: true }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HermeticError);
    expect((error as HermeticError).code).toBe("FOUNDATION_UNSAFE");
    expect((error as HermeticError).message).toContain("AgentsTable");
    // The change set is deleted, not left for somebody to find and run.
    expect(backend.changeSets.size).toBe(0);
    expect(backend.mutations).not.toContain("foundation.executeChangeSet");
    // Nothing was stamped, and the lock is free again.
    expect(fleetOf(backend).foundation_version).toBeUndefined();
    expect(fleetOf(backend).lock).toBeNull();
  });

  test("a Conditional replacement of a stateful resource is refused too", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    backend.changeSetChanges = [
      {
        logicalId: "FleetBucket",
        resourceType: "AWS::S3::Bucket",
        action: "Modify",
        // CloudFormation cannot say in advance. "We will find out once the
        // bucket has been thrown away" is not a risk to take on the operator's
        // behalf, so it is refused exactly like `True`.
        replacement: "Conditional",
      },
    ];
    let error: unknown;
    try {
      await drain(core(backend).foundation.update({ yes: true }));
    } catch (e) {
      error = e;
    }
    expect((error as HermeticError).code).toBe("FOUNDATION_UNSAFE");
    expect((error as HermeticError).message).toContain("FleetBucket");
    expect((error as HermeticError).message).toContain("conditionally");
    expect(backend.mutations).not.toContain("foundation.executeChangeSet");
    expect(fleetOf(backend).foundation_version).toBeUndefined();
  });

  test("a replacement of a stateless resource is allowed through", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    backend.changeSetChanges = [
      {
        logicalId: "AgentSecurityGroup",
        resourceType: "AWS::EC2::SecurityGroup",
        action: "Modify",
        replacement: "True",
      },
    ];
    await drain(core(backend).foundation.update({ yes: true }));
    expect(fleetOf(backend).foundation_version).toBe(FOUNDATION_VERSION);
  });

  test("refuses LOCKED while another operator's fleet lock is live", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    backend.fleetItem = {
      ...fleetOf(backend),
      lock: {
        owner: "someone-else",
        expires: new Date(backend.now().getTime() + 60_000).toISOString(),
      },
    };
    expect(await codeOf(() => drain(core(backend).foundation.update({ yes: true })))).toBe("LOCKED");
    // Somebody else's lock is left exactly where it was.
    expect(fleetOf(backend).lock?.owner).toBe("someone-else");
  });

  test("an expired fleet lock is not a lock", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    backend.fleetItem = {
      ...fleetOf(backend),
      lock: { owner: "a-dead-run", expires: new Date(backend.now().getTime() - 1).toISOString() },
    };
    await drain(core(backend).foundation.update({ yes: true }));
    expect(fleetOf(backend).foundation_version).toBe(FOUNDATION_VERSION);
  });

  test("refuses CONFLICT while an agent is locked or mid-transition", async () => {
    const backend = outdated(seedFixtureAgents(seedFixtureFoundation(new MemoryBackend())));
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", {
      ...atlas,
      lock: {
        owner: "another-operator",
        expires: new Date(backend.now().getTime() + 60_000).toISOString(),
      },
    });
    expect(await codeOf(() => drain(core(backend).foundation.update({ yes: true })))).toBe("CONFLICT");
    // Refused before the lock was taken: nothing to clean up.
    expect(fleetOf(backend).lock).toBeUndefined();

    backend.agents.set("atlas", { ...atlas, lock: null, status: "bootstrapping" });
    expect(await codeOf(() => drain(core(backend).foundation.update({ yes: true })))).toBe("CONFLICT");
  });

  /**
   * The TOCTOU the first version had: the agent scan ran *before* the lock was
   * taken, so an `agents.create` could pass `assertFleetUnlocked`, claim a row
   * and start launching a box in the gap — and the update would go on to
   * archive, re-stack and rewrite the release underneath it. The scan is asked
   * again once the door is shut, and a `no` then is a refusal that gives the
   * lock straight back.
   */
  test("an agent that claims a row while the fleet lock is being taken refuses the update", async () => {
    const backend = outdated(seedFixtureAgents(seedFixtureFoundation(new MemoryBackend())));
    const atlas = backend.agents.get("atlas")!;
    const lockFleet = backend.store.fleet.lockFleet;
    backend.store.fleet.lockFleet = async (owner: string, expires: string, now: Date) => {
      // The racing create lands here: after the preflight scan, before the lock
      // this call is taking exists.
      backend.agents.set("atlas", { ...atlas, status: "creating" });
      return lockFleet(owner, expires, now);
    };

    expect(await codeOf(() => drain(core(backend).foundation.update({ yes: true })))).toBe("CONFLICT");
    // The lock is handed straight back: a refusal must not cost the fleet ten
    // minutes of nobody being able to do anything (§4.4).
    expect(fleetOf(backend).lock ?? null).toBeNull();
    // And nothing was touched: no archive, no stack update, no stamp.
    expect(fleetOf(backend).foundation_version).toBeUndefined();
    expect((await backend.artifacts.list("archive/")).length).toBe(0);
  });

  test("refuses FOUNDATION_NEWER when the fleet is ahead of this build", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    backend.fleetItem = { ...fleetOf(backend), foundation_version: FOUNDATION_VERSION + 1 };
    expect(await codeOf(() => drain(core(backend).foundation.update({ yes: true })))).toBe(
      "FOUNDATION_NEWER",
    );
  });

  test("a failure mid-op leaves the fleet unstamped and the lock released", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    backend.changeSetStatus = "FAILED";
    backend.changeSetStatusReason = "the template is not valid JSON";
    expect(await codeOf(() => drain(core(backend).foundation.update({ yes: true })))).toBe(
      "FOUNDATION_UPDATE_FAILED",
    );
    const fleet = fleetOf(backend);
    expect(fleet.foundation_version).toBeUndefined();
    expect(fleet.min_hermetic_version).toBe("0.4.0");
    expect(fleet.lock).toBeNull();
    // Re-runnable: the status still says an update is available.
    expect((await core(backend).foundation.status()).update_available).toBe(true);
  });

  test("an abort stops the op and still releases the fleet lock", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    const controller = new AbortController();
    const stream = core(backend).foundation.update({ yes: true }, { signal: controller.signal });
    let code: string | null = null;
    try {
      for await (const e of stream) {
        if (e.phase === "preflight" && e.kind === "done") controller.abort();
      }
    } catch (e) {
      code = e instanceof HermeticError ? e.code : String(e);
    }
    expect(code).toBe("ABORTED");
    expect(fleetOf(backend).lock).toBeNull();
    expect(fleetOf(backend).foundation_version).toBeUndefined();
  });

  test("apply of a foundation plan runs the same op", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    const hermetic = core(backend);
    const plan = await hermetic.plan.foundation();
    const events = await drain(hermetic.apply({ plan, yes: true }));
    expect(phases(events).at(-1)).toBe("done");
    expect(fleetOf(backend).foundation_version).toBe(FOUNDATION_VERSION);
  });

  test("apply refuses a foundation plan the head did not confirm", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    const hermetic = core(backend);
    const plan = await hermetic.plan.foundation();
    expect(await codeOf(() => drain(hermetic.apply({ plan, yes: false })))).toBe(
      "CONFIRMATION_REQUIRED",
    );
  });
});

/**
 * The parts that need `createFoundation` directly rather than through
 * `createHermetic`: the fleet lock's TTL is `LOCK_TTL_MS` there (ten minutes),
 * and a test that waits one of those is a test that times out.
 */
describe("the fleet lock is kept alive through the long phases", () => {
  function directDeps(backend: MemoryBackend, over: Partial<FoundationDeps> = {}): FoundationDeps {
    return {
      ctx: testContext(backend, {
        guardAccount: async () => {},
        guardFleet: async () => ({
          config: FIXTURE_CONFIG,
          fleet: backend.fleetItem!,
          stack: backend.stack!,
        }),
        actor: async () => FIXTURE_CONFIG.frozen_by,
        appendEvent: async () => {},
        nowIso: () => backend.now().toISOString(),
      }),
      hermesFetch: OFFLINE_HERMES_RELEASE,
      // 30ms, so "a third of its life" is 10ms and a phase can outlive it.
      lockTtlMs: 30,
      changeSetPollMs: 0,
      rolloutPollMs: 1,
      heartbeatMs: 5,
      ...over,
    };
  }

  test("a stack update longer than the lock's TTL renews it as it goes", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    /**
     * A stack update that takes 120ms *on the fleet's clock* — four times the
     * 30ms TTL above. The clock is advanced explicitly rather than left to the
     * real waits below, because the keeper ages the lock on the backend's clock
     * (the one that stamps the expiry it renews) and the memory backend's is
     * held still; the real waits are only there to let the narration loop run.
     */
    let inStack = false;
    const realExecute = backend.foundation.executeChangeSet;
    backend.foundation.executeChangeSet = async (params) => {
      inStack = true;
      for (let i = 0; i < 12; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
        backend.advance(10);
        params.onProgress?.({
          status: "UPDATE_IN_PROGRESS",
          elapsed_ms: i * 10,
          events_available: true,
          events: [],
        });
      }
      const out = await realExecute.call(backend.foundation, params);
      inStack = false;
      return out;
    };

    // `renewFleetLock`, not `lockFleet`: a renew requires the lock to already be
    // ours and still live, so that a run whose TTL lapsed inside a long phase
    // cannot quietly take it back (§4.4).
    let renewedDuringStack = 0;
    const realRenew = backend.store.fleet.renewFleetLock;
    backend.store.fleet.renewFleetLock = async (owner, expires, at) => {
      if (inStack) renewedDuringStack += 1;
      return realRenew.call(backend.store.fleet, owner, expires, at);
    };

    await drain(createFoundation(directDeps(backend)).update({ yes: true }));

    /**
     * The defect: the lock was renewed only *between* phases, so a stack update
     * (or a large archive, or a slow push) that outlasts the TTL left the lock
     * this run believes it holds free for anyone else to take mid-flight. It is
     * a 120ms wait against a 30ms TTL, so the keeper's third-of-TTL rule should
     * fire several times inside the phase and never once before this fix.
     */
    expect(renewedDuringStack).toBeGreaterThan(2);
    // And it still finished, and still released.
    expect(fleetOf(backend).foundation_version).toBe(FOUNDATION_VERSION);
    expect(fleetOf(backend).lock).toBeNull();
  });

  test("losing the lock at the commit point fails the op instead of silently not stamping", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    /**
     * The lock expired mid-phase and somebody else took it. `replaceFleet`
     * answers `null`; ignoring that made the *commit point* a no-op — the stack
     * and the release were updated, `_fleet` was not stamped, and the op still
     * reported `done`, so the fleet looked updated and said "update available"
     * forever.
     */
    const realReplace = backend.store.fleet.replaceFleet;
    backend.store.fleet.replaceFleet = async (item, owner, at, expect) => {
      if (item.foundation_version === undefined) {
        return realReplace.call(backend.store.fleet, item, owner, at, expect);
      }
      backend.fleetItem = {
        ...backend.fleetItem!,
        lock: { owner: "a-thief", expires: new Date(backend.now().getTime() + 60_000).toISOString() },
      };
      return null;
    };

    expect(await codeOf(() => drain(createFoundation(directDeps(backend)).update({ yes: true })))).toBe(
      "LOCKED",
    );
    expect(fleetOf(backend).foundation_version).toBeUndefined();
  });

  /**
   * The ordinary interleave, and the one an operator should actually meet: a
   * `settings.set` fired while an update is running is refused by the lock,
   * cheaply, before it has written anything. The update finishes and stamps.
   */
  test("a settings write fired mid-update is refused, and the update still stamps", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    const hermetic = core(backend);
    const before = fleetOf(backend).settings!.version;

    // Collected rather than assigned to a `let`: the write happens inside a
    // callback, and a narrowed `string | null` read back outside it is `null`
    // as far as the compiler is concerned.
    const refused: (string | null)[] = [];
    const realLock = backend.store.fleet.lockFleet;
    backend.store.fleet.lockFleet = async (owner, expires, at) => {
      const took = await realLock.call(backend.store.fleet, owner, expires, at);
      // The instant the door is shut, and only then: a `settings.set` before
      // the take would legitimately win, and a test that raced it would flake.
      if (took && refused.length === 0) {
        refused.push(await codeOf(() => hermetic.settings.set({ defaults: { size: "large" } })));
      }
      return took;
    };

    await drain(hermetic.foundation.update({ yes: true }));
    expect(refused).toEqual(["LOCKED"]);
    // Refused before it wrote: the settings record is exactly where it was.
    expect(fleetOf(backend).settings!.version).toBe(before);
    expect(fleetOf(backend).foundation_version).toBe(FOUNDATION_VERSION);
    expect(fleetOf(backend).lock).toBeNull();
  });

  /**
   * The interleave the whole-item stamp used to lose silently: the update's
   * lock lapses mid-phase, a `settings.set` lands in the gap, and the stamp
   * then writes back the copy this run has been carrying since before the
   * settings existed — reverting them, with the op reporting `done`.
   *
   * The stamp now states the `settings.version` it was composed against, so a
   * settings record that moved refuses it. `CONFLICT`, not `LOCKED`: nobody
   * holds the lock, the row simply is not the one this run read.
   */
  test("a settings write that lands while the lock has lapsed refuses the stamp rather than being reverted", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    const hermetic = core(backend);

    let landed = false;
    const realReplace = backend.store.fleet.replaceFleet;
    backend.store.fleet.replaceFleet = async (item, owner, at, expectation) => {
      // Only the stamp: `item.foundation_version` is set by nothing else.
      if (item.foundation_version !== undefined && !landed) {
        landed = true;
        // The lock lapsed while the stack was updating, and somebody's settings
        // write got in — through the same door `settings.set` uses, which is
        // free the moment no lock is live.
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
      return realReplace.call(backend.store.fleet, item, owner, at, expectation);
    };

    const before = fleetOf(backend).settings!.version;
    expect(await codeOf(() => drain(hermetic.foundation.update({ yes: true })))).toBe("CONFLICT");
    // The whole point: their write is still there, and the stamp did not land.
    expect(fleetOf(backend).settings!.version).toBe(before + 1);
    expect(fleetOf(backend).settings!.updated_by).toBe("somebody-else");
    expect(fleetOf(backend).foundation_version).toBeUndefined();
  });

  test("a change set CloudFormation never finishes computing is bounded, not a hang", async () => {
    const backend = outdated(seedFixtureFoundation(new MemoryBackend()));
    backend.changeSetStatus = "CREATE_IN_PROGRESS";
    const code = await codeOf(() =>
      drain(
        createFoundation(directDeps(backend, { changeSetTimeoutMs: 20, changeSetPollMs: 1 })).update({
          yes: true,
        }),
      ),
    );
    expect(code).toBe("FOUNDATION_UPDATE_FAILED");
    expect(fleetOf(backend).lock).toBeNull();
  });
});

describe("doctor and init", () => {
  test("doctor reports an outdated foundation as a field, and never as a finding", async () => {
    /**
     * §4.8: a registered fleet whose directory entry agrees with `_fleet`. The
     * directory disagreeing is its own finding, and this test is about the
     * *foundation* field, so the two are kept apart.
     */
    const backend = outdated(seedFixtureFoundation(new MemoryBackend({ directory: "seeded" })));
    const entry = await backend.directory.get(FIXTURE_CONFIG.fleet_id);
    if (!entry) throw new Error("unreachable: the fixture directory seeds main");
    await backend.directory.update({ ...entry, foundation_version: 0 });
    const report = await core(backend).doctor();
    expect(report.foundation.outdated).toBe(true);
    expect(report.foundation.version).toBe(0);
    expect(report.foundation.available_version).toBe(FOUNDATION_VERSION);
    /**
     * `ok` is derived from `findings`, and an available update is an offer, not
     * a fault: putting it in the list would make every fleet permanently
     * un-`ok` the moment a new hermetic shipped, which is the fastest way to
     * teach an operator to ignore `doctor`.
     */
    expect(report.findings.join(" ")).not.toContain("foundation");
    expect(report.ok).toBe(true);

    // A fleet on this build's contract, with a directory that says the same.
    const fresh = await core(
      seedFixtureFoundation(new MemoryBackend({ directory: "seeded" })),
    ).doctor();
    expect(fresh.foundation.outdated).toBe(false);
    expect(fresh.ok).toBe(true);
  });

  test("`init --create` stamps the foundation version, the digest, and the manifest", async () => {
    const backend = new MemoryBackend();
    const hermetic = testHermetic({ backend, config: null });
    await drain(
      hermetic.init({
        create: true,
        profile: FIXTURE_CONFIG.profile,
        region: FIXTURE_CONFIG.region,
        confirm_account_id: FIXTURE_CONFIG.account_id,
        tailnet: "acme.ts.net",
      }),
    );
    const fleet = backend.fleetItem!;
    expect(fleet.foundation_version).toBe(FOUNDATION_VERSION);
    expect(fleet.foundation_template_sha256).toBe(foundationTemplateSha256());
    expect((await readFleetManifest(backend.artifacts))!.foundation).toMatchObject({
      version: FOUNDATION_VERSION,
      template_sha256: foundationTemplateSha256(),
    });
  });

  test("`init --attach` refuses FOUNDATION_NEWER when the fleet is ahead of this build", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    backend.fleetItem = { ...fleetOf(backend), foundation_version: FOUNDATION_VERSION + 1 };
    const hermetic = testHermetic({ backend, config: null });
    expect(
      await codeOf(() => drain(hermetic.init({ attach: true, profile: FIXTURE_CONFIG.profile }))),
    ).toBe("FOUNDATION_NEWER");
  });
});

describe("the fleet lock blocks agent operations", () => {
  test("an agent operation refuses with LOCKED while `_fleet.lock` is live", async () => {
    const backend = seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
    backend.fleetItem = {
      ...fleetOf(backend),
      lock: {
        owner: "a-foundation-update",
        expires: new Date(backend.now().getTime() + 60_000).toISOString(),
      },
    };
    const hermetic = createHermetic({ backend, config: FIXTURE_CONFIG, fixture: true });
    expect(await codeOf(() => drain(hermetic.agents.stop("atlas")))).toBe("LOCKED");
  });
});

/** One `ready` agent with an instance, so a rollout has exactly one target. */
async function seedOne(backend: MemoryBackend, name: string): Promise<Agent> {
  const at = backend.now().toISOString();
  const agent: Agent = {
    name,
    status: "ready",
    version: 1,
    lock: null,
    size: "medium",
    instance_type: "m7g.large",
    region: FIXTURE_CONFIG.region,
    instance_id: `i-${name}`,
    volume_id: `vol-${name}`,
    volume_gib: 100,
    hermes_version: "0.15.0",
    hermeticd_version: "0.4.0",
    config_hash: null,
    bootstrap: null,
    command: null,
    update_request: null,
    provider: "bedrock",
    secrets_mode: "none",
    tailscale_ip: "100.64.0.9",
    resources: { ssm_paths: [] },
    last_heartbeat: at,
    health: null,
    metrics: null,
    created_by: FIXTURE_CONFIG.frozen_by,
    created_at: at,
    updated_at: at,
  };
  backend.agents.set(name, agent);
  return agent;
}
