/**
 * Which Hermes external memory provider a new agent gets, and the refusals a
 * create — or an `agents.set` that changes it — makes about it before it
 * writes anything.
 *
 * Its own module rather than more of `create-agent.ts` (core rule 5), and
 * shaped like `profile-binding.ts`: a pure resolution, then checks the create
 * runs before it claims the name. Nothing here touches a secret — a service
 * provider's model calls use the agent's own provider credential, which the
 * box copies for it (`memory.llm.key_env`, `render/render-memory.ts`).
 *
 * The choice is pinned on the row (`Agent.memory`). The fleet default is read
 * once, at create: a later change to `settings.default_memory_provider` moves
 * no existing agent, for the reason `Agent.seed` is pinned — a fleet default
 * re-read at render time would re-hash every agent's configuration the day
 * somebody changed it. An existing agent changes provider only when its
 * operator says so, through `agents.set` (`memory_provider`), which runs the
 * same checks against the agent as it stands after the change and reaches a
 * running box through the ordinary rollout (§6.2).
 */
import type {
  Agent,
  AgentCapability,
  AgentMemory,
  FleetSettings,
  MemoryProviderChoice,
  Size,
} from "../../schema/index.ts";
import { SIZES } from "../../schema/index.ts";
import {
  MEMORY_PROVIDER_NONE,
  MEMORY_HONCHO_CAPABILITY,
  MEMORY_PROVIDERS,
  MEMORY_PROVIDER_CAPABILITY,
  MEMORY_SERVICE_CAPABILITY,
  OPENVIKING_DATA_DIRS,
  isMemoryProvider,
  memoryProviderIsService,
  type MemoryProvider,
  type MemoryProviderSpec,
} from "../../shared/memory-providers.ts";
import { PROVIDERS, type Provider } from "../../shared/providers.ts";
import { HermeticError } from "../../errors.ts";
import {
  isMemoryServiceProvider,
  memoryLlmFor,
  openvikingEmbedsRemotely,
} from "../../render/render-memory.ts";

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

/**
 * The provider an `agents.set` names: `undefined` when it names none (no
 * change), `null` for `none`. Unlike `resolveMemoryProvider`, never the fleet
 * default — that is read once, at create.
 */
export function statedMemoryProvider(
  choice: MemoryProviderChoice | undefined,
): MemoryProvider | null | undefined {
  if (choice === undefined) return undefined;
  return choice === MEMORY_PROVIDER_NONE || !isMemoryProvider(choice) ? null : choice;
}

/**
 * The model a memory server is handed for this row: the one `renderAgentConfig`
 * resolves — the row's `hermes.model`, else the model seeded at create, else
 * the vendor's default (`splitHermesSettings`, and `render.ts`'s call to
 * `renderMemory`).
 */
export function renderedMemoryModel(agent: Pick<Agent, "provider" | "hermes" | "seed">): string {
  return agent.hermes?.model ?? agent.seed?.model ?? PROVIDERS[agent.provider].default_model;
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
 * one as well as against honcho, the one shipped provider that does not list
 * every vendor.
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
  spec: Pick<MemoryProviderSpec, "vendors" | "vendors_note"> | undefined = provider === null
    ? undefined
    : MEMORY_PROVIDERS[provider],
): void {
  if (provider === null || spec === undefined || memoryLlmSupported(spec, vendor)) return;
  throw new HermeticError(
    "MEMORY_LLM_UNSUPPORTED",
    `memory provider ${provider} cannot make its model calls through ${vendor}` +
      (spec.vendors_note === undefined ? "" : ` (${spec.vendors_note})`) +
      "; bind the agent to another profile, or choose another memory provider",
    { provider, vendor },
  );
}

/**
 * Refuse a rebinding that would move an openviking agent's embeddings between
 * its vendor and the local model (`openvikingEmbedsRemotely`). Each mode has
 * its own store (`OPENVIKING_DATA_DIRS`: `data` local, `data-remote` remote),
 * so the server would still start — but on the other, empty store, with
 * everything the agent remembered left on disk unused. The guard exists so an
 * explicit rebinding never drops recall silently. A move between two embedding
 * vendors keeps the model, the width and the store, and is allowed.
 */
export function assertMemoryEmbeddingsKept(
  provider: MemoryProvider | null,
  from: Provider,
  to: Provider,
): void {
  if (provider !== "openviking" || from === to) return;
  const before = openvikingEmbedsRemotely(from);
  const after = openvikingEmbedsRemotely(to);
  if (before === after) return;
  const where = (remote: boolean, vendor: Provider) =>
    remote ? `${vendor}'s embeddings endpoint` : "the local embedding model";
  const store = (remote: boolean) =>
    remote ? OPENVIKING_DATA_DIRS.remote : OPENVIKING_DATA_DIRS.local;
  throw new HermeticError(
    "MEMORY_LLM_UNSUPPORTED",
    `memory provider openviking embeds through ${where(before, from)} for this agent, and ${to} ` +
      `would move it to ${where(after, to)}: the agent would start on an empty ` +
      `${store(after)} store, and what it remembers in ${store(before)} would stay on disk ` +
      "unused. Bind the agent to a profile whose vendor embeds the same way",
    { provider, from, to },
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
 * needs the box to install and run the server; honcho also needs the box to
 * know its Postgres, source build and three units (`MEMORY_HONCHO_CAPABILITY`).
 */
export function memoryCapabilities(provider: MemoryProvider | null): AgentCapability[] {
  if (provider === null) return [];
  if (!memoryProviderIsService(provider)) return [MEMORY_PROVIDER_CAPABILITY];
  const out: AgentCapability[] = [MEMORY_PROVIDER_CAPABILITY, MEMORY_SERVICE_CAPABILITY];
  if (provider === "honcho") out.push(MEMORY_HONCHO_CAPABILITY);
  return out;
}
