/**
 * Releasing a destroyed agent's name (§6.7): the last step of `agents.destroy`,
 * and the first step of an `agents.create` that finds a legacy `destroyed` row
 * still sitting on the name it wants.
 *
 * After a release nothing holds the name but the per-name `events` rows, which
 * are never deleted (§6.6), and one tombstone under the reserved `_destroyed`
 * partition of the events table. A kept data volume is moved off the name —
 * `agent=` removed, `hermetic:former_agent=<name>` set — so `findVolumeByTag`
 * cannot hand it to a later `create` of the same name; the agent row itself is
 * deleted. The instance, the tailnet device, the SSM prefix and the config
 * prefix are `destroy`'s own steps and are already gone by the time this runs.
 *
 * Crash ordering, which is the whole design:
 *
 * 1. the volume is retagged (idempotent: the same tags again),
 * 2. the `release` event is appended under the agent's name,
 * 3. the tombstone is written,
 * 4. the row is deleted, conditional on the version this run read,
 * 5. local state is purged.
 *
 * The tombstone goes in *before* the delete. A crash between the two leaves a
 * tombstone and a row still in `destroying` — which the next `destroy` finds,
 * re-runs (every step before this one is re-entrant) and finishes, reusing the
 * tombstone it finds for this incarnation rather than writing a second. The
 * other order could leave a freed name with no record that an agent ever held
 * it, which is the one outcome this must never produce.
 */
import type { Agent, AgentTombstone } from "../../schema/index.ts";
import type { CoreContext } from "../../context.ts";
import { checkAbort } from "../../abort.ts";
import { isHermeticError } from "../../errors.ts";
import { AGENT_TAG, FLEET_ID_TAG, MANAGED_TAG, MANAGED_TAG_VALUE } from "../../backend/constants.ts";

export interface ReleaseNameDeps {
  ctx: CoreContext;
  /**
   * Drop whatever this laptop keeps locally about `name` in `fleetId` (§4.5):
   * the cached view, notifications, watched conversations. Optional because
   * the release is complete without it — the store holds no row by then — and
   * a head that keeps nothing local has nothing to purge.
   */
  purgeLocal?: ((fleetId: string, name: string) => Promise<void>) | undefined;
}

export interface ReleaseNameOptions {
  /**
   * Whether the agent's data volume outlives it. `true` retags the volume
   * the row names as `former_agent`; `false` means the caller deleted it.
   */
  volumeKept: boolean;
  /** Who is releasing it, for the tombstone's `destroyed_by`. */
  actor: string;
  /**
   * Checked once, before the first write. Past that point the release runs to
   * the end: stopping between the tombstone and the delete is the crash case
   * the ordering tolerates, not one to cause on purpose.
   *
   * There is deliberately no heartbeat. The release is four quick writes on a
   * lock the caller holds — its `keepLock` just before the call renews only
   * when the lock is a third of its life old (`LOCK_RENEW_MS`), which leaves
   * it far more than four writes of life — and a renewal in the middle would
   * move the row's version under the conditional delete below, which is
   * made against the version of the `agent` passed in.
   */
  signal?: AbortSignal | undefined;
}

export interface ReleaseResult {
  tombstone: AgentTombstone;
  /**
   * What happened to the data volume the row named: `released` (retagged
   * `former_agent`), `gone` (kept was asked for but EC2 no longer has it),
   * `foreign` (it carries another owner's tags now and was left alone), or
   * `none` (no volume kept — the caller deleted it, or the row named none).
   */
  volume: "released" | "gone" | "foreign" | "none";
  /**
   * The error `purgeLocal` threw, or `null`. The name is already released by
   * then, so a failed local purge is reported, not raised: raising it would
   * fail an operation whose every AWS-side effect has already happened.
   */
  localPurgeError: unknown;
}

/**
 * `now`, unless it is not later than `floor` — then one millisecond past it.
 * A new incarnation's `created_at` must be strictly after its predecessor's
 * `destroyed_at`: `history --since/--until` is inclusive at both ends (§6.7),
 * so two lives that share a boundary instant would share an event window. A
 * frozen clock (the fixture's, a test's) or two readings inside one
 * millisecond make them equal; a laptop whose clock trails the one that
 * destroyed the predecessor makes `now` earlier.
 */
export function strictlyAfter(now: string, floor: string | null): string {
  if (floor === null) return now;
  const floorMs = Date.parse(floor);
  if (Number.isNaN(floorMs) || Date.parse(now) > floorMs) return now;
  return new Date(floorMs + 1).toISOString();
}

export function createReleaseName(deps: ReleaseNameDeps) {
  const { actor, backend, fleetId, nowIso } = deps.ctx;

  /** Whether a tombstone's `destroyed_at` is not later than the clock reads now. */
  function notFutureDated(t: AgentTombstone, nowMs: number): boolean {
    const at = Date.parse(t.destroyed_at);
    return !Number.isNaN(at) && at <= nowMs;
  }

  /**
   * The tombstone a previous, interrupted release of this same incarnation
   * already wrote, if any. An incarnation is a name plus the `created_at` the
   * row was born with: a reused name has a later one, so its predecessors'
   * tombstones never match it.
   *
   * A candidate dated in the future is ignored. A genuine retry's tombstone
   * was written by an earlier run, so it is always in the past; one dated
   * later than now can only be forged (the events table is writable by the
   * boxes), and adopting it would make the audit time the forger's choice —
   * one that could even overlap the next incarnation's `created_at`. It is
   * left where it is and a fresh tombstone is written beside it. A forgery
   * dated in the past still passes: it can only mis-date the audit record's
   * `destroyed_at`, and the per-name events log keeps the true times.
   */
  async function existingTombstone(agent: Agent): Promise<AgentTombstone | null> {
    const prior = await backend.store.events.queryTombstones({ name: agent.name });
    const nowMs = Date.parse(nowIso());
    return prior.find((t) => t.created_at === agent.created_at && notFutureDated(t, nowMs)) ?? null;
  }

  /**
   * The `destroyed_at` a new incarnation of `name` must be born after
   * (`strictlyAfter`): that of the newest tombstone for the name, or `null`
   * when there is none. A future-dated newest one is forged (see
   * `existingTombstone`) and yields `null` rather than pushing the new row's
   * `created_at` to a time the forger chose.
   */
  async function predecessorFloor(name: string): Promise<string | null> {
    const [newest] = await backend.store.events.queryTombstones({ name, limit: 1 });
    if (newest === undefined || !notFutureDated(newest, Date.parse(nowIso()))) return null;
    return newest.destroyed_at;
  }

  /**
   * What to do with the volume a kept-volume release names. The row is
   * writable by the box it describes (`ownership.ts`), and a legacy row may
   * have kept naming a disk that was deleted or adopted by another agent
   * since, so the id is resolved and its tags checked before anything is
   * written to it:
   *
   * - `retag`: this agent's data disk — or one a previous, interrupted release
   *   already moved off the name (managed, this fleet, no `agent` tag), which
   *   is retagged again to the same effect;
   * - `gone`: EC2 has no such volume any more, or it is being deleted;
   * - `foreign`: somebody else's disk now. Left exactly as it is — releasing
   *   this name must never take another agent's memory with it.
   */
  async function keptVolume(name: string, volumeId: string): Promise<"retag" | "gone" | "foreign"> {
    const owner = { fleet_id: fleetId(), agent: name };
    try {
      const found = await backend.compute.describeOwnedVolume(volumeId, owner);
      if (found === null || found.state === "deleting" || found.state === "deleted") return "gone";
      return "retag";
    } catch (e) {
      if (!isHermeticError(e) || e.code !== "RESOURCE_NOT_OWNED") throw e;
      const tags = (e.details?.["found"] ?? {}) as Record<string, string | null>;
      const released =
        tags[MANAGED_TAG] === MANAGED_TAG_VALUE &&
        tags[FLEET_ID_TAG] === owner.fleet_id &&
        (tags[AGENT_TAG] ?? null) === null;
      return released ? "retag" : "foreign";
    }
  }

  async function releaseName(agent: Agent, opts: ReleaseNameOptions): Promise<ReleaseResult> {
    const volumeId = agent.resources.volume_id ?? agent.volume_id ?? null;
    const instanceId = agent.resources.instance_id ?? agent.instance_id ?? null;
    checkAbort(opts.signal, "release");

    // (a) Move a kept volume off the name. `role=data` stays so the disk is
    // still recognisably an agent's memory; its display `Name` is left alone.
    const volume = opts.volumeKept && volumeId ? await keptVolume(agent.name, volumeId) : "none";
    if (volume === "retag" && volumeId) {
      await backend.compute.retagVolume(volumeId, null, { formerAgent: agent.name });
    }

    // (b) The record of this incarnation. The `release` event is appended
    // under the name before the row goes — events are never deleted, so this
    // is what `agent history` shows as the incarnation's last line — and it
    // carries the tombstone's own `destroyed_at`, one clock reading for both,
    // so `history --until <destroyed_at>` includes it.
    //
    // A retry that finds this incarnation's tombstone keeps its key (its
    // `destroyed_at`) and writes no second event, but writes the tombstone
    // again from the row: the put lands on the same key, so there is still
    // one, and its content is this run's account rather than whatever was
    // stored — the events table is writable by the boxes, and a planted
    // tombstone must not become the audit record.
    const prior = await existingTombstone(agent);
    const at = prior?.destroyed_at ?? nowIso();
    if (prior === null) {
      await backend.store.events.append({
        name: agent.name,
        timestamp: at,
        actor: await actor(),
        action: "release",
        from_status: agent.status,
        to_status: null,
        detail: "name released; tombstone written",
      });
    }
    const tombstone: AgentTombstone = {
      name: agent.name,
      fleet_id: fleetId(),
      created_at: agent.created_at,
      created_by: agent.created_by,
      destroyed_at: at,
      destroyed_by: opts.actor,
      size: agent.size,
      region: agent.region,
      provider: agent.provider,
      profile_id: agent.profile_id ?? null,
      instance_id: instanceId,
      volume_id: volumeId,
      volume_kept: volume === "retag",
      hermes_version: agent.hermes_version,
      legacy: false,
    };
    await backend.store.events.appendTombstone(tombstone);

    // (c) The row, only if it is still the one this run read. The lock goes
    // with it, so the caller must not release it afterwards.
    await backend.store.agents.delete(agent.name, { expectedVersion: agent.version });

    // (d) Whatever this laptop remembers about the name.
    let localPurgeError: unknown = null;
    if (deps.purgeLocal) {
      try {
        await deps.purgeLocal(fleetId(), agent.name);
      } catch (e) {
        localPurgeError = e;
      }
    }
    return { tombstone, volume: volume === "retag" ? "released" : volume, localPurgeError };
  }

  return { releaseName, existingTombstone, predecessorFloor };
}
