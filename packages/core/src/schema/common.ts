import { z } from "zod";

/** ISO-8601 timestamp string. Every timestamp in hermetic is a string, never a Date. */
export const Iso = z.iso.datetime();
export type Iso = z.infer<typeof Iso>;

/** AWS region, e.g. `us-west-2`. */
export const Region = z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/);
export type Region = z.infer<typeof Region>;

/** Twelve-digit AWS account id. */
export const AccountId = z.string().regex(/^\d{12}$/);
export type AccountId = z.infer<typeof AccountId>;

/** Semver-ish version string as used for hermes / hermeticd pins (`0.15.0`). */
export const Version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
export type Version = z.infer<typeof Version>;

/** SHA-256 hex digest. */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256 = z.infer<typeof Sha256>;

/**
 * Crockford base32, lowercase, without `i`, `l`, `o`, `u` — chosen so a
 * `fleet_id` (§4.2) can be read aloud or typed by hand without the classic
 * 1/l/I and 0/O/o mixups. `mintFleetId` (`../fleet-id.ts`) draws from this via
 * rejection sampling; `FleetIdSchema` is the single source of truth for the
 * shape every `fleet_id` field must match.
 */
export const FLEET_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** An 8-character lowercase Crockford base32 fleet id, e.g. `k7m2x9qa`. */
export const FleetIdSchema = z
  .string()
  .regex(
    new RegExp(`^[${FLEET_ID_ALPHABET}]{8}$`),
    `fleet_id must be 8 lowercase Crockford base32 characters (${FLEET_ID_ALPHABET}, no i/l/o/u)`,
  );
export type FleetId = z.infer<typeof FleetIdSchema>;

/**
 * A provider profile's identity (§8.3): 8 characters of the same alphabet, for
 * the same reason — it is read aloud, typed by hand into `providers update`,
 * and must not be confusable with the display name an operator may change at
 * will. It lives here rather than in `profile.ts` because the agent row names
 * one too, and `profile.ts` reads `agent.ts`.
 */
export const ProfileId = z
  .string()
  .regex(
    new RegExp(`^[${FLEET_ID_ALPHABET}]{8}$`),
    `a profile id is 8 lowercase Crockford base32 characters (${FLEET_ID_ALPHABET}, no i/l/o/u)`,
  );
export type ProfileId = z.infer<typeof ProfileId>;

/**
 * The name of a fleet-level shared secret slot, `/hermetic/<fleet_id>/secrets/<slug>`.
 *
 * Shaped exactly like an agent name (`AGENT_NAME_RE` in `requests.ts`, which
 * cannot be imported here without a cycle) for one reason: the slug is
 * concatenated into an SSM path, and a shape that admits `.` or `/` is a shape
 * that can escape the prefix.
 *
 * It lives here rather than in `fleet.ts` because `profile.ts` names a slug too
 * and `fleet.ts` reads `profile.ts`; one definition in the module both depend
 * on is the only arrangement without a cycle.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const SecretSlug = z.string().regex(SLUG_RE);
export type SecretSlug = z.infer<typeof SecretSlug>;
