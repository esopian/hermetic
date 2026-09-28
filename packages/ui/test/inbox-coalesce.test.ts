/**
 * Coalescing, counting and the rail's view of the inbox — the rules only.
 *
 * §4.9 keys a `chat.message` row on its own timestamp on purpose, so one busy
 * conversation really is forty rows in the store. That is a storage rule; what
 * a drawer *draws* is this file's subject, and the whole point of keeping it
 * here is that the fold can be proved without mounting a popover.
 */
import { describe, expect, test } from "bun:test";
import {
  centerCounts,
  conversationKeyOf,
  groupNotifications,
  groupRow,
  unreadChatByConversation,
} from "../src/logic/notification-logic.ts";

interface Row {
  id: string;
  at: string;
  kind: string;
  source: string;
  class: "ok" | "info" | "warn" | "bad" | "needs_action";
  ref?: string | null;
  read_at?: string | null;
  resolved_at?: string | null;
  muted?: boolean | null;
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "n1",
    at: "2026-09-19T10:00:00.000Z",
    kind: "chat.message",
    source: "chat",
    class: "info",
    ref: "veronica/default",
    read_at: null,
    resolved_at: null,
    muted: false,
    ...over,
  };
}

describe("conversationKeyOf", () => {
  test("names the conversation, and keeps a message apart from an error", () => {
    expect(conversationKeyOf(row())).toBe("chat.message:veronica/default");
    expect(conversationKeyOf(row({ kind: "chat.error" }))).toBe("chat.error:veronica/default");
    // Not a conversation at all: an operation row groups with nothing.
    expect(conversationKeyOf({ kind: "operation.failed", ref: "op-1" })).toBeNull();
    expect(conversationKeyOf(row({ ref: null }))).toBeNull();
  });
});

describe("groupNotifications", () => {
  test("a run of rows about one conversation becomes one card carrying its count", () => {
    const rows = [
      row({ id: "a", at: "2026-09-19T10:02:00.000Z" }),
      row({ id: "b", at: "2026-09-19T10:01:00.000Z" }),
      row({ id: "c", at: "2026-09-19T10:00:00.000Z" }),
    ];
    const groups = groupNotifications(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(3);
    expect(groups[0]?.latest.id).toBe("a");
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  test("the latest is the newest by time, not by position", () => {
    const groups = groupNotifications([
      row({ id: "old", at: "2026-09-19T10:00:00.000Z" }),
      row({ id: "new", at: "2026-09-19T10:05:00.000Z" }),
    ]);
    expect(groups[0]?.latest.id).toBe("new");
  });

  test("a different conversation breaks the run, and the run can resume after it", () => {
    const groups = groupNotifications([
      row({ id: "a" }),
      row({ id: "b" }),
      row({ id: "x", ref: "atlas/default" }),
      row({ id: "c" }),
    ]);
    // Two cards about one conversation, so the key carries the run's oldest row
    // as well: React keys the cards on it, and the conversation alone repeats.
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ["chat.message:veronica/default@b", 2],
      ["chat.message:atlas/default@x", 1],
      ["chat.message:veronica/default@c", 1],
    ]);
  });

  test("a run's key does not move when a newer row joins it", () => {
    const before = groupNotifications([row({ id: "b" }), row({ id: "c" })]);
    const after = groupNotifications([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);
    expect(after[0]?.key).toBe(before[0]?.key);
  });

  test("rows about no conversation are never folded together", () => {
    const groups = groupNotifications([
      row({ id: "o1", kind: "operation.done", source: "operation", ref: null }),
      row({ id: "o2", kind: "operation.done", source: "operation", ref: null }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["o1", "o2"]);
    expect(groups.every((g) => g.count === 1)).toBe(true);
  });
});

describe("groupRow", () => {
  test("a card whose newest row is read is still unread while any member is", () => {
    const seen = "2026-09-19T10:06:00.000Z";
    const groups = groupNotifications([
      row({ id: "a", at: "2026-09-19T10:05:00.000Z", read_at: seen }),
      row({ id: "b", at: "2026-09-19T10:04:00.000Z" }),
    ]);
    expect(groupRow(groups[0]!).read_at).toBeNull();
  });

  test("a card every member of which is read stays read, and a lone row is untouched", () => {
    const seen = "2026-09-19T10:06:00.000Z";
    const all = groupNotifications([
      row({ id: "a", at: "2026-09-19T10:05:00.000Z", read_at: seen }),
      row({ id: "b", at: "2026-09-19T10:04:00.000Z", read_at: seen }),
    ]);
    expect(groupRow(all[0]!).read_at).toBe(seen);
    const one = groupNotifications([row({ id: "a" })]);
    expect(groupRow(one[0]!)).toBe(one[0]!.latest);
  });
});

describe("centerCounts", () => {
  test("`needs you` is the server's total, not a count of the page held", () => {
    const held = [row({ id: "a", class: "needs_action" })];
    // The drawer holds one; the whole inbox has four.
    expect(centerCounts(held, { needsAction: 4 }).needs_you).toBe(4);
  });

  test("without a server total it falls back to what is held", () => {
    const held = [row({ id: "a", class: "needs_action" }), row({ id: "b" })];
    expect(centerCounts(held).needs_you).toBe(1);
    expect(centerCounts(held, { needsAction: null }).needs_you).toBe(1);
    expect(centerCounts(held).all).toBe(2);
  });
});

describe("unreadChatByConversation", () => {
  test("counts unread chat rows per bot and ignores everything else", () => {
    const counts = unreadChatByConversation([
      row({ id: "a" }),
      row({ id: "b" }),
      row({ id: "c", ref: "atlas/researcher" }),
      row({ id: "read", read_at: "2026-09-19T10:06:00.000Z" }),
      row({ id: "resolved", kind: "chat.error", resolved_at: "2026-09-19T10:06:00.000Z" }),
      row({ id: "muted", muted: true }),
      row({ id: "op", kind: "operation.failed", source: "operation", ref: null }),
    ]);
    expect(counts.get("veronica/default")).toBe(2);
    expect(counts.get("atlas/researcher")).toBe(1);
    expect(counts.size).toBe(2);
  });
});
