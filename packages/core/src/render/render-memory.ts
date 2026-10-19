/**
 * The external memory provider's half of an agent's configuration: the server
 * a service provider runs beside Hermes (`MEMORY_SERVICE_UNIT`), its own
 * configuration, what the Hermes units need to find it, and the manifest's
 * `memory` block hermeticd installs from. Final file content, no templating —
 * see `render.ts`.
 *
 * An in-process provider (`holographic`) renders nothing here: the managed
 * `config.yaml`'s `memory.provider` (`render-hermes.ts`) is all it needs.
 *
 * **The model a service calls.** hindsight extracts facts, openviking
 * summarises sessions and honcho reasons over conversations with a model, and
 * none has an account of its own: each uses the agent's bound vendor and model
 * (§8.3), mapped here onto the server's own settings (`memoryLlmFor`). honcho
 * and (where the vendor serves one) openviking also embed through the vendor's
 * OpenAI-compatible `/embeddings` endpoint — the store stays on the box. The key is never rendered. The
 * manifest names the variable(s) the server reads it from
 * (`memory.llm.key_env`), and hermeticd copies the agent's provider key under
 * each into `MEMORY_LLM_ENV_PATH` — tmpfs, root-only, loaded by the memory
 * unit alone, so an alias such as `OPENAI_API_KEY` for a Nous key never
 * reaches Hermes's own environment. Bedrock has no key: the server signs as
 * the instance role, and is told the region.
 *
 * **Loopback only.** No server authenticates its callers, so each is bound
 * to 127.0.0.1 explicitly — hindsight's own default is 0.0.0.0 — and the box's
 * nftables ruleset is the second wall, not the first. honcho's Postgres has no
 * TCP listener at all (`render-memory-honcho.ts`).
 */
import type {
  ManifestMemory,
  MemoryLlm,
  MemoryLlmKeyEnv,
  Provider,
  RenderedFile,
} from "../schema/index.ts";
import {
  HERMES_ACCOUNT_HOME,
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_UNIT,
  MEMORY_DB_UNIT,
  MEMORY_LLM_ENV_PATH,
  MEMORY_PROVIDERS,
  MEMORY_SERVICES,
  MEMORY_SERVICE_UNIT,
  MEMORY_WORKER_UNIT,
  PROVIDERS,
  PROVIDER_EMBEDDING_DIMENSION,
  honchoClientConfPath,
  honchoEnvPath,
  honchoSrcDir,
  memoryServiceDir,
  openvikingConfPath,
  openvikingDataDir,
  providerEmbeddingModel,
} from "../schema/index.ts";
import type { MemoryProvider } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import {
  HONCHO_LOOPBACK_URL,
  honchoClientConf,
  honchoDbDependency,
  honchoDbUnit,
  honchoEnvFile,
  honchoLlmEnv,
  honchoWorkerOrdering,
} from "./render-memory-honcho.ts";

/** The providers that run a server, and so have a `MEMORY_SERVICES` entry. */
export type MemoryServiceProvider = keyof typeof MEMORY_SERVICES;

export function isMemoryServiceProvider(id: MemoryProvider): id is MemoryServiceProvider {
  return MEMORY_PROVIDERS[id].kind === "service";
}

/** What `memoryLlmFor` maps a vendor to for hindsight: its `HINDSIGHT_API_LLM_*` environment. */
export interface HindsightLlmSettings {
  readonly env: Readonly<Record<string, string>>;
}

/** What `memoryLlmFor` maps a vendor to for openviking: the `vlm` block of `ov.conf`. */
export interface OpenVikingLlmSettings {
  readonly vlm: { readonly provider: "litellm"; readonly model: string; readonly api_base?: string };
}

/** What `memoryLlmFor` maps a vendor to for honcho: model and embedding environment (`honcho.env`). */
export interface HonchoLlmSettings {
  readonly env: Readonly<Record<string, string>>;
}

/**
 * A model id goes into a unit's `Environment=` line, into `honcho.env` (an
 * `EnvironmentFile`) and into `ov.conf`, which the server runs
 * `os.path.expandvars` over. `HermesSettings.model` is
 * free-form, so the id is held to the characters model ids are spelled in: no
 * whitespace or newline (a unit line), no `%` (a systemd specifier), no `$`
 * (an expansion in either file).
 */
const MODEL_ID = /^[A-Za-z0-9._:/@+-]+$/;

export function assertModelId(provider: MemoryServiceProvider, model: string): void {
  if (MODEL_ID.test(model)) return;
  throw new HermeticError(
    "VALIDATION",
    `model ${JSON.stringify(model)} cannot be handed to the ${provider} memory server: ` +
      "a model id may contain only letters, digits and . _ : / @ + -",
    { provider, model },
  );
}

/** The variable litellm reads each keyed route's key from (`MEMORY_LLM_KEY_ENVS`). */
const LITELLM_KEY_ENV: Readonly<Partial<Record<Provider, MemoryLlmKeyEnv>>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** Vendors reached through an OpenAI-compatible endpoint the memory server must be pointed at. */
function compatibleBaseUrl(vendor: Provider): string | null {
  return vendor === "nous" || vendor === "vercel" ? PROVIDERS[vendor].base_url : null;
}

/**
 * Map the agent's bound vendor and model onto a memory server's own LLM
 * settings, and the variable name(s) the box hands it the key under.
 *
 * hindsight speaks `anthropic`, `openai`, `openrouter` and `bedrock` natively;
 * Nous and Vercel are OpenAI-compatible endpoints, so they go through its
 * `openai` provider with `HINDSIGHT_API_LLM_BASE_URL`. openviking routes through
 * litellm, whose `<vendor>/<model>` route picks the client and whose
 * conventional `<VENDOR>_API_KEY` variable carries the key; Nous and Vercel
 * again ride the `openai/` route with an `api_base`. honcho speaks only
 * OpenAI-compatible endpoints for the vendors it is offered on
 * (`honchoLlmEnv`), and reads the key as `LLM_OPENAI_API_KEY`.
 */
export function memoryLlmFor(
  provider: "hindsight",
  vendor: Provider,
  model: string,
): { llm: MemoryLlm; settings: HindsightLlmSettings };
export function memoryLlmFor(
  provider: "openviking",
  vendor: Provider,
  model: string,
): { llm: MemoryLlm; settings: OpenVikingLlmSettings };
export function memoryLlmFor(
  provider: "honcho",
  vendor: Provider,
  model: string,
): { llm: MemoryLlm; settings: HonchoLlmSettings };
export function memoryLlmFor(
  provider: MemoryServiceProvider,
  vendor: Provider,
  model: string,
): { llm: MemoryLlm; settings: HindsightLlmSettings | OpenVikingLlmSettings | HonchoLlmSettings };
export function memoryLlmFor(
  provider: MemoryServiceProvider,
  vendor: Provider,
  model: string,
): { llm: MemoryLlm; settings: HindsightLlmSettings | OpenVikingLlmSettings | HonchoLlmSettings } {
  assertModelId(provider, model);
  const keyed = PROVIDERS[vendor].auth === "api_key";
  const baseUrl = compatibleBaseUrl(vendor);
  if (provider === "honcho") {
    return {
      llm: { vendor, model, key_env: ["LLM_OPENAI_API_KEY"] },
      settings: { env: honchoLlmEnv(vendor, model) },
    };
  }
  if (provider === "hindsight") {
    // Native where hindsight has the vendor; `openai` + base URL where it is
    // an OpenAI-compatible endpoint.
    const llmProvider = baseUrl !== null ? "openai" : vendor;
    const env: Record<string, string> = {
      HINDSIGHT_API_LLM_PROVIDER: llmProvider,
      HINDSIGHT_API_LLM_MODEL: model,
      ...(baseUrl === null ? {} : { HINDSIGHT_API_LLM_BASE_URL: baseUrl }),
    };
    return {
      llm: { vendor, model, key_env: keyed ? ["HINDSIGHT_API_LLM_API_KEY"] : [] },
      settings: { env },
    };
  }
  const route = baseUrl !== null ? "openai" : vendor;
  const routeKey = keyed ? LITELLM_KEY_ENV[route] : undefined;
  const keyEnv: MemoryLlmKeyEnv[] = routeKey === undefined ? [] : [routeKey];
  return {
    llm: { vendor, model, key_env: keyEnv },
    settings: {
      vlm: {
        provider: "litellm",
        model: `${route}/${model}`,
        ...(baseUrl === null ? {} : { api_base: baseUrl }),
      },
    },
  };
}

/**
 * Whether openviking embeds through the agent's vendor rather than its local
 * model — the one predicate both the render and `agents.set`'s refusal to
 * flip it (`memory-binding.ts`) read. A vendor with an OpenAI-compatible
 * `/embeddings` endpoint (`providerEmbeddingModel`) embeds there; anthropic
 * and bedrock keep the local GGUF.
 */
export function openvikingEmbedsRemotely(vendor: Provider): boolean {
  return providerEmbeddingModel(vendor) !== null;
}

/** The local model, and the only one OpenViking can run on the box. */
const OPENVIKING_LOCAL_EMBEDDING_MODEL = "bge-small-zh-v1.5-f16";

/**
 * `ov.conf`'s `embedding` block. Remote: OpenViking's `openai` embedder, the
 * one model every embedding vendor serves, at the width honcho uses too, with
 * `allow_metadata_override` so moving between those vendors — the same model
 * under another route name — keeps the stored vectors instead of refusing to
 * start (`EmbeddingRebuildRequiredError`). The embedder does not read the
 * environment, so `api_key` is a `${VAR}` reference to the variable the box
 * already materialises for the vlm route (`keyEnv`), which the server expands
 * from its unit's environment when it loads the file — the key itself is
 * never on disk.
 */
function openvikingEmbedding(
  vendor: Provider,
  keyEnv: readonly MemoryLlmKeyEnv[],
  dir: string,
): Record<string, unknown> {
  const model = providerEmbeddingModel(vendor);
  const key = keyEnv[0];
  if (model === null || key === undefined) {
    return {
      dense: { provider: "local", model: OPENVIKING_LOCAL_EMBEDDING_MODEL, cache_dir: `${dir}/models` },
    };
  }
  return {
    dense: {
      provider: "openai",
      model,
      dimension: PROVIDER_EMBEDDING_DIMENSION,
      ...(vendor === "openai" ? {} : { api_base: PROVIDERS[vendor].base_url }),
      api_key: "$" + `{${key}}`,
    },
    allow_metadata_override: true,
  };
}

/** What `renderMemory` and the Hermes units read off a render input. */
export interface MemoryRenderInput {
  /** The agent's name: honcho's AI peer. */
  name: string;
  memory?: { provider: MemoryProvider } | undefined;
  /** The agent's bound vendor — the one its own model calls go to. */
  provider: Provider;
  /** The agent's resolved model, as its `config.yaml` names it. */
  model: string;
  region: string;
}

/**
 * What the Hermes units (the dashboard's, and the gateway's drop-in) add for a
 * memory provider: ordering behind its server, and where each plugin finds it. `[Unit]` and `[Service]` lines, for `hermesRuntimeLines`.
 */
export interface MemoryHermesLines {
  ordering: string[];
  service: string[];
}

export function memoryHermesLines(input: Pick<MemoryRenderInput, "memory">): MemoryHermesLines {
  const id = input.memory?.provider;
  if (id === undefined || !isMemoryServiceProvider(id)) return { ordering: [], service: [] };
  /**
   * `Wants=`, not `Requires=`: a memory server that failed is an agent on
   * built-in memory, which is worse but still an agent; taking Hermes down
   * with it would be no agent at all.
   */
  const ordering = [`Wants=${MEMORY_SERVICE_UNIT}`, `After=${MEMORY_SERVICE_UNIT}`];
  const loopback = `http://127.0.0.1:${String(MEMORY_SERVICES[id].port)}`;
  /**
   * How each plugin finds its server. Environment rather than a rendered file,
   * because the plugins' own files live under `$HERMES_HOME`, and nothing
   * hermetic renders may land under the `hermes` home: root's files phase
   * writes and chowns them, and the account controls every directory entry
   * there (`account-dirs.ts`).
   *
   * - openviking: `is_available()` is false unless `OPENVIKING_ENDPOINT` is
   *   set — the plugin does not fall back to its own default URL — so without
   *   it Hermes would quietly run on built-in memory alone.
   * - hindsight: `_load_config` reads these when there is no
   *   `$HERMES_HOME/hindsight/config.json`. `local_external` makes it a client
   *   of the server above, with no key of its own. An operator-made
   *   `config.json` there overrides every one of them (upstream's precedence:
   *   the file, when present, is the whole configuration).
   * - honcho: the URL, for the case the linked `honcho.json` is gone; the
   *   rest of its settings have no variable and live in that file
   *   (`honchoClientConfPath`). A loopback URL is what lets the plugin run
   *   with no key.
   */
  const service = memoryPluginEnv(id, loopback);
  return { ordering, service };
}

function memoryPluginEnv(id: MemoryServiceProvider, loopback: string): string[] {
  switch (id) {
    case "openviking":
      return [`Environment=OPENVIKING_ENDPOINT=${loopback}`];
    case "hindsight":
      return [
        "Environment=HINDSIGHT_MODE=local_external",
        `Environment=HINDSIGHT_API_URL=${loopback}`,
        "Environment=HINDSIGHT_BANK_ID=hermes",
        "Environment=HINDSIGHT_BUDGET=mid",
        "Environment=HINDSIGHT_TIMEOUT=120",
      ];
    case "honcho":
      return [`Environment=HONCHO_BASE_URL=${HONCHO_LOOPBACK_URL}`];
  }
}

function bedrockRegionLines(vendor: Provider, region: string): string[] {
  if (PROVIDERS[vendor].auth !== "role") return [];
  // botocore reads `AWS_REGION`/`AWS_DEFAULT_REGION`; litellm's Bedrock client
  // reads `AWS_REGION_NAME` first. A unit inherits none of them.
  return [
    "Environment=AWS_REGION_NAME=" + region,
    "Environment=AWS_REGION=" + region,
    "Environment=AWS_DEFAULT_REGION=" + region,
  ];
}

/** What one memory server's unit adds to the shape every one of them shares. */
interface MemoryUnitSpec {
  /** `Description=`, when the provider runs more than one process. */
  description?: string;
  /** Extra `[Unit]` dependencies (honcho's database). */
  requires?: readonly string[];
  /** Defaults to the service's directory on the data volume. */
  workingDirectory?: string;
  /** Settings files loaded before the key file, so the key file wins. */
  envFiles?: readonly string[];
  env: readonly string[];
  execStartPre?: string;
  execStart: string;
  /** Left at systemd's default unless the start does real work. */
  timeoutStartSec?: number;
}

function memoryUnit(id: MemoryServiceProvider, spec: MemoryUnitSpec): string {
  return [
    "# Rendered by hermetic. Final file, no templating.",
    "[Unit]",
    "Description=" + (spec.description ?? "Hermes memory server (" + MEMORY_PROVIDERS[id].label + ")"),
    "After=network-online.target",
    "Wants=network-online.target",
    ...(spec.requires ?? []),
    /**
     * The venv, the data and the models are all on the data volume, which is
     * mounted `nofail`: without this the server could start against an empty
     * root-filesystem directory the volume then mounts over (the browser
     * units' reason, `render-browser.ts`).
     */
    "RequiresMountsFor=/data",
    /**
     * `MEMORY_LLM_ENV_PATH` is on tmpfs and written by the secrets oneshot,
     * so it is gone after every reboot until that unit has run again.
     */
    "After=hermetic-secrets.service",
    "Requires=hermetic-secrets.service",
    "",
    "[Service]",
    "Type=simple",
    "User=hermes",
    "Group=hermes",
    "Environment=HOME=" + HERMES_ACCOUNT_HOME,
    "WorkingDirectory=" + (spec.workingDirectory ?? memoryServiceDir(id)),
    ...(spec.envFiles ?? []).map((f) => "EnvironmentFile=" + f),
    /**
     * Unconditional: hermeticd always writes it, empty for
     * a Bedrock agent, so the unit's shape does not depend on the vendor.
     */
    "EnvironmentFile=" + MEMORY_LLM_ENV_PATH,
    ...spec.env,
    ...(spec.execStartPre === undefined ? [] : ["ExecStartPre=" + spec.execStartPre]),
    "ExecStart=" + spec.execStart,
    ...(spec.timeoutStartSec === undefined ? [] : ["TimeoutStartSec=" + String(spec.timeoutStartSec)]),
    "Restart=always",
    "RestartSec=5",
    "NoNewPrivileges=yes",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export interface RenderedMemory {
  files: RenderedFile[];
  units: string[];
  /** Absent for an agent with no external provider. */
  manifestMemory: ManifestMemory | undefined;
  hermesUnitLines: MemoryHermesLines;
}

/** One server's own files, units and the model it was mapped onto. */
interface RenderedServer {
  files: RenderedFile[];
  units: string[];
  llm: MemoryLlm;
}

function unitFile(unit: string, content: string): RenderedFile {
  return { path: `/etc/systemd/system/${unit}`, mode: "0644", content };
}

/**
 * A memory server's configuration file: under `/etc/hermetic`, root-owned and
 * group `hermes` at 0640 — readable by the server, writable by root alone —
 * and never on the data volume: nothing hermetic renders lands under the
 * `hermes` home (`MEMORY_SERVICE_CONF_DIR`). The paths it *names* are the
 * service's data, which stays there.
 */
function confFile(path: string, content: string, restart_units: string[]): RenderedFile {
  return { path, mode: "0640", owner: "root", group: "hermes", content, restart_units };
}

function renderHindsight(input: MemoryRenderInput, region: string[]): RenderedServer {
  const spec = MEMORY_SERVICES.hindsight;
  const dir = memoryServiceDir("hindsight");
  const mapped = memoryLlmFor("hindsight", input.provider, input.model);
  const unit = memoryUnit("hindsight", {
    env: [
      "Environment=HINDSIGHT_API_HOST=127.0.0.1",
      "Environment=HINDSIGHT_API_PORT=" + String(spec.port),
      // Embedded Postgres, under `$HOME/.pg0` — on the data volume.
      "Environment=HINDSIGHT_API_DATABASE_URL=pg0",
      ...Object.entries(mapped.settings.env).map(([k, v]) => `Environment=${k}=${v}`),
      // The first start downloads the embedding and reranking models.
      "Environment=HINDSIGHT_API_MODEL_INIT_TIMEOUT=1800",
      "Environment=HF_HOME=" + dir + "/hf",
      ...region,
    ],
    execStart: `${dir}/venv/bin/${spec.command}`,
  });
  // The plugin's settings are environment on the Hermes units (`memoryHermesLines`).
  return {
    files: [unitFile(MEMORY_SERVICE_UNIT, unit)],
    units: [MEMORY_SERVICE_UNIT],
    llm: mapped.llm,
  };
}

function renderOpenViking(input: MemoryRenderInput, region: string[]): RenderedServer {
  const spec = MEMORY_SERVICES.openviking;
  const dir = memoryServiceDir("openviking");
  const mapped = memoryLlmFor("openviking", input.provider, input.model);
  const unit = memoryUnit("openviking", {
    env: region,
    execStart: `${dir}/venv/bin/${spec.command} --config ${openvikingConfPath}`,
  });
  /**
   * Strict JSON, which the server runs `os.path.expandvars` over before
   * parsing. One `$` is deliberate: a remote embedder's `api_key` is a
   * `${VAR}` reference to the key the unit's `EnvironmentFile` already holds
   * (`openvikingEmbedding`), so it is expanded in the server's memory and
   * never written here; `assertFullyRendered` allows exactly that reference in
   * exactly this file. Nothing else may carry one — model ids are held to
   * `assertModelId`. The vlm needs no key in the file: litellm reads the
   * vendor's variable itself. `auth_mode: null` is the dev mode, which the
   * server refuses unless the host is loopback.
   *
   * The store follows the embedding mode (`OPENVIKING_DATA_DIRS`): vectors of
   * one width cannot be read with the other's embedder, and a store can meet
   * the other mode without `agents.set` seeing it (a kept volume adopted on
   * another vendor, a store from before provider embeddings), so each mode
   * has its own and a flip opens an empty one rather than a crash loop. An
   * explicit flip is still refused at `agents.set`, so recall is not lost
   * without being asked for.
   */
  const conf = {
    server: { host: "127.0.0.1", port: spec.port, auth_mode: null },
    storage: { workspace: openvikingDataDir(openvikingEmbedsRemotely(input.provider)) },
    embedding: openvikingEmbedding(input.provider, mapped.llm.key_env, dir),
    vlm: mapped.settings.vlm,
  };
  return {
    files: [
      unitFile(MEMORY_SERVICE_UNIT, unit),
      confFile(openvikingConfPath, JSON.stringify(conf, null, 2) + "\n", [MEMORY_SERVICE_UNIT]),
    ],
    units: [MEMORY_SERVICE_UNIT],
    llm: mapped.llm,
  };
}

/**
 * honcho: three units (`render-memory-honcho.ts`). The API and the worker are
 * memory servers of the usual shape, run from the source checkout with its
 * settings file loaded before the key file; the database is its own.
 *
 * Units in start order — database, API, worker — because apply restarts them
 * in the manifest's order, and restarting the database after the others would
 * restart both again through their `Requires=`.
 */
function renderHoncho(input: MemoryRenderInput): RenderedServer {
  const spec = MEMORY_SERVICES.honcho;
  const venv = `${memoryServiceDir("honcho")}/venv/bin`;
  const mapped = memoryLlmFor("honcho", input.provider, input.model);
  const shared = {
    workingDirectory: honchoSrcDir,
    envFiles: [honchoEnvPath],
    env: [],
  };
  const api = memoryUnit("honcho", {
    ...shared,
    description: "Hermes memory server (Honcho API)",
    requires: honchoDbDependency(),
    // Alembic under an advisory lock: idempotent, and the only schema step.
    execStartPre: `${venv}/python scripts/provision_db.py`,
    execStart: `${venv}/${spec.command} src.main:app --host 127.0.0.1 --port ${String(spec.port)} --workers 1`,
    // The first start runs every migration.
    timeoutStartSec: 600,
  });
  const worker = memoryUnit("honcho", {
    ...shared,
    description: "Hermes memory worker (Honcho deriver)",
    requires: honchoWorkerOrdering(),
    execStart: `${venv}/python -m src.deriver`,
  });
  return {
    files: [
      unitFile(MEMORY_DB_UNIT, honchoDbUnit()),
      unitFile(MEMORY_SERVICE_UNIT, api),
      unitFile(MEMORY_WORKER_UNIT, worker),
      confFile(honchoEnvPath, honchoEnvFile(mapped.settings.env), [
        MEMORY_SERVICE_UNIT,
        MEMORY_WORKER_UNIT,
      ]),
      /**
       * Read by Hermes's plugin at start, through the link hermeticd makes
       * under the `hermes` home — so a change restarts the Hermes units, as
       * the managed `config.yaml` does.
       */
      confFile(honchoClientConfPath, honchoClientConf(input.name), [
        HERMES_DASHBOARD_UNIT,
        HERMES_GATEWAY_UNIT,
      ]),
    ],
    units: [MEMORY_DB_UNIT, MEMORY_SERVICE_UNIT, MEMORY_WORKER_UNIT],
    llm: mapped.llm,
  };
}

export function renderMemory(input: MemoryRenderInput): RenderedMemory {
  const hermesUnitLines = memoryHermesLines(input);
  const id = input.memory?.provider;
  if (id === undefined) return { files: [], units: [], manifestMemory: undefined, hermesUnitLines };
  if (!isMemoryServiceProvider(id)) {
    return { files: [], units: [], manifestMemory: { provider: id }, hermesUnitLines };
  }
  const region = bedrockRegionLines(input.provider, input.region);
  let server: RenderedServer;
  switch (id) {
    case "hindsight":
      server = renderHindsight(input, region);
      break;
    case "openviking":
      server = renderOpenViking(input, region);
      break;
    case "honcho":
      // No bedrock: refused before render (`assertMemoryLlm`), so no region.
      server = renderHoncho(input);
      break;
  }
  return {
    files: server.files,
    units: server.units,
    manifestMemory: { provider: id, pin: MEMORY_SERVICES[id].pin, llm: server.llm },
    hermesUnitLines,
  };
}
