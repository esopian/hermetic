/**
 * `hermetic inbox`'s rendering (§9, §4.9).
 *
 * The rows are pure functions of a `Notification` so the thing an operator
 * actually reads can be asserted without a fleet, a fixture home or a spawned
 * process — `cli.test.ts` owns the spawned `--json` contract, and this owns the
 * human column.
 *
 * What it is here to pin: a condition that has since resolved must not read like
 * one that still holds. A resolved row says `resolved` where its class would go
 * and carries when it went, and none of that touches the unread marker, because
 * `read_at` is the operator's acknowledgement and `resolved_at` is the world's.
 * A row the operator cleared or snoozed says that instead, ahead of either.
 */
import { describe, expect, test } from "bun:test";
import type { Command } from "commander";
import type { Notification } from "@hermetic/core";
import {
  ackInput,
  inboxFooter,
  inboxRow,
  listInput,
  marks,
  onOff,
  snoozeUntil,
  untilLabel,
} from "../src/commands/inbox.ts";
import { ValidationFailure } from "../src/validate.ts";
import { buildProgram } from "../src/program.ts";
import { runningCommand, setGlobalFlags, setRunningCommand } from "../src/context.ts";

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
    cleared_at: null,
    snoozed_until: null,
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

  test("a resolved condition says so instead of naming the class it was raised at", () => {
    const cleared = row({ resolved_at: "2026-09-16T11:40:00.000Z" });
    expect(marks(cleared)).toBe("* resolved");
    // Resolved is not read: nobody acknowledged this, and the star still says so.
    expect(marks({ ...cleared, read_at: "2026-09-16T11:50:00.000Z" })).toBe("  resolved");
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

  test("a resolved row says when it resolved, after the text core wrote", () => {
    const out = inboxRow(row({ resolved_at: "2026-09-16T11:40:00.000Z" }), NOW);
    expect(out[2]).toBe("* resolved");
    expect(out[4]).toBe("Foundation update available — on v6, this build ships v7 (resolved 20m ago)");
  });

  test("a row with no detail, and an unparseable resolved stamp, still render", () => {
    const out = inboxRow(row({ detail: null, resolved_at: "not a date" }), NOW);
    expect(out[4]).toBe("Foundation update available (resolved)");
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
  test("resolved rows are tallied against what was shown, and say so", () => {
    const rows = [row(), row({ resolved_at: "2026-09-16T11:40:00.000Z" })];
    expect(inboxFooter(2, 1, rows)).toBe("2 unread, 1 needing action · 1 of 2 shown already resolved");
  });
});

describe("cleared and snoozed rows", () => {
  test("a cleared row says cleared, ahead of resolved", () => {
    const cleared = row({
      read_at: "2026-09-16T11:50:00.000Z",
      resolved_at: "2026-09-16T11:40:00.000Z",
      cleared_at: "2026-09-16T11:55:00.000Z",
    });
    expect(marks(cleared, NOW)).toBe("  cleared");
  });

  test("an active snooze names when it ends; a lapsed one reads as the class again", () => {
    const until = "2026-09-16T14:30:00.000Z";
    expect(marks(row({ snoozed_until: until }), NOW)).toBe(`* snoozed until ${untilLabel(until, NOW)}`);
    expect(marks(row({ snoozed_until: "2026-09-16T11:00:00.000Z" }), NOW)).toBe("* needs_action");
  });

  test("a moment within a day prints as a time, a later one with its date", () => {
    expect(untilLabel("2026-09-16T14:30:00.000Z", NOW)).toMatch(/^\d\d:\d\d$/);
    expect(untilLabel("2026-09-20T14:30:00.000Z", NOW)).toMatch(/^2026-09-2\d \d\d:\d\d$/);
  });

  test("the footer names snoozed and history totals only when there are some", () => {
    expect(inboxFooter(1, 0, [row()], { snoozed: 2, history: 0 })).toBe(
      "1 unread, 0 needing action · 2 snoozed",
    );
    expect(inboxFooter(1, 0, [row()], { snoozed: 0, history: 5 })).toBe(
      "1 unread, 0 needing action · 5 in history",
    );
  });
});

describe("the snooze and settings arguments", () => {
  test("--for is a duration from now", () => {
    expect(snoozeUntil("4h", NOW)).toBe("2026-09-16T16:00:00.000Z");
    expect(snoozeUntil("1w", NOW)).toBe("2026-09-23T12:00:00.000Z");
    expect(() => snoozeUntil("soon", NOW)).toThrow(ValidationFailure);
  });

  test("on/off map to booleans and anything else is left for the schema to refuse", () => {
    expect(onOff("on")).toBe(true);
    expect(onOff("off")).toBe(false);
    expect(onOff("maybe")).toBe("maybe");
  });
});

/**
 * `inbox` and `inbox ack` both declare `--unread` (and `inbox` its `--all`
 * shorthand beside ack's `--all`), and Commander hands a flag both declare to
 * the parent. These run the real program's parse, with the actions swapped for
 * recorders that build the request the real actions build (`listInput`,
 * `ackInput`). What is under test is argv to request, not core.
 */
describe("inbox and inbox ack each get the flags typed for them", () => {
  type Seen = { command: string; input: unknown };

  async function parse(argv: string[]): Promise<Seen[]> {
    const seen: Seen[] = [];
    const program = buildProgram();
    const inbox = program.commands.find((c) => c.name() === "inbox") as Command;
    const ack = inbox.commands.find((c) => c.name() === "ack") as Command;
    inbox.action((opts: Record<string, unknown>) => {
      seen.push({ command: "inbox", input: listInput(opts) });
    });
    ack.action((ids: string[], _opts: unknown, cmd: Command) => {
      seen.push({ command: "ack", input: ackInput(ids, cmd) });
    });
    program.exitOverride();
    // The real program's preAction hook records the running command and its
    // flags in module state, which later suites in this process read (the
    // foundation check skips some commands). Put both back afterwards.
    const before = runningCommand();
    try {
      await program.parseAsync(argv, { from: "user" });
    } finally {
      setRunningCommand(before.command, before.args);
      setGlobalFlags({});
    }
    return seen;
  }

  test("inbox ack --all is every unread row, with no ids", async () => {
    expect(await parse(["inbox", "ack", "--all"])).toEqual([{ command: "ack", input: { all: true } }]);
  });

  test("inbox ack <id> --unread marks that row unread", async () => {
    expect(await parse(["inbox", "ack", "ntf000000001", "--unread"])).toEqual([
      { command: "ack", input: { ids: ["ntf000000001"], unread: true } },
    ]);
  });

  test("inbox --unread and inbox --view all stay the list's", async () => {
    const list = async (argv: string[]) => {
      const seen = await parse(argv);
      expect(seen.map((s) => s.command)).toEqual(["inbox"]);
      return seen[0]?.input as Record<string, unknown>;
    };
    expect(await list(["inbox", "--unread"])).toMatchObject({ unread: true });
    expect(await list(["inbox", "--view", "all"])).toMatchObject({ view: "all" });
    expect(await list(["inbox", "--all"])).toMatchObject({ view: "all" });
    expect((await list(["inbox", "--view", "all"]))["unread"]).toBeUndefined();
  });

  test("ids and --all together are still refused", async () => {
    await expect(parse(["inbox", "ack", "ntf000000001", "--all"])).rejects.toThrow(ValidationFailure);
  });
});
