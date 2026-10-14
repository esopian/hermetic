/**
 * The Hermes external memory providers an agent can be given at create: the id
 * list the Zod enum is built from, what each needs on the box, and the pinned
 * release of any server hermeticd runs beside Hermes for it.
 *
 * Hermes always keeps its built-in memory (`MEMORY.md`/`USER.md`) on, and runs
 * at most one external provider beside it, chosen by `memory.provider` in its
 * `config.yaml` (`agent/memory_manager.py`; `""`, `none`, `default` and
 * `builtin` all mean built-in only). hermetic renders that key into the managed
 * scope, so the choice is the operator's and not the agent's.
 *
 * Every provider here is one hermetic sets up completely on the agent box with
 * no operator input and no memory-service account: the memory data and any
 * server it needs live on the box's data volume, and a provider that makes
 * model calls of its own makes them with the agent's already-bound provider
 * credential (§8.3), mapped by `render/render-memory.ts`. Deliberately
 * excluded, and why:
 *
 * - `supermemory`, `mem0`, `retaindb` — hosted services; each needs an account
 *   and an API key of its own, and keeps the memory off the box.
 * - `honcho` — self-hostable, but its server has no local embedding option:
 *   it embeds only through an OpenAI-compatible `/v1/embeddings` endpoint, so
 *   an agent bound to anthropic, bedrock or nous could not be served at all.
 *   The server is also a source build (Python 3.13, Postgres + pgvector, an
 *   API and a deriver process) with no released package. Revisit if upstream
 *   ships a local embedder.
 * - `byterover` — needs the `brv` binary and an account.
 * - `memori` — drives an external CLI.
 *
 * Pure values only — no Zod, no `node:*`, nothing that opens a file or a
 * socket — because `shared/index.ts` re-exports from here into the browser and
 * the box. The Zod schemas that validate these shapes live in `schema/memory.ts`,
 * which imports this module, never the reverse
 * (`packages/core/test/shared-browser-safe.test.ts`).
 */
import { HERMES_ACCOUNT_HOME, HERMES_HOME } from "./hermes.ts";
import { PROVIDER_IDS, type Provider } from "./providers.ts";

/** External memory provider ids, as Hermes spells them in `memory.provider`. */
export const MEMORY_PROVIDER_IDS = ["holographic", "hindsight", "openviking"] as const;
export type MemoryProvider = (typeof MEMORY_PROVIDER_IDS)[number];

/**
 * The explicit "no external provider" answer a create may give. Distinct from
 * leaving the choice out, which inherits the fleet's default; this overrides
 * it, and the row records `null`.
 */
export const MEMORY_PROVIDER_NONE = "none" as const;

export interface MemoryProviderSpec {
  readonly label: string;
  /** One line for a picker. */
  readonly summary: string;
  /**
   * `in-process` providers run inside Hermes and need nothing but a file on
   * the data volume; `service` providers are a server hermeticd installs and
   * runs as `MEMORY_SERVICE_UNIT`, bound to loopback, pinned by
   * `MEMORY_SERVICES[id]`.
   */
  readonly kind: "in-process" | "service";
  /**
   * The least *total* instance memory (GiB, `SIZES[size].memGib`) a box
   * running this provider beside Hermes and the browser stack may have. A
   * create whose size has less is refused (`MEMORY_PROVIDER_UNDERSIZED`)
   * rather than left to swap. 0 for an in-process provider.
   */
  readonly min_mem_gib: number;
  /**
   * The agent model providers (§8.1) this provider's own model calls can be
   * mapped onto. A provider that calls no model lists them all. A create whose
   * agent is bound elsewhere is refused (`MEMORY_LLM_UNSUPPORTED`) rather than
   * silently degraded.
   */
  readonly vendors: readonly Provider[];
  /** Whether the provider makes model calls of its own, with the agent's credential. */
  readonly uses_llm: boolean;
  /**
   * pip specs hermeticd preinstalls into Hermes's venv — the provider's client
   * side, as its `plugin.yaml` lists them — so the first turn does not stall
   * on a lazy install.
   */
  readonly pip: readonly string[];
  readonly docs: string;
}

const DOCS = "https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers";

export const MEMORY_PROVIDERS: Readonly<Record<MemoryProvider, MemoryProviderSpec>> = {
  holographic: {
    label: "Holographic (local)",
    summary:
      "SQLite fact store with full-text search and trust scoring, inside Hermes; no model calls.",
    kind: "in-process",
    min_mem_gib: 0,
    vendors: PROVIDER_IDS,
    uses_llm: false,
    // The store lives at `$HERMES_HOME/memory_store.db`, and every setting
    // under `plugins.hermes-memory-store` is optional, so nothing is rendered.
    // numpy is optional upstream: without it the holographic (HRR) weighting is
    // dropped and only FTS5 + Jaccard rank. Preinstalled so the provider runs
    // as designed.
    pip: ["numpy"],
    docs: `${DOCS}#holographic`,
  },
  hindsight: {
    label: "Hindsight (local server)",
    summary:
      "Knowledge-graph memory with fact extraction, local embeddings and an embedded Postgres, served on the box; extraction uses the agent's own model.",
    kind: "service",
    min_mem_gib: 8,
    vendors: PROVIDER_IDS,
    uses_llm: true,
    // The Hermes plugin (`MEMORY_SERVICES.hindsight.plugin`) in `local_external`
    // mode needs only the HTTP client; the server runs from its own venv.
    pip: ["hindsight-client==0.10.3"],
    docs: `${DOCS}#hindsight`,
  },
  openviking: {
    label: "OpenViking (local server)",
    summary:
      "Context database with a local embedding model, served on the box; session summaries use the agent's own model.",
    kind: "service",
    min_mem_gib: 4,
    vendors: PROVIDER_IDS,
    uses_llm: true,
    // `httpx` is the plugin's only dependency and Hermes already ships it.
    pip: [],
    docs: `${DOCS}#openviking`,
  },
};

/** The catalogue in picker order, each entry carrying its id. */
export const MEMORY_PROVIDERS_LIST: readonly ({ readonly id: MemoryProvider } & MemoryProviderSpec)[] =
  MEMORY_PROVIDER_IDS.map((id) => ({ id, ...MEMORY_PROVIDERS[id] }));

export function isMemoryProvider(x: string): x is MemoryProvider {
  return (MEMORY_PROVIDER_IDS as readonly string[]).includes(x);
}

export function memoryProviderIsService(id: MemoryProvider): boolean {
  return MEMORY_PROVIDERS[id].kind === "service";
}

// --- The on-box service ----------------------------------------------------

/**
 * The one systemd unit a service provider runs as. One name for whichever
 * provider the agent has, so a manifest that changes provider under a box
 * replaces the unit rather than leaving a second one enabled. (A recreate
 * never does: it replaces the root volume the unit lives on.)
 */
export const MEMORY_SERVICE_UNIT = "hermetic-memory.service";

/**
 * Everything a service provider keeps, under the `hermes` account on the data
 * volume so it survives a recreate: `<root>/<id>/venv`, its data, its
 * configuration. Beside `HERMES_HOME`, not inside it, because Hermes treats
 * its home as its own.
 */
export const MEMORY_SERVICE_ROOT = `${HERMES_ACCOUNT_HOME}/memory`;

export function memoryServiceDir(id: MemoryProvider): string {
  return `${MEMORY_SERVICE_ROOT}/${id}`;
}

/**
 * Where the configuration hermetic renders for a service provider lives: off
 * the data volume, root-owned, group `hermes`, 0640. Never under the `hermes`
 * home — root's files phase writes and chowns rendered files, and root never
 * writes under that home (`account-dirs.ts`), because the account controls
 * every directory entry in it. The service's data stays in `memoryServiceDir`.
 */
export const MEMORY_SERVICE_CONF_DIR = "/etc/hermetic/memory";

/** openviking's `ov.conf`, the file its unit's `--config` names. */
export const openvikingConfPath = `${MEMORY_SERVICE_CONF_DIR}/ov.conf`;

/**
 * Where hermeticd materialises the credential a service's model calls use:
 * the agent's provider key, copied under the variable name(s) the manifest's
 * `memory.llm.key_env` lists. tmpfs, root-only, the unit's `EnvironmentFile`
 * — the same place and rules as `secrets.env`, in a file only this unit loads
 * so an alias like `OPENAI_API_KEY` never reaches Hermes's own environment.
 */
export const MEMORY_LLM_ENV_PATH = "/run/hermetic/memory-llm.env";

/**
 * The only variable names a manifest may ask the box to copy the agent's
 * provider key under (`memory.llm.key_env`). A closed set, because
 * `EnvironmentFile=` overrides `Environment=`: a name outside it could
 * overwrite the unit's own `HINDSIGHT_API_HOST` or `PATH` with the key.
 */
export const MEMORY_LLM_KEY_ENVS = [
  "HINDSIGHT_API_LLM_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
] as const;
export type MemoryLlmKeyEnv = (typeof MEMORY_LLM_KEY_ENVS)[number];

/** The Hermes plugin directory a catalog plugin is checked out into. */
export function hermesPluginDir(name: string): string {
  return `${HERMES_HOME}/plugins/${name}`;
}

export interface MemoryServicePlugin {
  readonly repo: string;
  readonly sha: string;
  readonly subdir: string;
  readonly version: string;
}

export interface MemoryServiceSpec {
  /**
   * The release this build installs, as one string: the manifest carries it
   * (`memory.pin`), the box records it in `<dir>/.hermetic-pin` once the venv
   * holds it, and a box whose hermeticd knows a different pin refuses the
   * manifest rather than installing something else under that name. Bump it
   * with `packages`.
   */
  readonly pin: string;
  /** Loopback port the server listens on. */
  readonly port: number;
  /** The uv-managed Python the service venv is built with. */
  readonly python: string;
  /** pip specs into the service venv. */
  readonly packages: readonly string[];
  /** Extra package indexes, for prebuilt wheels PyPI lacks. */
  readonly extra_index: readonly string[];
  /** Distributions that must come as wheels — fail rather than compile on the box. */
  readonly only_binary: readonly string[];
  /** The executable in the venv's `bin/` the unit runs. */
  readonly command: string;
  /** A Hermes catalog plugin to check out into `hermesPluginDir(id)`, or null when bundled upstream. */
  readonly plugin: MemoryServicePlugin | null;
  /** A model file to pre-seed so the first recall does not stall on a download, or null. */
  readonly model: {
    readonly url: string;
    readonly file: string;
    readonly sha256: string;
    readonly size: number;
  } | null;
}

export const MEMORY_SERVICES: Readonly<Record<"hindsight" | "openviking", MemoryServiceSpec>> = {
  hindsight: {
    // The last 0.x line: the plugin's own bounds are `hindsight-client>=0.10.1,<1`
    // and `hindsight-embed>=0.10.1,<1`, and `hindsight-all` pins embed and
    // api-slim to its exact version, so the client in Hermes's venv
    // (`MEMORY_PROVIDERS.hindsight.pip`) moves with this.
    pin: "hindsight-all==0.10.3+plugin-1.0.1",
    port: 8888,
    python: "3.11",
    packages: ["hindsight-all==0.10.3"],
    extra_index: [],
    only_binary: [],
    command: "hindsight-api",
    // Hermes's plugin catalog entry at the pinned ref (`plugin-catalog/hindsight.yaml`).
    plugin: {
      repo: "https://github.com/vectorize-io/hindsight",
      sha: "176f8c2de1369f569c489b831d143b78128b5535",
      subdir: "hindsight-integrations/hermes",
      version: "1.0.1",
    },
    // Embeddings and the reranker are sentence-transformers models the server
    // fetches from Hugging Face into `HF_HOME` on first start; the unit
    // tolerates that start (`HINDSIGHT_API_MODEL_INIT_TIMEOUT`).
    model: null,
  },
  openviking: {
    pin: "openviking==0.5.0",
    port: 1933,
    python: "3.11",
    // `local-embed` is llama-cpp-python, sdist-only on PyPI: the extra index
    // is upstream's CPU wheel index, and `only_binary` makes a missing wheel a
    // failure rather than a compile on a 2-vCPU box. boto3 is litellm's
    // Bedrock dependency, which neither package declares.
    packages: ["openviking[local-embed]==0.5.0", "llama-cpp-python==0.3.36", "boto3>=1.40,<2"],
    extra_index: ["https://abetlen.github.io/llama-cpp-python/whl/cpu"],
    only_binary: ["llama-cpp-python"],
    command: "openviking-server",
    plugin: null,
    // The only local dense model OpenViking knows. Downloaded inside the first
    // embedding call otherwise, which Hermes's 3 s recall budget would not wait for.
    model: {
      url: "https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-f16.gguf",
      file: "bge-small-zh-v1.5-f16.gguf",
      sha256: "ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c",
      size: 47886240,
    },
  },
};

export function memoryServiceOf(id: MemoryProvider): MemoryServiceSpec | null {
  return id === "hindsight" || id === "openviking" ? MEMORY_SERVICES[id] : null;
}

/**
 * The hermeticd capabilities a manifest naming a memory provider asks for
 * (`AGENT_CONFIG_CAPABILITIES` in `schema/manifest.ts`): every provider needs
 * its Python dependencies settled; a service provider also needs the box to
 * install and run the server.
 */
export const MEMORY_PROVIDER_CAPABILITY = "memory-provider";
export const MEMORY_SERVICE_CAPABILITY = "memory-service";
