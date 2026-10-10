import { describe, expect, test } from "bun:test";
import { HermeticError } from "../src/errors.ts";
import {
  FIXTURE_CONFIG,
  fixtureConfigFor,
  FIXTURE_PROFILE_IDS,
  FIXTURE_PROFILE_KEY,
  MemoryBackend,
  seedFixtureFoundation,
} from "../src/backend/memory.ts";
import { BROWSER_FOUNDATION_VERSION, FLEET_MANIFEST_KEY } from "../src/schema/index.ts";
import type { Agent, AgentEvent, OpEvent } from "../src/schema/index.ts";
import type { AgentPatch } from "../src/backend/types.ts";
import { drain, freshFleet, testHermetic } from "./helpers.ts";

describe("agents.create", () => {
  test("provisions everything and hands off to the instance", async () => {
    const { backend, hermetic } = freshFleet();
    const events = await drain(hermetic.agents.create({ name: "atlas" }));

    expect(events.at(-1)?.progress).toBe(1);
    expect(events.map((e) => e.phase)).toEqual([
      "validate",
      "secrets",
      // Two: the tailnet auth key, and the provider credential this agent's
      // profile was snapshotted from. The fixture fleet's default profile is
      // `anthropic-main`, which is key-authenticated (§8.3).
      "secrets",
      "render",
      "volume",
      "instance", // start: launching
      "instance", // done: recorded on the row
      "instance", // start: attaching data volume
      "instance", // done: attached
      "instance", // done: handed off
      // No `handoff` rail here: `testHermetic` leaves the post-handoff watch's
      // budget at zero, so the create ends the moment the row is unlocked. The
      // watch has its own test (`handoff.test.ts`).
      "done",
    ]);

    const agent = await backend.store.agents.get("atlas");
    expect(agent).not.toBeNull();
    // The handoff state: every resource recorded, the lock released, and the
    // instance now responsible for reporting status (§6.2 step 8).
    expect(agent!.lock).toBeNull();
    expect(agent!.status).toBe("creating");
    expect(agent!.resources.instance_id).toBeString();
    expect(agent!.resources.volume_id).toBeString();
    expect(agent!.resources.config_key).toStartWith("config/atlas/");
    expect(agent!.resources.ssm_paths).toEqual([
      "/hermes/fxtr0001/atlas/ts-key",
      // §8.3: the instance slot named for the profile revision this agent was
      // bound at, not the one fixed slot every agent used to share.
      "/hermes/fxtr0001/atlas/provider-key-ant00001-r1",
    ]);
    expect(agent!.config_hash).toBeString();
    expect(agent!.instance_type).toBe("t4g.2xlarge");
    expect(agent!.volume_gib).toBe(100);

    // The tailscale key landed in its slot, not in an event.
    expect(await backend.secrets.isPlaceholder("/hermes/fxtr0001/atlas/ts-key")).toBe(false);
    expect(await backend.artifacts.exists(agent!.resources.config_key!)).toBe(true);

    const history = await backend.store.events.query("atlas");
    expect(history.map((e) => e.action)).toContain("create");
    expect(history.map((e) => e.action)).toContain("handoff");
    for (const e of history) {
      expect(e.actor).toBe(FIXTURE_CONFIG.frozen_by);
    }
  });

  test("fleet defaults fill in every omitted flag", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "ibis" }));
    const agent = (await backend.store.agents.get("ibis"))!;
    expect(agent.size).toBe("medium");
    // §8.3: the provider comes from the fleet's *default profile*, not from
    // `settings.defaults.provider` — a profile is what carries a credential,
    // and a bare provider name does not.
    expect(agent.provider).toBe("anthropic");
    expect(agent.profile_id).toBe(FIXTURE_PROFILE_IDS.anthropic);
    expect(agent.profile_revision).toBe(1);
    expect(agent.credential_ref).toBe("provider-key-ant00001-r1");
    expect(agent.secrets_mode).toBe("none");
  });

  test("explicit flags win over fleet defaults", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(
      hermetic.agents.create({
        name: "fathom",
        size: "small",
        provider: "anthropic",
        secrets: "bitwarden",
        volume_gib: 250,
      }),
    );
    const agent = (await backend.store.agents.get("fathom"))!;
    expect(agent).toMatchObject({
      size: "small",
      instance_type: "r8g.large",
      provider: "anthropic",
      secrets_mode: "bitwarden",
      volume_gib: 250,
    });
    // One slot per thing the box actually needs (§8.1): the auth key always,
    // the provider key because anthropic is key-authenticated, the bws token
    // because Bitwarden was asked for.
    expect(agent.resources.ssm_paths).toEqual([
      "/hermes/fxtr0001/fathom/ts-key",
      "/hermes/fxtr0001/fathom/provider-key-ant00001-r1",
      "/hermes/fxtr0001/fathom/bws-token",
    ]);
  });

  test("a GPU profile launches its G5g instance type", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "tesla", size: "gpu-medium" }));

    const agent = (await backend.store.agents.get("tesla"))!;
    expect(agent).toMatchObject({ size: "gpu-medium", instance_type: "g5g.4xlarge" });
  });

  /**
   * §8.3: a create never carries a credential. A key that arrived on the
   * request would belong to nothing — no profile owns it, no rotation reaches
   * it — so it is refused, with the command that stores one, before the name is
   * taken.
   */
  test("a key on the request is refused, and says where keys live", async () => {
    const { backend, hermetic } = freshFleet();
    let error: HermeticError | null = null;
    try {
      await drain(
        hermetic.agents.create({
          name: "vireo",
          provider: "openrouter",
          api_key: "sk-or-v1-FIXTURE-PROVIDER-KEY",
        }),
      );
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("VALIDATION");
    expect(error?.message).toInclude("keys live on provider profiles");
    expect(error?.message).toInclude("hermetic providers create");
    // Refused before anything was claimed, and the key is in no error detail.
    expect(await backend.store.agents.get("vireo")).toBeNull();
    expect(JSON.stringify(error)).not.toInclude("sk-or-v1-FIXTURE-PROVIDER-KEY");
  });

  /**
   * §8.3: the profile's slot is empty, so binding to it would produce an agent
   * that boots and cannot start Hermes. The fixture's `nous-lab` profile is the
   * one still holding the placeholder.
   */
  test("a profile with no key stored refuses the create rather than half-making it", async () => {
    const { backend, hermetic } = freshFleet();
    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "wren", provider_profile: "nous-lab" }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("VALIDATION");
    expect(error?.message).toInclude("nous-lab has no key stored");
    expect(error?.message).toInclude("--api-key-stdin");
    // …and refused before it took the name.
    expect(await backend.store.agents.get("wren")).toBeNull();
  });

  /**
   * §8.3: the profile holds the key, so nobody types it again. The copy happens
   * here, on the laptop, into the agent's *own* slot for the revision it was
   * bound at — no instance role can read `/hermetic/*`, so this is the only way
   * the value reaches a box, and the fan-out stays one copy per agent.
   */
  test("a profile's key is copied into the agent's own revision slot", async () => {
    const { backend, hermetic } = freshFleet();
    const events = await drain(
      hermetic.agents.create({ name: "kite", provider_profile: "openrouter-cheap" }),
    );

    const agent = (await backend.store.agents.get("kite"))!;
    expect(agent.provider).toBe("openrouter");
    expect(agent.profile_id).toBe(FIXTURE_PROFILE_IDS.openrouter);
    expect(agent.credential_ref).toBe("provider-key-rtr00002-r1");
    expect(backend.params.get("/hermes/fxtr0001/kite/provider-key-rtr00002-r1")).toBe(
      FIXTURE_PROFILE_KEY,
    );
    expect(events.some((e) => e.level === "warn")).toBe(false);

    // The profile is named, the value never is — in the stream or the history.
    const stream = JSON.stringify(events);
    expect(stream).toInclude("copied from provider profile openrouter-cheap");
    expect(stream).not.toInclude(FIXTURE_PROFILE_KEY);
    const history = await backend.store.events.query("kite");
    expect(history.map((e) => e.detail)).toContain(
      `provider-key-rtr00002-r1 from profile ${FIXTURE_PROFILE_IDS.openrouter} r1`,
    );
    expect(JSON.stringify(history)).not.toInclude(FIXTURE_PROFILE_KEY);
  });

  /** A profile the fleet has turned off is not one a new agent may be built on. */
  test("a disabled profile is refused by name", async () => {
    const { hermetic } = freshFleet();
    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "petrel", provider_profile: "vercel-gw" }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("VALIDATION");
    expect(error?.message).toInclude("vercel-gw is disabled");
  });

  /**
   * §8.3: two profiles on one provider, and a bare `--provider` that cannot
   * choose between them. hermetic does not pick a credential on an operator's
   * behalf; it lists the candidates and refuses.
   */
  test("a bare provider naming two profiles is AMBIGUOUS_PROFILE", async () => {
    const { hermetic } = freshFleet();
    await hermetic.providers.create({
      provider: "openrouter",
      name: "openrouter-spare",
      api_key: "sk-or-v1-FIXTURE-SECOND",
    });
    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "petrel", provider: "openrouter" }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("AMBIGUOUS_PROFILE");
    expect(error?.message).toInclude("openrouter-cheap");
    expect(error?.message).toInclude("openrouter-spare");
  });

  /** Two answers to one question; picking either would be a guess. */
  test("--provider together with --provider-profile is refused", async () => {
    const { hermetic } = freshFleet();
    let error: HermeticError | null = null;
    try {
      await drain(
        hermetic.agents.create({
          name: "petrel",
          provider: "openrouter",
          provider_profile: "anthropic-main",
        }),
      );
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("VALIDATION");
    expect(error?.message).toInclude("pass one");
  });

  /**
   * §5.1: the fleet's role may invoke exactly the model ARNs its foundation was
   * given, so a Bedrock model outside that set is refused — and never quietly
   * swapped for one that is.
   */
  test("a Bedrock model the fleet's role may not invoke is MODEL_NOT_GRANTED", async () => {
    const { backend, hermetic } = freshFleet();
    await hermetic.providers.update({ profile: "bedrock-role", model: "zai.glm-9-ungranted" });
    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "petrel", provider_profile: "bedrock-role" }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("MODEL_NOT_GRANTED");
    expect(error?.message).toInclude("foundation update");
    expect(await backend.store.agents.get("petrel")).toBeNull();
  });

  /**
   * §7.3: foundation v14 is what grants the box read on the mirrored browser,
   * so a create on a fleet that has not been updated is refused on the laptop —
   * not left to fail as a 403 in a bootstrap stage, eight minutes into a first
   * boot nobody is watching. The fleet is seeded at `BROWSER_FOUNDATION_VERSION
   * - 1` explicitly: the gate is pinned at the version that introduced it, so
   * "one foundation behind" stops meaning "below the gate" as soon as an
   * unrelated bump moves `FOUNDATION_VERSION` past it.
   *
   * It applies to **every** create now. There is no `--no-browser` to get past
   * it with, because there is no agent without a browser: a fleet below v14 can
   * make nothing at all until it is updated.
   */
  test("any agent on a fleet below v14 is BROWSER_NEEDS_FOUNDATION_UPDATE", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend(), {
      fleet: "staging",
      foundationVersion: BROWSER_FOUNDATION_VERSION - 1,
    });
    const hermetic = testHermetic({ backend, config: fixtureConfigFor("staging") });
    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "petrel" }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("BROWSER_NEEDS_FOUNDATION_UPDATE");
    expect(error?.message).toInclude("hermetic foundation update");
    // Refused before the name was claimed: nothing to clean up.
    expect(await backend.store.agents.get("petrel")).toBeNull();
  });

  test("an agent on the current foundation is created normally", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "petrel" }));
    expect(await backend.store.agents.get("petrel")).not.toBeNull();
  });

  /**
   * The drawer that offered a profile read the fleet seconds ago. Core asks
   * again at the moment it writes, because a profile can be disabled — or have
   * its slot emptied — in between.
   */
  test("readiness is re-checked at submit, not trusted from the listing", async () => {
    const { backend, hermetic } = freshFleet();
    const listed = await hermetic.providers.list({});
    expect(listed.profiles.find((p) => p.name === "openrouter-cheap")?.ready).toBe(true);

    await hermetic.providers.update({ profile: "openrouter-cheap", enabled: false });

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "petrel", provider_profile: "openrouter-cheap" }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("VALIDATION");
    expect(await backend.store.agents.get("petrel")).toBeNull();
  });

  /**
   * §4.6: the fleet's answers are pinned on the row at create, not re-read at
   * render time. A later `providers set --model` must not move an existing
   * agent's `config_hash` — which is what would report the whole fleet as
   * drifted from one settings write.
   */
  /**
   * §8.3: the profile's model is *managed* on a profile-bound agent — a profile
   * exists to answer "which model does this credential run", and an agent that
   * could drift off it on the box would make the answer a suggestion. The seed
   * still records what the fleet said, and is still pinned at create so a later
   * settings write cannot move an existing row's `config_hash` (§4.6).
   */
  test("the profile's model is managed on the row, and the fleet's is still seeded", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "kite", provider_profile: "openrouter-cheap" }));

    const agent = (await backend.store.agents.get("kite"))!;
    expect(agent.hermes).toEqual({ model: "deepseek/deepseek-v4.1-flash" });
    // The seed is still the fleet's answer for this provider, resolved at
    // create and pinned on the row (§4.6) — it happens to agree here, and it is
    // a different fact from the managed model above.
    expect(agent.seed).toEqual({ model: "deepseek/deepseek-v4.1-flash" });

    const before = agent.config_hash;
    await hermetic.providers.update({ profile: "openrouter-cheap", model: "moved-model" });
    await drain(hermetic.agents.create({ name: "tern", provider_profile: "openrouter-cheap" }));
    // The new agent takes the profile's new model; the existing row renders
    // what it was bound to, so its hash has not moved — the profile edit is a
    // change an operator applies, not one that happens.
    expect((await backend.store.agents.get("tern"))!.hermes).toEqual({ model: "moved-model" });
    expect((await backend.store.agents.get("kite"))!.config_hash).toBe(before);
  });

  test("a stated model wins over the profile's, and the fleet's is still seeded", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(
      hermetic.agents.create({
        name: "kite",
        provider_profile: "openrouter-cheap",
        hermes: { model: "stated-model" },
      }),
    );
    const agent = (await backend.store.agents.get("kite"))!;
    expect(agent.hermes).toEqual({ model: "stated-model" });
    // The seed still records what the fleet said; `splitHermesSettings` is what
    // keeps it out of the rendered files while the operator states one.
    expect(agent.seed).toEqual({ model: "deepseek/deepseek-v4.1-flash" });
  });

  /**
   * §4.5: a half-built agent is always finishable. Disabling a provider stops
   * *new* agents being made with it — it must not strand one that already
   * exists in `creating`, which would leave a row nobody can resume and only
   * `destroy` can clear.
   */
  test("a disabled profile refuses a new agent but still resumes a half-built one", async () => {
    const { backend, hermetic } = freshFleet();
    const controller = new AbortController();

    await expect(
      (async () => {
        for await (const e of hermetic.agents.create(
          { name: "granite", provider_profile: "openrouter-cheap" },
          { signal: controller.signal },
        )) {
          if (e.phase === "volume") controller.abort();
        }
      })(),
    ).rejects.toThrow(HermeticError);
    expect((await backend.store.agents.get("granite"))!.status).toBe("creating");

    // The profile is turned off between the two runs.
    await hermetic.providers.update({ profile: "openrouter-cheap", enabled: false });

    // A new agent on that profile is refused, and named.
    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "basalt", provider_profile: "openrouter-cheap" }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("VALIDATION");
    expect(error?.message).toInclude("openrouter-cheap is disabled");
    // …and refused before it took the name.
    expect(await backend.store.agents.get("basalt")).toBeNull();

    // The half-built one finishes — re-run as the operator typed it, naming the
    // profile that has since been turned off (§4.5).
    const events = await drain(
      hermetic.agents.create({ name: "granite", provider_profile: "openrouter-cheap" }),
    );
    expect(events[1]?.phase).toBe("resume");
    expect((await backend.store.agents.get("granite"))!.resources.instance_id).toBeString();
  });

  test("a role-authenticated profile gets no provider-key slot at all", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "ibis", provider_profile: "bedrock-role" }));
    const agent = (await backend.store.agents.get("ibis"))!;
    expect(agent.resources.ssm_paths).toEqual(["/hermes/fxtr0001/ibis/ts-key"]);
    expect(agent.credential_ref).toBeUndefined();
  });

  test("an invalid name is rejected before anything is created", async () => {
    const { backend, hermetic } = freshFleet();
    await expect(drain(hermetic.agents.create({ name: "Atlas" as string }))).rejects.toThrow(
      HermeticError,
    );
    expect(backend.mutations).toEqual([]);
  });

  test("a second run makes zero mutating calls", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "atlas" }));
    expect(backend.mutations.length).toBeGreaterThan(0);

    backend.resetMutations();
    const events = await drain(hermetic.agents.create({ name: "atlas" }));

    expect(backend.mutations).toEqual([]);
    expect(events.at(-1)?.message).toContain("already exists");
  });

  test("a create interrupted before handoff is resumed, not duplicated", async () => {
    const { backend, hermetic } = freshFleet();
    const controller = new AbortController();

    // Abort as soon as the volume exists but the instance does not.
    await expect(
      (async () => {
        for await (const e of hermetic.agents.create(
          { name: "granite" },
          { signal: controller.signal },
        )) {
          if (e.phase === "volume") controller.abort();
        }
      })(),
    ).rejects.toThrow(HermeticError);

    const partial = (await backend.store.agents.get("granite"))!;
    expect(partial.status).toBe("creating");
    expect(partial.lock).toBeNull();
    expect(partial.resources.instance_id).toBeUndefined();

    backend.resetMutations();
    const events = await drain(hermetic.agents.create({ name: "granite" }));
    expect(events[1]?.phase).toBe("resume");

    const finished = (await backend.store.agents.get("granite"))!;
    expect(finished.resources.instance_id).toBeString();
    // Only one data volume was ever created, because step 6 checks reality first.
    // (Launching also produces a disposable root volume; that is not the disk
    // anything looks up.)
    expect(backend.mutations.filter((m) => m === "compute.createVolume")).toEqual([]);
    expect(
      [...backend.volumes.values()].filter((v) => v.agent === "granite" && v.role === "data"),
    ).toHaveLength(1);
  });

  test("abort mid-way yields ABORTED and releases the lock", async () => {
    const { backend, hermetic } = freshFleet();
    const controller = new AbortController();

    let code: string | null = null;
    try {
      for await (const e of hermetic.agents.create({ name: "heron" }, { signal: controller.signal })) {
        if (e.phase === "secrets") controller.abort();
      }
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("ABORTED");

    const agent = (await backend.store.agents.get("heron"))!;
    expect(agent.lock).toBeNull();
    expect(agent.resources.instance_id).toBeUndefined();
    expect([...backend.instances.values()]).toHaveLength(0);
  });

  test("resources are persisted after the volume step, before the instance exists", async () => {
    const { backend, hermetic } = freshFleet();
    const controller = new AbortController();

    await expect(
      (async () => {
        for await (const e of hermetic.agents.create(
          { name: "basalt" },
          { signal: controller.signal },
        )) {
          if (e.phase === "volume") controller.abort();
        }
      })(),
    ).rejects.toThrow(HermeticError);

    const partial = (await backend.store.agents.get("basalt"))!;
    expect(partial.resources.volume_id).toBeString();
    expect(partial.volume_id).toBeString();
    expect(partial.resources.instance_id).toBeUndefined();
  });

  test("a crash right after the instance step leaves resources describing what exists, even though handoff never happened", async () => {
    const { backend, hermetic } = freshFleet();
    const controller = new AbortController();

    await expect(
      (async () => {
        for await (const e of hermetic.agents.create(
          { name: "quartz" },
          { signal: controller.signal },
        )) {
          if (e.phase === "instance") controller.abort();
        }
      })(),
    ).rejects.toThrow(HermeticError);

    const partial = (await backend.store.agents.get("quartz"))!;
    expect(partial.resources.instance_id).toBeString();
    expect(partial.resources.volume_id).toBeString();
    expect(partial.instance_id).toBeString();
    // The config object was uploaded before the instance was launched, so the
    // row names it here too: an object in the bucket that no row points at is
    // exactly the orphan §4.5 is for.
    expect(partial.resources.config_key).toStartWith("config/quartz/");
    expect(partial.config_hash).toBeString();
    // The row is still not handed off, and `ssm_paths` is what says so: it is
    // written by the handoff itself, so a resume can tell this row from a
    // finished one (`isHandedOff`).
    expect(partial.resources.ssm_paths).toEqual([]);
  });

  test("a failed volume attach still records the instance id that already exists in AWS", async () => {
    const { backend, hermetic } = freshFleet();
    const realAttach = backend.compute.attachVolume;
    backend.compute.attachVolume = async () => {
      // No `aws_error` detail, so `attach.ts` treats it as a real answer and
      // gives up rather than retrying it forever.
      throw new HermeticError("INTERNAL", "AttachVolume failed", {});
    };

    await expect(drain(hermetic.agents.create({ name: "cougar" }))).rejects.toThrow(HermeticError);

    const row = (await backend.store.agents.get("cougar"))!;
    expect(row.instance_id).toBeString();
    expect(row.resources.instance_id).toBe(row.instance_id ?? undefined);
    expect([...backend.instances.values()]).toHaveLength(1);

    // Resume finds the live tagged instance, does not launch another, and
    // retries attach against a working implementation.
    backend.compute.attachVolume = realAttach;

    backend.resetMutations();
    const events = await drain(hermetic.agents.create({ name: "cougar" }));
    expect(events.some((e) => e.message.includes("found live instance"))).toBe(true);
    expect(backend.mutations.filter((m) => m === "compute.runInstance")).toEqual([]);
    const finished = (await backend.store.agents.get("cougar"))!;
    expect(finished.resources.instance_id).toBe(row.instance_id ?? undefined);
    expect(finished.resources.config_key).toBeString();
  });

  /**
   * The tag query is an index, and DynamoDB is not the only eventually
   * consistent thing here: `DescribeInstances` with a tag filter can answer
   * about a box that `RunInstances` created seconds ago by not mentioning it.
   * A resume that read that silence as "there is nothing there" launched a
   * second instance and overwrote `instance_id` with it — and the first one
   * billed forever, because nothing named it any more.
   */
  test("a resume whose tag query lags asks about the recorded instance instead of launching another", async () => {
    const { backend, hermetic } = freshFleet();
    const realAttach = backend.compute.attachVolume;
    backend.compute.attachVolume = async () => {
      throw new HermeticError("INTERNAL", "AttachVolume failed", {});
    };
    await expect(drain(hermetic.agents.create({ name: "cinnabar" }))).rejects.toThrow(HermeticError);
    backend.compute.attachVolume = realAttach;

    const row = (await backend.store.agents.get("cinnabar"))!;
    const recorded = row.instance_id!;

    // The index is behind: the first two queries do not mention the box that
    // exists, and `describeInstance` is the only thing that knows better.
    const realTagQuery = backend.compute.listInstancesByTag;
    let lag = 2;
    backend.compute.listInstancesByTag = async (name: string) => (lag-- > 0 ? [] : realTagQuery(name));

    backend.resetMutations();
    const events = await drain(hermetic.agents.create({ name: "cinnabar" }));

    expect(backend.mutations.filter((m) => m === "compute.runInstance")).toEqual([]);
    expect([...backend.instances.keys()]).toEqual([recorded]);
    const finished = (await backend.store.agents.get("cinnabar"))!;
    expect(finished.instance_id).toBe(recorded);
    expect(finished.resources.config_key).toBeString();
    expect(events.some((e) => e.message.includes(`found live instance ${recorded}`))).toBe(true);
  });

  /**
   * The other half of the same patience: an id EC2 keeps denying all the way
   * through `INSTANCE_VISIBILITY_GRACE_MS` really is gone, and the create must
   * finish rather than wait forever. The row here names a box that never
   * existed, which is what a terminate somebody else ran looks like.
   */
  test("a recorded instance EC2 never admits to is eventually replaced", async () => {
    const { backend, hermetic } = freshFleet();
    const realAttach = backend.compute.attachVolume;
    backend.compute.attachVolume = async () => {
      throw new HermeticError("INTERNAL", "AttachVolume failed", {});
    };
    await expect(drain(hermetic.agents.create({ name: "cobalt" }))).rejects.toThrow(HermeticError);
    backend.compute.attachVolume = realAttach;

    const row = (await backend.store.agents.get("cobalt"))!;
    const recorded = row.instance_id!;
    // Gone from EC2 entirely, and gone from the tag index with it.
    backend.instances.delete(recorded);

    backend.resetMutations();
    const events = await drain(hermetic.agents.create({ name: "cobalt" }));

    expect(backend.mutations.filter((m) => m === "compute.runInstance")).toHaveLength(1);
    const finished = (await backend.store.agents.get("cobalt"))!;
    expect(finished.instance_id).not.toBe(recorded);
    expect(
      events.some((e) => e.level === "warn" && e.message.includes("does not admit exists yet")),
    ).toBe(true);
  });

  /**
   * The same wait, and the same reason `attach.ts` guards its reads: a throttled
   * `DescribeInstances` here would end the one wait whose whole purpose is that
   * "EC2 did not answer" is never read as "the instance is gone" — and the
   * answer to that misreading is a second billing box.
   */
  test("a throttled describe does not count as EC2 denying the recorded instance", async () => {
    const { backend, hermetic } = freshFleet();
    const realAttach = backend.compute.attachVolume;
    backend.compute.attachVolume = async () => {
      throw new HermeticError("INTERNAL", "AttachVolume failed", {});
    };
    await expect(drain(hermetic.agents.create({ name: "cerulean" }))).rejects.toThrow(HermeticError);
    backend.compute.attachVolume = realAttach;

    const recorded = (await backend.store.agents.get("cerulean"))!.instance_id!;
    const realTagQuery = backend.compute.listInstancesByTag;
    let lag = 1;
    backend.compute.listInstancesByTag = async (name: string) => (lag-- > 0 ? [] : realTagQuery(name));
    const realDescribe = backend.compute.describeInstance;
    let throttles = 2;
    backend.compute.describeInstance = async (id: string) => {
      if (throttles-- > 0) {
        throw new HermeticError("INTERNAL", "Request limit exceeded", {
          aws_error: "RequestLimitExceeded",
        });
      }
      return realDescribe(id);
    };

    backend.resetMutations();
    const events = await drain(hermetic.agents.create({ name: "cerulean" }));

    expect(backend.mutations.filter((m) => m === "compute.runInstance")).toEqual([]);
    expect((await backend.store.agents.get("cerulean"))!.instance_id).toBe(recorded);
    expect(
      events.some((e) => e.level === "warn" && e.message.includes("DescribeInstances was refused")),
    ).toBe(true);
  });

  /**
   * And the sentence that explains a create which has apparently stopped is
   * said on the *first* poll: holding it back for the progress interval holds
   * it back for exactly the seconds somebody is most likely to be watching.
   */
  test("the wait says why it is waiting on its first poll, not fifteen seconds in", async () => {
    const { backend, hermetic } = freshFleet();
    const realAttach = backend.compute.attachVolume;
    backend.compute.attachVolume = async () => {
      throw new HermeticError("INTERNAL", "AttachVolume failed", {});
    };
    await expect(drain(hermetic.agents.create({ name: "celadon" }))).rejects.toThrow(HermeticError);
    backend.compute.attachVolume = realAttach;

    const recorded = (await backend.store.agents.get("celadon"))!.instance_id!;
    const realTagQuery = backend.compute.listInstancesByTag;
    let lag = 1;
    backend.compute.listInstancesByTag = async (name: string) => (lag-- > 0 ? [] : realTagQuery(name));
    const realDescribe = backend.compute.describeInstance;
    let misses = 1;
    backend.compute.describeInstance = async (id: string) => (misses-- > 0 ? null : realDescribe(id));

    // A real progress interval: with the old rule nothing would be said until
    // fifteen seconds of a clock that never moves in a test had passed.
    const events = await drain(
      testHermetic({
        backend,
        config: FIXTURE_CONFIG,
        attach: { pollMs: 1, progressMs: 15_000 },
      }).agents.create({ name: "celadon" }),
    );

    expect(events.some((e) => e.message.includes(`names instance ${recorded}`))).toBe(true);
  });

  test("resume captures a live tagged instance that was never written onto the row", async () => {
    const { backend, hermetic } = freshFleet();
    const controller = new AbortController();
    await expect(
      (async () => {
        for await (const e of hermetic.agents.create(
          { name: "crimson" },
          { signal: controller.signal },
        )) {
          if (e.phase === "volume") controller.abort();
        }
      })(),
    ).rejects.toThrow(HermeticError);

    const partial = (await backend.store.agents.get("crimson"))!;
    // Simulate the AWS-side launch that never made it onto the row: an instance
    // tagged for this agent, volume already recorded, instance_id still null.
    backend.instances.set("i-005466f1aa81a3e48", {
      instance_id: "i-005466f1aa81a3e48",
      state: "running",
      public_ip: "203.0.113.50",
      agent: "crimson",
      fleet_id: FIXTURE_CONFIG.fleet_id,
    });
    expect(partial.instance_id).toBeNull();

    const events = await drain(hermetic.agents.create({ name: "crimson" }));
    expect(events.some((e) => e.message.includes("i-005466f1aa81a3e48"))).toBe(true);
    expect(backend.mutations.filter((m) => m === "compute.runInstance")).toEqual([]);
    const finished = (await backend.store.agents.get("crimson"))!;
    expect(finished.instance_id).toBe("i-005466f1aa81a3e48");
    expect(finished.resources.instance_id).toBe("i-005466f1aa81a3e48");
    expect(backend.volumes.get(finished.resources.volume_id!)?.attached_to).toBe("i-005466f1aa81a3e48");
  });

  /**
   * A resume with two boxes wearing the tag: the one the row already records,
   * and one left by a launch whose id never persisted. Adopting EC2's arbitrary
   * first match would rewrite `instance_id` to the wrong box and demote the
   * right one to a duplicate nothing but a destructive `recreate` clears — so
   * create picks the same one `doctor` calls the agent's, and only *names* the
   * rest.
   */
  test("resume adopts the instance the row records, and only names the stray", async () => {
    const { backend, hermetic } = freshFleet();
    const realAttach = backend.compute.attachVolume;
    backend.compute.attachVolume = async () => {
      throw new HermeticError("INTERNAL", "AttachVolume failed", {});
    };
    await expect(drain(hermetic.agents.create({ name: "cougar" }))).rejects.toThrow(HermeticError);
    backend.compute.attachVolume = realAttach;

    const row = (await backend.store.agents.get("cougar"))!;
    const recorded = row.instance_id!;
    // A second box tagged for the same agent, inserted *first* so the tag
    // lookup returns it ahead of the recorded one.
    const others = new Map(backend.instances);
    backend.instances.clear();
    backend.instances.set("i-stray0000000000", {
      instance_id: "i-stray0000000000",
      state: "running",
      public_ip: "203.0.113.60",
      agent: "cougar",
      fleet_id: FIXTURE_CONFIG.fleet_id,
    });
    for (const [id, inst] of others) backend.instances.set(id, inst);

    backend.resetMutations();
    const events = await drain(hermetic.agents.create({ name: "cougar" }));

    const finished = (await backend.store.agents.get("cougar"))!;
    expect(finished.instance_id).toBe(recorded);
    expect(finished.resources.instance_id).toBe(recorded);
    expect(events.some((e) => e.message.includes(`found live instance ${recorded}`))).toBe(true);
    // Named, not destroyed: create adopts, `recreate` sweeps.
    const warned = events.filter((e) => e.level === "warn");
    expect(warned.some((e) => e.message.includes("i-stray0000000000"))).toBe(true);
    expect(backend.instances.get("i-stray0000000000")!.state).toBe("running");
    expect(backend.mutations.filter((m) => m === "compute.terminate")).toEqual([]);
    expect(backend.mutations.filter((m) => m === "compute.runInstance")).toEqual([]);
  });

  test("two concurrent creates of the same name: exactly one wins", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const a = testHermetic({ backend, config: FIXTURE_CONFIG });
    const b = testHermetic({ backend, config: FIXTURE_CONFIG });

    const results = await Promise.allSettled([
      drain(a.agents.create({ name: "corvid" })),
      drain(b.agents.create({ name: "corvid" })),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(HermeticError);
    expect(((rejected[0] as PromiseRejectedResult).reason as HermeticError).code).toBe("NAME_TAKEN");

    expect([...backend.instances.values()].filter((i) => i.agent === "corvid")).toHaveLength(1);
  });

  test("a live agent's name is taken", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "lumen" }));
    await backend.store.agents.update("lumen", (await backend.store.agents.get("lumen"))!.version, {
      status: "bootstrapping",
    });
    await backend.store.agents.update("lumen", (await backend.store.agents.get("lumen"))!.version, {
      status: "ready",
    });

    let code: string | null = null;
    try {
      await drain(hermetic.agents.create({ name: "lumen" }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("NAME_TAKEN");
  });

  /**
   * §3.6: `init --skip-artifacts` leaves a fleet whose bucket has no release
   * and no `manifest.json`. The refusal has to land here — before a row, a key
   * or a volume exists — rather than eight minutes into a boot whose presigned
   * download 404s.
   */
  test("refuses when the bucket has no fleet manifest, before anything is created", async () => {
    const { backend, hermetic } = freshFleet();
    backend.objects.delete(FLEET_MANIFEST_KEY);
    backend.resetMutations();

    let err: unknown;
    try {
      await drain(hermetic.agents.create({ name: "atlas" }));
    } catch (e) {
      err = e;
    }
    expect((err as HermeticError).code).toBe("NOT_FOUND");
    expect((err as HermeticError).message).toContain("hermetic artifacts push");
    expect(await backend.store.agents.get("atlas")).toBeNull();
    expect(backend.mutations).toEqual([]);
  });

  test("refuses to create behind a security group with an inbound rule", async () => {
    const { backend, hermetic } = freshFleet();
    backend.sgInbound = [{ protocol: "tcp", from: 22, to: 22, cidr: "0.0.0.0/0" }];

    let code: string | null = null;
    try {
      await drain(hermetic.agents.create({ name: "kestrel" }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("SG_INBOUND_RULE");
    expect(backend.mutations).toEqual([]);
  });

  test("fails NOT_INITIALIZED without a frozen local config", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: null });
    let code: string | null = null;
    try {
      await drain(hermetic.agents.create({ name: "atlas" }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("NOT_INITIALIZED");
  });

  test("fails ACCOUNT_MISMATCH when STS resolves a different account", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    backend.accountId = "999999999999";
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
    let code: string | null = null;
    try {
      await drain(hermetic.agents.create({ name: "atlas" }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("ACCOUNT_MISMATCH");
    expect(backend.mutations).toEqual([]);
  });

  test("fails FLEET_MISMATCH when the stack tag disagrees with local config", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    backend.stack!.tags["fleet_id"] = "00000000-0000-4000-8000-000000000000";
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
    let code: string | null = null;
    try {
      await drain(hermetic.agents.create({ name: "atlas" }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("FLEET_MISMATCH");
  });
});

/**
 * §6.2's opt-in undo. The default — a failed create leaves a resumable row that
 * names what exists — is covered by the tests above and stays exactly as it was;
 * these are about the operator who asked for nothing instead.
 */
describe("agents.create --rollback-on-failure", () => {
  /** Drain a create that is expected to fail, keeping both halves. */
  async function failing(
    stream: AsyncIterable<OpEvent>,
  ): Promise<{ events: OpEvent[]; error: HermeticError | null }> {
    const events: OpEvent[] = [];
    let error: HermeticError | null = null;
    try {
      for await (const e of stream) events.push(e);
    } catch (e) {
      error = e as HermeticError;
    }
    return { events, error };
  }

  test("a fresh create that dies at RunInstances leaves nothing behind", async () => {
    const { backend, hermetic } = freshFleet();
    backend.compute.runInstance = async () => {
      throw new HermeticError("INTERNAL", "RunInstances failed", {});
    };

    const { events, error } = await failing(
      hermetic.agents.create({ name: "atlas", rollback_on_failure: true }),
    );

    // The operator's error is what propagates, with its code intact — the
    // rollback is a side effect of the failure, never a replacement for it.
    expect(error).toBeInstanceOf(HermeticError);
    expect(error!.code).toBe("INTERNAL");

    expect(await backend.store.agents.get("atlas")).toBeNull();
    expect(backend.mutations).toContain("store.agents.delete");
    expect([...backend.volumes.values()].filter((v) => v.agent === "atlas")).toEqual([]);
    expect(await backend.secrets.list("/hermes/fxtr0001/atlas/")).toEqual([]);
    // Both prefixes really had something in them: an assertion that a prefix is
    // empty passes just as well when nothing was ever written to it.
    expect(backend.mutations).toContain("secrets.deleteByPrefix");
    expect(backend.mutations).toContain("artifacts.purgeByPrefix");
    expect(await backend.artifacts.list("config/atlas/")).toEqual([]);

    // Events are never deleted (§6.6): the history says the run failed and that
    // it was rolled back, even though the row it described is gone.
    const history = await backend.store.events.query("atlas");
    expect(history.map((e) => e.action)).toContain("failed");
    expect(history.map((e) => e.action)).toContain("rollback");
    expect(events.some((e) => e.phase === "rollback")).toBe(true);
  });

  test("a create that dies at attach terminates the instance it launched and deletes the volume it made", async () => {
    const { backend, hermetic } = freshFleet();
    backend.compute.attachVolume = async () => {
      throw new HermeticError("INTERNAL", "AttachVolume failed", {});
    };

    const { error } = await failing(
      hermetic.agents.create({ name: "cougar", rollback_on_failure: true }),
    );

    expect(error!.code).toBe("INTERNAL");
    expect(backend.mutations).toContain("compute.terminate");
    expect(backend.mutations).toContain("compute.deleteVolume");
    expect(backend.mutations).toContain("store.agents.delete");
    expect([...backend.instances.values()].every((i) => i.state === "terminated")).toBe(true);
    expect(
      [...backend.volumes.values()].filter((v) => v.agent === "cougar" && v.role === "data"),
    ).toEqual([]);
    expect(await backend.store.agents.get("cougar")).toBeNull();
  });

  test("the same failure without the flag unwinds nothing at all", async () => {
    const { backend, hermetic } = freshFleet();
    backend.compute.attachVolume = async () => {
      throw new HermeticError("INTERNAL", "AttachVolume failed", {});
    };

    const { error } = await failing(hermetic.agents.create({ name: "cougar" }));

    expect(error!.code).toBe("INTERNAL");
    const row = (await backend.store.agents.get("cougar"))!;
    expect(row.status).toBe("creating");
    expect(row.lock).toBeNull();
    expect(row.resources.instance_id).toBeString();
    expect([...backend.instances.values()].filter((i) => i.state !== "terminated")).toHaveLength(1);
    expect(
      [...backend.volumes.values()].filter((v) => v.agent === "cougar" && v.role === "data"),
    ).toHaveLength(1);
    for (const m of ["compute.terminate", "compute.deleteVolume", "store.agents.delete"]) {
      expect(backend.mutations).not.toContain(m);
    }
  });

  test("a resumed create rolls back only the instance it launched, never the volume it inherited", async () => {
    const { backend, hermetic } = freshFleet();
    const controller = new AbortController();

    // First attempt: claim the row and the volume, then die before the instance.
    await expect(
      (async () => {
        for await (const e of hermetic.agents.create(
          { name: "granite" },
          { signal: controller.signal },
        )) {
          if (e.phase === "volume") controller.abort();
        }
      })(),
    ).rejects.toThrow(HermeticError);
    const volumeId = (await backend.store.agents.get("granite"))!.resources.volume_id!;

    backend.compute.attachVolume = async () => {
      throw new HermeticError("INTERNAL", "AttachVolume failed", {});
    };
    backend.resetMutations();
    const { events, error } = await failing(
      hermetic.agents.create({ name: "granite", rollback_on_failure: true }),
    );

    expect(error!.code).toBe("INTERNAL");
    // Launched by this run, so it goes.
    expect(backend.mutations).toContain("compute.terminate");
    // Everything the run only inherited stays: the disk (§1), the slots, the row.
    expect(backend.mutations).not.toContain("compute.deleteVolume");
    expect(backend.mutations).not.toContain("store.agents.delete");
    expect(backend.mutations).not.toContain("secrets.deleteByPrefix");
    expect(backend.volumes.get(volumeId)).toBeDefined();
    expect(await backend.secrets.exists("/hermes/fxtr0001/granite/ts-key")).toBe(true);

    const row = (await backend.store.agents.get("granite"))!;
    expect(row.status).toBe("creating");
    expect(row.lock).toBeNull();
    expect(events.some((e) => e.message.includes("resumed it rather than creating it"))).toBe(true);
  });

  test("an undo step that fails keeps the row and says to destroy it", async () => {
    const { backend, hermetic } = freshFleet();
    backend.compute.attachVolume = async () => {
      throw new HermeticError("INTERNAL", "AttachVolume failed", {});
    };
    backend.compute.deleteVolume = async () => {
      throw new HermeticError("CONFLICT", "DeleteVolume refused", {});
    };

    const { events, error } = await failing(
      hermetic.agents.create({ name: "basalt", rollback_on_failure: true }),
    );

    // The create's own error is what the operator gets, not the undo's.
    expect(error!.code).toBe("INTERNAL");
    expect(error!.message).toContain("AttachVolume");

    // The steps either side of the failure still ran…
    expect(backend.mutations).toContain("compute.terminate");
    expect(backend.mutations).toContain("secrets.deleteByPrefix");
    // …and the row survived, because it is the only thing naming the volume.
    expect(backend.mutations).not.toContain("store.agents.delete");
    const row = (await backend.store.agents.get("basalt"))!;
    expect(row.status).toBe("creating");
    expect(row.lock).toBeNull();

    const warn = events.find((e) => e.message.includes("rollback step volume failed"));
    expect(warn?.level).toBe("warn");
    expect(warn?.message).toContain("(CONFLICT)");
    expect(JSON.stringify(events)).not.toContain("DeleteVolume refused");
    expect(JSON.stringify(events)).toContain("hermetic agent destroy basalt --yes");
  });

  /**
   * An interrupt is the one failure the flag does *not* act on. Ctrl-C means
   * stop, and what stopping leaves — a row naming what exists — is strictly
   * better than what an unwind interrupted a second later would leave: the
   * heads force-exit about 1.5s after aborting, and the detach wait alone can
   * outlast that, stranding a terminated instance, an undeleted volume and a
   * held lock.
   */
  test("an interrupted create is left resumable, flag or no flag", async () => {
    const { backend, hermetic } = freshFleet();
    const controller = new AbortController();

    const { events, error } = await failing(
      (async function* () {
        for await (const e of hermetic.agents.create(
          { name: "heron", rollback_on_failure: true },
          { signal: controller.signal },
        )) {
          if (e.phase === "instance") controller.abort();
          yield e;
        }
      })(),
    );

    expect(error!.code).toBe("ABORTED");
    expect(events.some((e) => e.phase === "rollback")).toBe(false);

    // Exactly what an abort without the flag leaves (see the tests above).
    const row = (await backend.store.agents.get("heron"))!;
    expect(row.status).toBe("creating");
    expect(row.lock).toBeNull();
    expect(row.resources.instance_id).toBeString();
    expect(
      [...backend.volumes.values()].filter((v) => v.agent === "heron" && v.role === "data"),
    ).toHaveLength(1);
    expect([...backend.instances.values()].filter((i) => i.state !== "terminated")).toHaveLength(1);
    for (const m of ["compute.terminate", "compute.deleteVolume", "store.agents.delete"]) {
      expect(backend.mutations).not.toContain(m);
    }
  });

  /**
   * The row is committed as handed off — `lock: null`, every resource recorded
   * — and the history line is written *after*. A throw on that write lands in
   * the same catch a real failure does, with a full ledger, so the ownership
   * check in `rollback.ts` is the only thing between a throttled events table
   * and a destroyed, healthy, booting agent.
   */
  test("a handoff whose history line fails never rolls back the finished agent", async () => {
    const { backend, hermetic } = freshFleet();
    const append = backend.store.events.append;
    backend.store.events.append = async (event: AgentEvent) => {
      if (event.action === "handoff") {
        throw new HermeticError("INTERNAL", "PutItem throttled", {});
      }
      return append(event);
    };

    const { events, error } = await failing(
      hermetic.agents.create({ name: "atlas", rollback_on_failure: true }),
    );

    expect(error!.code).toBe("INTERNAL");

    // The agent is finished and untouched: this is the handoff state.
    const row = (await backend.store.agents.get("atlas"))!;
    expect(row.lock).toBeNull();
    expect(row.resources.instance_id).toBeString();
    expect(row.resources.volume_id).toBeString();
    expect(row.resources.config_key).toBeString();
    expect([...backend.instances.values()].every((i) => i.state !== "terminated")).toBe(true);
    expect(
      [...backend.volumes.values()].filter((v) => v.agent === "atlas" && v.role === "data"),
    ).toHaveLength(1);
    for (const m of ["compute.terminate", "compute.deleteVolume", "store.agents.delete"]) {
      expect(backend.mutations).not.toContain(m);
    }
    expect(await backend.secrets.exists("/hermes/fxtr0001/atlas/ts-key")).toBe(true);
    expect(events.some((e) => e.message.includes("finished provisioning before this failure"))).toBe(
      true,
    );
  });

  /**
   * The ownership gate is a re-claim, not a read: `store.agents.delete` is
   * unconditional, and with no volume to wait for nothing renews the lock
   * between the read and the deletes. A run that stalled inside `RunInstances`
   * — no keeper covers that call — can therefore pass a read taken a
   * millisecond before its lock expires. The version-conditional re-take is
   * what turns that into a refusal.
   */
  test("a rollback that cannot re-take the lock deletes nothing", async () => {
    const { backend, hermetic } = freshFleet();
    let unwinding = false;
    backend.compute.runInstance = async () => {
      unwinding = true;
      throw new HermeticError("INTERNAL", "RunInstances failed", {});
    };
    const update = backend.store.agents.update;
    backend.store.agents.update = async (name: string, version: number, patch: AgentPatch) => {
      // Stands in for the row having changed hands in the gap: the only lock
      // patch after the failure is the rollback's own re-claim.
      if (unwinding && patch.lock !== undefined) {
        throw new HermeticError("CONFLICT", "version moved", {});
      }
      return update(name, version, patch);
    };

    const { events, error } = await failing(
      hermetic.agents.create({ name: "atlas", rollback_on_failure: true }),
    );

    expect(error!.code).toBe("INTERNAL");
    for (const m of [
      "compute.deleteVolume",
      "secrets.deleteByPrefix",
      "artifacts.purgeByPrefix",
      "store.agents.delete",
    ]) {
      expect(backend.mutations).not.toContain(m);
    }
    expect(await backend.store.agents.get("atlas")).not.toBeNull();
    expect(await backend.secrets.exists("/hermes/fxtr0001/atlas/ts-key")).toBe(true);
    expect(events.some((e) => e.message.includes("could not confirm"))).toBe(true);
  });

  /**
   * No `AbortSignal` reaches the AWS SDK calls, so ctrl-C during a call that is
   * already in flight lets it finish and throw its own answer. The code alone
   * would read that as an ordinary failure and start unwinding into a process
   * the head is about to kill; the gate checks the signal too.
   */
  test("an interrupt that surfaces as an AWS error still does not roll back", async () => {
    const { backend, hermetic } = freshFleet();
    const controller = new AbortController();
    backend.compute.runInstance = async () => {
      // Ctrl-C landed while RunInstances was in flight; EC2 answered anyway.
      controller.abort();
      throw new HermeticError("INTERNAL", "InsufficientInstanceCapacity", {});
    };

    const { events, error } = await failing(
      hermetic.agents.create(
        { name: "quartz", rollback_on_failure: true },
        { signal: controller.signal },
      ),
    );

    expect(error!.code).toBe("INTERNAL");
    expect(events.some((e) => e.phase === "rollback")).toBe(false);
    for (const m of [
      "compute.terminate",
      "compute.deleteVolume",
      "secrets.deleteByPrefix",
      "artifacts.purgeByPrefix",
      "store.agents.delete",
    ]) {
      expect(backend.mutations).not.toContain(m);
    }
    const row = (await backend.store.agents.get("quartz"))!;
    expect(row.status).toBe("creating");
    expect(row.lock).toBeNull();
  });

  /**
   * `rollbackDeps`'s `reclaim` re-takes the lock (`acquireLock`), which bumps
   * the row's version, and returns the new row — but until Fix 1 that return
   * was discarded, so `create`'s `agent` binding (the one `keepLock` reads and
   * writes) kept the pre-reclaim version. The next time the detach wait's
   * heartbeat crossed `LOCK_RENEW_MS` and called a real `renewLock`, it did so
   * with the stale version and got back `CONFLICT` — landing in the volume
   * step's catch, leaving the volume undeleted and the row stuck reporting
   * "rollback incomplete (volume)" forever, caused by the rollback breaking its
   * own lock renewal.
   *
   * This forces exactly that path: fail `create` at attach (an instance and a
   * volume of this run's own in the ledger), then keep the rollback's detach
   * wait "still attached" for a few polls, each one advancing the fixture's
   * frozen clock past the renew threshold, so a real `renewLock` actually
   * fires *after* the reclaim.
   */
  test("a rollback's own lock renewal survives the reclaim", async () => {
    const { backend, hermetic } = freshFleet();

    // The fixture clock is frozen; drive it by hand so the detach wait's
    // heartbeat crosses LOCK_RENEW_MS (TTL/3, ~200s) on each poll without
    // crossing LOCK_TTL_MS itself.
    const base = backend.clock.now().getTime();
    let offset = 0;
    backend.clock.now = () => new Date(base + offset);
    const STEP_MS = 4 * 60 * 1000;

    // Fail at attach: this run has already launched an instance and created a
    // volume of its own by the time this throws, so both land in the ledger.
    let simulateHeld = false;
    backend.compute.attachVolume = async () => {
      simulateHeld = true;
      throw new HermeticError("INTERNAL", "AttachVolume failed", {});
    };

    // Capture the instance this run launches, so the fake describeVolume below
    // can report it as the volume's holder.
    let instanceId: string | null = null;
    const realRunInstance = backend.compute.runInstance;
    backend.compute.runInstance = async (spec) => {
      const ref = await realRunInstance(spec);
      instanceId = ref.instance_id;
      return ref;
    };

    // Make the detach wait actually wait. Only once the attach has failed
    // (`simulateHeld`) do the first 3 polls report the volume still attached —
    // and each of those also advances the clock, so every poll crosses the
    // renew threshold and `keepLock` performs a real `renewLock`. The 4th call
    // on falls through to the real `describeVolume`, which reports the volume
    // free (this fixture's `terminate` never actually attached it).
    let fakedCalls = 0;
    const realDescribeVolume = backend.compute.describeVolume;
    backend.compute.describeVolume = async (volumeId: string) => {
      if (simulateHeld && fakedCalls < 3) {
        fakedCalls++;
        offset += STEP_MS;
        return {
          volume_id: volumeId,
          size_gib: 100,
          state: "in-use",
          attachments: [{ instance_id: instanceId!, state: "attached" }],
        };
      }
      return realDescribeVolume(volumeId);
    };

    const { events, error } = await failing(
      hermetic.agents.create({ name: "atlas", rollback_on_failure: true }),
    );

    // The create's own error is what propagates; the rollback is a side effect.
    expect(error).toBeInstanceOf(HermeticError);
    expect(error!.code).toBe("INTERNAL");
    expect(error!.message).toContain("AttachVolume");

    // Proof the detach wait actually ran (and thus the heartbeat fired).
    expect(events.some((e) => e.message.includes("waiting for"))).toBe(true);
    // The bug this pins: a stale-version renewal failing the volume step.
    expect(events.some((e) => e.message.includes("rollback step volume failed"))).toBe(false);

    expect(backend.mutations).toContain("compute.terminate");
    expect(backend.mutations).toContain("compute.deleteVolume");
    expect(backend.mutations).toContain("store.agents.delete");
    expect(await backend.store.agents.get("atlas")).toBeNull();
    expect(
      [...backend.volumes.values()].filter((v) => v.agent === "atlas" && v.role === "data"),
    ).toEqual([]);
  });
});

/**
 * §4.5, §6.2: `create` is not the only writer of the row it is finishing. The
 * box it just launched moves the row to `bootstrapping` as soon as hermeticd's
 * stage runner starts, and a fast box does that while the laptop is still
 * waiting for `AttachVolume`. The version-conditional handoff write then lost
 * the race, and a create whose agent was coming up perfectly well reported
 * `CONFLICT` with the lock still on the row and the config pointer unrecorded.
 */
describe("the handoff races the box", () => {
  /** The patch `create`'s last write carries, and nothing else's. */
  const isHandoffWrite = (p: AgentPatch): boolean =>
    p.lock === null && p.instance_id !== undefined && p.resources !== undefined;

  /**
   * Land `racer`'s write between `create` reading the row and writing it, the
   * first time it attempts the handoff — which is exactly the shape of the
   * box's own conditional transition (`packages/agentd/src/aws.ts`).
   */
  function raceTheHandoff(backend: MemoryBackend, racer: (current: Agent) => AgentPatch): void {
    const update = backend.store.agents.update;
    let raced = false;
    backend.store.agents.update = async (name: string, version: number, p: AgentPatch) => {
      if (raced || !isHandoffWrite(p)) return update(name, version, p);
      raced = true;
      const current = (await backend.store.agents.get(name))!;
      await update(name, current.version, racer(current));
      throw new HermeticError("CONFLICT", `agent ${name} changed underneath this operation`, {
        name,
      });
    };
  }

  test("the box's status move is kept and the create still finishes", async () => {
    const { backend, hermetic } = freshFleet();
    raceTheHandoff(backend, () => ({ status: "bootstrapping" }));

    const events = await drain(hermetic.agents.create({ name: "atlas" }));

    expect(events.at(-1)?.progress).toBe(1);
    const agent = (await backend.store.agents.get("atlas"))!;
    // The box moved the status, so the status is the box's — `create` never
    // wrote one and the retry does not put `creating` back.
    expect(agent.status).toBe("bootstrapping");
    expect(agent.lock).toBeNull();
    expect(agent.instance_id).toBeString();
    expect(agent.resources.instance_id).toBe(agent.instance_id!);
    expect(agent.resources.volume_id).toBeString();
    expect(agent.resources.config_key).toStartWith("config/atlas/");
    expect(agent.config_hash).toBeString();
    expect(agent.resources.ssm_paths.length).toBeGreaterThan(0);
  });

  /**
   * The other half of the fix, and the one that does not depend on a retry
   * working: the config pointer is on the row before there is a second writer
   * at all.
   */
  test("the config pointer is on the row before the instance is launched", async () => {
    const { backend, hermetic } = freshFleet();
    const runInstance = backend.compute.runInstance;
    let atLaunch: Agent | null = null;
    backend.compute.runInstance = async (spec) => {
      atLaunch = await backend.store.agents.get(spec.name);
      return runInstance(spec);
    };

    await drain(hermetic.agents.create({ name: "atlas" }));

    const row: Agent = atLaunch!;
    expect(row.resources.config_key).toStartWith("config/atlas/");
    expect(row.config_hash).toBeString();
    expect(await backend.artifacts.exists(row.resources.config_key!)).toBe(true);
  });

  test("a lock another operator has taken is a real conflict", async () => {
    const { backend, hermetic } = freshFleet();
    raceTheHandoff(backend, () => ({
      lock: { owner: "someone-else#f0c2", expires: "2099-01-01T00:00:00.000Z" },
    }));

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "atlas" }));
    } catch (e) {
      error = e as HermeticError;
    }

    expect(error?.code).toBe("CONFLICT");
    const agent = (await backend.store.agents.get("atlas"))!;
    // Not stolen back: the other operator still holds it.
    expect(agent.lock?.owner).toBe("someone-else#f0c2");
    // And the handoff did not half-land.
    expect(agent.resources.ssm_paths).toEqual([]);
  });

  test("a row naming a different instance is a real conflict, and is not overwritten", async () => {
    const { backend, hermetic } = freshFleet();
    const foreign = "i-otherrun00000000";
    raceTheHandoff(backend, (current) => ({
      instance_id: foreign,
      resources: { ...current.resources, instance_id: foreign },
    }));

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "atlas" }));
    } catch (e) {
      error = e as HermeticError;
    }

    expect(error?.code).toBe("CONFLICT");
    const agent = (await backend.store.agents.get("atlas"))!;
    // Whoever launched that box is the only one who can clean it up; a handoff
    // that rewrote the id would leave it billing and named by nothing.
    expect(agent.instance_id).toBe(foreign);
    expect(agent.resources.instance_id).toBe(foreign);
    expect(agent.resources.ssm_paths).toEqual([]);
  });
});
