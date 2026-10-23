/**
 * Hermes's task list (`tools/todo_tool.py`) read into `TodoSnapshot`.
 *
 * Three places carry a list: a completed `todo_list` call's result, the
 * `todo.updated` event that follows it, and `session.resume`'s `todo_state`.
 * All three are the same `{todos, revision}` document, so one parser reads them,
 * and it is the trust boundary: the box's words are capped here, not in a head.
 */
import type { ChatBlock, TodoItem, TodoSnapshot } from "../../schema/chat.ts";
import { parseJson, rec } from "./hermes-chat-wire.ts";

/** Upstream's `MAX_TODO_ITEMS` and `MAX_TODO_CONTENT_CHARS`; ids have no upstream cap, so ours. */
const MAX_ITEMS = 256;
const MAX_CONTENT = 4000;
const MAX_ID = 200;

/** The tool names that write the list; `todo` is the legacy alias pre-rename replays use. */
export const TODO_TOOL_NAMES: ReadonlySet<string> = new Set(["todo_list", "todo"]);

const STATUS = new Map<string, TodoItem["status"]>([
  ["completed", "done"],
  ["in_progress", "active"],
  ["cancelled", "cancelled"],
  ["pending", "pending"],
]);

/** `s` cut to `max` UTF-16 units, never between the halves of a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Upstream's `str(x).strip()` for the scalars it can mean; anything else is empty. */
const scalar = (v: unknown): string =>
  typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : "";

const idOf = (v: unknown): string | null => cut(scalar(v), MAX_ID) || null;

/**
 * A list, or null when `value` (an object or its JSON text) is not one, read the
 * way `TodoStore` normalises one (`tools/todo_tool.py`). Upstream's unused store,
 * `{todos: [], revision: 0}`, is "no list"; an empty list at a later revision is
 * a real clear.
 */
export function todoSnapshotFrom(value: unknown): TodoSnapshot | null {
  const doc = rec(typeof value === "string" ? parseJson(value) : value);
  if (!doc || !Array.isArray(doc.todos)) return null;
  const r = doc.revision;
  const revision = typeof r === "number" && Number.isSafeInteger(r) && r >= 0 ? r : null;
  const items: Record<string, unknown>[] = [];
  for (const raw of doc.todos) {
    const item = rec(raw);
    if (item) items.push(item);
  }
  // `_dedupe_by_id`: the last item of each id wins, in its own position; items
  // with no id share one key, as upstream's `?` does.
  const last = new Map<string | null, number>();
  for (const [i, item] of items.entries()) last.set(idOf(item.id), i);
  const kept = [...last.values()].sort((a, b) => a - b).slice(0, MAX_ITEMS);
  const explicit = new Set(kept.map((i) => idOf(items[i]?.id)));
  let fallback = "?";
  for (let n = 1; explicit.has(fallback); n += 1) fallback = `?${n}`;
  const todos: TodoItem[] = kept.map((i) => {
    const item: Record<string, unknown> = items[i] ?? {};
    const id = idOf(item.id) ?? fallback;
    const parent = idOf(item.parent);
    return {
      id,
      content: cut(scalar(item.content), MAX_CONTENT) || "(no description)",
      status: STATUS.get(scalar(item.status).toLowerCase()) ?? "pending",
      parent: parent === id ? null : parent,
    };
  });
  sanitizeParents(todos);
  if (todos.length === 0 && (revision ?? 0) === 0) return null;
  return { todos, revision };
}

/** `_sanitize_parents`: a parent naming no item is dropped, and a cycle is broken where it is found. */
function sanitizeParents(todos: TodoItem[]): void {
  const byId = new Map(todos.map((t) => [t.id, t]));
  for (const t of todos) if (t.parent && !byId.has(t.parent)) t.parent = null;
  for (const t of todos) {
    const seen = new Set([t.id]);
    for (let node = t; node.parent; ) {
      if (seen.has(node.parent)) {
        t.parent = null;
        break;
      }
      seen.add(node.parent);
      const next = byId.get(node.parent);
      if (!next) break;
      node = next;
    }
  }
}

/** The `todos` a tool block carries: only a finished todo call whose list parses. */
export function toolTodos(
  name: string,
  status: string,
  payload: Record<string, unknown>,
  result: unknown,
): { todos: TodoSnapshot } | Record<string, never> {
  if (!TODO_TOOL_NAMES.has(name.toLowerCase()) || status === "running") return {};
  // The live `tool.complete` merges the list in beside the result as well.
  const todos =
    todoSnapshotFrom(result) ??
    (payload.todos === undefined
      ? null
      : todoSnapshotFrom({ todos: payload.todos, revision: payload.revision }));
  return todos ? { todos } : {};
}

/** `session.resume`'s `todo_state` as the block a resumed turn opens with, or null. */
export function todoSeedBlock(todoState: unknown): ChatBlock | null {
  const todos = todoSnapshotFrom(todoState);
  return todos
    ? {
        kind: "activity",
        category: "notice",
        key: "tasks",
        title: "Task list",
        state: "done",
        role: "status",
        todos,
      }
    : null;
}
