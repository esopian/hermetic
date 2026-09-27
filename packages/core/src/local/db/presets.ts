import type { Database } from "bun:sqlite";
import { CREATE_PRESETS_PREF } from "../../shared/presets.ts";
import type { PresetStore } from "../create-presets.ts";

/**
 * The create presets' one `prefs` row (§4.6). The value is the JSON document
 * `create-presets.ts` validates; this class only moves the string, so a row it
 * cannot parse is core's decision, not SQLite's.
 */
export class SqlitePresetStore implements PresetStore {
  constructor(private readonly db: Database) {}

  async read(): Promise<string | null> {
    const row = this.db.query(`SELECT value FROM prefs WHERE key = ?`).get(CREATE_PRESETS_PREF) as {
      value: string;
    } | null;
    return row?.value ?? null;
  }

  async write(value: string | null): Promise<void> {
    if (value === null) {
      this.db.run(`DELETE FROM prefs WHERE key = ?`, [CREATE_PRESETS_PREF]);
      return;
    }
    this.db.run(
      `INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [CREATE_PRESETS_PREF, value],
    );
  }
}
