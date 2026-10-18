import type { Database } from "bun:sqlite";
import type { DevtoolsSettingsStore } from "../../chat/devtools.ts";
import { DEFAULT_DEVTOOLS_SETTINGS, DevtoolsCapture, DevtoolsKeep } from "../../schema/index.ts";
import type { DevtoolsSettings } from "../../schema/index.ts";

/** The `prefs` rows the developer tools' preferences live in (§9.2). */
export const PREF_DEVTOOLS_ENABLED = "devtools.enabled";
export const PREF_DEVTOOLS_CAPTURE = "devtools.capture";
export const PREF_DEVTOOLS_KEEP = "devtools.keep";

/**
 * This laptop's developer-tools preferences, one `prefs` row each. A value
 * another build wrote that this one cannot read is the default, the bargain
 * `SqliteChatSettingsStore` makes.
 */
export class SqliteDevtoolsSettingsStore implements DevtoolsSettingsStore {
  constructor(private readonly db: Database) {}

  settings(): DevtoolsSettings {
    const enabled = this.read(PREF_DEVTOOLS_ENABLED);
    const capture = DevtoolsCapture.safeParse(this.read(PREF_DEVTOOLS_CAPTURE));
    const keep = DevtoolsKeep.safeParse(Number(this.read(PREF_DEVTOOLS_KEEP)));
    return {
      enabled:
        enabled === "true" ? true : enabled === "false" ? false : DEFAULT_DEVTOOLS_SETTINGS.enabled,
      capture: capture.success ? capture.data : DEFAULT_DEVTOOLS_SETTINGS.capture,
      keep: keep.success ? keep.data : DEFAULT_DEVTOOLS_SETTINGS.keep,
    };
  }

  setSettings(patch: Partial<DevtoolsSettings>): DevtoolsSettings {
    if (patch.enabled !== undefined) this.write(PREF_DEVTOOLS_ENABLED, String(patch.enabled));
    if (patch.capture !== undefined) this.write(PREF_DEVTOOLS_CAPTURE, patch.capture);
    if (patch.keep !== undefined) this.write(PREF_DEVTOOLS_KEEP, String(patch.keep));
    return this.settings();
  }

  private read(key: string): string | null {
    const row = this.db.query(`SELECT value FROM prefs WHERE key = ?`).get(key) as {
      value: string;
    } | null;
    return row?.value ?? null;
  }

  private write(key: string, value: string): void {
    this.db.run(
      `INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }
}
