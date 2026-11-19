import { describe, expect, test } from "bun:test";
import { mapHistory } from "../src/chat/hermes/hermes-chat.ts";
import {
  KINDS,
  defaultPicker,
  describeSchedule,
  finishedCronCalls,
  fromSchedule,
  laptopTime,
  nextRuns,
  scheduleProblem,
  toSchedule,
  weekGrid,
  withKind,
  zoned,
} from "../src/shared/routine-schedule.ts";

const LA = "America/Los_Angeles";
/** Wednesday 2026-10-21, 22:40 in Los Angeles. */
const NOW = Date.parse("2026-10-22T05:40:00Z");

describe("describeSchedule", () => {
  test.each([
    ["0 8 * * *", "Every day at 8:00 AM"],
    ["0 8 * * 1-5", "Weekdays at 8:00 AM"],
    ["0 9 * * 1", "Every Monday at 9:00 AM"],
    ["0 9 * * 1,3,5", "Mon, Wed, Fri at 9:00 AM"],
    ["30 6 1 * *", "Monthly on the 1st at 6:30 AM"],
    ["15 * * * *", "Every hour at :15"],
    ["*/10 * * * *", "Every 10 minutes"],
    ["every 120m", "Every 2 hours"],
    ["2h", "Every 2 hours"],
    ["in 30m", "Once, in 30 minutes"],
    ["in 1h", "Once, in 1 hour"],
    ["0 8 1-7 * 1", "Custom schedule"],
    ["every monday 9am", "every monday 9am"],
  ])("%s → %s", (s, words) => expect(describeSchedule(s, LA)).toBe(words));
  test("a naive timestamp is the profile's wall clock; an offset one is absolute", () => {
    // The joiner between date and time ("," or "at") is the ICU build's.
    expect(describeSchedule("2026-10-23T10:00", LA)).toMatch(/^Once, Fri, Oct 23\W+(at )?10:00 AM$/);
    expect(describeSchedule("2026-10-23T10:00:00+00:00", LA)).toMatch(
      /^Once, Fri, Oct 23\W+(at )?3:00 AM$/,
    );
  });
});

describe("nextRuns", () => {
  test("cron fires on the profile's clock, across the DST change", () => {
    const runs = nextRuns("0 8 * * 1-5", LA, 8, NOW).map((t) => new Date(t).toISOString());
    expect(runs[0]).toBe("2026-10-22T15:00:00.000Z");
    // Nov 2 is after the clocks go back: 8 AM PST is 16:00 UTC.
    expect(runs).toContain("2026-11-02T16:00:00.000Z");
    expect(runs).not.toContain("2026-10-24T15:00:00.000Z");
  });
  test("intervals count from now, a one-shot in the past has none", () => {
    expect(nextRuns("every 2h", LA, 2, NOW)).toEqual([NOW + 2 * 3_600_000, NOW + 4 * 3_600_000]);
    expect(nextRuns("2026-10-01T10:00", LA, 1, NOW)).toEqual([]);
    expect(nextRuns("every monday 9am", LA, 1, NOW)).toEqual([]);
  });
  test("day-of-month and weekday restricted together match either", () => {
    const runs = nextRuns("0 9 1 * 5", LA, 3, NOW).map((t) => new Date(t).toISOString().slice(0, 10));
    expect(runs).toEqual(["2026-10-23", "2026-10-30", "2026-11-01"]);
  });
});

describe("the picker round-trips the schedule it writes", () => {
  const samples = [
    "0 8 * * *",
    "0 8 * * 1-5",
    "30 9 * * 1,3",
    "0 7 15 * *",
    "5 * * * *",
    "every 2h",
    "in 30m",
    "2026-10-23T10:00",
    "0 8 1-7 * 1",
  ];
  test.each(samples)("%s", (s) => expect(toSchedule(fromSchedule(s, LA, NOW))).toBe(s));
  test("every kind writes something the problem check accepts", () => {
    const base = defaultPicker(LA, NOW);
    for (const [kind] of KINDS) expect(scheduleProblem(withKind(base, kind), LA, NOW)).toBe("");
  });
  test("a minute interval reads back in the largest whole unit", () => {
    expect(fromSchedule("every 1440m", LA, NOW)).toMatchObject({ kind: "interval", n: 1, unit: "d" });
  });
});

describe("scheduleProblem", () => {
  const p = defaultPicker(LA, NOW);
  test("names what is wrong", () => {
    expect(scheduleProblem({ ...p, kind: "weekly", days: [] }, LA, NOW)).toContain("day");
    expect(scheduleProblem({ ...p, kind: "cron", expr: "0 8 * *" }, LA, NOW)).toContain("cron");
    expect(scheduleProblem({ ...p, kind: "cron", expr: "0 8 31 2 *" }, LA, NOW)).toContain("never");
    expect(scheduleProblem({ ...p, kind: "at", date: "2026-10-01" }, LA, NOW)).toContain("passed");
    expect(scheduleProblem({ ...p, kind: "interval", n: Number.NaN }, LA, NOW)).toContain("at least 1");
  });
});

test("zoned and the laptop hint agree on a wall clock", () => {
  const t = zoned(2026, 10, 23, 8, 0, LA);
  expect(new Date(t).toISOString()).toBe("2026-10-23T15:00:00.000Z");
  expect(laptopTime(t, LA, LA)).toBe("");
  expect(laptopTime(t, LA, "America/Chicago")).toBe("10:00 AM your time");
  expect(laptopTime(t, LA, "Asia/Tokyo")).toBe("Sat 12:00 AM your time");
});

test("weekGrid buckets runs by day and hour", () => {
  const grid = weekGrid(nextRuns("0 8 * * 1-5", LA, 10, NOW), LA, NOW);
  expect(grid).toHaveLength(7);
  expect(grid[1]?.[8]).toBe(1);
  expect(grid[3]?.[8]).toBe(0);
});

describe("finishedCronCalls", () => {
  test("a cron call re-read from history counts, plain or behind v0.23.1's tool_call bridge", () => {
    const BOX = {
      instance: "atlas",
      baseUrl: "https://fxtr0001-atlas.tail0000.ts.net/",
      fleet_id: "fxtr0001",
    };
    const call = (id: string, name: string, args: unknown) => ({
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
    const messages = mapHistory(BOX, "s-1", {
      messages: [
        {
          id: 1,
          role: "assistant",
          content: "",
          tool_calls: [
            call("c-1", "cronjob", { action: "list" }),
            // `cronjob_manage` is deferred by default (`hermes_cli/config_defaults.py:1997-2001`).
            call("c-2", "tool_call", {
              name: "cronjob_manage",
              arguments: { action: "pause", job_id: "j1" },
            }),
            call("c-3", "tool_call", { name: "web_search", arguments: { q: "x" } }),
          ],
        },
        { id: 2, role: "tool", tool_call_id: "c-1", content: "{}" },
        { id: 3, role: "tool", tool_call_id: "c-2", tool_name: "tool_call", content: "{}" },
        { id: 4, role: "tool", tool_call_id: "c-3", tool_name: "tool_call", content: "{}" },
      ],
    });
    // Each result row is a message of its own; the turn is all of them.
    const turn = { id: "turn", blocks: messages.flatMap((m) => m.blocks) };
    expect(finishedCronCalls(turn)).toEqual(["id:c-1", "id:c-2"]);
  });
});
