/**
 * The data-volume snapshot policy (§7.1): how often the fleet's DLM policy
 * snapshots every agent's `/data` volume, how many it keeps, and whether it
 * runs at all.
 *
 * CloudFormation owns the answer. The three values are parameters of the
 * foundation stack (`SnapshotsEnabled`, `SnapshotRetainCount`,
 * `SnapshotIntervalHours`, `aws/cfn-template.ts`), so a fleet's policy is what
 * its stack says and `plan.snapshots` → `apply` is the only thing that moves
 * it. The defaults are the policy every fleet had before the parameters
 * existed — daily, keep 7 — so adding them changed nothing on any fleet.
 *
 * Here, in `shared/`, because the UI draws the controls from the same bounds
 * core validates against. Pure values only (`shared-browser-safe.test.ts`).
 */

/** The foundation version whose template made the policy configurable. */
export const SNAPSHOT_POLICY_FOUNDATION_VERSION = 16;

/** The intervals DLM accepts for `CreateRule.Interval` with `IntervalUnit: HOURS`. */
export const SNAPSHOT_INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
export type SnapshotIntervalHours = (typeof SNAPSHOT_INTERVAL_HOURS)[number];

/** DLM's `RetainRule.Count` bounds. */
export const SNAPSHOT_RETAIN_MIN = 1;
export const SNAPSHOT_RETAIN_MAX = 1000;

export interface SnapshotPolicy {
  enabled: boolean;
  /** Snapshots kept per volume; DLM deletes the oldest past this. */
  retain: number;
  interval_hours: SnapshotIntervalHours;
}

/** What every fleet ran before the policy was configurable, and what a new one starts on. */
export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = { enabled: true, retain: 7, interval_hours: 24 };

/** The stack parameter names, so the template, the backends and the reader spell them once. */
export const SNAPSHOT_PARAMS = {
  enabled: "SnapshotsEnabled",
  retain: "SnapshotRetainCount",
  interval_hours: "SnapshotIntervalHours",
} as const;

export function isSnapshotInterval(n: number): n is SnapshotIntervalHours {
  return (SNAPSHOT_INTERVAL_HOURS as readonly number[]).includes(n);
}

/** A policy as the three stack parameter values CloudFormation is given. */
export function snapshotParameterValues(p: SnapshotPolicy): Record<string, string> {
  return {
    [SNAPSHOT_PARAMS.enabled]: p.enabled ? "true" : "false",
    [SNAPSHOT_PARAMS.retain]: String(p.retain),
    [SNAPSHOT_PARAMS.interval_hours]: String(p.interval_hours),
  };
}

/**
 * The policy a stack's parameters describe, or `null` when the stack carries
 * none of them — a foundation from before they existed, which runs the
 * default policy and cannot be changed until `foundation update` brings it
 * onto a template that has them. A parameter present but unreadable is also
 * `null`: guessing a policy is how a head would show one the fleet is not on.
 */
export function snapshotPolicyOf(parameters: Readonly<Record<string, string>>): SnapshotPolicy | null {
  const enabled = parameters[SNAPSHOT_PARAMS.enabled];
  const retain = Number(parameters[SNAPSHOT_PARAMS.retain]);
  const interval = Number(parameters[SNAPSHOT_PARAMS.interval_hours]);
  if (enabled !== "true" && enabled !== "false") return null;
  if (!Number.isInteger(retain) || retain < SNAPSHOT_RETAIN_MIN || retain > SNAPSHOT_RETAIN_MAX) {
    return null;
  }
  if (!isSnapshotInterval(interval)) return null;
  return { enabled: enabled === "true", retain, interval_hours: interval };
}

export function sameSnapshotPolicy(a: SnapshotPolicy, b: SnapshotPolicy): boolean {
  return a.enabled === b.enabled && a.retain === b.retain && a.interval_hours === b.interval_hours;
}

/** "daily, keep 7" / "every 12 h, keep 3" / "off". */
export function describeSnapshotPolicy(p: SnapshotPolicy): string {
  if (!p.enabled) return "off";
  const every = p.interval_hours === 24 ? "daily" : `every ${p.interval_hours} h`;
  return `${every}, keep ${p.retain}`;
}

/**
 * About how many days back the oldest kept snapshot reaches: the window an
 * operator can restore from.
 */
export function snapshotWindowDays(p: SnapshotPolicy): number {
  return (p.retain * p.interval_hours) / 24;
}
