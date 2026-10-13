import { z } from "zod";
import { MEMORY_PROVIDER_IDS, MEMORY_PROVIDER_NONE } from "../shared/memory-providers.ts";
export {
  MEMORY_KEY_SLOT,
  MEMORY_PROVIDERS,
  MEMORY_PROVIDERS_LIST,
  MEMORY_PROVIDER_CAPABILITY,
  MEMORY_PROVIDER_IDS,
  MEMORY_PROVIDER_NONE,
  isMemoryProvider,
  memoryKeyEnv,
  memoryKeySlug,
  memoryProviderNeedsKey,
} from "../shared/memory-providers.ts";
export type { MemoryProvider, MemoryProviderSpec } from "../shared/memory-providers.ts";

/** A Hermes external memory provider (`shared/memory-providers.ts`). */
export const MemoryProviderId = z.enum(MEMORY_PROVIDER_IDS);
export type MemoryProviderId = z.infer<typeof MemoryProviderId>;

/**
 * What a create may say about memory: a provider, or `none` to override the
 * fleet's default down to Hermes's built-in memory only. Saying nothing
 * inherits the default.
 */
export const MemoryProviderChoice = z.union([MemoryProviderId, z.literal(MEMORY_PROVIDER_NONE)]);
export type MemoryProviderChoice = z.infer<typeof MemoryProviderChoice>;

/**
 * The external memory provider an agent was created with, and the instance
 * slot its key was copied into (`MEMORY_KEY_SLOT`). `key_ref` is null for a
 * provider that needs no key; nullish rather than optional for the reason
 * `Agent.credential_ref` is — a row store cannot clear an attribute by writing
 * `undefined`.
 */
export const AgentMemory = z.object({
  provider: MemoryProviderId,
  key_ref: z.string().min(1).nullish(),
});
export type AgentMemory = z.infer<typeof AgentMemory>;
