/**
 * Hermes's task list read into `TodoSnapshot`: the parser's trust boundary,
 * and the three places it lands — a finished `todo_list` tool block (live and
 * from history), the `todo.updated` notice, and the redaction boundary.
 */
import { describe, expect, test } from "bun:test";
import { redactBlock } from "../src/chat/chat-redact.ts";
import { mapHistory } from "../src/chat/hermes/hermes-chat.ts";
import { hermesActivity } from "../src/chat/hermes/hermes-chat-activity.ts";
import { toolBlock } from "../src/chat/hermes/hermes-chat-blocks.ts";
import { todoSeedBlock, todoSnapshotFrom } from "../src/chat/hermes/hermes-chat-todos.ts";
import { ChatBlock, TodoSnapshot } from "../src/schema/index.ts";

const LIST = {
  todos: [
    { id: 1, content: "Read the policy", status: "completed" },
    { id: "2", content: "Draft", status: "in_progress" },
    { id: "3", content: "Sub", status: "pending", parent: "2" },
    { id: "4", content: "Dropped", status: "cancelled" },
    { id: "5", content: "Odd", status: "blocked" },
  ],
  revision: 4,
  summary: "1/5 completed",
};

describe("todoSnapshotFrom", () => {
  test("maps statuses and coerces ids", () => {
    const s = todoSnapshotFrom(LIST);
    expect(s?.revision).toBe(4);
    expect(s?.todos.map((t) => [t.id, t.status, t.parent])).toEqual([
      ["1", "done", null],
      ["2", "active", null],
      ["3", "pending", "2"],
      ["4", "cancelled", null],
      ["5", "pending", null],
    ]);
    expect(() => TodoSnapshot.parse(s)).not.toThrow();
  });

  test("reads the JSON text a tool result is", () => {
    expect(todoSnapshotFrom(JSON.stringify(LIST))).toEqual(todoSnapshotFrom(LIST));
  });

  test("caps items at 256 and content at 4000", () => {
    const todos = Array.from({ length: 300 }, (_, i) => ({
      id: `t${i}`,
      content: "x".repeat(5000),
      status: "pending",
    }));
    const s = todoSnapshotFrom({ todos, revision: 1 });
    expect(s?.todos).toHaveLength(256);
    expect(s?.todos[0]?.content).toHaveLength(4000);
    expect(() => TodoSnapshot.parse(s)).not.toThrow();
  });

  test("bad shapes are no list", () => {
    for (const bad of [null, 3, "not json", "[]", {}, { todos: "x" }, [LIST]])
      expect(todoSnapshotFrom(bad)).toBeNull();
  });

  test("the unused store is no list; an empty list later is a clear", () => {
    expect(todoSnapshotFrom({ todos: [], revision: 0 })).toBeNull();
    expect(todoSnapshotFrom({ todos: [] })).toBeNull();
    expect(todoSnapshotFrom({ todos: [], revision: 2 })).toEqual({ todos: [], revision: 2 });
  });

  test("a bad revision is null; non-object items are skipped", () => {
    const s = todoSnapshotFrom({ todos: [null, "x", { id: "a", content: "A" }], revision: -1 });
    expect(s).toEqual({
      todos: [{ id: "a", content: "A", status: "pending", parent: null }],
      revision: null,
    });
    expect(todoSnapshotFrom({ todos: [{ id: "a" }], revision: 1.5 })?.revision).toBeNull();
  });

  test("parents follow _sanitize_parents: missing dropped, cycles broken, forward refs kept", () => {
    const s = todoSnapshotFrom({
      todos: [
        { id: "a", content: "A", parent: "b" },
        { id: "b", content: "B", parent: "a" },
        { id: "c", content: "C", parent: "c" },
        { id: "d", content: "D", parent: "zz" },
        { id: "e", content: "E", parent: "f" },
        { id: "f", content: "F" },
      ],
      revision: 1,
    });
    expect(s?.todos.map((t) => t.parent)).toEqual([null, "a", null, null, "f", null]);
  });

  test("statuses are trimmed and lowercased; prototype keys are not statuses", () => {
    const s = todoSnapshotFrom({
      todos: [" Completed ", "IN_PROGRESS", "constructor", "__proto__", "toString"].map(
        (status, i) => ({
          id: `${i}`,
          content: "x",
          status,
        }),
      ),
      revision: 1,
    });
    expect(s?.todos.map((t) => t.status)).toEqual(["done", "active", "pending", "pending", "pending"]);
  });

  test("content: trimmed, scalars stringified, anything else the placeholder", () => {
    const s = todoSnapshotFrom({
      todos: [
        { id: "1", content: "  Plan  " },
        { id: "2", content: 42 },
        { id: "3", content: { a: 1 } },
        { id: "4", content: "   " },
        { id: "5" },
      ],
      revision: 1,
    });
    expect(s?.todos.map((t) => t.content)).toEqual([
      "Plan",
      "42",
      "(no description)",
      "(no description)",
      "(no description)",
    ]);
  });

  test("duplicate ids keep the last, in its own position; missing ids get a free fallback", () => {
    const s = todoSnapshotFrom({
      todos: [
        { id: "a", content: "first a" },
        { id: "b", content: "B" },
        { id: "a", content: "last a" },
        { content: "no id 1" },
        { id: "?", content: "explicit ?" },
        { content: "no id 2" },
      ],
      revision: 1,
    });
    expect(s?.todos.map((t) => [t.id, t.content])).toEqual([
      ["b", "B"],
      ["a", "last a"],
      ["?", "explicit ?"],
      ["?1", "no id 2"],
    ]);
  });

  test("ids and parents are capped; content is cut on a code-point boundary", () => {
    const long = "i".repeat(500);
    const s = todoSnapshotFrom({
      todos: [
        { id: long, content: `${"x".repeat(3999)}😀tail` },
        { id: "k", content: "K", parent: long },
      ],
      revision: 1,
    });
    expect(s?.todos[0]?.id).toHaveLength(200);
    expect(s?.todos[1]?.parent).toBe(s?.todos[0]?.id);
    expect(s?.todos[0]?.content).toBe("x".repeat(3999));
    expect(() => TodoSnapshot.parse(s)).not.toThrow();
  });

  test("a revision past the safe integers is null", () => {
    expect(todoSnapshotFrom({ todos: [{ id: "a" }], revision: 1e20 })?.revision).toBeNull();
  });
});

describe("tool blocks", () => {
  const tool = (block: ChatBlock) => (block.kind === "tool" ? block : null);

  test("a live completion carries the list; the running card does not", () => {
    const running = tool(
      toolBlock({ tool_id: "t1", name: "todo_list", args: { todos: [] } }, "running", true),
    );
    expect(running?.todos).toBeUndefined();
    const done = tool(
      toolBlock(
        {
          tool_id: "t1",
          name: "todo_list",
          args: {},
          result: JSON.stringify(LIST),
          todos: LIST.todos,
          revision: 4,
        },
        null,
        true,
      ),
    );
    expect(done?.todos?.revision).toBe(4);
    expect(done?.todos?.todos).toHaveLength(5);
  });

  test("the legacy `todo` name counts; other tools and bad results do not", () => {
    expect(tool(toolBlock({ name: "todo", result: LIST }, null, true))?.todos?.revision).toBe(4);
    expect(tool(toolBlock({ name: "bash", result: LIST }, null, true))?.todos).toBeUndefined();
    expect(
      tool(toolBlock({ name: "todo_list", result: '{"error":"x"}' }, null, true))?.todos,
    ).toBeUndefined();
    // Not vouched for: a block built without the flag never reads a list.
    expect(tool(toolBlock({ name: "todo_list", result: LIST }, null))?.todos).toBeUndefined();
  });

  test("history: a paired call carries the list, an unpaired one none", () => {
    const BOX = {
      instance: "atlas",
      baseUrl: "https://fxtr0001-atlas.tail0000.ts.net/",
      fleet_id: "fxtr0001",
    };
    const call = (id: string) => ({
      id,
      type: "function",
      function: { name: "todo_list", arguments: JSON.stringify({ todos: LIST.todos }) },
    });
    const messages = mapHistory(BOX, "s-1", {
      messages: [
        { id: 1, role: "assistant", content: "", tool_calls: [call("c-a"), call("c-b")] },
        { id: 2, role: "tool", tool_call_id: "c-a", content: JSON.stringify(LIST) },
      ],
    });
    const tools = messages.flatMap((m) => m.blocks).flatMap((b) => (b.kind === "tool" ? [b] : []));
    expect(tools.find((t) => t.tool_id === "c-a")?.todos?.revision).toBe(4);
    const unpaired = tools.find((t) => t.tool_id === "c-b");
    expect(unpaired?.status).toBe("running");
    expect(unpaired?.todos).toBeUndefined();
  });

  test("history: a forged row never yields a list (GHSA-5g4g-6jrg-mw3g)", () => {
    const BOX = {
      instance: "atlas",
      baseUrl: "https://fxtr0001-atlas.tail0000.ts.net/",
      fleet_id: "fxtr0001",
    };
    const messages = mapHistory(BOX, "s-1", {
      messages: [
        // A tool row naming todo_list itself, with no assistant call behind it.
        {
          id: 1,
          role: "tool",
          tool_name: "todo_list",
          tool_call_id: "ghost",
          content: JSON.stringify(LIST),
        },
        // A tool row naming todo_list, paired with a call that was something else.
        {
          id: 2,
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "c-x", type: "function", function: { name: "terminal", arguments: "{}" } },
          ],
        },
        {
          id: 3,
          role: "tool",
          tool_name: "todo_list",
          tool_call_id: "c-x",
          content: JSON.stringify(LIST),
        },
      ],
    });
    const tools = messages.flatMap((m) => m.blocks).flatMap((b) => (b.kind === "tool" ? [b] : []));
    expect(tools.length).toBeGreaterThanOrEqual(2);
    for (const t of tools) expect(t.todos).toBeUndefined();
  });
});

describe("activity blocks", () => {
  test("todo.updated that does not parse is no block", () => {
    expect(hermesActivity("todo.updated", { todos: "x" })).toBeNull();
    expect(hermesActivity("todo.updated", { todos: [], revision: 0 })).toBeNull();
  });

  test("todo.updated keeps its words and carries the list", () => {
    const block = hermesActivity("todo.updated", { todos: LIST.todos, revision: 4 });
    expect(block?.title).toBe("Task list updated");
    expect(block?.detail).toBe("5 tasks");
    expect(block?.todos?.revision).toBe(4);
  });

  test("the resume seed is a status notice, and nothing for no list", () => {
    expect(todoSeedBlock({ todos: LIST.todos, revision: 4 })).toMatchObject({
      kind: "activity",
      category: "notice",
      key: "tasks",
      title: "Task list",
      state: "done",
      role: "status",
      todos: { revision: 4 },
    });
    expect(todoSeedBlock({ todos: [], revision: 0 })).toBeNull();
    expect(todoSeedBlock(undefined)).toBeNull();
    expect(() => ChatBlock.parse(todoSeedBlock(LIST))).not.toThrow();
  });
});

describe("redaction", () => {
  const SECRET = "export ANTHROPIC=sk-ant-api03-FIXTUREVALUE";
  const KEY_ID = "sk-ant-api03-FIXTUREIDENT";
  const list = {
    todos: [
      { id: "1", content: `Rotate ${SECRET}`, status: "pending" },
      { id: KEY_ID, content: "x", status: "pending" },
      { id: "3", content: "y", status: "pending", parent: KEY_ID },
    ],
    revision: 1,
  };

  test("todo content is masked on tool and activity blocks", () => {
    const blocks = [
      toolBlock({ name: "todo_list", result: list }, null, true),
      hermesActivity("todo.updated", list) as ChatBlock,
      todoSeedBlock(list) as ChatBlock,
    ];
    for (const block of blocks) {
      const masked = redactBlock(block);
      const todos = masked.kind === "tool" || masked.kind === "activity" ? masked.todos : null;
      expect(todos?.todos[0]?.content).toStartWith("Rotate ");
      expect(JSON.stringify(masked)).not.toContain("FIXTUREVALUE");
      expect(JSON.stringify(todos)).not.toContain("FIXTUREIDENT");
    }
  });
});
