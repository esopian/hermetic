/**
 * An inbox that lives only in this process (§4.9). Tests and any `Hermetic`
 * built without a local database get one, for the reason `MemoryRunStore`
 * exists (§4.6): losing the log costs the log, never the fleet.
 *
 * It must answer every question exactly as `SqliteNotificationStore` does —
 * views, counts, scoping, the sweep — because the tests that pin the inbox's
 * semantics run against both.
 */
import { hiddenByListening } from "../shared/notifications.ts";
import { DEFAULT_NOTIFICATION_SETTINGS, agentMuteTarget, sourceMuteTarget } from "../schema/index.ts";
import type {
  Notification,
  NotificationMute,
  NotificationSettings,
  NotificationView,
  NotificationsListInput,
} from "../schema/index.ts";
import {
  DEFAULT_NOTIFICATION_VIEW,
  autoClearCutoff,
  mintNotificationId,
  retentionCutoff,
} from "./notification-store.ts";
import type {
  NotificationAckWrite,
  NotificationClearWrite,
  NotificationCounts,
  NotificationInsert,
  NotificationStore,
} from "./notification-store.ts";

/** The three view predicates, in the same words the SQL store spells them. */
function inView(row: Notification, view: NotificationView, now: string): boolean {
  const snoozed = row.snoozed_until != null && row.snoozed_until > now;
  switch (view) {
    case "inbox":
      return row.cleared_at == null && !snoozed;
    case "snoozed":
      return row.cleared_at == null && snoozed;
    case "history":
      return row.cleared_at != null || row.resolved_at != null;
    case "all":
      return true;
  }
}

export class MemoryNotificationStore implements NotificationStore {
  private readonly rows: Notification[] = [];
  private readonly muted = new Map<string, string>();
  private readonly seen = new Map<string, string>();
  /** `restored_at` by row id: internal to the sweep, not a `Notification` field. */
  private readonly restored = new Map<string, string>();
  private current: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS };

  constructor(private readonly now: () => Date = () => new Date()) {}

  private muteOf(row: Pick<Notification, "agent" | "source">): boolean {
    if (row.agent != null && this.muted.has(agentMuteTarget(row.agent))) return true;
    return this.muted.has(sourceMuteTarget(row.source));
  }

  private out(row: Notification): Notification {
    return { ...row, muted: this.muteOf(row) };
  }

  /** The auto-clear sweep; see `NotificationStore`. */
  private sweep(): void {
    const now = this.now();
    const cutoff = autoClearCutoff(this.current.auto_clear_read, now);
    const resolvedRule = this.current.clear_resolved_on_read;
    const at = now.toISOString();
    for (const row of this.rows) {
      if (row.cleared_at != null || row.read_at == null) continue;
      const restoredAt = this.restored.get(row.id);
      // A restore resets the age clock, and holds off the resolved-on-read rule
      // until the row is read again after it.
      const since = restoredAt !== undefined && restoredAt > row.read_at ? restoredAt : row.read_at;
      const stale = cutoff !== null && since < cutoff;
      const readSinceRestore = restoredAt === undefined || row.read_at > restoredAt;
      const settled = resolvedRule && row.resolved_at != null && readSinceRestore;
      if (stale || settled) row.cleared_at = at;
    }
  }

  insert(row: NotificationInsert): Notification {
    if (row.key != null) {
      const open = this.rows.find((r) => r.key === row.key && r.resolved_at == null);
      if (open) return this.out(open);
    }
    const id = row.id ?? mintNotificationId();
    const existing = this.rows.find((r) => r.id === id);
    if (existing) return this.out(existing);
    const created: Notification = {
      id,
      at: row.at ?? this.now().toISOString(),
      source: row.source,
      kind: row.kind,
      class: row.class,
      title: row.title,
      detail: row.detail ?? null,
      agent: row.agent ?? null,
      fleet_id: row.fleet ?? null,
      ref: row.ref ?? null,
      key: row.key ?? null,
      actions: row.actions ?? [],
      read_at: row.read_at ?? null,
      resolved_at: null,
      cleared_at: null,
      snoozed_until: null,
      muted: false,
    };
    this.rows.push(created);
    const cutoff = retentionCutoff(this.now());
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      const row = this.rows[i] as Notification;
      if (row.at < cutoff) {
        this.rows.splice(i, 1);
        this.restored.delete(row.id);
      }
    }
    this.sweep();
    return this.out(created);
  }

  /** The fleet scope: that fleet's rows plus fleetless ones, or all rows with no fleet. */
  private forFleet(fleet: string | null): Notification[] {
    return this.rows.filter((r) => r.fleet_id == null || fleet === null || r.fleet_id === fleet);
  }

  private visible(fleet: string | null, instances?: readonly string[]): Notification[] {
    return this.forFleet(fleet).filter((r) => !hiddenByListening(r, instances));
  }

  /** The named rows, held to the fleet scope. */
  private named(ids: readonly string[], fleet: string | null): Notification[] {
    const wanted = new Set(ids);
    return this.forFleet(fleet).filter((r) => wanted.has(r.id));
  }

  list(
    input: NotificationsListInput,
    fleet: string | null,
    instances?: readonly string[],
  ): Notification[] {
    this.sweep();
    const now = this.now().toISOString();
    const view = input.view ?? DEFAULT_NOTIFICATION_VIEW;
    return this.visible(fleet, instances)
      .filter((r) => inView(r, view, now))
      .filter((r) => (input.unread === true ? r.read_at == null : true))
      .filter((r) => (input.since === undefined ? true : r.at > input.since))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, input.limit)
      .map((r) => this.out(r));
  }

  /**
   * The badge is about what still holds and is still in front of the
   * operator. A resolved advisory is still *in* the inbox — the list returns
   * it, and `read_at` stays the operator's own acknowledgement (§4.9) rather
   * than something the world sets for them — but a condition that has cleared
   * must stop asking for attention, and so must a row the operator cleared or
   * snoozed.
   */
  counts(fleet: string | null, instances?: readonly string[]): NotificationCounts {
    const now = this.now().toISOString();
    const rows = this.visible(fleet, instances);
    const unread = rows.filter(
      (r) => inView(r, "inbox", now) && r.read_at == null && r.resolved_at == null,
    );
    const snoozed = rows.filter((r) => inView(r, "snoozed", now));
    const next = snoozed
      .map((r) => r.snoozed_until as string)
      .reduce<string | null>((min, at) => (min === null || at < min ? at : min), null);
    return {
      unread: unread.length,
      needs_action: unread.filter((r) => r.class === "needs_action").length,
      snoozed: snoozed.length,
      history: rows.filter((r) => inView(r, "history", now)).length,
      next_snooze_at: next,
    };
  }

  ack(input: NotificationAckWrite, fleet: string | null): number {
    const at = this.now().toISOString();
    let moved: number;
    if (input.all === true) {
      const target = this.forFleet(fleet).filter((r) => r.read_at == null);
      for (const row of target) row.read_at = at;
      moved = target.length;
    } else {
      const ids = input.ids ?? (input.id === undefined ? [] : [input.id]);
      const unread = input.unread === true;
      const target = this.named(ids, fleet).filter((r) =>
        unread ? r.read_at != null : r.read_at == null,
      );
      for (const row of target) row.read_at = unread ? null : at;
      moved = target.length;
    }
    this.sweep();
    return moved;
  }

  clear(input: NotificationClearWrite, fleet: string | null, instances?: readonly string[]): number {
    const at = this.now().toISOString();
    if (input.restore === true) {
      const target = this.named(input.ids ?? [], fleet).filter(
        (r) => r.cleared_at != null || r.snoozed_until != null,
      );
      for (const row of target) {
        row.cleared_at = null;
        row.snoozed_until = null;
        this.restored.set(row.id, at);
      }
      return target.length;
    }
    let target: Notification[];
    if (input.ids !== undefined) {
      target = this.named(input.ids, fleet).filter((r) => r.cleared_at == null);
    } else {
      target = this.visible(fleet, instances)
        .filter((r) => inView(r, "inbox", at))
        .filter((r) => (input.read === true ? r.read_at != null : r.resolved_at != null));
    }
    for (const row of target) {
      row.cleared_at = at;
      if (row.read_at == null) row.read_at = at;
    }
    return target.length;
  }

  snooze(input: { ids: readonly string[]; until: string | null }, fleet: string | null): number {
    const target = this.named(input.ids, fleet).filter((r) =>
      input.until === null ? r.snoozed_until != null : r.cleared_at == null,
    );
    for (const row of target) row.snoozed_until = input.until;
    return target.length;
  }

  settings(): NotificationSettings {
    return { ...this.current };
  }

  setSettings(patch: Partial<NotificationSettings>): NotificationSettings {
    this.current = { ...this.current, ...patch };
    return this.settings();
  }

  mute(target: string): void {
    if (!this.muted.has(target)) this.muted.set(target, this.now().toISOString());
  }

  unmute(target: string): void {
    this.muted.delete(target);
  }

  mutes(): NotificationMute[] {
    return [...this.muted.entries()]
      .map(([target, at]) => ({ target, at }))
      .sort((a, b) => (a.target < b.target ? -1 : 1));
  }

  openKeys(prefix: string, fleet: string | null): string[] {
    const owned = (key: string): boolean => key === prefix || key.startsWith(`${prefix}:`);
    const keys = new Set<string>();
    for (const row of this.forFleet(fleet)) {
      if (row.key == null || row.resolved_at != null) continue;
      if (owned(row.key)) keys.add(row.key);
    }
    return [...keys];
  }

  resolve(key: string): void {
    const at = this.now().toISOString();
    for (const row of this.rows) {
      if (row.key === key && row.resolved_at == null) row.resolved_at = at;
    }
    this.sweep();
  }

  private seenKey(fleet: string | null, agent: string): string {
    return `${fleet ?? ""} ${agent}`;
  }

  seenStatus(fleet: string | null, agent: string): string | null {
    return this.seen.get(this.seenKey(fleet, agent)) ?? null;
  }

  setSeenStatus(fleet: string | null, agent: string, status: string): void {
    this.seen.set(this.seenKey(fleet, agent), status);
  }

  forgetSeen(fleet: string | null, agent: string): void {
    this.seen.delete(this.seenKey(fleet, agent));
  }
}
