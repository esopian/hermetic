import type { Database } from "bun:sqlite";
import { NOTIFICATION_RETENTION_DAYS } from "../../chat/notifications.ts";
import type { InstanceListeningStore } from "../../chat/instance-listening.ts";
import type { LocalChatSessions } from "../../chat/chat.ts";
import type { ChatFenceRow, ChatFenceStore } from "../../chat/chat-fence.ts";

/**
 * Which conversations this laptop started (§9.2).
 *
 * The argument for it being *here*, and only here, is in `LocalChatSessions`
 * and in the `chat-local-sessions` migration above: the box genuinely cannot
 * tell a session hermetic opened from one its own TUI opened, so `portal` can
 * only ever be granted on this laptop's own evidence. Two operators watching one
 * fleet therefore get different answers, and that is right — the reply your
 * colleague is about to send really is going into a conversation they did not
 * open.
 *
 * Keyed on `(fleet, session)` rather than on the session alone, because two
 * fleets can hold sessions whose ids collide and because dropping a fleet
 * should be able to drop its rows.
 */
export class SqliteLocalChatSessions implements LocalChatSessions {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Retention is the inbox's, for the inbox's reason: sessions on a box outlive
   * rows on a laptop, and a table nobody ever deletes from is a table that grows
   * for the life of the installation. Enforced on write rather than by a sweep,
   * so a laptop that is not chatting spends nothing.
   *
   * A pruned row means a thread the operator did open a month ago starts
   * warning again. That is the right way round: the memory expiring makes the
   * portal *more* cautious, never less.
   */
  remember(
    fleet: string | null,
    where: { instance: string; bot: string; session: string },
    at: string,
  ): void {
    this.db.run(
      `INSERT INTO chat_local_sessions (fleet, instance, bot, session, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (fleet, session) DO UPDATE SET at = excluded.at,
                                                    instance = excluded.instance,
                                                    bot = excluded.bot`,
      [fleet ?? "", where.instance, where.bot, where.session, at],
    );
    const cutoff = new Date(
      this.now().getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000,
    ).toISOString();
    this.db.run(`DELETE FROM chat_local_sessions WHERE at < ?`, [cutoff]);
  }

  mine(fleet: string | null, sessions: readonly string[]): Set<string> {
    const found = new Set<string>();
    if (sessions.length === 0) return found;
    // One statement, bound rather than interpolated: a session id is a string
    // the *box* chose, and it is the last thing that should reach SQL as text.
    const holes = sessions.map(() => "?").join(",");
    const rows = this.db
      .query(`SELECT session FROM chat_local_sessions WHERE fleet = ? AND session IN (${holes})`)
      .all(fleet ?? "", ...sessions) as { session: string }[];
    for (const row of rows) found.add(row.session);
    return found;
  }

  forgetInstance(fleet: string | null, instance: string): void {
    this.db.run(`DELETE FROM chat_local_sessions WHERE fleet = ? AND instance = ?`, [
      fleet ?? "",
      instance,
    ]);
  }
}

/**
 * The cross-process half of `chat-fence.ts`, in the file the CLI and the portal
 * already share.
 *
 * Expiry is not enforced here. A lapsed row is simply a row `chatFenced` reads
 * and ignores, and it is overwritten by the next turn against that bot — so
 * there is no sweep to get wrong, and a fence whose holder died leaves one row
 * of at most a few dozen bytes.
 */
export class SqliteChatFenceStore implements ChatFenceStore {
  constructor(private readonly db: Database) {}

  read(fleet: string | null, instance: string, bot: string): ChatFenceRow | null {
    const row = this.db
      .query(
        `SELECT owner, expires_at FROM chat_turn_fence WHERE fleet = ? AND instance = ? AND bot = ?`,
      )
      .get(fleet ?? "", instance, bot) as ChatFenceRow | null;
    return row ?? null;
  }

  write(fleet: string | null, instance: string, bot: string, row: ChatFenceRow): void {
    this.db.run(
      `INSERT INTO chat_turn_fence (fleet, instance, bot, owner, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (fleet, instance, bot) DO UPDATE SET owner = excluded.owner,
                                                          expires_at = excluded.expires_at`,
      [fleet ?? "", instance, bot, row.owner, row.expires_at],
    );
  }

  renew(
    fleet: string | null,
    instance: string,
    bot: string,
    owner: string,
    expiresAt: string,
  ): boolean {
    this.db.run(
      `UPDATE chat_turn_fence SET expires_at = ?
         WHERE fleet = ? AND instance = ? AND bot = ? AND owner = ?`,
      [expiresAt, fleet ?? "", instance, bot, owner],
    );
    // `changes` is per-connection and read straight after the statement, so it
    // is this update's count and not another process's.
    return (this.db.query(`SELECT changes() AS n`).get() as { n: number }).n > 0;
  }

  clear(fleet: string | null, instance: string, bot: string, owner: string): void {
    this.db.run(
      `DELETE FROM chat_turn_fence WHERE fleet = ? AND instance = ? AND bot = ? AND owner = ?`,
      [fleet ?? "", instance, bot, owner],
    );
  }

  forgetInstance(fleet: string | null, instance: string): void {
    this.db.run(`DELETE FROM chat_turn_fence WHERE fleet = ? AND instance = ?`, [
      fleet ?? "",
      instance,
    ]);
  }
}

/** An empty table means this laptop monitors no instances. */
export class SqliteInstanceListeningStore implements InstanceListeningStore {
  constructor(private readonly db: Database) {}

  list(fleet: string | null): string[] {
    const rows = this.db
      .query(`SELECT instance FROM instance_listening WHERE fleet = ? ORDER BY instance`)
      .all(fleet ?? "") as { instance: string }[];
    return rows.map((row) => row.instance);
  }

  set(fleet: string | null, instance: string, listening: boolean): void {
    if (listening) {
      this.db.run(`INSERT OR IGNORE INTO instance_listening (fleet, instance) VALUES (?, ?)`, [
        fleet ?? "",
        instance,
      ]);
    } else {
      this.db.run(`DELETE FROM instance_listening WHERE fleet = ? AND instance = ?`, [
        fleet ?? "",
        instance,
      ]);
    }
  }
}
