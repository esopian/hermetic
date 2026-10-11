/**
 * The terminal's notification rules (issue #18), without a provider:
 * the group, the watching gate, the trigger, where `Open session` lands, the
 * banner limits on a fake clock, and what the return toast picks.
 */
import { describe, expect, test } from "bun:test";
import {
  PREF_GROUPS,
  actionHash,
  defaultPrefs,
  groupOf,
  normalizePrefs,
  shouldDesktop,
  shouldToast,
} from "../src/logic/notification-logic.ts";
import type { NotificationLike } from "../src/logic/notification-logic.ts";
import {
  TERMINAL_BANNER_APP_MS,
  TERMINAL_BANNER_SESSION_MS,
  TerminalBannerGate,
  isWatchingTerminalSession,
  pickReturnToast,
  terminalActionHash,
} from "../src/logic/terminal-notify.ts";

const KINDS = [
  "terminal.output",
  "terminal.finished",
  "terminal.input",
  "terminal.bell",
  "terminal.disconnected",
] as const;

function row(over: Partial<NotificationLike> = {}): NotificationLike {
  return { kind: "terminal.output", source: "terminal", class: "info", ref: "s1", ...over };
}

/** Mid-afternoon: outside the default quiet hours whether or not they are on. */
const NOON = new Date("2026-10-10T14:00:00");

describe("the Terminal group", () => {
  test("every terminal kind is in it", () => {
    for (const kind of KINDS) expect(groupOf({ kind })).toBe("terminal");
  });

  test("toasts by default, with the desktop banner on, and every output interrupts", () => {
    const p = defaultPrefs();
    expect(p.delivery.terminal).toBe("toast");
    expect(p.desktop.terminal).toBe(true);
    expect(p.terminalTrigger).toBe("output");
  });

  test("is listed between Agent messages and Operations, as the mock has it", () => {
    const ids = PREF_GROUPS.map((g) => g.id);
    expect(ids.indexOf("terminal")).toBe(ids.indexOf("messages") + 1);
    expect(ids.indexOf("operations")).toBe(ids.indexOf("terminal") + 1);
  });

  test("the trigger persists with the other preferences and tolerates junk", () => {
    expect(normalizePrefs({ terminalTrigger: "important" }).terminalTrigger).toBe("important");
    expect(normalizePrefs({ terminalTrigger: "loud" }).terminalTrigger).toBe("output");
    expect(normalizePrefs({ delivery: { terminal: "inbox" } }).delivery.terminal).toBe("inbox");
  });
});

describe("watching a terminal session", () => {
  test("a row about the viewed session is being watched; another session's is not", () => {
    expect(isWatchingTerminalSession(row({ ref: "s1" }), "s1")).toBe(true);
    expect(isWatchingTerminalSession(row({ ref: "s2" }), "s1")).toBe(false);
    expect(isWatchingTerminalSession(row({ ref: "s1" }), null)).toBe(false);
  });

  test("only terminal rows can be watched this way", () => {
    expect(isWatchingTerminalSession({ kind: "chat.message", ref: "s1" }, "s1")).toBe(false);
  });

  test("joins the toast gate: the viewed session never interrupts, others still do", () => {
    const prefs = defaultPrefs();
    for (const kind of KINDS) {
      const n = row({ kind, ref: "s1" });
      expect(shouldToast(n, prefs, prefs.quiet, NOON, null, "s1")).toBe(false);
      expect(shouldDesktop(n, prefs, prefs.quiet, NOON, null, "s1")).toBe(false);
      expect(shouldToast(n, prefs, prefs.quiet, NOON, null, "s2")).toBe(true);
      expect(shouldToast(n, prefs, prefs.quiet, NOON, null, null)).toBe(true);
    }
  });
});

describe("the trigger", () => {
  test("`important` keeps output out of the toast and the banner, and nothing else", () => {
    const prefs = { ...defaultPrefs(), terminalTrigger: "important" as const };
    expect(shouldToast(row({ kind: "terminal.output" }), prefs, prefs.quiet, NOON)).toBe(false);
    expect(shouldDesktop(row({ kind: "terminal.output" }), prefs, prefs.quiet, NOON)).toBe(false);
    for (const kind of KINDS.filter((k) => k !== "terminal.output")) {
      expect(shouldToast(row({ kind }), prefs, prefs.quiet, NOON)).toBe(true);
    }
  });

  test("`important` is about terminal output only; no other group's rows notice it", () => {
    const prefs = { ...defaultPrefs(), terminalTrigger: "important" as const };
    const op = { kind: "operation.failed", source: "operation", class: "bad" } as const;
    expect(shouldToast(op, prefs, prefs.quiet, NOON)).toBe(true);
  });

  test("the group's delivery still rules: inbox never toasts, even for input", () => {
    const prefs = defaultPrefs();
    prefs.delivery.terminal = "inbox";
    expect(
      shouldToast(row({ kind: "terminal.input", class: "needs_action" }), prefs, prefs.quiet, NOON),
    ).toBe(false);
  });
});

describe("Open session", () => {
  test("goes to the agent's Terminal section, on the session", () => {
    expect(actionHash({ target: "terminal", ref: "atlas/s1" })).toBe("#agent/atlas/terminal/s1");
    expect(terminalActionHash("atlas/s1")).toBe("#agent/atlas/terminal/s1");
  });

  test("a ref with no agent or no session goes nowhere", () => {
    for (const ref of [null, "", "atlas", "/s1", "atlas/"]) {
      expect(actionHash({ target: "terminal", ref })).toBeNull();
    }
  });
});

describe("TerminalBannerGate", () => {
  const banner = (title: string) => ({ title, body: "" });

  test("the first banner goes out at once", () => {
    const gate = new TerminalBannerGate();
    expect(gate.offer("s1", banner("one"), 0)).toEqual(banner("one"));
    expect(gate.nextFlushAt()).toBeNull();
  });

  test("one per session per 60 s: a repeat inside the window is dropped, not held", () => {
    const gate = new TerminalBannerGate();
    gate.offer("s1", banner("one"), 0);
    expect(gate.offer("s1", banner("again"), TERMINAL_BANNER_APP_MS + 1)).toBeNull();
    expect(gate.nextFlushAt()).toBeNull();
    expect(gate.offer("s1", banner("later"), TERMINAL_BANNER_SESSION_MS)).toEqual(banner("later"));
  });

  test("one per 10 s app-wide: the rest are held and fold into one", () => {
    const gate = new TerminalBannerGate();
    expect(gate.offer("s1", banner("one"), 0)).not.toBeNull();
    expect(gate.offer("s2", banner("two"), 1_000)).toBeNull();
    expect(gate.offer("s3", banner("three"), 2_000)).toBeNull();
    expect(gate.nextFlushAt()).toBe(TERMINAL_BANNER_APP_MS);
    // Not before the window has passed.
    expect(gate.flush(TERMINAL_BANNER_APP_MS - 1)).toBeNull();
    expect(gate.flush(TERMINAL_BANNER_APP_MS)?.title).toBe("2 terminal sessions have new output");
    expect(gate.nextFlushAt()).toBeNull();
    // The flush counted as a banner for both sessions and for the app.
    expect(gate.offer("s2", banner("two again"), TERMINAL_BANNER_APP_MS + 1)).toBeNull();
    expect(gate.offer("s4", banner("four"), TERMINAL_BANNER_APP_MS + 2)).toBeNull();
  });

  test("a single held session flushes as its own banner, its newest one", () => {
    const gate = new TerminalBannerGate();
    gate.offer("s1", banner("one"), 0);
    gate.offer("s2", banner("two"), 1_000);
    gate.offer("s2", banner("two, newer"), 2_000);
    expect(gate.flush(TERMINAL_BANNER_APP_MS)).toEqual(banner("two, newer"));
  });

  test("a held session that bannered in the meantime is not told twice", () => {
    const gate = new TerminalBannerGate(60_000, 10_000);
    gate.offer("s1", banner("one"), 0);
    gate.offer("s1", banner("held? no — dropped"), 5_000);
    expect(gate.flush(10_000)).toBeNull();
  });
});

describe("pickReturnToast", () => {
  const r = (id: string, at: string, over: Record<string, unknown> = {}) => ({
    id,
    at,
    kind: "terminal.finished",
    read_at: null as string | null,
    resolved_at: null as string | null,
    cleared_at: null as string | null,
    ...over,
  });

  test("the newest is the toast, the next is `also`, the rest are counted", () => {
    const a = r("a", "2026-10-10T10:00:00Z");
    const b = r("b", "2026-10-10T10:05:00Z");
    const c = r("c", "2026-10-10T10:02:00Z");
    const d = r("d", "2026-10-10T10:01:00Z");
    const pick = pickReturnToast([a, b, c, d], [a, b, c, d]);
    expect(pick?.newest.id).toBe("b");
    expect(pick?.also?.id).toBe("c");
    expect(pick?.more).toBe(2);
  });

  test("one row: no `also`", () => {
    const a = r("a", "2026-10-10T10:00:00Z");
    expect(pickReturnToast([a], [a])).toEqual({ newest: a, also: null, more: 0 });
  });

  test("a row read, resolved or cleared since it arrived is no longer unseen", () => {
    const a = r("a", "2026-10-10T10:00:00Z");
    const b = r("b", "2026-10-10T10:05:00Z");
    const c = r("c", "2026-10-10T10:06:00Z", { kind: "terminal.output" });
    const now = [
      { ...a },
      { ...b, read_at: "2026-10-10T10:07:00Z" },
      { ...c, resolved_at: "2026-10-10T10:08:00Z" },
    ];
    expect(pickReturnToast([a, b, c], now)?.newest.id).toBe("a");
    expect(pickReturnToast([b, c], now)).toBeNull();
    expect(pickReturnToast([a], [{ ...a, cleared_at: "2026-10-10T10:09:00Z" }])).toBeNull();
  });

  test("a row the inbox no longer holds is taken as it arrived; a duplicate counts once", () => {
    const a = r("a", "2026-10-10T10:00:00Z");
    expect(pickReturnToast([a, a], [])).toEqual({ newest: a, also: null, more: 0 });
  });

  test("nothing away is nothing to show", () => {
    expect(pickReturnToast([], [])).toBeNull();
  });
});
