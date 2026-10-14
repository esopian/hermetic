/**
 * honcho, the self-hosted memory server with its own Postgres, and the
 * embedding half of openviking that came with it: what the laptop renders for
 * the box (three units, `honcho.env`, the plugin's `honcho.json`), the mapping
 * of the agent's vendor and model onto Honcho's settings, the refusals made
 * before anything exists, and the capability a honcho manifest asks for.
 */
import { describe, expect, test } from "bun:test";
import { HermeticError } from "../src/errors.ts";
import { FIXTURE_PROFILE_KEY, FIXTURE_SHARED_NOUS_KEY, FIXTURE_TS_KEY } from "../src/backend/memory.ts";
import {
  AGENT_CAPABILITY_LIST,
  AgentConfig,
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_DROPIN,
  HERMES_GATEWAY_UNIT,
  HERMES_MANAGED_CONFIG,
  HONCHO_DB_SOCKET_DIR,
  HONCHO_PG_BIN,
  MEMORY_DB_UNIT,
  MEMORY_HONCHO_CAPABILITY,
  MEMORY_LLM_ENV_PATH,
  MEMORY_PROVIDERS,
  MEMORY_PROVIDER_CAPABILITY,
  MEMORY_SERVICES,
  MEMORY_SERVICE_CAPABILITY,
  MEMORY_SERVICE_UNIT,
  MEMORY_WORKER_UNIT,
  PROVIDERS,
  honchoClientConfPath,
  honchoEnvPath,
  honchoPgDataDir,
  honchoSrcDir,
  honchoTiktokenDir,
  memoryServiceDir,
  OPENVIKING_DATA_DIRS,
  openvikingConfPath,
  openvikingDataDir,
  requiredCapabilities,
  type Provider,
} from "../src/schema/index.ts";
import { PROVIDER_IDS } from "../src/shared/providers.ts";
import { renderAgentConfig, type RenderInput } from "../src/render/render.ts";
import { memoryLlmFor, renderMemory } from "../src/render/render-memory.ts";
import {
  assertMemoryEmbeddingsKept,
  assertMemoryLlm,
  assertMemorySized,
  memoryCapabilities,
} from "../src/agents/lifecycle/memory-binding.ts";
import { drain, freshFleet } from "./helpers.ts";

function errorOf(run: () => unknown): HermeticError | null {
  try {
    run();
    return null;
  } catch (e) {
    if (e instanceof HermeticError) return e;
    throw e;
  }
}

/** A usable openai profile beside the fixture's (its `nous-lab` has no key stored). */
async function withOpenAiProfile(hermetic: ReturnType<typeof freshFleet>["hermetic"]): Promise<void> {
  await hermetic.providers.create({
    provider: "openai",
    name: "openai-main",
    api_key: "sk-FIXTURE-OPENAI-PROFILE",
  });
}

async function errorOfAsync(run: () => Promise<unknown>): Promise<HermeticError | null> {
  try {
    await run();
    return null;
  } catch (e) {
    if (e instanceof HermeticError) return e;
    throw e;
  }
}

const unitPath = (unit: string) => `/etc/systemd/system/${unit}`;
const UNITS = [MEMORY_DB_UNIT, MEMORY_SERVICE_UNIT, MEMORY_WORKER_UNIT] as const;
const GATEWAYS = ["openrouter", "nous", "vercel"] as const satisfies readonly Provider[];

/** Every Honcho function that calls a model, as its settings prefix. */
const FUNCTIONS = [
  "DERIVER_MODEL_CONFIG",
  "SUMMARY_MODEL_CONFIG",
  "DIALECTIC_LEVELS__minimal__MODEL_CONFIG",
  "DIALECTIC_LEVELS__low__MODEL_CONFIG",
  "DIALECTIC_LEVELS__medium__MODEL_CONFIG",
  "DIALECTIC_LEVELS__high__MODEL_CONFIG",
  "DIALECTIC_LEVELS__max__MODEL_CONFIG",
  "DREAM_DEDUCTION_MODEL_CONFIG",
  "DREAM_INDUCTION_MODEL_CONFIG",
];

/** `KEY=value` lines of an EnvironmentFile, comments dropped. */
function envOf(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

function honcho(vendor: Provider = "openai", model = "gpt-5.4-mini") {
  return renderMemory({
    name: "atlas",
    provider: vendor,
    model,
    region: "us-east-1",
    memory: { provider: "honcho" },
  });
}

function fileOf(r: { files: { path: string; content: string }[] }, path: string): string {
  const f = r.files.find((x) => x.path === path);
  expect(f).toBeDefined();
  return f!.content;
}

describe("honcho in the catalogue", () => {
  test("a service on the embedding vendors only, sized for three processes", () => {
    const spec = MEMORY_PROVIDERS.honcho;
    expect(spec.kind).toBe("service");
    expect([...spec.vendors]).toEqual(["openai", "openrouter", "nous", "vercel"]);
    expect(spec.vendors_note).toBeDefined();
    expect(MEMORY_SERVICES.honcho.port).toBe(18000);
    expect(memoryServiceDir("honcho")).toBe("/data/hermes/memory/honcho");
    expect(errorOf(() => assertMemorySized("honcho", "xxsmall", undefined))?.code).toBe(
      "MEMORY_PROVIDER_UNDERSIZED",
    );
    expect(errorOf(() => assertMemorySized("honcho", "xsmall", undefined))).toBeNull();
  });
});

describe("renderMemory: honcho", () => {
  test("three units, in start order, and the two files they and Hermes read", () => {
    const r = honcho();
    expect(r.units).toEqual([MEMORY_DB_UNIT, MEMORY_SERVICE_UNIT, MEMORY_WORKER_UNIT]);
    expect(r.files.map((f) => f.path)).toEqual([
      ...UNITS.map(unitPath),
      honchoEnvPath,
      honchoClientConfPath,
    ]);
    expect(r.manifestMemory).toEqual({
      provider: "honcho",
      pin: MEMORY_SERVICES.honcho.pin,
      llm: { vendor: "openai", model: "gpt-5.4-mini", key_env: ["LLM_OPENAI_API_KEY"] },
    });
  });

  test("the database has no TCP listener and a socket only the account can reach", () => {
    const db = fileOf(honcho(), unitPath(MEMORY_DB_UNIT));
    const exec = db.split("\n").find((l) => l.startsWith("ExecStart="))!;
    expect(exec).toStartWith(`ExecStart=${HONCHO_PG_BIN}/postgres -D ${honchoPgDataDir} `);
    // `listen_addresses` empty: the very next word is another option.
    expect(exec).toInclude(" -c listen_addresses= -c ");
    expect(exec).toInclude(` -c unix_socket_directories=${HONCHO_DB_SOCKET_DIR}`);
    expect(exec).not.toMatch(/listen_addresses=\S/);
    expect(exec).not.toMatch(/\bport=/);
    expect(db).toInclude(`RuntimeDirectory=${HONCHO_DB_SOCKET_DIR.slice("/run/".length)}\n`);
    expect(db).toInclude("RuntimeDirectoryMode=0700\n");
    expect(db).toInclude("Type=notify\n");
    expect(db).toInclude("KillMode=mixed\nKillSignal=SIGINT\n");
    // Finite: Hermes orders after the API, which orders after this.
    expect(db).toInclude("TimeoutStartSec=300\n");
    expect(db).not.toInclude("infinity");
    expect(db).not.toInclude("EnvironmentFile=");
  });

  test("the API binds loopback after migrating; the worker follows it", () => {
    const r = honcho();
    const venv = `${memoryServiceDir("honcho")}/venv/bin`;
    const api = fileOf(r, unitPath(MEMORY_SERVICE_UNIT));
    expect(api).toInclude(
      `ExecStart=${venv}/uvicorn src.main:app --host 127.0.0.1 --port 18000 --workers 1\n`,
    );
    expect(api).toInclude(`ExecStartPre=${venv}/python scripts/provision_db.py\n`);
    expect(api).toInclude(`Requires=${MEMORY_DB_UNIT}\nAfter=${MEMORY_DB_UNIT}\n`);
    expect(api).toInclude("TimeoutStartSec=600\n");
    const worker = fileOf(r, unitPath(MEMORY_WORKER_UNIT));
    expect(worker).toInclude(`ExecStart=${venv}/python -m src.deriver\n`);
    expect(worker).toInclude(
      `Requires=${MEMORY_DB_UNIT}\nAfter=${MEMORY_DB_UNIT}\nAfter=${MEMORY_SERVICE_UNIT}\n`,
    );
    for (const unit of [api, worker]) {
      expect(unit).not.toInclude("0.0.0.0");
      expect(unit).toInclude(`WorkingDirectory=${honchoSrcDir}\n`);
      // Settings first, the key file last: nothing in the settings can shadow the key.
      expect(unit).toInclude(
        `EnvironmentFile=${honchoEnvPath}\nEnvironmentFile=${MEMORY_LLM_ENV_PATH}\n`,
      );
      expect(unit).toInclude("Requires=hermetic-secrets.service\n");
      expect(unit).toInclude("Restart=always\n");
    }
  });

  test("all three run as hermes from the data volume, and wait for it", () => {
    const r = honcho();
    for (const unit of UNITS) {
      const content = fileOf(r, unitPath(unit));
      expect(content).toInclude("RequiresMountsFor=/data\n");
      expect(content).toInclude("User=hermes\nGroup=hermes\n");
      expect(content).toInclude("NoNewPrivileges=yes\n");
      expect(content).toInclude("WantedBy=multi-user.target\n");
    }
    for (const dir of [honchoPgDataDir, honchoSrcDir, honchoTiktokenDir, memoryServiceDir("honcho")]) {
      expect(dir).toStartWith("/data/");
    }
    // Every absolute path the units and settings name is the data volume, the
    // runtime socket, the distro's Postgres binaries, or a file under /etc.
    const named = [...UNITS.map(unitPath), honchoEnvPath]
      .map((p) => fileOf(r, p))
      .join("\n")
      .match(/(?<![\w:@/])\/[A-Za-z0-9._/-]+/g)!;
    const allowed = [
      "/data/",
      HONCHO_DB_SOCKET_DIR,
      `${HONCHO_PG_BIN}/`,
      "/etc/hermetic/",
      "/run/hermetic/",
    ];
    for (const path of named) {
      expect({
        path,
        allowed: path === "/data" || allowed.some((prefix) => path.startsWith(prefix)),
      }).toEqual({
        path,
        allowed: true,
      });
    }
  });

  test("honcho.env: no secret, everything off that would phone home, the pools inside max_connections", () => {
    const r = honcho();
    const file = r.files.find((f) => f.path === honchoEnvPath)!;
    expect({ mode: file.mode, owner: file.owner, group: file.group }).toEqual({
      mode: "0640",
      owner: "root",
      group: "hermes",
    });
    expect(file.restart_units).toEqual([MEMORY_SERVICE_UNIT, MEMORY_WORKER_UNIT]);
    const env = envOf(file.content);
    expect(env).toMatchObject({
      PYTHON_DOTENV_DISABLED: "1",
      HONCHO_CONFIG_TOML_DISABLED: "1",
      DB_CONNECTION_URI: `postgresql+psycopg://hermes@/honcho?host=${HONCHO_DB_SOCKET_DIR}`,
      AUTH_USE_AUTH: "false",
      SENTRY_ENABLED: "false",
      TELEMETRY_ENABLED: "false",
      METRICS_ENABLED: "false",
      CACHE_ENABLED: "false",
      VECTOR_STORE_TYPE: "pgvector",
      TIKTOKEN_CACHE_DIR: honchoTiktokenDir,
      DERIVER_WORKERS: "1",
      EMBEDDING_VECTOR_DIMENSIONS: "1536",
    });
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/API_KEY|SECRET|PASSWORD|LANGFUSE/);
    }
    const db = fileOf(r, unitPath(MEMORY_DB_UNIT));
    const maxConnections = Number(/-c max_connections=(\d+)/.exec(db)![1]);
    const perProcess = Number(env["DB_POOL_SIZE"]) + Number(env["DB_MAX_OVERFLOW"]);
    // API + worker, plus the migration, Postgres's three reserved slots and a psql.
    expect(2 * perProcess + 1 + 3 + 1).toBeLessThanOrEqual(maxConnections);
  });

  test("honcho.json: the loopback server, the agent as AI peer, an explicit observation mode", () => {
    const r = honcho();
    const file = r.files.find((f) => f.path === honchoClientConfPath)!;
    expect({ mode: file.mode, owner: file.owner, group: file.group }).toEqual({
      mode: "0640",
      owner: "root",
      group: "hermes",
    });
    expect(file.restart_units).toEqual([HERMES_DASHBOARD_UNIT, HERMES_GATEWAY_UNIT]);
    expect(JSON.parse(file.content)).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:18000",
      workspace: "hermes",
      aiPeer: "atlas",
      peerName: "user",
      sessionStrategy: "per-session",
      observationMode: "directional",
    });
    expect(r.hermesUnitLines).toEqual({
      ordering: [`Wants=${MEMORY_SERVICE_UNIT}`, `After=${MEMORY_SERVICE_UNIT}`],
      service: ["Environment=HONCHO_BASE_URL=http://127.0.0.1:18000"],
    });
  });
});

describe("mapping the agent's vendor onto Honcho", () => {
  test("openai: its own endpoint, the bare model names, upstream's structured output", () => {
    const { llm, settings } = memoryLlmFor("honcho", "openai", "gpt-5.4-mini");
    expect(llm).toEqual({ vendor: "openai", model: "gpt-5.4-mini", key_env: ["LLM_OPENAI_API_KEY"] });
    const expected: Record<string, string> = {};
    for (const f of FUNCTIONS) {
      expected[`${f}__TRANSPORT`] = "openai";
      expected[`${f}__MODEL`] = "gpt-5.4-mini";
    }
    expect(settings.env).toEqual({
      ...expected,
      EMBEDDING_MODEL_CONFIG__TRANSPORT: "openai",
      EMBEDDING_MODEL_CONFIG__MODEL: "text-embedding-3-small",
      EMBEDDING_VECTOR_DIMENSIONS: "1536",
      EMBEDDING_MODEL_CONFIG__DIMENSIONS_MODE: "never",
    });
  });

  test("the gateways: their base URL for models and embeddings, the routed embedding model, json_object", () => {
    for (const vendor of GATEWAYS) {
      const { llm, settings } = memoryLlmFor("honcho", vendor, "deepseek/deepseek-v4.1-flash");
      expect(llm.key_env).toEqual(["LLM_OPENAI_API_KEY"]);
      const base = PROVIDERS[vendor].base_url!;
      const expected: Record<string, string> = { LLM_OPENAI_BASE_URL: base };
      for (const f of FUNCTIONS) {
        expected[`${f}__TRANSPORT`] = "openai";
        expected[`${f}__MODEL`] = "deepseek/deepseek-v4.1-flash";
        expected[`${f}__STRUCTURED_OUTPUT_MODE`] = "json_object";
      }
      expect(settings.env).toEqual({
        ...expected,
        EMBEDDING_MODEL_CONFIG__TRANSPORT: "openai",
        EMBEDDING_MODEL_CONFIG__MODEL: "openai/text-embedding-3-small",
        EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL: base,
        EMBEDDING_VECTOR_DIMENSIONS: "1536",
        EMBEDDING_MODEL_CONFIG__DIMENSIONS_MODE: "never",
      });
    }
  });

  test("anthropic and bedrock cannot be mapped at all", () => {
    for (const vendor of ["anthropic", "bedrock"] as const) {
      expect(errorOf(() => memoryLlmFor("honcho", vendor, "m-1"))?.code).toBe("MEMORY_LLM_UNSUPPORTED");
    }
  });
});

describe("refusing honcho on a vendor with no embeddings", () => {
  test("assertMemoryLlm names the reason the catalogue gives", () => {
    for (const vendor of PROVIDER_IDS) {
      const error = errorOf(() => assertMemoryLlm("honcho", vendor));
      if (vendor === "anthropic" || vendor === "bedrock") {
        expect(error?.code).toBe("MEMORY_LLM_UNSUPPORTED");
        expect(error?.message).toInclude(MEMORY_PROVIDERS.honcho.vendors_note!);
        expect(error?.details).toEqual({ provider: "honcho", vendor });
      } else {
        expect(error).toBeNull();
      }
    }
  });

  test("a create is refused before the name is claimed", async () => {
    const { backend, hermetic } = freshFleet();
    // The fleet's default profile is anthropic; bedrock-role is a role profile.
    for (const input of [{}, { provider_profile: "bedrock-role" }]) {
      const error = await errorOfAsync(() =>
        drain(hermetic.agents.create({ name: "kite", memory_provider: "honcho", ...input })),
      );
      expect(error?.code).toBe("MEMORY_LLM_UNSUPPORTED");
      // `assertMemoryLlm`'s refusal, not the render's backstop.
      expect(error?.message).toInclude(MEMORY_PROVIDERS.honcho.vendors_note!);
      expect(await backend.store.agents.get("kite")).toBeNull();
      expect(backend.params.has("/hermes/fxtr0001/kite/ts-key")).toBe(false);
      expect(backend.mutations).not.toContain("compute.runInstance");
    }
  });

  test("a set onto anthropic or bedrock is refused, the row unchanged", async () => {
    const { backend, hermetic } = freshFleet();
    await withOpenAiProfile(hermetic);
    await drain(
      hermetic.agents.create({
        name: "kite",
        memory_provider: "honcho",
        provider_profile: "openrouter-cheap",
      }),
    );
    const before = (await backend.store.agents.get("kite"))!;
    expect(before.memory).toEqual({ provider: "honcho" });
    for (const provider_profile of ["anthropic-main", "bedrock-role"]) {
      const error = await errorOfAsync(() => hermetic.agents.set({ name: "kite", provider_profile }));
      expect(error?.code).toBe("MEMORY_LLM_UNSUPPORTED");
      expect(error?.message).toInclude(MEMORY_PROVIDERS.honcho.vendors_note!);
      expect(await backend.store.agents.get("kite")).toEqual(before);
    }
    // Another embedding vendor is a binding like any other.
    await hermetic.agents.set({ name: "kite", provider_profile: "openai-main" });
    expect((await backend.store.agents.get("kite"))!.pending?.provider).toBe("openai");
  });

  test("a created agent's uploaded config carries no secret", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(
      hermetic.agents.create({
        name: "kite",
        memory_provider: "honcho",
        provider_profile: "openrouter-cheap",
      }),
    );
    const agent = (await backend.store.agents.get("kite"))!;
    const tarball = backend.objects.get(agent.resources.config_key!)!;
    const text = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(tarball)));
    expect(text).toInclude(honchoEnvPath.slice(1));
    expect(text).toInclude("LLM_OPENAI_BASE_URL=https://openrouter.ai/api/v1");
    for (const secret of [FIXTURE_PROFILE_KEY, FIXTURE_SHARED_NOUS_KEY, FIXTURE_TS_KEY]) {
      expect(text).not.toInclude(secret);
    }
    expect(text).not.toMatch(/FIXTURE|sk-or-|tskey-/);
  });
});

describe("rendering an agent with honcho", () => {
  const render = (provider: Provider = "openrouter") =>
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
      memory: { provider: "honcho" },
    } satisfies RenderInput);

  test("the manifest names all three units ahead of Hermes, and asks for memory-honcho", () => {
    const r = render();
    const units = r.manifest.units;
    for (const unit of UNITS) {
      expect(units.indexOf(unit)).toBeGreaterThanOrEqual(0);
      expect(units.indexOf(unit)).toBeLessThan(units.indexOf(HERMES_DASHBOARD_UNIT));
    }
    expect(r.manifest.requires).toEqual(
      expect.arrayContaining([
        MEMORY_PROVIDER_CAPABILITY,
        MEMORY_SERVICE_CAPABILITY,
        MEMORY_HONCHO_CAPABILITY,
      ]),
    );
    expect(AgentConfig.parse(JSON.parse(JSON.stringify(r.manifest))).memory?.provider).toBe("honcho");
    const managed = r.files.find((f) => f.path === HERMES_MANAGED_CONFIG)!.content;
    expect(managed).toInclude('memory:\n  provider: "honcho"\n');
    for (const path of [unitPath(HERMES_DASHBOARD_UNIT), HERMES_GATEWAY_DROPIN]) {
      expect(r.files.find((f) => f.path === path)!.content).toInclude(
        "Environment=HONCHO_BASE_URL=http://127.0.0.1:18000\n",
      );
    }
  });

  test("the capability is derived from the document, and only for honcho", () => {
    expect(memoryCapabilities("honcho")).toEqual([
      MEMORY_PROVIDER_CAPABILITY,
      MEMORY_SERVICE_CAPABILITY,
      MEMORY_HONCHO_CAPABILITY,
    ]);
    for (const id of ["holographic", "hindsight", "openviking"] as const) {
      expect(memoryCapabilities(id)).not.toContain(MEMORY_HONCHO_CAPABILITY);
    }
    expect(requiredCapabilities(render().manifest)).toContain(MEMORY_HONCHO_CAPABILITY);
    expect(
      requiredCapabilities({ units: [], files: [], memory: { provider: "openviking", pin: "x" } }),
    ).not.toContain(MEMORY_HONCHO_CAPABILITY);
    expect(AGENT_CAPABILITY_LIST).toContain(MEMORY_HONCHO_CAPABILITY);
  });

  test("a published hermeticd without memory-honcho refuses a honcho create before anything exists", async () => {
    const { backend, hermetic } = freshFleet();
    const manifest = JSON.parse(new TextDecoder().decode(backend.objects.get("manifest.json")!)) as {
      hermeticd: { capabilities?: string[] };
    };
    manifest.hermeticd.capabilities = (manifest.hermeticd.capabilities ?? []).filter(
      (c) => c !== MEMORY_HONCHO_CAPABILITY,
    );
    backend.objects.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
    const error = await errorOfAsync(() =>
      drain(
        hermetic.agents.create({
          name: "kite",
          memory_provider: "honcho",
          provider_profile: "openrouter-cheap",
        }),
      ),
    );
    expect(error?.code).toBe("HERMETICD_UNAVAILABLE");
    expect(error?.message).toInclude(MEMORY_HONCHO_CAPABILITY);
    expect(await backend.store.agents.get("kite")).toBeNull();
  });
});

describe("openviking: embeddings through the vendor where it serves them", () => {
  const conf = (vendor: Provider) => {
    const r = renderMemory({
      name: "atlas",
      provider: vendor,
      model: "m-1",
      region: "us-east-1",
      memory: { provider: "openviking" },
    });
    return JSON.parse(r.files.find((f) => f.path === openvikingConfPath)!.content) as {
      embedding: Record<string, unknown>;
      storage: { workspace: string };
    };
  };
  const dir = memoryServiceDir("openviking");

  test("per vendor: the provider model at 1536 with the key by reference, or the local model", () => {
    const expected: Record<Provider, Record<string, unknown>> = {
      openai: {
        dense: {
          provider: "openai",
          model: "text-embedding-3-small",
          dimension: 1536,
          api_key: "${OPENAI_API_KEY}",
        },
        allow_metadata_override: true,
      },
      openrouter: {
        dense: {
          provider: "openai",
          model: "openai/text-embedding-3-small",
          dimension: 1536,
          api_base: "https://openrouter.ai/api/v1",
          api_key: "${OPENROUTER_API_KEY}",
        },
        allow_metadata_override: true,
      },
      nous: {
        dense: {
          provider: "openai",
          model: "openai/text-embedding-3-small",
          dimension: 1536,
          api_base: "https://inference-api.nousresearch.com/v1",
          api_key: "${OPENAI_API_KEY}",
        },
        allow_metadata_override: true,
      },
      vercel: {
        dense: {
          provider: "openai",
          model: "openai/text-embedding-3-small",
          dimension: 1536,
          api_base: "https://ai-gateway.vercel.sh/v1",
          api_key: "${OPENAI_API_KEY}",
        },
        allow_metadata_override: true,
      },
      anthropic: {
        dense: { provider: "local", model: "bge-small-zh-v1.5-f16", cache_dir: `${dir}/models` },
      },
      bedrock: {
        dense: { provider: "local", model: "bge-small-zh-v1.5-f16", cache_dir: `${dir}/models` },
      },
    };
    for (const vendor of PROVIDER_IDS) {
      expect(conf(vendor).embedding).toEqual(expected[vendor]);
      // Each embedding mode has its own store, so a flip never meets the other width.
      const remote = vendor !== "anthropic" && vendor !== "bedrock";
      expect(conf(vendor).storage.workspace).toBe(
        `${dir}/${remote ? OPENVIKING_DATA_DIRS.remote : OPENVIKING_DATA_DIRS.local}`,
      );
      expect(conf(vendor).storage.workspace).toBe(openvikingDataDir(remote));
    }
    // The local store keeps the path every store before provider embeddings had.
    expect(openvikingDataDir(false)).toBe(`${dir}/data`);
    expect(OPENVIKING_DATA_DIRS.remote).not.toBe(OPENVIKING_DATA_DIRS.local);
  });

  test("the key reference is the only `${` a full render lets through, and only in ov.conf", () => {
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
      memory: { provider: "openviking" },
    });
    const withRef = r.files
      .filter((f) => f.content.includes("${OPENROUTER_API_KEY}"))
      .map((f) => f.path);
    expect(withRef.sort()).toEqual([openvikingConfPath, "/etc/hermetic/manifest.json"].sort());
  });

  test("assertMemoryEmbeddingsKept: remote to remote and local to local pass, a flip does not", () => {
    expect(errorOf(() => assertMemoryEmbeddingsKept("openviking", "openai", "nous"))).toBeNull();
    expect(errorOf(() => assertMemoryEmbeddingsKept("openviking", "anthropic", "bedrock"))).toBeNull();
    for (const [from, to] of [
      ["anthropic", "openai"],
      ["openrouter", "bedrock"],
    ] as const) {
      const error = errorOf(() => assertMemoryEmbeddingsKept("openviking", from, to));
      expect(error?.code).toBe("MEMORY_LLM_UNSUPPORTED");
      expect(error?.details).toEqual({ provider: "openviking", from, to });
    }
    // Only openviking stores vectors whose width the vendor decides.
    expect(errorOf(() => assertMemoryEmbeddingsKept("hindsight", "anthropic", "openai"))).toBeNull();
    expect(errorOf(() => assertMemoryEmbeddingsKept(null, "anthropic", "openai"))).toBeNull();
  });

  test("agents.set refuses the flip, the row unchanged, and allows a move between embedding vendors", async () => {
    const { backend, hermetic } = freshFleet();
    await withOpenAiProfile(hermetic);
    await drain(hermetic.agents.create({ name: "kite", memory_provider: "openviking" }));
    const local = (await backend.store.agents.get("kite"))!;
    expect(local.provider).toBe("anthropic");
    const error = await errorOfAsync(() =>
      hermetic.agents.set({ name: "kite", provider_profile: "openrouter-cheap" }),
    );
    expect(error?.code).toBe("MEMORY_LLM_UNSUPPORTED");
    expect(error?.message).toInclude("embed");
    // The other store opens empty; the current one is kept, unused — not lost on disk.
    expect(error?.message).toInclude("empty data-remote store");
    expect(error?.message).toInclude("in data would stay on disk unused");
    expect(await backend.store.agents.get("kite")).toEqual(local);
    // Onto the other local vendor is fine.
    await hermetic.agents.set({ name: "kite", provider_profile: "bedrock-role" });
    expect((await backend.store.agents.get("kite"))!.pending?.provider).toBe("bedrock");

    await drain(
      hermetic.agents.create({
        name: "wren",
        memory_provider: "openviking",
        provider_profile: "openrouter-cheap",
      }),
    );
    await hermetic.agents.set({ name: "wren", provider_profile: "openai-main" });
    expect((await backend.store.agents.get("wren"))!.pending?.provider).toBe("openai");
    expect(
      (
        await errorOfAsync(() =>
          hermetic.agents.set({ name: "wren", provider_profile: "anthropic-main" }),
        )
      )?.code,
    ).toBe("MEMORY_LLM_UNSUPPORTED");
  });
});
