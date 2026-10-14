/**
 * The Hermes external memory provider, as the create drawer, Settings ›
 * Defaults and the agent drawer word it.
 *
 * The catalogue is core's (`@hermetic/core/shared`'s `MEMORY_PROVIDERS`); this
 * module only answers the questions every head asks of it: what a choice is
 * called, what it costs the box, whether a size can run it, and what a create
 * that states nothing inherits.
 */
import { MEMORY_PROVIDERS, MEMORY_PROVIDER_NONE, isMemoryProvider } from "@hermetic/core/shared";
import type { MemoryProvider, Provider } from "@hermetic/core/shared";
import type { CreateAgentInput, Meta } from "../api/index.ts";
import { providerOption } from "./format.ts";

/** What a create may state: a provider, or `none` for built-in memory only. */
export type MemoryChoice = NonNullable<CreateAgentInput["memory_provider"]>;

/** Whether a stored value is one this build can send back as a choice. */
export function isMemoryChoice(v: unknown): v is MemoryChoice {
  return v === MEMORY_PROVIDER_NONE || (typeof v === "string" && isMemoryProvider(v));
}

/** A provider's label, or the built-in answer for none. */
export function memoryLabel(id: MemoryProvider | null | undefined): string {
  return id === null || id === undefined ? "None" : MEMORY_PROVIDERS[id].label;
}

/**
 * The short facts a picker shows beside a provider: where it runs (a server
 * hermeticd runs beside Hermes, or inside Hermes itself), the instance memory
 * it needs, and whether it spends the agent's own model credential.
 */
export function memoryTags(id: MemoryProvider): string[] {
  const spec = MEMORY_PROVIDERS[id];
  const tags = [spec.kind === "service" ? "Runs on the box" : "Inside Hermes"];
  if (spec.min_mem_gib > 0) tags.push(`Needs ≥ ${String(spec.min_mem_gib)} GiB`);
  if (spec.uses_llm) tags.push("Uses the agent's model provider");
  return tags;
}

/**
 * Whether a size with `memGib` of instance memory is too small for a
 * provider's server — core's `MEMORY_PROVIDER_UNDERSIZED` rule
 * (`memory-binding.ts`), over the size table the page already carries
 * (`format.ts`'s `SIZES`, a restatement of core's).
 */
export function memoryUndersized(id: MemoryProvider, memGib: number): boolean {
  return MEMORY_PROVIDERS[id].min_mem_gib > memGib;
}

/**
 * Why a provider cannot serve an agent on `vendor`, or null when it can (or
 * when the vendor is not known yet). It is the spec's own `vendors_note` — the
 * sentence core's `MEMORY_LLM_UNSUPPORTED` refusal carries — and, for a
 * provider that states none, a plain statement of the same fact.
 */
export function memoryVendorBlock(
  id: MemoryProvider,
  vendor: Provider | null | undefined,
): string | null {
  if (vendor === null || vendor === undefined) return null;
  const spec = MEMORY_PROVIDERS[id];
  if (spec.vendors.includes(vendor)) return null;
  return (
    spec.vendors_note ??
    `${spec.label} cannot make its model calls through ${providerOption(vendor).label}`
  );
}

/**
 * The fleet's default as `/api/meta` carries it: a provider, `null` for
 * "built-in only", or `undefined` when the settings were not reported — which
 * is "could not read", never "none".
 */
export function fleetDefaultMemory(meta: Meta | null | undefined): MemoryProvider | null | undefined {
  const settings = meta?.settings?.settings;
  if (settings === undefined || settings === null) return undefined;
  const d = settings.default_memory_provider;
  return d !== undefined && d !== null && isMemoryProvider(d) ? d : null;
}
