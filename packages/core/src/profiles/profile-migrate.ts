/**
 * Turning a fleet's legacy provider settings into provider profiles (§8.3).
 *
 * Before profiles, a fleet said at most one thing per provider: whether it was
 * offered, which model it defaulted to, and which shared secret slot held its
 * key (`FleetSettings.providers`). That is exactly one profile's worth of
 * information per provider, so the migration is a rename rather than a guess —
 * and everything it cannot derive it leaves alone.
 *
 * **It runs on read, not on write.** `settingsOf` normalises whatever came out
 * of DynamoDB, so every reader sees profiles immediately; the migrated record
 * is persisted by the next settings write, whenever that happens. A fleet that
 * is only ever read is therefore never rewritten, and two laptops reading the
 * same unmigrated `_fleet` see the same profiles with the same ids.
 *
 * **Which means the ids must be derived, not minted.** A random id would differ
 * between two reads of the same unmigrated item — `providers ls` would print
 * one id, and the `providers update <id>` that followed would find nothing. So
 * a migrated profile's id is a digest of the fleet id and the provider, which
 * is stable, unique within a fleet, and in the same alphabet a minted one uses.
 *
 * **It is idempotent.** Settings that already carry `profiles` are returned
 * untouched, whatever is in them — including an empty record, which is a fleet
 * whose profiles were all deleted and not a fleet awaiting migration.
 */
import { createHash } from "node:crypto";
import { FLEET_ID_ALPHABET, PROVIDERS, PROVIDERS_LIST, profileSlotSlug } from "../schema/index.ts";
import type { FleetSettings, Provider, ProviderProfile } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";

/** The same length and alphabet `mintFleetId` uses, derived rather than drawn. */
export function derivedProfileId(fleetId: string, provider: Provider): string {
  const digest = createHash("sha256").update(`hermetic:profile:${fleetId}:${provider}`).digest();
  let id = "";
  for (let i = 0; i < 8; i++) id += FLEET_ID_ALPHABET[digest[i]! % FLEET_ID_ALPHABET.length];
  return id;
}

/**
 * Whether this provider's legacy entry describes something worth carrying
 * forward.
 *
 * A key is the obvious one, and a model override is the other: both are
 * statements the operator made that a migration must not drop. The fleet's
 * default provider is included whatever it says, because `default_profile` has
 * to resolve to something — a fleet whose default is Bedrock has a perfectly
 * good role-authenticated profile and nothing to type.
 */
function worthMigrating(settings: FleetSettings, provider: Provider): boolean {
  if (provider === settings.defaults.provider) return true;
  const entry = settings.providers[provider];
  if (entry === undefined) return false;
  return entry.secret !== undefined || entry.default_model !== undefined;
}

/**
 * The settings as they stand, with profiles. Pure: no clock, no actor, no
 * store — every value it needs is already on the record it is given.
 */
export function withProviderProfiles(settings: FleetSettings, fleetId: string): FleetSettings {
  if (settings.profiles !== undefined) return settings;

  const profiles: Record<string, ProviderProfile> = {};
  for (const provider of PROVIDERS_LIST) {
    if (!worthMigrating(settings, provider)) continue;
    const entry = settings.providers[provider];
    const id = derivedProfileId(fleetId, provider);
    profiles[id] = {
      id,
      // The provider's own id, not its label: a label has spaces and capitals
      // and a profile name is a CLI argument.
      name: provider,
      provider,
      // The override the fleet stated, else the catalog's — resolved *now* and
      // then owned by the fleet, which is the whole point of a profile.
      model: entry?.default_model ?? PROVIDERS[provider].default_model,
      enabled: entry?.enabled ?? true,
      revision: 1,
      credential:
        PROVIDERS[provider].auth === "role"
          ? { kind: "role" }
          : entry?.secret === undefined
            ? // A keyed provider whose fleet held no shared slot: the profile
              // exists (it is the fleet's default) and is simply not ready
              // until somebody rotates a key into its own slot.
              { kind: "secret", slug: profileSlotSlug(id) }
            : { kind: "secret", slug: entry.secret },
      // Attributed to whoever last wrote these settings, at the time they wrote
      // them: this profile is a restatement of that write, not a new one.
      created_at: settings.updated_at,
      created_by: settings.updated_by,
      updated_at: settings.updated_at,
      updated_by: settings.updated_by,
    };
  }

  const defaultId = derivedProfileId(fleetId, settings.defaults.provider);
  return {
    ...settings,
    profiles,
    default_profile: profiles[defaultId] === undefined ? null : defaultId,
  };
}

/* ── keeping the legacy surface and the profiles in agreement ──────────────── */

/**
 * Every profile on a fleet, by name. Here rather than in
 * `provider-profiles.ts` because `settings.ts` needs it and that module already
 * reads `settings.ts`.
 */
export function profilesIn(settings: FleetSettings): ProviderProfile[] {
  const byId: Record<string, ProviderProfile> = settings.profiles ?? {};
  return Object.values(byId).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which profile of a provider a fleet designates: the fleet default when it is
 * this provider's, else the only profile of this provider, else nothing.
 */
export function designatedProfileIn(
  settings: FleetSettings,
  provider: Provider,
): ProviderProfile | null {
  const defaultId = settings.default_profile;
  const fleetDefault =
    defaultId === null || defaultId === undefined ? undefined : settings.profiles?.[defaultId];
  if (fleetDefault?.provider === provider) return fleetDefault;
  const ofProvider = profilesIn(settings).filter((p) => p.provider === provider);
  return ofProvider.length === 1 ? ofProvider[0]! : null;
}

/**
 * The profile a request names: the profile's `id`, then the `name` an operator
 * gave it, compared case-insensitively — so a profile somebody named after
 * another profile's id cannot shadow the profile that *is* that id (§8.3).
 *
 * Here for the reason `profilesIn` is: `settings.ts` resolves
 * `settings set --default-profile` with it, and `provider-profiles.ts` — which
 * re-exports it as `resolveProfile` — already reads `settings.ts`, so the
 * selector rule cannot live there without a cycle. One implementation, because
 * "which profile did the operator mean" must not have two answers.
 */
export function resolveProfileIn(settings: FleetSettings, selector: string): ProviderProfile {
  const byId = settings.profiles?.[selector];
  if (byId !== undefined) return byId;
  const needle = selector.toLowerCase();
  const matches = profilesIn(settings).filter((p) => p.name.toLowerCase() === needle);
  if (matches.length === 1) return matches[0]!;
  throw new HermeticError("NOT_FOUND", `no provider profile ${selector}`, { profile: selector });
}
