/**
 * What the operator already dismissed of each conversation's task list
 * (§9.4): the revision it was seen, cleared or hidden at (`TodoView`, read by
 * `todoLifecycle`). Phone-local and never sent to the fleet; the same shape
 * and key as the desktop's `task-list-prefs.ts` (`hermetic.chat.tasks.<fleet_id>`,
 * entries keyed `instance/bot/<the list's session>` in recency order, at most
 * `TASK_VIEW_LIMIT`).
 *
 * One file per fleet (`open`): up to 200 entries outgrow a keychain value, and
 * nothing here is secret. A read or write that fails leaves the marks in
 * memory for this run.
 */
import type { TodoView } from "@hermetic/core/shared";

export const TASK_MARKS_KEY = "hermetic.chat.tasks";
export const TASK_VIEW_LIMIT = 200;

export type TaskViews = Readonly<Record<string, TodoView>>;

/** One file's text (`TextFile` in `src/fleet/store.ts`, structurally). */
export interface TaskMarksFile {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export interface TaskMarks {
  /** The fleet's marks, the same object until one moves. Empty until the file is read. */
  views(fleetId: string): TaskViews;
  /** Raise the marks in `patch` for one conversation; a mark never moves back. */
  mark(fleetId: string, key: string, patch: TodoView): void;
  subscribe(listener: () => void): () => void;
}

const EMPTY: TaskViews = {};
const FIELDS = ["seen", "cleared", "hidden"] as const;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The desktop's document: `[[key, {seen, cleared, hidden}], …]`, oldest first. */
export function parseTaskViews(raw: string | null): TaskViews {
  if (raw === null) return EMPTY;
  try {
    const doc: unknown = JSON.parse(raw);
    if (!Array.isArray(doc)) return EMPTY;
    const views: Record<string, TodoView> = {};
    for (const entry of doc) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const v = (entry[1] ?? {}) as Record<string, unknown>;
      views[entry[0]] = { seen: num(v.seen), cleared: num(v.cleared), hidden: num(v.hidden) };
    }
    return views;
  } catch {
    return EMPTY;
  }
}

/** `next` with `key` raised by `patch`, moved last and bounded; `null` when nothing moved. */
export function raiseTaskView(views: TaskViews, key: string, patch: TodoView): TaskViews | null {
  const was = views[key] ?? {};
  const next: TodoView = { ...was };
  let moved = false;
  for (const field of FIELDS) {
    const value = patch[field];
    if (value == null || (was[field] ?? -1) >= value) continue;
    next[field] = value;
    moved = true;
  }
  if (!moved) return null;
  // Insertion order is recency: the conversation just marked goes last, the oldest falls off.
  const entries = Object.entries(views).filter(([k]) => k !== key);
  entries.push([key, next]);
  return Object.fromEntries(entries.slice(-TASK_VIEW_LIMIT));
}

export function createTaskMarks(open: (fleetId: string) => TaskMarksFile): TaskMarks {
  const listeners = new Set<() => void>();
  const fleets = new Map<
    string,
    { views: TaskViews; file: TaskMarksFile | null; loaded: Promise<void> }
  >();
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  const fleet = (fleetId: string) => {
    const held = fleets.get(fleetId);
    if (held) return held;
    let file: TaskMarksFile | null = null;
    try {
      file = open(fleetId);
    } catch {
      file = null;
    }
    const entry = { views: EMPTY, file, loaded: Promise.resolve() };
    fleets.set(fleetId, entry);
    entry.loaded = (file ? file.read() : Promise.resolve(null))
      .catch(() => null)
      .then((raw) => {
        const stored = parseTaskViews(raw);
        // A mark made before the read landed is kept on top of what was stored.
        let views = stored;
        for (const [key, view] of Object.entries(entry.views))
          views = raiseTaskView(views, key, view) ?? views;
        if (views === EMPTY) return;
        entry.views = views;
        notify();
      });
    return entry;
  };
  return {
    views: (fleetId) => fleet(fleetId).views,
    mark(fleetId, key, patch) {
      const entry = fleet(fleetId);
      const next = raiseTaskView(entry.views, key, patch);
      if (!next) return;
      entry.views = next;
      notify();
      // After the read, so the first write never drops what was stored.
      void entry.loaded.then(() =>
        entry.file?.write(JSON.stringify(Object.entries(entry.views))).catch(() => {}),
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
