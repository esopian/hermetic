/**
 * `hermetic inbox`'s rendering (§9, §4.9).
 *
 * The rows are pure functions of a `Notification` so the thing an operator
 * actually reads can be asserted without a fleet, a fixture home or a spawned
 * process — `cli.test.ts` owns the spawned `--json` contract, and this owns the
 * human column.
 *
 * What it is here to pin: a condition that has since cleared must not read like
 * one that still holds. A resolved row says `cleared` where its class would go
 * and carries when it went, and none of that touches the unread marker, because
 * `read_at` is the operator's acknowledgement and `resolved_at` is the world's.
 */
import { describe, expect, test } from "bun:test";
import type { Notification } from "@hermetic/core";
import { inboxFooter, inboxRow, marks } from "../src/commands/inbox.ts";

const NOW = Date.parse("2026-09-16T12:00:00.000Z");

function row(over: Partial<Notification> = {}): Notification {
  return {
    id: "ntf000000001",
    at: "2026-09-16T09:00:00.000Z",
    source: "fleet",
    kind: "fleet.advisory",
    class: "needs_action",
    title: "Foundation update available",
    detail: "on v6, this build ships v7",
    agent: null,
    fleet_id: "fxtr0001",
    ref: null,
    key: "fleet.advisory:foundation_update",
    actions: [],
    read_at: null,
    resolved_at: null,
    muted: false,
    ...over,
  };
}

describe("the STATE column", () => {
  test("a live row is the unread marker, the mute marker and the class", () => {
    expect(marks(row())).toBe("* needs_action");
    expect(marks(row({ muted: true }))).toBe("*~needs_action");
    expect(marks(row({ read_at: "2026-09-16T11:00:00.000Z" }))).toBe("  needs_action");
  });

  test("a cleared condition says so instead of naming the class it was raised at", () => {
    const cleared = row({ resolved_at: "2026-09-16T11:40:00.000Z" });
    expect(marks(cleared)).toBe("* cleared");
    // Cleared is not read: nobody acknowledged this, and the star still says so.
    expect(marks({ ...cleared, read_at: "2026-09-16T11:50:00.000Z" })).toBe("  cleared");
  });
});

describe("the row", () => {
  test("a live row is id, age, state, agent and the title with its detail", () => {
    expect(inboxRow(row({ agent: "atlas" }), NOW)).toEqual([
      "ntf000000001",
      "3h",
      "* needs_action",
      "atlas",
      "Foundation update available — on v6, this build ships v7",
    ]);
  });

  test("a cleared row says when it cleared, after the text core wrote", () => {
    const out = inboxRow(row({ resolved_at: "2026-09-16T11:40:00.000Z" }), NOW);
    expect(out[2]).toBe("* cleared");
    expect(out[4]).toBe("Foundation update available — on v6, this build ships v7 (cleared 20m ago)");
  });

  test("a row with no detail, and an unparseable resolved stamp, still render", () => {
    const out = inboxRow(row({ detail: null, resolved_at: "not a date" }), NOW);
    expect(out[4]).toBe("Foundation update available (cleared)");
  });
});

describe("the footer", () => {
  test("core's two counts, and nothing else, when nothing shown has cleared", () => {
    expect(inboxFooter(3, 1, [row(), row()])).toBe("3 unread, 1 needing action");
  });

  /**
   * The cleared tally is scoped out loud: `unread` and `needing action` are
   * core's, over the whole inbox, while this one can only be counted over the
   * page that was printed.
   */
  test("cleared rows are tallied against what was shown, and say so", () => {
    const rows = [row(), row({ resolved_at: "2026-09-16T11:40:00.000Z" })];
    expect(inboxFooter(2, 1, rows)).toBe("2 unread, 1 needing action · 1 of 2 shown already cleared");
  });
});
