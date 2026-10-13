/**
 * The inbox's presentation rules: runs of entries about one conversation fold
 * into one card, a folded card is unread if any member is, badge tones, and
 * the local quiet-hours window.
 *
 * Mirrors `packages/ui/src/logic/notification-logic.ts` (`groupNotifications`,
 * `groupRow`, `badgeTone`, `inQuietHours`), over the phone's own entries
 * (`src/inbox/store.ts`) rather than the laptop's notification rows. Pure.
 */
import type { InboxEntry } from "../inbox/store.ts";

/** Entries of one kind about one conversation fold together. */
export function conversationKeyOf(e: Pick<InboxEntry, "kind" | "instance" | "bot">): string {
  return `${e.kind}:${e.instance}/${e.bot}`;
}

export interface NotificationGroup<T> {
  /** The conversation key and the run's oldest entry id. */
  key: string;
  rows: T[];
  latest: T;
  count: number;
}

/** Fold *consecutive* entries about one conversation into one card. */
export function groupNotifications<T extends { id: string; at: string }>(
  list: readonly T[],
  keyOf: (n: T) => string | null,
): NotificationGroup<T>[] {
  const groups: NotificationGroup<T>[] = [];
  let runKey: string | null = null;
  for (const row of list) {
    const key = keyOf(row);
    const last = groups[groups.length - 1];
    if (key !== null && key === runKey && last) {
      last.rows.push(row);
      last.count += 1;
      last.key = `${key}@${row.id}`;
      if (Date.parse(row.at) > Date.parse(last.latest.at)) last.latest = row;
      continue;
    }
    runKey = key;
    groups.push({
      key: key === null ? row.id : `${key}@${row.id}`,
      rows: [row],
      latest: row,
      count: 1,
    });
  }
  return groups;
}

/** The phone's inbox, grouped. */
export function groupEntries(list: readonly InboxEntry[]): NotificationGroup<InboxEntry>[] {
  return groupNotifications(list, conversationKeyOf);
}

/** The row a card draws: the latest one, unread if *any* member is. */
export function groupRow<T extends { read_at?: string | null }>(group: NotificationGroup<T>): T {
  if (group.count === 1) return group.latest;
  if (!group.latest.read_at) return group.latest;
  return group.rows.some((r) => !r.read_at) ? { ...group.latest, read_at: null } : group.latest;
}

/** Whether a card carries the unread marker: any member unread. */
export function groupUnread<T extends { read_at?: string | null }>(
  group: NotificationGroup<T>,
): boolean {
  return group.rows.some((r) => !r.read_at);
}

/** Whether a card is about the operator being needed, and whether that is unread. */
export function groupCondition(group: NotificationGroup<InboxEntry>): {
  needs: boolean;
  needsUnread: boolean;
} {
  const needs = group.rows.filter((r) => r.kind === "needs_action");
  return { needs: needs.length > 0, needsUnread: needs.some((r) => !r.read_at) };
}

/** Entries a "mark read" should acknowledge. */
export function unackedIds<T extends { id: string; read_at?: string | null }>(
  rows: readonly T[],
): string[] {
  return rows.filter((r) => !r.read_at).map((r) => r.id);
}

export type BadgeTone = "quiet" | "unread" | "needs_action";

/** Gold (needs you) outranks orange (unread) at every level. */
export function badgeTone(unread: number, needsAction: number): BadgeTone {
  if (needsAction > 0) return "needs_action";
  if (unread > 0) return "unread";
  return "quiet";
}

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

/** Where tapping an entry goes: its conversation (and session). */
export function rowDestination(entry: Pick<InboxEntry, "instance" | "bot" | "session">): {
  kind: "chat";
  instance: string;
  bot: string;
  session: string;
} {
  return { kind: "chat", instance: entry.instance, bot: entry.bot, session: entry.session };
}
