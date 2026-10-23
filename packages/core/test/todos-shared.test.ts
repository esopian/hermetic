/** `shared/todos.ts`: which list is current, its progress, its diff and its lifecycle. */
import { describe, expect, test } from "bun:test";
import {
  latestTodoList,
  todoAge,
  todoDiff,
  todoFraction,
  todoLifecycle,
  todoRunning,
  todoSupersedes,
  type TodoMessageLike,
  type TodoSnapshotLike,
  type TodoView,
} from "../src/shared/index.ts";

const item = (id: string, status: string, content = id, parent: string | null = null) => ({
  id,
  content,
  status,
  parent,
});
const snap = (revision: number | null, ...todos: ReturnType<typeof item>[]): TodoSnapshotLike => ({
  todos,
  revision,
});
const msg = (id: string, session: string, ...lists: TodoSnapshotLike[]): TodoMessageLike => ({
  id,
  session,
  at: `2026-09-17T09:00:0${id.slice(-1)}.000Z`,
  blocks: [{ kind: "text" }, ...lists.map((todos) => ({ kind: "tool", todos }))],
});

describe("todoSupersedes", () => {
  test("revisions move forward; equal is accepted, lower ignored", () => {
    expect(todoSupersedes(null, snap(1))).toBe(true);
    expect(todoSupersedes(snap(3), snap(4))).toBe(true);
    expect(todoSupersedes(snap(3), snap(3))).toBe(true);
    expect(todoSupersedes(snap(3), snap(2))).toBe(false);
  });

  test("unrevisioned lists replace only null or unrevisioned ones", () => {
    expect(todoSupersedes(snap(null), snap(1))).toBe(true);
    expect(todoSupersedes(null, snap(null))).toBe(true);
    expect(todoSupersedes(snap(null), snap(null))).toBe(true);
    expect(todoSupersedes(snap(2), snap(null))).toBe(false);
  });
});

describe("latestTodoList", () => {
  test("restatements at the winning revision keep its first position", () => {
    const found = latestTodoList([
      msg("m1", "a", snap(2, item("x", "active"))),
      msg(
        "m2",
        "a",
        snap(3, item("x", "done"), item("y", "active")),
        snap(3, item("x", "done"), item("y", "active")),
      ),
      msg("m3", "a", snap(3, item("x", "done"), item("y", "active", "y restated"))),
    ]);
    expect(found).toMatchObject({
      message_id: "m2",
      at: "2026-09-17T09:00:02.000Z",
      first_message_id: "m1",
    });
    // Content may take the later restatement.
    expect(found?.snapshot.todos[1]?.content).toBe("y restated");
  });

  test("a finished list's jump target skips its own duplicate hits", () => {
    const done = () => snap(3, item("x", "done"), item("y", "cancelled"));
    const found = latestTodoList([
      msg("m0", "a", snap(1, item("old", "done"))),
      msg("m1", "a", snap(2, item("x", "active"), item("y", "pending"))),
      // The finishing turn: tool.complete and todo.updated, both revision 3.
      msg("m2", "a", done(), done()),
      // A later turn's resume seed restates revision 3.
      msg("m3", "a", done()),
    ]);
    expect(found).toMatchObject({ message_id: "m2", first_message_id: "m1" });
  });

  test("none without a list", () => {
    expect(latestTodoList([msg("m1", "a")])).toBeNull();
  });

  test("a lower revision later in the session is ignored", () => {
    const found = latestTodoList([
      msg("m1", "a", snap(3, item("x", "active"))),
      msg("m2", "a", snap(2)),
    ]);
    expect(found?.message_id).toBe("m1");
    expect(found?.snapshot.revision).toBe(3);
    expect(found?.at).toBe("2026-09-17T09:00:01.000Z");
  });

  test("a later session wins whatever its revision", () => {
    const found = latestTodoList([
      msg("m1", "a", snap(9, item("x", "active"))),
      msg("m2", "b", snap(1, item("y", "active"))),
      msg("m3", "b"),
    ]);
    expect(found).toMatchObject({ message_id: "m2", session: "b", first_message_id: "m2" });
  });

  test("first_message_id walks back to the last finished list in the session", () => {
    const found = latestTodoList([
      msg("m1", "a", snap(1, item("x", "active"))),
      msg("m2", "a", snap(2, item("x", "done"))),
      msg("m3", "a"),
      msg("m4", "a", snap(3, item("y", "active"))),
      msg("m5", "a", snap(4, item("y", "active"), item("z", "pending"))),
    ]);
    expect(found).toMatchObject({ message_id: "m5", first_message_id: "m4" });
  });

  test("first_message_id stays inside the winner's session", () => {
    const found = latestTodoList([
      msg("m1", "a", snap(1, item("x", "active"))),
      msg("m2", "b", snap(1, item("x", "active"))),
      msg("m3", "b", snap(2, item("x", "active"))),
    ]);
    expect(found).toMatchObject({ message_id: "m3", first_message_id: "m2" });
  });
});

describe("todoFraction and todoRunning", () => {
  test("cancelled items are out of the total", () => {
    expect(
      todoFraction(
        snap(1, item("a", "done"), item("b", "cancelled"), item("c", "active"), item("d", "pending")),
      ),
    ).toEqual({ done: 1, total: 3 });
  });

  test("the deepest active item wins, with its parent", () => {
    const s = snap(1, item("p", "active"), item("c", "active", "c", "p"), item("q", "active"));
    expect(todoRunning(s)).toEqual({
      item: item("c", "active", "c", "p"),
      parent: item("p", "active"),
    });
    expect(todoRunning(snap(1, item("q", "active")))).toEqual({
      item: item("q", "active"),
      parent: null,
    });
    expect(todoRunning(snap(1, item("q", "done")))).toBeNull();
  });
});

describe("todoDiff", () => {
  test("a new list is planned", () => {
    expect(todoDiff(null, snap(1, item("a", "pending"), item("b", "pending")))).toBe("Planned 2 tasks");
    expect(todoDiff(snap(1, item("z", "done")), snap(2, item("a", "pending")))).toBe("Planned 1 task");
  });

  test("changes are marked in list order, each cut at its first ' · '", () => {
    const prev = snap(
      1,
      item("a", "active", "Read · the policy"),
      item("b", "pending"),
      item("c", "pending"),
    );
    const next = snap(
      2,
      item("a", "done", "Read · the policy"),
      item("b", "active"),
      item("c", "cancelled"),
      item("d", "pending", "New"),
    );
    expect(todoDiff(prev, next)).toBe("✓ Read · ▶ b · × c · + New");
  });

  test("cleared, removed, and back to pending", () => {
    const prev = snap(
      1,
      item("a", "done", "A"),
      item("b", "active", "B"),
      item("c", "pending", "C · more"),
    );
    expect(todoDiff(prev, snap(2))).toBe("Cleared the list");
    expect(todoDiff(null, snap(2))).toBe("No change");
    expect(todoDiff(prev, snap(2, item("a", "pending", "A"), item("b", "active", "B")))).toBe(
      "○ A · − C",
    );
  });

  test("no change", () => {
    expect(todoDiff(snap(1, item("a", "pending")), snap(2, item("a", "pending")))).toBe("No change");
  });
});

describe("todoAge", () => {
  test("null under an hour, then hours, then days", () => {
    expect(todoAge(59 * 60_000)).toBeNull();
    expect(todoAge(Number.NaN)).toBeNull();
    expect(todoAge(3 * 3_600_000)).toBe("3h");
    expect(todoAge(3 * 86_400_000 + 1)).toBe("3d");
  });
});

describe("todoLifecycle", () => {
  const NOW = Date.parse("2026-09-17T12:00:00.000Z");
  const open = snap(4, item("a", "done"), item("b", "active"), item("c", "cancelled"));
  const finished = snap(5, item("a", "done"), item("c", "cancelled"));
  const run = (
    snapshot: TodoSnapshotLike | null,
    over: Partial<{ busy: boolean; live: boolean; updatedAt: string | null; view: TodoView }> = {},
  ) =>
    todoLifecycle({
      snapshot,
      busy: false,
      live: false,
      updatedAt: "2026-09-17T11:30:00.000Z",
      now: NOW,
      view: {},
      ...over,
    });

  test("none", () => {
    expect(run(null)).toMatchObject({
      phase: "none",
      strip: null,
      rail: null,
      pulse: false,
      revision: 0,
    });
    expect(run(snap(3))).toMatchObject({ phase: "none", strip: null, rail: null, revision: 3 });
  });

  test("running pulses only when live", () => {
    expect(run(open, { busy: true, live: true })).toMatchObject({
      phase: "running",
      strip: "full",
      rail: "running",
      pulse: true,
      aged: null,
    });
    expect(run(open, { busy: true }).pulse).toBe(false);
  });

  test("paused, and paused and aged", () => {
    expect(run(open, { live: true })).toMatchObject({
      phase: "paused",
      strip: "paused",
      rail: "paused",
      pulse: false,
      aged: null,
    });
    expect(run(open, { updatedAt: "2026-09-14T12:00:00.000Z" }).aged).toBe("3d");
  });

  test("hidden holds until the next revision, and never touches the rail", () => {
    expect(run(open, { view: { hidden: 4 } })).toMatchObject({ strip: null, rail: "paused" });
    expect(run(snap(5, item("b", "active")), { view: { hidden: 4 } }).strip).toBe("paused");
  });

  test("finished, cleared and seen, each per revision", () => {
    expect(run(finished)).toMatchObject({
      phase: "finished",
      strip: "finished",
      rail: "finished",
      cancelled: 1,
    });
    expect(run(finished, { view: { cleared: 5 } })).toMatchObject({ strip: null, rail: "finished" });
    expect(run(finished, { view: { seen: 5 } })).toMatchObject({ strip: "finished", rail: null });
    // A new list is a higher revision, so a clear made before it does not hide it.
    expect(run(snap(6, item("n", "pending")), { view: { cleared: 5 }, busy: true }).strip).toBe("full");
    // Reopened: an item back to pending at a later revision.
    expect(
      run(snap(6, item("a", "pending"), item("c", "cancelled")), { view: { cleared: 5, seen: 5 } }),
    ).toMatchObject({ phase: "paused", strip: "paused", rail: "paused" });
    // A finished list sent again at the next revision shows again.
    expect(run(snap(6, item("a", "done")), { view: { cleared: 5 } }).strip).toBe("finished");
  });
});
