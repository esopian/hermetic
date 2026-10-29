import {
  type RosterSnapshot,
  RosterStore,
  bucketSignal,
  compareBots,
  compareBuckets,
  railUnread,
  rosterFooter,
  rosterLayout,
  unreadBadge,
} from "../../src/client/roster-store.ts";
import { bot, swarm } from "../helpers/fixtures.ts";

describe("rail rules", () => {
  test("railUnread is the max of roster and inbox, never the sum", () => {
    expect(railUnread({ unread: 2 }, 3)).toBe(3);
    expect(railUnread({ unread: 2 }, 1)).toBe(2);
    expect(railUnread({ unread: 0 }, -4)).toBe(0);
  });

  test("unreadBadge: ! for needs-you, else the count, else nothing", () => {
    expect(unreadBadge({ unread: 5, needs_action: true })).toBe("!");
    expect(unreadBadge({ unread: 0, needs_action: false }, 2)).toBe("2");
    expect(unreadBadge({ unread: 0, needs_action: false })).toBeNull();
  });

  test("compareBots: needs, unread, newest, default, name", () => {
    const rows = [
      bot({ name: "e" }),
      bot({ name: "d", is_default: true }),
      bot({ name: "c", last_message_at: "2026-10-13T09:00:00Z" }),
      bot({ name: "b", unread: 1 }),
      bot({ name: "a", needs_action: true }),
      bot({ name: "aa" }),
    ].sort(compareBots);
    expect(rows.map((b) => b.name)).toEqual(["a", "b", "c", "d", "aa", "e"]);
  });

  test("compareBuckets: unreachable sinks", () => {
    const base = { needsAction: false, unread: 0, lastAt: null };
    const sorted = [
      { ...base, instance: "a", reachable: false, needsAction: true },
      { ...base, instance: "b", reachable: true },
      { ...base, instance: "c", reachable: true, unread: 2 },
    ].sort(compareBuckets);
    expect(sorted.map((b) => b.instance)).toEqual(["c", "b", "a"]);
  });

  test("bucketSignal counts needs and unread", () => {
    expect(bucketSignal([bot({ needs_action: true }), bot({ unread: 3 })], (b) => b.unread)).toEqual({
      unread: 3,
      needs: 1,
    });
  });
});

describe("rosterLayout", () => {
  const swarms = [
    swarm("atlas", [bot({ name: "scribe", unread: 2 }), bot({ name: "default", is_default: true })]),
    swarm("kestrel", [bot({ name: "ops", needs_action: true })]),
    swarm("ember", [], { reachable: false, unreachable_reason: "off the tailnet" }),
  ];

  test("buckets ordered, unreachable kept and sunk, counts", () => {
    const layout = rosterLayout(swarms);
    expect(layout.buckets.map((b) => b.instance)).toEqual(["kestrel", "atlas", "ember"]);
    expect(layout.buckets[2]).toMatchObject({ reachable: false, reason: "off the tailnet", bots: [] });
    expect(layout.needsYou).toBe(1);
    expect(layout.botCount).toBe(3);
    expect(rosterFooter(layout)).toEqual({ roster: "3 instances · 3 bots", attention: "1 needs you" });
  });

  test("pinned bots are lifted out of their buckets in pin order", () => {
    const layout = rosterLayout(swarms, { pinned: ["kestrel/ops", "atlas/default", "gone/bot"] });
    expect(layout.pinned.map((b) => b.name)).toEqual(["ops", "default"]);
    expect(layout.buckets.map((b) => b.instance)).toEqual(["atlas", "ember"]);
    expect(layout.buckets[0]!.bots.map((b) => b.name)).toEqual(["scribe"]);
  });

  test("filters and search", () => {
    expect(rosterLayout(swarms, { filter: "needs" }).buckets.map((b) => b.instance)).toEqual([
      "kestrel",
      "ember",
    ]);
    const unread = rosterLayout(swarms, {
      filter: "unread",
      unreadOf: (i, b) => (i === "atlas" && b === "default" ? 1 : 0),
    });
    expect(unread.buckets.find((b) => b.instance === "atlas")!.bots.map((b) => b.name)).toEqual([
      "scribe",
      "default",
    ]);
    expect(rosterLayout(swarms, { query: "SCRI" }).buckets[0]!.bots.map((b) => b.name)).toEqual([
      "scribe",
    ]);
  });

  test("folds apply only when reachable and not searching", () => {
    expect(
      rosterLayout(swarms, { folded: ["atlas"] }).buckets.find((b) => b.instance === "atlas")!.folded,
    ).toBe(true);
    expect(
      rosterLayout(swarms, { folded: ["atlas"], query: "s" }).buckets.find(
        (b) => b.instance === "atlas",
      )!.folded,
    ).toBe(false);
  });
});

describe("RosterStore", () => {
  function source() {
    let listening = ["atlas"];
    return {
      swarms: jest.fn(async () => ({ swarms: [swarm("atlas", [bot({ unread: 1 })])] })),
      listening: jest.fn(async () => ({ instances: listening })),
      listen: jest.fn(async (instance: string, on: boolean) => {
        listening = on ? [...listening, instance] : listening.filter((i) => i !== instance);
        return { instances: listening };
      }),
    };
  }

  test("refresh reads swarms and listening", async () => {
    const store = new RosterStore(source(), null, () => 42);
    expect(await store.refresh()).toBe(true);
    expect(store.getState()).toMatchObject({ listening: ["atlas"], readAt: 42, error: null });
    expect(store.layout().buckets).toHaveLength(1);
  });

  test("listen is optimistic and snaps back on refusal", async () => {
    const src = source();
    const store = new RosterStore(src, null);
    await store.refresh();
    src.listen.mockRejectedValueOnce(new Error("FORBIDDEN"));
    const p = store.listen("kestrel", true);
    expect(store.getState().listening).toEqual(["atlas", "kestrel"]);
    await expect(p).rejects.toThrow("FORBIDDEN");
    expect(store.getState().listening).toEqual(["atlas"]);
  });

  test("pins persist per fleet", async () => {
    const saved: unknown[] = [];
    const store = new RosterStore(source(), {
      load: async () => ({ pinned: ["atlas/x"], folded: [] }),
      save: async (fleet, prefs) => {
        saved.push([fleet, prefs]);
      },
    });
    await store.setFleet("fxtr0001");
    expect(store.getState().prefs.pinned).toEqual(["atlas/x"]);
    store.togglePinned("atlas", "scribe");
    store.togglePinned("atlas", "x");
    expect(saved.at(-1)).toEqual(["fxtr0001", { pinned: ["atlas/scribe"], folded: [] }]);
  });

  test("markSeen clears a bot's unread locally", async () => {
    const store = new RosterStore(source(), null);
    await store.refresh();
    store.markSeen("atlas", "scribe");
    expect(store.getState().swarms[0]!.bots[0]!.unread).toBe(0);
  });

  test("readAt is when the read started, not when the slowest box answered", async () => {
    let clock = 100;
    let answer!: () => void;
    const src = {
      ...source(),
      swarms: () =>
        new Promise<{ swarms: ReturnType<typeof swarm>[] }>((resolve) => {
          answer = () => resolve({ swarms: [swarm("atlas", [bot()])] });
        }),
    };
    const store = new RosterStore(src, null, () => clock);
    const read = store.refresh();
    clock = 9_000;
    answer();
    await read;
    expect(store.getState().readAt).toBe(100);
  });

  test("a box that does not answer keeps its last-listed bots, unreachable, marks and all", async () => {
    let up = true;
    const src = {
      ...source(),
      swarms: async () => ({
        swarms: [
          up
            ? swarm("atlas", [bot({ unread: 3 }), bot({ name: "ops" })])
            : swarm("atlas", [], { reachable: false, unreachable_reason: "CHAT_UNREACHABLE: timeout" }),
        ],
      }),
    };
    const store = new RosterStore(src, null);
    await store.refresh();
    up = false;
    await store.refresh();
    const [down] = store.getState().swarms;
    expect(down).toMatchObject({ reachable: false, unreachable_reason: "CHAT_UNREACHABLE: timeout" });
    expect(down!.bots.map((b) => [b.name, b.unread])).toEqual([
      ["scribe", 3],
      ["ops", 0],
    ]);
    // Still down on the next read: still kept.
    await store.refresh();
    expect(store.getState().swarms[0]!.bots).toHaveLength(2);
    up = true;
    await store.refresh();
    expect(store.getState().swarms[0]!.reachable).toBe(true);
  });

  test("a read saves what each box listed and when it answered; a cold start draws it unreachable", async () => {
    let saved: RosterSnapshot | null = null;
    const cache = {
      load: jest.fn(async () => saved),
      save: jest.fn(async (_fleet: string, snapshot: RosterSnapshot) => {
        saved = snapshot;
      }),
    };
    const first = new RosterStore(source(), null, () => 500, cache);
    await first.setFleet("fxtr0001");
    await first.refresh();
    expect(first.getState().answeredAt).toEqual({ atlas: 500 });
    expect(saved).toMatchObject({ answeredAt: { atlas: 500 }, swarms: [{ instance: "atlas" }] });

    // The next launch: nothing read yet, the saved rows are drawn, every box unreachable.
    const never = {
      ...source(),
      swarms: () => new Promise<{ swarms: ReturnType<typeof swarm>[] }>(() => {}),
    };
    const next = new RosterStore(never, null, () => 900, cache);
    await next.setFleet("fxtr0001");
    const state = next.getState();
    expect(state.readAt).toBeNull();
    expect(state.answeredAt).toEqual({ atlas: 500 });
    expect(state.swarms.map((s) => [s.instance, s.reachable, s.bots.length])).toEqual([
      ["atlas", false, 1],
    ]);
  });

  test("a saved roster never replaces a read that already landed", async () => {
    const cache = {
      load: async () => ({
        swarms: [swarm("atlas", [bot({ name: "old" })])],
        answeredAt: { atlas: 1 },
      }),
      save: async () => {},
    };
    const store = new RosterStore(source(), null, () => 42, cache);
    await store.refresh();
    await store.setFleet("fxtr0001");
    expect(store.getState().swarms[0]).toMatchObject({ reachable: true });
    expect(store.getState().swarms[0]!.bots.map((b) => b.name)).toEqual(["scribe"]);
  });

  test("a bot waiting on the operator reads needs-you until the wait is cleared", async () => {
    const store = new RosterStore(source(), null);
    await store.refresh();
    let changes = 0;
    store.subscribe(() => changes++);
    store.setWaiting(["atlas/scribe"]);
    expect(store.getState().swarms[0]!.bots[0]!.needs_action).toBe(true);
    // Unchanged keys change nothing; a read keeps it; reading the thread does not clear it.
    store.setWaiting(["atlas/scribe"]);
    expect(changes).toBe(1);
    await store.refresh();
    store.markSeen("atlas", "scribe");
    expect(store.getState().swarms[0]!.bots[0]!.needs_action).toBe(true);
    store.setWaiting([]);
    expect(store.getState().swarms[0]!.bots[0]!.needs_action).toBe(false);
  });
});

describe("arrivals ahead of the roster (desktop RailBump)", () => {
  function store(swarms: () => ReturnType<typeof swarm>[]) {
    const source = {
      swarms: async () => ({ swarms: swarms() }),
      listening: async () => ({ instances: ["atlas"] }),
      listen: async () => ({ instances: ["atlas"] }),
    };
    return new RosterStore(source);
  }
  const row = (s: RosterStore) => s.getState().swarms[0]!.bots[0]!;

  test("a reply moves preview, role and time, and clears the unread at once", async () => {
    const s = store(() => [swarm("atlas", [bot({ name: "scribe", unread: 2, preview: null })])]);
    await s.refresh();
    expect(row(s).preview ?? null).toBeNull();
    s.noteArrival({
      instance: "atlas",
      bot: "scribe",
      at: "2026-10-13T12:00:00.000Z",
      unread: false,
      preview: { preview: "Deployed.", preview_role: "bot" },
    });
    expect(row(s)).toMatchObject({
      preview: "Deployed.",
      preview_role: "bot",
      last_message_at: "2026-10-13T12:00:00.000Z",
      unread: 0,
    });
  });

  test("an older stamp never moves the time back; no quote keeps the last one", async () => {
    const s = store(() => [
      swarm("atlas", [bot({ name: "scribe", last_message_at: "2026-10-13T12:00:00.000Z" })]),
    ]);
    await s.refresh();
    s.noteArrival({
      instance: "atlas",
      bot: "scribe",
      at: "2026-10-13T13:00:00.000Z",
      unread: true,
      preview: { preview: "first", preview_role: "user" },
    });
    s.noteArrival({
      instance: "atlas",
      bot: "scribe",
      at: "2026-10-13T09:00:00.000Z",
      unread: true,
      preview: null,
    });
    expect(row(s)).toMatchObject({
      preview: "first",
      preview_role: "user",
      last_message_at: "2026-10-13T13:00:00.000Z",
      unread: 2,
    });
  });

  test("a separate session's arrival moves the time and quote, never the Bot Chat's count", async () => {
    const s = store(() => [swarm("atlas", [bot({ name: "scribe", unread: 2 })])]);
    await s.refresh();
    s.noteArrival({
      instance: "atlas",
      bot: "scribe",
      at: "2026-10-13T12:00:00.000Z",
      unread: false,
      preview: null,
      elsewhere: true,
    });
    expect(row(s)).toMatchObject({ unread: 2, last_message_at: "2026-10-13T12:00:00.000Z" });
  });

  test("a roster read that started after the arrival is authoritative; one in flight keeps it", async () => {
    let listed = [swarm("atlas", [bot({ name: "scribe", preview: "old" })])];
    const s = store(() => listed);
    await s.refresh();
    const arrival = {
      instance: "atlas",
      bot: "scribe",
      at: null,
      unread: false,
      preview: { preview: "new", preview_role: "bot" as const },
    };
    // In flight when the arrival lands: the answer cannot include it, so the bump stays.
    const inFlight = s.refresh();
    s.noteArrival(arrival);
    await inFlight;
    expect(row(s).preview).toBe("new");
    // A later read answers for it.
    listed = [swarm("atlas", [bot({ name: "scribe", preview: "from the box" })])];
    await s.refresh();
    expect(row(s).preview).toBe("from the box");
  });
});
