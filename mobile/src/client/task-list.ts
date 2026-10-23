/**
 * Hermes's task list on the phone (§9.4): what the pinned strip, the Tasks
 * sheet, the transcript's Tasks rows and the home row's tag draw. Which list
 * is current, where it stands and what a revision changed are core's
 * (`latestTodoList`, `todoLifecycle`, `todoDiff`, `todoSummary` in
 * `@hermetic/core/shared`); this file turns them into the phone's rows and
 * words. Mirrors `packages/ui/src/chat/task-list.ts` (`turnState`,
 * `finishedMark`, `todoTree`, `previousLists`, `todoStepKey`, `taskNow`).
 * Pure TypeScript.
 */
import {
  todoFraction,
  todoLifecycle,
  todoRunning,
  todoSummary,
  type TodoFound,
  type TodoItemLike,
  type TodoLifecycle,
  type TodoSnapshotLike,
  type TodoView,
} from "@hermetic/core/shared";
import type { ChatBlock } from "@hermetic/core/chat-client";
import type { TurnActivity } from "./turn-reducer.ts";

/* ── the turn ───────────────────────────────────────────────────────────── */

/**
 * `live`: this phone receives the turn's frames. `busy`: a turn runs there,
 * whoever follows it (one running on its box unfollowed keeps `sending`).
 */
export function turnState(input: { sending: boolean; activity: TurnActivity; remote: boolean }): {
  busy: boolean;
  live: boolean;
} {
  const live = input.activity !== "idle" && !input.remote;
  return { live, busy: live || input.sending };
}

/** A conversation's marks key: the session the list was carried in (Hermes numbers revisions per session). */
export function taskViewKey(instance: string, bot: string, session: string): string {
  return `${instance}/${bot}/${session}`;
}

/**
 * What a finished list's arrival marks. Only a list found already finished on
 * open is cleared; one seen before (running, paused, or finished and restated
 * at a later revision) keeps its done line until a send is taken.
 */
export function finishedMark(
  prev: { viewKey: string | null; phase: string } | null,
  viewKey: string,
  revision: number | null,
): TodoView {
  const seenBefore = prev?.viewKey === viewKey && prev.phase !== "none";
  return seenBefore ? { seen: revision } : { seen: revision, cleared: revision };
}

/* ── items ──────────────────────────────────────────────────────────────── */

export interface TaskNow {
  item: TodoItemLike;
  parent: TodoItemLike | null;
}

/** The item a strip names: the running one, else the first still open. */
export function taskNow(snapshot: TodoSnapshotLike): TaskNow | null {
  const running = todoRunning(snapshot);
  if (running) return running;
  const item = snapshot.todos.find((t) => t.status === "pending");
  if (!item) return null;
  return { item, parent: snapshot.todos.find((t) => t.id === item.parent) ?? null };
}

/** `Parent › subtask`, or the item alone. */
export const nowText = (now: TaskNow): string =>
  now.parent ? `${now.parent.content} › ${now.item.content}` : now.item.content;

/**
 * Children under their parent whatever the list order, roots being items with
 * no parent or one not in the list, siblings in list order; a parent cycle is
 * cut at its first member so nothing becomes unreachable.
 */
export function todoTree(todos: readonly TodoItemLike[]): {
  roots: TodoItemLike[];
  children: Map<string, TodoItemLike[]>;
} {
  const ids = new Set(todos.map((item) => item.id));
  const roots: TodoItemLike[] = [];
  const children = new Map<string, TodoItemLike[]>();
  for (const item of todos) {
    if (item.parent && item.parent !== item.id && ids.has(item.parent)) {
      const list = children.get(item.parent) ?? [];
      list.push(item);
      children.set(item.parent, list);
    } else roots.push(item);
  }
  const reached = new Set<string>();
  const walk = (list: readonly TodoItemLike[]) => {
    for (const item of list) {
      if (reached.has(item.id)) continue;
      reached.add(item.id);
      walk(children.get(item.id) ?? []);
    }
  };
  walk(roots);
  for (const item of todos) {
    if (reached.has(item.id)) continue;
    const key = item.parent ?? "";
    children.set(
      key,
      (children.get(key) ?? []).filter((x) => x !== item),
    );
    roots.push(item);
    walk([item]);
  }
  return { roots, children };
}

/** One drawn row of the list. `folded`: a finished parent's `3/3`, its subtasks hidden. */
export interface TaskRow {
  item: TodoItemLike;
  depth: number;
  folded: string | null;
}

/** The tree as rows, depth first. With `foldDone`, a done parent hides its subtasks. */
export function taskRows(todos: readonly TodoItemLike[], foldDone = false): TaskRow[] {
  const { roots, children } = todoTree(todos);
  const out: TaskRow[] = [];
  const walk = (list: readonly TodoItemLike[], depth: number) => {
    for (const item of list) {
      const kids = children.get(item.id) ?? [];
      if (foldDone && item.status === "done" && kids.length > 0) {
        const { done, total } = todoFraction({ todos: kids, revision: null });
        out.push({ item, depth, folded: `${done}/${total}` });
        continue;
      }
      out.push({ item, depth, folded: null });
      walk(kids, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/** How many rows the expanded strip shows. */
export const STRIP_WINDOW = 5;

/**
 * The expanded strip's rows: from the last settled row before the first open
 * one, `STRIP_WINDOW` onward, done parents folded. `rest` is how many are not shown.
 */
export function taskWindow(snapshot: TodoSnapshotLike): { rows: TaskRow[]; rest: number } {
  const all = taskRows(snapshot.todos, true);
  const first = all.findIndex((r) => r.item.status === "active" || r.item.status === "pending");
  const start = Math.max(0, first - 1);
  const rows = all.slice(start, start + STRIP_WINDOW);
  return { rows, rest: all.length - rows.length };
}

/** A segment of the rail: one per item not cancelled, in list order. `still`: running, not live. */
export type TaskCell = "done" | "run" | "still" | "open";

export function taskCells(snapshot: TodoSnapshotLike, pulse: boolean): TaskCell[] {
  return snapshot.todos
    .filter((t) => t.status !== "cancelled")
    .map((t) =>
      t.status === "done" ? "done" : t.status === "active" ? (pulse ? "run" : "still") : "open",
    );
}

/* ── the strip ──────────────────────────────────────────────────────────── */

export type TaskStripState =
  | { kind: "none" }
  | {
      kind: "expanded";
      fraction: string;
      summary: string;
      label: string;
    }
  | {
      kind: "folded";
      tone: "run" | "paused" | "done";
      fraction: string;
      /** `▶` and the item while running, `▷` when paused or not live; null when finished. */
      now: { glyph: "▶" | "▷"; text: string } | null;
      /** `paused · 3d`, `last known`; null while running or finished. */
      meta: string | null;
      /** Offer Hide (paused only). */
      hide: boolean;
      label: string;
    };

/**
 * What the strip draws, or nothing. `folded`: the operator folded a running
 * strip. `observing`: this phone watches the conversation, so what it shows
 * is current rather than the last thing read.
 */
export function taskStrip(input: {
  found: TodoFound | null;
  life: TodoLifecycle;
  folded: boolean;
  observing: boolean;
}): TaskStripState {
  const { found, life, folded, observing } = input;
  if (!found || !life.strip) return { kind: "none" };
  const snapshot = found.snapshot;
  const { done, total } = todoFraction(snapshot);
  const fraction = `${done}/${total}`;
  const counts = `${done} of ${total}`;
  const now = taskNow(snapshot);
  if (life.strip === "finished")
    return {
      kind: "folded",
      tone: "done",
      fraction: `${fraction} done`,
      now: null,
      meta: null,
      hide: false,
      label: `Tasks finished, ${counts} done${life.cancelled ? `, ${life.cancelled} cancelled` : ""}`,
    };
  const item = now ? nowText(now) : null;
  if (life.strip === "full") {
    const label = `Tasks ${counts}, ${item ? `running: ${item}` : todoSummary(snapshot.todos)}`;
    if (!folded) return { kind: "expanded", fraction, summary: todoSummary(snapshot.todos), label };
    return {
      kind: "folded",
      tone: "run",
      fraction,
      now: item ? { glyph: life.pulse ? "▶" : "▷", text: item } : null,
      meta: null,
      hide: false,
      label,
    };
  }
  const meta = [observing ? "paused" : "last known", life.aged].filter(Boolean).join(" · ");
  return {
    kind: "folded",
    tone: "paused",
    fraction,
    now: item ? { glyph: "▷", text: item } : null,
    meta,
    hide: true,
    label: `Tasks ${counts}, ${observing ? "paused" : "last known"}${item ? `: ${item}` : ""}${life.aged ? `, untouched ${life.aged}` : ""}`,
  };
}

/** The sheet's counts line: `1 active · 3 open · paused`, or `✓ done`. */
export function taskCounts(snapshot: TodoSnapshotLike, life: TodoLifecycle): string {
  if (life.phase === "finished") return "✓ done";
  return `${todoSummary(snapshot.todos)}${life.phase === "paused" ? " · paused" : ""}`;
}

/**
 * The sheet's source line. `stamp` is the list's time as the transcript
 * writes it (`chatTime`).
 */
export function taskSource(
  found: TodoFound,
  life: TodoLifecycle,
  observing: boolean,
  stamp: string,
): string {
  const rev = found.snapshot.revision === null ? null : `rev ${found.snapshot.revision}`;
  const parts = life.pulse
    ? ["live", rev, stamp]
    : observing
      ? [rev, `updated ${stamp}`]
      : ["last known · from history", rev, stamp];
  return parts.filter(Boolean).join(" · ");
}

/* ── home ───────────────────────────────────────────────────────────────── */

/** One Bot Chat's current list, as the home row reads it. */
export interface ConversationTasks {
  found: TodoFound;
  busy: boolean;
  live: boolean;
}

/** The boxed tag beside a home row's name, or null. */
export interface HomeTaskTag {
  text: string;
  tone: "acc" | "fg3" | "ok";
  /** What VoiceOver says for it. */
  label: string;
}

/** `2/5` in the accent while live, muted when paused, `✓ 9/9` in ok when finished and unseen. */
export function homeTaskTag(
  entry: ConversationTasks | undefined,
  view: TodoView,
  now: number,
): HomeTaskTag | null {
  if (!entry) return null;
  const life = todoLifecycle({
    snapshot: entry.found.snapshot,
    busy: entry.busy,
    live: entry.live,
    updatedAt: entry.found.at,
    now,
    view,
  });
  if (!life.rail) return null;
  const { done, total } = todoFraction(entry.found.snapshot);
  if (life.rail === "finished")
    return { text: `✓ ${done}/${total}`, tone: "ok", label: `tasks ${done} of ${total} done` };
  return {
    text: `${done}/${total}`,
    tone: life.pulse ? "acc" : "fg3",
    label: `tasks ${done} of ${total}${life.rail === "paused" ? ", paused" : ""}`,
  };
}

/* ── the transcript ─────────────────────────────────────────────────────── */

/** A `todoDiff` line as what it settled and what now runs, so a Tasks row can keep the running part in view. */
export function diffParts(diff: string): { rest: string; running: string } {
  const parts = diff.split(" · ");
  const running = (p: string) => p.startsWith("▶ ");
  return {
    rest: parts.filter((p) => !running(p)).join(" · "),
    running: parts.filter(running).join(" · "),
  };
}

const SPOKEN: Record<string, string> = {
  "✓": "done",
  "▶": "running",
  "○": "reopened",
  "×": "cancelled",
  "+": "added",
  "−": "removed",
};

/** A `todoDiff` line as VoiceOver should say it: `done: Unit tests, running: Flow tests`. */
export function spokenDiff(diff: string): string {
  return diff
    .split(" · ")
    .map((p) => {
      const word = SPOKEN[p.slice(0, 1)];
      return word && p[1] === " " ? `${word}: ${p.slice(2)}` : p;
    })
    .join(", ");
}

/** A `todo_list` call: drawn as a Tasks row, counted as a task update rather than a tool. */
export const isTodoStep = (block: ChatBlock): boolean => block.kind === "tool" && !!block.todos;

/** The `todo.updated` notice and the resume seed: restatements of a call, never drawn. */
export const isTodoNotice = (block: ChatBlock): boolean => block.kind === "activity" && !!block.todos;

/**
 * A todo call's identity for `previousLists`: its `tool_id`, else what it left
 * (revision and every item's state), since a re-read row may be a new object.
 */
export function todoStepKey(block: {
  tool_id?: string | null;
  todos?: TodoSnapshotLike | null;
}): string {
  if (block.tool_id) return `tool:${block.tool_id}`;
  const todos = block.todos;
  return `list:${todos?.revision ?? "-"}:${(todos?.todos ?? []).map((t) => `${t.id}=${t.status}`).join(",")}`;
}

/** The list each todo call changed from, by `todoStepKey`: the previous call's, in transcript order. */
export function previousLists(
  messages: readonly { blocks: readonly ChatBlock[] }[],
): Map<string, TodoSnapshotLike | null> {
  const out = new Map<string, TodoSnapshotLike | null>();
  let prev: TodoSnapshotLike | null = null;
  for (const message of messages)
    for (const block of message.blocks) {
      if (block.kind !== "tool" || !block.todos) continue;
      out.set(todoStepKey(block), prev);
      prev = block.todos;
    }
  return out;
}

/**
 * The items a revision touched, for the sheet to flash: new ones and ones
 * whose status moved (the same rule `todoDiff` words).
 */
export function changedIds(prev: TodoSnapshotLike | null, next: TodoSnapshotLike): string[] {
  const before = new Map((prev?.todos ?? []).map((t) => [t.id, t.status]));
  return next.todos.filter((t) => before.get(t.id) !== t.status).map((t) => t.id);
}
