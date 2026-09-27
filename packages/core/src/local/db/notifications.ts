import type { Database } from "bun:sqlite";
import type { Notification, NotificationMute, NotificationsListInput } from "../../schema/index.ts";
import {
  Notification as NotificationSchema,
  agentMuteTarget,
  sourceMuteTarget,
} from "../../schema/index.ts";
import {
  MemoryNotificationStore,
  NOTIFICATION_RETENTION_DAYS,
  mintNotificationId,
  notifyOpSettled,
} from "../../chat/notifications.ts";
import type { NotificationInsert, NotificationStore } from "../../chat/notifications.ts";
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
    const cutoff = new Date(
      this.now().getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000,
    ).toISOString();
    this.db.run(`DELETE FROM notifications WHERE at < ?`, [cutoff]);
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

  list(
    input: NotificationsListInput,
    fleet: string | null,
    instances?: readonly string[],
  ): Notification[] {
    const muted = this.muteSet();
    const scope = this.listeningScope(fleet, instances);
    const clauses = [scope.where];
    const params: Array<string | number> = [...scope.params];
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
   * The badge is about what still holds, which is why `resolved_at IS NULL` is
   * in here and not in `list`: a cleared condition stays in the inbox and stops
   * asking for attention. `read_at` is deliberately left alone — it is the
   * operator's acknowledgement and `resolved_at` is the world's (§4.9), and a
   * resolve that also marked a row read would lose the difference.
   */
  counts(
    fleet: string | null,
    instances?: readonly string[],
  ): { unread: number; needs_action: number } {
    const scope = this.listeningScope(fleet, instances);
    const row = this.db
      .query(
        `SELECT COUNT(*) AS unread,
                SUM(CASE WHEN class = 'needs_action' THEN 1 ELSE 0 END) AS needs_action
           FROM notifications
          WHERE ${scope.where} AND read_at IS NULL AND resolved_at IS NULL`,
      )
      .get(...scope.params) as { unread: number; needs_action: number | null } | null;
    return { unread: row?.unread ?? 0, needs_action: row?.needs_action ?? 0 };
  }

  ack(input: { id?: string; all?: boolean }, fleet: string | null): number {
    const at = this.now().toISOString();
    if (input.all === true) {
      const scope = this.scope(fleet);
      this.db.run(`UPDATE notifications SET read_at = ? WHERE ${scope.where} AND read_at IS NULL`, [
        at,
        ...scope.params,
      ]);
    } else {
      if (input.id === undefined) return 0;
      this.db.run(`UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`, [
        at,
        input.id,
      ]);
    }
    // `changes` is not portable across the two drivers this file runs under, so
    // the count comes from the rows that now carry exactly this timestamp.
    const row = this.db.query(`SELECT COUNT(*) AS n FROM notifications WHERE read_at = ?`).get(at) as {
      n: number;
    } | null;
    return row?.n ?? 0;
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
