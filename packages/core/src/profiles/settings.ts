/**
 * The fleet's shared settings (§4.6): `settings.get` and `settings.set`.
 *
 * Its own module for the reason `lifecycle.ts` and `teardown.ts` are (core rule
 * 5): it is a subject with a dependency list it can be handed, and
 * `hermetic.ts` is the file that keeps running into the 2500-line cap. What it
 * shares with nothing else is the concurrency rule below.
 *
 * **Two writers, one `_fleet`.** A `foundation update` holds the fleet lock and
 * rewrites the whole item, and every laptop attached to this fleet can set
 * settings. So a write here is refused twice over — once by `settings.version`,
 * which is the counter this object exists to carry, and once by the lock, which
 * is somebody else already rewriting the item this would land on. Both
 * conditions are evaluated by the store against what is *stored*
 * (`FleetStore.putSettings`), never against the copy this closure read.
 *
 * **Absent is not empty.** A fleet created before this feature has no
 * `settings` at all, and `settings.get` says so (`persisted: false`) while
 * still answering with what that fleet's settings *are* — synthesized from
 * `_fleet.defaults` and the provider catalog by `defaultFleetSettings`, the
 * same function `init` and the v2 migration use. The first write on such a
 * fleet is conditional on `attribute_not_exists`, so two laptops racing to be
 * the first cannot both win.
 */
import {
  FLEET_KEY,
  PROVIDERS,
  SettingsGetInput as SettingsGetInputSchema,
  SettingsSetInput as SettingsSetInputSchema,
  defaultFleetSettings,
} from "../schema/index.ts";
import type {
  FleetItem,
  FleetSettings,
  HermesSettings,
  LocalConfig,
  SettingsGetInput,
  SettingsSetInput,
} from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import { resolveProfileIn, withProviderProfiles } from "./profile-migrate.ts";
import type { Backend, StackInfo } from "../backend/types.ts";
import type { CoreContext } from "../context.ts";

/**
 * The half of the settings surface `secrets.ts` shares: reading the settings as
 * they stand and writing them back under both conditions. It is an interface of
 * its own so there is exactly one implementation of the version/lock/conflict
 * rule — a shared-secret push writes `settings.secrets`, which is the same
 * conditional write on the same item, and two implementations of it would be
 * two answers to "who won".
 */
export interface SettingsStore {
  backend: Backend;
  guardFleet: () => Promise<{ config: LocalConfig; fleet: FleetItem; stack: StackInfo }>;
  /**
   * Throws `LOCKED` while somebody holds the fleet-wide lock (§4.4). `owner`
   * is the caller's own lock, if it has one: pass it and the caller's own lock
   * is not what refuses it, which is what §8.3's profile writes need to hold
   * the lock across their own settings write.
   */
  assertFleetUnlocked: (name?: string, owner?: string) => Promise<void>;
  appendEvent: (name: string, action: string, detail?: string) => Promise<void>;
}

/** The settings surface needs nothing beyond the shared context, which is itself a `SettingsStore`. */
export interface SettingsDeps {
  ctx: CoreContext;
}

/** The settings as they stand, and whether they were read or synthesized. */
export interface SettingsSnapshot {
  fleet: FleetItem;
  settings: FleetSettings;
  persisted: boolean;
}

/**
 * The settings as they stand. A fleet with none is not a fleet without
 * settings: it is a fleet whose settings are the ones `defaultFleetSettings`
 * synthesizes, attributed to whoever created it, at the time they created it —
 * these are the settings that fleet has always had, not a write somebody is
 * making now.
 */
export async function readSettings(deps: SettingsStore): Promise<SettingsSnapshot> {
  const { fleet } = await deps.guardFleet();
  return settingsOf(fleet);
}

/**
 * The same answer for a `_fleet` item somebody already read.
 *
 * `agents.create` is the caller that matters: it has guarded the fleet and is
 * holding the item, and a second `guardFleet` there would be a second DynamoDB
 * read of the row it is looking at — while still having to agree, exactly, with
 * what `settings.get` would have said.
 */
export function settingsOf(fleet: FleetItem): SettingsSnapshot {
  /**
   * §8.3's provider profiles are normalised here rather than by a foundation
   * migration, for the reason `profile-migrate.ts` spells out: the derivation
   * is pure and stable, so every reader of an unmigrated `_fleet` sees the same
   * profiles with the same ids, and the migrated record is persisted by
   * whichever settings write happens next rather than by a write of its own.
   */
  if (fleet.settings) {
    return {
      fleet,
      settings: withProviderProfiles(fleet.settings, fleet.fleet_id),
      persisted: true,
    };
  }
  return {
    fleet,
    settings: withProviderProfiles(
      defaultFleetSettings(fleet.defaults, fleet.created_by, fleet.created_at),
      fleet.fleet_id,
    ),
    persisted: false,
  };
}

/** The version a conditional write must be composed against; `null` means "none yet". */
export function expectedVersionOf(settings: FleetSettings, persisted: boolean): number | null {
  return persisted ? settings.version : null;
}

/**
 * The write. `false` from the store is one of two facts, and which one matters
 * to the operator: somebody else's settings write landed first (`CONFLICT`,
 * re-read and retry), or a `foundation update` is holding the fleet lock
 * (`LOCKED`, wait for it). Re-reading to tell them apart is one extra call on
 * the failure path only.
 *
 * The event is appended by the same call, because a settings write that is not
 * in `_fleet`'s history is a fleet-wide change nobody can account for later.
 * Field names and new values only: nothing that reaches here is a secret — a
 * provider entry names a slot and a secret entry is a slug (§8.3) — and the run
 * log is read back by every head.
 *
 * `owner` is passed by a caller that is holding the fleet lock across this
 * write and the one after it (§8.3). It buys exactly one thing: its own lock
 * does not refuse it. A lock that expired under it and was taken by somebody
 * else is a different owner, so both the guard and the store's condition still
 * refuse — which is the guarantee that makes running without a heartbeat safe.
 */
export async function commitSettings(
  deps: SettingsStore,
  next: FleetSettings,
  expectedVersion: number | null,
  action: string,
  detail: string,
  owner?: string,
): Promise<SettingsResult> {
  // Refuse a locked fleet before writing, so the ordinary case reports the
  // update in progress rather than a condition failure.
  await deps.assertFleetUnlocked(undefined, owner);
  const ok = await deps.backend.store.fleet.putSettings(
    next,
    expectedVersion,
    deps.backend.clock.now(),
    owner,
  );
  if (!ok) {
    await deps.assertFleetUnlocked(undefined, owner);
    const latest = await deps.backend.store.fleet.get();
    throw new HermeticError(
      "CONFLICT",
      `fleet settings changed under you (now version ${latest?.settings?.version ?? "(none)"}); re-read and retry`,
      { expected: expectedVersion, actual: latest?.settings?.version ?? null },
    );
  }
  await deps.appendEvent(FLEET_KEY, action, detail);
  return { settings: next, persisted: true, catalog: PROVIDERS };
}

/**
 * What every method here answers with: the settings, whether they are on the
 * item yet, and the static provider catalog.
 *
 * The catalog rides along rather than being its own method because it is a
 * constant of the build — auth mode, env var, base URL, the model id a provider
 * falls back to — and there is nothing to poll. A head renders "default model"
 * as the override if there is one and the catalog's otherwise, which it can
 * only do if it has both.
 */
export interface SettingsResult {
  settings: FleetSettings;
  /** False when `_fleet` carries no `settings`; `settings` is then synthesized. */
  persisted: boolean;
  catalog: typeof PROVIDERS;
}

/**
 * A stated `agent_defaults` merged onto the fleet's, key by key.
 *
 * Merge rather than replace because the request is a patch everywhere else:
 * `hermetic settings set --approvals off` states the one key the operator
 * named, and a whole-object write would silently drop a `model` somebody set
 * last week. A key stated as `null` is the spelling for "clear this one key";
 * any other value replaces it; a key the request never mentions is untouched.
 *
 * An *explicit* `undefined` means "leave alone" too, deliberately. JSON drops
 * `undefined`, so the portal could not state it over HTTP even if it wanted
 * to, and a meaning one head cannot spell is not a meaning core may honour.
 * Clearing is always `null`.
 *
 * Cleared means *absent*, not present-and-empty: an empty object would be read
 * back as "the fleet states these settings" by `splitHermesSettings`, so a
 * merge that ends with no keys left answers `undefined`.
 */
function mergeAgentDefaults(
  current: HermesSettings | undefined,
  stated: NonNullable<NonNullable<SettingsSetInput["agent_defaults"]>>,
): HermesSettings | undefined {
  const merged: HermesSettings = { ...current };
  /** Typed per-key assignment, so the merge needs no cast on the value. */
  const put = <K extends keyof HermesSettings>(key: K, value: HermesSettings[K]): void => {
    merged[key] = value;
  };
  for (const key of Object.keys(stated) as (keyof HermesSettings)[]) {
    const value = stated[key];
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else put(key, value);
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

export interface SettingsApi {
  settingsGet: (input?: SettingsGetInput) => Promise<SettingsResult>;
  settingsSet: (input: SettingsSetInput) => Promise<SettingsResult>;
}

export function createSettings(deps: SettingsDeps): SettingsApi {
  const read = () => readSettings(deps.ctx);
  const expectedOf = expectedVersionOf;

  /**
   * The operator's own claim about which version they read, checked before
   * anything is composed. It is not the same guarantee the store's condition
   * gives — that one is atomic — but it is the one that produces a *useful*
   * message, naming both numbers, and it is what makes a form that was open in
   * a browser for ten minutes fail instead of overwriting.
   */
  function checkExpected(
    input: { expected_version?: number | null | undefined },
    settings: FleetSettings,
    persisted: boolean,
  ): void {
    if (input.expected_version === undefined) return;
    const actual = expectedOf(settings, persisted);
    if (input.expected_version === actual) return;
    throw new HermeticError(
      "CONFLICT",
      `fleet settings are at version ${actual ?? "(none)"}, not ${input.expected_version ?? "(none)"}; re-read and retry`,
      { expected: input.expected_version, actual },
    );
  }

  const commit = (
    next: FleetSettings,
    expectedVersion: number | null,
    action: string,
    detail: string,
  ) => commitSettings(deps.ctx, next, expectedVersion, action, detail);

  async function settingsGet(input: SettingsGetInput = {}): Promise<SettingsResult> {
    SettingsGetInputSchema.parse(input);
    const { settings, persisted } = await read();
    return { settings, persisted, catalog: PROVIDERS };
  }

  async function settingsSet(input: SettingsSetInput): Promise<SettingsResult> {
    const parsed = SettingsSetInputSchema.parse(input);
    const { settings, persisted } = await read();
    checkExpected(parsed, settings, persisted);

    const defaults = { ...settings.defaults, ...(parsed.defaults ?? {}) };

    // Absent leaves the fleet's Hermes defaults alone, `null` clears all of
    // them, and an object merges key by key (`mergeAgentDefaults`).
    const agentDefaults =
      parsed.agent_defaults === undefined
        ? settings.agent_defaults
        : parsed.agent_defaults === null
          ? undefined
          : mergeAgentDefaults(settings.agent_defaults, parsed.agent_defaults);

    /**
     * §8.3: what a create with no `--provider-profile` resolves to is a
     * *profile*, so this is the field that names the fleet default and the
     * selector is resolved here rather than by the head — an id or a name, the
     * same vocabulary `agent create --provider-profile` takes.
     *
     * A disabled profile is refused for the reason `providers update` refuses
     * it: a default nothing may be created with is not a default.
     */
    const chosen =
      parsed.default_profile === undefined ? null : resolveProfileIn(settings, parsed.default_profile);
    if (chosen !== null && !chosen.enabled) {
      throw new HermeticError(
        "VALIDATION",
        "a disabled profile cannot be the fleet default; enable it first",
        { profile: chosen.id },
      );
    }

    const now = deps.ctx.nowIso();
    const who = await deps.ctx.actor();

    const next: FleetSettings = {
      ...settings,
      version: persisted ? settings.version + 1 : 1,
      defaults,
      ...(chosen === null ? {} : { default_profile: chosen.id }),
      updated_at: now,
      updated_by: who,
    };
    // Cleared means *absent*, not present-and-empty: an empty object would be
    // read back as "the fleet states these settings" by `splitHermesSettings`.
    if (agentDefaults === undefined) delete next.agent_defaults;
    else next.agent_defaults = agentDefaults;

    const changed = [
      ...Object.keys(parsed.defaults ?? {}).map((k) => `defaults.${k}`),
      ...(chosen === null ? [] : [`default profile ${chosen.name} (${chosen.id})`]),
      // Read off the *computed* result, not off what was stated: a per-key
      // `null` that removes the last remaining key clears them as surely as
      // `--clear-agent-defaults` does, and the run log has to say so.
      ...(parsed.agent_defaults === undefined
        ? []
        : [agentDefaults === undefined ? "agent_defaults cleared" : "agent_defaults"]),
    ];
    return commit(
      next,
      expectedOf(settings, persisted),
      "settings.set",
      `${changed.join(", ")} → v${next.version}`,
    );
  }

  return { settingsGet, settingsSet };
}
