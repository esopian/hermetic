/**
 * The Hermes external memory provider: chosen at `agents.create`, inherited
 * from `settings.default_memory_provider`, pinned on the row, rendered into the
 * managed config, and — for a keyed provider — its key copied from the fleet's
 * shared `memory-<id>` slot into the agent's own `memory-key` slot.
 */
import { describe, expect, test } from "bun:test";
import { HermeticError } from "../src/errors.ts";
import {
  FIXTURE_CONFIG,
  FIXTURE_MEMORY_KEY,
  MemoryBackend,
  fixtureConfigFor,
  seedFixtureFleet,
  seedFixtureFoundation,
} from "../src/backend/memory.ts";
import { SECRET_PLACEHOLDER, sharedSecretPath } from "../src/backend/constants.ts";
import {
  AgentConfig,
  AgentMemory,
  CreateAgentInput,
  FleetSettings,
  HERMES_MANAGED_CONFIG,
  MEMORY_KEY_SLOT,
  MEMORY_PROVIDERS,
  MEMORY_PROVIDERS_LIST,
  MEMORY_PROVIDER_CAPABILITY,
  MEMORY_PROVIDER_IDS,
  MemoryProviderChoice,
  SettingsSetInput,
  isMemoryProvider,
  memoryKeyEnv,
  memoryKeySlug,
  memoryProviderNeedsKey,
  requiredCapabilities,
} from "../src/schema/index.ts";
import { renderAgentConfig, type RenderInput } from "../src/render/render.ts";
import { resolveMemoryProvider } from "../src/agents/lifecycle/memory-binding.ts";
import { drain, freshFleet, testHermetic } from "./helpers.ts";

const SUPERMEMORY_SLOT = sharedSecretPath(FIXTURE_CONFIG.fleet_id, "memory-supermemory");
const HONCHO_KEY = "hc-memory-FIXTURE-SECRET";

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return e instanceof HermeticError ? e.code : `not a HermeticError: ${String(e)}`;
  }
}

describe("the memory provider catalogue", () => {
  test("ids, keys and slots agree with each other", () => {
    expect([...MEMORY_PROVIDER_IDS]).toEqual([
      "holographic",
      "supermemory",
      "honcho",
      "mem0",
      "retaindb",
    ]);
    expect(MEMORY_PROVIDERS_LIST.map((p) => p.id)).toEqual([...MEMORY_PROVIDER_IDS]);
    for (const id of MEMORY_PROVIDER_IDS) {
      const spec = MEMORY_PROVIDERS[id];
      // A keyed provider names its variable; the local one names none.
      expect(memoryProviderNeedsKey(id)).toBe(spec.env !== null);
      expect(memoryKeyEnv(id)).toBe(spec.env);
      expect(memoryKeySlug(id)).toBe(`memory-${id}`);
      expect(spec.docs).toStartWith(
        "https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers",
      );
    }
    expect(memoryProviderNeedsKey("holographic")).toBe(false);
    expect(memoryKeyEnv("supermemory")).toBe("SUPERMEMORY_API_KEY");
    expect(MEMORY_KEY_SLOT).toBe("memory-key");
    expect(isMemoryProvider("mem0")).toBe(true);
    // Upstream's built-in-only sentinels are not providers.
    for (const s of ["none", "builtin", "default", "", "hindsight"])
      expect(isMemoryProvider(s)).toBe(false);
  });
});

describe("memory provider schemas", () => {
  test("a create accepts a provider or `none`, and refuses anything else", () => {
    expect(CreateAgentInput.parse({ name: "kite", memory_provider: "honcho" }).memory_provider).toBe(
      "honcho",
    );
    expect(CreateAgentInput.parse({ name: "kite", memory_provider: "none" }).memory_provider).toBe(
      "none",
    );
    expect(CreateAgentInput.parse({ name: "kite" }).memory_provider).toBeUndefined();
    expect(CreateAgentInput.safeParse({ name: "kite", memory_provider: "hindsight" }).success).toBe(
      false,
    );
    expect(CreateAgentInput.safeParse({ name: "kite", memory_provider: "builtin" }).success).toBe(
      false,
    );
    expect(MemoryProviderChoice.safeParse("").success).toBe(false);
  });

  test("the fleet default takes a provider or null, never `none`", () => {
    expect(SettingsSetInput.parse({ default_memory_provider: "mem0" }).default_memory_provider).toBe(
      "mem0",
    );
    expect(
      SettingsSetInput.parse({ default_memory_provider: null }).default_memory_provider,
    ).toBeNull();
    expect(SettingsSetInput.safeParse({ default_memory_provider: "none" }).success).toBe(false);
    // On its own it is enough to make a write that names something.
    expect(SettingsSetInput.safeParse({}).success).toBe(false);
    expect(FleetSettings.shape.default_memory_provider.safeParse("bogus").success).toBe(false);
  });

  test("a row's memory names a provider and a nullish slot", () => {
    expect(AgentMemory.parse({ provider: "holographic", key_ref: null })).toEqual({
      provider: "holographic",
      key_ref: null,
    });
    expect(AgentMemory.safeParse({ provider: "nope" }).success).toBe(false);
    expect(AgentMemory.safeParse({ provider: "honcho", key_ref: "" }).success).toBe(false);
  });
});

describe("resolving a create's memory provider", () => {
  test("stated wins, absent inherits, `none` overrides the default", () => {
    const fleet = { default_memory_provider: "holographic" as const };
    expect(resolveMemoryProvider("honcho", fleet)).toBe("honcho");
    expect(resolveMemoryProvider(undefined, fleet)).toBe("holographic");
    expect(resolveMemoryProvider("none", fleet)).toBeNull();
    expect(resolveMemoryProvider(undefined, {})).toBeNull();
    expect(resolveMemoryProvider(undefined, { default_memory_provider: null })).toBeNull();
  });
});

describe("agents.create with a memory provider", () => {
  test("no choice and no fleet default is built-in memory only", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "kite" }));
    const agent = (await backend.store.agents.get("kite"))!;
    expect(agent.memory).toBeNull();
    expect(agent.resources.ssm_paths.some((p) => p.endsWith("/memory-key"))).toBe(false);
  });

  test("an absent choice inherits the fleet default", async () => {
    const { backend, hermetic } = freshFleet();
    await hermetic.settings.set({ default_memory_provider: "holographic" });
    await drain(hermetic.agents.create({ name: "kite" }));
    const agent = (await backend.store.agents.get("kite"))!;
    expect(agent.memory).toEqual({ provider: "holographic", key_ref: null });
    // A local provider needs no key, so no slot.
    expect(agent.resources.ssm_paths.some((p) => p.endsWith("/memory-key"))).toBe(false);
  });

  test("an explicit `none` overrides the fleet default to built-in only", async () => {
    const { backend, hermetic } = freshFleet();
    await hermetic.settings.set({ default_memory_provider: "supermemory" });
    await drain(hermetic.agents.create({ name: "kite", memory_provider: "none" }));
    expect((await backend.store.agents.get("kite"))!.memory).toBeNull();
  });

  test("the staging fixture's default is inherited", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend(), { fleet: "staging" });
    expect(backend.fleetItem!.settings!.default_memory_provider).toBe("holographic");
    const hermetic = testHermetic({ backend, config: fixtureConfigFor("staging") });
    await drain(hermetic.agents.create({ name: "kite" }));
    expect((await backend.store.agents.get("kite"))!.memory).toEqual({
      provider: "holographic",
      key_ref: null,
    });
  });

  test("a keyed provider's shared key is copied into the agent's own slot", async () => {
    const { backend, hermetic } = freshFleet();
    const events = await drain(
      hermetic.agents.create({ name: "kite", memory_provider: "supermemory" }),
    );
    const agent = (await backend.store.agents.get("kite"))!;
    expect(agent.memory).toEqual({ provider: "supermemory", key_ref: "memory-key" });
    const slot = "/hermes/fxtr0001/kite/memory-key";
    expect(agent.resources.ssm_paths).toContain(slot);
    expect(backend.params.get(slot)).toBe(FIXTURE_MEMORY_KEY);

    // The slot is named, the value never is.
    const stream = JSON.stringify(events);
    expect(stream).toInclude(
      "SUPERMEMORY_API_KEY copied from the fleet's shared slot memory-supermemory",
    );
    expect(stream).not.toInclude(FIXTURE_MEMORY_KEY);
    const history = await backend.store.events.query("kite");
    expect(history.map((e) => e.detail)).toContain("memory-key from shared slot memory-supermemory");
    expect(JSON.stringify(history)).not.toInclude(FIXTURE_MEMORY_KEY);
  });

  test("an absent shared slot is MEMORY_KEY_MISSING, before the name is taken", async () => {
    const { backend, hermetic } = freshFleet();
    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "kite", memory_provider: "honcho" }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("MEMORY_KEY_MISSING");
    expect(error?.message).toInclude("hermetic secrets push _fleet --shared memory-honcho");
    expect(await backend.store.agents.get("kite")).toBeNull();
    expect(backend.mutations).not.toContain("compute.runInstance");
  });

  test("a placeholder shared slot is MEMORY_KEY_MISSING too, inherited or stated", async () => {
    const { backend, hermetic } = freshFleet();
    backend.params.set(SUPERMEMORY_SLOT, SECRET_PLACEHOLDER);
    await hermetic.settings.set({ default_memory_provider: "supermemory" });
    expect(await codeOf(() => drain(hermetic.agents.create({ name: "kite" })))).toBe(
      "MEMORY_KEY_MISSING",
    );
    expect(await backend.store.agents.get("kite")).toBeNull();
    // `none` still creates, because it asks for no key.
    await drain(hermetic.agents.create({ name: "kite", memory_provider: "none" }));
    expect((await backend.store.agents.get("kite"))!.memory).toBeNull();
  });

  test("a filled shared slot of another provider is copied for that provider", async () => {
    const { backend, hermetic } = freshFleet();
    backend.params.set(sharedSecretPath(FIXTURE_CONFIG.fleet_id, "memory-honcho"), HONCHO_KEY);
    await drain(hermetic.agents.create({ name: "kite", memory_provider: "honcho" }));
    expect(backend.params.get("/hermes/fxtr0001/kite/memory-key")).toBe(HONCHO_KEY);
  });

  /**
   * A fleet whose published hermeticd says what it implements, and that list
   * lacks `memory-provider`, is refused before the name is taken or a key is
   * copied — not by `ensureConfig` after both.
   */
  test("a published hermeticd without the capability refuses before anything exists", async () => {
    const { backend, hermetic } = freshFleet();
    const manifest = JSON.parse(new TextDecoder().decode(backend.objects.get("manifest.json")!)) as {
      hermeticd: Record<string, unknown>;
    };
    manifest.hermeticd = {
      ...manifest.hermeticd,
      capabilities: ["gateway-unit", "restart-units", "browser-stack", "provider-key-ref"],
    };
    backend.objects.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "kite", memory_provider: "supermemory" }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("HERMETICD_UNAVAILABLE");
    expect(error?.message).toInclude("memory-provider");
    expect(await backend.store.agents.get("kite")).toBeNull();
    expect(backend.params.has("/hermes/fxtr0001/kite/memory-key")).toBe(false);
    expect(backend.params.has("/hermes/fxtr0001/kite/ts-key")).toBe(false);

    // The same fleet still creates an agent that asks for no memory provider.
    await drain(hermetic.agents.create({ name: "kite" }));
    expect((await backend.store.agents.get("kite"))!.memory).toBeNull();
  });

  /**
   * A resume finishes the row that exists: its memory, not the request's, and a
   * copy an earlier run made survives the shared slot being emptied since.
   */
  test("a resumed create keeps the row's provider and its earlier copy", async () => {
    const { backend, hermetic } = freshFleet();
    const controller = new AbortController();
    await expect(
      (async () => {
        for await (const e of hermetic.agents.create(
          { name: "kite", memory_provider: "supermemory" },
          { signal: controller.signal },
        )) {
          if (e.phase === "volume") controller.abort();
        }
      })(),
    ).rejects.toThrow(HermeticError);
    expect((await backend.store.agents.get("kite"))!.status).toBe("creating");
    expect(backend.params.get("/hermes/fxtr0001/kite/memory-key")).toBe(FIXTURE_MEMORY_KEY);

    backend.params.set(SUPERMEMORY_SLOT, SECRET_PLACEHOLDER);
    const events = await drain(hermetic.agents.create({ name: "kite", memory_provider: "none" }));
    expect(events[1]?.phase).toBe("resume");
    const agent = (await backend.store.agents.get("kite"))!;
    expect(agent.memory).toEqual({ provider: "supermemory", key_ref: "memory-key" });
    expect(agent.resources.instance_id).toBeString();
    expect(backend.params.get("/hermes/fxtr0001/kite/memory-key")).toBe(FIXTURE_MEMORY_KEY);
  });

  /**
   * `recreate` re-renders from the row (`renderFor`), so the provider the agent
   * was created with survives it — and a fleet default changed since does not
   * move it.
   */
  test("a recreate renders the row's provider again", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
    await hermetic.settings.set({ default_memory_provider: "supermemory" });
    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));
    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.memory).toEqual({ provider: "holographic", key_ref: null });
    const tarball = backend.objects.get(after.resources.config_key!)!;
    const text = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(tarball)));
    expect(text).toInclude('memory:\n  provider: "holographic"\n');
    expect(text).not.toInclude("supermemory");
  });

  test("the fixture seeds one local and one keyed agent, and reads surface them", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
    expect((await hermetic.agents.get("atlas")).memory).toEqual({
      provider: "holographic",
      key_ref: null,
    });
    expect((await hermetic.agents.get("corvid")).memory).toEqual({
      provider: "supermemory",
      key_ref: "memory-key",
    });
    expect(backend.params.get("/hermes/fxtr0001/corvid/memory-key")).toBe(FIXTURE_MEMORY_KEY);
    expect(backend.params.get(SUPERMEMORY_SLOT)).toBe(FIXTURE_MEMORY_KEY);
    expect(backend.fleetItem!.settings!.default_memory_provider).toBeUndefined();
  });
});

describe("settings: the fleet's default memory provider", () => {
  test("set, read back, and cleared", async () => {
    const { hermetic } = freshFleet();
    expect((await hermetic.settings.get()).settings.default_memory_provider).toBeUndefined();

    const set = await hermetic.settings.set({ default_memory_provider: "mem0" });
    expect(set.settings.default_memory_provider).toBe("mem0");
    expect((await hermetic.settings.get()).settings.default_memory_provider).toBe("mem0");

    // Another write leaves it alone.
    await hermetic.settings.set({ auto_update_hermeticd: false });
    expect((await hermetic.settings.get()).settings.default_memory_provider).toBe("mem0");

    const cleared = await hermetic.settings.set({ default_memory_provider: null });
    expect(cleared.settings.default_memory_provider).toBeNull();
    expect((await hermetic.settings.get()).settings.default_memory_provider).toBeNull();
  });

  test("a bad id is refused before anything is written", async () => {
    const { backend, hermetic } = freshFleet();
    const version = backend.fleetItem!.settings!.version;
    expect(
      await codeOf(() => hermetic.settings.set({ default_memory_provider: "none" as never })),
    ).not.toBeNull();
    expect(backend.fleetItem!.settings!.version).toBe(version);
  });
});

describe("rendering a memory provider", () => {
  const render = (memory?: RenderInput["memory"]) =>
    renderAgentConfig({
      name: "atlas",
      size: "small",
      provider: "bedrock",
      secrets_mode: "none",
      hermes_version: "0.21.1",
      hermes_ref: "v2026.9.24",
      chrome_ref: "153.0.8010.12",
      region: "us-east-1",
      tailnet: "tail0.ts.net",
      ...(memory === undefined ? {} : { memory }),
    });
  const file = (r: ReturnType<typeof render>, suffix: string) =>
    r.files.find((f) => f.path.endsWith(suffix))?.content ?? "";

  const none = render();
  const local = render({ provider: "holographic" });
  const keyed = render({ provider: "supermemory", key_ref: "memory-key" });

  test("none renders no memory key, no env comment, no manifest field", () => {
    expect(file(none, HERMES_MANAGED_CONFIG)).not.toInclude("memory:");
    expect(file(none, "hermetic-secrets.service")).not.toInclude("memory-key");
    expect(none.manifest.memory).toBeUndefined();
    expect(none.manifest.requires ?? []).not.toContain(MEMORY_PROVIDER_CAPABILITY);
  });

  test("a local provider is selected in the managed config, with no key", () => {
    expect(file(local, HERMES_MANAGED_CONFIG)).toInclude('memory:\n  provider: "holographic"\n');
    // The seed file is the agent's; the binding is not.
    expect(file(local, "/etc/hermes/config.seed.yaml")).not.toInclude('provider: "holographic"');
    expect(file(local, "hermetic-secrets.service")).not.toInclude("memory-key");
    expect(local.manifest.memory).toEqual({ provider: "holographic" });
    expect(local.manifest.requires).toContain("memory-provider");
  });

  test("a keyed provider names its slot and the variable it arrives in", () => {
    expect(file(keyed, HERMES_MANAGED_CONFIG)).toInclude('memory:\n  provider: "supermemory"\n');
    expect(file(keyed, "hermetic-secrets.service")).toInclude(
      "# SUPERMEMORY_API_KEY is read from SSM at this fleet's SSM prefix + atlas/memory-key by hermeticd.",
    );
    expect(keyed.manifest.memory).toEqual({ provider: "supermemory", key_ref: "memory-key" });
    expect(requiredCapabilities(keyed.manifest)).toContain("memory-provider");
    // The key itself is never rendered anywhere.
    for (const f of keyed.files) expect(f.content).not.toInclude(FIXTURE_MEMORY_KEY);
  });

  test("the field is in the hash, and survives a parse", () => {
    expect(local.manifest.config_hash).not.toBe(none.manifest.config_hash);
    expect(keyed.manifest.config_hash).not.toBe(local.manifest.config_hash);
    // Deterministic: the same input renders the same hash.
    expect(render({ provider: "holographic" }).manifest.config_hash).toBe(local.manifest.config_hash);
    expect(AgentConfig.parse(JSON.parse(JSON.stringify(keyed.manifest))).memory).toEqual({
      provider: "supermemory",
      key_ref: "memory-key",
    });
    expect(
      AgentConfig.safeParse({ ...keyed.manifest, memory: { provider: "hindsight" } }).success,
    ).toBe(false);
    // A manifest is a document, not an authorisation: only `memory-key` may be
    // named, so no manifest can point the box at another agent slot.
    for (const key_ref of ["provider-key", "ts-key", "bws-token", "../x", "memory-key-2"]) {
      expect(
        AgentConfig.safeParse({ ...keyed.manifest, memory: { provider: "supermemory", key_ref } })
          .success,
      ).toBe(false);
      // Nor can a render be talked into emitting one.
      expect(() => render({ provider: "supermemory", key_ref })).toThrow();
    }
  });
});
