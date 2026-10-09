import type { Database } from "bun:sqlite";
import type {
  Notification,
  NotificationMute,
  NotificationSettings,
  NotificationView,
  NotificationsListInput,
} from "../../schema/index.ts";
import {
  AutoClearRead as AutoClearReadSchema,
  DEFAULT_NOTIFICATION_SETTINGS,
  Notification as NotificationSchema,
  agentMuteTarget,
  sourceMuteTarget,
} from "../../schema/index.ts";
import {
  MemoryNotificationStore,
  mintNotificationId,
  notifyOpSettled,
} from "../../chat/notifications.ts";
import type {
  NotificationAckWrite,
  NotificationClearWrite,
  NotificationCounts,
  NotificationInsert,
  NotificationStore,
} from "../../chat/notifications.ts";
import {
  DEFAULT_NOTIFICATION_VIEW,
  autoClearCutoff,
  retentionCutoff,
} from "../../chat/notification-store.ts";
import { INSTANCE_NOTIFICATION_SOURCES } from "../../shared/notifications.ts";
import { openLocalDb, type DbFileOptions } from "./index.ts";

/**
 * The operator's inbox, in the same file as `runs` (§4.9). Local, not
 * fleet state: two laptops watching one fleet keep separate inboxes, and muting
 * `atlas` here silences nothing for anybody else.
 *
 * `muted` is computed on the way out rather than stored, because a mute applies
 * to every row its target has ever raised — a stored copy would be right only
 * until the next `inbox mute`.
 */
/**
 * A literal for the left of a `LIKE ... ESCAPE '\'`. SQLite's `_` matches any
 * one character and `%` any run of them, and every advisory family name
 * (`loose_volume`, `bedrock_grant`, …) contains an underscore — so a prefix
 * used raw would match keys that merely look like it.
 */
function escapeLike(literal: string): string {
  return literal.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The two mute targets a row can match, read off a row core has already validated. */
function isMuted(row: Pick<Notification, "agent" | "source">, muted: Set<string>): boolean {
  if (row.agent != null && muted.has(agentMuteTarget(row.agent))) return true;
  return muted.has(sourceMuteTarget(row.source));
}

/** The two `prefs` rows the auto-clear settings live in (§4.9). */
export const PREF_INBOX_AUTO_CLEAR_READ = "notifications.auto_clear_read";
export const PREF_INBOX_CLEAR_RESOLVED_ON_READ = "notifications.clear_resolved_on_read";

type Clause = { where: string; params: string[] };

/**
 * A view as SQL, with `now` bound as a parameter so a snooze lapses the moment
 * the clock passes it and nothing has to move the row. The same three
 * predicates as `inView` in `notification-memory-store.ts`.
 */
function viewClause(view: NotificationView, now: string): Clause {
  switch (view) {
    case "inbox":
      return {
        where: `(cleared_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?))`,
        params: [now],
      };
    case "snoozed":
      return { where: `(cleared_at IS NULL AND snoozed_until > ?)`, params: [now] };
    case "history":
      return { where: `(cleared_at IS NOT NULL OR resolved_at IS NOT NULL)`, params: [] };
    case "all":
      return { where: `1 = 1`, params: [] };
  }
}

/** `?, ?, ?` for a list of ids. The schema caps a batch at 500, well under SQLite's limit. */
function placeholders(ids: readonly string[]): string {
  return ids.map(() => "?").join(",");
}

export class SqliteNotificationStore implements NotificationStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The mute targets, as a set, so a list of 100 rows is one query and not 100. */
  private muteSet(): Set<string> {
    const rows = this.db.query(`SELECT target FROM notification_mutes`).all() as Array<{
      target: string;
    }>;
    return new Set(rows.map((r) => r.target));
  }

  private toNotification(row: NotificationRow, muted: Set<string>): Notification | null {
    let actions: unknown = [];
    try {
      actions = JSON.parse(row.actions);
    } catch {
      // A row whose actions this build cannot read is still worth showing; it
      // just shows without buttons.
      actions = [];
    }
    const parsed = NotificationSchema.safeParse({
      id: row.id,
      at: row.at,
      source: row.source,
      kind: row.kind,
      class: row.class,
      title: row.title,
      detail: row.detail,
      agent: row.agent,
      fleet_id: row.fleet,
      ref: row.ref,
      key: row.key,
      actions,
      read_at: row.read_at,
      resolved_at: row.resolved_at,
      cleared_at: row.cleared_at ?? null,
      snoozed_until: row.snoozed_until ?? null,
      muted: false,
    });
    // Same bargain as `teardowns`: a row written by another build is skipped,
    // never fatal. The point of the table is that it keeps working.
    if (!parsed.success) return null;
    // Derived after parsing, so the mute target is built from a validated
    // source rather than from whatever string the column happened to hold.
    return { ...parsed.data, muted: isMuted(parsed.data, muted) };
  }

  insert(row: NotificationInsert): Notification {
    const muted = this.muteSet();
    if (row.key != null) {
      const open = this.db
        .query(`SELECT * FROM notifications WHERE key = ? AND resolved_at IS NULL`)
        .get(row.key) as NotificationRow | null;
      const existing = open === null ? null : this.toNotification(open, muted);
      // The condition still holds and already has a row: that row *is* the
      // notification, and raising a second one would be the scan shouting.
      if (existing) return existing;
    }
    const id = row.id ?? mintNotificationId();
    const at = row.at ?? this.now().toISOString();
    this.db.run(
      `INSERT INTO notifications
         (id, at, source, kind, class, title, detail, agent, fleet, ref, key, actions, read_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO NOTHING`,
      [
        id,
        at,
        row.source,
        row.kind,
        row.class,
        row.title,
        row.detail ?? null,
        row.agent ?? null,
        row.fleet ?? null,
        row.ref ?? null,
        row.key ?? null,
        JSON.stringify(row.actions ?? []),
        row.read_at ?? null,
      ],
    );
    // §4.9: retention is enforced on write, so an inbox nobody opens for a
    // year is still bounded without a sweeper anywhere.
    this.db.run(`DELETE FROM notifications WHERE at < ?`, [retentionCutoff(this.now())]);
    this.sweep();
    const stored = this.db
      .query(`SELECT * FROM notifications WHERE id = ?`)
      .get(id) as NotificationRow | null;
    const result = stored === null ? null : this.toNotification(stored, muted);
    if (result) return result;
    // Retention deleted the row as it was written: the caller still gets the
    // notification it asked for, there is just nothing durable behind it.
    const written = {
      id,
      at,
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
    return { ...written, muted: isMuted(written, muted) };
  }

  /**
   * The active fleet's rows plus the rows that name no fleet (§4.9). Opened
   * without a fleet — before `init`, or on a home with no default — every row
   * is in scope, because there is nothing to scope it to.
   */
  private scope(fleet: string | null): { where: string; params: string[] } {
    return fleet === null
      ? { where: `1 = 1`, params: [] }
      : { where: `(fleet IS NULL OR fleet = ?)`, params: [fleet] };
  }

  private listeningScope(
    fleet: string | null,
    instances?: readonly string[],
  ): { where: string; params: string[] } {
    const scope = this.scope(fleet);
    if (instances === undefined) return scope;
    // Only instance sources are scoped by listening (`hiddenByListening`).
    const sources = INSTANCE_NOTIFICATION_SOURCES.map(() => "?").join(",");
    const watched =
      instances.length === 0
        ? `(agent IS NULL OR source NOT IN (${sources}))`
        : `(agent IS NULL OR source NOT IN (${sources}) OR agent IN (${instances.map(() => "?").join(",")}))`;
    return {
      where: `${scope.where} AND ${watched}`,
      params: [...scope.params, ...INSTANCE_NOTIFICATION_SOURCES, ...instances],
    };
  }

  /** The fleet scope plus the named ids — what an id-addressed write may touch. */
  private namedScope(ids: readonly string[], fleet: string | null): Clause {
    const scope = this.scope(fleet);
    return {
      where: `${scope.where} AND id IN (${placeholders(ids)})`,
      params: [...scope.params, ...ids],
    };
  }

  /** One `UPDATE … RETURNING id`, so a batch is one statement and the count is exact. */
  private update(sql: string, params: string[]): number {
    return this.db.query(`${sql} RETURNING id`).all(...params).length;
  }

  private readPref(key: string): string | null {
    try {
      const row = this.db.query(`SELECT value FROM prefs WHERE key = ?`).get(key) as {
        value: string;
      } | null;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private writePref(key: string, value: string): void {
    this.db.run(
      `INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  /**
   * A value another build wrote that this one cannot read falls back to the
   * default, the same bargain `toNotification` makes with a row.
   */
  settings(): NotificationSettings {
    const auto = AutoClearReadSchema.safeParse(this.readPref(PREF_INBOX_AUTO_CLEAR_READ));
    const resolved = this.readPref(PREF_INBOX_CLEAR_RESOLVED_ON_READ);
    return {
      auto_clear_read: auto.success ? auto.data : DEFAULT_NOTIFICATION_SETTINGS.auto_clear_read,
      clear_resolved_on_read:
        resolved === "true"
          ? true
          : resolved === "false"
            ? false
            : DEFAULT_NOTIFICATION_SETTINGS.clear_resolved_on_read,
    };
  }

  setSettings(patch: Partial<NotificationSettings>): NotificationSettings {
    if (patch.auto_clear_read !== undefined) {
      this.writePref(PREF_INBOX_AUTO_CLEAR_READ, patch.auto_clear_read);
    }
    if (patch.clear_resolved_on_read !== undefined) {
      this.writePref(PREF_INBOX_CLEAR_RESOLVED_ON_READ, String(patch.clear_resolved_on_read));
    }
    return this.settings();
  }

  /**
   * The auto-clear sweep (§4.9): one idempotent `UPDATE` over every fleet's
   * rows, because the rule is this laptop's and not any one fleet's. Only read
   * rows qualify, so a cleared row is always a read one. A restore
   * (`restored_at`) resets the age clock, and holds off the resolved-on-read
   * rule until the row is read again after it; without that, the next list
   * would clear a restored row straight back into History.
   */
  private sweep(): void {
    const settings = this.settings();
    const now = this.now();
    const rules: string[] = [];
    const params: string[] = [now.toISOString()];
    const cutoff = autoClearCutoff(settings.auto_clear_read, now);
    if (cutoff !== null) {
      rules.push(`MAX(read_at, COALESCE(restored_at, read_at)) < ?`);
      params.push(cutoff);
    }
    if (settings.clear_resolved_on_read) {
      rules.push(`(resolved_at IS NOT NULL AND (restored_at IS NULL OR read_at > restored_at))`);
    }
    if (rules.length === 0) return;
    this.db.run(
      `UPDATE notifications SET cleared_at = ?
        WHERE cleared_at IS NULL AND read_at IS NOT NULL AND (${rules.join(" OR ")})`,
      params,
    );
  }

  list(
    input: NotificationsListInput,
    fleet: string | null,
    instances?: readonly string[],
  ): Notification[] {
    this.sweep();
    const muted = this.muteSet();
    const scope = this.listeningScope(fleet, instances);
    const view = viewClause(input.view ?? DEFAULT_NOTIFICATION_VIEW, this.now().toISOString());
    const clauses = [scope.where, view.where];
    const params: Array<string | number> = [...scope.params, ...view.params];
    if (input.unread === true) clauses.push(`read_at IS NULL`);
    if (input.since !== undefined) {
      clauses.push(`at > ?`);
      params.push(input.since);
    }
    params.push(input.limit);
    const rows = this.db
      .query(
        `SELECT * FROM notifications WHERE ${clauses.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as NotificationRow[];
    return rows.flatMap((row) => {
      const parsed = this.toNotification(row, muted);
      return parsed === null ? [] : [parsed];
    });
  }

  /**
   * The badge is about what still holds and is still in front of the
   * operator, which is why `resolved_at IS NULL` is in here and not in `list`:
   * a resolved condition stays in the inbox and stops asking for attention. A
   * cleared or actively snoozed row has left the inbox, so it leaves the
   * counts with it. `read_at` is deliberately left alone by a resolve — it is
   * the operator's acknowledgement and `resolved_at` is the world's (§4.9), and
   * a resolve that also marked a row read would lose the difference.
   */
  counts(fleet: string | null, instances?: readonly string[]): NotificationCounts {
    const scope = this.listeningScope(fleet, instances);
    const now = this.now().toISOString();
    const inbox = viewClause("inbox", now);
    const snoozed = viewClause("snoozed", now);
    const history = viewClause("history", now);
    const unread = `${inbox.where} AND read_at IS NULL AND resolved_at IS NULL`;
    const row = this.db
      .query(
        `SELECT SUM(CASE WHEN ${unread} THEN 1 ELSE 0 END) AS unread,
                SUM(CASE WHEN ${unread} AND class = 'needs_action' THEN 1 ELSE 0 END) AS needs_action,
                SUM(CASE WHEN ${snoozed.where} THEN 1 ELSE 0 END) AS snoozed,
                SUM(CASE WHEN ${history.where} THEN 1 ELSE 0 END) AS history,
                MIN(CASE WHEN ${snoozed.where} THEN snoozed_until END) AS next_snooze_at
           FROM notifications
          WHERE ${scope.where}`,
      )
      .get(
        ...inbox.params,
        ...inbox.params,
        ...snoozed.params,
        ...history.params,
        ...snoozed.params,
        ...scope.params,
      ) as {
      unread: number | null;
      needs_action: number | null;
      snoozed: number | null;
      history: number | null;
      next_snooze_at: string | null;
    } | null;
    return {
      unread: row?.unread ?? 0,
      needs_action: row?.needs_action ?? 0,
      snoozed: row?.snoozed ?? 0,
      history: row?.history ?? 0,
      next_snooze_at: row?.next_snooze_at ?? null,
    };
  }

  ack(input: NotificationAckWrite, fleet: string | null): number {
    const at = this.now().toISOString();
    let moved: number;
    if (input.all === true) {
      const scope = this.scope(fleet);
      moved = this.update(
        `UPDATE notifications SET read_at = ? WHERE ${scope.where} AND read_at IS NULL`,
        [at, ...scope.params],
      );
    } else {
      const ids = input.ids ?? (input.id === undefined ? [] : [input.id]);
      if (ids.length === 0) return 0;
      const named = this.namedScope(ids, fleet);
      moved =
        input.unread === true
          ? this.update(
              `UPDATE notifications SET read_at = NULL WHERE ${named.where} AND read_at IS NOT NULL`,
              named.params,
            )
          : this.update(
              `UPDATE notifications SET read_at = ? WHERE ${named.where} AND read_at IS NULL`,
              [at, ...named.params],
            );
    }
    this.sweep();
    return moved;
  }

  clear(input: NotificationClearWrite, fleet: string | null, instances?: readonly string[]): number {
    const at = this.now().toISOString();
    if (input.restore === true) {
      const ids = input.ids ?? [];
      if (ids.length === 0) return 0;
      const named = this.namedScope(ids, fleet);
      return this.update(
        `UPDATE notifications SET cleared_at = NULL, snoozed_until = NULL, restored_at = ?
          WHERE ${named.where} AND (cleared_at IS NOT NULL OR snoozed_until IS NOT NULL)`,
        [at, ...named.params],
      );
    }
    let target: Clause;
    if (input.ids !== undefined) {
      const named = this.namedScope(input.ids, fleet);
      target = { where: `${named.where} AND cleared_at IS NULL`, params: named.params };
    } else {
      const scope = this.listeningScope(fleet, instances);
      const inbox = viewClause("inbox", at);
      const which = input.read === true ? `read_at IS NOT NULL` : `resolved_at IS NOT NULL`;
      target = {
        where: `${scope.where} AND ${inbox.where} AND ${which}`,
        params: [...scope.params, ...inbox.params],
      };
    }
    return this.update(
      `UPDATE notifications SET cleared_at = ?, read_at = COALESCE(read_at, ?) WHERE ${target.where}`,
      [at, at, ...target.params],
    );
  }

  snooze(input: { ids: readonly string[]; until: string | null }, fleet: string | null): number {
    if (input.ids.length === 0) return 0;
    const named = this.namedScope(input.ids, fleet);
    return input.until === null
      ? this.update(
          `UPDATE notifications SET snoozed_until = NULL
            WHERE ${named.where} AND snoozed_until IS NOT NULL`,
          named.params,
        )
      : this.update(
          `UPDATE notifications SET snoozed_until = ? WHERE ${named.where} AND cleared_at IS NULL`,
          [input.until, ...named.params],
        );
  }

  mute(target: string): void {
    this.db.run(
      `INSERT INTO notification_mutes (target, at) VALUES (?, ?) ON CONFLICT(target) DO NOTHING`,
      [target, this.now().toISOString()],
    );
  }

  unmute(target: string): void {
    this.db.run(`DELETE FROM notification_mutes WHERE target = ?`, [target]);
  }

  mutes(): NotificationMute[] {
    return this.db
      .query(`SELECT target, at FROM notification_mutes ORDER BY target`)
      .all() as NotificationMute[];
  }

  /**
   * Unbounded by design (see `NotificationStore.openKeys`): the whole point of
   * the read is that a reconciliation can close a condition the newest rows
   * have buried. Ownership is the exact key or the key plus `:`, which is why
   * the `LIKE` carries an `ESCAPE` — `_` is a SQL wildcard and every family
   * name has one in it, so an unescaped `loose_volume:%` would also match
   * `looseXvolume:…`.
   */
  openKeys(prefix: string, fleet: string | null): string[] {
    const scope = this.scope(fleet);
    const rows = this.db
      .query(
        `SELECT DISTINCT key FROM notifications
          WHERE ${scope.where}
            AND resolved_at IS NULL
            AND key IS NOT NULL
            AND (key = ? OR key LIKE ? ESCAPE '\\')`,
      )
      .all(...scope.params, prefix, `${escapeLike(prefix)}:%`) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }

  resolve(key: string): void {
    this.db.run(`UPDATE notifications SET resolved_at = ? WHERE key = ? AND resolved_at IS NULL`, [
      this.now().toISOString(),
      key,
    ]);
    this.sweep();
  }

  /**
   * `agent_status_seen.fleet` is NOT NULL, so a home with no fleet chosen keys
   * on the empty string: one laptop, one pre-fleet slot, and no row that could
   * collide with a real `fleet_id`.
   */
  seenStatus(fleet: string | null, agent: string): string | null {
    const row = this.db
      .query(`SELECT status FROM agent_status_seen WHERE fleet = ? AND agent = ?`)
      .get(fleet ?? "", agent) as { status: string } | null;
    return row?.status ?? null;
  }

  setSeenStatus(fleet: string | null, agent: string, status: string): void {
    this.db.run(
      `INSERT INTO agent_status_seen (fleet, agent, status, seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(fleet, agent) DO UPDATE SET status = excluded.status, seen_at = excluded.seen_at`,
      [fleet ?? "", agent, status, this.now().toISOString()],
    );
  }

  forgetSeen(fleet: string | null, agent: string): void {
    this.db.run(`DELETE FROM agent_status_seen WHERE fleet = ? AND agent = ?`, [fleet ?? "", agent]);
  }
}

interface NotificationRow {
  id: string;
  at: string;
  source: string;
  kind: string;
  class: string;
  title: string;
  detail: string | null;
  agent: string | null;
  fleet: string | null;
  ref: string | null;
  key: string | null;
  actions: string;
  read_at: string | null;
  resolved_at: string | null;
  /** Absent on a database that has not run `notifications-cleared-snoozed` yet. */
  cleared_at?: string | null;
  snoozed_until?: string | null;
}

/**
 * The inbox however it can be had — same contract as `openRunStore`: reading or
 * writing a notification must never be what fails a command, so an unopenable
 * home degrades to an in-process inbox (§4.6).
 */
export function openNotificationStore(
  home?: string,
  opts: DbFileOptions = {},
): { notifications: NotificationStore; close(): void } {
  try {
    const local = openLocalDb({
      ...(home !== undefined ? { home } : {}),
      ...opts,
      renameCorrupt: false,
    });
    return { notifications: new SqliteNotificationStore(local.db), close: () => local.close() };
  } catch {
    return { notifications: new MemoryNotificationStore(), close: () => {} };
  }
}

/**
 * The `operation.*` source (§4.9). Called from `RunRecorder.finish`
 * with the run already updated, so the row it reads back carries the fleet the
 * command ran against and core never has to be told twice.
 *
 * A run id with no row is a head finishing something it never started; there is
 * nothing to notify about and nothing to complain to.
 */
export function notifySettledRun(
  db: Database,
  id: string,
  op: { method: string; error?: { code: string; message: string } },
): void {
  const run = db
    .query(`SELECT id, command, agent, started_at, fleet FROM runs WHERE id = ?`)
    .get(id) as {
    id: string;
    command: string;
    agent: string | null;
    started_at: string;
    fleet: string | null;
  } | null;
  if (run === null) return;
  notifyOpSettled(
    new SqliteNotificationStore(db),
    run.fleet,
    { id: run.id, command: run.command, agent: run.agent, started_at: run.started_at },
    op,
  );
}
