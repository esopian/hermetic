/**
 * The local quiet-hours window: when this phone's own connections raise no
 * alerts. Mirrors `packages/ui/src/logic/notification-logic.ts`
 * (`inQuietHours`). Pure.
 */
export interface QuietHours {
  enabled: boolean;
  /** `HH:MM`, local time. */
  start: string;
  end: string;
}

export function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Equal ends mean off, never "all day". A window may cross midnight. */
export function inQuietHours(now: Date, q: QuietHours): boolean {
  if (!q.enabled) return false;
  const start = minutesOf(q.start);
  const end = minutesOf(q.end);
  if (start === null || end === null || start === end) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return start < end ? m >= start && m < end : m >= start || m < end;
}
