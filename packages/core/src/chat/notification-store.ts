/**
 * The inbox's store contract (§4.9), and the few pure rules both stores apply
 * the same way: retention, the auto-clear cutoff, and the id minting.
 *
 * Its own module so the two implementations — `SqliteNotificationStore` in
 * `local/db/notifications.ts` and `MemoryNotificationStore` beside this file —
 * can both import it without either importing the sources in
 * `notifications.ts`, which re-exports everything here.
 */
import { randomUUID } from "node:crypto";
import type {
  AutoClearRead,
  Notification,
  NotificationAction,
  NotificationClass,
  NotificationKind,
  NotificationMute,
  NotificationSettings,
  NotificationSource,
  NotificationView,
  NotificationsListInput,
} from "../schema/index.ts";

/** Rows older than this are deleted as a new one is written (§4.9). */
export const NOTIFICATION_RETENTION_DAYS = 30;

export const DAY_MS = 86_400_000;

/** What each `auto_clear_read` setting means in days; `never` has no cutoff. */
const AUTO_CLEAR_DAYS: Record<AutoClearRead, number | null> = {
  never: null,
  "1d": 1,
  "7d": 7,
  "30d": 30,
};

/**
 * The `read_at` before which a read row is auto-cleared, as an ISO string the
 * stores compare against lexically, or null when the setting is `never`.
 */
export function autoClearCutoff(setting: AutoClearRead, now: Date): string | null {
  const days = AUTO_CLEAR_DAYS[setting];
  return days === null ? null : new Date(now.getTime() - days * DAY_MS).toISOString();
}

/** The oldest `at` retention keeps. */
export function retentionCutoff(now: Date): string {
  return new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS).toISOString();
}

/** Short, random, and typed back by an operator exactly once (`inbox ack <id>`). */
export function mintNotificationId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

/**
 * What a source hands the store. `id`, `at` and `read_at` are settable so the
 * fixture seed can write fixed rows twice and get the same inbox both times.
 */
export interface NotificationInsert {
  source: NotificationSource;
  kind: NotificationKind;
  class: NotificationClass;
  title: string;
  detail?: string | null;
  agent?: string | null;
  /** The `fleet_id` the row is about; null for a row about the laptop itself. */
  fleet?: string | null;
  ref?: string | null;
  /** The condition this row reports; unique among unresolved rows. */
  key?: string | null;
  actions?: NotificationAction[];
  id?: string;
  at?: string;
  read_at?: string | null;
}

/** The numbers `notifications.list` reports beside its rows, all in one scope. */
export interface NotificationCounts {
  unread: number;
  needs_action: number;
  snoozed: number;
  history: number;
  next_snooze_at: string | null;
}

/** The store's view of an `ack`: `id` and `ids` both name rows; `all` is every unread row. */
export interface NotificationAckWrite {
  id?: string;
  ids?: readonly string[];
  all?: boolean;
  unread?: boolean;
}

/** The store's view of a `clear`: exactly one of `ids`, `read`, `resolved`. */
export interface NotificationClearWrite {
  ids?: readonly string[];
  read?: boolean;
  resolved?: boolean;
  restore?: boolean;
}

/** Which view a list asks for when it names none. */
export const DEFAULT_NOTIFICATION_VIEW: NotificationView = "inbox";

/**
 * The local notification log. Synchronous, like the SQLite it is backed by:
 * every implementation is a local file or an array, and there is no
 * configuration in which reading the inbox is a network call.
 *
 * **Scope.** Every read and every write takes the fleet this `Hermetic` was
 * opened as: the named fleet's rows plus the rows that name no fleet, or every
 * row when there is no fleet. A write by `id`/`ids` is held to the same scope,
 * so a window on one fleet cannot clear, snooze or ack another fleet's rows by
 * guessing their ids. Listening (`instances`) narrows only what an operator is
 * shown — the views, the counts, and the `read`/`resolved` bulk clears that
 * address "what is on screen".
 *
 * **The auto-clear sweep.** `insert`, `ack`, `resolve` and `list` each run one
 * idempotent `UPDATE` that clears the rows `settings()` says should be gone: a
 * read row older than `auto_clear_read`, and (when `clear_resolved_on_read`) a
 * row both read and resolved. Running it on `list` is what lets an idle inbox
 * converge when a head merely reads it. `clear` and `snooze` do not sweep, so a
 * `clear --restore` is never undone by the call that made it. Nor by the next
 * sweep: a restore stamps an internal `restored_at`, the age rule measures from
 * the later of it and `read_at`, and the resolved rule skips a restored row
 * until it is read again after the restore.
 */
export interface NotificationStore {
  /**
   * Writes a row and returns it. A row carrying a `key` that an unresolved row
   * already holds is **not** written — the existing row is returned instead, so
   * a condition that keeps holding keeps finding the notification it already
   * raised. Enforces retention and sweeps on the way through.
   */
  insert(row: NotificationInsert): Notification;
  /** Newest first, in the requested view (default `inbox`). Sweeps first. */
  list(
    input: NotificationsListInput,
    fleet: string | null,
    instances?: readonly string[],
  ): Notification[];
  /**
   * `unread` and `needs_action` count unread, unresolved rows in the inbox view
   * (so neither cleared nor actively snoozed); `snoozed` and `history` count
   * their views; `next_snooze_at` is the earliest active snooze. All listening
   * scoped.
   */
  counts(fleet: string | null, instances?: readonly string[]): NotificationCounts;
  /**
   * Marks the named rows read (or, with `unread`, unread), or every unread row
   * of this fleet with `all`. One statement per call. Returns how many moved.
   */
  ack(input: NotificationAckWrite, fleet: string | null): number;
  /**
   * Clears the named rows, or every read / every resolved row in the inbox view
   * (listening scoped); `restore` un-clears and un-snoozes named rows instead.
   * Clearing stamps `read_at` on a row that had none. Returns how many moved.
   */
  clear(input: NotificationClearWrite, fleet: string | null, instances?: readonly string[]): number;
  /**
   * Snoozes the named, uncleared rows until `until` (a normalised ISO string),
   * or unsnoozes them when `until` is null. Returns how many moved.
   */
  snooze(input: { ids: readonly string[]; until: string | null }, fleet: string | null): number;
  /** The auto-clear rules, with defaults filled in for anything never set. */
  settings(): NotificationSettings;
  /** Applies a patch and returns the settings that now hold. */
  setSettings(patch: Partial<NotificationSettings>): NotificationSettings;
  mute(target: string): void;
  unmute(target: string): void;
  mutes(): NotificationMute[];
  /**
   * The keys of the unresolved rows this prefix owns, in this fleet's scope and
   * with no row limit — the read `observeAdvisories` reconciles against.
   *
   * Ownership is the rule the key scheme already documents: `prefix` matches a
   * key equal to it, or a key beginning `prefix` + `:`. The separator is
   * required rather than a bare prefix match, so `fleet.advisory:loose_volume`
   * never owns `fleet.advisory:loose_volumes`.
   *
   * Unbounded on purpose. A `list()` window would leave an advisory pushed past
   * it permanently unresolvable, which is exactly the bug the read replaces —
   * and it is bounded in practice anyway, because unresolved rows are one per
   * held condition and the conditions are counted in tens.
   */
  openKeys(prefix: string, fleet: string | null): string[];
  /**
   * Closes the condition `key` names, so a later recurrence raises a new row.
   * A row the operator cleared while the condition held stays cleared: that is
   * what "hidden until it changes" means, and the change is the new row.
   */
  resolve(key: string): void;
  /** The last `display_status` this laptop saw for an agent, or null. */
  seenStatus(fleet: string | null, agent: string): string | null;
  setSeenStatus(fleet: string | null, agent: string, status: string): void;
  forgetSeen(fleet: string | null, agent: string): void;
}
