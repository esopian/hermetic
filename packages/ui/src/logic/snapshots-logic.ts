/**
 * Settings › Foundation › Snapshots (§7.1): the pure part of the policy
 * editor — whether the form is valid and which fields moved — so the drawer
 * and its tests compute one answer.
 */
import { SNAPSHOT_RETAIN_MAX, SNAPSHOT_RETAIN_MIN } from "@hermetic/core/shared";
import type { SnapshotIntervalHours, SnapshotPolicy } from "@hermetic/core/shared";
import type { PlanSnapshotsInput } from "../api/index.ts";

/** The retention counts offered as one-click choices; any count in bounds can be typed. */
export const RETAIN_CHOICES = [1, 3, 7, 14, 30] as const;

export interface SnapshotForm {
  enabled: boolean;
  /** As typed, so a half-typed number is not coerced under the operator's cursor. */
  retain: string;
  interval_hours: SnapshotIntervalHours;
}

export function formOf(p: SnapshotPolicy): SnapshotForm {
  return { enabled: p.enabled, retain: String(p.retain), interval_hours: p.interval_hours };
}

/** Why the form cannot be planned, or `null` when it can. */
export function formIssue(form: SnapshotForm): string | null {
  const n = Number(form.retain);
  if (form.retain.trim() === "" || !Number.isInteger(n)) return "retention is a whole number";
  if (n < SNAPSHOT_RETAIN_MIN || n > SNAPSHOT_RETAIN_MAX) {
    return `retention is ${SNAPSHOT_RETAIN_MIN}–${SNAPSHOT_RETAIN_MAX}`;
  }
  return null;
}

/**
 * Only the fields that moved, so the plan names what the operator changed and
 * keeps the stack's value for the rest. `null` when nothing moved — there is
 * no plan to ask for. Retention and interval are not sent while turning the
 * policy off unless they moved too: they are kept for when it comes back on.
 */
export function patchOf(current: SnapshotPolicy, form: SnapshotForm): PlanSnapshotsInput | null {
  if (formIssue(form) !== null) return null;
  const patch: PlanSnapshotsInput = {};
  if (form.enabled !== current.enabled) patch.enabled = form.enabled;
  const retain = Number(form.retain);
  if (retain !== current.retain) patch.retain = retain;
  if (form.interval_hours !== current.interval_hours) patch.interval_hours = form.interval_hours;
  return Object.keys(patch).length === 0 ? null : patch;
}

export function intervalLabel(h: SnapshotIntervalHours): string {
  return h === 24 ? "daily" : `every ${h} h`;
}
