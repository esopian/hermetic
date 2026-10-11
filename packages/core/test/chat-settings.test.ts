/**
 * §9.2's chat settings as stored: one `prefs` row on this laptop, read as the
 * default when absent or unreadable, and kept across a reopen of the home.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREF_CHAT_REDACT, SqliteChatSettingsStore, openMemoryDb } from "../src/local/db/index.ts";
import { openHermetic } from "../src/open.ts";

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("no row is the default, and redaction defaults off", () => {
  const store = new SqliteChatSettingsStore(openMemoryDb().db);
  expect(store.settings()).toEqual({ redact: false });
});

test("a write is one prefs row, and an empty patch writes nothing", () => {
  const { db } = openMemoryDb();
  const store = new SqliteChatSettingsStore(db);
  expect(store.setSettings({ redact: true })).toEqual({ redact: true });
  const row = db.query(`SELECT value FROM prefs WHERE key = ?`).get(PREF_CHAT_REDACT);
  expect(row).toEqual({ value: "true" });
  expect(store.setSettings({})).toEqual({ redact: true });
  expect(store.setSettings({ redact: false })).toEqual({ redact: false });
});

test("a value this build cannot read is the default", () => {
  const { db } = openMemoryDb();
  db.run(`INSERT INTO prefs (key, value) VALUES (?, ?)`, [PREF_CHAT_REDACT, "sometimes"]);
  expect(new SqliteChatSettingsStore(db).settings()).toEqual({ redact: false });
});

test("the switch survives a reopen of the same home", async () => {
  const home = mkdtempSync(join(tmpdir(), "hermetic-chat-settings-"));
  homes.push(home);
  const first = await openHermetic({ fixture: true, home });
  await first.chat.settings({ redact: true });
  const second = await openHermetic({ fixture: true, home });
  expect(await second.chat.settings({})).toEqual({ redact: true });
});
