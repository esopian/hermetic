/**
 * The task list's phone logic: which strip state a thread shows, the home
 * row's tag, the strip's five-row window and rail, what a finished list marks,
 * and how a turn's todo calls read in the transcript while it runs and once it
 * settles.
 */
import type { ChatBlock } from "@hermetic/core/chat-client";
import { latestTodoList, todoLifecycle, type TodoView } from "@hermetic/core/shared";
import { groupSummary, sections } from "../../src/client/chat-activity.ts";
import {
  changedIds,
  diffParts,
  finishedMark,
  homeTaskTag,
  previousLists,
  spokenDiff,
  taskCells,
  taskSource,
  taskStrip,
  taskWindow,
  turnState,
} from "../../src/client/task-list.ts";
import { msg, todoTool, tool } from "../helpers/fixtures.ts";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const AT = "2026-10-13T11:30:00.000Z";

const RUNNING = todoTool(
  [
    ["1", "Read the policy", "done"],
    ["2", "Draft the change", "active"],
    ["2a", "Pick the count", "active", "2"],
    ["3", "Apply it", "pending"],
    ["4", "Drop the old one", "cancelled"],
  ],
  4,
);
const FINISHED = todoTool(
  [
    ["1", "Read the policy", "done"],
    ["2", "Draft the change", "done"],
    ["3", "Apply it", "cancelled"],
  ],
  5,
);

function life(
  block = RUNNING,
  over: { busy?: boolean; live?: boolean; at?: string; view?: TodoView } = {},
) {
  const found = latestTodoList([msg({ at: over.at ?? AT, blocks: [block] })]);
  if (!found) throw new Error("no list");
  return {
    found,
    life: todoLifecycle({
      snapshot: found.snapshot,
      busy: over.busy ?? false,
      live: over.live ?? false,
      updatedAt: found.at,
      now: NOW,
      view: over.view ?? {},
    }),
  };
}

describe("taskStrip", () => {
  test("running: expanded with the counts, or one line naming the deepest running item", () => {
    const run = life(RUNNING, { busy: true, live: true });
    expect(taskStrip({ ...run, folded: false, observing: true })).toEqual({
      kind: "expanded",
      fraction: "1/4",
      summary: "2 active · 1 open",
      label: "Tasks 1 of 4, running: Draft the change › Pick the count",
    });
    expect(taskStrip({ ...run, folded: true, observing: true })).toMatchObject({
      kind: "folded",
      tone: "run",
      now: { glyph: "▶", text: "Draft the change › Pick the count" },
      meta: null,
      hide: false,
    });
  });

  test("running on its box unfollowed: the folded line's item is not live", () => {
    const run = life(RUNNING, { busy: true, live: false });
    expect(taskStrip({ ...run, folded: true, observing: true })).toMatchObject({
      now: { glyph: "▷", text: "Draft the change › Pick the count" },
    });
  });

  test("paused: folded with Hide; the age once untouched an hour; last known when not watched", () => {
    const fresh = life(RUNNING);
    expect(taskStrip({ ...fresh, folded: false, observing: true })).toMatchObject({
      kind: "folded",
      tone: "paused",
      fraction: "1/4",
      now: { glyph: "▷", text: "Draft the change › Pick the count" },
      meta: "paused",
      hide: true,
    });
    const old = life(RUNNING, { at: "2026-10-10T11:00:00.000Z" });
    const state = taskStrip({ ...old, folded: false, observing: false });
    expect(state).toMatchObject({ meta: "last known · 3d" });
    expect(state.kind === "folded" && state.label).toBe(
      "Tasks 1 of 4, last known: Draft the change › Pick the count, untouched 3d",
    );
  });

  test("paused and hidden at this revision: nothing, until the next revision", () => {
    const hidden = life(RUNNING, { view: { hidden: 4 } });
    expect(taskStrip({ ...hidden, folded: false, observing: true })).toEqual({ kind: "none" });
    const next = life(todoTool([["1", "Read the policy", "pending"]], 5), { view: { hidden: 4 } });
    expect(taskStrip({ ...next, folded: false, observing: true }).kind).toBe("folded");
  });

  test("finished: ✓ done until cleared; nothing once cleared", () => {
    const done = life(FINISHED);
    expect(taskStrip({ ...done, folded: false, observing: true })).toMatchObject({
      kind: "folded",
      tone: "done",
      fraction: "2/2 done",
      now: null,
      hide: false,
    });
    const cleared = life(FINISHED, { view: { cleared: 5 } });
    expect(taskStrip({ ...cleared, folded: false, observing: true })).toEqual({ kind: "none" });
  });

  test("the sheet's source line", () => {
    const live = life(RUNNING, { busy: true, live: true });
    expect(taskSource(live.found, live.life, true, "11:30 AM")).toBe("live · rev 4 · 11:30 AM");
    const paused = life(RUNNING);
    expect(taskSource(paused.found, paused.life, true, "11:30 AM")).toBe("rev 4 · updated 11:30 AM");
    expect(taskSource(paused.found, paused.life, false, "Oct 10")).toBe(
      "last known · from history · rev 4 · Oct 10",
    );
  });
});

describe("finishedMark", () => {
  test("found finished on open is seen and cleared; watched finishing is only seen", () => {
    expect(finishedMark(null, "k", 5)).toEqual({ seen: 5, cleared: 5 });
    expect(finishedMark({ viewKey: "k", phase: "running" }, "k", 5)).toEqual({ seen: 5 });
    expect(finishedMark({ viewKey: "other", phase: "running" }, "k", 5)).toEqual({
      seen: 5,
      cleared: 5,
    });
  });
});

describe("homeTaskTag", () => {
  const entry = (block = RUNNING, busy = false, live = false) => {
    const found = latestTodoList([msg({ at: AT, blocks: [block] })]);
    if (!found) throw new Error("no list");
    return { found, busy, live };
  };

  test("accent while live, muted when paused or followed from afar", () => {
    expect(homeTaskTag(entry(RUNNING, true, true), {}, NOW)).toEqual({
      text: "1/4",
      tone: "acc",
      label: "tasks 1 of 4",
    });
    expect(homeTaskTag(entry(RUNNING, true, false), {}, NOW)?.tone).toBe("fg3");
    expect(homeTaskTag(entry(RUNNING), {}, NOW)).toEqual({
      text: "1/4",
      tone: "fg3",
      label: "tasks 1 of 4, paused",
    });
  });

  test("finished: ✓ in ok until the conversation is opened (seen), then nothing", () => {
    expect(homeTaskTag(entry(FINISHED), {}, NOW)).toEqual({
      text: "✓ 2/2",
      tone: "ok",
      label: "tasks 2 of 2 done",
    });
    expect(homeTaskTag(entry(FINISHED), { seen: 5 }, NOW)).toBeNull();
    expect(homeTaskTag(undefined, {}, NOW)).toBeNull();
  });
});

describe("the strip's window and rail", () => {
  const long = todoTool([
    ["a", "Cut the branch", "done"],
    ["b", "Run the suite", "done"],
    ["b1", "Unit", "done", "b"],
    ["b2", "Flow", "done", "b"],
    ["c", "Build", "active"],
    ["d", "Notes", "pending"],
    ["e", "Tag", "pending"],
    ["f", "Verify", "pending"],
    ["g", "Announce", "pending"],
  ]);

  test("five rows from the last done one, done parents folded to their count", () => {
    const { rows, rest } = taskWindow(long.todos ?? { todos: [], revision: null });
    expect(rows.map((r) => [r.item.id, r.folded])).toEqual([
      ["b", "2/2"],
      ["c", null],
      ["d", null],
      ["e", null],
      ["f", null],
    ]);
    expect(rest).toBe(2);
  });

  test("one cell per item not cancelled; the running one still when not live", () => {
    const snapshot = RUNNING.todos ?? { todos: [], revision: null };
    expect(taskCells(snapshot, true)).toEqual(["done", "run", "run", "open"]);
    expect(taskCells(snapshot, false)).toEqual(["done", "still", "still", "open"]);
  });
});

describe("the transcript", () => {
  const notice: ChatBlock = {
    kind: "activity",
    category: "notice",
    key: "tasks",
    title: "Task list updated",
    state: "done",
    todos: RUNNING.todos ?? null,
  };
  const blocks: ChatBlock[] = [
    tool({ status: "ok" }),
    RUNNING,
    notice,
    tool({ tool_id: "t2", status: "ok" }),
    FINISHED,
  ];

  test("while the turn runs, each todo call is its own row; the notice is never drawn", () => {
    const list = sections(blocks, true);
    expect(list.map((s) => (s.activity ? `group:${s.blocks.length}` : s.blocks[0]?.kind))).toEqual([
      "group:1",
      "tool",
      "group:1",
      "tool",
    ]);
  });

  test("settled, they fold into the run's head as task updates", () => {
    const list = sections(blocks);
    expect(list).toHaveLength(1);
    const head = groupSummary(list[0]?.blocks ?? [], false, "idle", false);
    expect(head.status).toBe("Tools complete");
    expect(head.count).toBe("2 tools · 2 task updates");
    expect(groupSummary([RUNNING], false, "idle", false)).toMatchObject({
      status: "Tasks updated",
      count: "1 task update",
    });
  });

  test("each call's previous list, and what it changed", () => {
    const prevOf = previousLists([msg({ blocks })]);
    expect(prevOf.get("tool:todo-4")).toBeNull();
    expect(prevOf.get("tool:todo-5")).toBe(RUNNING.todos);
    expect(changedIds(RUNNING.todos ?? null, FINISHED.todos ?? { todos: [], revision: null })).toEqual([
      "2",
      "3",
    ]);
  });

  test("turnState: live is this phone receiving the frames", () => {
    expect(turnState({ sending: true, activity: "streaming", remote: false })).toEqual({
      busy: true,
      live: true,
    });
    expect(turnState({ sending: true, activity: "idle", remote: true })).toEqual({
      busy: true,
      live: false,
    });
    expect(turnState({ sending: false, activity: "idle", remote: false })).toEqual({
      busy: false,
      live: false,
    });
  });
});

describe("a Tasks row's diff", () => {
  const diff = "✓ Unit tests · ▶ Flow tests · + Docs";
  test("the running part apart from what settled, so it can keep its room", () => {
    expect(diffParts(diff)).toEqual({ rest: "✓ Unit tests · + Docs", running: "▶ Flow tests" });
    expect(diffParts("Planned 5 tasks")).toEqual({ rest: "Planned 5 tasks", running: "" });
  });

  test("spoken with words for its glyphs", () => {
    expect(spokenDiff(diff)).toBe("done: Unit tests, running: Flow tests, added: Docs");
    expect(spokenDiff("○ a · × b · − c")).toBe("reopened: a, cancelled: b, removed: c");
    expect(spokenDiff("Planned 5 tasks")).toBe("Planned 5 tasks");
  });
});
