/**
 * The notification rules (§4.9).
 *
 * Four of the notification design's five decisions are prose in a document
 * and behaviour in this module — "gold outranks orange", "events toast,
 * conditions do not", "approvals ignore quiet hours", "preferences are
 * local". Prose cannot fail a build; these can.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  NOTIFICATION_PREFS_KEY,
  PREF_GROUPS,
  TOAST_DWELL_MS,
  actionHash,
  badgeTone,
  chatThreadOf,
  defaultPrefs,
  desktopAllowed,
  filterTab,
  groupOf,
  inQuietHours,
  isResolved,
  isWatchingThread,
  loadNotificationPrefs,
  normalizePrefs,
  inboxTime,
  resolvedLabel,
  rowTone,
  saveNotificationPrefs,
  shouldDesktop,
  shouldToast,
  sourceLine,
  streamCountDelta,
  tabCounts,
  toastDwellMs,
} from "../src/logic/notification-logic.ts";
import type {
  NotificationLike,
  NotificationPrefs,
  WatchedThread,
} from "../src/logic/notification-logic.ts";

function n(over: Partial<NotificationLike> = {}): NotificationLike {
  return { kind: "operation.done", source: "operation", class: "ok", muted: false, ...over };
}

/** A local clock, so a test never depends on the machine's timezone offset. */
function at(hh: number, mm = 0): Date {
  const d = new Date(2026, 8, 16, hh, mm, 0, 0);
  return d;
}

describe("badgeTone", () => {
  test("gold outranks orange at every level", () => {
    expect(badgeTone(0, 0)).toBe("quiet");
    expect(badgeTone(7, 0)).toBe("unread");
    expect(badgeTone(0, 2)).toBe("needs_action");
    // The case the rule is *for*: both true at once.
    expect(badgeTone(7, 2)).toBe("needs_action");
    expect(badgeTone(1, 1)).toBe("needs_action");
  });
});

describe("groupOf", () => {
  test("maps every kind core writes today", () => {
    expect(groupOf(n({ kind: "operation.failed" }))).toBe("operations");
    expect(groupOf(n({ kind: "operation.done" }))).toBe("operations");
    expect(groupOf(n({ kind: "agent.health" }))).toBe("health");
    expect(groupOf(n({ kind: "fleet.advisory" }))).toBe("advisories");
  });

  test("maps the chat kinds the later phases add", () => {
    expect(groupOf(n({ kind: "chat.approval" }))).toBe("approvals");
    expect(groupOf(n({ kind: "chat.question" }))).toBe("approvals");
    expect(groupOf(n({ kind: "chat.message" }))).toBe("messages");
    expect(groupOf(n({ kind: "chat.cron" }))).toBe("scheduled");
  });

  test("an unknown kind is delivered, not dropped", () => {
    expect(groupOf(n({ kind: "budget.threshold" }))).toBe("operations");
    expect(groupOf(n({ kind: "" }))).toBe("operations");
  });

  test("every group in the settings rail is reachable", () => {
    const reached = new Set(
      [
        "chat.approval",
        "chat.message",
        "operation.done",
        "agent.health",
        "chat.cron",
        "fleet.advisory",
      ].map((kind) => groupOf(n({ kind }))),
    );
    expect(reached.size).toBe(PREF_GROUPS.length);
  });
});

describe("defaults", () => {
  test("advisories are a condition, so they never toast", () => {
    const p = defaultPrefs();
    expect(p.delivery.advisories).toBe("inbox");
    expect(p.desktop.advisories).toBe(false);
  });

  test("approvals and operations interrupt, including on the desktop", () => {
    const p = defaultPrefs();
    expect(p.delivery.approvals).toBe("toast");
    expect(p.desktop.approvals).toBe(true);
    expect(p.delivery.operations).toBe("toast");
    expect(p.desktop.operations).toBe(true);
  });

  test("health and messages toast in the page only; scheduled runs stay in the inbox", () => {
    const p = defaultPrefs();
    expect(p.delivery.health).toBe("toast");
    expect(p.desktop.health).toBe(false);
    expect(p.delivery.messages).toBe("toast");
    expect(p.desktop.messages).toBe(false);
    expect(p.delivery.scheduled).toBe("inbox");
  });

  test("quiet hours are off, and pre-filled with the window somebody would pick", () => {
    const p = defaultPrefs();
    expect(p.quiet).toEqual({ enabled: false, start: "22:00", end: "08:00" });
  });

  test("each call is a fresh document — editing one must not edit the next", () => {
    const a = defaultPrefs();
    a.delivery.operations = "off";
    expect(defaultPrefs().delivery.operations).toBe("toast");
  });

  test("a desktop notification is only offered to a group that toasts", () => {
    expect(desktopAllowed("toast")).toBe(true);
    expect(desktopAllowed("inbox")).toBe(false);
    expect(desktopAllowed("off")).toBe(false);
  });
});

describe("inQuietHours", () => {
  const overnight = { enabled: true, start: "22:00", end: "08:00" };

  test("off is off, whatever the window says", () => {
    expect(inQuietHours(at(23), { ...overnight, enabled: false })).toBe(false);
  });

  test("the overnight window wraps midnight", () => {
    expect(inQuietHours(at(22, 0), overnight)).toBe(true);
    expect(inQuietHours(at(23, 59), overnight)).toBe(true);
    expect(inQuietHours(at(0, 1), overnight)).toBe(true);
    expect(inQuietHours(at(7, 59), overnight)).toBe(true);
    // Half-open: the end is when it stops.
    expect(inQuietHours(at(8, 0), overnight)).toBe(false);
    expect(inQuietHours(at(13, 0), overnight)).toBe(false);
    expect(inQuietHours(at(21, 59), overnight)).toBe(false);
  });

  test("a same-day window does not wrap", () => {
    const lunch = { enabled: true, start: "12:00", end: "13:00" };
    expect(inQuietHours(at(12, 30), lunch)).toBe(true);
    expect(inQuietHours(at(11, 59), lunch)).toBe(false);
    expect(inQuietHours(at(13, 0), lunch)).toBe(false);
    expect(inQuietHours(at(23, 0), lunch)).toBe(false);
  });

  test("a half-filled or malformed window is off, not all day", () => {
    expect(inQuietHours(at(3), { enabled: true, start: "09:00", end: "09:00" })).toBe(false);
    expect(inQuietHours(at(3), { enabled: true, start: "", end: "08:00" })).toBe(false);
    expect(inQuietHours(at(3), { enabled: true, start: "25:00", end: "08:00" })).toBe(false);
  });
});

describe("shouldToast", () => {
  const prefs = defaultPrefs();
  const night = { enabled: true, start: "22:00", end: "08:00" };

  test("an event in a toasting group interrupts", () => {
    expect(shouldToast(n({ kind: "operation.failed", class: "bad" }), prefs, prefs.quiet, at(13))).toBe(
      true,
    );
  });

  test("a muted row never interrupts, whatever the group says", () => {
    expect(
      shouldToast(
        n({ kind: "chat.approval", class: "needs_action", muted: true }),
        prefs,
        night,
        at(2),
      ),
    ).toBe(false);
  });

  test("a group set to inbox or off never interrupts", () => {
    expect(shouldToast(n({ kind: "fleet.advisory", class: "info" }), prefs, prefs.quiet, at(13))).toBe(
      false,
    );
    const off: NotificationPrefs = {
      ...prefs,
      delivery: { ...prefs.delivery, operations: "off" },
    };
    expect(shouldToast(n({ kind: "operation.done" }), off, off.quiet, at(13))).toBe(false);
  });

  test("quiet hours hold an ordinary event", () => {
    expect(shouldToast(n({ kind: "operation.done" }), prefs, night, at(2))).toBe(false);
    expect(shouldToast(n({ kind: "operation.done" }), prefs, night, at(13))).toBe(true);
  });

  test("an approval ignores quiet hours", () => {
    const approval = n({ kind: "chat.approval", class: "needs_action" });
    expect(shouldToast(approval, prefs, night, at(2))).toBe(true);
    // …but a muted approval is still silent, and an `off` group still is too.
    expect(shouldToast({ ...approval, muted: true }, prefs, night, at(2))).toBe(false);
  });

  test("a desktop notification needs the toast *and* the group's opt-in", () => {
    const failed = n({ kind: "operation.failed", class: "bad" });
    expect(shouldDesktop(failed, prefs, prefs.quiet, at(13))).toBe(true);
    const health = n({ kind: "agent.health", class: "bad" });
    expect(shouldToast(health, prefs, prefs.quiet, at(13))).toBe(true);
    expect(shouldDesktop(health, prefs, prefs.quiet, at(13))).toBe(false);
  });
});

describe("toastDwellMs", () => {
  test("needs-you and failures are sticky; everything else leaves", () => {
    expect(toastDwellMs(n({ class: "needs_action" }))).toBeNull();
    expect(toastDwellMs(n({ class: "bad" }))).toBeNull();
    expect(toastDwellMs(n({ class: "ok" }))).toBe(TOAST_DWELL_MS);
    expect(toastDwellMs(n({ class: "info" }))).toBe(TOAST_DWELL_MS);
    expect(toastDwellMs(n({ class: "warn" }))).toBe(TOAST_DWELL_MS);
  });
});

describe("filterTab", () => {
  const list: NotificationLike[] = [
    n({ kind: "operation.failed", source: "operation", class: "bad" }),
    n({ kind: "agent.health", source: "agent", class: "bad" }),
    n({ kind: "fleet.advisory", source: "fleet", class: "info" }),
    n({ kind: "chat.approval", source: "chat", class: "needs_action" }),
    n({ kind: "chat.message", source: "chat", class: "info" }),
  ];

  test("`all` is everything, and a copy rather than the caller's array", () => {
    const out = filterTab(list, "all");
    expect(out).toHaveLength(5);
    expect(out).not.toBe(list);
  });

  test("`needs you` is the class, not the source", () => {
    expect(filterTab(list, "needs_you")).toHaveLength(1);
    expect(filterTab(list, "needs_you")[0]?.kind).toBe("chat.approval");
  });

  test("`fleet` is fleet, operation and agent — not chat", () => {
    expect(filterTab(list, "fleet").map((x) => x.source)).toEqual(["operation", "agent", "fleet"]);
  });

  test("the tab counts are the tabs", () => {
    expect(tabCounts(list)).toEqual({ all: 5, needs_you: 1, fleet: 3 });
  });
});

describe("resolved conditions (the events-toast rule, §4.9)", () => {
  const now = Date.parse("2026-09-16T12:00:00.000Z");

  test("resolved is the world's fact, and read is the operator's", () => {
    expect(isResolved(n())).toBe(false);
    expect(isResolved({ ...n(), resolved_at: null })).toBe(false);
    // A row can be resolved and unread, or read and unresolved: neither field
    // is evidence for the other.
    expect(isResolved({ ...n(), resolved_at: "2026-09-16T11:00:00.000Z" })).toBe(true);
  });

  test("the cleared note says when, in the same words as the age beside it", () => {
    expect(resolvedLabel("2026-09-16T11:59:30.000Z", now)).toBe("cleared just now");
    expect(resolvedLabel("2026-09-16T11:40:00.000Z", now)).toBe("cleared 20m ago");
    expect(resolvedLabel("2026-09-16T09:00:00.000Z", now)).toBe("cleared 3h ago");
    // A date, once an age has stopped meaning anything, takes no "ago".
    expect(resolvedLabel("2026-09-10T12:00:00.000Z", now)).not.toContain("ago");
    expect(resolvedLabel("not a date", now)).toBe("cleared");
  });

  test("a cleared condition leaves `needs you` but stays in `all` and `fleet`", () => {
    const list: NotificationLike[] = [
      n({ kind: "fleet.advisory", source: "fleet", class: "needs_action" }),
      n({
        kind: "fleet.advisory",
        source: "fleet",
        class: "needs_action",
        resolved_at: "2026-09-16T11:00:00.000Z",
      }),
    ];
    expect(filterTab(list, "needs_you")).toHaveLength(1);
    expect(filterTab(list, "needs_you")[0]?.resolved_at).toBeUndefined();
    // The record that it happened and cleared is kept, in both source cuts.
    expect(tabCounts(list)).toEqual({ all: 2, needs_you: 1, fleet: 2 });
  });

  test("a cleared row never interrupts, whatever its group is set to", () => {
    const prefs = defaultPrefs();
    prefs.delivery.advisories = "toast";
    const live = n({ kind: "fleet.advisory", source: "fleet", class: "needs_action" });
    expect(shouldToast(live, prefs)).toBe(true);
    expect(shouldToast({ ...live, resolved_at: "2026-09-16T11:00:00.000Z" }, prefs)).toBe(false);
    // And no desktop banner either — that rides on the toast.
    prefs.desktop.advisories = true;
    expect(shouldDesktop({ ...live, resolved_at: "2026-09-16T11:00:00.000Z" }, prefs)).toBe(false);
  });
});

describe("actionHash", () => {
  test("the hash-addressed views resolve", () => {
    expect(actionHash({ target: "foundation" })).toBe("#settings/foundation");
    expect(actionHash({ target: "volumes" })).toBe("#fleet/volumes");
    expect(actionHash({ target: "settings" })).toBe("#settings/notifications");
    expect(actionHash({ target: "run", ref: "r-1" })).toBe("#settings/runs");
    // An op id is findable in the run log, which is the page an op action wants.
    expect(actionHash({ target: "op", ref: "op-1" })).toBe("#settings/runs");
  });

  test("an agent has no hash — the drawer is App state, so the row uses a callback", () => {
    expect(actionHash({ target: "agent", ref: "lumen" })).toBeNull();
    expect(actionHash({ target: "nonsense" })).toBeNull();
  });

  test("a chat action opens the bot named in its ref", () => {
    expect(actionHash({ target: "chat", ref: "atlas/researcher" })).toBe("#chat/atlas/researcher");
  });
});

/* ── the watching rule (§4.9) ─────────────────────────────────────────────── */

const WATCHING: WatchedThread = { instance: "atlas", bot: "researcher", focused: true };

function chat(over: Partial<NotificationLike> = {}): NotificationLike {
  return n({
    kind: "chat.message",
    source: "chat",
    class: "info",
    ref: "atlas/researcher",
    ...over,
  });
}

describe("chatThreadOf", () => {
  test("splits at the first slash, because an agent name can hold neither", () => {
    expect(chatThreadOf({ kind: "chat.message", ref: "atlas/researcher" })).toEqual({
      instance: "atlas",
      bot: "researcher",
    });
    // A bot name upstream chose is not hermetic's to validate, and one holding a
    // slash still resolves to the right box.
    expect(chatThreadOf({ kind: "chat.error", ref: "atlas/team/writer" })).toEqual({
      instance: "atlas",
      bot: "team/writer",
    });
  });

  test("a row that is about no thread resolves to none", () => {
    expect(chatThreadOf({ kind: "agent.health", ref: "atlas/researcher" })).toBeNull();
    expect(chatThreadOf({ kind: "chat.message", ref: null })).toBeNull();
    expect(chatThreadOf({ kind: "chat.message", ref: "atlas" })).toBeNull();
    expect(chatThreadOf({ kind: "chat.message", ref: "atlas/" })).toBeNull();
  });
});

describe("isWatchingThread", () => {
  test("the thread on screen and in focus is being watched", () => {
    expect(isWatchingThread(chat(), WATCHING)).toBe(true);
  });

  test("another thread on the same box is not", () => {
    expect(isWatchingThread(chat({ ref: "atlas/default" }), WATCHING)).toBe(false);
  });

  test("the same bot name on another box is not", () => {
    expect(isWatchingThread(chat({ ref: "ember/researcher" }), WATCHING)).toBe(false);
  });

  test("a thread that is open but not focused is not being watched", () => {
    // A chat view behind an editor on a second monitor. Treating that as
    // watching would drop exactly the notifications the operator went to the
    // other window in order to be told about.
    expect(isWatchingThread(chat(), { ...WATCHING, focused: false })).toBe(false);
  });

  test("with no thread open, nothing is being watched", () => {
    expect(isWatchingThread(chat(), null)).toBe(false);
  });

  test("a row about no thread is never suppressed by one being open", () => {
    expect(isWatchingThread(n({ kind: "agent.health", source: "agent" }), WATCHING)).toBe(false);
  });
});

describe("shouldToast and the watching rule", () => {
  const prefs = defaultPrefs();

  test("a reply into the thread already on screen does not interrupt", () => {
    expect(shouldToast(chat(), prefs)).toBe(true);
    expect(shouldToast(chat(), prefs, prefs.quiet, new Date(), WATCHING)).toBe(false);
  });

  test("a reply into any other thread still does", () => {
    // This is the case the whole source exists for: a cron routine, a channel
    // or a peer bot spoke somewhere the operator is not looking.
    expect(shouldToast(chat({ ref: "ember/nightly" }), prefs, prefs.quiet, new Date(), WATCHING)).toBe(
      true,
    );
  });

  test("a failed turn in the thread on screen does not interrupt either", () => {
    // The banner is already in the thread, three inches from where they are
    // looking. The row is still in the inbox; only the toast is withheld.
    const failed = chat({ kind: "chat.error", class: "bad" });
    expect(shouldToast(failed, prefs, prefs.quiet, new Date(), WATCHING)).toBe(false);
  });

  test("watching suppresses the desktop banner too, since one rides on the other", () => {
    const loud: NotificationPrefs = {
      ...prefs,
      desktop: { ...prefs.desktop, messages: true },
    };
    expect(shouldDesktop(chat(), loud)).toBe(true);
    expect(shouldDesktop(chat(), loud, loud.quiet, new Date(), WATCHING)).toBe(false);
  });

  test("a non-chat row is unaffected by any thread being open", () => {
    const health = n({ kind: "agent.health", source: "agent", class: "bad" });
    expect(shouldToast(health, prefs, prefs.quiet, new Date(), WATCHING)).toBe(true);
  });
});

describe("row chrome", () => {
  test("the tone class collapses info and warn onto the quiet rule", () => {
    expect(rowTone("needs_action")).toBe("needs-action");
    expect(rowTone("bad")).toBe("bad");
    expect(rowTone("ok")).toBe("ok");
    expect(rowTone("info")).toBe("info");
    expect(rowTone("warn")).toBe("info");
  });

  test("the source line names who, where from, and what", () => {
    expect(sourceLine({ kind: "operation.failed", source: "operation", agent: "marrow" })).toBe(
      "marrow · operation · failed",
    );
    expect(
      sourceLine({ kind: "fleet.advisory", source: "fleet", agent: null, fleet_id: "fxtr0001" }),
    ).toBe("fleet fxtr0001 · fleet · advisory");
  });

  test("relative time is an age while an age means something", () => {
    const now = Date.parse("2026-09-16T12:00:00.000Z");
    expect(inboxTime("2026-09-16T11:59:30.000Z", now)).toBe("now");
    expect(inboxTime("2026-09-16T11:56:00.000Z", now)).toBe("4m");
    expect(inboxTime("2026-09-16T01:00:00.000Z", now)).toBe("11h");
    // Older than a day falls back to a date; the format is the browser's.
    expect(inboxTime("2026-09-10T12:00:00.000Z", now)).not.toBe("11h");
    expect(inboxTime("not a date", now)).toBe("—");
  });
});

describe("what a streamed row adds to the badge", () => {
  const held = [{ id: "n1" }, { id: "n2" }];
  test("a row the last fetch already counted adds nothing", () => {
    // The server only re-sends counts when they change, so a second bump for a
    // row already in the inbox would sit on the badge until something else moved.
    expect(streamCountDelta(held, { id: "n1", class: "ok", read_at: null })).toEqual({
      unread: 0,
      needs_action: 0,
    });
    expect(streamCountDelta(held, { id: "n2", class: "needs_action", read_at: null })).toEqual({
      unread: 0,
      needs_action: 0,
    });
  });
  test("a row this inbox has never seen is counted once, by class", () => {
    expect(streamCountDelta(held, { id: "n3", class: "ok", read_at: null })).toEqual({
      unread: 1,
      needs_action: 0,
    });
    expect(streamCountDelta(held, { id: "n4", class: "needs_action", read_at: null })).toEqual({
      unread: 1,
      needs_action: 1,
    });
  });
  test("a read row and a cleared row are counted by neither total", () => {
    expect(
      streamCountDelta(held, { id: "n5", class: "ok", read_at: "2026-09-16T12:00:00.000Z" }),
    ).toEqual({ unread: 0, needs_action: 0 });
    expect(
      streamCountDelta(held, {
        id: "n6",
        class: "needs_action",
        read_at: null,
        resolved_at: "2026-09-16T12:00:00.000Z",
      }),
    ).toEqual({ unread: 0, needs_action: 0 });
  });
});

describe("prefs persistence", () => {
  /**
   * `bun test` has no DOM unless a `*.dom.test.tsx` file in the same process
   * registered one, so this file brings its own storage rather than depending on
   * which files happen to run before it. If happy-dom is already installed its
   * storage is used as found, and nothing here is put back wrong.
   */
  const backing = new Map<string, string>();
  const stub: Storage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  };
  let installed = false;

  beforeAll(() => {
    if ((globalThis as { localStorage?: Storage }).localStorage) return;
    Object.defineProperty(globalThis, "localStorage", { value: stub, configurable: true });
    installed = true;
  });

  afterAll(() => {
    localStorage.removeItem(NOTIFICATION_PREFS_KEY);
    if (installed) Reflect.deleteProperty(globalThis, "localStorage");
  });

  test("a round trip through localStorage keeps every field", () => {
    const p = defaultPrefs();
    p.delivery.health = "off";
    p.desktop.messages = true;
    p.quiet = { enabled: true, start: "23:30", end: "07:15" };
    saveNotificationPrefs(p);
    expect(loadNotificationPrefs()).toEqual(p);
    localStorage.removeItem(NOTIFICATION_PREFS_KEY);
  });

  test("nothing stored is the defaults", () => {
    localStorage.removeItem(NOTIFICATION_PREFS_KEY);
    expect(loadNotificationPrefs()).toEqual(defaultPrefs());
  });

  test("a document that is not JSON is the defaults, not a thrown render", () => {
    localStorage.setItem(NOTIFICATION_PREFS_KEY, "{not json");
    expect(loadNotificationPrefs()).toEqual(defaultPrefs());
    localStorage.removeItem(NOTIFICATION_PREFS_KEY);
  });

  test("a partial or half-corrupt document keeps the fields it got right", () => {
    const out = normalizePrefs({
      delivery: { operations: "off", health: "nonsense" },
      desktop: { approvals: "yes", messages: true },
      quiet: { enabled: true, start: "25:00", end: "07:00" },
    });
    expect(out.delivery.operations).toBe("off");
    // A value that is not one of the three falls back rather than poisoning the row.
    expect(out.delivery.health).toBe(defaultPrefs().delivery.health);
    expect(out.desktop.approvals).toBe(defaultPrefs().desktop.approvals);
    expect(out.desktop.messages).toBe(true);
    expect(out.quiet.enabled).toBe(true);
    expect(out.quiet.start).toBe(defaultPrefs().quiet.start);
    expect(out.quiet.end).toBe("07:00");
  });

  test("a document that is not an object at all is the defaults", () => {
    expect(normalizePrefs(null)).toEqual(defaultPrefs());
    expect(normalizePrefs(42)).toEqual(defaultPrefs());
    expect(normalizePrefs([])).toEqual(defaultPrefs());
  });
});
