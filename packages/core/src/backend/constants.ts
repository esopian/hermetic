/**
 * Constants shared by every `Backend` implementation. They live here rather than
 * in `memory.ts` so `aws/ssm.ts` can agree with the fixture backend without
 * importing the fixture fleet.
 */

import type { TagSelector } from "./types.ts";

/** The value hermetic writes into a slot it owns but has no value for yet (§8.2). */
export const SECRET_PLACEHOLDER = "__hermetic_placeholder__";

/**
 * The two *roots* of hermetic's SSM namespace: fleet-level slots live under
 * `/hermetic/`, per-agent ones under `/hermes/` (§8.2).
 *
 * Nothing is stored directly under a root. Every path a fleet writes is scoped
 * by its `fleet_id` (`/hermetic/<fleet_id>/…`, `/hermes/<fleet_id>/…`), because
 * two fleets in one AWS account would otherwise share the account's whole
 * parameter namespace: `atlas` in `main` and `atlas` in `staging` would be the
 * same slot, and one fleet's `teardown --purge` would delete the other's keys.
 *
 * The roots survive only for *listing legacy state*: parameters written before
 * fleet scoping sit directly under them, and the v3 foundation migration copies
 * those forward. A delete-by-prefix is never given a root (`teardown --purge`
 * passes the two fleet-scoped prefixes below) unless the directory proves this
 * is the account's only fleet.
 */
export const HERMETIC_PARAM_ROOT = "/hermetic/";

export const AGENT_PARAM_ROOT = "/hermes/";

/** Everything this fleet owns under `/hermetic/`. What `teardown --purge` deletes. */
export function hermeticParamPrefix(fleetId: string): string {
  return `${HERMETIC_PARAM_ROOT}${fleetId}/`;
}

/** Everything this fleet's *agents* can read: the ARN the instance role is scoped to. */
export function agentParamPrefix(fleetId: string): string {
  return `${AGENT_PARAM_ROOT}${fleetId}/`;
}

/** One agent's slot, `/hermes/<fleet_id>/<name>/<slot>` (§8.2). */
export function agentParamPath(fleetId: string, name: string, slot: string): string {
  return `${agentParamPrefix(fleetId)}${name}/${slot}`;
}

/** SecureString slot holding the tailnet OAuth client secret minted by hand (§5). */
export function tailscaleOauthSecretPath(fleetId: string): string {
  return `${hermeticParamPrefix(fleetId)}tailscale/oauth-secret`;
}

/** Optional companion slot; when absent the client id is parsed out of the secret. */
export function tailscaleOauthClientIdPath(fleetId: string): string {
  return `${hermeticParamPrefix(fleetId)}tailscale/oauth-client-id`;
}

/** Tag every hermetic-owned EC2 resource carries, and the DLM snapshot selector (§5). */
export const MANAGED_TAG = "hermetic:managed";
export const MANAGED_TAG_VALUE = "true";

/** The per-agent identity tag; the tag *is* the identity (§5.1). */
export const AGENT_TAG = "agent";

/**
 * Where a kept data volume's name goes when its agent is destroyed (§6.7).
 * `findVolumeByTag` selects on `AGENT_TAG` alone, so a volume tagged only with
 * this one is invisible to a plain `agent create <same name>` — the disk is
 * released from the name and adoptable only by an explicit `--volume vol-…`
 * (§9.1). The value is the former agent's name, for `volume ls` to show.
 */
export const FORMER_AGENT_TAG = "hermetic:former_agent";

/**
 * What a hermetic-managed volume is *for*. The root volume of an instance is
 * tagged `agent=<name>` too (EC2 copies instance tags onto it in some flows), so
 * "the data volume" needs a tag of its own — otherwise a resume could attach the
 * root disk and `destroy` — which deletes the data volume by default (§6.7) —
 * could delete the wrong one. Only
 * volumes carrying `hermetic:role=data` are the precious ones (§1).
 */
export const ROLE_TAG = "hermetic:role";
export const ROLE_DATA = "data";

/**
 * The tag the DLM policy of §7.1 selects volumes on, and therefore the tag its
 * snapshots carry — the only handle `teardown --delete-snapshots` has on them.
 */
export const DATA_SNAPSHOT_TAG: TagSelector = { key: ROLE_TAG, value: ROLE_DATA };

/** Stack tags (§5). */
export const FLEET_ID_TAG = "hermetic:fleet_id";
export const VERSION_TAG = "hermetic:version";

/** The stock Ubuntu LTS the fleet pins (§7.1). */
export const UBUNTU_RELEASE = "24.04";

/**
 * Fleet-level shared secrets (§8.3): `/hermetic/<fleet_id>/secrets/<slug>`,
 * SecureString, beside the Tailscale slots above.
 *
 * Under `/hermetic/`, which is the whole point: no instance role can read it.
 * The foundation grants `parameter/hermes/<fleet_id>/*` and nothing wider
 * (`aws/cfn-template.ts`), so a shared key reaches a box only by being *copied*
 * into that agent's own slot by the laptop that created it — never by the box
 * reading the fleet's copy. Widening the instance policy to `/hermetic/*` would
 * hand every agent the fleet's Tailscale OAuth client.
 */
export function sharedSecretPrefix(fleetId: string): string {
  return `${hermeticParamPrefix(fleetId)}secrets/`;
}

/** The slot one shared secret lives in. `slug` is `SecretSlug`-shaped, so it cannot escape. */
export function sharedSecretPath(fleetId: string, slug: string): string {
  return `${sharedSecretPrefix(fleetId)}${slug}`;
}
