import { z } from "zod";
import {
  SNAPSHOT_INTERVAL_HOURS,
  SNAPSHOT_RETAIN_MAX,
  SNAPSHOT_RETAIN_MIN,
  isSnapshotInterval,
} from "../shared/snapshots.ts";
import type { SnapshotIntervalHours } from "../shared/snapshots.ts";
export {
  DEFAULT_SNAPSHOT_POLICY,
  SNAPSHOT_INTERVAL_HOURS,
  SNAPSHOT_PARAMS,
  SNAPSHOT_POLICY_FOUNDATION_VERSION,
  SNAPSHOT_RETAIN_MAX,
  SNAPSHOT_RETAIN_MIN,
  describeSnapshotPolicy,
  isSnapshotInterval,
  sameSnapshotPolicy,
  snapshotParameterValues,
  snapshotPolicyOf,
  snapshotWindowDays,
} from "../shared/snapshots.ts";
export type { SnapshotIntervalHours, SnapshotPolicy } from "../shared/snapshots.ts";

/**
 * The data-volume snapshot policy (§7.1) as the wire carries it. The plain
 * values and the stack-parameter reader live in `shared/snapshots.ts`.
 */
export const SnapshotInterval = z
  .number()
  .int()
  .refine((n): n is SnapshotIntervalHours => isSnapshotInterval(n), {
    message: `an interval is one of ${SNAPSHOT_INTERVAL_HOURS.join(", ")} hours`,
  });

export const SnapshotPolicySchema = z.object({
  enabled: z.boolean(),
  retain: z.number().int().min(SNAPSHOT_RETAIN_MIN).max(SNAPSHOT_RETAIN_MAX),
  interval_hours: SnapshotInterval,
});

/**
 * `snapshots.status`: the policy the stack runs, and what the fleet is paying
 * to keep.
 *
 * `policy` is `null` on a foundation from before the policy was configurable;
 * that fleet runs the default policy and `plan.snapshots` refuses until
 * `foundation update` brings it onto a template with the parameters.
 */
export const SnapshotsReport = z.object({
  policy: SnapshotPolicySchema.nullable(),
  /** The fleet's data-volume snapshots that exist now, whatever made them. */
  existing: z.object({
    count: z.number().int().nonnegative(),
    /** The sum of the snapshots' volume sizes: an upper bound, since EBS bills changed blocks only. */
    volume_gib: z.number().nonnegative(),
  }),
});
export type SnapshotsReport = z.infer<typeof SnapshotsReport>;

/** `snapshots status`: takes nothing. */
export const SnapshotsStatusInput = z.object({}).partial();
export type SnapshotsStatusInput = z.infer<typeof SnapshotsStatusInput>;

/**
 * `plan snapshots`: a patch over the stack's current policy. Each stated field
 * replaces its value; an omitted one keeps what the stack says. At least one
 * must be stated.
 */
export const PlanSnapshotsInput = z
  .object({
    enabled: z.boolean().optional(),
    retain: z.number().int().min(SNAPSHOT_RETAIN_MIN).max(SNAPSHOT_RETAIN_MAX).optional(),
    interval_hours: SnapshotInterval.optional(),
  })
  .refine((v) => v.enabled !== undefined || v.retain !== undefined || v.interval_hours !== undefined, {
    message: "name at least one of enabled, retain or interval_hours",
  });
export type PlanSnapshotsInput = z.infer<typeof PlanSnapshotsInput>;
