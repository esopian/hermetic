import { z } from "zod";
import { AgentStatus } from "./agent.ts";

/**
 * The volume surface (§9): what `volume ls` / `volume status` answer with, and
 * what `agent create --volume` names.
 *
 * Volumes are the one hermetic resource that outlives the row that made it —
 * `destroy` keeps the data volume by default (§6.6) — so a volume is addressed
 * by its EBS id and never by an agent name. The name is what got lost.
 */

/**
 * An EBS volume id. Deliberately wider than AWS's own 17 hex digits: the
 * fixture backend mints readable ids (`vol-fixture00000000001`) and a schema
 * that rejected them would make fixture mode a different surface from the real
 * one, which is exactly what fixture mode exists to avoid.
 */
export const VOLUME_ID_RE = /^vol-[0-9a-z]{6,40}$/;
export const VolumeId = z.string().regex(VOLUME_ID_RE, "an EBS volume id, e.g. vol-0c85d3b7f1a94e620");
export type VolumeId = z.infer<typeof VolumeId>;

/**
 * The partition key a volume reservation is stored under in the agents table
 * (§4.2, §9.1) — `_volume:vol-0c85…`, beside the reserved `_fleet` item.
 *
 * A leading underscore is what makes it safe: §6.1 forbids it in an agent name,
 * so a reserved key can never collide with one, and the read path skips every
 * `_`-prefixed row rather than trying to parse it as an agent.
 */
export const VOLUME_CLAIM_PREFIX = "_volume:";

/** The reserved row key for a volume id, and the id back out of one. */
export function volumeClaimKey(volumeId: string): string {
  return `${VOLUME_CLAIM_PREFIX}${volumeId}`;
}

export function volumeIdOfClaimKey(key: string): string | null {
  return key.startsWith(VOLUME_CLAIM_PREFIX) ? key.slice(VOLUME_CLAIM_PREFIX.length) : null;
}

/**
 * Is this row key one of the reserved ones — `_fleet`, a volume reservation, or
 * anything a later build reserves the same way? Rows named like this share the
 * agents table with agents and are never agents (§4.2).
 */
export function isReservedRowKey(name: unknown): boolean {
  return typeof name === "string" && name.startsWith("_");
}

/**
 * Which of five groups a volume falls into. This is the whole product: the
 * question a volume list answers is not "what disks exist" but "which memory
 * has nobody reading it, and what is that costing".
 *
 * - `attached` — an instance is reading it. The agent owns it; nothing to do.
 * - `detached` — free, but a live agent row still names it. That is an agent
 *   problem (a stalled recreate), reported on the agent, not an orphan.
 * - `no_agent` — free, and no live row names it: the agent was destroyed and
 *   kept its volume, or the row is gone entirely. The reclaimable case.
 * - `ambiguous` — two managed volumes carry the same `agent` tag and neither
 *   (or both) carries `hermetic:role=data`. `findVolumeByTag` refuses this
 *   exact shape (§1) and so does the list: showing a first match as though it
 *   were the answer is the trap that rule exists to close. Ambiguous wins over
 *   every other grouping, including `attached`.
 * - `unmanaged` — no `hermetic:managed` tag. hermetic did not create it, will
 *   not attach it and will not delete it; it is listed because it bills.
 */
export const VolumeGroup = z.enum(["attached", "detached", "no_agent", "ambiguous", "unmanaged"]);
export type VolumeGroup = z.infer<typeof VolumeGroup>;

export const VolumeAttachmentView = z.object({
  instance_id: z.string(),
  /** `attaching` | `attached` | `detaching` | `detached`. */
  state: z.string(),
});
export type VolumeAttachmentView = z.infer<typeof VolumeAttachmentView>;

export const VolumeView = z.object({
  volume_id: VolumeId,
  size_gib: z.number(),
  /** EC2's own `State`, verbatim: `available` | `in-use` | `creating` | … */
  state: z.string(),
  availability_zone: z.string().nullable(),
  created_at: z.string().nullable(),
  /** The `agent=<name>` tag, or null on a volume carrying none. */
  agent: z.string().nullable(),
  /** Carries `hermetic:managed=true`. */
  managed: z.boolean(),
  /** Carries `hermetic:role=data` — the label that settles an ambiguous pair. */
  role_data: z.boolean(),
  group: VolumeGroup,
  attachments: z.array(VolumeAttachmentView),
  /**
   * Is anything reading it. Not the same question as `attached_to !== null`:
   * EC2 can report `in-use` without naming the instance, and reading that as
   * unattached is the one mistake with a bad blast radius here — it is what
   * decides whether a volume is offered for deletion.
   */
  attached: z.boolean(),
  /** The instance reading it, when EC2 names one. */
  attached_to: z.string().nullable(),
  /**
   * The agent row that owns this volume, and its status — a DynamoDB fact,
   * joined here because the group depends on it and neither head may compute a
   * join core can (§3.1). The *live* owner's status when there is one, and
   * otherwise the destroyed row's, which is what `no_agent` means.
   */
  agent_status: AgentStatus.nullable(),
  /**
   * The live agent rows claiming this volume (§9.1). Ownership is a row fact
   * and rows are kept forever, so a disk can be named by a destroyed row *and*
   * by the live agent that reclaimed it; only the live ones are owners. More
   * than one is `ambiguous` — hermetic will not guess whose memory it is.
   */
  owners: z.array(z.string()),
  /**
   * When no live row owns it: the destroyed agent whose memory it is (§6.6).
   * Display only — a destroyed row is not an owner, and this volume is
   * reclaimable — but "retained by cinder" is what makes `no_agent` legible.
   */
  retained_by: z.string().nullable(),
  /**
   * The holder of a live §9.1 reservation, while an adoption or a delete is
   * mid-flight on this id; `null` when nobody is acting on it.
   */
  reserved_by: z.string().nullable(),
  /** When that reservation expires, if it is not released first. */
  reserved_until: z.string().nullable(),
  /** How long it has been free, in ms, when EC2 reports no attachment. */
  free_for_ms: z.number().nullable(),
  snapshots: z.number().int(),
  newest_snapshot_at: z.string().nullable(),
  /** gp3 list price × size. An estimate, like the create drawer's `≈ $196/mo`. */
  monthly_cost_usd: z.number(),
  /** `ambiguous` only: the other volumes carrying the same `agent` tag. */
  ambiguous_with: z.array(VolumeId),
});
export type VolumeView = z.infer<typeof VolumeView>;

export const VolumeSummary = z.object({
  total: z.number().int(),
  attached: z.number().int(),
  detached: z.number().int(),
  no_agent: z.number().int(),
  ambiguous: z.number().int(),
  unmanaged: z.number().int(),
  total_gib: z.number(),
  /** GiB nothing is reading — the headline number of the Volumes view. */
  unattached_gib: z.number(),
  monthly_cost_usd: z.number(),
  unattached_monthly_cost_usd: z.number(),
  snapshots: z.number().int(),
  read_at: z.string(),
});
export type VolumeSummary = z.infer<typeof VolumeSummary>;

export const VolumeListResult = z.object({
  volumes: z.array(VolumeView),
  summary: VolumeSummary,
});
export type VolumeListResult = z.infer<typeof VolumeListResult>;

/** `volume status <id>`: one volume, its snapshots and its tags. */
export const VolumeDetailResult = VolumeView.extend({
  tags: z.record(z.string(), z.string()),
  snapshot_list: z.array(
    z.object({
      snapshot_id: z.string(),
      size_gib: z.number(),
      started_at: z.string(),
    }),
  ),
});
export type VolumeDetailResult = z.infer<typeof VolumeDetailResult>;

/** What `volume delete` did, once it did it. */
export const VolumeDeleteResult = z.object({
  volume_id: VolumeId,
  size_gib: z.number(),
  agent: z.string().nullable(),
  /** Snapshots are kept: deleting a volume is not deleting its history (§1). */
  snapshots_kept: z.number().int(),
  monthly_saving_usd: z.number(),
});
export type VolumeDeleteResult = z.infer<typeof VolumeDeleteResult>;

/**
 * gp3 list price, USD per GiB-month. One number, one place, quoted as an
 * estimate everywhere it surfaces — hermetic makes no Cost Explorer call and
 * the bill is whatever AWS says it is.
 */
export const GP3_USD_PER_GIB_MONTH = 0.08;

export function monthlyCostUsd(sizeGib: number): number {
  return Math.round(sizeGib * GP3_USD_PER_GIB_MONTH * 100) / 100;
}
