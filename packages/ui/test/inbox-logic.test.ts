/**
 * The Inbox v2 rules (`inbox-logic.ts`), pure: which rows a tab and a drawer
 * view hold, how they fall into sections and coalesce, which ids a scoped bulk
 * verb names, what a snooze preset means at a given moment, what each key
 * does, and — the one with the most ways to go wrong — what undo sends to put
 * rows back exactly as they were.
 *
 * Dates are built in local time (`new Date(y, m, d, h, min)`) because
 * "Today", "This evening" and "next Monday" are the operator's calendar.
 */
import { describe, expect, test } from "bun:test";
import {
  affectedRows,
  applyVerb,
  bellParts,
  buildSections,
  centerTabCounts,
  chunkIds,
  coalesce,
  countDelta,
  drawerRows,
  filterCenter,
  focusAfterRemoval,
  inboxKeyAction,
  moveFocus,
  rangeKeys,
  readIds,
  markReadRows,
  restoreWrites,
  snoozeLabel,
  snoozePresets,
  timeBucket,
  unreadIds,
  verbLabel,
  verbWrites,
} from "../src/logic/inbox-logic.ts";
import type { InboxRow, InboxVerb } from "../src/logic/inbox-logic.ts";

/** Tue 29 Sep 2026, 14:20 local — the mockup's "now". */
const NOW = new Date(2026, 8, 29, 14, 20).getTime();
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function row(id: string, over: Partial<InboxRow> = {}): InboxRow {
  return {
    id,
    at: iso(NOW - 5 * MIN),
    kind: "operation.failed",
    source: "operation",
    class: "bad",
    title: id,
    read_at: null,
    resolved_at: null,
    cleared_at: null,
    snoozed_until: null,
    ...over,
  };
}

const READ = iso(NOW - MIN);

describe("tabs and views", () => {
  const rows = [
    row("gold", { class: "needs_action", kind: "fleet.advisory", source: "fleet" }),
    row("unread"),
    row("read", { read_at: READ }),
    row("resolved", { resolved_at: READ }),
    row("cleared", { cleared_at: READ, read_at: READ }),
    row("snoozed", { snoozed_until: iso(NOW + 60 * MIN) }),
    row("woke", { snoozed_until: iso(NOW - MIN) }),
  ];

  test("each tab is a cut of the inbox view: cleared and actively snoozed rows have left it", () => {
    const ids = (tab: Parameters<typeof filterCenter>[1]) =>
      filterCenter(rows, tab, NOW).map((n) => n.id);
    expect(ids("all")).toEqual(["gold", "unread", "read", "resolved", "woke"]);
    expect(ids("needs_you")).toEqual(["gold"]);
    // A resolved row nobody opened is history, not work.
    expect(ids("unread")).toEqual(["gold", "unread", "woke"]);
  });

  test("the server's unread total wins where it sent it; the rest count what the tab lists", () => {
    expect(centerTabCounts(rows, NOW, { unread: 9 })).toEqual({
      needs_you: 1,
      unread: 9,
      all: 5,
    });
    // A read demand that still stands is pinned, so the tab counts it, though
    // the server's unread-only `needs_action` would not.
    const readDemand = [row("g", { class: "needs_action", read_at: READ })];
    expect(centerTabCounts(readDemand, NOW, { unread: 0 }).needs_you).toBe(1);
    expect(centerTabCounts(rows, NOW)).toEqual({ needs_you: 1, unread: 3, all: 5 });
  });

  test("the drawer's views, sources, agents and filter", () => {
    const views = { snoozed: [rows[5]!], history: [rows[3]!, rows[4]!] };
    const view = (over: Partial<Parameters<typeof drawerRows>[2]>) =>
      drawerRows(rows, views, { view: "inbox", source: null, agent: null, q: "", ...over }, NOW).map(
        (n) => n.id,
      );
    expect(view({ view: "snoozed" })).toEqual(["snoozed"]);
    expect(view({ view: "history" })).toEqual(["resolved", "cleared"]);
    expect(view({ view: "needs_you" })).toEqual(["gold"]);
    expect(view({ source: "fleet" })).toEqual(["gold"]);
    expect(view({ q: "WOKE" })).toEqual(["woke"]);
  });

  test("the bell: gold count plus a dim +N, or the orange count alone", () => {
    expect(bellParts(7, 2)).toEqual({ tone: "needs_action", main: 2, more: 5 });
    expect(bellParts(1, 2)).toEqual({ tone: "needs_action", main: 2, more: 0 });
    expect(bellParts(3, 0)).toEqual({ tone: "unread", main: 3, more: 0 });
    expect(bellParts(0, 0).tone).toBe("quiet");
  });
});

describe("sections and coalescing", () => {
  test("time buckets follow the local calendar, not the age", () => {
    expect(timeBucket(iso(new Date(2026, 8, 29, 0, 5).getTime()), NOW)).toBe("today");
    expect(timeBucket(iso(new Date(2026, 8, 28, 23, 55).getTime()), NOW)).toBe("yesterday");
    expect(timeBucket(iso(new Date(2026, 8, 25, 12, 0).getTime()), NOW)).toBe("week");
    expect(timeBucket(iso(new Date(2026, 8, 10, 12, 0).getTime()), NOW)).toBe("older");
  });

  test("`Waiting on you` is pinned first; the rest fall into time sections, newest first", () => {
    const sections = buildSections(
      [
        row("old", { at: iso(NOW - 26 * 60 * MIN) }),
        row("new", { at: iso(NOW - MIN) }),
        row("gold", { class: "needs_action", at: iso(NOW - 30 * 60 * MIN) }),
      ],
      NOW,
    );
    expect(sections.map((s) => [s.id, s.pin, s.cards.map((c) => c.key)])).toEqual([
      ["waiting", true, ["gold"]],
      ["today", false, ["new"]],
      ["yesterday", false, ["old"]],
    ]);
  });

  test("a run of finished operations draws as one card; a failure breaks the run", () => {
    const done = (id: string, m: number) =>
      row(id, { kind: "operation.done", class: "ok", at: iso(NOW - m * MIN) });
    const cards = coalesce([
      done("a", 1),
      done("b", 2),
      done("c", 3),
      row("x", { at: iso(NOW - 4 * MIN) }),
      done("d", 5),
    ]);
    expect(cards.map((c) => [c.kind, c.count])).toEqual([
      ["operations", 3],
      ["single", 1],
      ["single", 1],
    ]);
  });
});

describe("scoped bulk verbs", () => {
  test("`Mark N read` / `Clear N read` name exactly the list in view", () => {
    const list = [row("a"), row("b", { read_at: READ }), row("c"), row("r", { resolved_at: READ })];
    // `r` is unread but resolved: the header's "N unread" does not count it,
    // so neither does the button.
    expect(unreadIds(list)).toEqual(["a", "c"]);
    expect(markReadRows(list).map((n) => n.id)).toEqual(["a", "c"]);
    expect(readIds(list)).toEqual(["b"]);
  });

  test("a write never carries more than 500 ids", () => {
    const ids = Array.from({ length: 1201 }, (_v, i) => `n${i}`);
    expect(chunkIds(ids).map((c) => c.length)).toEqual([500, 500, 201]);
    const writes = verbWrites(
      { verb: "read" },
      ids.map((id) => row(id)),
    );
    expect(writes.length).toBe(3);
  });

  test("a verb touches only the rows it would change", () => {
    const list = [row("a"), row("b", { read_at: READ })];
    expect(affectedRows({ verb: "read" }, list, NOW).map((n) => n.id)).toEqual(["a"]);
    expect(affectedRows({ verb: "unread" }, list, NOW).map((n) => n.id)).toEqual(["b"]);
  });

  test("clearing also reads; restoring lifts a snooze", () => {
    const at = iso(NOW);
    expect(applyVerb(row("a"), { verb: "clear" }, at)).toMatchObject({ cleared_at: at, read_at: at });
    expect(
      applyVerb(row("a", { cleared_at: at, snoozed_until: iso(NOW + MIN) }), { verb: "restore" }, at),
    ).toMatchObject({ cleared_at: null, snoozed_until: null });
  });
});

describe("undo", () => {
  const undo = (verb: InboxVerb, prior: InboxRow[]) =>
    restoreWrites(
      prior,
      prior.map((n) => applyVerb(n, verb, iso(NOW))),
      NOW,
    );

  test("undoing a clear restores every row and marks the unread ones unread — first", () => {
    const prior = [row("a"), row("b", { read_at: READ }), row("c")];
    expect(undo({ verb: "clear" }, prior)).toEqual([
      // Before the restore, or core's clear-resolved-on-read sweep re-clears them.
      { method: "notifications.ack", input: { ids: ["a", "c"], unread: true } },
      { method: "notifications.clear", input: { ids: ["a", "b", "c"], restore: true } },
    ]);
  });

  test("undoing a clear of snoozed rows puts each snooze back", () => {
    const later = iso(NOW + 90 * MIN);
    const prior = [row("a", { read_at: READ, snoozed_until: later })];
    expect(undo({ verb: "clear" }, prior)).toEqual([
      { method: "notifications.clear", input: { ids: ["a"], restore: true } },
      { method: "notifications.snooze", input: { ids: ["a"], until: later } },
    ]);
  });

  test("undoing a snooze lifts it where there was none and restores each earlier one", () => {
    const earlier = iso(NOW + 30 * MIN);
    const prior = [row("a"), row("b", { snoozed_until: earlier })];
    expect(undo({ verb: "snooze", until: iso(NOW + 24 * 60 * MIN) }, prior)).toEqual([
      { method: "notifications.snooze", input: { ids: ["a"], clear: true } },
      { method: "notifications.snooze", input: { ids: ["b"], until: earlier } },
    ]);
  });

  test("undoing read and unread is the opposite ack", () => {
    // Reading an unread resolved row may have swept it into History on the
    // server, so the undo restores it too, after it is unread again.
    expect(undo({ verb: "read" }, [row("a")])).toEqual([
      { method: "notifications.ack", input: { ids: ["a"], unread: true } },
      { method: "notifications.clear", input: { ids: ["a"], restore: true } },
    ]);
    expect(undo({ verb: "unread" }, [row("a", { read_at: READ })])).toEqual([
      { method: "notifications.ack", input: { ids: ["a"] } },
    ]);
  });

  test("undoing a read of a snoozed row restores it and puts the snooze back", () => {
    const later = iso(NOW + 90 * MIN);
    const prior = [row("a", { resolved_at: READ, snoozed_until: later })];
    expect(undo({ verb: "read" }, prior)).toEqual([
      { method: "notifications.ack", input: { ids: ["a"], unread: true } },
      { method: "notifications.clear", input: { ids: ["a"], restore: true } },
      { method: "notifications.snooze", input: { ids: ["a"], until: later } },
    ]);
  });

  test("undoing a restore from History clears the rows again", () => {
    const prior = [row("a", { read_at: READ, cleared_at: READ })];
    expect(undo({ verb: "restore" }, prior)).toEqual([
      { method: "notifications.clear", input: { ids: ["a"] } },
    ]);
  });

  test("the badge moves by what changed: clearing unread rows, and a needs-you row", () => {
    const prior = [row("a"), row("b", { read_at: READ }), row("g", { class: "needs_action" })];
    const after = prior.map((n) => applyVerb(n, { verb: "clear" }, iso(NOW)));
    expect(countDelta(prior, after, NOW)).toEqual({ unread: -2, needs: -1 });
  });

  test("the bar's words", () => {
    const open = row("o", { key: "foundation:update" });
    expect(verbLabel({ verb: "clear" }, [row("a"), row("b")], NOW)).toEqual({
      label: "Cleared 2 notifications",
      sub: "kept in History for 30 days",
    });
    expect(verbLabel({ verb: "clear" }, [open], NOW).sub).toBe(
      "1 still open · hidden until it changes",
    );
  });
});

describe("snooze presets", () => {
  test("from Tuesday 14:20: an hour, this evening, tomorrow morning, next Monday", () => {
    const p = snoozePresets(NOW);
    expect(p.map((x) => [x.id, x.hint])).toEqual([
      ["hour", "15:20"],
      ["evening", "18:00"],
      ["morning", "Wed 09:00"],
      ["week", "Mon 09:00"],
    ]);
    expect(new Date(p[3]!.until).getDate()).toBe(5);
  });

  test("`This evening` is gone once the evening has started; Monday means next week's", () => {
    const mondayNight = new Date(2026, 9, 5, 19, 0).getTime();
    const p = snoozePresets(mondayNight);
    expect(p.map((x) => x.id)).toEqual(["hour", "morning", "week"]);
    expect(new Date(p[2]!.until).getDate()).toBe(12);
  });

  test("a snooze end is a time today, a weekday this week, a date beyond", () => {
    expect(snoozeLabel(iso(new Date(2026, 8, 29, 18, 0).getTime()), NOW)).toBe("18:00");
    expect(snoozeLabel(iso(new Date(2026, 8, 30, 9, 0).getTime()), NOW)).toBe("Wed 09:00");
    expect(snoozeLabel(iso(new Date(2026, 9, 20, 9, 0).getTime()), NOW)).toContain("09:00");
  });
});

describe("the keyboard", () => {
  test("keys map per surface; modifiers belong to the app", () => {
    expect(inboxKeyAction({ key: "j" }, "center")).toBe("down");
    expect(inboxKeyAction({ key: "Backspace" }, "drawer")).toBe("clear");
    expect(inboxKeyAction({ key: "R", shiftKey: true }, "center")).toBe("read_view");
    expect(inboxKeyAction({ key: "1" }, "center")).toBe("tab_1");
    expect(inboxKeyAction({ key: "1" }, "drawer")).toBeNull();
    expect(inboxKeyAction({ key: "x" }, "center")).toBeNull();
    expect(inboxKeyAction({ key: "A", shiftKey: true }, "drawer")).toBe("select_all");
    expect(inboxKeyAction({ key: "I", shiftKey: true }, "center")).toBe("open_drawer");
    expect(inboxKeyAction({ key: "z", metaKey: true }, "center")).toBeNull();
    expect(inboxKeyAction({ key: "Escape" }, "drawer")).toBeNull();
  });

  test("focus moves clamped, and lands below (else above) a card that left", () => {
    const keys = ["a", "b", "c"];
    expect(moveFocus(keys, null, 1)).toBe("a");
    expect(moveFocus(keys, "c", 1)).toBe("c");
    expect(moveFocus(keys, "b", -1)).toBe("a");
    expect(focusAfterRemoval(keys, "b")).toBe("c");
    expect(focusAfterRemoval(keys, "c")).toBe("b");
    expect(focusAfterRemoval(["a"], "a")).toBeNull();
  });

  test("shift-click selects the range from the last box ticked", () => {
    expect(rangeKeys(["a", "b", "c", "d"], "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeKeys(["a", "b"], null, "b")).toEqual(["b"]);
  });
});
