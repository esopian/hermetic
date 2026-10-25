/**
 * The kanban readers the desktop and the phone share: which tool block names a
 * card (`readKanbanCreateResult`), and a dashboard task read as a detail
 * (`parseKanbanTaskDetail`).
 */
import { describe, expect, test } from "bun:test";
import { parseKanbanTaskDetail } from "../src/schema/kanban.ts";
import { isKanbanTaskTool, readKanbanCreateResult } from "../src/shared/kanban.ts";

const ID = "t_0000abcd";
const tool = (result: unknown, render: string | null = "kanban_task") => ({
  kind: "tool",
  render,
  result,
});

describe("readKanbanCreateResult", () => {
  test("reads the task id from an object or a JSON string", () => {
    expect(readKanbanCreateResult(tool({ task_id: ID }))).toEqual({ task_id: ID });
    expect(readKanbanCreateResult(tool(JSON.stringify({ task_id: ID })))).toEqual({ task_id: ID });
  });

  test("anything else is not a card", () => {
    expect(readKanbanCreateResult(tool("not json"))).toBeNull();
    expect(readKanbanCreateResult(tool({ error: "kanban off" }))).toBeNull();
    expect(readKanbanCreateResult(tool({ task_id: "t_nothex!" }))).toBeNull();
    expect(readKanbanCreateResult(tool({ task_id: ID }, null))).toBeNull();
    expect(
      readKanbanCreateResult({ kind: "text", render: "kanban_task", result: { task_id: ID } }),
    ).toBeNull();
    expect(isKanbanTaskTool(undefined)).toBe(false);
    expect(isKanbanTaskTool(tool({ task_id: ID }))).toBe(true);
  });
});

describe("parseKanbanTaskDetail", () => {
  test("maps the task, drops odd rows, and resolves link titles", () => {
    const detail = parseKanbanTaskDetail("atlas", {
      task: { id: ID, title: "Card", status: "blocked", block_kind: "needs_input" },
      comments: [{ id: 1, author: "me", body: "hi", created_at: 5 }, "junk", { body: "no id" }],
      events: [{ id: 1, kind: "created", created_at: 1 }],
      runs: [{ id: 7, status: "done" }],
      links: { parents: ["t_00000001", 3], children: ["t_00000002"] },
      link_tasks: [{ id: "t_00000001", title: "Parent", status: "done" }],
    });
    expect(detail?.instance).toBe("atlas");
    expect(detail?.task.status).toBe("blocked");
    expect(detail?.comments.map((c) => c.body)).toEqual(["hi"]);
    expect(detail?.events).toHaveLength(1);
    expect(detail?.runs[0]?.status).toBe("done");
    expect(detail?.links).toEqual({
      parents: [{ id: "t_00000001", title: "Parent", status: "done" }],
      children: [{ id: "t_00000002", title: "t_00000002", status: "unknown" }],
    });
    expect(detail?.stale_since).toBeNull();
  });

  test("an answer without a task is null", () => {
    expect(parseKanbanTaskDetail("atlas", { comments: [] })).toBeNull();
    expect(parseKanbanTaskDetail("atlas", null)).toBeNull();
  });
});
