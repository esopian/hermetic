/**
 * What a create inherits from the fleet when the operator states nothing
 * (§4.6, §8.1, §10) — one pure function, so the CLI can ask the same question
 * *before* it decides whether to prompt for a key that the fleet already has.
 *
 * The whole of the rule is the distinction between the two ways a value can
 * reach an agent:
 *
 * - **Stated** by the operator on this create → hermetic manages it. It goes
 *   into the managed config and is rewritten on every apply.
 * - **Inherited** from fleet settings → hermetic *seeds* it. A fleet default is
 *   not a per-agent instruction, so the agent's own dashboard may still change
 *   it (`splitHermesSettings`, §6.4).
 *
 * The seed is resolved here, at create, and pinned on the row rather than being
 * re-read at render time. That is deliberate: a later `hermetic settings set`
 * or a profile's model would otherwise silently change every existing
 * agent's rendered config — and with it every `config_hash` — turning one
 * settings write into fleet-wide drift.
 */
import { PROVIDERS, providerNeedsKey } from "../schema/index.ts";
import type { FleetSettings, HermesSettings, Provider } from "../schema/index.ts";

/**
 * Where this agent's provider key comes from, decided before anything is
 * written. `{ shared }` names a slot, never a value — the copy itself happens
 * in `lifecycle.ts`, on the laptop, with the operator's credentials (§8.3).
 *
 * `"prompt"` is the head's cue, not core's: core cannot prompt (rule 1), so it
 * means "nobody supplied one" and ends in the warning that says how to fill the
 * slot later. `"none"` is a role-authenticated provider, which has no key at
 * all.
 */
export type KeySource = "input" | { shared: string } | "prompt" | "none";

/** The fields of a create request this resolution depends on, and no others. */
export interface CreateDefaultsInput {
  provider?: Provider | undefined;
  hermes?: HermesSettings | null | undefined;
  api_key?: string | undefined;
}

export interface CreateDefaults {
  provider: Provider;
  /**
   * The model an agent that named none is seeded with: the provider's fleet
   * override, else the fleet-wide `agent_defaults.model`, else the catalog's
   * (`providerDefaultModel` is the same rule without the middle step).
   */
  seed_model: string;
  /**
   * The whole seed layer for this agent — `agent_defaults` with the resolved
   * model in it. Stored on the row as `seed` and handed to
   * `splitHermesSettings`, which fills only the fields the operator left
   * unstated: every field here can still be overridden on the box.
   */
  seed: HermesSettings;
  key_source: KeySource;
}

/**
 * Where the key for one provider comes from on this fleet.
 *
 * Split out of `resolveCreateDefaults` because `create` asks it a second time
 * once the row is settled: a resumed create's provider is whatever the existing
 * row says, which is not necessarily what this request asked for, and re-running
 * the whole resolution would also re-run the "disabled" refusal against an
 * agent that already exists.
 */
export function providerKeySource(
  provider: Provider,
  settings: FleetSettings,
  apiKey?: string | undefined,
): KeySource {
  if (apiKey !== undefined) return "input";
  if (!providerNeedsKey(provider)) return "none";
  const slug = settings.providers[provider]?.secret;
  return slug === undefined ? "prompt" : { shared: slug };
}

/**
 * The fleet's answers for one create request. Pure and total: it refuses
 * nothing, so a head may ask it what *would* happen — which is what the CLI
 * does before deciding whether to prompt for a key, on a command that may
 * equally be resuming an agent that already exists.
 */
export function resolveCreateDefaults(
  input: CreateDefaultsInput,
  settings: FleetSettings,
): CreateDefaults {
  const provider = input.provider ?? settings.defaults.provider;

  const seed_model =
    settings.providers[provider]?.default_model ??
    settings.agent_defaults?.model ??
    PROVIDERS[provider].default_model;

  return {
    provider,
    seed_model,
    seed: { ...settings.agent_defaults, model: seed_model },
    key_source: providerKeySource(provider, settings, input.api_key),
  };
}
