/**
 * The `terminal` source of the inbox (issue #18): the rows the desktop app's
 * SSH sessions raise, their wording and classes, the one condition a session
 * holds, what viewing and closing a session do to its rows, and the
 * `terminal_alerts` switch. Run against both stores, like the rest of the
 * inbox, because the app writes through SQLite and the tests that pin
 * semantics must hold for both.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryNotificationStore,
  notificationsList,
  notificationsSettings,
} from "../src/chat/notifications.ts";
import type { NotificationDeps, NotificationStore } from "../src/chat/notifications.ts";
import {
  notifyTerminalEvent,
  resolveTerminalSession,
  terminalNotices,
  type TerminalEventInput,
} from "../src/chat/terminal-notifications.ts";
import { migrate } from "../src/local/db/index.ts";
import { SqliteNotificationStore } from "../src/local/db/notifications.ts";
import { isHermeticError } from "../src/errors.ts";
import { openHermetic } from "../src/open.ts";
import type { Notification } from "../src/schema/index.ts";

const FLEET = "fleet001";
const OTHER = "fleet002";
const START = Date.parse("2026-10-10T12:00:00.000Z");

interface Harness {
  store: NotificationStore;
  deps: NotificationDeps;
  rows(): Notification[];
}

function harness(kind: "memory" | "sqlite"): Harness {
  const now = () => new Date(START);
  let store: NotificationStore;
  if (kind === "memory") store = new MemoryNotificationStore(now);
  else {
    const db = new Database(":memory:");
    migrate(db);
    store = new SqliteNotificationStore(db, now);
  }
  // Fleet-less deps: every fleet's rows, so a test can see both.
  const deps: NotificationDeps = { store, fleet: () => null, now };
  return { store, deps, rows: () => store.list({ view: "all", limit: 100 }, null) };
}

function event(over: Partial<TerminalEventInput> = {}): TerminalEventInput {
  return {
    fleet_id: FLEET,
    agent: "atlas",
    session_id: "s1",
    session_index: 1,
    event: "output",
    ...over,
  };
}

for (const kind of ["memory", "sqlite"] as const) {
  describe(`notifyTerminalEvent (${kind})`, () => {
    test("each event reads as the spec words it, in its class", () => {
      const h = harness(kind);
      notifyTerminalEvent(h.store, event({ event: "output" }));
      notifyTerminalEvent(h.store, event({ event: "finished", program: "apt upgrade", exit_code: 0 }));
      notifyTerminalEvent(
        h.store,
        event({ event: "finished", program: "sudo apt install x", exit_code: 100, ran_ms: 461_000 }),
      );
      notifyTerminalEvent(h.store, event({ event: "input" }));
      notifyTerminalEvent(h.store, event({ event: "bell" }));
      notifyTerminalEvent(h.store, event({ event: "disconnected" }));
      const got = h
        .rows()
        .map((r) => ({
          kind: r.kind as string,
          class: r.class as string,
          title: r.title,
          detail: r.detail ?? null,
        }))
        .sort((a, b) => (a.title < b.title ? -1 : 1));
      expect(got).toEqual(
        [
          {
            kind: "terminal.output",
            class: "info",
            title: "atlas · session 1 has new output",
            detail: null,
          },
          {
            kind: "terminal.finished",
            class: "ok",
            title: "atlas · session 1 — apt finished · exit 0",
            detail: null,
          },
          {
            kind: "terminal.finished",
            class: "bad",
            title: "atlas · session 1 — apt failed · exit 100",
            detail: "ran 7m41s",
          },
          {
            kind: "terminal.input",
            class: "needs_action",
            title: "atlas · session 1 may be waiting for input",
            detail: null,
          },
          {
            kind: "terminal.bell",
            class: "warn",
            title: "atlas · session 1 rang the bell",
            detail: null,
          },
          {
            kind: "terminal.disconnected",
            class: "bad",
            title: "atlas · session 1 disconnected",
            detail: null,
          },
        ].sort((a, b) => (a.title < b.title ? -1 : 1)),
      );
    });

    test("every row is the terminal source, about its session, with one action to open it", () => {
      const h = harness(kind);
      notifyTerminalEvent(h.store, event({ session_index: 2, session_id: "abc-123", event: "bell" }));
      const [row] = h.rows();
      expect(row).toMatchObject({
        source: "terminal",
        agent: "atlas",
        fleet_id: FLEET,
        ref: "abc-123",
        key: null,
        title: "atlas · session 2 rang the bell",
        actions: [{ label: "Open session", target: "terminal", ref: "atlas/abc-123" }],
      });
    });

    test("a finished command with no usable program name says `command`, never the line", () => {
      const h = harness(kind);
      notifyTerminalEvent(h.store, event({ event: "finished", program: "TOKEN=x make", exit_code: 2 }));
      notifyTerminalEvent(h.store, event({ event: "finished", program: null }));
      const titles = h.rows().map((r) => r.title);
      expect(titles).toContain("atlas · session 1 — command failed · exit 2");
      // No exit status from the marker: reported, not guessed, in the neutral class.
      expect(titles).toContain("atlas · session 1 — command finished");
      expect(h.rows().find((r) => r.title.endsWith("command finished"))?.class).toBe("info");
    });

    test("output is one condition per session, keyed with the fleet, never duplicated while open", () => {
      const h = harness(kind);
      notifyTerminalEvent(h.store, event());
      notifyTerminalEvent(h.store, event());
      notifyTerminalEvent(h.store, event({ fleet_id: OTHER }));
      notifyTerminalEvent(h.store, event({ session_id: "s2", session_index: 2 }));
      const keys = h
        .rows()
        .map((r) => r.key)
        .sort();
      expect(keys).toEqual([
        `terminal:${FLEET}:s1:output`,
        `terminal:${FLEET}:s2:output`,
        `terminal:${OTHER}:s1:output`,
      ]);
    });

    test("events are not conditions: each bell is its own row", () => {
      const h = harness(kind);
      notifyTerminalEvent(h.store, event({ event: "bell" }));
      notifyTerminalEvent(h.store, event({ event: "bell" }));
      expect(h.rows()).toHaveLength(2);
    });

    test("an input that does not validate writes nothing and does not throw", () => {
      const h = harness(kind);
      notifyTerminalEvent(h.store, event({ session_id: "a:b" }));
      notifyTerminalEvent(h.store, event({ session_index: 0 }));
      notifyTerminalEvent(h.store, event({ agent: "Not A Name" }));
      notifyTerminalEvent(h.store, { ...event(), event: "scrolled" } as unknown as TerminalEventInput);
      expect(h.rows()).toEqual([]);
    });

    test("a store that throws is swallowed", () => {
      const h = harness(kind);
      const broken = {
        ...h.store,
        settings: () => {
          throw new Error("disk gone");
        },
      } as unknown as NotificationStore;
      expect(() => notifyTerminalEvent(broken, event())).not.toThrow();
      expect(() =>
        resolveTerminalSession(broken, { fleet_id: FLEET, session_id: "s1", read: true }),
      ).not.toThrow();
    });
  });

  describe(`resolveTerminalSession (${kind})`, () => {
    test("viewing resolves the output condition and reads every row of that session only", () => {
      const h = harness(kind);
      notifyTerminalEvent(h.store, event());
      notifyTerminalEvent(h.store, event({ event: "bell" }));
      notifyTerminalEvent(h.store, event({ session_id: "s2", session_index: 2, event: "bell" }));
      notifyTerminalEvent(h.store, event({ fleet_id: OTHER, event: "bell" }));
      // Clearing resolved-on-read would sweep the viewed condition into
      // history; keep it in view so the stamps can be read.
      notificationsSettings(h.deps, { clear_resolved_on_read: false });

      resolveTerminalSession(h.store, { fleet_id: FLEET, session_id: "s1", read: true });

      const rows = h.rows();
      const s1 = rows.filter((r) => r.fleet_id === FLEET && r.ref === "s1");
      expect(s1).toHaveLength(2);
      for (const r of s1) expect(r.read_at).not.toBeNull();
      expect(s1.find((r) => r.kind === "terminal.output")?.resolved_at).not.toBeNull();
      // Another session, and the same session id in another fleet, are untouched.
      for (const r of rows.filter((r) => !(r.fleet_id === FLEET && r.ref === "s1"))) {
        expect(r.read_at).toBeNull();
      }
    });

    test("closing resolves the condition and leaves the events unread", () => {
      const h = harness(kind);
      notifyTerminalEvent(h.store, event());
      notifyTerminalEvent(h.store, event({ event: "disconnected" }));
      resolveTerminalSession(h.store, { fleet_id: FLEET, session_id: "s1", read: false });
      const rows = h.rows();
      expect(rows.find((r) => r.kind === "terminal.output")?.resolved_at).not.toBeNull();
      for (const r of rows) expect(r.read_at).toBeNull();
      // Resolved, so the next output is a fresh row rather than the old one.
      notifyTerminalEvent(h.store, event());
      expect(h.rows().filter((r) => r.kind === "terminal.output")).toHaveLength(2);
    });

    test("a resolve viewed with the default settings moves the condition to history", () => {
      const h = harness(kind);
      notifyTerminalEvent(h.store, event());
      resolveTerminalSession(h.store, { fleet_id: FLEET, session_id: "s1", read: true });
      expect(notificationsList(h.deps, {}).notifications).toEqual([]);
      expect(notificationsList(h.deps, { view: "history" }).notifications).toHaveLength(1);
    });
  });

  describe(`terminal_alerts (${kind})`, () => {
    test("defaults on; turning it off resolves every open terminal row and nothing else", () => {
      const h = harness(kind);
      expect(notificationsSettings(h.deps).terminal_alerts).toBe(true);
      notifyTerminalEvent(h.store, event());
      notifyTerminalEvent(h.store, event({ fleet_id: OTHER, session_id: "s9" }));
      h.store.insert({
        source: "fleet",
        kind: "fleet.advisory",
        class: "needs_action",
        title: "unrelated condition",
        fleet: FLEET,
        key: "fleet.advisory:foundation_update",
      });

      expect(notificationsSettings(h.deps, { terminal_alerts: false }).terminal_alerts).toBe(false);

      const rows = h.rows();
      for (const r of rows.filter((r) => r.source === "terminal")) {
        expect(r.resolved_at).not.toBeNull();
      }
      expect(rows.find((r) => r.source === "fleet")?.resolved_at).toBeNull();
      expect(h.store.openKeys("terminal", null)).toEqual([]);
    });

    test("off, nothing is raised; back on, rows are raised again", () => {
      const h = harness(kind);
      notificationsSettings(h.deps, { terminal_alerts: false });
      notifyTerminalEvent(h.store, event());
      notifyTerminalEvent(h.store, event({ event: "bell" }));
      expect(h.rows()).toEqual([]);
      notificationsSettings(h.deps, { terminal_alerts: true });
      notifyTerminalEvent(h.store, event({ event: "bell" }));
      expect(h.rows()).toHaveLength(1);
    });
  });
}

test("terminal_alerts persists in the SQLite prefs across a reopen", () => {
  const db = new Database(":memory:");
  migrate(db);
  new SqliteNotificationStore(db).setSettings({ terminal_alerts: false });
  expect(new SqliteNotificationStore(db).settings().terminal_alerts).toBe(false);
  db.run(`UPDATE prefs SET value = 'maybe' WHERE key = 'notifications.terminal_alerts'`);
  // A value another build wrote that this one cannot read is the default.
  expect(new SqliteNotificationStore(db).settings().terminal_alerts).toBe(true);
});

describe("terminalNotices: the source bound to an open Hermetic", () => {
  async function fixture() {
    const home = mkdtempSync(join(tmpdir(), "hermetic-terminal-notices-"));
    return openHermetic({ fixture: true, home });
  }

  test("raises into, and resolves out of, the instance's own inbox", async () => {
    const hermetic = await fixture();
    const notices = terminalNotices(hermetic);
    const fleet_id = hermetic.target?.fleet_id as string;
    notices.raise({ fleet_id, agent: "atlas", session_id: "t1", session_index: 1, event: "output" });
    const listed = await hermetic.notifications.list({ view: "all", limit: 500 });
    const row = listed.notifications.find((n) => n.source === "terminal");
    expect(row?.key).toBe(`terminal:${fleet_id}:t1:output`);
    notices.resolve({ fleet_id, session_id: "t1", read: false });
    const after = await hermetic.notifications.list({ view: "all", limit: 500 });
    expect(after.notifications.find((n) => n.id === row?.id)?.resolved_at).not.toBeNull();
  });

  test("alertsOn reads the current setting", async () => {
    const hermetic = await fixture();
    const notices = terminalNotices(hermetic);
    expect(notices.alertsOn()).toBe(true);
    await hermetic.notifications.settings({ terminal_alerts: false });
    expect(notices.alertsOn()).toBe(false);
  });

  test("an object createHermetic did not build is refused, not silently ignored", () => {
    let caught: unknown;
    try {
      terminalNotices({});
    } catch (e) {
      caught = e;
    }
    expect(isHermeticError(caught) && caught.code).toBe("INTERNAL");
  });
});
