/**
 * What the operator already dismissed of each conversation's task list (§9.2):
 * the revision it was seen, cleared or hidden at (`TodoView`, read by
 * `todoLifecycle`). Local to this laptop, like the rail's own preferences
 * (`chat-rail-prefs.ts`), and keyed by `fleet_id` for the same reason.
 *
 * Keyed by `instance/bot/session`, the session the list was carried in: Hermes
 * numbers revisions per session, so a mark made in one session never hides a
 * list in the next. Bounded to the most recently marked conversations.
 */
import { useSyncExternalStore } from "react";
import type { TodoView } from "@hermetic/core/shared";

export const TASK_LIST_PREFS_KEY = "hermetic.chat.tasks";
const CHANGED = "hermetic:chat-task-prefs";
export const TASK_VIEW_LIMIT = 200;

type Views = Readonly<Record<string, TodoView>>;
const EMPTY: Views = {};
const NO_VIEW: TodoView = {};

export function taskViewKey(instance: string, bot: string, session: string): string {
  return `${instance}/${bot}/${session}`;
}

const storageKey = (fleetId: string): string => `${TASK_LIST_PREFS_KEY}.${fleetId}`;
/** A denied write still holds for this page. */
const volatile = new Map<string, Views>();
/** One parsed value per raw string, so `useSyncExternalStore` sees a stable snapshot. */
const parsed = new Map<string, { raw: string | null; views: Views }>();

const mark = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function parse(raw: string | null): Views {
  if (raw === null) return EMPTY;
  try {
    const doc: unknown = JSON.parse(raw);
    if (!Array.isArray(doc)) return EMPTY;
    const views: Record<string, TodoView> = {};
    for (const entry of doc) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const v = (entry[1] ?? {}) as Record<string, unknown>;
      views[entry[0]] = { seen: mark(v.seen), cleared: mark(v.cleared), hidden: mark(v.hidden) };
    }
    return views;
  } catch {
    return EMPTY;
  }
}

export function readTaskViews(fleetId: string): Views {
  const held = volatile.get(fleetId);
  if (held) return held;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey(fleetId));
  } catch {
    return EMPTY;
  }
  const cached = parsed.get(fleetId);
  if (cached && cached.raw === raw) return cached.views;
  const views = parse(raw);
  parsed.set(fleetId, { raw, views });
  return views;
}

/**
 * Raise the marks in `patch` for one conversation; a mark never moves back.
 * A no-op write is skipped, so a render that re-asserts a mark does not loop.
 */
export function markTaskView(fleetId: string, key: string, patch: TodoView): void {
  const views = readTaskViews(fleetId);
  const was = views[key] ?? NO_VIEW;
  const next: TodoView = { ...was };
  let moved = false;
  for (const field of ["seen", "cleared", "hidden"] as const) {
    const value = patch[field];
    if (value == null || (was[field] ?? -1) >= value) continue;
    next[field] = value;
    moved = true;
  }
  if (!moved) return;
  // Insertion order is recency: the conversation just marked goes last, the oldest falls off.
  const entries = Object.entries(views).filter(([k]) => k !== key);
  entries.push([key, next]);
  const kept = entries.slice(-TASK_VIEW_LIMIT);
  const updated: Views = Object.fromEntries(kept);
  try {
    window.localStorage.setItem(storageKey(fleetId), JSON.stringify(kept));
    volatile.delete(fleetId);
  } catch {
    volatile.set(fleetId, updated);
  }
  window.dispatchEvent(new Event(CHANGED));
}

function subscribe(changed: () => void): () => void {
  const stored = (event: StorageEvent) => {
    if (event.key !== null && !event.key.startsWith(TASK_LIST_PREFS_KEY)) return;
    volatile.clear();
    changed();
  };
  window.addEventListener(CHANGED, changed);
  window.addEventListener("storage", stored);
  return () => {
    window.removeEventListener(CHANGED, changed);
    window.removeEventListener("storage", stored);
  };
}

export function useTaskViews(fleetId: string): Views {
  return useSyncExternalStore(
    subscribe,
    () => readTaskViews(fleetId),
    () => EMPTY,
  );
}

export const taskViewOf = (views: Views, key: string): TodoView => views[key] ?? NO_VIEW;
