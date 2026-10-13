/**
 * The inbox's presentation rules: runs of rows about one conversation fold
 * into one card, a folded card is unread if any member is, badge tones, and
 * the local quiet-hours window.
 *
 * Mirrors `packages/ui/src/logic/notification-logic.ts` (`conversationKeyOf`,
 * `groupNotifications`, `groupRow`, `badgeTone`, `inQuietHours`). Pure.
 */
import type { Notification } from "../protocol/types.ts";
import { chatThreadOf, isUnreadRow } from "./notifications-store.ts";

export function conversationKeyOf(n: { kind: string; ref?: string | null }): string | null {
  const thread = chatThreadOf(n);
  return thread === null ? null : `${n.kind}:${thread.instance}/${thread.bot}`;
}

export interface NotificationGroup<T> {
  /** The conversation key and the run's oldest row id, or the lone row's id. */
  key: string;
  rows: T[];
  latest: T;
  count: number;
}

/** Fold *consecutive* rows about one conversation into one card. */
export function groupNotifications<
  T extends { id: string; at: string; kind: string; ref?: string | null },
>(list: readonly T[], keyOf: (n: T) => string | null = conversationKeyOf): NotificationGroup<T>[] {
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

/** The row a card draws: the latest one, unread if *any* member is. */
export function groupRow<T extends { read_at?: string | null }>(group: NotificationGroup<T>): T {
  if (group.count === 1) return group.latest;
  if (!group.latest.read_at) return group.latest;
  return group.rows.some((r) => !r.read_at) ? { ...group.latest, read_at: null } : group.latest;
}

/**
 * Whether a card carries the unread marker: any member counts as unread by
 * `isUnreadRow`, the same rule as the header's count. `groupRow` is the
 * desktop's display row and keys on `read_at` alone; the marker does not.
 */
export function groupUnread<T extends { read_at?: string | null; resolved_at?: string | null }>(
  group: NotificationGroup<T>,
): boolean {
  return group.rows.some(isUnreadRow);
}

/**
 * A folded card's condition, read across every member so it agrees with the
 * unread marker and the header's counts: it is cleared only when *every*
 * member is resolved, and it needs the operator when *any* member is an
 * unresolved `needs_action`. Phone-only: the desktop card draws the latest
 * row's state (`groupRow`), which can say "cleared" while an older member
 * still counts as needing you in the header.
 */
export function groupCondition<T extends { class: string; resolved_at?: string | null }>(
  group: NotificationGroup<T>,
): { resolved: boolean; needs: boolean } {
  return {
    resolved: group.rows.every((r) => !!r.resolved_at),
    needs: group.rows.some((r) => r.class === "needs_action" && !r.resolved_at),
  };
}

/** Rows a "mark read" should acknowledge: everything not yet read, resolved or not. */
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

/** Where tapping a row goes: its conversation, an agent's browser, or nowhere. */
export function rowDestination(
  row: Pick<Notification, "kind" | "ref" | "agent" | "actions">,
): { kind: "chat"; instance: string; bot: string } | { kind: "agent"; name: string } | null {
  const thread = chatThreadOf(row);
  if (thread) return { kind: "chat", ...thread };
  const chatAction = row.actions.find((a) => a.target === "chat" && a.ref);
  if (chatAction?.ref) {
    const t = chatThreadOf({ kind: "chat.message", ref: chatAction.ref });
    if (t) return { kind: "chat", ...t };
  }
  if (row.agent) return { kind: "agent", name: row.agent };
  const agentAction = row.actions.find((a) => a.target === "agent" && a.ref);
  if (agentAction?.ref) return { kind: "agent", name: agentAction.ref };
  return null;
}
