import { z } from "zod";
import {
  MEMORY_LLM_KEY_ENVS,
  MEMORY_PROVIDER_IDS,
  MEMORY_PROVIDER_NONE,
  isMemoryProvider,
} from "../shared/memory-providers.ts";
import { PROVIDER_IDS } from "../shared/providers.ts";
export {
  HONCHO_APT_PACKAGES,
  HONCHO_DB_NAME,
  HONCHO_DB_SOCKET_DIR,
  HONCHO_PG_BIN,
  HONCHO_PG_MAJOR,
  HONCHO_PLUGIN_CONFIG_LINK,
  MEMORY_DB_UNIT,
  MEMORY_HONCHO_CAPABILITY,
  MEMORY_LLM_ENV_PATH,
  MEMORY_LLM_KEY_ENVS,
  MEMORY_PROVIDERS,
  MEMORY_PROVIDERS_LIST,
  MEMORY_PROVIDER_CAPABILITY,
  MEMORY_PROVIDER_IDS,
  MEMORY_PROVIDER_NONE,
  MEMORY_SERVICES,
  MEMORY_SERVICE_CAPABILITY,
  MEMORY_SERVICE_CONF_DIR,
  MEMORY_SERVICE_ROOT,
  MEMORY_SERVICE_UNIT,
  MEMORY_SERVICE_UNITS,
  MEMORY_WORKER_UNIT,
  PROVIDER_EMBEDDING_DIMENSION,
  PROVIDER_EMBEDDING_MODEL,
  PROVIDER_EMBEDDING_VENDORS,
  hermesPluginDir,
  honchoClientConfPath,
  honchoEnvPath,
  honchoPgDataDir,
  honchoSrcDir,
  honchoTiktokenDir,
  isMemoryProvider,
  memoryProviderIsService,
  memoryServiceDir,
  OPENVIKING_DATA_DIRS,
  openvikingConfPath,
  openvikingDataDir,
  memoryServiceOf,
  providerEmbeddingModel,
} from "../shared/memory-providers.ts";
export type {
  MemoryLlmKeyEnv,
  MemoryProvider,
  MemoryProviderSpec,
  MemoryServiceId,
  MemoryServicePlugin,
  MemoryServiceSource,
  MemoryServiceSpec,
} from "../shared/memory-providers.ts";

/** A Hermes external memory provider (`shared/memory-providers.ts`). */
export const MemoryProviderId = z.enum(MEMORY_PROVIDER_IDS);
export type MemoryProviderId = z.infer<typeof MemoryProviderId>;

/**
 * A provider id read back off a *stored* row, where it may predate the
 * catalogue: an agent or a fleet default recorded under a provider that has
 * since been removed (`supermemory`, `mem0`, `retaindb`, `honcho`) reads as no
 * provider rather than failing to parse. Rendering such an agent then drops
 * `memory.provider` from its managed config — Hermes falls back to built-in
 * memory — which is the honest answer once the box can no longer run it.
 * Requests still use the strict `MemoryProviderId`.
 */
export const StoredMemoryProviderId = z.preprocess(
  (v) => (typeof v === "string" && isMemoryProvider(v) ? v : null),
  MemoryProviderId.nullable(),
);

/**
 * What a create may say about memory: a provider, or `none` to override the
 * fleet's default down to Hermes's built-in memory only. Saying nothing
 * inherits the default.
 */
export const MemoryProviderChoice = z.union([MemoryProviderId, z.literal(MEMORY_PROVIDER_NONE)]);
export type MemoryProviderChoice = z.infer<typeof MemoryProviderChoice>;

/**
 * The external memory provider an agent was created with. The row records
 * nothing else: the provider's server, its data and any credential it uses
 * are all derived on the box from this and the agent's own provider binding.
 * `null` is built-in memory only, and what a row written under a since-removed
 * provider reads as (`StoredMemoryProviderId`).
 */
export const AgentMemory = z.preprocess((v) => {
  if (v === null || v === undefined) return v;
  if (typeof v !== "object") return null;
  const provider = (v as { provider?: unknown }).provider;
  return typeof provider === "string" && isMemoryProvider(provider) ? { provider } : null;
}, z.object({ provider: MemoryProviderId }).nullable());
export type AgentMemory = z.infer<typeof AgentMemory>;

/**
 * The model a service provider's own calls use, mapped on the laptop from the
 * agent's bound profile (`render/render-memory.ts`). The vendor and model are
 * recorded for the box's `hermeticd status` and for `config_hash`; the unit
 * file carries the actual provider-specific settings. `key_env` is what the
 * box acts on: the variable name(s) it copies the agent's provider key under
 * into `MEMORY_LLM_ENV_PATH`. Empty for a role-authenticated vendor (bedrock).
 */
// `PROVIDER_IDS` directly rather than `Provider` from `agent.ts`, which imports this file.
export const MemoryLlm = z.object({
  vendor: z.enum(PROVIDER_IDS),
  model: z.string().min(1),
  key_env: z.array(z.enum(MEMORY_LLM_KEY_ENVS)),
});
export type MemoryLlm = z.infer<typeof MemoryLlm>;

/**
 * The manifest's memory block (`AgentConfig.memory`). `pin` is present for a
 * service provider and must equal the pin the box's hermeticd was built with
 * (`MEMORY_SERVICES[id].pin`); a box that knows another refuses the manifest
 * rather than installing a release under a name it does not own.
 */
export const ManifestMemory = z.object({
  provider: MemoryProviderId,
  pin: z.string().min(1).optional(),
  llm: MemoryLlm.optional(),
});
export type ManifestMemory = z.infer<typeof ManifestMemory>;

/**
 * `AgentConfig.memory` as the box reads it: a block naming a provider this
 * build does not know (a bundle rendered under f5ad900 for a since-removed
 * hosted provider, still on a box's root volume) reads as no provider, so the
 * boot oneshot that writes the managed `.env` block keeps working and the next
 * converge replaces the bundle. A block naming a *known* provider is parsed
 * strictly: a wrong pin or key variable is still refused.
 */
export const StoredManifestMemory = z.preprocess((v) => {
  if (v === null || v === undefined || typeof v !== "object") return undefined;
  const provider = (v as { provider?: unknown }).provider;
  return typeof provider === "string" && isMemoryProvider(provider) ? v : undefined;
}, ManifestMemory.optional());
