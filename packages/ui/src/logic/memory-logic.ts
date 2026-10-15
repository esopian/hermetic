/**
 * The Hermes external memory provider, as the create drawer, Settings ›
 * Defaults and the agent drawer word it.
 *
 * The catalogue is core's (`@hermetic/core/shared`'s `MEMORY_PROVIDERS`); this
 * module only answers the questions every head asks of it: what a choice is
 * called, what it costs the box, whether a size can run it, and what a create
 * that states nothing inherits.
 */
import {
  MEMORY_NONE_SPEC,
  MEMORY_PROVIDERS,
  MEMORY_PROVIDERS_LIST,
  MEMORY_PROVIDER_NONE,
  PROVIDER_IDS,
  isMemoryProvider,
  memoryResourceFacts,
} from "@hermetic/core/shared";
import type { MemoryProvider, MemoryResourceFact, Provider, SizeId } from "@hermetic/core/shared";
import type { AgentView, CreateAgentInput, Meta } from "../api/index.ts";
import { CONVERGEABLE, SIZES, providerOption } from "./format.ts";
import type { SizeSpec } from "./format.ts";

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

/**
 * The agent facts the drawer's memory chooser reads: what it runs now, the
 * size and instance type it runs on, and the vendor (or vendors, while a
 * profile change is staged) its provider's model calls would go through.
 */
export type MemoryAgentFacts = Pick<
  AgentView,
  "memory" | "size" | "instance_type" | "provider" | "pending"
>;

/** What the agent runs now, as a choice: its provider, or `none`. */
export function currentMemoryChoice(agent: Pick<AgentView, "memory">): MemoryChoice {
  return agent.memory?.provider ?? MEMORY_PROVIDER_NONE;
}

/** A choice's label: a provider's own, or the built-in answer. */
export function memoryChoiceLabel(choice: MemoryChoice): string {
  return choice === MEMORY_PROVIDER_NONE ? "Built-in only" : MEMORY_PROVIDERS[choice].label;
}

/**
 * The instance memory the size check runs against, or null when there is
 * nothing to check against. Core checks a size's own memory only when the
 * agent runs that size's default instance type (`assertMemorySized` skips an
 * explicit instance type, whose memory it does not know), so an agent whose
 * `instance_type` is not its size's default is not held to the size's number
 * here either. A row with no size — an older fixture, a partial view — is not
 * guessed at.
 */
export function memoryCheckGib(agent: Pick<AgentView, "size" | "instance_type">): number | null {
  if (agent.size === undefined || agent.size === null) return null;
  const spec = SIZES.find((s) => s.id === agent.size);
  if (spec === undefined) return null;
  const type = agent.instance_type;
  if (typeof type === "string" && type !== "" && type !== spec.instance_type) return null;
  return spec.memGib;
}

/**
 * The vendor a provider cannot serve this agent through, with the reason, or
 * null. Both the running vendor and a staged profile change's are checked: the
 * staged one is what the agent runs after the same rollout that switches its
 * memory, and core checks the binding the agent has after the call.
 */
export function memoryVendorRefusal(
  id: MemoryProvider,
  agent: Pick<AgentView, "provider" | "pending">,
): { vendor: Provider; reason: string } | null {
  const vendors: Provider[] = [];
  if (agent.provider !== undefined && agent.provider !== null) vendors.push(agent.provider);
  const staged = agent.pending?.provider;
  if (staged !== undefined && staged !== null && !vendors.includes(staged)) vendors.push(staged);
  for (const vendor of vendors) {
    const reason = memoryVendorBlock(id, vendor);
    if (reason !== null) return { vendor, reason };
  }
  return null;
}

/** One option of the drawer's memory chooser. */
export interface MemoryOption {
  value: MemoryChoice;
  label: string;
  /** What the agent runs now. Never disabled: choosing it is "no change". */
  current: boolean;
  disabled: boolean;
  /** Why the option is disabled, in a full sentence; null when it is not. */
  reason: string | null;
}

/**
 * Every choice the agent drawer offers, in the create drawer's order: built-in
 * only, then each provider. A provider the agent's size is too small for, or
 * its vendor cannot serve, is disabled with the reason in its label — the same
 * refusals core's `agents.set` would answer with (`MEMORY_PROVIDER_UNDERSIZED`,
 * `MEMORY_LLM_UNSUPPORTED`).
 */
export function memoryOptions(agent: MemoryAgentFacts): MemoryOption[] {
  const current = currentMemoryChoice(agent);
  const memGib = memoryCheckGib(agent);
  const mark = (label: string, isCurrent: boolean) => (isCurrent ? `${label} · current` : label);
  const options: MemoryOption[] = [
    {
      value: MEMORY_PROVIDER_NONE,
      label: mark("None — built-in only", current === MEMORY_PROVIDER_NONE),
      current: current === MEMORY_PROVIDER_NONE,
      disabled: false,
      reason: null,
    },
  ];
  for (const p of MEMORY_PROVIDERS_LIST) {
    const isCurrent = current === p.id;
    const undersized = memGib !== null && memoryUndersized(p.id, memGib);
    const vendor = memoryVendorRefusal(p.id, agent);
    let label = p.label;
    let reason: string | null = null;
    if (!isCurrent && undersized) {
      label = `${p.label} — needs ≥ ${String(p.min_mem_gib)} GiB`;
      reason = `${p.label} needs at least ${String(p.min_mem_gib)} GiB of instance memory; ${String(agent.size)} has ${String(memGib)} GiB`;
    } else if (!isCurrent && vendor !== null) {
      label = `${p.label} — not for ${providerOption(vendor.vendor).label}`;
      reason = vendor.reason;
    }
    options.push({
      value: p.id,
      label: mark(label, isCurrent),
      current: isCurrent,
      disabled: reason !== null,
      reason,
    });
  }
  return options;
}

/**
 * Whether a memory switch saved now would be applied by a rollout now, or
 * waits for the next rollout or recreate. Read off the stored `status`, as
 * core reads it; a view without one falls back to its display status.
 */
export function memorySwitchesLive(agent: Pick<AgentView, "status" | "display_status">): boolean {
  // `CONVERGEABLE` (format.ts) restates core's list (`agents/converge.ts`),
  // which the page cannot import: a box that is not up cannot apply anything.
  return CONVERGEABLE.has(agent.status ?? agent.display_status);
}

/** Whether a choice is a server hermeticd installs beside Hermes (a first install takes a while). */
export function memoryChoiceIsService(choice: MemoryChoice): boolean {
  return choice !== MEMORY_PROVIDER_NONE && MEMORY_PROVIDERS[choice].kind === "service";
}

// --- Resource cards and the size fit ----------------------------------------

/** A choice's name and one-line summary, for a card or a radio row; none included. */
export function memoryChoiceText(choice: MemoryChoice): { label: string; summary: string } {
  if (choice === MEMORY_PROVIDER_NONE) {
    return { label: MEMORY_NONE_SPEC.label, summary: MEMORY_NONE_SPEC.summary };
  }
  const spec = MEMORY_PROVIDERS[choice];
  return { label: spec.label, summary: spec.summary };
}

/**
 * The smallest size of `family` with at least `minGib` of instance memory, or
 * null when none has. Within one family on purpose: `gpu-xsmall` has 8 GiB, but
 * telling someone who picked a CPU size to move to a GPU box is not the fix.
 */
export function smallestSizeFor(minGib: number, family: SizeSpec["family"] = "cpu"): SizeSpec | null {
  let best: SizeSpec | null = null;
  for (const s of SIZES) {
    if (s.family !== family || s.memGib < minGib) continue;
    if (best === null || s.memGib < best.memGib) best = s;
  }
  return best;
}

/**
 * `memoryResourceFacts` (core's, the one wording every head shares) with the
 * RAM floor suffixed by the smallest CPU size that meets it, as a chip reads:
 * `≥ 8 GiB (small+)`.
 */
export function memoryResourceChips(
  choice: MemoryChoice,
  vendor?: Provider | null,
): readonly MemoryResourceFact[] {
  const min = choice === MEMORY_PROVIDER_NONE ? 0 : MEMORY_PROVIDERS[choice].min_mem_gib;
  const floor = min > 0 ? smallestSizeFor(min) : null;
  return memoryResourceFacts(choice, vendor).map((f) =>
    f.key === "ram_floor" && floor !== null ? { ...f, value: `${f.value} (${floor.id}+)` } : f,
  );
}

/** How a memory choice sits on a size and a vendor (`memoryFit`). */
export type MemoryFitState = "fits" | "undersized" | "vendor-blocked" | "unknown";
export interface MemoryFitResult {
  state: MemoryFitState;
  message: string | null;
  switchTo: SizeId | null;
}
export interface MemoryFitContext {
  /** The size the agent gets, or null/absent when it is not known (an unread fleet default). */
  sizeId?: SizeId | null;
  /**
   * The instance memory to check, when it is not simply `sizeId`'s: null skips
   * the size check (e.g. `memoryCheckGib` for an explicit instance type).
   * Absent reads `sizeId`'s from `SIZES`.
   */
  memGib?: number | null;
  /** The agent's vendor, or null/absent when no usable profile is chosen yet. */
  vendor?: Provider | null;
}

/**
 * Whether a memory choice can run on a size and through a vendor:
 *
 * - `fits` — nothing core would refuse.
 * - `undersized` — the size has less instance memory than the provider's
 *   `min_mem_gib` (core's `MEMORY_PROVIDER_UNDERSIZED`). `switchTo` is the
 *   smallest size in the selected size's family that has enough.
 * - `vendor-blocked` — the provider's model calls cannot go through the
 *   vendor (core's `MEMORY_LLM_UNSUPPORTED`); `message` is `memoryVendorBlock`'s.
 * - `unknown` — a check that could fail had nothing to check against (the size
 *   or the vendor is not known yet); core decides, and nothing is said.
 *
 * Undersized is checked before the vendor, as the create drawer's gate always
 * has. `message` is null unless the state is a refusal.
 */
export function memoryFit(choice: MemoryChoice, ctx: MemoryFitContext = {}): MemoryFitResult {
  const fits: MemoryFitResult = { state: "fits", message: null, switchTo: null };
  if (choice === MEMORY_PROVIDER_NONE) return fits;
  const spec = MEMORY_PROVIDERS[choice];
  const sizeId = ctx.sizeId ?? null;
  const size = sizeId === null ? undefined : SIZES.find((s) => s.id === sizeId);
  const memGib = ctx.memGib !== undefined ? ctx.memGib : (size?.memGib ?? null);
  if (memGib !== null && memoryUndersized(choice, memGib)) {
    const target = smallestSizeFor(spec.min_mem_gib, size?.family ?? "cpu");
    const needs =
      target === null
        ? `Needs at least ${String(spec.min_mem_gib)} GiB of instance memory.`
        : `Needs size ${target.id} (${String(target.memGib)} GiB) or larger.`;
    const selected = sizeId === null ? `${String(memGib)} GiB` : `${sizeId} (${String(memGib)} GiB)`;
    return {
      state: "undersized",
      message: `${needs} Selected: ${selected}`,
      switchTo: target !== null && target.id !== sizeId ? target.id : null,
    };
  }
  const vendorReason = memoryVendorBlock(choice, ctx.vendor);
  if (vendorReason !== null) return { state: "vendor-blocked", message: vendorReason, switchTo: null };
  const vendorRestricted = spec.vendors.length < PROVIDER_IDS.length;
  const vendorUnknown = ctx.vendor === null || ctx.vendor === undefined;
  if ((memGib === null && spec.min_mem_gib > 0) || (vendorUnknown && vendorRestricted)) {
    return { state: "unknown", message: null, switchTo: null };
  }
  return fits;
}

/**
 * The vendors a provider cannot serve, as Settings' radio list words it under
 * the provider: `Not available for anthropic / bedrock agents: no embeddings
 * API`. Null for a provider every vendor can run (one with no `vendors_note`).
 * The vendor names come from the catalogue (`PROVIDER_IDS` less the spec's
 * `vendors`), so a vendor gaining an embeddings endpoint drops out on its own.
 */
export function memoryUnavailableNote(id: MemoryProvider): string | null {
  const spec = MEMORY_PROVIDERS[id];
  if (spec.vendors_note === undefined) return null;
  const excluded = PROVIDER_IDS.filter((v) => !spec.vendors.includes(v))
    .map((v) => providerOption(v).label)
    .sort();
  if (excluded.length === 0) return null;
  const why = spec.resources.embeddings === "provider" ? ": no embeddings API" : "";
  return `Not available for ${excluded.join(" / ")} agents${why}`;
}

/**
 * What the agent drawer's memory card says about a choice for this agent: the
 * vendor its chips speak for, and its fit.
 *
 * The vendor is the one that refuses the choice when one does (the running
 * vendor or a staged profile's, as `memoryVendorRefusal` checks both), else
 * the vendor the agent runs after the switch's rollout — the staged profile's,
 * when one is staged. The fit is `memoryFit` on the agent's size, held to the
 * same instance memory `memoryOptions` checks (`memoryCheckGib`), so the card's
 * warning and the chooser's disabled reasons are the same refusals. The
 * current choice gets no fit: choosing it is no change, and core refuses
 * nothing.
 */
export function memoryAgentCard(
  choice: MemoryChoice,
  agent: MemoryAgentFacts,
): { vendor: Provider | null; fit: MemoryFitResult | null } {
  const refusal = choice === MEMORY_PROVIDER_NONE ? null : memoryVendorRefusal(choice, agent);
  const vendor = refusal?.vendor ?? agent.pending?.provider ?? agent.provider ?? null;
  if (choice === currentMemoryChoice(agent)) return { vendor, fit: null };
  const fit = memoryFit(choice, { sizeId: agent.size ?? null, memGib: memoryCheckGib(agent), vendor });
  return { vendor, fit };
}
