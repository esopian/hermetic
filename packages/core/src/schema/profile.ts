/**
 * Provider profiles (§8.3): a *named* credential plus model default for one
 * provider, held on the fleet rather than on an agent.
 *
 * The record the fleet holds is deliberately small and deliberately not a
 * secret: a profile names the slot its key lives in, never the key. Everything
 * an operator may legitimately choose — what this profile is called, which
 * model it defaults to, whether it is offered at all — is here; everything that
 * is a fact about Hermes stays in `PROVIDERS` (`agent.ts`).
 *
 * `provider` is immutable after create. A profile that changed provider would
 * be a different credential pointing at a different endpoint under a name
 * agents already pinned, and every agent bound to it would silently start
 * talking to somebody else.
 */
import { z } from "zod";
import { Iso, ProfileId, SecretSlug } from "./common.ts";
import { Provider } from "./agent.ts";

/**
 * What an operator calls a profile. Unique per fleet, compared
 * case-insensitively: `Anthropic Main` and `anthropic main` naming two
 * different credentials is a trap, not a feature.
 *
 * The same charset an agent name uses (`AGENT_NAME_RE`), widened only in
 * length: a profile name is a CLI argument and a path-free label, so admitting
 * `.` or `/` would buy nothing and cost the usual.
 */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ProfileName = z
  .string()
  .regex(PROFILE_NAME_RE, "a profile name is 1-40 characters of [a-z0-9-], starting alphanumeric");
export type ProfileName = z.infer<typeof ProfileName>;

/**
 * Where this profile's credential comes from.
 *
 * `role` is Bedrock and only Bedrock: the instance authenticates as itself, so
 * there is no slot and nothing to rotate. `secret` names a fleet shared slot
 * (`/hermetic/<fleet_id>/secrets/<slug>`) and never a value — the slug is the
 * whole of what this record may carry (§8.3).
 */
export const ProfileCredential = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("role") }),
  z.object({ kind: z.literal("secret"), slug: SecretSlug }),
]);
export type ProfileCredential = z.infer<typeof ProfileCredential>;

/** The slug a profile's own slot is called. Owned-by-profile is derivable from it. */
export function profileSlotSlug(id: string): string {
  return `profile-${id}`;
}

/** The profile id a slug belongs to, or null when nothing owns it. */
export function profileIdOfSlug(slug: string): string | null {
  const rest = slug.startsWith("profile-") ? slug.slice("profile-".length) : null;
  return rest !== null && ProfileId.safeParse(rest).success ? rest : null;
}

export const ProviderProfile = z.object({
  id: ProfileId,
  name: ProfileName,
  /** Immutable after create; see this module's note. */
  provider: Provider,
  /**
   * The model this profile resolves to. Always explicit — resolved from the
   * catalog once, at create, and then persisted — so a provider whose catalog
   * default rotates without a release cannot move an agent that is already
   * running.
   */
  model: z.string().min(1).max(200),
  /** Whether `agent create` offers this profile at all. */
  enabled: z.boolean(),
  /**
   * Bumped by every change. An agent pins the revision it was created against,
   * so "this profile moved since you bound to it" is a comparison rather than a
   * guess.
   */
  revision: z.number().int().positive(),
  credential: ProfileCredential,
  created_at: Iso,
  created_by: z.string(),
  updated_at: Iso,
  updated_by: z.string(),
});
export type ProviderProfile = z.infer<typeof ProviderProfile>;
