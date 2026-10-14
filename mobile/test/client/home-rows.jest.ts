import {
  failedBots,
  homeItems,
  homePreview,
  homeRows,
  homeRowsByKey,
  homeTime,
  needsBots,
  sectionState,
} from "../../src/client/home-rows.ts";
import { RosterStore } from "../../src/client/roster-store.ts";
import { memoryFile, memoryKv, rosterPrefsStorage } from "../../src/fleet/store.ts";
import { InboxStore } from "../../src/inbox/store.ts";
import { bot, inboxEntry, swarm } from "../helpers/fixtures.ts";

// Built from local-time parts, so every case holds in any time zone.
const NOW = new Date(2026, 9, 14, 15, 0).getTime(); // Wed 14 Oct 2026, 3:00 PM
const at = (y: number, mo: number, d: number, h = 9, mi = 0) => new Date(y, mo, d, h, mi).toISOString();

describe("homeTime", () => {
  test("today is the clock time", () => {
    expect(homeTime(at(2026, 9, 14, 14, 24), NOW)).toBe("2:24 PM");
    expect(homeTime(at(2026, 9, 14, 0, 5), NOW)).toBe("12:05 AM");
  });

  test("the last six days are the weekday", () => {
    expect(homeTime(at(2026, 9, 13, 23, 59), NOW)).toBe("Tuesday");
    expect(homeTime(at(2026, 9, 12), NOW)).toBe("Monday");
    expect(homeTime(at(2026, 9, 8), NOW)).toBe("Thursday");
  });

  test("older is the date, with the year only when it is not this year", () => {
    expect(homeTime(at(2026, 9, 7), NOW)).toBe("Oct 7");
    expect(homeTime(at(2026, 8, 30), NOW)).toBe("Sep 30");
    expect(homeTime(at(2025, 11, 31), NOW)).toBe("Dec 31, 2025");
  });

  test("nothing, or nonsense, is empty", () => {
    expect(homeTime(null, NOW)).toBe("");
    expect(homeTime(undefined, NOW)).toBe("");
    expect(homeTime("not a date", NOW)).toBe("");
  });
});

describe("homePreview", () => {
  test("the operator's own words carry the sent glyph, not a You: prefix", () => {
    expect(homePreview(bot({ preview: "ship it\nnow", preview_role: "user" }))).toEqual({
      text: "ship it now",
      sent: true,
    });
    expect(homePreview(bot({ preview: "done", preview_role: "bot" }))).toEqual({
      text: "done",
      sent: false,
    });
    expect(homePreview(bot({}))).toEqual({ text: "No messages yet", sent: false });
  });
});

describe("homeRows: the hero", () => {
  const swarms = [
    swarm("atlas", [
      bot({ name: "ops", is_default: true }),
      bot({ name: "scribe" }),
      bot({ name: "pin" }),
    ]),
    swarm("corvid", [bot({ name: "pilot", is_default: true }), bot({ name: "wren" })]),
  ];

  test("nothing pinned: the default bot of each listened instance, in listening order, unstarred", () => {
    const layout = homeRows({ swarms, listening: ["corvid", "atlas"], pinned: [] });
    expect(layout.heroPinned).toBe(false);
    expect(layout.hero.map((r) => r.key)).toEqual(["corvid/pilot", "atlas/ops"]);
    // An instance not listened to gives no hero.
    expect(homeRows({ swarms, listening: ["atlas"], pinned: [] }).hero.map((r) => r.key)).toEqual([
      "atlas/ops",
    ]);
  });

  test("an instance with no default flag gives its first bot", () => {
    const plain = [swarm("atlas", [bot({ name: "a" }), bot({ name: "b" })])];
    expect(
      homeRows({ swarms: plain, listening: ["atlas"], pinned: [] }).hero.map((r) => r.key),
    ).toEqual(["atlas/a"]);
  });

  test("pins replace the defaults, in pin order; gone or unlistened pins drop out", () => {
    const layout = homeRows({
      swarms,
      listening: ["atlas", "corvid"],
      pinned: ["corvid/wren", "atlas/gone", "kestrel/x", "atlas/pin"],
    });
    expect(layout.heroPinned).toBe(true);
    expect(layout.hero.map((r) => [r.key, r.pinned])).toEqual([
      ["corvid/wren", true],
      ["atlas/pin", true],
    ]);
    // Only pins, so the defaults go back to their sections.
    expect(layout.sections.map((s) => [s.instance, s.rows.map((r) => r.bot.name)])).toEqual([
      ["atlas", ["ops", "scribe"]],
      ["corvid", ["pilot"]],
    ]);
  });

  test("every pin gone: back to the defaults", () => {
    const layout = homeRows({ swarms, listening: ["atlas"], pinned: ["atlas/gone"] });
    expect(layout.heroPinned).toBe(false);
    expect(layout.hero.map((r) => r.key)).toEqual(["atlas/ops"]);
  });

  test("a pin on a box that is down is kept, dimmed: absence proves nothing", () => {
    const down = [swarms[0]!, swarm("corvid", [], { reachable: false })];
    const layout = homeRows({ swarms: down, listening: ["atlas", "corvid"], pinned: ["corvid/pilot"] });
    expect(layout.hero).toEqual([
      expect.objectContaining({ key: "corvid/pilot", reachable: false, pinned: true }),
    ]);
  });

  test("hero bots are never repeated in a section; a section they empty is left out", () => {
    const solo = [swarm("atlas", [bot({ name: "ops", is_default: true })]), swarms[1]!];
    const layout = homeRows({ swarms: solo, listening: ["atlas", "corvid"], pinned: [] });
    expect(layout.hero.map((r) => r.key)).toEqual(["atlas/ops", "corvid/pilot"]);
    expect(layout.sections.map((s) => s.instance)).toEqual(["corvid"]);
    const keys = layout.sections.flatMap((s) => s.rows.map((r) => r.key));
    for (const h of layout.hero) expect(keys).not.toContain(h.key);
  });
});

describe("homeRows: sections", () => {
  const T = (h: number) => at(2026, 9, 14, h);

  test("within a section: needs-you, unread, newest, name", () => {
    const layout = homeRows({
      swarms: [
        swarm("atlas", [
          bot({ name: "ops", is_default: true, last_message_at: T(14) }),
          bot({ name: "old", title: "Old", last_message_at: T(8) }),
          bot({ name: "new", title: "New", last_message_at: T(12) }),
          bot({ name: "zed", title: "Zed" }),
          bot({ name: "abe", title: "Abe" }),
          bot({ name: "unr", title: "Unr", unread: 2, last_message_at: T(7) }),
          bot({ name: "nee", title: "Nee", needs_action: true, last_message_at: T(6) }),
        ]),
      ],
      listening: ["atlas"],
      pinned: [],
    });
    const rows = layout.sections[0]!.rows;
    expect(rows.map((r) => r.bot.name)).toEqual(["nee", "unr", "new", "old", "abe", "zed"]);
    expect(rows.find((r) => r.bot.name === "nee")?.badge).toBe("!");
    expect(rows.find((r) => r.bot.name === "unr")?.badge).toBe("2");
    expect(rows.find((r) => r.bot.name === "old")?.badge).toBeNull();
  });

  test("sections: reachable first, then needs-you, unread, most recent (desktop compareBuckets)", () => {
    const layout = homeRows({
      swarms: [
        swarm("down", [], { reachable: false, unreachable_reason: "TIMEOUT: no answer" }),
        swarm("quiet", [
          bot({ name: "d", is_default: true }),
          bot({ name: "q", last_message_at: T(13) }),
        ]),
        swarm("recent", [
          bot({ name: "d", is_default: true }),
          bot({ name: "r", last_message_at: T(14) }),
        ]),
        swarm("unread", [
          bot({ name: "d", is_default: true }),
          bot({ name: "u", unread: 1, last_message_at: T(1) }),
        ]),
        swarm("needs", [
          bot({ name: "d", is_default: true }),
          bot({ name: "n", needs_action: true, last_message_at: T(1) }),
        ]),
      ],
      listening: ["down", "quiet", "recent", "unread", "needs"],
      pinned: [],
    });
    expect(layout.sections.map((s) => s.instance)).toEqual([
      "needs",
      "unread",
      "recent",
      "quiet",
      "down",
    ]);
    expect(layout.sections.at(-1)).toMatchObject({
      instance: "down",
      reachable: false,
      reason: "TIMEOUT: no answer",
      rows: [],
      folded: false,
    });
  });

  test("the inbox's unread lifts a bot the roster has not caught up on", () => {
    const layout = homeRows({
      swarms: [
        swarm("atlas", [
          bot({ name: "ops", is_default: true }),
          bot({ name: "a", last_message_at: T(12) }),
          bot({ name: "b", last_message_at: T(1) }),
        ]),
      ],
      listening: ["atlas"],
      pinned: [],
      unreadOf: (_i, b) => (b === "b" ? 1 : 0),
    });
    expect(layout.sections[0]!.rows.map((r) => [r.bot.name, r.badge])).toEqual([
      ["b", "1"],
      ["a", null],
    ]);
    expect(layout.sections[0]!.unread).toBe(1);
  });

  test("no instance suffix; the bot's own name only when two titles collide in one instance", () => {
    const layout = homeRows({
      swarms: [
        swarm("atlas", [
          bot({ name: "ops", is_default: true }),
          bot({ name: "x", title: "Clio" }),
          bot({ name: "y", title: "clio" }),
          bot({ name: "z", title: "Solo" }),
        ]),
        swarm("corvid", [bot({ name: "pilot", is_default: true }), bot({ name: "c", title: "Solo" })]),
      ],
      listening: ["atlas", "corvid"],
      pinned: [],
    });
    const suffixes = Object.fromEntries(
      layout.sections.flatMap((s) => s.rows.map((r) => [r.key, r.suffix] as const)),
    );
    expect(suffixes).toEqual({ "atlas/x": "x", "atlas/y": "y", "atlas/z": null, "corvid/c": null });
  });

  test("folded: only a reachable section folds, and homeItems drops its rows", () => {
    const layout = homeRows({
      swarms: [
        swarm("atlas", [bot({ name: "ops", is_default: true }), bot({ name: "a" })]),
        swarm("corvid", [bot({ name: "pilot", is_default: true }), bot({ name: "b" })]),
        swarm("down", [], { reachable: false }),
      ],
      listening: ["atlas", "corvid", "down"],
      pinned: [],
      folded: ["atlas", "down"],
    });
    expect(layout.sections.map((s) => [s.instance, s.folded])).toEqual([
      ["atlas", true],
      ["corvid", false],
      ["down", false],
    ]);
    expect(homeItems(layout.sections).map((i) => i.key)).toEqual([
      "section:atlas",
      "section:corvid",
      "corvid/b",
      "section:down",
    ]);
  });

  test("nothing listened: no hero and no sections", () => {
    expect(homeRows({ swarms: [], listening: [], pinned: [] })).toEqual({
      hero: [],
      heroPinned: false,
      sections: [],
    });
  });

  test("homeRowsByKey: every listed bot, hero defaults included", () => {
    const rows = homeRowsByKey({
      swarms: [swarm("atlas", [bot({ name: "ops", is_default: true }), bot({ name: "a" })])],
      listening: ["atlas"],
    });
    expect([...rows.keys()].sort()).toEqual(["atlas/a", "atlas/ops"]);
  });
});

describe("inbox-derived marks", () => {
  const T = (h: number) => at(2026, 9, 14, h);

  test("failed: the latest unread outcome per bot", () => {
    const failed = failedBots([
      inboxEntry({ id: "i3", kind: "turn.error", bot: "a", at: T(12) }),
      inboxEntry({ id: "i2", kind: "turn.done", bot: "b", at: T(11) }),
      inboxEntry({ id: "i1", kind: "turn.error", bot: "b", at: T(10) }),
      inboxEntry({ id: "i0", kind: "turn.error", bot: "c", at: T(9), read_at: T(13) }),
    ]);
    expect([...failed]).toEqual(["atlas/a"]);
  });

  test("needs-you comes from an unread needs_action entry, though the roster says false", () => {
    const entries = [
      inboxEntry({ id: "i2", kind: "needs_action", bot: "a", at: T(12) }),
      inboxEntry({ id: "i1", kind: "needs_action", bot: "b", at: T(11), read_at: T(12) }),
      inboxEntry({ id: "i0", kind: "turn.done", bot: "c", at: T(10) }),
    ];
    const needs = needsBots(entries);
    expect([...needs]).toEqual(["atlas/a"]);
    const layout = homeRows({
      swarms: [
        swarm("atlas", [
          bot({ name: "ops", is_default: true, last_message_at: T(14) }),
          bot({ name: "a", needs_action: false, last_message_at: T(1) }),
          bot({ name: "b", needs_action: false, last_message_at: T(13) }),
        ]),
      ],
      listening: ["atlas"],
      pinned: [],
      unreadOf: (_i, b) => (b === "a" ? 1 : 0),
      needs,
    });
    const rows = layout.sections[0]!.rows;
    expect(rows.map((r) => [r.bot.name, r.badge])).toEqual([
      ["a", "!"],
      ["b", null],
    ]);
    expect(layout.sections[0]!.needs).toBe(true);
  });

  test("clearable: Mark read is offered only when it clears something", () => {
    const layout = homeRows({
      swarms: [
        swarm("atlas", [
          bot({ name: "ops", is_default: true }),
          // The roster's own needs flag (fixture) is not the phone's to clear.
          bot({ name: "rosterNeeds", needs_action: true }),
          bot({ name: "unread", unread: 2 }),
          bot({ name: "inbox" }),
          bot({ name: "failed" }),
          bot({ name: "plain" }),
        ]),
      ],
      listening: ["atlas"],
      pinned: [],
      unreadOf: (_i, b) => (b === "inbox" ? 1 : 0),
      failed: new Set(["atlas/failed"]),
    });
    expect(Object.fromEntries(layout.sections[0]!.rows.map((r) => [r.bot.name, r.clearable]))).toEqual({
      rosterNeeds: false,
      unread: true,
      inbox: true,
      failed: true,
      plain: false,
    });
  });

  test("marking the thread read clears the inbox's needs, unread and failed marks", () => {
    const inbox = new InboxStore(memoryFile(), () => T(15));
    inbox.ingest({ ...inboxEntry({ kind: "needs_action", bot: "a", at: T(12), dedupe: "d1" }) });
    inbox.ingest({ ...inboxEntry({ kind: "turn.error", bot: "a", at: T(11), dedupe: "d2" }) });
    const input = () => ({
      swarms: [swarm("atlas", [bot({ name: "ops", is_default: true }), bot({ name: "a" })])],
      listening: ["atlas"],
      pinned: [],
      unreadOf: inbox.unreadFor,
      failed: failedBots(inbox.getState().entries),
      needs: needsBots(inbox.getState().entries),
    });
    expect(homeRows(input()).sections[0]!.rows[0]).toMatchObject({
      badge: "!",
      failed: true,
      clearable: true,
    });
    inbox.markThreadRead("atlas", "a");
    expect(homeRows(input()).sections[0]!.rows[0]).toMatchObject({
      badge: null,
      failed: false,
      clearable: false,
    });
  });
});

describe("sectionState", () => {
  test("nothing said while it answers; else the telling fleet word, or unreachable", () => {
    expect(sectionState(true, "ready")).toEqual({ word: null, status: "ready" });
    expect(sectionState(true, "degraded")).toEqual({ word: null, status: "degraded" });
    expect(sectionState(true, "unreachable")).toEqual({ word: null, status: "ready" });
    expect(sectionState(false, "stopped")).toEqual({ word: "stopped", status: "stopped" });
    expect(sectionState(false, "ready")).toEqual({ word: "unreachable", status: "unreachable" });
    expect(sectionState(false, null)).toEqual({ word: "unreachable", status: "unreachable" });
  });
});

describe("pins persist; the old primary does not", () => {
  const source = () => ({
    swarms: async () => ({ swarms: [] }),
    listening: async () => ({ instances: [] }),
    listen: async () => ({ instances: [] }),
  });

  test("pins round-trip through the prefs storage, per fleet", async () => {
    const kv = memoryKv();
    const first = new RosterStore(source(), rosterPrefsStorage(kv));
    await first.setFleet("fxtr0001");
    first.togglePinned("atlas", "scribe");
    await Promise.resolve();
    const second = new RosterStore(source(), rosterPrefsStorage(kv));
    await second.setFleet("fxtr0001");
    expect(second.getState().prefs).toEqual({ pinned: ["atlas/scribe"], folded: [] });
    const other = new RosterStore(source(), rosterPrefsStorage(kv));
    await other.setFleet("sg7k2m4p");
    expect(other.getState().prefs).toEqual({ pinned: [], folded: [] });
  });

  test("a save from the primary-bot build still loads, without the primary", async () => {
    const kv = memoryKv({
      "hermetic.rail.fxtr0001": JSON.stringify({ pinned: ["a/b"], folded: ["x"], primary: "a/c" }),
    });
    const store = new RosterStore(source(), rosterPrefsStorage(kv));
    await store.setFleet("fxtr0001");
    expect(store.getState().prefs).toEqual({ pinned: ["a/b"], folded: ["x"] });
    // A storage that hands back extra fields does not leak them into prefs either.
    const loose = new RosterStore(source(), {
      load: async () => ({ pinned: [], folded: [], primary: "a/c" }) as never,
      save: async () => {},
    });
    await loose.setFleet("fxtr0001");
    expect(loose.getState().prefs).toEqual({ pinned: [], folded: [] });
  });
});
