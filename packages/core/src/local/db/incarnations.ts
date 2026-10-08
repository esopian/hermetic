import type { Database } from "bun:sqlite";
import type { IncarnationStore } from "../incarnations.ts";

/**
 * `agent_incarnations`: the `created_at` of the agent row each name's local
 * state was gathered against (`local/incarnations.ts`). Same file as the inbox
 * and the chat tables it guards, so the CLI and the portal agree on it.
 */
export class SqliteIncarnationStore implements IncarnationStore {
  constructor(private readonly db: Database) {}

  list(fleet: string): Map<string, string> {
    const rows = this.db
      .query(`SELECT name, created_at FROM agent_incarnations WHERE fleet = ?`)
      .all(fleet) as Array<{ name: string; created_at: string }>;
    return new Map(rows.map((row) => [row.name, row.created_at]));
  }

  set(fleet: string, name: string, createdAt: string): void {
    this.db.run(
      `INSERT INTO agent_incarnations (fleet, name, created_at) VALUES (?, ?, ?)
         ON CONFLICT (fleet, name) DO UPDATE SET created_at = excluded.created_at`,
      [fleet, name, createdAt],
    );
  }

  forget(fleet: string, name: string): void {
    this.db.run(`DELETE FROM agent_incarnations WHERE fleet = ? AND name = ?`, [fleet, name]);
  }
}
