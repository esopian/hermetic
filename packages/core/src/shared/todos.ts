/**
 * Hermes's task list as every head reads it (§9.2): which snapshot is current,
 * how far along it is, what changed, and whether the strip and the rail show it.
 *
 * Parsed in core (`chat/hermes/hermes-chat-todos.ts`, typed by `TodoSnapshot` in
 * `schema/chat.ts`). `shared/*` never imports `schema/*`, so the shapes here are
 * structural: only what these helpers read. Pure and clock-free; the caller
 * passes `now`.
 */

/** `TodoItem`, structurally. Status is `done | active | pending | cancelled`. */
export interface TodoItemLike {
  id: string;
  content: string;
  status: string;
  parent?: string | null;
}

/** `TodoSnapshot`, structurally. */
export interface TodoSnapshotLike {
  todos: readonly TodoItemLike[];
  revision: number | null;
}

/** `ChatMessage`, structurally: only the blocks that may carry a list. */
export interface TodoMessageLike {
  id: string;
  session: string;
  at: string;
  blocks: readonly { kind: string; todos?: TodoSnapshotLike | null }[];
}

export interface TodoFound {
  snapshot: TodoSnapshotLike;
  /** The message that carried `snapshot`, and its session and time. */
  message_id: string;
  session: string;
  at: string;
  /** Where this list was planned: the earliest message of its run since the last finished list. */
  first_message_id: string;
}

/** What the operator already dismissed, each as the revision it was dismissed at. */
export interface TodoView {
  seen?: number | null;
  cleared?: number | null;
  hidden?: number | null;
}

export type TodoPhase = "none" | "running" | "paused" | "finished";

export interface TodoLifecycle {
  phase: TodoPhase;
  strip: "full" | "paused" | "finished" | null;
  rail: "running" | "paused" | "finished" | null;
  pulse: boolean;
  aged: string | null;
  cancelled: number;
  revision: number;
}

const settled = (status: string): boolean => status === "done" || status === "cancelled";
const finished = (s: TodoSnapshotLike): boolean => s.todos.every((t) => settled(t.status));

/**
 * Whether `next` replaces `held`. Revisions only move forward; an equal one is
 * accepted because a `tool.complete` restates the `todo.updated` it follows. An
 * unrevisioned list replaces only an unrevisioned one.
 */
export function todoSupersedes(held: TodoSnapshotLike | null, next: TodoSnapshotLike): boolean {
  if (held === null || held.revision === null) return true;
  return next.revision !== null && next.revision >= held.revision;
}

/**
 * The current list across a transcript. Each run of one session is ordered by
 * revision; a later session that carries any list wins outright, because a
 * compaction starts a new session whose revisions may restart.
 *
 * A restatement at the same revision (the resume seed on every turn, a
 * `tool.complete` after its `todo.updated`) may refresh the content but not the
 * position: `message_id` and `at` stay where that revision first appeared, so
 * a list's age does not reset on every send and a live read agrees with a
 * reloaded one.
 */
export function latestTodoList(messages: readonly TodoMessageLike[]): TodoFound | null {
  type Hit = { snapshot: TodoSnapshotLike; index: number };
  const rank = (h: Hit): number => h.snapshot.revision ?? -1;
  let held: { snapshot: TodoSnapshotLike; pos: Hit } | null = null;
  let found: { snapshot: TodoSnapshotLike; pos: Hit; run: Hit[] } | null = null;
  let run: Hit[] = [];
  for (const [index, message] of messages.entries()) {
    if (index > 0 && message.session !== messages[index - 1]?.session) {
      run = [];
      held = null;
    }
    for (const block of message.blocks) {
      if (!block.todos) continue;
      const hit: Hit = { snapshot: block.todos, index };
      run.push(hit);
      if (!todoSupersedes(held?.snapshot ?? null, hit.snapshot)) continue;
      const restated: boolean =
        held !== null &&
        hit.snapshot.revision !== null &&
        held.snapshot.revision === hit.snapshot.revision;
      held = { snapshot: hit.snapshot, pos: restated && held ? held.pos : hit };
      found = { ...held, run };
    }
  }
  if (!found) return null;
  const { snapshot, pos } = found;
  // Back to where this list was planned: past restatements, up to the last
  // finished list of a lower revision.
  let first = pos.index;
  for (let i = found.run.indexOf(pos) - 1; i >= 0; i -= 1) {
    const earlier = found.run[i];
    if (!earlier || rank(earlier) >= rank(pos)) continue;
    if (finished(earlier.snapshot)) break;
    first = earlier.index;
  }
  const message = messages[pos.index] as TodoMessageLike;
  return {
    snapshot,
    message_id: message.id,
    session: message.session,
    at: message.at,
    first_message_id: (messages[first] as TodoMessageLike).id,
  };
}

/** Done items over every item not cancelled. */
export function todoFraction(s: TodoSnapshotLike): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const t of s.todos) {
    if (t.status === "cancelled") continue;
    total += 1;
    if (t.status === "done") done += 1;
  }
  return { done, total };
}

/** The item being worked on: the deepest active one, so a subtask beats its parent. */
export function todoRunning(
  s: TodoSnapshotLike,
): { item: TodoItemLike; parent: TodoItemLike | null } | null {
  const byId = new Map(s.todos.map((t) => [t.id, t]));
  const depth = (t: TodoItemLike): number => {
    let d = 0;
    const seen = new Set<string>();
    for (let p = t.parent ? byId.get(t.parent) : undefined; p && !seen.has(p.id); ) {
      seen.add(p.id);
      d += 1;
      p = p.parent ? byId.get(p.parent) : undefined;
    }
    return d;
  };
  let best: { item: TodoItemLike; depth: number } | null = null;
  for (const item of s.todos) {
    if (item.status !== "active") continue;
    const d = depth(item);
    if (!best || d > best.depth) best = { item, depth: d };
  }
  if (!best) return null;
  return { item: best.item, parent: (best.item.parent && byId.get(best.item.parent)) || null };
}

const MARK = new Map([
  ["done", "✓"],
  ["active", "▶"],
  ["cancelled", "×"],
  ["pending", "○"],
]);
const head = (content: string): string => content.split(" · ")[0] ?? content;

/**
 * One line saying what `next` changed: `Planned 5 tasks`, `Cleared the list`,
 * `✓ a · ▶ b · ○ c · × d · + e · − f` (done, active, back to pending,
 * cancelled, new, removed), or `No change`.
 */
export function todoDiff(prev: TodoSnapshotLike | null, next: TodoSnapshotLike): string {
  const before = new Map((prev?.todos ?? []).map((t) => [t.id, t]));
  if (next.todos.length === 0) return before.size > 0 ? "Cleared the list" : "No change";
  if (!next.todos.some((t) => before.has(t.id))) {
    const n = next.todos.length;
    return `Planned ${n} ${n === 1 ? "task" : "tasks"}`;
  }
  const parts: string[] = [];
  const after = new Set(next.todos.map((t) => t.id));
  for (const t of next.todos) {
    const was = before.get(t.id);
    const mark = MARK.get(t.status);
    if (!was) parts.push(`+ ${head(t.content)}`);
    else if (was.status !== t.status && mark) parts.push(`${mark} ${head(t.content)}`);
  }
  for (const t of before.values()) if (!after.has(t.id)) parts.push(`− ${head(t.content)}`);
  return parts.length > 0 ? parts.join(" · ") : "No change";
}

/** How long a paused list has sat: null under an hour, else `3h` or `3d`. */
export function todoAge(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 3_600_000) return null;
  const hours = Math.floor(ms / 3_600_000);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * Where the list stands and what each surface shows. A finished list stays on
 * the strip until cleared and on the rail until seen; a paused one stays on the
 * strip until hidden. Each dismissal holds only for the revision it was made
 * at, so the agent's next change brings the list back.
 */
export function todoLifecycle(input: {
  snapshot: TodoSnapshotLike | null;
  busy: boolean;
  live: boolean;
  updatedAt: string | null;
  now: number;
  view: TodoView;
}): TodoLifecycle {
  const { snapshot, busy, live, updatedAt, now, view } = input;
  const revision = snapshot?.revision ?? 0;
  const base: TodoLifecycle = {
    phase: "none",
    strip: null,
    rail: null,
    pulse: false,
    aged: null,
    cancelled: 0,
    revision,
  };
  if (!snapshot || snapshot.todos.length === 0) return base;
  // shortcut: an unrevisioned list counts as revision 0, so one dismissal hides
  // every later unrevisioned list; upstream always revisions its result, so
  // upgrade (e.g. key marks by content) if unrevisioned lists show up.
  const at = (mark: number | null | undefined): boolean => mark != null && mark >= revision;
  const cancelled = snapshot.todos.filter((t) => t.status === "cancelled").length;
  if (finished(snapshot))
    return {
      ...base,
      phase: "finished",
      strip: at(view.cleared) ? null : "finished",
      rail: at(view.seen) ? null : "finished",
      cancelled,
    };
  if (busy)
    return { ...base, phase: "running", strip: "full", rail: "running", pulse: live, cancelled };
  return {
    ...base,
    phase: "paused",
    strip: at(view.hidden) ? null : "paused",
    rail: "paused",
    aged: updatedAt ? todoAge(now - Date.parse(updatedAt)) : null,
    cancelled,
  };
}
