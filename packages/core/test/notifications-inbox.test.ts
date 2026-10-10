/**
 * Inbox v2 (§4.9): the views, the counts, the batch writes, clear/restore,
 * snooze and its expiry, the auto-clear sweep, and the fleet scope every write
 * by id is held to.
 *
 * Every case runs over both stores, because the fixture portal and the tests
 * run on one and every real laptop on the other, and a rule that held over
 * only one of them would be a bug nobody saw until it was in front of an
 * operator. The clock is injected into the store and the deps alike, so a
 * snooze can lapse without anybody waiting for it.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MemoryNotificationStore,
  notificationsAck,
  notificationsClear,
  notificationsList,
  notificationsSettings,
  notificationsSnooze,
} from "../src/chat/notifications.ts";
import type { NotificationDeps, NotificationStore } from "../src/chat/notifications.ts";
import { migrate } from "../src/local/db/index.ts";
import { SqliteNotificationStore } from "../src/local/db/notifications.ts";
import { isHermeticError } from "../src/errors.ts";
import type { NotificationInsert } from "../src/chat/notifications.ts";

const FLEET = "fleet001";
const OTHER = "fleet002";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse("2026-09-29T12:00:00.000Z");

interface Harness {
  store: NotificationStore;
  deps: NotificationDeps;
  /** Moves the shared clock forward. */
  advance(ms: number): void;
  iso(offsetMs?: number): string;
  db?: Database;
}

function harness(kind: "memory" | "sqlite", instances?: readonly string[]): Harness {
  let clock = START;
  const now = () => new Date(clock);
  let db: Database | undefined;
  let store: NotificationStore;
  if (kind === "memory") store = new MemoryNotificationStore(now);
  else {
    db = new Database(":memory:");
    migrate(db);
    store = new SqliteNotificationStore(db, now);
  }
  return {
    store,
    deps: {
      store,
      fleet: () => FLEET,
      now,
      ...(instances === undefined ? {} : { instances: () => instances }),
    },
    advance: (ms) => {
      clock += ms;
    },
    iso: (offsetMs = 0) => new Date(clock + offsetMs).toISOString(),
    ...(db === undefined ? {} : { db }),
  };
}

function row(id: string, over: Partial<NotificationInsert> = {}): NotificationInsert {
  return {
    id,
    source: "operation",
    kind: "operation.done",
    class: "ok",
    title: `row ${id}`,
    fleet: FLEET,
    ...over,
  };
}

function ids(h: Harness, view?: "inbox" | "snoozed" | "history" | "all"): string[] {
  return notificationsList(h.deps, view === undefined ? {} : { view }).notifications.map((n) => n.id);
}

function get(h: Harness, id: string) {
  return notificationsList(h.deps, { view: "all" }).notifications.find((n) => n.id === id);
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (isHermeticError(e)) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

for (const kind of ["memory", "sqlite"] as const) {
  describe(`inbox v2 over the ${kind} store`, () => {
    test("each view is the slice the contract derives from the stamps and the clock", () => {
      const h = harness(kind);
      h.store.insert(row("plain", { at: h.iso(-5 * 60_000) }));
      h.store.insert(row("resolved", { at: h.iso(-4 * 60_000), key: "k:resolved" }));
      h.store.resolve("k:resolved");
      h.store.insert(row("cleared", { at: h.iso(-3 * 60_000) }));
      notificationsClear(h.deps, { ids: ["cleared"] });
      h.store.insert(row("snoozed", { at: h.iso(-2 * 60_000) }));
      notificationsSnooze(h.deps, { ids: ["snoozed"], until: h.iso(HOUR) });

      expect(ids(h)).toEqual(["resolved", "plain"]);
      expect(ids(h, "inbox")).toEqual(["resolved", "plain"]);
      expect(ids(h, "snoozed")).toEqual(["snoozed"]);
      expect(ids(h, "history")).toEqual(["cleared", "resolved"]);
      expect(ids(h, "all")).toEqual(["snoozed", "cleared", "resolved", "plain"]);
      const result = notificationsList(h.deps);
      expect(result.snoozed).toBe(1);
      expect(result.history).toBe(2);
    });

    test("unread and needs_action leave out cleared and actively snoozed rows", () => {
      const h = harness(kind);
      for (const id of ["a", "b", "c", "d"]) h.store.insert(row(id, { class: "needs_action" }));
      h.store.insert(row("e"));
      expect(notificationsList(h.deps)).toMatchObject({ unread: 5, needs_action: 4 });

      notificationsClear(h.deps, { ids: ["a"] });
      notificationsSnooze(h.deps, { ids: ["b"], until: h.iso(HOUR) });
      const result = notificationsList(h.deps);
      expect(result).toMatchObject({ unread: 3, needs_action: 2, snoozed: 1, history: 1 });
    });

    test("a snooze lapses on its own, and next_snooze_at is the earliest one", () => {
      const h = harness(kind);
      h.store.insert(row("soon", { class: "needs_action" }));
      h.store.insert(row("later"));
      notificationsSnooze(h.deps, { ids: ["later"], until: h.iso(3 * HOUR) });
      // An offset-free stamp with no millis: stored normalised, so it compares
      // as the moment it is rather than as the string it was typed as.
      const soon = new Date(START + HOUR).toISOString().replace(".000Z", "Z");
      notificationsSnooze(h.deps, { ids: ["soon"], until: soon });
      let result = notificationsList(h.deps);
      expect(result.next_snooze_at).toBe(h.iso(HOUR));
      expect(result).toMatchObject({ unread: 0, needs_action: 0, snoozed: 2 });

      h.advance(HOUR);
      result = notificationsList(h.deps);
      expect(result.notifications.map((n) => n.id)).toEqual(["soon"]);
      expect(result).toMatchObject({ unread: 1, needs_action: 1, snoozed: 1 });
      expect(result.next_snooze_at).toBe(new Date(START + 3 * HOUR).toISOString());

      h.advance(2 * HOUR);
      result = notificationsList(h.deps);
      expect(result).toMatchObject({ unread: 2, snoozed: 0, next_snooze_at: null });
    });

    test("snooze refuses the past, and --clear brings a row back now", () => {
      const h = harness(kind);
      h.store.insert(row("x"));
      expect(refusal(() => notificationsSnooze(h.deps, { ids: ["x"], until: h.iso(-1) }))).toBe(
        "VALIDATION",
      );
      expect(refusal(() => notificationsSnooze(h.deps, { ids: ["x"] }))).toBe("VALIDATION");
      expect(notificationsSnooze(h.deps, { ids: ["x"], until: h.iso(DAY) })).toEqual({ snoozed: 1 });
      expect(notificationsSnooze(h.deps, { ids: ["x"], clear: true })).toEqual({ snoozed: 1 });
      expect(get(h, "x")?.snoozed_until ?? null).toBeNull();
      expect(ids(h)).toEqual(["x"]);
    });

    test("ack takes one selector, a batch in one call, and --unread reverses it", () => {
      const h = harness(kind);
      for (const id of ["a", "b", "c"]) h.store.insert(row(id));
      expect(refusal(() => notificationsAck(h.deps, { id: "a", all: true }))).toBe("VALIDATION");
      expect(refusal(() => notificationsAck(h.deps, { ids: ["a"], id: "b" }))).toBe("VALIDATION");
      expect(refusal(() => notificationsAck(h.deps, {}))).toBe("VALIDATION");
      expect(refusal(() => notificationsAck(h.deps, { all: true, unread: true }))).toBe("VALIDATION");
      expect(refusal(() => notificationsAck(h.deps, { ids: [] }))).toBe("VALIDATION");

      expect(notificationsAck(h.deps, { ids: ["a", "b", "nope"] })).toEqual({ acked: 2 });
      expect(notificationsAck(h.deps, { ids: ["a", "b"] })).toEqual({ acked: 0 });
      expect(notificationsList(h.deps).unread).toBe(1);
      expect(notificationsAck(h.deps, { ids: ["a"], unread: true })).toEqual({ acked: 1 });
      expect(notificationsList(h.deps).unread).toBe(2);
      expect(notificationsAck(h.deps, { id: "c" })).toEqual({ acked: 1 });
      expect(notificationsAck(h.deps, { all: true })).toEqual({ acked: 1 });
      expect(notificationsList(h.deps).unread).toBe(0);
    });

    test("clear by ids marks unread rows read; --read and --resolved take the inbox view", () => {
      const h = harness(kind);
      h.store.insert(row("unread"));
      h.store.insert(row("read", { read_at: h.iso(-60_000) }));
      h.store.insert(row("open", { key: "k:open" }));
      h.store.insert(row("gone", { key: "k:gone" }));
      h.store.resolve("k:gone");

      expect(notificationsClear(h.deps, { ids: ["unread"] })).toEqual({ cleared: 1 });
      expect(get(h, "unread")?.read_at).toBe(h.iso());
      expect(get(h, "unread")?.cleared_at).toBe(h.iso());
      expect(notificationsClear(h.deps, { ids: ["unread"] })).toEqual({ cleared: 0 });

      expect(notificationsClear(h.deps, { read: true })).toEqual({ cleared: 1 });
      expect(ids(h).sort()).toEqual(["gone", "open"]);
      expect(notificationsClear(h.deps, { resolved: true })).toEqual({ cleared: 1 });
      expect(ids(h)).toEqual(["open"]);
      expect(get(h, "gone")?.read_at).toBe(h.iso());

      expect(refusal(() => notificationsClear(h.deps, { read: true, resolved: true }))).toBe(
        "VALIDATION",
      );
      expect(refusal(() => notificationsClear(h.deps, { read: true, restore: true }))).toBe(
        "VALIDATION",
      );
    });

    test("restore un-clears and un-snoozes the named rows", () => {
      const h = harness(kind);
      h.store.insert(row("c"));
      h.store.insert(row("s"));
      notificationsClear(h.deps, { ids: ["c"] });
      notificationsSnooze(h.deps, { ids: ["s"], until: h.iso(DAY) });
      expect(ids(h)).toEqual([]);
      expect(notificationsClear(h.deps, { ids: ["c", "s"], restore: true })).toEqual({
        cleared: 2,
      });
      const c = get(h, "c");
      expect([c?.cleared_at ?? null, c?.snoozed_until ?? null]).toEqual([null, null]);
      expect(ids(h).sort()).toEqual(["c", "s"]);
    });

    /**
     * The sweep runs on every list, so a restore has to be something it can
     * see: without `restored_at`, a read resolved row went straight back to
     * History on the next list, and the operator's restore lasted one render.
     */
    test("a restored read resolved row survives the next list", () => {
      const h = harness(kind);
      h.store.insert(row("cond", { key: "k:c" }));
      h.store.resolve("k:c");
      notificationsAck(h.deps, { ids: ["cond"] });
      expect(ids(h)).toEqual([]);
      h.advance(60_000);
      notificationsClear(h.deps, { ids: ["cond"], restore: true });
      expect(ids(h)).toEqual(["cond"]);
      h.advance(HOUR);
      expect(ids(h)).toEqual(["cond"]);
      expect(get(h, "cond")?.cleared_at ?? null).toBeNull();
    });

    test("a restored row read long ago gets the full age window again", () => {
      const h = harness(kind);
      h.store.insert(row("old", { at: h.iso(-9 * DAY), read_at: h.iso(-8 * DAY) }));
      expect(ids(h)).toEqual([]);
      h.advance(60_000);
      notificationsClear(h.deps, { ids: ["old"], restore: true });
      expect(ids(h)).toEqual(["old"]);
      h.advance(6 * DAY);
      expect(ids(h)).toEqual(["old"]);
      // Seven days after the restore, the age rule takes it again.
      h.advance(DAY + 60_000);
      expect(ids(h)).toEqual([]);
    });

    test("reading a restored resolved row again clears it again", () => {
      const h = harness(kind);
      h.store.insert(row("cond", { key: "k:c" }));
      h.store.resolve("k:c");
      notificationsAck(h.deps, { ids: ["cond"] });
      h.advance(60_000);
      notificationsClear(h.deps, { ids: ["cond"], restore: true });
      h.advance(60_000);
      notificationsAck(h.deps, { ids: ["cond"], unread: true });
      expect(ids(h)).toEqual(["cond"]);
      h.advance(60_000);
      notificationsAck(h.deps, { ids: ["cond"] });
      expect(ids(h)).toEqual([]);
      expect(ids(h, "history")).toEqual(["cond"]);
    });

    test("clearing an open condition hides it until the condition changes", () => {
      const h = harness(kind);
      h.store.insert(row("first", { key: "k:cond", class: "needs_action" }));
      notificationsClear(h.deps, { ids: ["first"] });
      // Still holding: the scan finds the row it already wrote, and it stays hidden.
      expect(h.store.insert(row("again", { key: "k:cond" })).id).toBe("first");
      expect(ids(h)).toEqual([]);
      // Resolved, then back: a new row, in the inbox.
      h.store.resolve("k:cond");
      h.advance(60_000);
      h.store.insert(row("recurred", { key: "k:cond", class: "needs_action" }));
      expect(ids(h)).toEqual(["recurred"]);
      expect(notificationsList(h.deps).needs_action).toBe(1);
    });

    test("the sweep clears stale read rows, and read resolved rows, on every path", () => {
      const h = harness(kind);
      expect(notificationsSettings(h.deps)).toEqual({
        auto_clear_read: "7d",
        clear_resolved_on_read: true,
      });
      // insert: a row already read eight days ago lands cleared.
      h.store.insert(row("stale", { at: h.iso(-9 * DAY), read_at: h.iso(-8 * DAY) }));
      h.store.insert(row("fresh", { at: h.iso(-2 * DAY), read_at: h.iso(-DAY) }));
      expect(get(h, "stale")?.cleared_at).toBe(h.iso());
      expect(get(h, "fresh")?.cleared_at ?? null).toBeNull();

      // list: time passes with nobody writing, and the read converges anyway.
      h.advance(7 * DAY);
      expect(ids(h)).toEqual([]);
      expect(get(h, "fresh")?.cleared_at).toBe(h.iso());

      // ack: reading a resolved condition clears it.
      h.store.insert(row("cond", { key: "k:c" }));
      h.store.resolve("k:c");
      expect(ids(h)).toEqual(["cond"]);
      notificationsAck(h.deps, { ids: ["cond"] });
      expect(ids(h)).toEqual([]);

      // resolve: a condition already read clears as it resolves.
      h.store.insert(row("seen", { key: "k:s", read_at: h.iso() }));
      expect(ids(h)).toEqual(["seen"]);
      h.store.resolve("k:s");
      expect(get(h, "seen")?.cleared_at).toBe(h.iso());
    });

    test("the settings turn the sweep off, and it is idempotent when on", () => {
      const h = harness(kind);
      expect(
        notificationsSettings(h.deps, { auto_clear_read: "never", clear_resolved_on_read: false }),
      ).toEqual({ auto_clear_read: "never", clear_resolved_on_read: false });
      h.store.insert(row("old", { at: h.iso(-20 * DAY), read_at: h.iso(-20 * DAY) }));
      h.store.insert(row("cond", { key: "k:c", read_at: h.iso() }));
      h.store.resolve("k:c");
      expect(ids(h).sort()).toEqual(["cond", "old"]);

      // Read 20 days ago: inside 30d, outside 1d. `cond` was read just now and
      // the resolved rule is off, so neither setting touches it.
      notificationsSettings(h.deps, { auto_clear_read: "30d" });
      expect(ids(h).sort()).toEqual(["cond", "old"]);
      notificationsSettings(h.deps, { auto_clear_read: "1d" });
      expect(ids(h)).toEqual(["cond"]);
      const stamp = get(h, "old")?.cleared_at;
      h.advance(HOUR);
      notificationsList(h.deps);
      expect(get(h, "old")?.cleared_at).toBe(stamp);
      expect(notificationsSettings(h.deps)).toEqual({
        auto_clear_read: "1d",
        clear_resolved_on_read: false,
      });
      expect(refusal(() => notificationsSettings(h.deps, { auto_clear_read: "2d" }))).toBe(
        "VALIDATION",
      );
    });

    test("a write by id cannot reach another fleet's rows", () => {
      const h = harness(kind);
      h.store.insert(row("mine"));
      h.store.insert(row("theirs", { fleet: OTHER }));
      h.store.insert(row("theirs-read", { fleet: OTHER, read_at: h.iso() }));
      const both = ["mine", "theirs"];

      expect(notificationsAck(h.deps, { ids: both })).toEqual({ acked: 1 });
      expect(notificationsAck(h.deps, { id: "theirs" })).toEqual({ acked: 0 });
      expect(notificationsAck(h.deps, { ids: ["theirs-read"], unread: true })).toEqual({
        acked: 0,
      });
      expect(notificationsSnooze(h.deps, { ids: both, until: h.iso(HOUR) })).toEqual({
        snoozed: 1,
      });
      expect(notificationsClear(h.deps, { ids: both })).toEqual({ cleared: 1 });

      const theirs = { store: h.store, fleet: () => OTHER, now: h.deps.now } as NotificationDeps;
      const view = notificationsList(theirs, { view: "all" }).notifications;
      const t = view.find((n) => n.id === "theirs");
      expect([t?.read_at ?? null, t?.snoozed_until ?? null, t?.cleared_at ?? null]).toEqual([
        null,
        null,
        null,
      ]);
      expect(view.find((n) => n.id === "theirs-read")?.read_at).toBe(h.iso());
      // And the undo path is held to the same scope.
      notificationsClear(theirs, { ids: ["theirs"] });
      expect(notificationsClear(h.deps, { ids: ["theirs"], restore: true })).toEqual({
        cleared: 0,
      });
    });

    test("--read clears only what listening lets the operator see", () => {
      const h = harness(kind, ["atlas"]);
      h.store.insert(row("watched", { source: "agent", agent: "atlas", read_at: h.iso() }));
      h.store.insert(row("unwatched", { source: "agent", agent: "ember", read_at: h.iso() }));
      expect(notificationsClear(h.deps, { read: true })).toEqual({ cleared: 1 });
      const all = { ...h.deps, instances: undefined };
      expect(notificationsList(all, { view: "inbox" }).notifications.map((n) => n.id)).toEqual([
        "unwatched",
      ]);
    });
  });
}

describe("the SQLite store's settings", () => {
  test("persist in prefs, and a value another build wrote reads as the default", () => {
    const h = harness("sqlite");
    notificationsSettings(h.deps, { auto_clear_read: "30d", clear_resolved_on_read: false });
    const db = h.db as Database;
    const reopened = new SqliteNotificationStore(db);
    expect(reopened.settings()).toEqual({ auto_clear_read: "30d", clear_resolved_on_read: false });
    db.run(`UPDATE prefs SET value = 'soon' WHERE key = 'notifications.auto_clear_read'`);
    expect(reopened.settings().auto_clear_read).toBe("7d");
  });

  test("the migration is safe to run twice", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.run(`DELETE FROM schema_migrations WHERE name = 'notifications-cleared-snoozed'`);
    expect(() => migrate(db)).not.toThrow();
    const cols = db.query(`PRAGMA table_info(notifications)`).all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === "cleared_at" || c.name === "snoozed_until")).toHaveLength(2);
  });
});
