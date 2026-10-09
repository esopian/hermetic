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
 * 1. the row is read again and must still be this run's — the same
 *    incarnation, under this run's live lock (`assertStillHeld`) — and only
 *    then is the volume retagged (idempotent: the same tags again), and so is
 *    every other disk still tagged `agent=<name>` that predates the run
 *    (`taggedExtras`; idempotent too: one already moved no longer matches),
 * 2. the `release` event is appended under the agent's name,
 * 3. the tombstone is written,
 * 4. the row is deleted, conditional on the version and `created_at` this
 *    run read,
 * 5. local state is purged.
 *
 * The tombstone goes in *before* the delete. A crash between the two leaves a
 * tombstone and a row still in `destroying` — which the next `destroy` finds,
 * re-runs (every step before this one is re-entrant) and finishes, reusing the
 * tombstone it finds for this incarnation rather than writing a second. The
 * other order could leave a freed name with no record that an agent ever held
 * it, which is the one outcome this must never produce.
 */
import type { Agent, AgentEvent, AgentTombstone } from "../../schema/index.ts";
import type { CoreContext } from "../../context.ts";
import { checkAbort } from "../../abort.ts";
import { HermeticError, isHermeticError } from "../../errors.ts";
import { isLockLive } from "../state.ts";
import {
  AGENT_TAG,
  FLEET_ID_TAG,
  FORMER_AGENT_TAG,
  MANAGED_TAG,
  MANAGED_TAG_VALUE,
} from "../../backend/constants.ts";

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
  /**
   * Who is releasing it: the tombstone's `destroyed_by`, or its `released_by`
   * when the row is a legacy `destroyed` one somebody else destroyed earlier.
   */
  actor: string;
  /**
   * When the run doing the release began — read off the clock before it took
   * the row's lock. A disk EC2 created later than this is not swept
   * (`taggedExtras`): nothing of this incarnation could have made it while
   * this run held the name, so it can only be a later incarnation's, made
   * after this run's lock lapsed and somebody else released and re-created
   * the name.
   */
  runStartedAt: string;
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

/** What `volumeHold` found: see there. */
export type VolumeHold =
  | { kind: "owned" }
  | { kind: "released" }
  | { kind: "gone" }
  | { kind: "foreign"; refusal: HermeticError };

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
   * Every *other* disk this run found still tagged `agent=<name>` and moved
   * off the name (`taggedExtras`), never deleted: ids and the state each was
   * in. Empty on a retry that finds them already moved. The ids are also in
   * the `release` event's `detail`, when this run is the one that writes it.
   */
  swept: Array<{ volume_id: string; state: string }>;
  /**
   * The error `purgeLocal` threw, or `null`. The name is already released by
   * then, so a failed local purge is reported, not raised: raising it would
   * fail an operation whose every AWS-side effect has already happened.
   */
  localPurgeError: unknown;
}

/**
 * How far ahead of this laptop's clock a tombstone may be dated and still be
 * taken for genuine. A genuine one can run ahead: its `destroyed_at` is kept
 * strictly after its `created_at`, which is kept strictly after its
 * predecessor's `incarnationEnd` (`strictlyAfter`), so under a frozen clock —
 * the fixture's, a test's — each life of a name lands a millisecond or two
 * past the last, and a laptop trailing the one that wrote it reads it as
 * ahead by the skew. Without the slack such a tombstone would be ignored as
 * forged, the next life born back at "now", and its destroy keyed on its
 * predecessor's instant — overwriting that tombstone. A forgery inside the
 * slack can move a key or a floor by at most this much.
 */
export const TOMBSTONE_CLOCK_SLACK_MS = 60_000;

/**
 * `now`, unless it is not later than `floor` — then one millisecond past it.
 * A new incarnation's `created_at` must be strictly after its predecessor's
 * `destroyed_at`: `history --since/--until` is inclusive at both ends (§6.7),
 * so two lives that share a boundary instant would share an event window. A
 * frozen clock (the fixture's, a test's) or two readings inside one
 * millisecond make them equal; a laptop whose clock trails the one that
 * destroyed the predecessor makes `now` earlier.
 *
 * A floor more than `TOMBSTONE_CLOCK_SLACK_MS` ahead of `now` is not trusted,
 * and `now` is returned as if there were none. The release keys a fresh
 * tombstone on `strictlyAfter(now, agent.created_at)`, and the row's
 * `created_at` is writable by the box it describes (`ownership.ts`): one set
 * to the year 3000 would otherwise key the tombstone there, where it sorts as
 * the name's newest for good.
 */
export function strictlyAfter(now: string, floor: string | null): string {
  if (floor === null) return now;
  const floorMs = Date.parse(floor);
  const nowMs = Date.parse(now);
  if (Number.isNaN(floorMs) || nowMs > floorMs) return now;
  if (floorMs > nowMs + TOMBSTONE_CLOCK_SLACK_MS) return now;
  return new Date(floorMs + 1).toISOString();
}

/**
 * When and by whom a legacy `destroyed` row was destroyed (§6.7), from the
 * name's history, newest first. The row never said who destroyed it, so the
 * newest event that moved it to `destroyed` does; its timestamp is the moment,
 * falling back on the row's own `updated_at` (the destroy was its last write)
 * when no event survives. Shared by `agents.destroyed`, which renders a legacy
 * row through it, and the release, which writes it into the tombstone, so the
 * record does not change its account of the destroy when it is released.
 */
export function legacyDestruction(
  agent: Agent,
  events: readonly AgentEvent[],
): { at: string; by: string } {
  const last = events.find((e) => e.to_status === "destroyed");
  return { at: last?.timestamp ?? agent.updated_at, by: last?.actor ?? "unknown" };
}

/**
 * The last instant of an incarnation's record (`AgentTombstone.released_at`):
 * the `until` that still includes its `release` event, and the instant the
 * name's next incarnation must be born strictly after.
 */
export function incarnationEnd(t: AgentTombstone): string {
  return t.released_at ?? t.destroyed_at;
}

export function createReleaseName(deps: ReleaseNameDeps) {
  const { actor, backend, fleetId, nowIso } = deps.ctx;

  /**
   * Whether neither of a tombstone's instants — `destroyed_at`, and
   * `released_at` when it has one — is later than the clock reads now, give
   * or take `TOMBSTONE_CLOCK_SLACK_MS`.
   */
  function notFutureDated(t: AgentTombstone, nowMs: number): boolean {
    return [t.destroyed_at, incarnationEnd(t)].every((iso) => {
      const at = Date.parse(iso);
      return !Number.isNaN(at) && at <= nowMs + TOMBSTONE_CLOCK_SLACK_MS;
    });
  }

  /**
   * The tombstone a previous, interrupted release of this same incarnation
   * already wrote, if any. An incarnation is a name plus the `created_at` the
   * row was born with: a reused name has a later one, so its predecessors'
   * tombstones never match it.
   *
   * A candidate dated in the future is ignored. A genuine retry's tombstone
   * was written by an earlier run, so it is in the past, or ahead by no more
   * than the slack (`TOMBSTONE_CLOCK_SLACK_MS`); one dated later than that can
   * only be forged (the events table is writable by the
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
   * The instant a new incarnation of `name` must be born after
   * (`strictlyAfter`): the `incarnationEnd` of the newest tombstone for the
   * name that is not dated in the future, or `null` when there is none. A
   * future-dated one is forged (see `existingTombstone`) and is passed over
   * rather than pushing the new row's `created_at` to a time the forger chose
   * — and passed over, not taken to mean "no predecessor": it sorts newest for
   * as long as it stays in the future, so stopping at it would leave every
   * later life of the name without a floor. The whole per-name list is read;
   * a name has one tombstone per life, so it is short.
   */
  async function predecessorFloor(name: string): Promise<string | null> {
    const nowMs = Date.parse(nowIso());
    const tombstones = await backend.store.events.queryTombstones({ name });
    const genuine = tombstones.find((t) => notFutureDated(t, nowMs));
    return genuine === undefined ? null : incarnationEnd(genuine);
  }

  /**
   * Where the volume a row names stands with respect to `name` (§6.7). The row
   * is writable by the box it describes (`ownership.ts`), and a legacy row may
   * have kept naming a disk that was deleted or adopted by another agent
   * since, so the id is resolved and its tags read before anything is written
   * to — or deleted from — it:
   *
   * - `owned`: this agent's data disk, and nothing on it says a release
   *   promised to keep it;
   * - `released`: it carries `hermetic:former_agent=<name>` — a destroy that
   *   kept it already started moving it off the name. The destroy writes
   *   that tag before it terminates anything (`destroy-agent.ts`), and
   *   `retagVolume` sets it again *before* it removes `agent`, so this covers
   *   a release that finished (managed, this fleet, no `agent` tag) and a
   *   destroy interrupted anywhere before that (`agent=<name>` still there
   *   too). The intent to
   *   keep is durable on the volume itself, before any tombstone records it,
   *   so every caller reads this as "keep": a retry finishes the retag, and a
   *   destroy that did not ask for `--keep-volume` still never deletes it.
   *   (An adoption interrupted between the same two calls leaves the same
   *   pair of tags; `create-agent.ts` finishes that one before the row can
   *   be destroyed, so a live row never names such a disk.) A row pointed at
   *   an earlier incarnation's kept disk reads this way too; whatever disk
   *   still carries `agent=<name>` instead is the release's sweep to move off
   *   the name (`taggedExtras`), so the decoy cannot leave it behind for the
   *   next `create` to adopt;
   * - `gone`: EC2 has no such volume any more, or it is being deleted;
   * - `foreign`: somebody else's disk now, with the refusal that says so.
   *   Left exactly as it is — releasing this name must never take another
   *   agent's memory with it. That includes a managed disk with no `agent`
   *   tag that names some *other* former agent, or none.
   */
  async function volumeHold(name: string, volumeId: string): Promise<VolumeHold> {
    const owner = { fleet_id: fleetId(), agent: name };
    try {
      const found = await backend.compute.describeOwnedVolume(volumeId, owner);
      if (found === null || found.state === "deleting" || found.state === "deleted") {
        return { kind: "gone" };
      }
      return { kind: found.former_agent === name ? "released" : "owned" };
    } catch (e) {
      if (!isHermeticError(e) || e.code !== "RESOURCE_NOT_OWNED") throw e;
      const tags = (e.details?.["found"] ?? {}) as Record<string, string | null>;
      const released =
        tags[MANAGED_TAG] === MANAGED_TAG_VALUE &&
        tags[FLEET_ID_TAG] === owner.fleet_id &&
        (tags[AGENT_TAG] ?? null) === null &&
        tags[FORMER_AGENT_TAG] === name;
      return released ? { kind: "released" } : { kind: "foreign", refusal: e };
    }
  }

  /**
   * §6.7: every disk besides `except` (the row's own) that is managed, in this
   * fleet and still tagged `agent=<name>` — the ones the release then moves
   * off the name exactly as a kept volume is, `agent` removed and
   * `former_agent=<name>` set, and reports. A released name must hold no
   * disk, or the next `create` of it adopts one by tag (`findVolumeByTag`).
   * Such a disk is a duplicate `doctor` reports, a launch whose volume id
   * never reached the row, or the real disk of a row the box pointed elsewhere
   * (or at nothing) — the row never named it, so nothing proves it is this
   * incarnation's to lose, and it is never deleted.
   *
   * Its state is not consulted. Every instance tagged for the name is
   * terminated before a destroy's release, and a legacy row's long before, so
   * one still `in-use` is attached to some other box; tags are all the
   * release changes, which detaches nothing, while leaving `agent=<name>` on
   * it would hand it to the next `create` of the name. Moving it is
   * idempotent: one already moved no longer matches, so a retry sweeps only
   * what is left.
   *
   * Its age is. A disk EC2 created after `since` — the run's start — is left
   * out: this run held the name from then on, so no launch of this
   * incarnation made it, and the only way to one is a release that stalled
   * past its lock while somebody else released the name and created it
   * again. That disk is the successor's live memory. `assertStillHeld` refuses
   * such a stalled run before it writes anything; this is the same fence on
   * the disk itself, for a stall that falls between the two. The comparison
   * is EC2's clock against this laptop's: a laptop running behind would leave
   * out a duplicate made in the last moments before the run, the rare and
   * recoverable side (the next destroy of the name sweeps it), never the
   * other way round.
   */
  async function taggedExtras(
    name: string,
    except: string | null,
    since: string,
  ): Promise<Array<{ volume_id: string; state: string }>> {
    const sinceMs = Date.parse(since);
    return (await backend.compute.listVolumesByAgentTag(name))
      .filter((v) => v.volume_id !== except && v.agent === name)
      .filter((v) => v.created_at === null || !(Date.parse(v.created_at) > sinceMs))
      .map((v) => ({ volume_id: v.volume_id, state: v.state }));
  }

  /**
   * Whether the row is still this run's to release, read fresh immediately
   * before the first tag write: the same incarnation (`created_at`), under a
   * lock this run owns and that has not expired. Anything else throws
   * `CONFLICT` having changed nothing — the same refusal `assertUnmoved`
   * makes for a plan the world moved under.
   *
   * The conditional delete at the end already refuses to remove a later
   * incarnation's row, but by then the tags are written: a release that
   * stalled past its lock while somebody else released the name and created
   * it again would move the successor's disk off the name before its delete
   * failed. Asking first closes that. What is left is a stall *between* this
   * read and the writes, which `taggedExtras`'s age check and the
   * value-conditional tag removal (`expectedAgent`) still cover.
   */
  async function assertStillHeld(agent: Agent): Promise<void> {
    const fresh = await backend.store.agents.get(agent.name);
    const owner = agent.lock?.owner ?? null;
    const held =
      fresh !== null &&
      owner !== null &&
      fresh.created_at === agent.created_at &&
      fresh.lock?.owner === owner &&
      isLockLive(fresh.lock, undefined, Date.parse(nowIso()));
    if (held) return;
    throw new HermeticError(
      "CONFLICT",
      `${agent.name} is no longer held by this release (its lock lapsed, or the name moved on); nothing was released — run the destroy again`,
      {
        name: agent.name,
        created_at: agent.created_at,
        owner,
        found_created_at: fresh?.created_at ?? null,
        found_owner: fresh?.lock?.owner ?? null,
        found_expires: fresh?.lock?.expires ?? null,
      },
    );
  }

  async function releaseName(agent: Agent, opts: ReleaseNameOptions): Promise<ReleaseResult> {
    const volumeId = agent.resources.volume_id ?? agent.volume_id ?? null;
    const instanceId = agent.resources.instance_id ?? agent.instance_id ?? null;
    checkAbort(opts.signal, "release");

    // (a) Move a kept volume off the name — this agent's disk, or one a
    // previous, interrupted release (or this destroy's own pre-terminate
    // write, `destroy-agent.ts`) already started moving (`released`), which
    // is retagged again to the same effect. `role=data` stays so the disk is
    // still recognisably an agent's memory; its display `Name` is left alone.
    //
    // Then every other disk still tagged for the name that predates this run,
    // kept or not, moved off it the same way and never deleted
    // (`taggedExtras`).
    //
    // Reads first, then the row checked again, then the writes: nothing is
    // retagged unless the row is still this run's (`assertStillHeld`). Each
    // write removes `agent` only while it still says `<name>`
    // (`expectedAgent`), so a disk another agent adopted after the read keeps
    // its new owner.
    const held = opts.volumeKept && volumeId ? await volumeHold(agent.name, volumeId) : null;
    const hold = held?.kind ?? "none";
    const volume = hold === "owned" || hold === "released" ? "retag" : hold;
    const swept = await taggedExtras(agent.name, volumeId, opts.runStartedAt);
    await assertStillHeld(agent);
    const moveOff = { formerAgent: agent.name, expectedAgent: agent.name };
    if (volume === "retag" && volumeId) {
      await backend.compute.retagVolume(volumeId, null, moveOff);
    }
    for (const v of swept) {
      await backend.compute.retagVolume(v.volume_id, null, moveOff);
    }

    // (b) The record of this incarnation. The `release` event is appended
    // under the name before the row goes — events are never deleted, so this
    // is what `agent history` shows as the incarnation's last line — and it
    // carries the tombstone's own `incarnationEnd`, one clock reading for
    // both, so `history --until <incarnationEnd>` includes it.
    //
    // A legacy `destroyed` row was destroyed long before this run, by whoever
    // its history says: the tombstone keeps that time and actor, capped at
    // now so the release never predates the destroy, and records this run as
    // `released_at`/`released_by`. Any other row is destroyed by this very
    // run, which is also the release, so it carries no `released_*`.
    //
    // A retry that finds this incarnation's tombstone keeps its key — its
    // `destroyed_at`, exactly, whatever else it says — and, for a legacy row,
    // its `released_at`/`released_by`, and writes no second event. It writes
    // the tombstone again from the row: the put lands on the same key, so
    // there is still one, and its content is this run's account rather than
    // whatever was stored — the events table is writable by the boxes, and a
    // planted tombstone must not become the audit record. Nothing the prior
    // says may move the key: a forged `released_at` earlier than its
    // `destroyed_at` would otherwise put the retry's tombstone under a second
    // key beside the first.
    //
    // A fresh key is strictly after the row's `created_at`, which is strictly
    // after the predecessor's `incarnationEnd` (`predecessorFloor`), so the
    // keys of one name's lives only move forward: under a frozen clock, or a
    // laptop trailing the one that created the row, `now` alone would repeat
    // the predecessor's key and the put would overwrite its tombstone. A
    // `created_at` further ahead than the slack is the box's to have written
    // and is not followed: the key is `now` (`strictlyAfter`). A
    // legacy row keeps its original destroy time below and needs no floor: it
    // is the oldest life of its name that any tombstone records (it held the
    // name until now), and every later life is born after its `released_at`.
    const prior = await existingTombstone(agent);
    const now = nowIso();
    const legacy = agent.status === "destroyed";
    let destroyedAt = prior?.destroyed_at ?? strictlyAfter(now, agent.created_at);
    let destroyedBy = opts.actor;
    let releasedAt = now;
    if (legacy) {
      const original = legacyDestruction(agent, await backend.store.events.query(agent.name));
      if (prior === null) {
        // The first release caps the destroy at now, so the release never
        // predates it (a history written under a clock running ahead).
        const whenMs = Date.parse(original.at);
        destroyedAt = !Number.isNaN(whenMs) && whenMs <= Date.parse(now) ? original.at : now;
      } else {
        // A retry keeps both instants it finds, the release lifted to the
        // destroy if a forged prior put it earlier — never the other way
        // round, which would move the key.
        const priorReleased = prior.released_at ?? now;
        releasedAt = Date.parse(priorReleased) >= Date.parse(destroyedAt) ? priorReleased : destroyedAt;
      }
      destroyedBy = original.by;
    }
    // The release event's timestamp: the incarnation's last instant, the
    // `incarnationEnd` of the tombstone written below.
    const at = legacy ? releasedAt : destroyedAt;
    // The event also names every disk the sweep above moved off the name: the
    // retag is the only other trace of it, and the warnings a head shows are
    // gone with the run. It is a best effort, not a ledger — a run that crashed
    // after the sweep and before this append leaves its retry nothing to sweep
    // (`swept` is empty) and so nothing to list, and a retry that finds its
    // tombstone writes no event at all. Either way the disks are kept, and
    // `hermetic:former_agent=<name>` still finds them.
    if (prior === null) {
      const moved = swept.map((v) => v.volume_id).join(", ");
      await backend.store.events.append({
        name: agent.name,
        timestamp: at,
        actor: await actor(),
        action: "release",
        from_status: agent.status,
        to_status: null,
        detail: `name released; tombstone written${
          moved === "" ? "" : `; kept and tagged former_agent=${agent.name}: ${moved}`
        }`,
      });
    }
    const tombstone: AgentTombstone = {
      name: agent.name,
      fleet_id: fleetId(),
      created_at: agent.created_at,
      created_by: agent.created_by,
      destroyed_at: destroyedAt,
      destroyed_by: destroyedBy,
      size: agent.size,
      region: agent.region,
      provider: agent.provider,
      profile_id: agent.profile_id ?? null,
      instance_id: instanceId,
      volume_id: volumeId,
      volume_kept: volume === "retag",
      hermes_version: agent.hermes_version,
      ...(legacy ? { released_at: releasedAt, released_by: prior?.released_by ?? opts.actor } : {}),
      legacy: false,
    };
    await backend.store.events.appendTombstone(tombstone);

    // (c) The row, only if it is still the one this run read: the same
    // version of the same incarnation (`created_at`), so a release that
    // stalled past its lock cannot delete a later agent of this name that
    // happens to sit at the version it read. The lock goes with it, so the
    // caller must not release it afterwards.
    await backend.store.agents.delete(agent.name, {
      expectedVersion: agent.version,
      expectedCreatedAt: agent.created_at,
    });

    // (d) Whatever this laptop remembers about the name.
    let localPurgeError: unknown = null;
    if (deps.purgeLocal) {
      try {
        await deps.purgeLocal(fleetId(), agent.name);
      } catch (e) {
        localPurgeError = e;
      }
    }
    return {
      tombstone,
      volume: volume === "retag" ? "released" : volume,
      swept,
      localPurgeError,
    };
  }

  return { releaseName, existingTombstone, predecessorFloor, volumeHold };
}
