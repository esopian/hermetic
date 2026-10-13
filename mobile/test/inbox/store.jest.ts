import type { MobilePushData } from "@hermetic/core/schema";
import { groupEntries, groupRow, groupUnread } from "../../src/client/inbox-logic.ts";
import { memoryFile } from "../../src/fleet/store.ts";
import {
  alertFor,
  arrivalFromPush,
  INBOX_LIMIT,
  InboxStore,
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

describe("grouping", () => {
  test("consecutive entries about one conversation fold; a card is unread if any member is", () => {
    const rows = [
      inboxEntry({ id: "1", read_at: NOW }),
      inboxEntry({ id: "2" }),
      inboxEntry({ id: "3", bot: "other" }),
    ];
    const groups = groupEntries(rows);
    expect(groups.map((g) => g.count)).toEqual([2, 1]);
    expect(groupUnread(groups[0]!)).toBe(true);
    expect(groupRow(groups[0]!).read_at).toBeNull();
  });
});
