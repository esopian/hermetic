import type { Database } from "bun:sqlite";
import { chatSeenSubject } from "../../chat/notifications.ts";
import type { IncarnationStore } from "../incarnations.ts";

/**
 * `agent_incarnations`: the `created_at` of the agent row each name's local
 * state was gathered against (`local/incarnations.ts`). Same file as the inbox
 * and the chat tables it guards, so the CLI and the portal agree on it — and,
 * because both may reconcile at once, the reconciler's writes are
 * compare-and-set (`claim`, `forgetIf`): each is one statement, so SQLite makes
 * the compare and the write atomic across connections and processes.
 */
export class SqliteIncarnationStore implements IncarnationStore {
  constructor(private readonly db: Database) {}

  list(fleet: string): Map<string, string> {
    const rows = this.db
      .query(`SELECT name, created_at FROM agent_incarnations WHERE fleet = ?`)
      .all(fleet) as Array<{ name: string; created_at: string }>;
    return new Map(rows.map((row) => [row.name, row.created_at]));
  }

  get(fleet: string, name: string): string | undefined {
    const row = this.db
      .query(`SELECT created_at FROM agent_incarnations WHERE fleet = ? AND name = ?`)
      .get(fleet, name) as { created_at: string } | null;
    return row?.created_at;
  }

  claim(fleet: string, name: string, expected: string | undefined, next: string): boolean {
    if (expected === undefined) {
      return (
        this.db.run(
          `INSERT INTO agent_incarnations (fleet, name, created_at) VALUES (?, ?, ?)
             ON CONFLICT (fleet, name) DO NOTHING`,
          [fleet, name, next],
        ).changes > 0
      );
    }
    return (
      this.db.run(
        `UPDATE agent_incarnations SET created_at = ?
           WHERE fleet = ? AND name = ? AND created_at = ?`,
        [next, fleet, name, expected],
      ).changes > 0
    );
  }

  forgetIf(fleet: string, name: string, expected: string): boolean {
    return (
      this.db.run(`DELETE FROM agent_incarnations WHERE fleet = ? AND name = ? AND created_at = ?`, [
        fleet,
        name,
        expected,
      ]).changes > 0
    );
  }

  forget(fleet: string, name: string): void {
    this.db.run(`DELETE FROM agent_incarnations WHERE fleet = ? AND name = ?`, [fleet, name]);
  }

  /**
   * The earliest stamp on what `purgeLocalAgent` would drop for the name and
   * can date: the health and chat watermarks (`agent_status_seen.seen_at`,
   * the chat ones by the same `chat:<name>/` prefix the purge uses), the
   * sessions this laptop opened (`chat_local_sessions.at`) and its open
   * notifications (`notifications.at`). Each is a row's last write, not its
   * first, so a piece rewritten since reads as newer than it is: this can miss
   * stale state, never invent it, and any piece last written before a
   * predecessor's release is that predecessor's. Left out: the listening opt-in (no date), the turn fence
   * (an expiry, and minutes long), and the mute, whose key has no fleet in it
   * and so cannot be pinned to this fleet's name.
   */
  oldestStateAt(fleet: string, name: string): string | undefined {
    const chatPrefix = chatSeenSubject(name, "");
    const row = this.db
      .query(
        `SELECT MIN(at) AS at FROM (
           SELECT seen_at AS at FROM agent_status_seen
            WHERE fleet = ? AND (agent = ? OR substr(agent, 1, ?) = ?)
           UNION ALL
           SELECT at FROM chat_local_sessions WHERE fleet = ? AND instance = ?
           UNION ALL
           SELECT at FROM notifications WHERE fleet = ? AND agent = ? AND resolved_at IS NULL
         )`,
      )
      .get(fleet, name, chatPrefix.length, chatPrefix, fleet, name, fleet, name) as {
      at: string | null;
    } | null;
    return row?.at ?? undefined;
  }
}
