/**
 * The volume surface (§9): `volumes.list`, `volumes.get`, `volumes.delete`.
 *
 * Instances are disposable, volumes are precious (§1) — which means a volume
 * outlives the row that made it. `destroy` keeps the data volume by default
 * (§6.6), so an account that has seen agents come and go accumulates memory
 * nothing is reading and everything is billing for. Before this module the only
 * thing that could see those volumes was `teardown --delete-volumes`, at the
 * one moment it was too late to do anything but delete them.
 *
 * The one idea here is the **grouping**, and it is a join core has to do
 * because neither head may: a volume's *state* is an EC2 fact and its *owner*
 * is a DynamoDB fact, and "which memory has nobody reading it" is the two of
 * them together. `doctor` reconciles the same pair for instances (§9); this is
 * that reconciliation for volumes, surfaced instead of diagnosed.
 *
 * Written as a module taking an explicit deps object (AGENTS.md rule 5), the
 * same shape as `LifecycleDeps`/`TeardownDeps`/`PlanDeps`.
 */
import {
  DeleteVolumeInput as DeleteVolumeInputSchema,
  ListVolumesInput as ListVolumesInputSchema,
  VolumeRefInput as VolumeRefInputSchema,
  monthlyCostUsd,
} from "../schema/index.ts";
import type {
  Agent,
  DeleteVolumeInput,
  ListVolumesInput,
  VolumeDeleteResult,
  VolumeDetailResult,
  VolumeGroup,
  VolumeListResult,
  VolumeRefInput,
  VolumeSummary,
  VolumeView,
} from "../schema/index.ts";
import { randomUUID } from "node:crypto";
import { HermeticError } from "../errors.ts";
import { DATA_SNAPSHOT_TAG } from "../backend/constants.ts";
import type { SnapshotRef, VolumeDetail } from "../backend/types.ts";
import type { CoreContext } from "../context.ts";
import {
  ADVISORY_LOOSE_VOLUME,
  looseVolumeAdvisories,
  observeAdvisories,
} from "../chat/notifications.ts";
import type { VolumeReservation } from "./volume-claims.ts";
import { deletionOwner } from "./volume-claims.ts";

/** What the volume surface needs beyond the shared context: the reservation it shares with `agent create --volume` (§9.1). */
export interface VolumesDeps {
  ctx: CoreContext;
  reservation: VolumeReservation;
}

/** A volume is attached when EC2 reports any attachment that is not `detached`. */
function attachmentOf(volume: VolumeDetail): string | null {
  const live = volume.attachments.find((a) => a.state !== "detached");
  return live?.instance_id ?? null;
}

/**
 * Attached, whether or not EC2 named the instance. `in-use` with no attachment
 * is a shape EC2 does not produce, but reading it as *unattached* would be the
 * one mistake with a bad blast radius here — it is what decides whether a
 * volume is offered for deletion.
 */
function isAttached(volume: VolumeDetail): boolean {
  return attachmentOf(volume) !== null || volume.state === "in-use";
}

/**
 * The volumes an agent name could mean, exactly as `findVolumeByTag` decides
 * it (`aws/ec2.ts`): managed volumes carrying `agent=<name>`, with the
 * `role=data` one winning when there is more than one candidate. When neither
 * rule settles it — several candidates and none, or more than one, tagged
 * `role=data` — the tag is ambiguous and *every* candidate is reported as such.
 *
 * This is not a nicety. `findVolumeByTag` refuses this shape with `CONFLICT`
 * rather than guessing which volume holds an agent's memory, and a list that
 * showed one of them as the answer would be the guess that rule exists to
 * prevent.
 */
export function ambiguousVolumeTags(volumes: readonly VolumeDetail[]): Map<string, string[]> {
  const byAgent = new Map<string, VolumeDetail[]>();
  for (const v of volumes) {
    if (!v.managed || v.agent === null) continue;
    byAgent.set(v.agent, [...(byAgent.get(v.agent) ?? []), v]);
  }
  const ambiguous = new Map<string, string[]>();
  for (const [, candidates] of byAgent) {
    if (candidates.length < 2) continue;
    const tagged = candidates.filter((v) => v.role_data);
    if (tagged.length === 1) continue;
    for (const v of candidates) {
      ambiguous.set(
        v.volume_id,
        candidates.filter((o) => o.volume_id !== v.volume_id).map((o) => o.volume_id),
      );
    }
  }
  return ambiguous;
}

/** The rows that name a volume, split by whether they are still an owner. */
export interface VolumeOwners {
  /** Rows that are not `destroyed`: the agents this volume actually belongs to. */
  live: Agent[];
  /** Destroyed rows that still name it — kept forever (§4.3), owners of nothing. */
  historical: Agent[];
}

/**
 * Every agent row that names a volume, live rows told from historical ones.
 *
 * The row's `resources.volume_id` is the authoritative link — it is what
 * `create` wrote as it went (§4.5) — and the `agent` tag is the fallback for a
 * volume whose row predates it or whose create died before the write.
 *
 * Returning *all* of them, rather than the first match, is the point. A
 * destroyed row goes on naming its volume forever, and `agent create B --volume
 * <id>` gives that same disk a live owner, so a volume with a history has two
 * rows naming it and which one a scan happens to return first is arbitrary. The
 * first-match version of this function answered with whichever came back first,
 * so a disk that `B` is using read as `no_agent` — free, reclaimable, and
 * offered for deletion — roughly half the time. Live rows win; the ambiguity of
 * two *live* claimants is reported rather than resolved (§1).
 */
export function ownersOf(volume: VolumeDetail, agents: readonly Agent[]): VolumeOwners {
  const byId = agents.filter((a) => (a.resources.volume_id ?? a.volume_id) === volume.volume_id);
  const live = byId.filter((a) => a.status !== "destroyed");
  const historical = byId.filter((a) => a.status === "destroyed");
  /**
   * The tag is only consulted when no live row names the id, and never to add a
   * second claimant: a tag says which agent *last* wrote it, and `create`
   * rewrites it on adoption, so reading it as ownership beside a row that names
   * the id would manufacture ambiguity out of a stale label.
   */
  if (live.length === 0 && volume.agent !== null) {
    const tagged = agents.find((a) => a.name === volume.agent && !byId.some((b) => b.name === a.name));
    if (tagged) (tagged.status === "destroyed" ? historical : live).push(tagged);
  }
  return { live, historical };
}

/**
 * Where a volume belongs. Order matters and encodes the design's rules:
 * ambiguity beats everything (hermetic does not know which volume this
 * is, or whose it is), an unmanaged volume is never hermetic's to place, and a
 * *destroyed* agent row does not count as an owner — the row is kept forever
 * (§4.3) but nothing is reading its volume, which is the whole point of the
 * group.
 */
export function groupOf(volume: VolumeDetail, owners: VolumeOwners, ambiguous: boolean): VolumeGroup {
  if (ambiguous) return "ambiguous";
  if (!volume.managed) return "unmanaged";
  // Two live rows claiming one disk is the same refusal as two disks claiming
  // one agent tag, from the other end: hermetic knows which volume this is and
  // not whose it is, and either way the answer is not to pick one.
  if (owners.live.length > 1) return "ambiguous";
  if (isAttached(volume)) return "attached";
  return owners.live.length === 1 ? "detached" : "no_agent";
}

export function createVolumes(deps: VolumesDeps) {
  const { assertFleetUnlocked, backend, guardFleet, nowIso } = deps.ctx;
  const { reservation } = deps;

  /**
   * One read of reality: EC2's volumes, EC2's snapshots, DynamoDB's rows. The
   * three are joined here and nowhere else — a head that recomputed the
   * grouping would be a second definition of it (§3.1).
   */
  async function readAll(): Promise<{ views: VolumeView[]; snapshots: SnapshotRef[] }> {
    const [volumes, snapshots, agents, reserved] = await Promise.all([
      backend.compute.listVolumes(),
      backend.compute.listSnapshots(DATA_SNAPSHOT_TAG),
      backend.store.agents.scan(),
      // §9.1: a fourth fact, read the same way the other three are. A volume
      // somebody is mid-adoption of looks free to every other read here, and a
      // list that showed it as reclaimable would be inviting a race it can see.
      reservation.holders(),
    ]);
    const ambiguous = ambiguousVolumeTags(volumes);
    const now = Date.parse(nowIso());

    const byVolume = new Map<string, SnapshotRef[]>();
    for (const snap of snapshots) {
      byVolume.set(snap.volume_id, [...(byVolume.get(snap.volume_id) ?? []), snap]);
    }

    const views = volumes.map((volume): VolumeView => {
      const owners = ownersOf(volume, agents);
      const owner = owners.live[0] ?? owners.historical[0] ?? null;
      const claim = reserved.get(volume.volume_id) ?? null;
      const twins = ambiguous.get(volume.volume_id) ?? null;
      const attached_to = attachmentOf(volume);
      const attached = isAttached(volume);
      const snaps = byVolume.get(volume.volume_id) ?? [];
      const newest = snaps.reduce<string | null>(
        (acc, s) => (acc === null || s.started_at > acc ? s.started_at : acc),
        null,
      );
      /**
       * How long it has been free. EC2 does not report a detach time, so this
       * is the honest approximation available from what does exist: the owning
       * row's last update for a volume an agent let go, and creation time for
       * one that was never attached. Null when neither is parseable, rather
       * than a zero that would read as "just now".
       */
      const since = owner ? owner.updated_at : volume.created_at;
      const sinceMs = since === null ? NaN : Date.parse(since);
      return {
        volume_id: volume.volume_id,
        size_gib: volume.size_gib,
        state: volume.state,
        availability_zone: volume.availability_zone,
        created_at: volume.created_at,
        agent: volume.agent,
        managed: volume.managed,
        role_data: volume.role_data,
        group: groupOf(volume, owners, twins !== null),
        attachments: volume.attachments,
        attached,
        attached_to,
        agent_status: owner?.status ?? null,
        owners: owners.live.map((a) => a.name),
        retained_by: owners.live.length === 0 ? (owners.historical[0]?.name ?? null) : null,
        reserved_by: claim?.owner ?? null,
        reserved_until: claim?.expires ?? null,
        free_for_ms: attached || Number.isNaN(sinceMs) ? null : Math.max(0, now - sinceMs),
        snapshots: snaps.length,
        newest_snapshot_at: newest,
        monthly_cost_usd: monthlyCostUsd(volume.size_gib),
        ambiguous_with: twins ?? [],
      };
    });
    return { views, snapshots };
  }

  function summarise(views: readonly VolumeView[], snapshots: number, at: string): VolumeSummary {
    const count = (g: VolumeGroup): number => views.filter((v) => v.group === g).length;
    const gib = (rows: readonly VolumeView[]): number => rows.reduce((n, v) => n + v.size_gib, 0);
    const unattached = views.filter((v) => !v.attached);
    return {
      total: views.length,
      attached: count("attached"),
      detached: count("detached"),
      no_agent: count("no_agent"),
      ambiguous: count("ambiguous"),
      unmanaged: count("unmanaged"),
      total_gib: gib(views),
      unattached_gib: gib(unattached),
      monthly_cost_usd: monthlyCostUsd(gib(views)),
      unattached_monthly_cost_usd: monthlyCostUsd(gib(unattached)),
      snapshots,
      read_at: at,
    };
  }

  /**
   * §9 `volume ls`. The summary is always computed over the *whole* inventory,
   * even when `unattached` narrows the rows: the headline number is what the
   * account holds, and a filter that also shrank the total would hide exactly
   * the thing the view exists to show.
   */
  async function list(input: ListVolumesInput = {}): Promise<VolumeListResult> {
    const parsed = ListVolumesInputSchema.parse(input);
    await guardFleet();
    const at = nowIso();
    const { views, snapshots } = await readAll();
    const summary = summarise(views, snapshots.length, at);
    observeAdvisories(deps.ctx.notifications, ADVISORY_LOOSE_VOLUME, looseVolumeAdvisories(views));
    const rows = parsed.unattached === true ? views.filter((v) => !v.attached) : views;
    return { volumes: rows, summary };
  }

  async function find(volumeId: string): Promise<VolumeView> {
    const { views } = await readAll();
    const found = views.find((v) => v.volume_id === volumeId);
    if (!found) {
      throw new HermeticError("NOT_FOUND", `no volume ${volumeId} in this region`, {
        volume_id: volumeId,
      });
    }
    return found;
  }

  /** §9 `volume status <volume-id>`: one volume, its tags and its snapshots. */
  async function get(input: VolumeRefInput): Promise<VolumeDetailResult> {
    const parsed = VolumeRefInputSchema.parse(input);
    await guardFleet();
    const view = await find(parsed.volume_id);
    const [detail, snapshots] = await Promise.all([
      backend.compute.listVolumes(),
      backend.compute.listSnapshots(DATA_SNAPSHOT_TAG),
    ]);
    const raw = detail.find((v) => v.volume_id === parsed.volume_id);
    return {
      ...view,
      tags: raw?.tags ?? {},
      snapshot_list: snapshots
        .filter((s) => s.volume_id === parsed.volume_id)
        .map((s) => ({ snapshot_id: s.snapshot_id, size_gib: s.size_gib, started_at: s.started_at }))
        .sort((a, b) => (a.started_at < b.started_at ? 1 : -1)),
    };
  }

  /**
   * §9 `volume delete <volume-id> --yes`. One step and a confirmation, the same
   * ceremony `agent destroy --yes` has — not a plan (the whole plan is one
   * line). Snapshots are kept: this deletes a volume, not its history.
   *
   * Four refusals, and each one is a case where deleting would be guessing
   * about somebody's memory (§1): an attached volume belongs to a live box, a
   * volume a live agent row still names belongs to that agent, an ambiguous one
   * cannot be identified at all, and an unmanaged one was never hermetic's.
   */
  /** The four refusals, so they can be asked twice — see `remove`. */
  function assertDeletable(view: VolumeView): void {
    if (!view.managed) {
      throw new HermeticError(
        "VOLUME_UNUSABLE",
        `${view.volume_id} is not managed by hermetic; delete it where it was created`,
        { volume_id: view.volume_id },
      );
    }
    if (view.ambiguous_with.length > 0) {
      throw new HermeticError(
        "CONFLICT",
        `${view.volume_id} and ${view.ambiguous_with.join(", ")} are both tagged agent=${view.agent}; hermetic will not guess which one holds its memory`,
        { volume_id: view.volume_id, ambiguous_with: view.ambiguous_with, agent: view.agent },
      );
    }
    if (view.owners.length > 1) {
      throw new HermeticError(
        "CONFLICT",
        `${view.owners.join(" and ")} both claim ${view.volume_id}; hermetic will not guess whose memory it is (\`hermetic volume status ${view.volume_id}\`)`,
        { volume_id: view.volume_id, owners: view.owners },
      );
    }
    if (view.attached_to !== null) {
      throw new HermeticError("VOLUME_IN_USE", `${view.volume_id} is attached to ${view.attached_to}`, {
        volume_id: view.volume_id,
        instance_id: view.attached_to,
      });
    }
    /**
     * Asked of the owning *rows*, not of the group, which is the distinction
     * that used to be missing. A live agent's disk can be detached for perfectly
     * ordinary reasons — the box is stopped, a recreate is mid-flight — and a
     * grouping that read it as free was one arbitrary scan order away from
     * offering somebody's running agent's memory for deletion.
     */
    const owner = view.owners[0];
    if (owner !== undefined) {
      throw new HermeticError(
        "CONFLICT",
        `agent ${owner} still owns ${view.volume_id}; destroy the agent first (\`hermetic agent destroy ${owner} --yes --delete-volume\`)`,
        { volume_id: view.volume_id, agent: owner, status: view.agent_status },
      );
    }
  }

  async function remove(input: DeleteVolumeInput): Promise<VolumeDeleteResult> {
    const parsed = DeleteVolumeInputSchema.parse(input);
    await guardFleet();
    await assertFleetUnlocked();
    const view = await find(parsed.volume_id);

    if (!parsed.yes) {
      throw new HermeticError(
        "CONFIRMATION_REQUIRED",
        `deleting ${view.volume_id} is irreversible; pass --yes`,
        { volume_id: view.volume_id },
      );
    }
    assertDeletable(view);

    /**
     * §9.1's reservation, held from here to the `DeleteVolume` and released
     * however this ends. The second look below closes the window against
     * everything that writes a *row*; it cannot close it against an adoption,
     * which reads the same world this one did and is on its way to retag a disk
     * this call is about to delete. Both operations reserve the volume id, so
     * one of them is refused while the other is inside — and the refusal names
     * which (`volume-claims.ts`).
     */
    const owner = deletionOwner(randomUUID());
    return await reservation.withClaim(view.volume_id, owner, async () => deleteReserved(view));
  }

  /** The irreversible half of `remove`, run under the reservation. */
  async function deleteReserved(view: VolumeView): Promise<VolumeDeleteResult> {
    /**
     * And again, immediately before the delete. The four refusals above were
     * decided from one snapshot of two systems — EC2's volumes and DynamoDB's
     * rows — and the interesting minute is exactly the one in between: an
     * `agent create --volume` adopting this disk, a `recreate` attaching it, a
     * row claiming it. `DeleteVolume` is not reversible and a snapshot is not
     * the volume, so the last thing this does before deleting is look again
     * (§4.5). A group that has moved at all is a refusal even when the new
     * group would also permit a delete: something happened here, and the
     * operator asked about the volume they were shown.
     */
    const now = await find(view.volume_id);
    assertDeletable(now);
    if (now.group !== view.group) {
      /**
       * Something moved between the two reads. `assertDeletable` has already
       * had its say about the new state, so this is the narrower question: the
       * operator asked about a volume in one state, and it is in another.
       * `DeleteVolume` is not reversible, so the answer is no — but a refusal
       * an operator cannot act on teaches them to stop reading refusals, so it
       * says which way it moved and whether asking again will work.
       */
      const retryable = now.group === "no_agent";
      throw new HermeticError(
        "CONFLICT",
        `${now.volume_id} changed while it was being deleted (${view.group} → ${now.group}); nothing was deleted — ` +
          (retryable
            ? `nothing is reading it now, so the same \`hermetic volume delete ${now.volume_id} --yes\` will go through`
            : `read \`hermetic volume status ${now.volume_id}\` and decide again`),
        { volume_id: now.volume_id, was: view.group, now: now.group, retryable },
      );
    }

    await backend.compute.deleteVolume(view.volume_id);
    return {
      volume_id: view.volume_id,
      size_gib: view.size_gib,
      agent: view.agent,
      snapshots_kept: view.snapshots,
      monthly_saving_usd: view.monthly_cost_usd,
    };
  }

  return { list, get, delete: remove };
}
