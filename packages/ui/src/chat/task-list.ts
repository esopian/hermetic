/**
 * Hermes's task list in the thread and on the rail (§9.2 Task list). Which list
 * is current and what each surface shows is core's (`latestTodoList`,
 * `todoLifecycle` in `@hermetic/core/shared`); this file feeds them what the
 * page knows — is a turn running, is this view receiving it, what the
 * operator already dismissed — and writes the dismissals back.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  latestTodoList,
  todoFraction,
  todoLifecycle,
  todoRunning,
  todoSummary,
} from "@hermetic/core/shared";
import type {
  TodoFound,
  TodoItemLike,
  TodoLifecycle,
  TodoSnapshotLike,
  TodoView,
} from "@hermetic/core/shared";
import type { ChatMessageView } from "../api/index.ts";
import type { TurnActivity } from "./chat-activity.ts";
import { key } from "./chat-conversation-record.ts";
import type { Conversation } from "./chat-conversation-record.ts";
import { markTaskView, taskViewKey, taskViewOf, useTaskViews } from "./task-list-prefs.ts";

/** One canonical conversation's current list, for its rail row. */
export interface ConversationTasks {
  instance: string;
  bot: string;
  found: TodoFound;
  busy: boolean;
  live: boolean;
}

/** `live`: this page is receiving the turn's frames. `busy`: a turn runs there, whoever started it. */
export function turnState(input: {
  sending: boolean;
  remoteBusy: boolean | null;
  activity: TurnActivity;
}): { busy: boolean; live: boolean } {
  const live = input.activity !== "idle";
  return { live, busy: live || input.sending || input.remoteBusy === true };
}

/** How many refused snapshots' lists are kept; one per owned conversation is the normal case. */
export const TASK_STASH_LIMIT = 200;

/**
 * The list in a fan-in snapshot the store refused because the listening set
 * was not read yet (`chat-observation.ts`): the head sends a reader its
 * snapshots once, so without this a conversation nobody opened would have no
 * bar until its next turn. Keyed by `instance/bot`; canonical only.
 */
export function stashTasks(
  stash: Map<string, TodoFound>,
  instance: string,
  bot: string,
  messages: readonly ChatMessageView[],
): void {
  const id = `${instance}/${bot}`;
  const found = latestTodoList(messages);
  stash.delete(id);
  if (!found) return;
  stash.set(id, found);
  for (const oldest of stash.keys()) {
    if (stash.size <= TASK_STASH_LIMIT) break;
    stash.delete(oldest);
  }
}

/** What `conversationTasks` keeps between renders, so a streaming delta rescans one record. */
export interface TaskListCache {
  byRecord: WeakMap<
    Conversation,
    { messages: readonly ChatMessageView[]; live: ChatMessageView | null; found: TodoFound | null }
  >;
  last: ConversationTasks[];
}
export const taskListCache = (): TaskListCache => ({ byRecord: new WeakMap(), last: [] });

function foundOf(cache: TaskListCache, record: Conversation): TodoFound | null {
  const held = cache.byRecord.get(record);
  if (held && held.messages === record.messages && held.live === record.live) return held.found;
  // Unchanged rows keep the list object, so the result below stays equal by identity.
  const next = record.live
    ? latestTodoList([...record.messages, record.live])
    : latestTodoList(record.messages);
  const found =
    held?.found &&
    next &&
    next.message_id === held.found.message_id &&
    next.snapshot === held.found.snapshot
      ? held.found
      : next;
  cache.byRecord.set(record, { messages: record.messages, live: record.live, found });
  return found;
}

const sameTasks = (a: ConversationTasks, b: ConversationTasks | undefined): boolean =>
  !!b &&
  a.instance === b.instance &&
  a.bot === b.bot &&
  a.found === b.found &&
  a.busy === b.busy &&
  a.live === b.live;

/**
 * Every canonical conversation's list, read from the records the fan-in keeps
 * for each conversation the app owns, else from the refused snapshot's stash.
 * The rail describes Bot Chat, so named sessions are left out. Cached per
 * transcript.
 */
export function conversationTasks(
  records: ReadonlyMap<string, Conversation>,
  stash: Map<string, TodoFound>,
  permits: (instance: string) => boolean,
  cache: TaskListCache,
): ConversationTasks[] {
  const out = new Map<string, ConversationTasks>();
  for (const [id, record] of records) {
    const { instance, bot } = record.target;
    if (id !== key({ instance, bot, session: null })) continue;
    // A record that has read its transcript knows better than any refused snapshot.
    if (record.historyRead) stash.delete(`${instance}/${bot}`);
    const found = foundOf(cache, record) ?? stash.get(`${instance}/${bot}`);
    if (!found) continue;
    out.set(`${instance}/${bot}`, {
      instance,
      bot,
      found,
      ...turnState({
        sending: record.sending,
        remoteBusy: record.remoteBusy,
        activity: record.activity,
      }),
    });
  }
  for (const [id, found] of stash) {
    const [instance = "", bot = ""] = id.split("/");
    if (!out.has(id) && permits(instance))
      out.set(id, { instance, bot, found, busy: false, live: false });
  }
  const next = [...out.values()];
  if (next.length === cache.last.length && next.every((entry, i) => sameTasks(entry, cache.last[i])))
    return cache.last;
  cache.last = next;
  return next;
}

/** The cells of a bar: one per item not cancelled, in list order. */
export function taskCells(snapshot: TodoSnapshotLike): string[] {
  return snapshot.todos.filter((t) => t.status !== "cancelled").map((t) => t.status);
}

/** The item a folded strip names: the running one, else the first still pending. */
export function taskNow(
  snapshot: TodoSnapshotLike,
): { item: TodoItemLike; parent: TodoItemLike | null } | null {
  const running = todoRunning(snapshot);
  if (running) return running;
  const item = snapshot.todos.find((t) => t.status === "pending");
  if (!item) return null;
  return { item, parent: snapshot.todos.find((t) => t.id === item.parent) ?? null };
}

/** `2/5 · 1 active · 2 open`, or `✓ 7/7 · 1 cancelled` once finished. */
export function taskTitle(snapshot: TodoSnapshotLike, life: TodoLifecycle): string {
  const { done, total } = todoFraction(snapshot);
  if (life.phase === "finished")
    return `✓ ${done}/${total}${life.cancelled ? ` · ${life.cancelled} cancelled` : ""}`;
  return `${done}/${total} · ${todoSummary(snapshot.todos)}`;
}

/** What the rail draws for one bot, or null. */
export function railTasks(
  entry: ConversationTasks | undefined,
  views: Parameters<typeof taskViewOf>[0],
  now: number,
): { snapshot: TodoSnapshotLike; life: TodoLifecycle } | null {
  if (!entry) return null;
  const { found, busy, live } = entry;
  const life = todoLifecycle({
    snapshot: found.snapshot,
    busy,
    live,
    updatedAt: found.at,
    now,
    view: taskViewOf(views, taskViewKey(entry.instance, entry.bot, found.session)),
  });
  return life.rail ? { snapshot: found.snapshot, life } : null;
}

/**
 * The list each todo call in the transcript changed from, by `todoStepKey`:
 * the previous todo call's, in transcript order. Only the calls count — the
 * `todo.updated` notice restates the call it follows.
 */
export function previousLists(
  messages: readonly ChatMessageView[],
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
 * A todo call's identity for `previousLists`: its `tool_id`, else what it
 * left (revision and every item's state), since a re-read row may be a new
 * object for the same call.
 */
export function todoStepKey(block: {
  tool_id?: string | null;
  todos?: TodoSnapshotLike | null;
}): string {
  if (block.tool_id) return `tool:${block.tool_id}`;
  const todos = block.todos;
  return `list:${todos?.revision ?? "-"}:${(todos?.todos ?? []).map((t) => `${t.id}=${t.status}`).join(",")}`;
}

/** What a todo step in the transcript reads: its previous list, and how to open the sheet. */
export interface TaskTranscript {
  prevOf: ReadonlyMap<string, TodoSnapshotLike | null>;
  show: () => void;
}
export const TaskTranscriptContext = createContext<TaskTranscript | null>(null);
export const useTaskTranscript = (): TaskTranscript | null => useContext(TaskTranscriptContext);

export interface TaskList {
  found: TodoFound | null;
  life: TodoLifecycle;
  open: boolean;
  setOpen: (open: boolean) => void;
  hide: () => void;
  /** Call on every send from this thread's composer. */
  sent: () => void;
  transcript: TaskTranscript;
}

/**
 * The sheet's tree: children under their parent whatever the list order (a
 * parent may come later, as the strip's `parent › item` already allows), roots
 * being items with no parent or one not in the list, siblings in list order.
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
  // Core breaks parent cycles; if one got here, its members would be unreachable, so cut it at the first.
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
    children.set(
      item.parent ?? "",
      (children.get(item.parent ?? "") ?? []).filter((x) => x !== item),
    );
    roots.push(item);
    walk([item]);
  }
  return { roots, children };
}

/**
 * What a finished list's arrival marks. Only a list found already finished on
 * open is cleared; one seen before (running, paused, or finished and restated at
 * a later revision) keeps its done line until it is dismissed or a send is taken.
 */
export function finishedMark(
  prev: { viewKey: string | null; phase: string } | null,
  viewKey: string,
  revision: number | null,
): TodoView {
  const seenBefore = prev?.viewKey === viewKey && prev.phase !== "none";
  return seenBefore ? { seen: revision } : { seen: revision, cleared: revision };
}

/**
 * The thread's list and its dismissals. Opening a conversation whose list is
 * already finished sees and clears it; watching it finish only sees it, so
 * the `✓ done` line stays until the operator's next message.
 */
export function useTaskList({
  fleetId,
  instance,
  bot,
  session,
  messages,
  busy,
  live,
  now,
}: {
  fleetId: string;
  instance: string;
  bot: string;
  /** The session this thread shows, so switching sessions closes the sheet. */
  session: string | null;
  messages: readonly ChatMessageView[];
  busy: boolean;
  live: boolean;
  now: number;
}): TaskList {
  const found = useMemo(() => latestTodoList(messages), [messages]);
  const views = useTaskViews(fleetId);
  const viewKey = found ? taskViewKey(instance, bot, found.session) : null;
  const life = todoLifecycle({
    snapshot: found?.snapshot ?? null,
    busy,
    live,
    updatedAt: found?.at ?? null,
    now,
    view: viewKey ? taskViewOf(views, viewKey) : {},
  });
  const [open, setOpen] = useState(false);
  // The shown conversation is the trigger, not a value read inside.
  useEffect(() => setOpen(false), [instance, bot, session]);

  // Keyed by the list's own conversation and session, so switching to another
  // one never reads as having watched this one finish. A layout effect, so a
  // list found finished on open is dismissed before its line is ever painted.
  const watched = useRef<{ viewKey: string | null; phase: string } | null>(null);
  const { phase, revision } = life;
  useLayoutEffect(() => {
    const prev = watched.current;
    watched.current = { viewKey, phase };
    if (!viewKey || phase !== "finished") return;
    markTaskView(fleetId, viewKey, finishedMark(prev, viewKey, revision));
  }, [fleetId, viewKey, phase, revision]);

  const hide = useCallback(() => {
    if (viewKey) markTaskView(fleetId, viewKey, { hidden: revision });
  }, [fleetId, viewKey, revision]);
  const sent = () => {
    if (viewKey && phase === "finished") markTaskView(fleetId, viewKey, { cleared: revision });
  };
  const show = useCallback(() => setOpen(true), []);
  const prevOf = useMemo(() => previousLists(messages), [messages]);
  const transcript = useMemo(() => ({ prevOf, show }), [prevOf, show]);
  return { found, life, open, setOpen, hide, sent, transcript };
}
