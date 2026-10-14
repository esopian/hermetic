import type { MobilePushData } from "@hermetic/core/schema";
import { memoryFile } from "../../src/fleet/store.ts";
import {
  alertFor,
  arrivalFromPush,
  entryLive,
  INBOX_LIMIT,
  InboxStore,
  pushBelongs,
  SAME_EVENT_MS,
} from "../../src/inbox/store.ts";
import { inboxEntry } from "../helpers/fixtures.ts";

const NOW = "2026-10-13T12:00:00.000Z";

function arrival(over: Partial<ReturnType<typeof inboxEntry>> = {}) {
  const { id: _id, read_at: _read, ...rest } = inboxEntry(over);
  return rest;
}

function setup(initial: string | null = null) {
  const file = memoryFile(initial);
  const inbox = new InboxStore(file, () => NOW);
  return { file, inbox };
}

describe("InboxStore", () => {
  test("ingest keeps one entry per dedupe key, newest first, and writes the file", async () => {
    const { file, inbox } = setup();
    expect(inbox.ingest(arrival({ dedupe: "a", at: "2026-10-13T10:00:00.000Z" }))).toBe(true);
    expect(inbox.ingest(arrival({ dedupe: "a", at: "2026-10-13T10:30:00.000Z", session: "s-9" }))).toBe(
      false,
    );
    expect(
      inbox.ingest(arrival({ dedupe: "b", kind: "message", at: "2026-10-13T11:00:00.000Z" })),
    ).toBe(true);
    expect(inbox.getState().entries.map((e) => e.dedupe)).toEqual(["b", "a"]);
    await inbox.flushed();
    expect(JSON.parse(file.text() ?? "[]")).toHaveLength(2);
  });

  test("a socket-seen event and the box's push for it are one entry (same conversation, kind, moment)", () => {
    const { inbox } = setup();
    inbox.ingest(arrival({ dedupe: "atlas:s-1:phone-T1:turn.done", at: "2026-10-13T10:00:00.000Z" }));
    const push = arrivalFromPush(
      {
        fleet_id: "fxtr0001",
        instance: "atlas",
        bot: "scribe",
        session: "s-1",
        kind: "turn.done",
        dedupe: "atlas:s-1:4:turn.done",
      } satisfies MobilePushData,
      { title: "scribe", body: "done" },
      new Date(Date.parse("2026-10-13T10:00:00.000Z") + SAME_EVENT_MS - 1).toISOString(),
    );
    expect(inbox.ingest(push)).toBe(false);
    expect(inbox.ingest({ ...push, at: "2026-10-13T10:10:00.000Z" })).toBe(true);
  });

  test("two box pushes of one kind seconds apart are two events: only exact keys fold", () => {
    const { inbox } = setup();
    const push = (count: number, at: string) =>
      arrivalFromPush(
        {
          fleet_id: "fxtr0001",
          instance: "atlas",
          bot: "scribe",
          session: "s-1",
          kind: "needs_action",
          dedupe: `atlas:s-1:${count}:needs_action`,
        },
        { title: "scribe", body: "Approval needed" },
        at,
      );
    expect(inbox.ingest(push(4, "2026-10-13T10:00:00.000Z"))).toBe(true);
    expect(inbox.ingest(push(5, "2026-10-13T10:00:03.000Z"))).toBe(true);
    expect(inbox.ingest(push(5, "2026-10-13T10:00:04.000Z"))).toBe(false);
    expect(inbox.getState().needsAction).toBe(2);
  });

  test("two events this phone saw itself are two entries too, however close", () => {
    const { inbox } = setup();
    inbox.ingest(arrival({ kind: "needs_action", dedupe: "atlas:s-1:phone-r1:needs_action" }));
    expect(
      inbox.ingest(
        arrival({
          kind: "needs_action",
          dedupe: "atlas:s-1:phone-r2:needs_action",
          at: "2026-10-13T10:00:03.000Z",
        }),
      ),
    ).toBe(true);
  });

  test("the last 200 are kept", () => {
    const { inbox } = setup();
    for (let i = 0; i < INBOX_LIMIT + 5; i++)
      inbox.ingest(
        arrival({
          dedupe: `d${i}`,
          session: `s${i}`,
          at: new Date(Date.UTC(2026, 9, 13, 0, i)).toISOString(),
        }),
      );
    const entries = inbox.getState().entries;
    expect(entries).toHaveLength(INBOX_LIMIT);
    expect(entries[0]?.dedupe).toBe(`d${INBOX_LIMIT + 4}`);
  });

  test("unread counts per bot, the badge, and marking a thread read", () => {
    const { inbox } = setup();
    inbox.ingest(arrival({ dedupe: "a", session: "s1" }));
    inbox.ingest(arrival({ dedupe: "b", session: "s2", kind: "needs_action" }));
    inbox.ingest(arrival({ dedupe: "c", session: "s3", bot: "other" }));
    expect(inbox.unreadFor("atlas", "scribe")).toBe(2);
    expect(inbox.badgeCount()).toBe(3);
    expect(inbox.getState().needsAction).toBe(1);
    inbox.markThreadRead("atlas", "scribe");
    expect(inbox.unreadFor("atlas", "scribe")).toBe(0);
    expect(inbox.badgeCount()).toBe(1);
    expect(inbox.getState().entries.find((e) => e.dedupe === "a")?.read_at).toBe(NOW);
  });

  test("entries home cannot show are marked read, so the badge cannot stick", () => {
    const { inbox } = setup();
    const before = "2026-10-13T10:00:00.000Z";
    const after = "2026-10-13T12:30:00.000Z";
    inbox.ingest(arrival({ dedupe: "a", instance: "atlas", bot: "scribe", at: before }));
    // Unlistened instance.
    inbox.ingest(arrival({ dedupe: "b", instance: "kestrel", bot: "x", at: before }));
    // Deleted bot: the box answered after the entry and no longer lists it.
    inbox.ingest(arrival({ dedupe: "c", instance: "atlas", bot: "gone", at: before }));
    // A bot newer than the read: kept, the next read may list it.
    inbox.ingest(arrival({ dedupe: "d", instance: "atlas", bot: "fresh", at: after }));
    // A box that did not answer, or one not read yet: nothing proves its bots gone.
    inbox.ingest(arrival({ dedupe: "e", instance: "corvid", bot: "pilot", at: before }));
    inbox.ingest(arrival({ dedupe: "f", instance: "heron", bot: "h", at: before }));
    expect(inbox.badgeCount()).toBe(6);
    const roster = {
      listening: ["atlas", "corvid", "heron"],
      swarms: [
        { instance: "atlas", reachable: true, bots: [{ name: "scribe" }] },
        { instance: "corvid", reachable: false, bots: [] },
      ] as never,
    };
    inbox.markReadUnless(entryLive(roster, Date.parse(NOW)));
    expect(
      inbox
        .getState()
        .entries.filter((e) => !e.read_at)
        .map((e) => e.dedupe)
        .sort(),
    ).toEqual(["a", "d", "e", "f"]);
    expect(inbox.badgeCount()).toBe(4);
  });

  test("load reads the file back, dropping anything malformed; a broken file is empty", async () => {
    const good = inboxEntry({ id: "i7" });
    const { inbox } = setup(JSON.stringify([good, { id: 3 }, "junk"]));
    await inbox.load();
    expect(inbox.getState().entries).toEqual([good]);
    inbox.ingest(arrival({ dedupe: "new", session: "s-new" }));
    expect(inbox.getState().entries.find((e) => e.dedupe === "new")?.id).toBe("i8");
    const broken = setup("{not json");
    await broken.inbox.load();
    expect(broken.inbox.getState().entries).toEqual([]);
  });

  test("clear empties it and removes the file", async () => {
    const { file, inbox } = setup();
    inbox.ingest(arrival());
    await inbox.flushed();
    await inbox.clear();
    expect(inbox.getState().entries).toEqual([]);
    expect(file.text()).toBeNull();
  });
});

describe("alertFor", () => {
  const event = arrival({ dedupe: "x" });

  test("the conversation on screen never interrupts", () => {
    const { inbox } = setup();
    expect(alertFor(event, inbox, "active", { instance: "atlas", bot: "scribe", focused: true })).toBe(
      "none",
    );
  });

  test("already in the inbox: nothing", () => {
    const { inbox } = setup();
    inbox.ingest(event);
    expect(alertFor(event, inbox, "active", null)).toBe("none");
  });

  test("otherwise a banner in the foreground, a local notification behind", () => {
    const { inbox } = setup();
    expect(alertFor(event, inbox, "active", null)).toBe("banner");
    expect(
      alertFor(event, inbox, "background", { instance: "atlas", bot: "scribe", focused: true }),
    ).toBe("local");
  });
});

describe("pushBelongs", () => {
  const data = {
    fleet_id: "fxtr0001",
    instance: "atlas",
    bot: "scribe",
    session: "s-1",
    kind: "turn.done",
    dedupe: "atlas:s-1:4:turn.done",
  } satisfies MobilePushData;
  const fleet = { fleet_id: "fxtr0001", agents: ["atlas", "corvid"] };

  test("the paired fleet and one of its agents", () => {
    expect(pushBelongs(data, fleet)).toBe(true);
  });

  test("another fleet, or an agent this fleet does not have, does not", () => {
    expect(pushBelongs({ ...data, fleet_id: "sg7k2m4p" }, fleet)).toBe(false);
    expect(pushBelongs({ ...data, instance: "oriole" }, fleet)).toBe(false);
  });
});
