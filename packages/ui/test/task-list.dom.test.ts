/** The task list's local dismissals (`task-list-prefs.ts`) and the page's derivations (`task-list.ts`). */
import "./dom.ts";
import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "bun:test";
import { todoLifecycle } from "@hermetic/core/shared";
import {
  TASK_LIST_PREFS_KEY,
  TASK_VIEW_LIMIT,
  markTaskView,
  readTaskViews,
  taskViewKey,
} from "../src/chat/task-list-prefs.ts";
import {
  TASK_STASH_LIMIT,
  conversationTasks,
  finishedMark,
  previousLists,
  stashTasks,
  taskCells,
  taskListCache,
  taskNow,
  taskTitle,
  todoStepKey,
  todoTree,
  turnState,
} from "../src/chat/task-list.ts";
import { key } from "../src/chat/chat-conversation-record.ts";
import type { Conversation } from "../src/chat/chat-conversation-record.ts";
import type { TodoFound } from "@hermetic/core/shared";
import type { ChatMessageView } from "../src/api/index.ts";

const FLEET = "fxtr0001";
const storage = `${TASK_LIST_PREFS_KEY}.${FLEET}`;

afterEach(() => window.localStorage.removeItem(storage));

test("marks only move forward and survive a re-read", () => {
  const key = taskViewKey("corvid", "default", "s1");
  markTaskView(FLEET, key, { seen: 4, cleared: 4 });
  markTaskView(FLEET, key, { seen: 2, hidden: 3 });
  expect(readTaskViews(FLEET)[key]).toEqual({ seen: 4, cleared: 4, hidden: 3 });
  expect(JSON.parse(window.localStorage.getItem(storage) ?? "null")).toEqual([
    [key, { seen: 4, cleared: 4, hidden: 3 }],
  ]);
});

test("a no-op mark writes nothing", () => {
  const key = taskViewKey("corvid", "default", "s1");
  markTaskView(FLEET, key, { seen: 4 });
  const raw = window.localStorage.getItem(storage);
  let fired = 0;
  const count = () => fired++;
  window.addEventListener("hermetic:chat-task-prefs", count);
  markTaskView(FLEET, key, { seen: 4 });
  window.removeEventListener("hermetic:chat-task-prefs", count);
  expect(fired).toBe(0);
  expect(window.localStorage.getItem(storage)).toBe(raw);
});

test("corrupt storage reads as nothing dismissed", () => {
  window.localStorage.setItem(storage, "{not json");
  expect(readTaskViews(FLEET)).toEqual({});
  window.localStorage.setItem(
    storage,
    JSON.stringify([["k", { seen: "x", cleared: 2 }], [3, {}], "z"]),
  );
  expect(readTaskViews(FLEET)).toEqual({ k: { seen: undefined, cleared: 2, hidden: undefined } });
});

test("the oldest conversations fall off past the limit", () => {
  for (let i = 0; i <= TASK_VIEW_LIMIT; i += 1) markTaskView(FLEET, `a/b/${i}`, { seen: 1 });
  const views = readTaskViews(FLEET);
  expect(Object.keys(views)).toHaveLength(TASK_VIEW_LIMIT);
  expect(views["a/b/0"]).toBeUndefined();
  expect(views[`a/b/${TASK_VIEW_LIMIT}`]).toEqual({ seen: 1 });
});

const list = (revision: number, statuses: string[]) => ({
  revision,
  todos: statuses.map((status, i) => ({ id: String(i), content: `t${i}`, status })),
});

test("cells skip cancelled items; the title counts and finishes", () => {
  const running = list(3, ["done", "active", "pending", "cancelled"]);
  expect(taskCells(running)).toEqual(["done", "active", "pending"]);
  const life = (snapshot: ReturnType<typeof list>) =>
    todoLifecycle({ snapshot, busy: false, live: false, updatedAt: null, now: 0, view: {} });
  expect(taskTitle(running, life(running))).toBe("1/3 · 1 active · 1 open");
  const done = list(4, ["done", "done", "cancelled"]);
  expect(taskTitle(done, life(done))).toBe("✓ 2/2 · 1 cancelled");
});

test("live is this page's turn; busy is any turn", () => {
  expect(turnState({ sending: false, remoteBusy: true, activity: "idle" })).toEqual({
    busy: true,
    live: false,
  });
  expect(turnState({ sending: true, remoteBusy: null, activity: "streaming" })).toEqual({
    busy: true,
    live: true,
  });
  expect(turnState({ sending: false, remoteBusy: false, activity: "idle" })).toEqual({
    busy: false,
    live: false,
  });
});

test("each todo call diffs against the call before it, not the notice", () => {
  const tool = (tool_id: string, revision: number) => ({
    kind: "tool",
    tool_id,
    todos: list(revision, ["pending"]),
  });
  const notice = { kind: "activity", key: "tasks", todos: list(9, ["done"]) };
  const messages = [
    { id: "m1", blocks: [tool("a", 1), notice] },
    { id: "m2", blocks: [{ kind: "text", markdown: "x" }, tool("b", 2)] },
  ] as unknown as ChatMessageView[];
  const prev = previousLists(messages);
  expect(prev.get("tool:a")).toBeNull();
  expect(prev.get("tool:b")?.revision).toBe(1);
});

test("a todo call with no tool_id still finds the list before it", () => {
  const first = { kind: "tool", tool_id: "a", todos: list(1, ["pending"]) };
  const bare = { kind: "tool", tool_id: null, todos: list(2, ["done"]) };
  const messages = [{ id: "m1", blocks: [first, bare] }] as unknown as ChatMessageView[];
  expect(previousLists(messages).get(todoStepKey(bare))?.revision).toBe(1);
});

test("the rail's lists are cached per record and stable while nothing moved", () => {
  const found = list(3, ["active"]);
  const record = {
    target: { instance: "corvid", bot: "default", session: null },
    messages: [
      {
        id: "m1",
        session: "s1",
        at: "2026-10-22T00:00:00Z",
        blocks: [{ kind: "tool", tool_id: "a", todos: found }],
      },
    ],
    live: null,
    sending: false,
    remoteBusy: null,
    activity: "idle",
    historyRead: true,
  } as unknown as Conversation;
  const records = new Map([[key(record.target), record]]);
  const stash = new Map([["corvid/default", { snapshot: found } as unknown as TodoFound]]);
  const cache = taskListCache();
  const first = conversationTasks(records, stash, () => true, cache);
  expect(first).toHaveLength(1);
  // A record that read its history drops the refused snapshot's stand-in.
  expect(stash.size).toBe(0);
  expect(conversationTasks(records, stash, () => true, cache)).toBe(first);
  record.messages = [...record.messages];
  expect(conversationTasks(records, stash, () => true, cache)).toBe(first);
  record.remoteBusy = true;
  const busy = conversationTasks(records, stash, () => true, cache);
  expect(busy).not.toBe(first);
  expect(busy[0]?.busy).toBe(true);
});

test("the refused-snapshot stash is bounded and drops a list-less snapshot", () => {
  const stash = new Map<string, TodoFound>();
  const carrying = [
    {
      id: "m",
      session: "s",
      at: "2026-10-22T00:00:00Z",
      blocks: [{ kind: "tool", todos: list(1, ["pending"]) }],
    },
  ] as unknown as ChatMessageView[];
  for (let i = 0; i <= TASK_STASH_LIMIT; i += 1) stashTasks(stash, `i${i}`, "default", carrying);
  expect(stash.size).toBe(TASK_STASH_LIMIT);
  expect(stash.has("i0/default")).toBe(false);
  stashTasks(stash, "i1", "default", []);
  expect(stash.has("i1/default")).toBe(false);
});

test("a finished list already seen finished keeps its done line; only open-finished clears", () => {
  const key = taskViewKey("corvid", "default", "s1");
  const watching = { viewKey: key, phase: "running" };
  expect(finishedMark(null, key, 5)).toEqual({ seen: 5, cleared: 5 });
  expect(finishedMark({ viewKey: "other", phase: "running" }, key, 5)).toEqual({
    seen: 5,
    cleared: 5,
  });
  expect(finishedMark(watching, key, 5)).toEqual({ seen: 5 });
  expect(finishedMark({ viewKey: key, phase: "finished" }, key, 6)).toEqual({ seen: 6 });
});

test("the sheet's tree nests a child under a later parent and survives a cycle", () => {
  const item = (id: string, parent?: string) => ({ id, content: id, status: "pending", parent });
  const ids = (list: readonly { id: string }[] | undefined) => (list ?? []).map((i) => i.id);
  const later = todoTree([item("a", "b"), item("b"), item("c", "b"), item("d", "gone")]);
  expect(ids(later.roots)).toEqual(["b", "d"]);
  expect(ids(later.children.get("b"))).toEqual(["a", "c"]);
  const cycle = todoTree([item("x", "y"), item("y", "x"), item("z", "z")]);
  const seen = new Set<string>();
  const walk = (list: readonly { id: string }[]) => {
    for (const i of list) {
      expect(seen.has(i.id)).toBe(false);
      seen.add(i.id);
      walk(cycle.children.get(i.id) ?? []);
    }
  };
  walk(cycle.roots);
  expect([...seen].sort()).toEqual(["x", "y", "z"]);
});

test("a folded line names the running item, else the first pending one", () => {
  const item = (id: string, status: string, parent?: string) => ({ id, content: id, status, parent });
  const running = {
    revision: 1,
    todos: [item("a", "done"), item("b", "active"), item("c", "pending")],
  };
  expect(taskNow(running)?.item.id).toBe("b");
  const next = {
    revision: 1,
    todos: [item("a", "done"), item("p", "pending"), item("k", "pending", "p")],
  };
  expect(taskNow(next)?.item.id).toBe("p");
  const kid = { revision: 1, todos: [item("p", "done"), item("k", "pending", "p")] };
  expect(taskNow(kid)?.parent?.id).toBe("p");
  expect(taskNow({ revision: 1, todos: [item("a", "done"), item("x", "cancelled")] })).toBeNull();
});

test("the sheet drops in on transform and opacity, and reduced motion stops it", () => {
  const css = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const tasks = css("../src/chat/styles/chat-tasks.css");
  // A folded strip is a flex column under the full strip's `align-items: center`;
  // without stretch its bar shrinks to nothing.
  expect(tasks.match(/\.tl-strip\.folded \{[^}]*\}/)?.[0]).toContain("align-items: stretch");
  const sheet = tasks.match(/\.tl-sheet \{[^}]*\}/)?.[0] ?? "";
  expect(sheet).toContain("animation: tl-drop var(--motion-enter) var(--ease-ui)");
  const frames = tasks.match(/@keyframes tl-drop \{[\s\S]*?\n\}/)?.[0] ?? "";
  expect(frames).toContain("translateY(-6px)");
  expect(frames).toContain("opacity: 0");
  // polish.css switches every animation off under reduced motion; the sheet has no opt-out of its own.
  const reduced = css("../src/styles/polish.css").match(
    /@media \(prefers-reduced-motion: reduce\) \{\s*\*,[\s\S]*?animation: none !important/,
  );
  expect(reduced === null).toBe(false);
});
