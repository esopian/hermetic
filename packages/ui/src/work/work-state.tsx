/**
 * The WORK view's data (§9.2, issue #117): the fleet-wide kanban board, the
 * overlay drawers (a task, a new task) and the opener every other surface uses
 * (`OpenKanbanTaskContext`). One provider at `App` level, so a chat notice can
 * open a task drawer over whatever view is up.
 *
 * shortcut: polling, upgrade to /events socket if latency matters.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { kanbanNeedsYou } from "@hermetic/core/shared";
import { kanbanBoard, kanbanTask } from "../api/chat.ts";
import type { KanbanBoardView, KanbanTaskDetailView, KanbanTaskView } from "../api/chat.ts";
import { isVisible } from "../lib/visibility.ts";
import { fleetIdOf } from "../api/index.ts";
import { useFleet } from "../state/state.tsx";
import { OpenKanbanTaskContext } from "./open-task.ts";
import type { OpenKanbanTask } from "./open-task.ts";

/** How often the open WORK view re-reads every board. */
export const WORK_BOARD_POLL_MS = 10_000;
/** A mount read skips when another started this recently: `#work` cold mounts the provider and the view together. */
const MOUNT_READ_MAX_AGE_MS = 3_000;
/** How often an open drawer re-reads a card that can still move. */
export const WORK_TASK_POLL_MS = 5_000;

export interface TaskRef {
  instance: string;
  id: string;
}

export interface WorkState {
  board: KanbanBoardView | null;
  error: string | null;
  /** Re-read every board now; resolves when the read lands. */
  /** Re-read every board now; with `maxAgeMs`, skip when a read started that recently. */
  refresh: (maxAgeMs?: number) => Promise<void>;
  /** The overlay task drawer, or null. */
  drawer: TaskRef | null;
  openTask: (instance: string, id: string) => void;
  closeTask: () => void;
  /** The create drawer: `null` closed, otherwise the instance it opens on. */
  create: { instance: string | null } | null;
  openCreate: (instance?: string) => void;
  closeCreate: () => void;
}

const WorkContext = createContext<WorkState | null>(null);

export function useWork(): WorkState {
  const ctx = useContext(WorkContext);
  if (!ctx) throw new Error("useWork must be used inside <WorkProvider>");
  return ctx;
}

/** Every card on every board, with the instance it lives on. */
export function allTasks(board: KanbanBoardView | null): (KanbanTaskView & { instance: string })[] {
  return (board?.instances ?? []).flatMap((i) => i.tasks.map((t) => ({ ...t, instance: i.instance })));
}

/** The nav badge's two numbers, or null before the first read. */
export function workCounts(board: KanbanBoardView | null): { needYou: number; open: number } | null {
  if (!board) return null;
  const tasks = allTasks(board);
  return {
    needYou: tasks.filter(kanbanNeedsYou).length,
    open: tasks.filter((t) => t.status !== "done").length,
  };
}

/** Run `fn` every `ms` while the page is on screen, as `ScheduledJobs` does. */
function useVisiblePoll(fn: () => void, ms: number, on: boolean): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!on) return;
    let id: ReturnType<typeof setInterval> | null = null;
    const track = () => {
      const visible = isVisible();
      if (visible && id === null) id = setInterval(() => ref.current(), ms);
      else if (!visible && id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    track();
    document.addEventListener("visibilitychange", track);
    return () => {
      document.removeEventListener("visibilitychange", track);
      if (id !== null) clearInterval(id);
    };
  }, [ms, on]);
}

/**
 * `enabled`: the home is bound, so there is a fleet to read. Mounted above
 * `ChatShell`, so the chat dock and drawer get the real opener too. The board
 * is read once here, for the nav badge; it polls only while `WorkView` is
 * mounted (`useBoardPoll`).
 */
export function WorkProvider({
  enabled,
  children,
  overlays,
}: {
  enabled: boolean;
  children: ReactNode;
  /** The drawers, drawn after the page so they cover it (`WorkOverlays`). */
  overlays: ReactNode;
}) {
  const fleetId = fleetIdOf(useFleet().meta);
  const [board, setBoard] = useState<KanbanBoardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<TaskRef | null>(null);
  const [create, setCreate] = useState<{ instance: string | null } | null>(null);

  const readAt = useRef(0);
  const refresh = useCallback(async (maxAgeMs = 0) => {
    if (maxAgeMs > 0 && Date.now() - readAt.current < maxAgeMs) return;
    readAt.current = Date.now();
    try {
      setBoard(await kanbanBoard({}));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  // A fleet switch forgets the old boards and any drawer naming one of its cards.
  useEffect(() => {
    setBoard(null);
    setError(null);
    setDrawer(null);
    setCreate(null);
    if (enabled && fleetId !== null) void refresh(MOUNT_READ_MAX_AGE_MS);
  }, [enabled, fleetId, refresh]);

  const openTask = useCallback((instance: string, id: string) => {
    setCreate(null);
    setDrawer({ instance, id });
  }, []);
  const closeTask = useCallback(() => setDrawer(null), []);
  const openCreate = useCallback((instance?: string) => {
    setDrawer(null);
    setCreate({ instance: instance ?? null });
  }, []);
  const closeCreate = useCallback(() => setCreate(null), []);
  const opener = useMemo<OpenKanbanTask>(() => ({ open: openTask }), [openTask]);
  const value = useMemo<WorkState>(
    () => ({ board, error, refresh, drawer, openTask, closeTask, create, openCreate, closeCreate }),
    [board, error, refresh, drawer, openTask, closeTask, create, openCreate, closeCreate],
  );
  return (
    <WorkContext.Provider value={value}>
      <OpenKanbanTaskContext.Provider value={opener}>
        {children}
        {overlays}
      </OpenKanbanTaskContext.Provider>
    </WorkContext.Provider>
  );
}

/** Re-read the board on mount, then every 10 s while the page is on screen. */
export function useBoardPoll(): void {
  const { refresh } = useWork();
  useEffect(() => {
    void refresh(MOUNT_READ_MAX_AGE_MS);
  }, [refresh]);
  useVisiblePoll(() => void refresh(), WORK_BOARD_POLL_MS, true);
}

/** A card can still move unless it is done or archived; only those are worth a poll. */
export function isTerminal(status: string): boolean {
  return status === "done" || status === "archived";
}

/** One card's detail: read on open, re-read every 5 s while it can still move. */
export function useTaskDetail(ref: TaskRef): {
  detail: KanbanTaskDetailView | null;
  error: string | null;
  reload: () => Promise<void>;
} {
  const { instance, id } = ref;
  const [detail, setDetail] = useState<KanbanTaskDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(`${instance}/${id}`);
  current.current = `${instance}/${id}`;
  const reload = useCallback(async () => {
    const key = `${instance}/${id}`;
    try {
      const d = await kanbanTask({ instance, id });
      if (current.current !== key) return;
      setDetail(d);
      setError(null);
    } catch (e) {
      if (current.current === key) setError(e instanceof Error ? e.message : String(e));
    }
  }, [instance, id]);
  useEffect(() => {
    setDetail(null);
    setError(null);
    void reload();
  }, [reload]);
  const live = detail !== null && !isTerminal(detail.task.status);
  useVisiblePoll(() => void reload(), WORK_TASK_POLL_MS, live);
  return { detail, error, reload };
}
