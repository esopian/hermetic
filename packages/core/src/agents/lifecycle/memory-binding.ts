/**
 * Which Hermes external memory provider a new agent gets, and the refusals a
 * create makes about it before it owns anything.
 *
 * Its own module rather than more of `create-agent.ts` (core rule 5), and
 * shaped like `profile-binding.ts`: a pure resolution, then checks the create
 * runs before it claims the name. Nothing here touches a secret — a service
 * provider's model calls use the agent's own provider credential, which the
 * box copies for it (`memory.llm.key_env`, `render/render-memory.ts`).
 *
 * The choice is made once, at create, and pinned on the row (`Agent.memory`).
 * A later change to `settings.default_memory_provider` moves no existing agent,
 * for the reason `Agent.seed` is pinned: a fleet default re-read at render time
 * would re-hash every agent's configuration the day somebody changed it.
 */
import type {
  AgentCapability,
  AgentMemory,
  FleetSettings,
  MemoryProviderChoice,
  Size,
} from "../../schema/index.ts";
import { SIZES } from "../../schema/index.ts";
import {
  MEMORY_PROVIDERS,
  MEMORY_PROVIDER_CAPABILITY,
  MEMORY_SERVICE_CAPABILITY,
  isMemoryProvider,
  memoryProviderIsService,
  type MemoryProvider,
  type MemoryProviderSpec,
} from "../../shared/memory-providers.ts";
import type { Provider } from "../../shared/providers.ts";
import { HermeticError } from "../../errors.ts";
import { isMemoryServiceProvider, memoryLlmFor } from "../../render/render-memory.ts";

/**
 * The provider a create resolves to: what it stated, else the fleet's default,
 * else none. `none` stated overrides a fleet default — the one thing an absent
 * choice cannot say.
 */
export function resolveMemoryProvider(
  choice: MemoryProviderChoice | undefined,
  settings: Pick<FleetSettings, "default_memory_provider">,
): MemoryProvider | null {
  const resolved = choice ?? settings.default_memory_provider ?? null;
  // A stored default is parsed leniently (`StoredMemoryProviderId`); checked
  // again here so a store that hands back an unparsed row cannot pin a
  // since-removed provider on a new agent.
  return resolved === null || !isMemoryProvider(resolved) ? null : resolved;
}

/** What the row records for a resolved provider: `null` is built-in memory only. */
export function memoryOf(provider: MemoryProvider | null): AgentMemory | null {
  return provider === null ? null : { provider };
}

/**
 * Refuse a provider whose server needs more instance memory than the size
 * has, rather than leave it to swap beside Hermes and the browser stack.
 *
 * Skipped when the create named an explicit `instance_type` — the free-form
 * escape hatch (`CreateAgentInput.instance_type`). That string is any EC2
 * type, and core has no table of their memory: `SIZES[size]` would then be the
 * size's *nominal* memory, not the box's, and refusing on it could turn away a
 * create onto a larger machine. An operator who names the instance type owns
 * the answer.
 */
export function assertMemorySized(
  provider: MemoryProvider | null,
  size: Size,
  instanceTypeOverride: string | undefined,
): void {
  if (provider === null || instanceTypeOverride !== undefined) return;
  const mem_gib = SIZES[size].memGib;
  const min_mem_gib = MEMORY_PROVIDERS[provider].min_mem_gib;
  if (mem_gib >= min_mem_gib) return;
  throw new HermeticError(
    "MEMORY_PROVIDER_UNDERSIZED",
    `memory provider ${provider} needs at least ${String(min_mem_gib)} GiB of total instance memory; ` +
      `size ${size} has ${String(mem_gib)} GiB. Choose a larger --size, or --memory none`,
    { provider, size, mem_gib, min_mem_gib },
  );
}

/**
 * Whether a provider's own model calls can be mapped onto an agent bound to
 * `vendor`. Pure over a spec, so the refusal is testable against a narrowed
 * one: every provider this build ships lists every vendor.
 */
export function memoryLlmSupported(
  spec: Pick<MemoryProviderSpec, "vendors">,
  vendor: Provider,
): boolean {
  return spec.vendors.includes(vendor);
}

/**
 * Refuse a provider that cannot make its model calls through the agent's bound
 * vendor — a server that starts and then fails every extraction is worse than
 * a create that says so.
 */
export function assertMemoryLlm(
  provider: MemoryProvider | null,
  vendor: Provider,
  spec: Pick<MemoryProviderSpec, "vendors"> | undefined = provider === null
    ? undefined
    : MEMORY_PROVIDERS[provider],
): void {
  if (provider === null || spec === undefined || memoryLlmSupported(spec, vendor)) return;
  throw new HermeticError(
    "MEMORY_LLM_UNSUPPORTED",
    `memory provider ${provider} cannot make its model calls through ${vendor}; ` +
      "bind the agent to another profile, or choose another memory provider",
    { provider, vendor },
  );
}

/**
 * Refuse a model a service provider's server cannot be handed — the render's
 * own check (`memoryLlmFor`), asked before anything is written. At render it
 * would come after a create had claimed the name, or after `agents.set` had
 * written the row, and every render of that agent — `plan.rollout` for the
 * fleet included — would then fail on it. `VALIDATION`, as at render.
 */
export function assertMemoryModel(
  provider: MemoryProvider | null,
  vendor: Provider,
  model: string,
): void {
  if (provider === null || !isMemoryServiceProvider(provider)) return;
  memoryLlmFor(provider, vendor, model);
}

/**
 * The hermeticd capabilities a create's memory choice adds (`requiredCapabilities`
 * in `schema/manifest.ts` asks the same of the rendered document): any
 * provider needs its Python dependencies settled; a service provider also
 * needs the box to install and run the server.
 */
export function memoryCapabilities(provider: MemoryProvider | null): AgentCapability[] {
  if (provider === null) return [];
  return memoryProviderIsService(provider)
    ? [MEMORY_PROVIDER_CAPABILITY, MEMORY_SERVICE_CAPABILITY]
    : [MEMORY_PROVIDER_CAPABILITY];
}
