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
 * credential (§8.3), mapped by `render/render-memory.ts`.
 *
 * "On the box" is about the memory, not every byte of computation: the store
 * (files, a database, vectors) never leaves the box, while a provider's model
 * and embedding calls may go to the agent's own provider, because that is
 * where the agent's conversations already go. `honcho` is the one that needs
 * remote embeddings — its server embeds only through an OpenAI-compatible
 * `/embeddings` endpoint — so it is offered only to agents whose vendor has
 * one (`PROVIDER_EMBEDDING_VENDORS`), and its Postgres runs on the box.
 *
 * Deliberately excluded, and why:
 *
 * - `supermemory`, `mem0`, `retaindb` — hosted services; each needs an account
 *   and an API key of its own, and keeps the memory off the box.
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
export const MEMORY_PROVIDER_IDS = ["holographic", "hindsight", "openviking", "honcho"] as const;
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
  /**
   * Why a vendor missing from `vendors` cannot be served, for the
   * `MEMORY_LLM_UNSUPPORTED` refusal and a picker's hint. Absent when every
   * vendor is listed.
   */
  readonly vendors_note?: string;
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

/**
 * The agent vendors (§8.1) that serve an OpenAI-compatible `/embeddings`
 * endpoint, and the one embedding model a memory server is pointed at there.
 * OpenAI serves it under its own name; the gateways (OpenRouter, Nous, Vercel)
 * route it as `openai/<model>`. Anthropic has no embeddings API, and Bedrock's
 * embedding models are neither OpenAI-compatible nor 1536-wide.
 *
 * One model, so a store's vectors keep their meaning and their width
 * (`PROVIDER_EMBEDDING_DIMENSION`, which is Honcho's migrated `vector(1536)`)
 * when an agent moves between these vendors.
 */
export const PROVIDER_EMBEDDING_VENDORS: readonly Provider[] = [
  "openai",
  "openrouter",
  "nous",
  "vercel",
];
export const PROVIDER_EMBEDDING_MODEL = "text-embedding-3-small";
export const PROVIDER_EMBEDDING_DIMENSION = 1536;

/** The embedding model id as `vendor` spells it, or null when it serves no embeddings. */
export function providerEmbeddingModel(vendor: Provider): string | null {
  if (!PROVIDER_EMBEDDING_VENDORS.includes(vendor)) return null;
  return vendor === "openai" ? PROVIDER_EMBEDDING_MODEL : `openai/${PROVIDER_EMBEDDING_MODEL}`;
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
      "Context database served on the box; embeddings use the agent's own provider where it offers them (a local model otherwise), and session summaries its own model.",
    kind: "service",
    min_mem_gib: 4,
    vendors: PROVIDER_IDS,
    uses_llm: true,
    // `httpx` is the plugin's only dependency and Hermes already ships it.
    pip: [],
    docs: `${DOCS}#openviking`,
  },
  honcho: {
    label: "Honcho (local server)",
    summary:
      "Peer-modelling memory with reasoning over conversations, served on the box with its own Postgres; extraction and embeddings use the agent's own provider.",
    kind: "service",
    min_mem_gib: 4,
    vendors: PROVIDER_EMBEDDING_VENDORS,
    vendors_note:
      "Honcho embeds through an OpenAI-compatible /embeddings endpoint, which anthropic and bedrock do not offer",
    uses_llm: true,
    // Hermes bundles the plugin (`plugins/memory/honcho`) and pins its SDK at
    // this exact version (`tools/lazy_deps.py`); 2.x speaks the server's v3 API.
    pip: ["honcho-ai==2.2.0"],
    docs: `${DOCS}#honcho`,
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
 * honcho's two other processes: its background worker (the deriver, which
 * reasons over new messages, summarises and dreams) and the Postgres it keeps
 * everything in. `MEMORY_SERVICE_UNIT` is its API, so the Hermes units order
 * behind the same name whichever provider is bound.
 */
export const MEMORY_WORKER_UNIT = "hermetic-memory-worker.service";
export const MEMORY_DB_UNIT = "hermetic-memory-db.service";

/**
 * Every unit name a memory provider may run under. hermeticd removes any of
 * them that is on disk but not in the manifest's `units` — the one removal
 * rule for a provider changed or dropped under a box.
 */
export const MEMORY_SERVICE_UNITS = [MEMORY_SERVICE_UNIT, MEMORY_WORKER_UNIT, MEMORY_DB_UNIT] as const;

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
 * openviking's store, one per embedding mode, under `memoryServiceDir("openviking")`:
 * `data` for the local model (512-wide vectors; the path every store before
 * provider embeddings used) and `data-remote` for the vendor's (1536-wide).
 * OpenViking refuses to start against a store of the other width
 * (`EmbeddingRebuildRequiredError`), and a store can meet the other mode
 * without `agents.set` ever seeing it — a kept volume adopted by a create on
 * another vendor, or a store made before provider embeddings existed — so
 * each mode opens its own store, and a flip finds the other one (perhaps
 * empty) instead of a crash loop. hermeticd creates both; `ov.conf` names
 * the one its mode uses.
 */
export const OPENVIKING_DATA_DIRS = { local: "data", remote: "data-remote" } as const;

/** The store `ov.conf`'s `storage.workspace` names for a mode. */
export function openvikingDataDir(remote: boolean): string {
  return `${memoryServiceDir("openviking")}/${remote ? OPENVIKING_DATA_DIRS.remote : OPENVIKING_DATA_DIRS.local}`;
}

// --- honcho ------------------------------------------------------------------

/**
 * The honcho server's settings: an `EnvironmentFile` both its units (API and
 * worker) load, and no secret in it — the provider key is `MEMORY_LLM_ENV_PATH`,
 * and the database needs none (`HONCHO_DB_SOCKET_DIR`).
 */
export const honchoEnvPath = `${MEMORY_SERVICE_CONF_DIR}/honcho.env`;

/**
 * The Hermes plugin's client configuration (workspace, peers, server URL).
 * The plugin reads it only from `$HERMES_HOME/honcho.json` (or the account's
 * `~/.honcho/config.json`), and nothing hermetic renders lands under the
 * `hermes` home, so it is rendered here and hermeticd links
 * `HONCHO_PLUGIN_CONFIG_LINK` to it, as the account. An operator who replaces
 * the link with a file of their own keeps it: hermeticd only ever creates or
 * removes a link that points here.
 */
export const honchoClientConfPath = `${MEMORY_SERVICE_CONF_DIR}/honcho.json`;
export const HONCHO_PLUGIN_CONFIG_LINK = `${HERMES_HOME}/honcho.json`;

/** The Postgres major honcho's database is created and run with, from Ubuntu 24.04's archive. */
export const HONCHO_PG_MAJOR = 16;
export const HONCHO_PG_BIN = `/usr/lib/postgresql/${String(HONCHO_PG_MAJOR)}/bin`;
/**
 * The distro packages honcho's database needs: the server and pgvector built
 * for it (0.6 on noble; HNSW needs 0.5). Pinned by major, not by Debian
 * revision, so the archive's security updates still apply.
 */
export const HONCHO_APT_PACKAGES = [
  `postgresql-${String(HONCHO_PG_MAJOR)}`,
  `postgresql-${String(HONCHO_PG_MAJOR)}-pgvector`,
] as const;
/**
 * The cluster's data directory, on the data volume so the memory survives a
 * recreate; owned by the `hermes` account, which runs the server.
 */
export const honchoPgDataDir = `${MEMORY_SERVICE_ROOT}/honcho/pg`;
/**
 * The cluster listens on a Unix socket only (`listen_addresses` empty), in a
 * runtime directory the DB unit creates owned by `hermes`, 0700 — so only the
 * account (and root) can connect, and the database needs no password:
 * `local` connections authenticate by peer, as the `hermes` role.
 */
export const HONCHO_DB_SOCKET_DIR = "/run/hermetic-memory-db";
export const HONCHO_DB_NAME = "honcho";
/** The server's source checkout (it is not a package: no build system), and its tiktoken cache. */
export const honchoSrcDir = `${MEMORY_SERVICE_ROOT}/honcho/src`;
export const honchoTiktokenDir = `${MEMORY_SERVICE_ROOT}/honcho/tiktoken`;

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
  "LLM_OPENAI_API_KEY",
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

/** A server that runs from a pinned source checkout rather than a package (honcho). */
export interface MemoryServiceSource {
  readonly repo: string;
  /** The commit the tag pointed at when pinned; the checkout is by sha, never by tag. */
  readonly sha: string;
  readonly tag: string;
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
  /**
   * A pinned source checkout into `<dir>/src`, whose locked dependencies are
   * synced into the venv (`uv sync --frozen`) in place of `packages`; null
   * for a server installed from an index.
   */
  readonly source: MemoryServiceSource | null;
  /** Distro packages the server needs, installed by hermeticd before the venv. */
  readonly apt: readonly string[];
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

export type MemoryServiceId = "hindsight" | "openviking" | "honcho";

export const MEMORY_SERVICES: Readonly<Record<MemoryServiceId, MemoryServiceSpec>> = {
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
    source: null,
    apt: [],
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
    source: null,
    apt: [],
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
  honcho: {
    // The server and the plugin's SDK (`MEMORY_PROVIDERS.honcho.pip`) move together.
    pin: "honcho==3.3.0+honcho-ai==2.2.0",
    // Not 8000, the default of `python -m http.server`, uvicorn and `fastapi dev`,
    // which the agent's own tools bind: a squatter there would keep the API down.
    port: 18000,
    // `requires-python = ">=3.13"`; uv-managed, installed by root beside Hermes's 3.11.
    python: "3.13",
    packages: [],
    extra_index: [],
    only_binary: [],
    command: "uvicorn",
    source: {
      repo: "https://github.com/plastic-labs/honcho",
      sha: "608aec8a928da13c540262ed980c569448fb53ab",
      tag: "v3.3.0",
    },
    apt: HONCHO_APT_PACKAGES,
    // Hermes bundles the honcho plugin.
    plugin: null,
    model: null,
  },
};

export function memoryServiceOf(id: MemoryProvider): MemoryServiceSpec | null {
  return id === "hindsight" || id === "openviking" || id === "honcho" ? MEMORY_SERVICES[id] : null;
}

/**
 * The hermeticd capabilities a manifest naming a memory provider asks for
 * (`AGENT_CONFIG_CAPABILITIES` in `schema/manifest.ts`): every provider needs
 * its Python dependencies settled; a service provider also needs the box to
 * install and run the server.
 */
export const MEMORY_PROVIDER_CAPABILITY = "memory-provider";
export const MEMORY_SERVICE_CAPABILITY = "memory-service";
/**
 * honcho asks for more than `memory-service` promises: distro Postgres, a
 * second uv Python, a source checkout synced from its lockfile, three units
 * and the plugin's linked configuration. A hermeticd that predates it would
 * read a manifest naming `honcho` as naming no provider at all
 * (`StoredManifestMemory`) and leave Hermes pointed at a server nobody runs.
 */
export const MEMORY_HONCHO_CAPABILITY = "memory-honcho";
