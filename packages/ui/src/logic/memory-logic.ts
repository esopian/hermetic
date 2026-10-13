/**
 * The Hermes external memory provider, as the create drawer, Settings ›
 * Defaults and the agent drawer word it.
 *
 * The catalogue is core's (`@hermetic/core/shared`'s `MEMORY_PROVIDERS`); this
 * module only answers the questions every head asks of it: what a choice is
 * called, whether a keyed provider's fleet slot holds a key, and what a create
 * that states nothing inherits.
 */
import {
  MEMORY_PROVIDERS,
  MEMORY_PROVIDER_NONE,
  isMemoryProvider,
  memoryKeySlug,
  memoryProviderNeedsKey,
} from "@hermetic/core/shared";
import type { MemoryProvider } from "@hermetic/core/shared";
import type { CreateAgentInput, Meta, SharedSecretView } from "../api/index.ts";

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

/**
 * A provider's key, as the fleet's shared slot `memory-<id>` holds it:
 * `local` needs none, `set` is filled, `missing` is absent or still the
 * placeholder, and `unknown` is a slot list that could not be read — which
 * must not be drawn as missing, because core is the one that decides.
 */
export type MemoryKeyState = "local" | "set" | "missing" | "unknown";

export function memoryKeyState(
  id: MemoryProvider,
  slots: readonly SharedSecretView[] | null,
): MemoryKeyState {
  if (!memoryProviderNeedsKey(id)) return "local";
  if (slots === null) return "unknown";
  const slot = slots.find((s) => s.slug === memoryKeySlug(id));
  return slot?.exists && !slot.placeholder ? "set" : "missing";
}
