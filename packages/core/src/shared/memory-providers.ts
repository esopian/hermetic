/**
 * The Hermes external memory providers an agent can be given at create: the id
 * list the Zod enum is built from, what each needs on the box, and where its
 * key lives.
 *
 * Hermes always keeps its built-in memory (`MEMORY.md`/`USER.md`) on, and runs
 * at most one external provider beside it, chosen by `memory.provider` in its
 * `config.yaml` (`agent/memory_manager.py`; `""`, `none`, `default` and
 * `builtin` all mean built-in only). hermetic renders that key into the managed
 * scope, so the choice is the operator's and not the agent's.
 *
 * The providers below are every one bundled in-tree at the pinned Hermes ref
 * (`plugins/memory/<id>/`) that can be configured with nothing but an
 * environment variable: each one's `is_available()` keys on its API key alone
 * (holographic on nothing at all), so no JSON file has to be rendered for it.
 * Deliberately excluded:
 *
 * - `hindsight` — catalog-only at this ref; it needs `hermes plugins install`,
 *   which clones over the network and prompts for its environment.
 * - `openviking` — needs an OpenViking server to talk to.
 * - `byterover` — needs the `brv` binary on the box.
 * - `memori` — drives an external CLI.
 *
 * Pure values only — no Zod, no `node:*`, nothing that opens a file or a
 * socket — because `shared/index.ts` re-exports from here into the browser and
 * the box. The Zod schemas that validate these shapes live in `schema/memory.ts`,
 * which imports this module, never the reverse
 * (`packages/core/test/shared-browser-safe.test.ts`).
 */

/** External memory provider ids, as Hermes spells them in `memory.provider`. */
export const MEMORY_PROVIDER_IDS = [
  "holographic",
  "supermemory",
  "honcho",
  "mem0",
  "retaindb",
] as const;
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
   * `none` providers keep everything on the box and need no secret; `api_key`
   * providers need a key on the box before Hermes will activate them.
   */
  readonly auth: "none" | "api_key";
  /** Environment variable Hermes reads the key from; null for `none` providers. */
  readonly env: string | null;
  /**
   * The provider's Python dependencies, as its `plugin.yaml` lists them
   * (`pip_dependencies`). hermeticd preinstalls them into Hermes's venv so the
   * first turn does not stall on a lazy install.
   */
  readonly pip: readonly string[];
  readonly docs: string;
}

const DOCS = "https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers";

export const MEMORY_PROVIDERS: Readonly<Record<MemoryProvider, MemoryProviderSpec>> = {
  holographic: {
    label: "Holographic (local)",
    summary: "Local SQLite fact store with full-text search and trust scoring; nothing leaves the box.",
    auth: "none",
    env: null,
    // The store lives at `$HERMES_HOME/memory_store.db`, and every setting
    // under `plugins.hermes-memory-store` is optional, so nothing is rendered.
    pip: [],
    docs: `${DOCS}#holographic`,
  },
  supermemory: {
    label: "Supermemory",
    summary: "Hosted semantic long-term memory with profile recall and per-turn capture.",
    auth: "api_key",
    env: "SUPERMEMORY_API_KEY",
    pip: ["supermemory"],
    docs: `${DOCS}#supermemory`,
  },
  honcho: {
    label: "Honcho",
    summary: "Hosted cross-session user modelling with dialectic Q&A and semantic search.",
    auth: "api_key",
    env: "HONCHO_API_KEY",
    pip: ["honcho-ai"],
    docs: `${DOCS}#honcho`,
  },
  mem0: {
    label: "Mem0 (platform)",
    summary: "Hosted server-side fact extraction with semantic search and deduplication.",
    auth: "api_key",
    env: "MEM0_API_KEY",
    pip: ["mem0ai>=2.0.10,<3"],
    docs: `${DOCS}#mem0`,
  },
  retaindb: {
    label: "RetainDB",
    summary: "Hosted memory API with hybrid search and typed memories.",
    auth: "api_key",
    env: "RETAINDB_API_KEY",
    pip: ["requests"],
    docs: `${DOCS}#retaindb`,
  },
};

/** The catalogue in picker order, each entry carrying its id. */
export const MEMORY_PROVIDERS_LIST: readonly ({ readonly id: MemoryProvider } & MemoryProviderSpec)[] =
  MEMORY_PROVIDER_IDS.map((id) => ({ id, ...MEMORY_PROVIDERS[id] }));

export function isMemoryProvider(x: string): x is MemoryProvider {
  return (MEMORY_PROVIDER_IDS as readonly string[]).includes(x);
}

export function memoryProviderNeedsKey(id: MemoryProvider): boolean {
  return MEMORY_PROVIDERS[id].auth === "api_key";
}

/**
 * The fleet's shared slot a keyed provider's API key is pushed into once
 * (`hermetic secrets push _fleet --shared memory-<id>`), at
 * `/hermetic/<fleet_id>/secrets/memory-<id>`. A create copies it from there.
 */
export function memoryKeySlug(id: MemoryProvider): string {
  return `memory-${id}`;
}

/**
 * The agent's own slot the key is copied into, under `/hermes/<fleet_id>/<name>/`
 * — the one its instance role can read, and the one hermeticd materialises
 * into `secrets.env`.
 */
export const MEMORY_KEY_SLOT = "memory-key";

/** The environment variable the key reaches Hermes in, or null for a local provider. */
export function memoryKeyEnv(id: MemoryProvider): string | null {
  return MEMORY_PROVIDERS[id].env;
}

/**
 * The hermeticd capability a manifest naming a memory provider asks for
 * (`AGENT_CONFIG_CAPABILITIES` in `schema/manifest.ts`).
 */
export const MEMORY_PROVIDER_CAPABILITY = "memory-provider";
