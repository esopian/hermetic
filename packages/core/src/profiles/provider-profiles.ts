/**
 * Provider profiles (§8.3): `providers.list`, `providers.create`,
 * `providers.update`, `providers.delete`, `providers.models`.
 *
 * Its own module for the reason `settings.ts`, `secrets.ts`, `lifecycle.ts` and
 * `teardown.ts` have theirs (core rule 5): `hermetic.ts` is the file that keeps
 * running into the 2500-line cap, and this is a subject with a dependency list
 * it can be handed.
 *
 * **A profile is a name over a credential, and the credential is a slot.** The
 * record on `_fleet` carries the slug and never the key (§8.3) — the same rule
 * `ProviderSettings.secret` already followed, applied to a thing an operator
 * can have several of. Everything that reads a key here reads it from SSM and
 * drops it inside the function that read it.
 *
 * **Write order, and it is not the same in both directions.**
 *
 * A *create* publishes the credential before it commits the record that names
 * it: the slug is a new reference, and a settings write that never lands must
 * not leave a profile pointing at an empty slot. If the commit fails for any
 * reason the slot is deleted again — not blanked, because the id is minted and
 * a re-run would draw a different one, so a placeholder left behind would be a
 * slot nothing names. If even the deletion fails the error says so, naming the
 * slug, rather than claiming nothing happened.
 *
 * A *rotation* and a *delete* go the other way, and for the same underlying
 * reason: neither publishes a new reference, and both have something the fleet
 * is still using that a failed commit must not have destroyed. A rotation
 * commits and then writes the slot, so a lost race leaves the previous key in
 * place. A delete commits and then sweeps the slot, so a lost race leaves a
 * profile whose key is still there — and the sweep, being after the point of no
 * return, is best-effort and reported rather than fatal.
 *
 * **Two writes are one operation, so they are held under one lock.** Every
 * write here is a settings commit *and* an SSM write, in one order or the
 * other, and the pair is not atomic. Two operators rotating the same profile's
 * key at once could therefore interleave into a state no single run could
 * produce: both commits land, leaving revision 3 on the record, and the slot
 * ends up holding whichever key was written second — which may be the key that
 * belongs to revision 2. Nothing reports that, because both commands succeed
 * and the record is self-consistent. So `create`, `update` and `delete` take
 * the fleet lock (§4.4) for the whole of their sequence and release it in a
 * `finally`; the second operator is refused `LOCKED` and re-runs.
 *
 * The TTL is short and there is no heartbeat (`PROFILE_LOCK_TTL_MS`), because
 * these are two writes with nothing slow between them. If one somehow outlasts
 * the TTL and another operator takes the lock, each of the two writes refuses
 * on its own terms rather than overwriting. The settings write is refused by
 * the store's condition — the re-entry the owner buys is for *our* lock, not
 * for whatever lock happens to be there. The SSM write has no such condition,
 * so a rotation fences it by re-acquiring the lock immediately before and
 * immediately after the `put`, and a lock lost at either point is a `CONFLICT`
 * naming the slot (`updateLocked`). A create needs no fence: its slot write
 * comes first and lands on a slug nothing else names yet, and the commit that
 * follows is itself the conditional write, with the undo putting the slot back
 * when it is refused.
 *
 * **Model discovery writes nothing.** `providers.models` is a read of somebody
 * else's service (`model-catalog.ts`). It cannot move a profile's model, and
 * nothing it returns is cached anywhere — the persisted answer is
 * `ProviderProfile.model`, resolved once at create and owned by the fleet from
 * then on.
 */
import {
  FLEET_KEY,
  PROVIDERS,
  ProvidersCreateInput as ProvidersCreateInputSchema,
  ProvidersDeleteInput as ProvidersDeleteInputSchema,
  ProvidersListInput as ProvidersListInputSchema,
  ProvidersModelsInput as ProvidersModelsInputSchema,
  ProvidersUpdateInput as ProvidersUpdateInputSchema,
  profileSlotSlug,
} from "../schema/index.ts";
import type {
  Agent,
  CatalogModel,
  FleetItem,
  FleetSettings,
  Provider,
  ProviderProfile,
  ProvidersCreateInput,
  ProvidersDeleteInput,
  ProvidersListInput,
  ProvidersModelsInput,
  ProvidersModelsOutput,
  ProvidersUpdateInput,
  SharedSecretMeta,
} from "../schema/index.ts";
import { randomUUID } from "node:crypto";
import { HermeticError } from "../errors.ts";
import { sharedSecretPath } from "../backend/constants.ts";
import { PROFILE_LOCK_TTL_MS, createFleetLock, lockActivity, lockOwner } from "../fleet/fleet-lock.ts";
import type { FleetLock } from "../fleet/fleet-lock.ts";
import { commitSettings, expectedVersionOf, readSettings, settingsOf } from "./settings.ts";
import type { SettingsSnapshot } from "./settings.ts";
import type { CoreContext } from "../context.ts";
import { resolveProfileIn } from "./profile-migrate.ts";
import { mintProfileId } from "../fleet/fleet-id.ts";
import { listModels } from "./model-catalog.ts";
import type { ModelCatalogDeps } from "./model-catalog.ts";

/* ── what a head is told about a profile ───────────────────────────────────── */

/**
 * Why a profile is or is not usable. Core states it; the head renders it (rule
 * 1). "Stored" is never "verified": a key that is present may still be wrong,
 * and §8.3 refuses to guess by making an inference call.
 */
export type ReadyReason =
  | "role"
  | "key-set"
  | "disabled"
  | "key-missing"
  | "key-placeholder"
  | "grant-missing";

/** Whether the fleet's instance role may actually invoke a Bedrock profile's model. */
export type BedrockGrant = "granted" | "needs_foundation_update";

export interface ProfileView extends ProviderProfile {
  ready: boolean;
  ready_reason: ReadyReason;
  /**
   * Agents whose running configuration came from this profile — by `profile_id`
   * where the row carries one, and by the fleet's designation of their provider
   * where it does not (§8.3). It is what `providers.delete` refuses on.
   */
  linked_agents: string[];
  /**
   * Agents *staged* onto this profile and not yet applied (§8.3) — the rows
   * whose `pending.profile_id` names it.
   *
   * Separate from `linked_agents` because it is a different fact: these agents
   * are still running on whatever they were bound to before, so calling them
   * linked would misreport what the profile is serving. `providers.delete`
   * refuses on both sets, though, because a profile deleted out from under a
   * staged binding turns the operator's next `apply` into a `NOT_FOUND` on a
   * profile they can no longer inspect.
   */
  pending_agents: string[];
  is_default: boolean;
  /** Bedrock only: whether this profile's model is in the fleet's grant. */
  grant?: BedrockGrant;
}

export interface ProvidersListResult {
  profiles: ProfileView[];
  default_profile: string | null;
  /** The static catalog, for the same reason `settings.get` carries it. */
  catalog: typeof PROVIDERS;
  /** The Bedrock model ids this fleet's role may invoke, as `_fleet` records them. */
  bedrock_model_ids: string[];
}

export interface ProvidersWriteResult {
  profile: ProfileView;
  settings: FleetSettings;
  persisted: boolean;
}

export interface ProvidersDeleteResult {
  id: string;
  name: string;
  deleted: true;
  settings: FleetSettings;
  /**
   * The slug of the credential slot this profile owned, when the sweep that
   * follows the settings write could not remove it (§8.3).
   *
   * The delete itself succeeded — the profile is gone from `_fleet` — so this
   * is not a failure, it is a leftover: a fleet secret nothing names any more.
   * Core states it; the head prints it, and `hermetic secrets rm <slug>` is
   * what removes it.
   */
  slot_not_deleted?: string;
}

/* ── dependencies ──────────────────────────────────────────────────────────── */

/** What §8.3's profiles need beyond the shared context: the catalog transport and a stable id for tests. */
export interface ProviderProfilesDeps {
  ctx: CoreContext;
  /** `model-catalog.ts`'s transport: injectable so no test and no fixture opens a socket. */
  catalog: ModelCatalogDeps;
  /** Overridable only so a test can assert on a stable id. */
  mintId?: () => string;
}

export interface ProviderProfilesApi {
  providersList: (input?: ProvidersListInput) => Promise<ProvidersListResult>;
  providersCreate: (input: ProvidersCreateInput) => Promise<ProvidersWriteResult>;
  providersUpdate: (input: ProvidersUpdateInput) => Promise<ProvidersWriteResult>;
  providersDelete: (input: ProvidersDeleteInput) => Promise<ProvidersDeleteResult>;
  providersModels: (input: ProvidersModelsInput) => Promise<ProvidersModelsOutput>;
}

/* ── pure helpers, exported for the readers that need them ─────────────────── */

export function profilesOf(settings: FleetSettings): ProviderProfile[] {
  const byId: Record<string, ProviderProfile> = settings.profiles ?? {};
  return Object.values(byId).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The profile a request means, re-exported under the name every caller here
 * uses. The rule itself lives in `profile-migrate.ts` because `settings.ts`
 * resolves `--default-profile` with it and cannot import this module.
 */
export { resolveProfileIn as resolveProfile };

/**
 * Which profile an agent on this provider belongs to when its row names none:
 * the fleet default if that is this provider, else the one profile of this
 * provider if there is exactly one, else nothing.
 *
 * The same rule `agents.create` resolves a bare `--provider` with, which is why
 * it is here rather than inside the list: "which profile is this agent on" and
 * "which profile would a create pick" must not be two answers. Where a create
 * would refuse as ambiguous, an existing row still runs on *something*;
 * `rowProfile` answers that case.
 */
export function designatedProfile(settings: FleetSettings, provider: Provider): ProviderProfile | null {
  const defaultId = settings.default_profile;
  const fleetDefault =
    defaultId === null || defaultId === undefined ? undefined : settings.profiles?.[defaultId];
  if (fleetDefault?.provider === provider) return fleetDefault;
  const ofProvider = profilesOf(settings).filter((p) => p.provider === provider);
  return ofProvider.length === 1 ? ofProvider[0]! : null;
}

/**
 * The profile a row that names none is running on (§8.3's `linked_agents`).
 *
 * The fleet's designation first, exactly as a create would resolve it. Where
 * that is ambiguous — a second profile of the provider exists and the fleet
 * default is on another — the answer is the earliest-created profile of the
 * provider, not nothing. A row without `profile_id` predates profiles, so it
 * runs on what the migration made of that provider, which is the oldest; and
 * creating a sibling profile must not silently unlink every such agent (which
 * would also let the profile they run on be deleted out from under them).
 */
export function rowProfile(settings: FleetSettings, provider: Provider): ProviderProfile | null {
  const designated = designatedProfile(settings, provider);
  if (designated !== null) return designated;
  const ofProvider = profilesOf(settings)
    .filter((p) => p.provider === provider)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return ofProvider[0] ?? null;
}

/**
 * Bedrock spells one model two ways — the bare foundation model
 * (`zai.glm-4.7-flash`) and the cross-region inference profile
 * (`us.zai.glm-4.7-flash`) — and `bedrockModelArns` grants both forms of every
 * id the foundation was given. So a grant check compares the bare form, or a
 * profile whose only difference is the region prefix would read as ungranted.
 */
export function bedrockBaseModelId(id: string): string {
  return id.replace(/^(us|eu|apac|us-gov|global)\./, "");
}

export function bedrockGrantOf(model: string, granted: readonly string[]): BedrockGrant {
  const base = bedrockBaseModelId(model);
  return granted.some((g) => bedrockBaseModelId(g) === base) ? "granted" : "needs_foundation_update";
}

/**
 * The Bedrock grant a fleet that has never recorded one actually holds.
 *
 * Deliberately *not* `DEFAULT_BEDROCK_MODEL_IDS`, and the difference is the
 * whole point. That constant is what **this build** would pass as
 * `BedrockModelArns` on a fresh `init`, and it has since gained
 * `zai.glm-4.7-flash`. Every fleet created before that still has a stack whose
 * `BedrockModelArns` parameter is the older list, so reading the current
 * constant as "what this fleet was built with" would report GLM as `granted` on
 * a role that cannot invoke it — and the first Bedrock agent created on it
 * would come up healthy and refuse the first message, which is the exact
 * failure the grant check exists to prevent.
 *
 * So the fallback is the list as it stood before GLM was added: what a pre-v10
 * stack really holds. `foundation.update` at contract version 10 reconciles the
 * grant for real and records the result on `_fleet.bedrock_model_ids`, after
 * which this list is never consulted again for that fleet. Until then a GLM
 * profile honestly reports `needs_foundation_update`.
 *
 * It is a frozen copy rather than a slice of the live constant because it
 * describes history: it must not move when this build's defaults do.
 */
export const LEGACY_BEDROCK_MODEL_IDS: readonly string[] = [
  "anthropic.claude-sonnet-4-5-20250929-v1:0",
  "anthropic.claude-haiku-4-5-20251001-v1:0",
  "anthropic.claude-opus-4-1-20250805-v1:0",
] as const;

/**
 * The ids `_fleet` records, else the ones a fleet that predates the record was
 * actually built with (§8.3).
 */
export function grantedBedrockModels(fleet: FleetItem): string[] {
  return fleet.bedrock_model_ids ?? [...LEGACY_BEDROCK_MODEL_IDS];
}

/**
 * The profile that *owns* a slug, if any — meaning the slot `providers create`
 * made for it and `providers rm` will delete with it (`profile-<id>`).
 *
 * Deliberately narrower than "some profile names this slug". A profile migrated
 * off the old `settings.providers[p].secret` points at a shared slot that
 * predates profiles, that an operator pushed by hand and that other things may
 * still read; `secrets rm` refuses that one on the `used_by` fan-out it always
 * did, which is a different sentence and the right one. Deleting a profile must
 * never take a slot it did not create.
 */
export function profileOwningSlug(
  settings: FleetSettings,
  slug: string,
): { profile: string; name: string } | null {
  for (const p of profilesOf(settings)) {
    if (
      p.credential.kind === "secret" &&
      p.credential.slug === slug &&
      slug === profileSlotSlug(p.id)
    ) {
      return { profile: p.id, name: p.name };
    }
  }
  return null;
}

/**
 * What a profile write is handed once the fleet lock is its: who it holds the
 * lock as, the lock itself, and the settings read on the way in.
 *
 * The lock is in here because a write that spans two stores has to be able to
 * ask whether it still holds it — `updateLocked` fences its SSM write on both
 * sides — and the settings are in here so the body does not read `_fleet` a
 * second time (`withProfileLock`).
 */
interface Held extends SettingsSnapshot {
  owner: string;
  lock: FleetLock;
}

/* ── the surface ───────────────────────────────────────────────────────────── */

export function createProviderProfiles(deps: ProviderProfilesDeps): ProviderProfilesApi {
  const { backend } = deps.ctx;
  const mintId = deps.mintId ?? mintProfileId;

  /** The same check `settings.ts` makes, for the same reason: a stale form must fail. */
  function checkExpected(
    input: { expected_version?: number | null | undefined },
    settings: FleetSettings,
    persisted: boolean,
  ): void {
    if (input.expected_version === undefined) return;
    const actual = expectedVersionOf(settings, persisted);
    if (input.expected_version === actual) return;
    throw new HermeticError(
      "CONFLICT",
      `fleet settings are at version ${actual ?? "(none)"}, not ${input.expected_version ?? "(none)"}; re-read and retry`,
      { expected: input.expected_version, actual },
    );
  }

  /** Whether the slot behind a profile holds a real value. No value leaves this function. */
  async function readiness(profile: ProviderProfile): Promise<{ ready: boolean; reason: ReadyReason }> {
    if (!profile.enabled) return { ready: false, reason: "disabled" };
    if (profile.credential.kind === "role") return { ready: true, reason: "role" };
    const path = sharedSecretPath(deps.ctx.fleetId(), profile.credential.slug);
    if (!(await backend.secrets.exists(path))) return { ready: false, reason: "key-missing" };
    if (await backend.secrets.isPlaceholder(path)) return { ready: false, reason: "key-placeholder" };
    return { ready: true, reason: "key-set" };
  }

  function linkedAgents(settings: FleetSettings, agents: Agent[], profile: ProviderProfile): string[] {
    return agents
      .filter((a) => {
        if (a.status === "destroyed") return false;
        if (a.profile_id !== undefined) return a.profile_id === profile.id;
        if (a.provider !== profile.provider) return false;
        return rowProfile(settings, a.provider)?.id === profile.id;
      })
      .map((a) => a.name)
      .sort();
  }

  /**
   * Agents staged onto this profile by `agents.set` and not yet applied (§8.3).
   *
   * Asked separately from `linkedAgents` and answered from `pending.profile_id`
   * alone: a staged row is still *running* its previous binding, so it is not
   * linked — but the profile is very much in use by it, and a `providers rm`
   * that ignored the staging would leave the operator holding a `pending` whose
   * apply can only fail, naming a profile that no longer exists to be inspected
   * or re-staged from.
   */
  function pendingAgents(agents: Agent[], profile: ProviderProfile): string[] {
    return agents
      .filter((a) => a.status !== "destroyed" && a.pending?.profile_id === profile.id)
      .map((a) => a.name)
      .sort();
  }

  async function viewOf(
    settings: FleetSettings,
    fleet: FleetItem,
    agents: Agent[],
    profile: ProviderProfile,
  ): Promise<ProfileView> {
    const { ready, reason } = await readiness(profile);
    const grant =
      profile.provider === "bedrock"
        ? bedrockGrantOf(profile.model, grantedBedrockModels(fleet))
        : undefined;
    return {
      ...profile,
      // A Bedrock model the role may not invoke is not a profile an agent can
      // be created on, so it is not `ready` either — the same posture an empty
      // key slot gets, with its own reason so the head can name the fix.
      ready: ready && grant !== "needs_foundation_update",
      ready_reason: grant === "needs_foundation_update" && ready ? "grant-missing" : reason,
      linked_agents: linkedAgents(settings, agents, profile),
      pending_agents: pendingAgents(agents, profile),
      is_default: settings.default_profile === profile.id,
      ...(grant === undefined ? {} : { grant }),
    };
  }

  async function providersList(input: ProvidersListInput = {}): Promise<ProvidersListResult> {
    ProvidersListInputSchema.parse(input);
    const { fleet, settings } = await readSettings(deps.ctx);
    const agents = (await deps.ctx.scanAgents()).agents;
    const profiles: ProfileView[] = [];
    for (const profile of profilesOf(settings)) {
      profiles.push(await viewOf(settings, fleet, agents, profile));
    }
    return {
      profiles,
      default_profile: settings.default_profile ?? null,
      catalog: PROVIDERS,
      bedrock_model_ids: grantedBedrockModels(fleet),
    };
  }

  /** Refuse a name another profile already answers to, ignoring case (§8.3). */
  function assertNameFree(settings: FleetSettings, name: string, exceptId?: string): void {
    const clash = profilesOf(settings).find(
      (p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash !== undefined) {
      throw new HermeticError(
        "NAME_TAKEN",
        `this fleet already has a profile called ${clash.name} (${clash.id})`,
        { name, profile: clash.id },
      );
    }
  }

  /**
   * Put a *new* profile's key in the slot it will own, and hand back the undo.
   *
   * Only a create reaches here. The reference — the slug on the record — does
   * not exist yet, so the value goes first: a settings write that never lands
   * must not leave a profile pointing at an empty slot. A rotation does the
   * opposite and for the opposite reason; see `providersUpdate`.
   *
   * The undo *deletes* the slot rather than blanking it. The id is minted, so a
   * re-run of the same command mints a different one and would never come back
   * to this slug — a placeholder left behind would be a slot no profile names,
   * which `secrets ls` reports as an orphan and somebody has to clean up by
   * hand. The caller guarantees the slot held nothing before this ran, so
   * deleting it restores exactly the state it found.
   */
  async function writeNewKey(slug: string, value: string): Promise<() => Promise<void>> {
    const path = sharedSecretPath(deps.ctx.fleetId(), slug);
    await backend.secrets.ensureSlot(path);
    await backend.secrets.put(path, value);
    return async () => {
      await backend.secrets.delete(path);
    };
  }

  /**
   * Commit, and put the credential write back if the commit did not land.
   *
   * **Any** failure, not only a lost race. `CONFLICT` is the one that was
   * thought about first, but `LOCKED`, a throttled DynamoDB write and a dropped
   * connection all mean the same thing here — the record naming this slot was
   * never stored — and a key sitting in a slot nothing names is exactly what
   * the undo exists to prevent, whichever of them happened.
   *
   * The original failure is what the caller sees, because that is the one that
   * says what to do next. A failed *undo* replaces it only because it adds
   * something the operator cannot otherwise know: a value was left behind.
   */
  /**
   * Hold the fleet lock across one whole profile write, and give it back
   * whatever happens.
   *
   * Deliberately not named `withFleetLock`: `artifacts.ts` exports one of those
   * and it is a different shape — it takes a `FleetItem` and hands the locked
   * copy to the body, because its callers go on to rewrite the whole item. This
   * one hands the body a `Held`: the owner string, the lock itself (a rotation
   * fences its SSM write by re-acquiring, see `updateLocked`), and the settings
   * as `guardFleet` found them.
   *
   * The settings ride along because otherwise every body opened with
   * `readSettings(deps.ctx)`, which calls `guardFleet` again — a second
   * `DescribeStacks` and a second `_fleet` read of the row this function has
   * just read, inside the lock. One read per operation instead. It is the item
   * from *before* the lock was taken, which costs nothing: every write below is
   * conditional on the settings version it was composed against, so a write
   * that landed in the gap is refused as a `CONFLICT` and re-run rather than
   * overwritten.
   *
   * `guardFleet` first, so an operator pointed at the wrong account or the
   * wrong fleet is told that rather than being allowed to lock somebody's
   * `_fleet` and then be refused. No heartbeat, and no `renew`: see this
   * module's note and `PROFILE_LOCK_TTL_MS`.
   */
  async function withProfileLock<T>(
    operation: string,
    rerun: string,
    body: (held: Held) => Promise<T>,
  ): Promise<T> {
    const { fleet } = await deps.ctx.guardFleet();
    const owner = lockOwner(await deps.ctx.actor(), randomUUID(), operation);
    const lock = createFleetLock({
      backend,
      lockTtlMs: PROFILE_LOCK_TTL_MS,
      now: () => backend.clock.now(),
      rerun,
    });
    if (!(await lock.acquire(owner))) {
      const held = (await backend.store.fleet.get())?.lock;
      throw new HermeticError(
        "LOCKED",
        held == null
          ? `the ${FLEET_KEY} lock is held by another operator; run \`${rerun}\` again when they are done`
          : `${lockActivity(held.owner)} (${FLEET_KEY} locked by ${held.owner} until ${held.expires}); run \`${rerun}\` again when it finishes`,
        { owner: held?.owner ?? null, expires: held?.expires ?? null, scope: "fleet" },
      );
    }
    try {
      return await body({ owner, lock, ...settingsOf(fleet) });
    } finally {
      /**
       * A release that fails is not a failure of the operation. `unlockFleet`
       * rethrows anything but a lost race, so a throttled DynamoDB call here
       * would replace the result of writes that already landed with an error,
       * and the operator would re-run a rotation that had already happened.
       * The TTL is what covers a release that never lands (§4.4): thirty
       * seconds later the lock is nobody's.
       */
      try {
        await lock.unlock(owner);
      } catch {
        // Swallowed on purpose; see above. Core never logs (rule 1).
      }
    }
  }

  async function commitWithUndo(
    next: FleetSettings,
    expectedVersion: number | null,
    action: string,
    detail: string,
    undo: (() => Promise<void>) | null,
    slug: string | null,
    owner: string,
  ): Promise<void> {
    try {
      await commitSettings(deps.ctx, next, expectedVersion, action, detail, owner);
    } catch (e) {
      if (undo !== null) {
        try {
          await undo();
        } catch {
          const base =
            e instanceof HermeticError ? e : new HermeticError("INTERNAL", "the settings write failed");
          throw new HermeticError(
            base.code,
            `${base.message} — and the credential slot ${slug ?? "(none)"} could not be removed; it holds a key nothing names, so delete it with \`hermetic secrets rm ${slug ?? ""}\` before retrying`,
            { ...(base.details ?? {}), partial_write: slug },
          );
        }
      }
      throw e;
    }
  }

  async function providersCreate(input: ProvidersCreateInput): Promise<ProvidersWriteResult> {
    const parsed = ProvidersCreateInputSchema.parse(input);
    return withProfileLock("providers.create", "hermetic providers create", (held) =>
      createLocked(parsed, held),
    );
  }

  /**
   * The create itself, with the fleet lock already held. Split out so the lock
   * is taken once, at the top, and the body below reads as the sequence it is —
   * there is no path through it that returns without the `finally` running.
   *
   * No `assertFleetUnlocked` at the entry: taking the lock *is* that check, and
   * asking twice would be a second read that can only give the same answer.
   */
  async function createLocked(
    parsed: ProvidersCreateInput,
    { owner, fleet, settings, persisted }: Held,
  ): Promise<ProvidersWriteResult> {
    checkExpected(parsed, settings, persisted);
    assertNameFree(settings, parsed.name);

    const spec = PROVIDERS[parsed.provider];
    if (spec.auth === "role" && parsed.api_key !== undefined) {
      throw new HermeticError(
        "VALIDATION",
        `${spec.label} authenticates as the instance role; there is no key to store`,
        { provider: parsed.provider },
      );
    }

    /**
     * A minted id is redrawn rather than allowed to collide, and "collide"
     * means two things: a profile this fleet already holds, and a *slot* left
     * over from one it used to hold. The second matters because the undo below
     * deletes the slot it created — it may only do that if the slot held
     * nothing when this create found it.
     */
    const taken = async (candidate: string): Promise<boolean> => {
      if (settings.profiles?.[candidate] !== undefined) return true;
      if (spec.auth === "role") return false;
      return await backend.secrets.exists(
        sharedSecretPath(deps.ctx.fleetId(), profileSlotSlug(candidate)),
      );
    };
    let id = mintId();
    for (let i = 0; i < 8 && (await taken(id)); i++) id = mintId();
    if (await taken(id)) {
      throw new HermeticError("INTERNAL", "could not mint a free profile id");
    }

    const now = deps.ctx.nowIso();
    const who = await deps.ctx.actor();
    const slug = spec.auth === "role" ? null : profileSlotSlug(id);
    const profile: ProviderProfile = {
      id,
      name: parsed.name,
      provider: parsed.provider,
      // Resolved once, here, and owned by the fleet from now on: a catalog
      // default that rotates in a later release must not move this profile.
      model: parsed.model ?? spec.default_model,
      enabled: parsed.enabled ?? true,
      revision: 1,
      credential: slug === null ? { kind: "role" } : { kind: "secret", slug },
      created_at: now,
      created_by: who,
      updated_at: now,
      updated_by: who,
    };
    if (parsed.default === true && profile.enabled === false) {
      throw new HermeticError(
        "VALIDATION",
        "a disabled profile cannot be the fleet default; create it enabled first",
        { profile: id },
      );
    }

    /**
     * The credential before the record that names it; see this module's note.
     *
     * Unfenced, unlike a rotation's slot write, and for two reasons that both
     * have to hold. It writes a slug minted moments ago that no other operator
     * has a reason to write, so there is no key of theirs to overwrite; and it
     * happens *before* the commit, so if the lock has been lost the commit is
     * refused by its own condition and `commitWithUndo` deletes the slot again.
     * A re-acquire check after this `put` would only be able to throw, which
     * would skip that undo and leave behind exactly the orphan slot the undo
     * exists to prevent.
     */
    const undo =
      parsed.api_key !== undefined && slug !== null ? await writeNewKey(slug, parsed.api_key) : null;

    const secrets: SharedSecretMeta[] =
      undo === null || slug === null
        ? settings.secrets
        : [
            ...settings.secrets.filter((s) => s.slug !== slug),
            { slug, label: parsed.name, created_at: now, last_set_at: now },
          ].sort((a, b) => a.slug.localeCompare(b.slug));

    const next: FleetSettings = {
      ...settings,
      version: persisted ? settings.version + 1 : 1,
      profiles: { ...(settings.profiles ?? {}), [id]: profile },
      ...(parsed.default === true ? { default_profile: id } : {}),
      secrets,
      updated_at: now,
      updated_by: who,
    };
    // The slug, the name and the provider — never the key (§8.3).
    await commitWithUndo(
      next,
      expectedVersionOf(settings, persisted),
      "providers.create",
      `profile ${parsed.name} (${id}) on ${parsed.provider}, model ${profile.model} → v${next.version}`,
      undo,
      slug,
      owner,
    );
    const agents = (await deps.ctx.scanAgents()).agents;
    return {
      profile: await viewOf(next, fleet, agents, profile),
      settings: next,
      persisted: true,
    };
  }

  async function providersUpdate(input: ProvidersUpdateInput): Promise<ProvidersWriteResult> {
    const parsed = ProvidersUpdateInputSchema.parse(input);
    return withProfileLock("providers.update", "hermetic providers update", (held) =>
      updateLocked(parsed, held),
    );
  }

  /** The rotation itself, with the fleet lock already held; see `createLocked`. */
  async function updateLocked(
    parsed: ProvidersUpdateInput,
    { owner, lock, fleet, settings, persisted }: Held,
  ): Promise<ProvidersWriteResult> {
    checkExpected(parsed, settings, persisted);
    const current = resolveProfileIn(settings, parsed.profile);

    if (parsed.name !== undefined) assertNameFree(settings, parsed.name, current.id);
    if (parsed.api_key !== undefined && current.credential.kind === "role") {
      throw new HermeticError(
        "VALIDATION",
        `${PROVIDERS[current.provider].label} authenticates as the instance role; there is no key to rotate`,
        { profile: current.id, provider: current.provider },
      );
    }
    /**
     * A rotation may only write a slot this profile *owns*, which is the same
     * rule the delete follows and for the same reason. A profile the migration
     * produced points at a shared slug that predates profiles — one an operator
     * pushed by hand, that other providers' settings entries may still name and
     * that `agents.create` copies from — so rotating "this profile's key" here
     * would silently re-key everything else reading that slot. The fleet-level
     * command is the honest way to say that, and it is what the message names.
     */
    if (
      parsed.api_key !== undefined &&
      current.credential.kind === "secret" &&
      current.credential.slug !== profileSlotSlug(current.id)
    ) {
      throw new HermeticError(
        "VALIDATION",
        `${current.name} reads the shared slot ${current.credential.slug}, which it does not own; rotate it with \`hermetic secrets push _fleet --shared ${current.credential.slug}\`, which says who else it reaches`,
        { profile: current.id, slug: current.credential.slug },
      );
    }
    // The same refusal `settings set --provider` makes, for the same reason: a
    // default nothing may be created with is not a default.
    if (parsed.enabled === false && settings.default_profile === current.id) {
      throw new HermeticError(
        "VALIDATION",
        "the fleet default profile must stay enabled; make another profile the default first",
        { profile: current.id },
      );
    }
    const willBeEnabled = parsed.enabled ?? current.enabled;
    if (parsed.default === true && !willBeEnabled) {
      throw new HermeticError(
        "VALIDATION",
        "a disabled profile cannot be the fleet default; enable it in the same command or first",
        { profile: current.id },
      );
    }

    const now = deps.ctx.nowIso();
    const who = await deps.ctx.actor();
    /**
     * Whether anything *on the profile* moves. `--default` alone does not: the
     * fleet default is `settings.default_profile`, a pointer the fleet holds,
     * and bumping the revision for it would mark every agent pinned to this
     * profile `update_available` for a change that reaches none of them.
     */
    const touchesProfile =
      parsed.name !== undefined ||
      parsed.model !== undefined ||
      parsed.enabled !== undefined ||
      parsed.api_key !== undefined;
    const profile: ProviderProfile = touchesProfile
      ? {
          ...current,
          ...(parsed.name === undefined ? {} : { name: parsed.name }),
          // Persisted exactly as given: a model is never re-derived from a catalog
          // read, so refreshing a catalog cannot move it (§8.3).
          ...(parsed.model === undefined ? {} : { model: parsed.model }),
          ...(parsed.enabled === undefined ? {} : { enabled: parsed.enabled }),
          // Every change bumps it, the key rotation included: an agent pinned to
          // revision N is stale the moment anything about the profile moves.
          revision: current.revision + 1,
          updated_at: now,
          updated_by: who,
        }
      : current;

    /**
     * The slot this rotation writes, if any. The check above has already proved
     * the profile owns it, so it is always `profile-<id>`.
     */
    const rotating = parsed.api_key !== undefined && current.credential.kind === "secret";
    const slug = rotating ? profileSlotSlug(current.id) : null;

    const secrets: SharedSecretMeta[] =
      slug === null
        ? settings.secrets
        : [
            ...settings.secrets.filter((s) => s.slug !== slug),
            {
              slug,
              label: profile.name,
              created_at: settings.secrets.find((s) => s.slug === slug)?.created_at ?? now,
              last_set_at: now,
            },
          ].sort((a, b) => a.slug.localeCompare(b.slug));

    const next: FleetSettings = {
      ...settings,
      version: persisted ? settings.version + 1 : 1,
      profiles: { ...(settings.profiles ?? {}), [profile.id]: profile },
      ...(parsed.default === true ? { default_profile: profile.id } : {}),
      secrets,
      updated_at: now,
      updated_by: who,
    };

    const changed = [
      ...(parsed.name === undefined ? [] : [`name ${parsed.name}`]),
      ...(parsed.model === undefined ? [] : [`model ${parsed.model}`]),
      ...(parsed.enabled === undefined ? [] : [parsed.enabled ? "enabled" : "disabled"]),
      // That a key was rotated, never the key and never its digest.
      ...(parsed.api_key === undefined ? [] : ["key rotated"]),
      ...(parsed.default === true ? ["fleet default"] : []),
    ];
    /**
     * The record first, the key second — the opposite of a create, and the
     * reason is that a rotation publishes no new *reference*. The slug on the
     * record does not move, so there is nothing for a settings write to land
     * pointing at; what there is instead is a key the running configuration is
     * still using, which must survive a commit that never lands. Writing the
     * slot afterwards is what guarantees that, and it means no previous key is
     * ever held in a closure spanning the commit.
     */
    await commitSettings(
      deps.ctx,
      next,
      expectedVersionOf(settings, persisted),
      "providers.update",
      `profile ${profile.name} (${profile.id}): ${changed.join(", ")} → r${profile.revision}, v${next.version}`,
      owner,
    );
    if (slug !== null && parsed.api_key !== undefined) {
      const path = sharedSecretPath(deps.ctx.fleetId(), slug);
      /**
       * The slot write is fenced on both sides by a re-acquire, because it is
       * the one write here that no store condition guards.
       *
       * The settings commit above carries the lock owner, so a lock that
       * expired under this run and was taken by somebody else makes that write
       * fail: the condition is on *our* owner, not on whatever lock happens to
       * be there. SSM has no such condition. A throttled call between the two
       * writes can outlast the thirty-second TTL, and in that window another
       * operator may take the lock, commit revision N+2 and write their key —
       * and a `put` arriving late would silently overwrite it, leaving the
       * record describing their rotation and the slot holding ours.
       *
       * So: re-acquire before the write, which renews the lock when it is still
       * ours and fails when it is not, and refuse rather than overwrite; and
       * re-acquire after it, because a lock lost across the write means the
       * slot may now hold a key the record does not describe. Saying so is the
       * difference between "re-run the rotation" and "it worked".
       */
      if (!(await lock.acquire(owner))) {
        throw new HermeticError(
          "CONFLICT",
          `${profile.name} was updated, but the ${FLEET_KEY} lock was lost before its key reached ${slug}, so another operator's rotation may be in flight; nothing was written to the slot — re-run the rotation once they are done`,
          { profile: profile.id, slug, partial_write: slug },
        );
      }
      try {
        await backend.secrets.ensureSlot(path);
        await backend.secrets.put(path, parsed.api_key);
      } catch {
        // The record says revision N+1 and the slot still holds the old key.
        // Nothing is broken — every agent on the old key keeps working — but
        // the rotation did not happen, and saying so is the difference between
        // "run it again" and "it worked".
        throw new HermeticError(
          "CONFLICT",
          `${profile.name} was updated, but its key could not be written to ${slug}; the previous key is still in place — re-run the rotation`,
          { profile: profile.id, slug, partial_write: slug },
        );
      }
      if (!(await lock.acquire(owner))) {
        throw new HermeticError(
          "CONFLICT",
          `${profile.name}'s key was written to ${slug}, but the ${FLEET_KEY} lock had been lost by then, so the slot may hold a key this fleet's record does not describe — re-run the rotation once the other operator is done`,
          { profile: profile.id, slug, partial_write: slug },
        );
      }
    }
    const agents = (await deps.ctx.scanAgents()).agents;
    return { profile: await viewOf(next, fleet, agents, profile), settings: next, persisted: true };
  }

  async function providersDelete(input: ProvidersDeleteInput): Promise<ProvidersDeleteResult> {
    const parsed = ProvidersDeleteInputSchema.parse(input);
    return withProfileLock("providers.delete", "hermetic providers rm", (held) =>
      deleteLocked(parsed, held),
    );
  }

  /** The delete itself, with the fleet lock already held; see `createLocked`. */
  async function deleteLocked(
    parsed: ProvidersDeleteInput,
    { owner, settings, persisted }: Held,
  ): Promise<ProvidersDeleteResult> {
    const profile = resolveProfileIn(settings, parsed.profile);

    /**
     * Every reason this cannot happen is found before the confirmation is
     * asked for, the same order `secrets rm` uses: making an operator confirm
     * and *then* telling them it was never possible wastes the one gesture the
     * ceremony exists for.
     */
    if (settings.default_profile === profile.id) {
      throw new HermeticError(
        "VALIDATION",
        `${profile.name} is the fleet default profile; make another profile the default first`,
        { profile: profile.id },
      );
    }
    const agents = (await deps.ctx.scanAgents()).agents;
    const linked = linkedAgents(settings, agents, profile);
    if (linked.length > 0) {
      throw new HermeticError(
        "PROFILE_IN_USE",
        `${profile.name} is still the profile for ${linked.join(", ")}; move those agents first`,
        { profile: profile.id, linked_agents: linked },
      );
    }
    /**
     * A staged binding is a use of the profile too (§8.3). Without this the
     * delete succeeds, and the `apply` the operator runs afterwards refuses
     * with "profile no longer exists" on a row whose `pending` names something
     * nothing can show them — a state reached by two commands that each
     * reported success.
     */
    const staged = pendingAgents(agents, profile);
    if (staged.length > 0) {
      throw new HermeticError(
        "PROFILE_IN_USE",
        `${staged.join(", ")} ${staged.length === 1 ? "is" : "are"} staged onto ${profile.name} and not yet applied; ` +
          `run \`hermetic apply\` to perform that change, or re-stage those agents onto another profile first`,
        { profile: profile.id, pending_agents: staged },
      );
    }
    if (parsed.yes !== true) {
      throw new HermeticError(
        "CONFIRMATION_REQUIRED",
        `deleting the profile ${profile.name} deletes its credential slot; pass yes`,
        { profile: profile.id },
      );
    }

    /**
     * Only the slot this profile *owns*. A profile migrated off the old
     * `settings.providers[p].secret` points at a shared slug that predates
     * profiles and that other things may still name, and deleting the profile
     * is not permission to delete that (§8.3).
     */
    const owned =
      profile.credential.kind === "secret" && profile.credential.slug === profileSlotSlug(profile.id)
        ? profile.credential.slug
        : null;

    const profiles = { ...(settings.profiles ?? {}) };
    delete profiles[profile.id];
    const next: FleetSettings = {
      ...settings,
      version: persisted ? settings.version + 1 : 1,
      profiles,
      ...(owned === null ? {} : { secrets: settings.secrets.filter((s) => s.slug !== owned) }),
      updated_at: deps.ctx.nowIso(),
      updated_by: await deps.ctx.actor(),
    };
    /**
     * The record first, then the slot — the reverse of a create, and the
     * reverse for the same reason.
     *
     * A delete that removed the key first and then lost the settings write
     * would leave a profile every head still lists, pointing at a slot that no
     * longer exists: `providers ls` would call it ready one moment and
     * `key-missing` the next, and an `agents.create` in between would have
     * provisioned a box around a key that was already gone. Committing first
     * makes the failure harmless — the settings write either lands or it does
     * not, and while it has not, the profile and its key are both still there.
     *
     * The sweep afterwards is therefore best-effort by construction. A slot
     * left behind is a fleet secret nobody names, which costs money and is
     * worth telling the operator about, so the result says which slug rather
     * than failing a delete that has already happened.
     */
    await commitSettings(
      deps.ctx,
      next,
      expectedVersionOf(settings, persisted),
      "providers.delete",
      `profile ${profile.name} (${profile.id}) removed → v${next.version}`,
      owner,
    );
    let sweepFailed: string | null = null;
    if (owned !== null) {
      try {
        await backend.secrets.delete(sharedSecretPath(deps.ctx.fleetId(), owned));
      } catch {
        sweepFailed = owned;
      }
    }
    return {
      id: profile.id,
      name: profile.name,
      deleted: true,
      settings: next,
      ...(sweepFailed === null ? {} : { slot_not_deleted: sweepFailed }),
    };
  }

  /**
   * The provider's own catalog, fetched now (§8.3).
   *
   * Two callers, one shape. Editing a saved profile presents the credential the
   * fleet holds — read here and dropped before this function returns. Setting a
   * provider up presents the draft credential the operator is typing, which is
   * never stored, never logged, and never in the answer.
   */
  async function providersModels(input: ProvidersModelsInput): Promise<ProvidersModelsOutput> {
    const parsed = ProvidersModelsInputSchema.parse(input);
    const { settings } = await readSettings(deps.ctx);

    const resolved = await (async (): Promise<{
      provider: Provider;
      selected: string;
      key: string | undefined;
      profile: string | undefined;
    }> => {
      if (parsed.profile !== undefined) {
        const profile = resolveProfileIn(settings, parsed.profile);
        if (profile.credential.kind === "role") {
          return {
            provider: profile.provider,
            selected: profile.model,
            key: undefined,
            profile: profile.id,
          };
        }
        const path = sharedSecretPath(deps.ctx.fleetId(), profile.credential.slug);
        if (!(await backend.secrets.exists(path)) || (await backend.secrets.isPlaceholder(path))) {
          throw new HermeticError(
            "PROVIDER_AUTH",
            `${profile.name} has no key stored yet; push one before reading ${PROVIDERS[profile.provider].label}'s catalog`,
            { profile: profile.id, provider: profile.provider },
          );
        }
        return {
          provider: profile.provider,
          selected: profile.model,
          key: await backend.secrets.get(path),
          profile: profile.id,
        };
      }
      const provider = parsed.provider as Provider;
      return {
        provider,
        selected: PROVIDERS[provider].default_model,
        key: parsed.api_key,
        profile: undefined,
      };
    })();

    const { models }: { models: CatalogModel[] } = await listModels(
      {
        provider: resolved.provider,
        api_key: resolved.key,
        selected: resolved.selected,
      },
      deps.catalog,
    );
    return {
      provider: resolved.provider,
      ...(resolved.profile === undefined ? {} : { profile: resolved.profile }),
      models,
      // The model this answer is pinned to: the profile's when one was named,
      // the catalog's otherwise. Never re-derived onto the profile.
      default_model: resolved.selected,
      fetched_at: deps.ctx.nowIso(),
    };
  }

  return { providersList, providersCreate, providersUpdate, providersDelete, providersModels };
}
