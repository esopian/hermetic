import {
  DedupeSet,
  NotificationsStore,
  alertFor,
  chatThreadOf,
  dedupeKey,
  isWatchingThread,
  unreadChatByConversation,
} from "../../src/client/notifications-store.ts";
import { notification } from "../helpers/fixtures.ts";

describe("watching", () => {
  test("chatThreadOf splits on the first slash, chat rows only", () => {
    expect(chatThreadOf({ kind: "chat.message", ref: "atlas/scribe" })).toEqual({
      instance: "atlas",
      bot: "scribe",
    });
    expect(chatThreadOf({ kind: "chat.message", ref: "atlas/" })).toBeNull();
    expect(chatThreadOf({ kind: "agent.health", ref: "atlas/scribe" })).toBeNull();
  });

  test("isWatchingThread needs focus and the same thread", () => {
    const row = { kind: "chat.message", ref: "atlas/scribe" };
    expect(isWatchingThread(row, { instance: "atlas", bot: "scribe", focused: true })).toBe(true);
    expect(isWatchingThread(row, { instance: "atlas", bot: "scribe", focused: false })).toBe(false);
    expect(isWatchingThread(row, { instance: "atlas", bot: "other", focused: true })).toBe(false);
    expect(isWatchingThread(row, null)).toBe(false);
  });

  test("unreadChatByConversation skips read, resolved and muted rows", () => {
    const counts = unreadChatByConversation([
      notification({ id: "1" }),
      notification({ id: "2" }),
      notification({ id: "3", read_at: "2026-10-13T10:00:00Z" }),
      notification({ id: "4", muted: true }),
      notification({ id: "5", resolved_at: "2026-10-13T10:00:00Z" }),
      notification({ id: "6", kind: "agent.health", ref: "atlas/scribe" }),
    ]);
    expect([...counts]).toEqual([["atlas/scribe", 2]]);
  });
});

describe("dedupe and the alert decision", () => {
  test("DedupeSet claims once and stays bounded", () => {
    const set = new DedupeSet(2);
    expect(set.claim("a")).toBe(true);
    expect(set.claim("a")).toBe(false);
    set.claim("b");
    set.claim("c");
    expect(set.size).toBe(2);
    expect(set.has("a")).toBe(false);
  });

  test("foreground → banner, background → local, a second delivery → none", () => {
    const set = new DedupeSet();
    const row = notification();
    expect(
      alertFor({ dedupe: dedupeKey.notification("n1"), row, phase: "active", watched: null }, set),
    ).toBe("banner");
    expect(
      alertFor({ dedupe: dedupeKey.notification("n1"), row, phase: "background", watched: null }, set),
    ).toBe("none");
    expect(
      alertFor({ dedupe: dedupeKey.turnDone("T1"), phase: "background", watched: null }, set),
    ).toBe("local");
  });

  test("a push and a socket frame for the same event collapse to one alert", () => {
    const set = new DedupeSet();
    // The push arrived first (the RN layer claims its data.dedupe)…
    expect(set.claim("req:r1")).toBe(true);
    // …so the socket frame for the same request stays silent.
    expect(alertFor({ dedupe: dedupeKey.request("r1"), phase: "background", watched: null }, set)).toBe(
      "none",
    );
  });

  test("watching the thread suppresses (and claims) the alert", () => {
    const set = new DedupeSet();
    const watched = { instance: "atlas", bot: "scribe", focused: true };
    expect(
      alertFor(
        {
          dedupe: "turn:T1:done",
          thread: { instance: "atlas", bot: "scribe" },
          phase: "active",
          watched,
        },
        set,
      ),
    ).toBe("none");
    expect(set.has("turn:T1:done")).toBe(true);
    // Backgrounded, the same conversation is not being watched.
    expect(
      alertFor(
        {
          dedupe: "turn:T2:done",
          thread: { instance: "atlas", bot: "scribe" },
          phase: "background",
          watched,
        },
        set,
      ),
    ).toBe("local");
  });

  test("muted or resolved rows never alert", () => {
    const set = new DedupeSet();
    expect(
      alertFor(
        { dedupe: "notif:a", row: notification({ muted: true }), phase: "active", watched: null },
        set,
      ),
    ).toBe("none");
    expect(
      alertFor(
        {
          dedupe: "notif:b",
          row: notification({ resolved_at: "2026-10-13T10:00:00Z" }),
          phase: "active",
          watched: null,
        },
        set,
      ),
    ).toBe("none");
  });
});

describe("NotificationsStore", () => {
  function setup() {
    const source = {
      list: jest.fn(async () => ({
        notifications: [
          notification({ id: "a", at: "2026-10-13T09:00:00Z" }),
          notification({ id: "b", at: "2026-10-13T10:00:00Z" }),
        ],
        unread: 2,
        needs_action: 0,
        snoozed: 0,
        history: 0,
        next_snooze_at: null,
        mutes: [],
      })),
      ack: jest.fn(async () => ({ acked: 1 })),
    };
    return { source, store: new NotificationsStore(source) };
  }

  test("refresh sorts newest first, counts, badge, and pre-claims listed rows", async () => {
    const { store } = setup();
    await store.refresh();
    expect(store.getState().rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(store.badgeCount()).toBe(2);
    expect(store.unreadFor("atlas", "scribe")).toBe(2);
    expect(store.dedupe.has("notif:a")).toBe(true);
  });

  test("ingest upserts and takes the bridge's counts", async () => {
    const { store } = setup();
    await store.refresh();
    expect(
      store.ingest(notification({ id: "c", at: "2026-10-13T11:00:00Z" }), {
        unread: 3,
        needs_action: 1,
      }),
    ).toBe(true);
    expect(
      store.ingest(notification({ id: "c", at: "2026-10-13T11:00:00Z", title: "edited" }), {
        unread: 3,
        needs_action: 1,
      }),
    ).toBe(false);
    expect(store.getState().rows[0]).toMatchObject({ id: "c", title: "edited" });
    expect(store.getState().counts).toEqual({ unread: 3, needs_action: 1 });
  });

  test("ackThread marks a conversation's rows read optimistically", async () => {
    const { store, source } = setup();
    await store.refresh();
    await store.ackThread("atlas", "scribe");
    expect(source.ack).toHaveBeenCalledWith({ ids: ["b", "a"] });
    expect(store.getState().counts.unread).toBe(0);
    expect(store.unreadFor("atlas", "scribe")).toBe(0);
  });
});
