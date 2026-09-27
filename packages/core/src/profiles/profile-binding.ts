/**
 * Binding an agent to a provider profile (§8.3): which profile a create means,
 * whether it may be used, and where the credential the box reads comes from.
 *
 * Its own module for the reason `provider-profiles.ts` is one (core rule 5):
 * `lifecycle.ts` and `hermetic.ts` are the two files that keep running into the
 * 2500-line cap, and both of them need exactly this subject. Everything here
 * takes its dependencies as an explicit object rather than closing over a
 * backend, so a test can bind an agent with four functions.
 *
 * ## The one rule
 *
 * **The credential is resolved by core, from the profile, at the moment the
 * binding is written — never from the request.** A head may not hand hermetic a
 * key for an agent, because a key that arrived that way belongs to nothing: no
 * profile owns it, no rotation reaches it, and the fleet cannot say where the
 * agent's credential came from. `providers create --api-key-stdin` is the one
 * place a key is typed.
 *
 * ## Why a snapshot rather than a reference
 *
 * A bound agent gets its *own* copy of the profile's key, in an instance slot
 * named for the profile revision it was bound at
 * (`provider-key-<profile_id>-r<revision>`). The instance role can read only
 * `/hermes/<fleet_id>/<agent>/*`, so a box can never read the fleet's shared
 * slot; the copy happens on the laptop, with the operator's credentials, which
 * is the same rule `create` has always followed.
 *
 * Naming the slot after the profile *and* the revision is what makes a rotation
 * — or a switch to another profile — *stageable*. The new key goes into a slot
 * the running configuration does not name, so nothing changes underneath a box
 * that is still serving; the manifest that names the new slot is what carries
 * the change, and it carries it through `config_hash` like every other
 * configuration change. The profile id is in the name because revisions start
 * at 1 per profile: a slot named for the revision alone would put a switch
 * between two r1 profiles back into the slot the box is reading. Older slots
 * are never deleted — an
 * agent that has to be rolled back to its previous binding must still find the
 * credential that binding ran on — and `destroy` takes the whole prefix.
 */
import {
  DEFAULT_PROVIDER_KEY_SLOT,
  PROVIDERS,
  isProviderKeySlot,
  providerKeySlot,
  providerNeedsKey,
} from "../schema/index.ts";
import type { Agent, FleetItem, FleetSettings, Provider, ProviderProfile } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import {
  bedrockGrantOf,
  designatedProfile,
  grantedBedrockModels,
  profilesOf,
  resolveProfile,
  rowProfile,
} from "./provider-profiles.ts";
import type { ReadyReason } from "./provider-profiles.ts";

/** What this module needs of a backend, and nothing else. */
export interface BindingPorts {
  secrets: {
    exists(path: string): Promise<boolean>;
    isPlaceholder(path: string): Promise<boolean>;
    get(path: string): Promise<string>;
    ensureSlot(path: string): Promise<void>;
    put(path: string, value: string): Promise<void>;
  };
  /** `/hermetic/<fleet_id>/secrets/<slug>` — the fleet's shared slot for a profile. */
  sharedPath: (slug: string) => string;
  /** `/hermes/<fleet_id>/<agent>/<slot>` — an agent's own slot, which its role may read. */
  agentPath: (agent: string, slot: string) => string;
}

/**
 * Whether the slot behind a profile holds a real value, asked at the moment of
 * binding rather than read off a list computed seconds ago.
 *
 * **No value leaves this function**: it reads presence and the placeholder
 * marker, never the key. "Stored" is never "verified" either (§8.3) — a key
 * that is present may still be wrong, and hermetic refuses to find that out by
 * spending somebody's tokens on an inference call.
 */
export async function bindingReadiness(
  ports: BindingPorts,
  profile: ProviderProfile,
): Promise<{ ready: boolean; reason: ReadyReason }> {
  if (!profile.enabled) return { ready: false, reason: "disabled" };
  if (profile.credential.kind === "role") return { ready: true, reason: "role" };
  const path = ports.sharedPath(profile.credential.slug);
  if (!(await ports.secrets.exists(path))) return { ready: false, reason: "key-missing" };
  if (await ports.secrets.isPlaceholder(path)) return { ready: false, reason: "key-placeholder" };
  return { ready: true, reason: "key-set" };
}

/** Everything a create or an apply writes onto the row about the provider. */
export interface ProfileBinding {
  provider: Provider;
  profile_id: string;
  profile_revision: number;
  model: string;
  /**
   * The instance slot the box materialises the key from, or `null` for a
   * role-authenticated provider — which has no key, and whose rows carry no
   * `credential_ref` rather than one pointing at an empty slot.
   */
  credential_ref: string | null;
}

/* ── selection ─────────────────────────────────────────────────────────────── */

/**
 * The profile a create means (§8.3), in the order the spec states:
 *
 * 1. `provider_profile` — by id, else by name.
 * 2. `provider` — the fleet's designated profile for it, and `AMBIGUOUS_PROFILE`
 *    listing the candidates when there is more than one to choose between.
 * 3. neither — the fleet's default profile.
 *
 * Both together is a `VALIDATION`: they are two different answers to one
 * question, and picking either would be guessing which the operator meant.
 */
export function selectCreateProfile(
  settings: FleetSettings,
  input: { provider?: Provider | undefined; provider_profile?: string | undefined },
): ProviderProfile {
  if (input.provider !== undefined && input.provider_profile !== undefined) {
    throw new HermeticError(
      "VALIDATION",
      "--provider names a provider and --provider-profile names a credential; pass one",
      { provider: input.provider, provider_profile: input.provider_profile },
    );
  }

  if (input.provider_profile !== undefined) return resolveProfile(settings, input.provider_profile);

  if (input.provider !== undefined) {
    const designated = designatedProfile(settings, input.provider);
    if (designated !== null) return designated;
    const candidates = profilesOf(settings).filter((p) => p.provider === input.provider);
    if (candidates.length === 0) {
      throw new HermeticError(
        "VALIDATION",
        `this fleet has no ${input.provider} profile; run \`hermetic providers create --provider ${input.provider} --name <name>\``,
        { provider: input.provider },
      );
    }
    throw new HermeticError(
      "AMBIGUOUS_PROFILE",
      `this fleet has ${String(candidates.length)} ${input.provider} profiles (${candidates
        .map((p) => p.name)
        .join(", ")}); name one with --provider-profile`,
      { provider: input.provider, candidates: candidates.map((p) => p.id) },
    );
  }

  const defaultId = settings.default_profile;
  const fallback =
    defaultId === null || defaultId === undefined ? undefined : settings.profiles?.[defaultId];
  if (fallback !== undefined) return fallback;
  throw new HermeticError(
    "VALIDATION",
    "no provider profile is ready; run `hermetic providers create`",
    {},
  );
}

/**
 * The profile an existing row is bound to, or `null` when it names none.
 *
 * A row without `profile_id` is not broken: every agent created before profiles
 * existed is one, and the answer for it is `rowProfile` — the fleet's
 * designation for its provider, else the provider's oldest profile — the same
 * rule `providers.list` reports `linked_agents` with, so "which profile is this
 * agent on" has one answer wherever it is asked.
 */
export function boundProfile(settings: FleetSettings, agent: Agent): ProviderProfile | null {
  if (agent.profile_id !== undefined) return settings.profiles?.[agent.profile_id] ?? null;
  return rowProfile(settings, agent.provider);
}

/**
 * Whether the profile an agent is pinned to has moved since it was pinned
 * (§8.3). The head renders it as "Update available"; nothing stages it, because
 * a profile edit is not an instruction to restart somebody's agent.
 */
export function profileUpdateAvailable(settings: FleetSettings, agent: Agent): boolean {
  if (agent.profile_id === undefined || agent.profile_revision === undefined) return false;
  const profile = settings.profiles?.[agent.profile_id];
  return profile !== undefined && agent.profile_revision < profile.revision;
}

/* ── refusals ──────────────────────────────────────────────────────────────── */

/**
 * The key a head is no longer allowed to supply (§8.3).
 *
 * Refused rather than ignored, and with the command that replaces it: a create
 * that silently dropped the key would produce an agent whose slot is empty for
 * a reason nothing on screen explains.
 */
export function assertNoInlineKey(input: { api_key?: string | undefined }): void {
  if (input.api_key === undefined) return;
  throw new HermeticError(
    "VALIDATION",
    "keys live on provider profiles; run `hermetic providers create --provider <p> --api-key-stdin`",
    {},
  );
}

/** Why a profile cannot be bound to right now, as a sentence, or `null`. */
function unusableBecause(profile: ProviderProfile, reason: ReadyReason): string | null {
  switch (reason) {
    case "role":
    case "key-set":
      return null;
    case "disabled":
      return `the profile ${profile.name} is disabled; \`hermetic providers update ${profile.name} --enable\``;
    case "key-missing":
    case "key-placeholder":
      return `the profile ${profile.name} has no key stored; \`hermetic providers update ${profile.name} --api-key-stdin\``;
    case "grant-missing":
      return `the profile ${profile.name} names a Bedrock model this fleet's role may not invoke`;
  }
}

/**
 * Ask again, at the moment of writing, whether this profile may be used.
 *
 * The drawer that listed it did so seconds ago and against a different read;
 * between then and here somebody may have disabled it or emptied its slot, and
 * a create that went ahead would produce an agent that cannot start for a
 * reason the fleet already knew.
 */
export async function assertProfileUsable(
  ports: BindingPorts,
  profile: ProviderProfile,
): Promise<void> {
  const { reason } = await bindingReadiness(ports, profile);
  const why = unusableBecause(profile, reason);
  if (why !== null) throw new HermeticError("VALIDATION", why, { profile: profile.id, reason });
}

/**
 * §5.1: the fleet's instance role may invoke exactly the model ARNs its
 * foundation was given, so a Bedrock model outside that set is an agent that
 * would boot and then fail every turn with `AccessDeniedException`.
 *
 * Refused, and **never substituted**. Quietly running somebody's agent on a
 * model they did not choose is the failure this check exists to prevent, not a
 * fallback it may take.
 */
export function assertModelGranted(provider: Provider, model: string, fleet: FleetItem): void {
  if (provider !== "bedrock") return;
  const granted = grantedBedrockModels(fleet);
  if (bedrockGrantOf(model, granted) === "granted") return;
  throw new HermeticError(
    "MODEL_NOT_GRANTED",
    `this fleet's role may not invoke the Bedrock model ${model}; run \`hermetic foundation update\` to grant it`,
    { model, granted },
  );
}

/* ── the binding itself ────────────────────────────────────────────────────── */

/**
 * What the row will say, given a profile and whatever model the operator
 * stated. The model is the profile's unless one was named — a profile's model
 * is a default, not a ceiling.
 */
export function bindingOf(profile: ProviderProfile, model?: string | undefined): ProfileBinding {
  return {
    provider: profile.provider,
    profile_id: profile.id,
    profile_revision: profile.revision,
    model: model ?? profile.model,
    credential_ref: providerNeedsKey(profile.provider)
      ? providerKeySlot(profile.id, profile.revision)
      : null,
  };
}

/**
 * Copy the profile's credential into this agent's own slot for that revision.
 *
 * On the laptop, with the operator's credentials, and never into a slot another
 * revision names: the value is a local `const` that goes to SSM and nowhere
 * else (§8.3). Idempotent — re-running a create that already snapshotted writes
 * the same bytes — and it returns the paths it touched so `create` can record
 * them on `resources.ssm_paths`.
 */
export async function snapshotCredential(
  ports: BindingPorts,
  profile: ProviderProfile,
  agentName: string,
  credentialRef: string | null | undefined,
): Promise<{ path: string; filled: boolean } | null> {
  if (credentialRef === null || credentialRef === undefined) return null;
  const path = ports.agentPath(agentName, credentialRef);
  await ports.secrets.ensureSlot(path);
  if (profile.credential.kind !== "secret") return { path, filled: false };
  const source = ports.sharedPath(profile.credential.slug);
  if (!(await ports.secrets.exists(source)) || (await ports.secrets.isPlaceholder(source))) {
    return { path, filled: false };
  }
  const value = await ports.secrets.get(source);
  await ports.secrets.put(path, value);
  return { path, filled: true };
}

/**
 * The slot a row's *running* configuration reads, for every reader that has to
 * name it: the renderer, `secrets push --provider-key`, `secrets verify`.
 *
 * A row that names none is a row written before profiles existed, and the
 * answer for it is the slot every agent has always had.
 */
export function credentialSlotOf(agent: Pick<Agent, "credential_ref">): string {
  const ref = agent.credential_ref;
  return typeof ref === "string" && isProviderKeySlot(ref) ? ref : DEFAULT_PROVIDER_KEY_SLOT;
}

/* ── staging a change, and applying it ─────────────────────────────────────── */

export interface StageInput {
  provider?: Provider | undefined;
  provider_profile?: string | undefined;
  refresh_profile?: boolean | undefined;
  model?: string | undefined;
}

/** Whether this `agents.set` is asking for a profile change at all. */
export function stagesProfileChange(input: StageInput): boolean {
  return (
    input.provider !== undefined ||
    input.provider_profile !== undefined ||
    input.refresh_profile === true
  );
}

/**
 * What `agents.set` writes to `Agent.pending` (§8.3), or the refusal.
 *
 * Three shapes of request, one answer:
 *
 * - **switch** (`provider_profile`, or a bare `provider`): the new profile at
 *   its current revision, and the model resets to that profile's unless one is
 *   named in the same call. Resetting is the point — an explicit model that
 *   survived a switch would be a model id from one provider's catalog aimed at
 *   another's endpoint.
 * - **refresh** (`refresh_profile`): the profile the row is already on, at
 *   whatever revision it has reached, keeping the explicit model override the
 *   row carries. This is how a rotated key or an edited profile reaches an
 *   agent, and it must not quietly undo a model the operator chose.
 * - **model only**: not a profile change at all; the caller handles it as the
 *   ordinary managed setting it has always been.
 *
 * Nothing here writes. Staging is a row write the caller makes under CAS, and
 * the credential is copied by the apply — not by this.
 */
export function stageProfileChange(
  settings: FleetSettings,
  agent: Agent,
  input: StageInput,
  at: { staged_at: string; staged_by: string },
): NonNullable<Agent["pending"]> {
  const refreshOnly =
    input.refresh_profile === true &&
    input.provider === undefined &&
    input.provider_profile === undefined;

  const target = refreshOnly
    ? (boundProfile(settings, agent) ??
      (() => {
        throw new HermeticError(
          "VALIDATION",
          `${agent.name} is not bound to a provider profile, so there is nothing to refresh; \`hermetic agent set ${agent.name} --provider-profile <id|name>\``,
          { name: agent.name },
        );
      })())
    : selectCreateProfile(settings, input);

  /**
   * A refresh is never a switch, including on a legacy row.
   *
   * The comparison below is `target.id !== agent.profile_id`, and a row written
   * before profiles existed has no `profile_id` at all — so the profile
   * `boundProfile` answered with (the fleet's designation for that row's
   * provider) reads as a *different* profile and the model resets. That is the
   * one thing a refresh promises not to do: it is how a rotated key reaches an
   * agent, and an operator who rotates a key must not discover afterwards that
   * the model they pinned was replaced by the profile's.
   */
  const switching = !refreshOnly && target.id !== agent.profile_id;
  const model = input.model ?? (switching ? target.model : (agent.hermes?.model ?? target.model));
  const binding = bindingOf(target, model);

  return {
    profile_id: binding.profile_id,
    profile_revision: binding.profile_revision,
    provider: binding.provider,
    model: binding.model,
    ...(binding.credential_ref === null ? {} : { credential_ref: binding.credential_ref }),
    staged_at: at.staged_at,
    staged_by: at.staged_by,
  };
}

/**
 * The row patch that turns a staged change into the running one, once the
 * credential has been snapshotted.
 *
 * `credential_ref` is written as `null` rather than left alone when the new
 * binding has no slot: an agent moved onto Bedrock authenticates as the
 * instance role, and a row still naming the slot its previous binding filled
 * would keep a stale credential alive in every reading of the fleet — and would
 * render a manifest telling hermeticd to materialise it.
 */
export function applyPendingPatch(agent: Agent): Record<string, unknown> {
  const pending = agent.pending;
  if (pending === null || pending === undefined) return {};
  return {
    provider: pending.provider,
    profile_id: pending.profile_id,
    profile_revision: pending.profile_revision,
    credential_ref: pending.credential_ref ?? null,
    hermes: { ...(agent.hermes ?? {}), model: pending.model },
    pending: null,
  };
}

/**
 * The row as it *will* stand once the staged change is applied — the same patch
 * `applyPendingPatch` writes, laid over the row rather than sent to the store.
 *
 * It exists because a plan has to answer a question about a future row without
 * writing one: `plan.rollout` reports the `config_hash` each agent will
 * converge to, and rendering the row as it stands would promise a hash the
 * apply then does not produce (the apply re-renders *after* rewriting the
 * binding). Derived from `applyPendingPatch` rather than repeating it, so the
 * plan's answer and the apply's write cannot drift apart.
 */
export function pendingApplied(agent: Agent): Agent {
  const patch = applyPendingPatch(agent);
  return Object.keys(patch).length === 0 ? agent : ({ ...agent, ...patch } as Agent);
}

/**
 * What an operator is told about a staged change, in one line (§8.3). Core
 * states it, the head prints it; `plan.rollout` carries it per agent and the
 * agent's own event log records it.
 */
export function describePending(agent: Agent): string | null {
  const pending = agent.pending;
  if (pending === null || pending === undefined) return null;
  const from = `${agent.provider}/${agent.hermes?.model ?? "(seeded model)"}`;
  const to = `${pending.provider}/${pending.model}`;
  const label = PROVIDERS[pending.provider].label;
  return from === to
    ? `re-pin ${label} profile ${pending.profile_id} at r${String(pending.profile_revision)}`
    : `${from} → ${to} (profile ${pending.profile_id} r${String(pending.profile_revision)})`;
}
