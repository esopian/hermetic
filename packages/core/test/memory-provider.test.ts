/**
 * The Hermes external memory provider: chosen at `agents.create`, inherited
 * from `settings.default_memory_provider`, pinned on the row, refused before
 * anything exists when the box cannot run it, and rendered — the managed
 * config's `memory.provider` always, and for a service provider its server,
 * its configuration and the manifest block hermeticd installs from.
 */
import { describe, expect, test } from "bun:test";
import { HermeticError } from "../src/errors.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import {
  AgentConfig,
  AgentMemory,
  CreateAgentInput,
  FleetSettings,
  HERMES_ACCOUNT_HOME,
  HERMES_GATEWAY_DROPIN,
  HERMES_MANAGED_CONFIG,
  MEMORY_LLM_ENV_PATH,
  MEMORY_PROVIDERS,
  MEMORY_PROVIDERS_LIST,
  MEMORY_PROVIDER_CAPABILITY,
  MEMORY_PRISM_CAPABILITY,
  MEMORY_PROVIDER_IDS,
  MEMORY_SERVICES,
  MEMORY_SERVICE_CAPABILITY,
  MEMORY_SERVICE_UNIT,
  MemoryProviderChoice,
  PRISM_DATA_DIR,
  PRISM_FASTEMBED_DIR,
  PRISM_TIKTOKEN_DIR,
  SettingsSetInput,
  type MemoryLlmKeyEnv,
  StoredMemoryProviderId,
  isMemoryProvider,
  memoryServiceDir,
  openvikingConfPath,
  requiredCapabilities,
  type Provider,
} from "../src/schema/index.ts";
import { PROVIDER_IDS } from "../src/shared/providers.ts";
import {
  MEMORY_NONE_SPEC,
  MEMORY_RESOURCE_ESTIMATE_NOTE,
  MEMORY_RESOURCE_FACT_KEYS,
  PROVIDER_EMBEDDING_VENDORS,
  memoryResourceFacts,
} from "../src/shared/index.ts";
import { renderAgentConfig, type RenderInput } from "../src/render/render.ts";
import { memoryLlmFor, renderMemory } from "../src/render/render-memory.ts";
import {
  assertMemoryLlm,
  assertMemorySized,
  memoryCapabilities,
  memoryLlmSupported,
  memoryOf,
  resolveMemoryProvider,
} from "../src/agents/lifecycle/memory-binding.ts";
import { drain, freshFleet, testHermetic } from "./helpers.ts";

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (e) {
    return e instanceof HermeticError ? e.code : `not a HermeticError: ${String(e)}`;
  }
}

async function codeOfAsync(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return e instanceof HermeticError ? e.code : `not a HermeticError: ${String(e)}`;
  }
}

/** The refusal itself, for a test that must tell one `VALIDATION` from another. */
async function errorOfAsync(run: () => Promise<unknown>): Promise<HermeticError | null> {
  try {
    await run();
    return null;
  } catch (e) {
    if (e instanceof HermeticError) return e;
    throw e;
  }
}

/** `assertModelId`'s refusal, as opposed to any other `VALIDATION`. */
function expectModelRefused(error: HermeticError | null, provider: string): void {
  expect(error?.code).toBe("VALIDATION");
  expect(error?.message).toInclude(`cannot be handed to the ${provider} memory server`);
}

describe("the memory provider catalogue", () => {
  test("exactly the five providers hermetic can run on the box", () => {
    expect([...MEMORY_PROVIDER_IDS]).toEqual([
      "holographic",
      "hindsight",
      "openviking",
      "honcho",
      "prism",
    ]);
    expect(MEMORY_PROVIDERS_LIST.map((p) => p.id)).toEqual([...MEMORY_PROVIDER_IDS]);
    expect(MEMORY_PROVIDERS.holographic.kind).toBe("in-process");
    expect(MEMORY_PROVIDERS.holographic.min_mem_gib).toBe(0);
    for (const id of ["hindsight", "openviking", "honcho", "prism"] as const) {
      expect(MEMORY_PROVIDERS[id].kind).toBe("service");
      expect(MEMORY_PROVIDERS[id].uses_llm).toBe(id !== "prism");
      expect(MEMORY_SERVICES[id].pin.length).toBeGreaterThan(0);
      expect(MEMORY_SERVICES[id].port).toBeGreaterThan(1024);
      expect(memoryServiceDir(id)).toBe(`/data/hermes/memory/${id}`);
    }
    for (const spec of MEMORY_PROVIDERS_LIST.filter((p) => p.id !== "prism")) {
      expect(spec.docs).toStartWith(
        "https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers",
      );
    }
    for (const s of ["none", "builtin", "default", "", "supermemory", "mem0", "retaindb"])
      expect(isMemoryProvider(s)).toBe(false);
  });
});

describe("memory resource estimates", () => {
  const factsOf = (choice: Parameters<typeof memoryResourceFacts>[0], vendor?: Provider | null) =>
    Object.fromEntries(memoryResourceFacts(choice, vendor).map((f) => [f.key, f.value]));

  test("every provider and none carries complete resources, and every fact has a value", () => {
    for (const r of [...MEMORY_PROVIDERS_LIST.map((p) => p.resources), MEMORY_NONE_SPEC.resources]) {
      expect(r.added_ram.length).toBeGreaterThan(0);
      expect(r.disk.length).toBeGreaterThan(0);
      expect(Number.isInteger(r.services)).toBe(true);
      expect(r.model_calls.length).toBeGreaterThan(0);
      expect(["none", "box", "provider", "provider-or-box"]).toContain(r.embeddings);
      expect(r.storage.length).toBeGreaterThan(0);
    }
    for (const choice of [...MEMORY_PROVIDER_IDS, "none"] as const) {
      const facts = memoryResourceFacts(choice);
      expect(facts.map((f) => f.key)).toEqual([...MEMORY_RESOURCE_FACT_KEYS]);
      for (const f of facts) {
        expect(f.label.length).toBeGreaterThan(0);
        expect(f.value.length).toBeGreaterThan(0);
      }
    }
    expect(MEMORY_NONE_SPEC.label).toBe("None (built-in only)");
    expect(MEMORY_RESOURCE_ESTIMATE_NOTE).toContain("estimates");
  });

  test("the RAM floor is the enforced min_mem_gib, not a second number", () => {
    expect(factsOf("hindsight")["ram_floor"]).toBe(
      `≥ ${String(MEMORY_PROVIDERS.hindsight.min_mem_gib)} GiB`,
    );
    expect(factsOf("openviking")["ram_floor"]).toBe(
      `≥ ${String(MEMORY_PROVIDERS.openviking.min_mem_gib)} GiB`,
    );
    expect(factsOf("holographic")["ram_floor"]).toBe("any size");
    expect(factsOf("none")["ram_floor"]).toBe("—");
    expect(factsOf("honcho")["services"]).toBe("3 (db, api, worker)");
    expect(factsOf("holographic")["services"]).toBe("0 (in Hermes)");
    expect(factsOf("hindsight")["services"]).toBe("1");
  });

  test("openviking's embeddings follow the vendor: provider where it serves them, a local model otherwise", () => {
    const local = PROVIDER_IDS.filter((v) => !PROVIDER_EMBEDDING_VENDORS.includes(v)).sort();
    expect(local).toEqual(["anthropic", "bedrock"]);
    expect(factsOf("openviking")["embeddings"]).toBe("provider (local model on anthropic/bedrock)");
    expect(factsOf("openviking", null)["embeddings"]).toBe(
      "provider (local model on anthropic/bedrock)",
    );
    for (const v of PROVIDER_EMBEDDING_VENDORS)
      expect(factsOf("openviking", v)["embeddings"]).toBe("provider");
    for (const v of local) expect(factsOf("openviking", v)["embeddings"]).toBe("on box (local model)");
    // The others do not move with the vendor.
    expect(factsOf("hindsight", "anthropic")["embeddings"]).toBe("on box");
    expect(factsOf("honcho", "openai")["embeddings"]).toBe("provider");
    expect(factsOf("holographic", "openai")["embeddings"]).toBe("none");
  });
});

describe("memory provider schemas", () => {
  test("a create accepts a provider or `none`, and refuses anything else", () => {
    expect(CreateAgentInput.parse({ name: "kite", memory_provider: "hindsight" }).memory_provider).toBe(
      "hindsight",
    );
    expect(CreateAgentInput.parse({ name: "kite", memory_provider: "none" }).memory_provider).toBe(
      "none",
    );
    expect(CreateAgentInput.parse({ name: "kite" }).memory_provider).toBeUndefined();
    for (const bad of ["supermemory", "builtin", ""])
      expect(CreateAgentInput.safeParse({ name: "kite", memory_provider: bad }).success).toBe(false);
    expect(MemoryProviderChoice.safeParse("").success).toBe(false);
  });

  test("a settings write is strict; a stored fleet default is lenient", () => {
    expect(
      SettingsSetInput.parse({ default_memory_provider: "openviking" }).default_memory_provider,
    ).toBe("openviking");
    expect(
      SettingsSetInput.parse({ default_memory_provider: null }).default_memory_provider,
    ).toBeNull();
    expect(SettingsSetInput.safeParse({ default_memory_provider: "none" }).success).toBe(false);
    expect(SettingsSetInput.safeParse({ default_memory_provider: "mem0" }).success).toBe(false);
    // A default written under a since-removed provider reads as none, not a failed parse.
    expect(FleetSettings.shape.default_memory_provider.parse("mem0")).toBeNull();
    expect(StoredMemoryProviderId.parse("mem0")).toBeNull();
    expect(StoredMemoryProviderId.parse("holographic")).toBe("holographic");
    expect(StoredMemoryProviderId.parse(null)).toBeNull();
  });

  test("a row written under f5ad900 reads as built-in memory, a current one as itself", () => {
    expect(AgentMemory.parse({ provider: "supermemory", key_ref: "memory-key" })).toBeNull();
    expect(AgentMemory.parse({ provider: "holographic", key_ref: null })).toEqual({
      provider: "holographic",
    });
    expect(AgentMemory.parse({ provider: "hindsight" })).toEqual({ provider: "hindsight" });
    expect(AgentMemory.parse(null)).toBeNull();
    expect(AgentMemory.parse("hindsight")).toBeNull();
  });
});

describe("resolving and checking a create's memory provider", () => {
  test("stated wins, absent inherits, `none` overrides the default", () => {
    const fleet = { default_memory_provider: "holographic" as const };
    expect(resolveMemoryProvider("hindsight", fleet)).toBe("hindsight");
    expect(resolveMemoryProvider(undefined, fleet)).toBe("holographic");
    expect(resolveMemoryProvider("none", fleet)).toBeNull();
    expect(resolveMemoryProvider(undefined, {})).toBeNull();
    expect(resolveMemoryProvider(undefined, { default_memory_provider: null })).toBeNull();
    // An unparsed stored default from a removed provider pins nothing.
    expect(resolveMemoryProvider(undefined, { default_memory_provider: "mem0" as never })).toBeNull();
    expect(memoryOf("openviking")).toEqual({ provider: "openviking" });
    expect(memoryOf(null)).toBeNull();
  });

  test("a size too small for the server is MEMORY_PROVIDER_UNDERSIZED", () => {
    for (const size of ["micro", "xxsmall", "xsmall"] as const) {
      expect(codeOf(() => assertMemorySized("hindsight", size, undefined))).toBe(
        "MEMORY_PROVIDER_UNDERSIZED",
      );
    }
    for (const size of ["micro", "xxsmall"] as const) {
      expect(codeOf(() => assertMemorySized("openviking", size, undefined))).toBe(
        "MEMORY_PROVIDER_UNDERSIZED",
      );
    }
    expect(codeOf(() => assertMemorySized("openviking", "xsmall", undefined))).toBeNull();
    expect(codeOf(() => assertMemorySized("hindsight", "small", undefined))).toBeNull();
    expect(codeOf(() => assertMemorySized("holographic", "micro", undefined))).toBeNull();
    expect(codeOf(() => assertMemorySized(null, "micro", undefined))).toBeNull();
    // An explicit instance type's memory is unknown to core: the operator owns it.
    expect(codeOf(() => assertMemorySized("hindsight", "micro", "r8g.large"))).toBeNull();

    let error: HermeticError | null = null;
    try {
      assertMemorySized("hindsight", "xsmall", undefined);
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.details).toEqual({
      provider: "hindsight",
      size: "xsmall",
      mem_gib: 4,
      min_mem_gib: 8,
    });
  });

  test("a vendor the provider cannot call through is MEMORY_LLM_UNSUPPORTED", () => {
    // Every shipped provider but honcho lists every vendor (honcho: `memory-honcho.test.ts`),
    // so the refusal is also exercised on a narrowed spec.
    for (const id of MEMORY_PROVIDER_IDS.filter((p) => p !== "honcho")) {
      for (const vendor of PROVIDER_IDS) {
        expect(codeOf(() => assertMemoryLlm(id, vendor))).toBeNull();
      }
    }
    const narrowed = { vendors: ["anthropic", "openai"] as const satisfies readonly Provider[] };
    expect(memoryLlmSupported(narrowed, "anthropic")).toBe(true);
    expect(memoryLlmSupported(narrowed, "bedrock")).toBe(false);
    expect(codeOf(() => assertMemoryLlm("hindsight", "bedrock", narrowed))).toBe(
      "MEMORY_LLM_UNSUPPORTED",
    );
    expect(codeOf(() => assertMemoryLlm("hindsight", "openai", narrowed))).toBeNull();
    expect(codeOf(() => assertMemoryLlm(null, "bedrock", narrowed))).toBeNull();
  });

  test("the capabilities a choice adds", () => {
    expect(memoryCapabilities(null)).toEqual([]);
    expect(memoryCapabilities("holographic")).toEqual([MEMORY_PROVIDER_CAPABILITY]);
    expect(memoryCapabilities("hindsight")).toEqual([
      MEMORY_PROVIDER_CAPABILITY,
      MEMORY_SERVICE_CAPABILITY,
    ]);
  });
});

describe("mapping the agent's model onto a memory server", () => {
  const NOUS = "https://inference-api.nousresearch.com/v1";
  const VERCEL = "https://ai-gateway.vercel.sh/v1";

  test("hindsight: its own provider names, a base URL for the compatible endpoints", () => {
    const expected: Record<Provider, { provider: string; base?: string; keyed: boolean }> = {
      anthropic: { provider: "anthropic", keyed: true },
      openai: { provider: "openai", keyed: true },
      openrouter: { provider: "openrouter", keyed: true },
      nous: { provider: "openai", base: NOUS, keyed: true },
      vercel: { provider: "openai", base: VERCEL, keyed: true },
      bedrock: { provider: "bedrock", keyed: false },
    };
    for (const vendor of PROVIDER_IDS) {
      const { llm, settings } = memoryLlmFor("hindsight", vendor, "some/model-1");
      const want = expected[vendor];
      expect(llm).toEqual({
        vendor,
        model: "some/model-1",
        key_env: want.keyed ? ["HINDSIGHT_API_LLM_API_KEY"] : [],
      });
      expect(settings.env).toEqual({
        HINDSIGHT_API_LLM_PROVIDER: want.provider,
        HINDSIGHT_API_LLM_MODEL: "some/model-1",
        ...(want.base === undefined ? {} : { HINDSIGHT_API_LLM_BASE_URL: want.base }),
      });
    }
  });

  test("openviking: a litellm route, the route's key variable, an api_base where compatible", () => {
    const expected: Record<Provider, { route: string; base?: string; key_env: MemoryLlmKeyEnv[] }> = {
      anthropic: { route: "anthropic", key_env: ["ANTHROPIC_API_KEY"] },
      openai: { route: "openai", key_env: ["OPENAI_API_KEY"] },
      openrouter: { route: "openrouter", key_env: ["OPENROUTER_API_KEY"] },
      nous: { route: "openai", base: NOUS, key_env: ["OPENAI_API_KEY"] },
      vercel: { route: "openai", base: VERCEL, key_env: ["OPENAI_API_KEY"] },
      bedrock: { route: "bedrock", key_env: [] },
    };
    for (const vendor of PROVIDER_IDS) {
      const { llm, settings } = memoryLlmFor("openviking", vendor, "m-2");
      const want = expected[vendor];
      expect(llm).toEqual({ vendor, model: "m-2", key_env: want.key_env });
      expect(settings.vlm).toEqual({
        provider: "litellm",
        model: `${want.route}/m-2`,
        ...(want.base === undefined ? {} : { api_base: want.base }),
      });
    }
  });

  test("a model id that could break a unit line or ov.conf is refused", () => {
    for (const bad of ["a b", "a\nExecStart=/bin/sh", "x%n", "$HOME/m", "m${X}"]) {
      expect(codeOf(() => memoryLlmFor("openviking", "openai", bad))).toBe("VALIDATION");
      expect(codeOf(() => memoryLlmFor("hindsight", "openai", bad))).toBe("VALIDATION");
      expect(codeOf(() => memoryLlmFor("honcho", "openai", bad))).toBe("VALIDATION");
    }
    expect(codeOf(() => memoryLlmFor("hindsight", "bedrock", "us.anthropic.claude-x-v2:0"))).toBeNull();
  });
});

/** The hindsight plugin's settings, as environment on the Hermes units (`memoryHermesLines`). */
const HINDSIGHT_PLUGIN_ENV = [
  "Environment=HINDSIGHT_MODE=local_external",
  "Environment=HINDSIGHT_API_URL=http://127.0.0.1:8888",
  "Environment=HINDSIGHT_BANK_ID=hermes",
  "Environment=HINDSIGHT_BUDGET=mid",
  "Environment=HINDSIGHT_TIMEOUT=120",
];

describe("renderMemory", () => {
  const unitPath = `/etc/systemd/system/${MEMORY_SERVICE_UNIT}`;
  const base = {
    name: "atlas",
    provider: "anthropic" as Provider,
    model: "claude-sonnet-5",
    region: "us-east-1",
  };

  test("none and holographic render no files, no unit, no Hermes lines", () => {
    const none = renderMemory(base);
    expect(none).toEqual({
      files: [],
      units: [],
      manifestMemory: undefined,
      hermesUnitLines: { ordering: [], service: [] },
    });
    const holo = renderMemory({ ...base, memory: { provider: "holographic" } });
    expect(holo.files).toEqual([]);
    expect(holo.units).toEqual([]);
    expect(holo.manifestMemory).toEqual({ provider: "holographic" });
    expect(holo.hermesUnitLines).toEqual({ ordering: [], service: [] });
  });

  test("hindsight: a loopback server under the data volume; the plugin told by environment", () => {
    const r = renderMemory({ ...base, memory: { provider: "hindsight" } });
    const dir = memoryServiceDir("hindsight");
    expect(r.units).toEqual([MEMORY_SERVICE_UNIT]);
    const unit = r.files.find((f) => f.path === unitPath)!.content;
    expect(unit).not.toInclude("0.0.0.0");
    expect(unit).toInclude("Environment=HINDSIGHT_API_HOST=127.0.0.1\n");
    expect(unit).toInclude("Environment=HINDSIGHT_API_PORT=8888\n");
    expect(unit).toInclude("Environment=HINDSIGHT_API_DATABASE_URL=pg0\n");
    expect(unit).toInclude("Environment=HINDSIGHT_API_LLM_PROVIDER=anthropic\n");
    expect(unit).toInclude("Environment=HINDSIGHT_API_LLM_MODEL=claude-sonnet-5\n");
    expect(unit).toInclude("Environment=HINDSIGHT_API_MODEL_INIT_TIMEOUT=1800\n");
    expect(unit).toInclude(`Environment=HF_HOME=${dir}/hf\n`);
    expect(unit).toInclude(`ExecStart=${dir}/venv/bin/hindsight-api\n`);
    expect(unit).toInclude(`EnvironmentFile=${MEMORY_LLM_ENV_PATH}\n`);
    expect(unit).toInclude("RequiresMountsFor=/data\n");
    expect(unit).toInclude("User=hermes\n");
    expect(unit).toInclude("Environment=HOME=/data/hermes\n");
    expect(unit).not.toInclude("AWS_REGION");

    // No plugin config file: the unit is the only file, and nothing lands under the hermes home.
    expect(r.files.map((f) => f.path)).toEqual([unitPath]);
    expect(r.hermesUnitLines).toEqual({
      ordering: [`Wants=${MEMORY_SERVICE_UNIT}`, `After=${MEMORY_SERVICE_UNIT}`],
      service: HINDSIGHT_PLUGIN_ENV,
    });
    expect(r.manifestMemory).toEqual({
      provider: "hindsight",
      pin: MEMORY_SERVICES.hindsight.pin,
      llm: { vendor: "anthropic", model: "claude-sonnet-5", key_env: ["HINDSIGHT_API_LLM_API_KEY"] },
    });
  });

  test("openviking: ov.conf is strict JSON naming the key by variable only, and Hermes is told the endpoint", () => {
    const r = renderMemory({
      ...base,
      provider: "nous",
      model: "deepseek/x",
      memory: { provider: "openviking" },
    });
    const dir = memoryServiceDir("openviking");
    const unit = r.files.find((f) => f.path === unitPath)!.content;
    expect(unit).not.toInclude("0.0.0.0");
    expect(openvikingConfPath).toBe("/etc/hermetic/memory/ov.conf");
    expect(unit).toInclude(
      `ExecStart=${dir}/venv/bin/openviking-server --config ${openvikingConfPath}\n`,
    );
    expect(unit).toInclude(`EnvironmentFile=${MEMORY_LLM_ENV_PATH}\n`);

    expect(r.files.map((f) => f.path)).toEqual([unitPath, openvikingConfPath]);
    const conf = r.files.find((f) => f.path === openvikingConfPath)!;
    expect({ mode: conf.mode, owner: conf.owner, group: conf.group }).toEqual({
      mode: "0640",
      owner: "root",
      group: "hermes",
    });
    expect(conf.restart_units).toEqual([MEMORY_SERVICE_UNIT]);
    // The one `$`: the embedder's key, by the variable the unit's key file holds.
    expect(conf.content.match(/\$/g)).toEqual(["$"]);
    expect(conf.content).toInclude('"api_key": "${OPENAI_API_KEY}"');
    expect(JSON.parse(conf.content)).toEqual({
      server: { host: "127.0.0.1", port: 1933, auth_mode: null },
      // Provider embeddings get their own store (`OPENVIKING_DATA_DIRS`).
      storage: { workspace: `${dir}/data-remote` },
      embedding: {
        dense: {
          provider: "openai",
          model: "openai/text-embedding-3-small",
          dimension: 1536,
          api_base: "https://inference-api.nousresearch.com/v1",
          api_key: "${OPENAI_API_KEY}",
        },
        allow_metadata_override: true,
      },
      vlm: {
        provider: "litellm",
        model: "openai/deepseek/x",
        api_base: "https://inference-api.nousresearch.com/v1",
      },
    });

    expect(r.hermesUnitLines.service).toEqual([
      "Environment=OPENVIKING_ENDPOINT=http://127.0.0.1:1933",
    ]);
    expect(r.manifestMemory?.llm?.key_env).toEqual(["OPENAI_API_KEY"]);
  });

  test("prism: an environment-only unit, no warm-up, no llm, and Hermes told PRME_API_URL", () => {
    const r = renderMemory({ ...base, memory: { provider: "prism" } });
    const python = `${memoryServiceDir("prism")}/venv/bin/python`;
    expect(r.files.map((f) => f.path)).toEqual([unitPath]);
    const unit = r.files[0]!.content;
    for (const line of [
      `Environment=PRME_DB_PATH=${PRISM_DATA_DIR}/memory.duckdb`,
      `Environment=PRME_VECTOR_PATH=${PRISM_DATA_DIR}/vectors.usearch`,
      `Environment=PRME_LEXICAL_PATH=${PRISM_DATA_DIR}/lexical_index`,
      "Environment=PRME_EMBEDDING_MODEL_NAME=BAAI/bge-small-en-v1.5",
      `Environment=FASTEMBED_CACHE_PATH=${PRISM_FASTEMBED_DIR}`,
      `Environment=TIKTOKEN_CACHE_DIR=${PRISM_TIKTOKEN_DIR}`,
      `ExecStart=${python} -m prme.api --host 127.0.0.1 --port 18010`,
    ]) {
      expect(unit).toInclude(`${line}\n`);
    }
    // The downloads are hermeticd's, at install: nothing holds the unit's start.
    expect(unit).not.toInclude("ExecStartPre=");
    expect(unit).not.toInclude("TimeoutStartSec=");
    // The directory pack, never the single-file `.prme` one.
    expect(unit).not.toInclude("PRME_PACK_PATH");
    expect(r.hermesUnitLines.service).toEqual(["Environment=PRME_API_URL=http://127.0.0.1:18010"]);
    expect(r.manifestMemory).toEqual({ provider: "prism", pin: MEMORY_SERVICES.prism.pin });
  });

  test("bedrock: no key variable, the region on the server's unit", () => {
    for (const provider of ["hindsight", "openviking"] as const) {
      const r = renderMemory({
        name: "atlas",
        provider: "bedrock",
        model: "zai.glm-4.7-flash",
        region: "eu-west-1",
        memory: { provider },
      });
      const unit = r.files.find((f) => f.path === unitPath)!.content;
      for (const v of ["AWS_REGION_NAME", "AWS_REGION", "AWS_DEFAULT_REGION"])
        expect(unit).toInclude(`Environment=${v}=eu-west-1\n`);
      expect(r.manifestMemory?.llm?.key_env).toEqual([]);
    }
  });
});

describe("rendering an agent with each memory provider", () => {
  const render = (memory?: RenderInput["memory"], provider: Provider = "anthropic") =>
    renderAgentConfig({
      name: "atlas",
      size: "small",
      provider,
      secrets_mode: "none",
      hermes_version: "0.21.1",
      hermes_ref: "v2026.9.24",
      chrome_ref: "153.0.8010.12",
      region: "us-east-1",
      tailnet: "tail0.ts.net",
      ...(memory === undefined ? {} : { memory }),
    });
  const file = (r: ReturnType<typeof render>, path: string) =>
    r.files.find((f) => f.path === path)?.content ?? "";
  /** None, and every provider whose model calls `vendor` can serve. */
  const servable = (vendor: Provider): RenderInput["memory"][] => [
    undefined,
    ...MEMORY_PROVIDER_IDS.filter((provider) =>
      MEMORY_PROVIDERS[provider].vendors.includes(vendor),
    ).map((provider) => ({ provider })),
  ];

  const none = render();
  const holo = render({ provider: "holographic" });
  const hind = render({ provider: "hindsight" });
  const ov = render({ provider: "openviking" });

  test("none renders no memory and asks for nothing", () => {
    expect(file(none, HERMES_MANAGED_CONFIG)).not.toInclude("memory:");
    expect(none.manifest.memory).toBeUndefined();
    expect(none.manifest.units).not.toContain(MEMORY_SERVICE_UNIT);
    expect(none.manifest.requires ?? []).not.toContain(MEMORY_PROVIDER_CAPABILITY);
    expect(file(none, "/etc/systemd/system/hermes-dashboard.service")).not.toInclude(
      MEMORY_SERVICE_UNIT,
    );
  });

  test("holographic is the managed config's selection and the memory-provider capability only", () => {
    expect(file(holo, HERMES_MANAGED_CONFIG)).toInclude('memory:\n  provider: "holographic"\n');
    expect(holo.manifest.memory).toEqual({ provider: "holographic" });
    expect(requiredCapabilities(holo.manifest)).toContain(MEMORY_PROVIDER_CAPABILITY);
    expect(requiredCapabilities(holo.manifest)).not.toContain(MEMORY_SERVICE_CAPABILITY);
    expect(holo.manifest.units).not.toContain(MEMORY_SERVICE_UNIT);
  });

  test("a service provider adds its unit, orders Hermes behind it, and asks for both capabilities", () => {
    for (const r of [hind, ov]) {
      expect(r.manifest.units).toContain(MEMORY_SERVICE_UNIT);
      expect(r.manifest.units.indexOf(MEMORY_SERVICE_UNIT)).toBeLessThan(
        r.manifest.units.indexOf("hermes-dashboard.service"),
      );
      expect(r.manifest.requires).toContain(MEMORY_PROVIDER_CAPABILITY);
      expect(r.manifest.requires).toContain(MEMORY_SERVICE_CAPABILITY);
      for (const path of ["/etc/systemd/system/hermes-dashboard.service", HERMES_GATEWAY_DROPIN]) {
        expect(file(r, path)).toInclude(`Wants=${MEMORY_SERVICE_UNIT}\nAfter=${MEMORY_SERVICE_UNIT}\n`);
      }
    }
    const hermesUnits = ["/etc/systemd/system/hermes-dashboard.service", HERMES_GATEWAY_DROPIN];
    for (const path of hermesUnits) {
      expect(file(ov, path)).toInclude("Environment=OPENVIKING_ENDPOINT=http://127.0.0.1:1933\n");
      expect(file(ov, path)).not.toInclude("HINDSIGHT_");
      for (const line of HINDSIGHT_PLUGIN_ENV) expect(file(hind, path)).toInclude(`${line}\n`);
      expect(file(hind, path)).not.toInclude("OPENVIKING_ENDPOINT");
      for (const r of [none, holo]) {
        expect(file(r, path)).not.toInclude("HINDSIGHT_");
        expect(file(r, path)).not.toInclude("OPENVIKING_ENDPOINT");
      }
    }
    expect(hind.manifest.memory?.pin).toBe(MEMORY_SERVICES.hindsight.pin);
    expect(ov.manifest.memory?.pin).toBe(MEMORY_SERVICES.openviking.pin);
  });

  test("prism is `prme` to Hermes, `prism` in the manifest, and asks for its own capability", () => {
    const r = render({ provider: "prism" });
    expect(file(r, HERMES_MANAGED_CONFIG)).toInclude('memory:\n  provider: "prme"\n');
    expect(r.manifest.memory).toEqual({ provider: "prism", pin: MEMORY_SERVICES.prism.pin });
    expect(r.manifest.requires).toEqual(
      expect.arrayContaining([MEMORY_SERVICE_CAPABILITY, MEMORY_PRISM_CAPABILITY]),
    );
    expect(hind.manifest.requires).not.toContain(MEMORY_PRISM_CAPABILITY);
  });

  test("the model the server is told is the agent's own", () => {
    expect(hind.manifest.memory?.llm?.model).toBe("claude-sonnet-5");
    const r = renderAgentConfig({
      name: "atlas",
      size: "small",
      provider: "openrouter",
      secrets_mode: "none",
      hermes_version: "0.21.1",
      hermes_ref: "v2026.9.24",
      chrome_ref: "153.0.8010.12",
      region: "us-east-1",
      tailnet: "tail0.ts.net",
      hermes: { model: "qwen/qwen3-coder" },
      memory: { provider: "hindsight" },
    });
    expect(r.manifest.memory?.llm).toEqual({
      vendor: "openrouter",
      model: "qwen/qwen3-coder",
      key_env: ["HINDSIGHT_API_LLM_API_KEY"],
    });
  });

  /**
   * Root's files phase writes and chowns every rendered file, and the `hermes`
   * account controls every directory entry under its own home — so nothing
   * hermetic renders, for any provider, may land there.
   */
  test("no provider renders a file under the hermes account's home", () => {
    for (const vendor of PROVIDER_IDS) {
      for (const memory of servable(vendor)) {
        const r = render(memory, vendor);
        for (const f of r.files) {
          expect(f.path === HERMES_ACCOUNT_HOME || f.path.startsWith(`${HERMES_ACCOUNT_HOME}/`)).toBe(
            false,
          );
        }
      }
    }
  });

  test("every provider × vendor parses as AgentConfig, hashes apart, and carries no secret", () => {
    const hashes = new Set<string>();
    let renders = 0;
    for (const vendor of PROVIDER_IDS) {
      for (const memory of servable(vendor)) {
        renders += 1;
        const r = render(memory, vendor);
        const parsed = AgentConfig.parse(JSON.parse(JSON.stringify(r.manifest)));
        expect(parsed.memory).toEqual(r.manifest.memory);
        hashes.add(r.manifest.config_hash);
        const serialised = JSON.stringify(r.manifest) + r.files.map((f) => f.content).join("\n");
        expect(serialised).not.toInclude("FIXTURE");
        expect(serialised).not.toMatch(/sk-[A-Za-z0-9]/);
        if (r.manifest.memory?.llm) {
          expect(Object.keys(r.manifest.memory.llm).sort()).toEqual(["key_env", "model", "vendor"]);
        }
      }
    }
    expect(hashes.size).toBe(renders);
    // honcho is refused before render on anthropic and bedrock, and only there.
    expect(renders).toBe(PROVIDER_IDS.length * (MEMORY_PROVIDER_IDS.length + 1) - 2);
  });

  test("a known provider's block is strict; a removed provider's reads as none", () => {
    const forged = { ...hind.manifest, memory: { provider: "hindsight", pin: "" } };
    expect(AgentConfig.safeParse(forged).success).toBe(false);
    // A bundle rendered under f5ad900, still on a box's root volume (`StoredManifestMemory`).
    const stale = AgentConfig.parse({
      ...hind.manifest,
      memory: { provider: "supermemory", key_ref: "memory-key" },
    });
    expect(stale.memory).toBeUndefined();
  });
});

describe("agents.create with a memory provider", () => {
  test("no choice and no fleet default is built-in memory only", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "kite" }));
    const agent = (await backend.store.agents.get("kite"))!;
    expect(agent.memory).toBeNull();
  });

  test("an absent choice inherits the fleet default; `none` overrides it", async () => {
    const { backend, hermetic } = freshFleet();
    await hermetic.settings.set({ default_memory_provider: "hindsight" });
    await drain(hermetic.agents.create({ name: "kite" }));
    expect((await backend.store.agents.get("kite"))!.memory).toEqual({ provider: "hindsight" });
    await drain(hermetic.agents.create({ name: "wren", memory_provider: "none" }));
    expect((await backend.store.agents.get("wren"))!.memory).toBeNull();
  });

  test("a service provider renders its server into the uploaded config", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "kite", memory_provider: "openviking" }));
    const agent = (await backend.store.agents.get("kite"))!;
    expect(agent.memory).toEqual({ provider: "openviking" });
    // No memory secret exists: nothing new under the agent's SSM prefix.
    expect(agent.resources.ssm_paths.some((p) => p.includes("memory"))).toBe(false);
    const tarball = backend.objects.get(agent.resources.config_key!)!;
    const text = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(tarball)));
    expect(text).toInclude(MEMORY_SERVICE_UNIT);
    expect(text).toInclude(MEMORY_SERVICES.openviking.pin);
  });

  test("an undersized create is refused before the name is taken", async () => {
    const { backend, hermetic } = freshFleet();
    expect(
      await codeOfAsync(() =>
        drain(hermetic.agents.create({ name: "kite", size: "xsmall", memory_provider: "hindsight" })),
      ),
    ).toBe("MEMORY_PROVIDER_UNDERSIZED");
    expect(await backend.store.agents.get("kite")).toBeNull();
    expect(backend.mutations).not.toContain("compute.runInstance");

    // An inherited default is checked the same way.
    await hermetic.settings.set({ default_memory_provider: "hindsight" });
    expect(
      await codeOfAsync(() => drain(hermetic.agents.create({ name: "kite", size: "micro" }))),
    ).toBe("MEMORY_PROVIDER_UNDERSIZED");
    // `none`, or a provider that fits, still creates.
    await drain(
      hermetic.agents.create({ name: "kite", size: "xsmall", memory_provider: "openviking" }),
    );
    expect((await backend.store.agents.get("kite"))!.memory).toEqual({ provider: "openviking" });
  });

  /**
   * The model id the server is handed is checked before the name is claimed
   * (`assertMemoryModel`), not first at the render after it — which would
   * leave a claimed row every later render of the agent fails on.
   */
  test("a model id the memory server cannot be handed is refused before the name is taken", async () => {
    const { backend, hermetic } = freshFleet();
    for (const memory_provider of ["hindsight", "openviking"] as const) {
      expectModelRefused(
        await errorOfAsync(() =>
          drain(hermetic.agents.create({ name: "kite", memory_provider, hermes: { model: "x%n" } })),
        ),
        memory_provider,
      );
      expect(await backend.store.agents.get("kite")).toBeNull();
      expect(backend.params.has("/hermes/fxtr0001/kite/ts-key")).toBe(false);
      expect(backend.mutations).not.toContain("compute.runInstance");
    }
  });

  test("a published hermeticd without memory-service refuses a service provider before anything exists", async () => {
    const { backend, hermetic } = freshFleet();
    const manifest = JSON.parse(new TextDecoder().decode(backend.objects.get("manifest.json")!)) as {
      hermeticd: Record<string, unknown>;
    };
    manifest.hermeticd = {
      ...manifest.hermeticd,
      capabilities: [
        "gateway-unit",
        "restart-units",
        "browser-stack",
        "provider-key-ref",
        "managed-env",
        MEMORY_PROVIDER_CAPABILITY,
      ],
    };
    backend.objects.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.create({ name: "kite", memory_provider: "hindsight" }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("HERMETICD_UNAVAILABLE");
    expect(error?.message).toInclude(MEMORY_SERVICE_CAPABILITY);
    expect(await backend.store.agents.get("kite")).toBeNull();
    expect(backend.params.has("/hermes/fxtr0001/kite/ts-key")).toBe(false);

    // The same fleet still creates an in-process provider.
    await drain(hermetic.agents.create({ name: "kite", memory_provider: "holographic" }));
    expect((await backend.store.agents.get("kite"))!.memory).toEqual({ provider: "holographic" });
  });

  /**
   * `recreate` re-renders from the row (`renderFor`), so the provider the agent
   * was created with survives it — and a fleet default changed since does not
   * move it.
   */
  test("a recreate renders the row's provider again", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
    await hermetic.settings.set({ default_memory_provider: "openviking" });
    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));
    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.memory).toEqual({ provider: "holographic" });
    const tarball = backend.objects.get(after.resources.config_key!)!;
    const text = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(tarball)));
    expect(text).toInclude('memory:\n  provider: "holographic"\n');
    expect(text).not.toInclude("openviking");
  });
});

/**
 * `agents.set` re-renders the agent from the row it writes, so a change that
 * leaves the bound memory provider unable to run — or unable to be rendered at
 * all — is refused before the row moves.
 */
describe("agents.set with a memory provider bound", () => {
  async function kite(memory_provider: "hindsight" | "openviking") {
    const fleet = freshFleet();
    await drain(fleet.hermetic.agents.create({ name: "kite", size: "small", memory_provider }));
    const before = (await fleet.backend.store.agents.get("kite"))!;
    expect(before.memory).toEqual({ provider: memory_provider });
    return { ...fleet, before };
  }

  test("a size the server no longer fits in is MEMORY_PROVIDER_UNDERSIZED, the row unchanged", async () => {
    const { backend, hermetic, before } = await kite("hindsight");
    expect(await codeOfAsync(() => hermetic.agents.set({ name: "kite", size: "xsmall" }))).toBe(
      "MEMORY_PROVIDER_UNDERSIZED",
    );
    expect(await backend.store.agents.get("kite")).toEqual(before);
    // A size it still fits is written.
    await hermetic.agents.set({ name: "kite", size: "medium" });
    expect((await backend.store.agents.get("kite"))!.size).toBe("medium");
  });

  test("a model id the server cannot be handed is VALIDATION, the row unchanged", async () => {
    for (const provider of ["hindsight", "openviking"] as const) {
      const { backend, hermetic, before } = await kite(provider);
      // The managed setting, and the model staged with a profile switch.
      expectModelRefused(
        await errorOfAsync(() => hermetic.agents.set({ name: "kite", model: "m${X}" })),
        provider,
      );
      expect(await backend.store.agents.get("kite")).toEqual(before);
      expectModelRefused(
        await errorOfAsync(() =>
          hermetic.agents.set({ name: "kite", provider_profile: "openrouter-cheap", model: "a b" }),
        ),
        provider,
      );
      expect(await backend.store.agents.get("kite")).toEqual(before);
    }
  });
});

describe("settings: the fleet's default memory provider", () => {
  test("set, read back, and cleared", async () => {
    const { hermetic } = freshFleet();
    expect((await hermetic.settings.get()).settings.default_memory_provider).toBeUndefined();

    const set = await hermetic.settings.set({ default_memory_provider: "openviking" });
    expect(set.settings.default_memory_provider).toBe("openviking");
    expect((await hermetic.settings.get()).settings.default_memory_provider).toBe("openviking");

    // Another write leaves it alone.
    await hermetic.settings.set({ auto_update_hermeticd: false });
    expect((await hermetic.settings.get()).settings.default_memory_provider).toBe("openviking");

    const cleared = await hermetic.settings.set({ default_memory_provider: null });
    expect(cleared.settings.default_memory_provider).toBeNull();
    expect((await hermetic.settings.get()).settings.default_memory_provider).toBeNull();
  });

  test("a bad or removed id is refused before anything is written", async () => {
    const { backend, hermetic } = freshFleet();
    const version = backend.fleetItem!.settings!.version;
    for (const bad of ["none", "supermemory"]) {
      expect(
        await codeOfAsync(() => hermetic.settings.set({ default_memory_provider: bad as never })),
      ).not.toBeNull();
    }
    expect(backend.fleetItem!.settings!.version).toBe(version);
  });

  test("a stored default from a removed provider reads as none and is not inherited", async () => {
    const { backend, hermetic } = freshFleet();
    // What the DynamoDB store hands back for a row written under f5ad900: it
    // parses every `_fleet` read through `FleetItem`.
    backend.fleetItem!.settings = FleetSettings.parse({
      ...backend.fleetItem!.settings,
      default_memory_provider: "mem0",
    });
    expect((await hermetic.settings.get()).settings.default_memory_provider).toBeNull();
    await drain(hermetic.agents.create({ name: "kite" }));
    expect((await backend.store.agents.get("kite"))!.memory).toBeNull();
  });
});
