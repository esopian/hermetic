import {
  failedBots,
  homePreview,
  homeRows,
  homeTime,
  resolvePrimary,
} from "../../src/client/home-rows.ts";
import { RosterStore } from "../../src/client/roster-store.ts";
import { memoryKv, rosterPrefsStorage } from "../../src/fleet/store.ts";
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

describe("resolvePrimary", () => {
  const swarms = [
    swarm("atlas", [bot({ name: "scribe" }), bot({ name: "ops", is_default: true })]),
    swarm("corvid", [bot({ name: "pilot", is_default: true })]),
  ];

  test("the stored choice wins while its bot is still listened", () => {
    expect(resolvePrimary(swarms, ["atlas", "corvid"], "corvid/pilot")).toBe("corvid/pilot");
  });

  test("else the default bot of the first listened instance, in listening order", () => {
    expect(resolvePrimary(swarms, ["atlas", "corvid"], null)).toBe("atlas/ops");
    expect(resolvePrimary(swarms, ["corvid", "atlas"], null)).toBe("corvid/pilot");
  });

  test("a stored bot that is gone, or no longer listened, falls back", () => {
    expect(resolvePrimary(swarms, ["atlas", "corvid"], "atlas/gone")).toBe("atlas/ops");
    expect(resolvePrimary(swarms, ["atlas"], "corvid/pilot")).toBe("atlas/ops");
  });

  test("a stored bot whose box is down stays primary: absence proves nothing", () => {
    const down = [swarms[0]!, swarm("corvid", [], { reachable: false })];
    expect(resolvePrimary(down, ["atlas", "corvid"], "corvid/pilot")).toBe("corvid/pilot");
  });

  test("no default bot: the first bot; nothing listened: none", () => {
    const plain = [swarm("atlas", [bot({ name: "a" }), bot({ name: "b" })])];
    expect(resolvePrimary(plain, ["atlas"], null)).toBe("atlas/a");
    expect(resolvePrimary([], [], "atlas/a")).toBeNull();
    // Swarms of instances no longer listened are ignored.
    expect(resolvePrimary(plain, [], null)).toBeNull();
  });
});

describe("homeRows", () => {
  const T = (h: number) => at(2026, 9, 14, h);

  test("hero apart, pinned under it, then needs-you, unread, newest, name", () => {
    const swarms = [
      swarm("atlas", [
        bot({ name: "ops", is_default: true, last_message_at: T(14) }),
        bot({ name: "old", title: "Old", last_message_at: T(8) }),
        bot({ name: "new", title: "New", last_message_at: T(12) }),
        bot({ name: "zed", title: "Zed" }),
        bot({ name: "abe", title: "Abe" }),
        bot({ name: "unr", title: "Unr", unread: 2, last_message_at: T(7) }),
        bot({ name: "nee", title: "Nee", needs_action: true, last_message_at: T(6) }),
        bot({ name: "pin", title: "Pin", last_message_at: T(1) }),
      ]),
    ];
    const layout = homeRows({
      swarms,
      listening: ["atlas"],
      pinned: ["atlas/pin", "atlas/ops"],
      primary: null,
    });
    expect(layout.hero?.key).toBe("atlas/ops");
    // The hero is never repeated, even when pinned.
    expect(layout.rows.map((r) => r.bot.name)).toEqual([
      "pin",
      "nee",
      "unr",
      "new",
      "old",
      "abe",
      "zed",
    ]);
    expect(layout.rows[0]).toMatchObject({ pinned: true });
    expect(layout.rows.find((r) => r.bot.name === "nee")?.badge).toBe("!");
    expect(layout.rows.find((r) => r.bot.name === "unr")?.badge).toBe("2");
    expect(layout.rows.find((r) => r.bot.name === "old")?.badge).toBeNull();
  });

  test("the inbox's unread lifts a bot the roster has not caught up on", () => {
    const swarms = [
      swarm("atlas", [
        bot({ name: "ops", is_default: true }),
        bot({ name: "a", last_message_at: T(12) }),
        bot({ name: "b", last_message_at: T(1) }),
      ]),
    ];
    const layout = homeRows({
      swarms,
      listening: ["atlas"],
      pinned: [],
      primary: null,
      unreadOf: (_i, b) => (b === "b" ? 1 : 0),
    });
    expect(layout.rows.map((r) => [r.bot.name, r.badge])).toEqual([
      ["b", "1"],
      ["a", null],
    ]);
  });

  test("the instance suffix: only with two instances, or two bots of one name", () => {
    const one = homeRows({
      swarms: [
        swarm("atlas", [
          bot({ name: "ops", is_default: true }),
          bot({ name: "x", title: "Clio" }),
          bot({ name: "y", title: "clio" }),
          bot({ name: "z", title: "Solo" }),
        ]),
      ],
      listening: ["atlas"],
      pinned: [],
      primary: null,
    });
    expect(Object.fromEntries(one.rows.map((r) => [r.bot.name, r.suffix]))).toEqual({
      x: "atlas",
      y: "atlas",
      z: null,
    });
    const two = homeRows({
      swarms: [swarm("atlas", [bot({ name: "ops" })]), swarm("corvid", [bot({ name: "pilot" })])],
      listening: ["atlas", "corvid"],
      pinned: [],
      primary: "atlas/ops",
    });
    expect(two.hero?.suffix).toBe("atlas");
    expect(two.rows.map((r) => r.suffix)).toEqual(["corvid"]);
  });

  test("failed turns mark their rows; a down box is listed and its stored hero kept", () => {
    const failed = failedBots([
      inboxEntry({ id: "i3", kind: "turn.error", bot: "a", at: T(12) }),
      inboxEntry({ id: "i2", kind: "turn.done", bot: "b", at: T(11) }),
      inboxEntry({ id: "i1", kind: "turn.error", bot: "b", at: T(10) }),
      inboxEntry({ id: "i0", kind: "turn.error", bot: "c", at: T(9), read_at: T(13) }),
    ]);
    expect([...failed]).toEqual(["atlas/a"]);
    const layout = homeRows({
      swarms: [
        swarm("atlas", [bot({ name: "a" }), bot({ name: "b" }), bot({ name: "c" })]),
        swarm("corvid", [], { reachable: false, unreachable_reason: "TIMEOUT: no answer" }),
      ],
      listening: ["atlas", "corvid"],
      pinned: [],
      primary: "corvid/pilot",
      failed,
    });
    expect(layout.hero).toMatchObject({ key: "corvid/pilot", reachable: false });
    expect(layout.rows.map((r) => [r.bot.name, r.failed])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
    expect(layout.down).toEqual([{ instance: "corvid", reason: "TIMEOUT: no answer" }]);
  });

  test("nothing listened: no hero and no rows", () => {
    expect(homeRows({ swarms: [], listening: [], pinned: [], primary: null })).toEqual({
      hero: null,
      rows: [],
      down: [],
    });
  });
});

describe("the primary bot persists", () => {
  const source = () => ({
    swarms: async () => ({ swarms: [] }),
    listening: async () => ({ instances: [] }),
    listen: async () => ({ instances: [] }),
  });

  test("setPrimary round-trips through the prefs storage, per fleet", async () => {
    const kv = memoryKv();
    const first = new RosterStore(source(), rosterPrefsStorage(kv));
    await first.setFleet("fxtr0001");
    expect(first.getState().prefs.primary).toBeNull();
    first.setPrimary("corvid", "pilot");
    first.togglePinned("atlas", "scribe");
    await Promise.resolve();

    const second = new RosterStore(source(), rosterPrefsStorage(kv));
    await second.setFleet("fxtr0001");
    expect(second.getState().prefs).toEqual({
      pinned: ["atlas/scribe"],
      folded: [],
      primary: "corvid/pilot",
    });
    second.setPrimary("corvid", null);
    expect(second.getState().prefs.primary).toBeNull();

    const other = new RosterStore(source(), rosterPrefsStorage(kv));
    await other.setFleet("sg7k2m4p");
    expect(other.getState().prefs.primary).toBeNull();
  });

  test("a save from before the primary bot reads as not chosen", async () => {
    const kv = memoryKv({ "hermetic.rail.fxtr0001": JSON.stringify({ pinned: ["a/b"], folded: [] }) });
    const store = new RosterStore(source(), rosterPrefsStorage(kv));
    await store.setFleet("fxtr0001");
    expect(store.getState().prefs).toEqual({ pinned: ["a/b"], folded: [], primary: null });
  });
});
