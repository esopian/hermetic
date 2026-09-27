/**
 * §8.3's provider profiles, as rules rather than as markup.
 *
 * Everything here is pure: what a readiness badge says, which profiles a create
 * may offer, whether Delete is allowed and why not, how a live catalog is
 * ordered against the model that is already selected. The drawers and sections
 * that render it stay about layout, and every one of these answers is testable
 * without a DOM.
 *
 * The UI may not import core (§3.1), so the *sentences* live here and the
 * *facts* come off the wire: core computes `ready`, `ready_reason`, `grant` and
 * `linked_agents`, and this module only decides how to say them.
 */
import type { AgentView, CatalogModel, ProfileReadyReason, ProfileView } from "../api/index.ts";
import { providerOption } from "./format.ts";
import type { ProviderOption } from "./format.ts";

/* ── readiness ───────────────────────────────────────────────────────────── */

export interface ReadyBadge {
  /** The word on the chip. */
  label: string;
  /** A CSS custom property, not a colour: the theme owns the actual value. */
  color: string;
  /** The full sentence, shown beside the chip and as its tooltip. */
  reason: string;
}

/**
 * "Stored" is never "verified" (§8.3): a key that is present may still be
 * wrong, and hermetic refuses to guess by making an inference call. So the
 * ready sentence says what is actually known — a key exists — and nothing more.
 */
const READY_BADGE: Record<ProfileReadyReason, ReadyBadge> = {
  role: {
    label: "ready",
    color: "var(--ok)",
    reason: "authenticates as the instance role — there is no key and nothing to rotate",
  },
  "key-set": {
    label: "ready",
    color: "var(--ok)",
    reason: "a key is stored in this profile's slot; stored is not the same as verified",
  },
  disabled: {
    label: "disabled",
    color: "var(--fg3)",
    reason: "disabled — a create does not offer it",
  },
  "key-missing": {
    label: "no key",
    color: "var(--bad)",
    reason: "nothing is stored in this profile's slot yet — use Rotate key",
  },
  "key-placeholder": {
    label: "placeholder",
    color: "var(--bad)",
    reason: "the slot holds the placeholder written when it was created, not a key",
  },
  "grant-missing": {
    label: "needs foundation update",
    color: "var(--warn)",
    reason:
      "the fleet's instance role may not invoke this model yet — run a foundation update to add the grant",
  },
};

export function readyBadge(profile: Pick<ProfileView, "ready_reason">): ReadyBadge {
  return (
    READY_BADGE[profile.ready_reason] ?? {
      label: String(profile.ready_reason),
      color: "var(--fg3)",
      reason: String(profile.ready_reason),
    }
  );
}

/** What a create may offer (§8.3): enabled, credentialed, and — on Bedrock — granted. */
export function readyProfiles(profiles: readonly ProfileView[]): ProfileView[] {
  return profiles.filter((p) => p.ready);
}

export function profileById(
  profiles: readonly ProfileView[],
  id: string | null | undefined,
): ProfileView | null {
  if (id === null || id === undefined || id === "") return null;
  return profiles.find((p) => p.id === id) ?? null;
}

/**
 * The profile a create preselects: the fleet's default when it is ready,
 * otherwise nothing — "require a choice" is the stated behaviour, and quietly
 * substituting another profile would build the agent against a credential
 * nobody picked.
 */
export function preselectedProfile(
  profiles: readonly ProfileView[],
  defaultProfile: string | null,
): ProfileView | null {
  const fallback = profileById(profiles, defaultProfile);
  return fallback?.ready === true ? fallback : null;
}

/* ── what a profile's own actions are allowed to do ──────────────────────── */

export interface Allowed {
  ok: boolean;
  /** Why not; also the disabled button's tooltip. */
  reason?: string;
}

/**
 * The same refusals core raises, said before the request rather than after it.
 * Both are stated, in that order, so an operator who clears one is told about
 * the other rather than discovering it on the next click.
 */
export function canDeleteProfile(profile: ProfileView): Allowed {
  if (profile.linked_agents.length > 0) {
    return {
      ok: false,
      reason: `still used by ${profile.linked_agents.join(", ")} — move those agents to another profile first`,
    };
  }
  if (profile.is_default) {
    return { ok: false, reason: "this is the fleet default — set another profile as default first" };
  }
  return { ok: true };
}

/** Disabling the fleet default would leave a create with nothing to resolve to. */
export function canDisableProfile(profile: ProfileView): Allowed {
  if (profile.is_default && profile.enabled) {
    return { ok: false, reason: "this is the fleet default — set another profile as default first" };
  }
  return { ok: true };
}

/** Only a ready profile may become the default a create falls back to. */
export function canSetDefault(profile: ProfileView): Allowed {
  if (profile.is_default) return { ok: false, reason: "already the fleet default" };
  if (!profile.ready) {
    return { ok: false, reason: `not ready — ${readyBadge(profile).reason}` };
  }
  return { ok: true };
}

/** Bedrock has no key, so there is nothing to rotate into. */
export function canRotateKey(profile: Pick<ProfileView, "credential">): Allowed {
  if (profile.credential.kind === "role") {
    return { ok: false, reason: "authenticates as the instance role — there is no key to rotate" };
  }
  return { ok: true };
}

/* ── the catalog ─────────────────────────────────────────────────────────── */

/**
 * The catalog as the picker draws it: the selected model first, whether or not
 * the provider still lists it.
 *
 * A custom id an operator typed, and a model a provider retired, are the same
 * case from here — the selection must stay visible and stay selected (§8.3), so
 * one that is missing is *synthesized* as `unlisted` rather than dropped. Which
 * is also why a refresh can never move the selection: this function is the only
 * thing that decides what is at the top, and it reads the selection, never the
 * catalog's own default.
 */
export function pinSelected(models: readonly CatalogModel[], selected: string): CatalogModel[] {
  const id = selected.trim();
  if (id === "") return [...models];
  const found = models.find((m) => m.id === id);
  const rest = models.filter((m) => m.id !== id);
  return [found ?? { id, name: id, unlisted: true }, ...rest];
}

/** Substring over id and display name, case-insensitively. Empty query matches everything. */
export function searchModels(models: readonly CatalogModel[], query: string): CatalogModel[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...models];
  return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
}

/**
 * What a failed catalog read says. The code is kept — it is the difference
 * between "the key is wrong" and "the provider is down", and the operator's
 * next move is different for each — and the message core wrote follows it.
 */
export function catalogFailure(code: string, message: string): string {
  const said =
    code === "PROVIDER_AUTH"
      ? "the provider rejected this key"
      : code === "PROVIDER_UNREACHABLE"
        ? "the provider could not be reached"
        : code === "PROVIDER_MALFORMED"
          ? "the provider answered with something this build cannot read"
          : message;
  return `${code} · ${said}`;
}

/* ── an agent's binding ──────────────────────────────────────────────────── */

/**
 * Whether the profile an agent is pinned to has moved since it was pinned.
 *
 * The row's own `update_available` wins, because core computed it against the
 * settings it actually read. It is *absent* when those settings could not be
 * read at all, and absent must not be rendered as "up to date" — so the
 * fallback is the same comparison made from the profile list this page already
 * holds, which is the arithmetic core would have done.
 */
export function profileUpdateAvailable(
  agent: Pick<AgentView, "profile_id" | "profile_revision" | "update_available">,
  profiles: readonly ProfileView[],
): boolean {
  if (typeof agent.update_available === "boolean") return agent.update_available;
  const pinned = agent.profile_revision;
  const bound = profileById(profiles, agent.profile_id);
  if (bound === null || pinned === undefined) return false;
  return bound.revision > pinned;
}

/**
 * What an agent's running configuration authenticates with, in one line.
 *
 * `credential_ref` has three states and only one of them is a slot name. A
 * *string* is the instance secret slot the running configuration was
 * materialised from. `null` is the cleared state core writes when an agent
 * moves onto a role-authenticated provider: there is no key, and naming a slot
 * would be a promise about a parameter nothing writes. `undefined` is a row
 * written before profiles existed, whose credential lives in the legacy
 * `provider-key` slot — but only if its provider has a key at all, which is
 * what `env === null` answers for Bedrock.
 *
 * Rendering `null` as `provider-key` — which it did — told an operator their
 * Bedrock agent was reading a key slot that has been empty since the day it was
 * created.
 */
export function credentialLine(
  agent: Pick<AgentView, "provider" | "credential_ref">,
  profiles: readonly ProfileView[] = [],
  profileId?: string | null,
): { text: string; mono: boolean } {
  if (typeof agent.credential_ref === "string") {
    return { text: agent.credential_ref, mono: true };
  }
  // The binding's own credential kind when there is one, and the provider's
  // otherwise: a profile is the more specific answer, and a row with no profile
  // still has a provider that either takes a key or does not.
  const bound = profileById(profiles, profileId);
  const role =
    bound !== null ? bound.credential.kind === "role" : providerOption(agent.provider).env === null;
  if (agent.credential_ref === null || role) {
    return { text: "IAM instance role · no key", mono: false };
  }
  return { text: "provider-key", mono: true };
}

/** A profile's provider, spelled the way the rest of the UI spells providers. */
export function providerSpec(profile: Pick<ProfileView, "provider">): ProviderOption {
  return providerOption(profile.provider);
}

/**
 * How a profile is named on one line: what an operator called it, then what it
 * actually is. The id is not in here — it is eight characters of noise in a
 * list where the name is unique by construction — but it is on the row itself.
 */
export function profileLine(profile: ProfileView): string {
  return `${profile.name} · ${providerSpec(profile).label} · ${profile.model}`;
}

/**
 * The staged change an agent is carrying, as one sentence. Distinct from the
 * running configuration on purpose: nothing on the box has moved yet, and the
 * banner has to say what *will* happen, not what did.
 */
export function pendingSummary(
  pending: NonNullable<AgentView["pending"]>,
  profiles: readonly ProfileView[],
): string {
  const bound = profileById(profiles, pending.profile_id);
  const name = bound?.name ?? pending.profile_id;
  return `${name} · ${pending.provider} · ${pending.model}`;
}
