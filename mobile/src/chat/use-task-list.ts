/**
 * The task list's hooks (§9.4): a thread's current list and its dismissals,
 * and every held Bot Chat's list for home's rows. What each surface draws is
 * `src/client/task-list.ts`; the marks are `src/client/task-marks.ts`, kept in
 * one document file per fleet.
 */
import {
  latestTodoList,
  type TodoFound,
  type TodoLifecycle,
  todoLifecycle,
} from "@hermetic/core/shared";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ConversationTasks } from "../client/task-list.ts";
import { finishedMark, taskViewKey, turnState } from "../client/task-list.ts";
import { createTaskMarks, TASK_MARKS_KEY, type TaskViews } from "../client/task-marks.ts";
import type { HermeticClient } from "../client/client.ts";
import type { ChatMessage } from "@hermetic/core/chat-client";
import { documentFile } from "../fleet/persist.ts";
import { oncePerFrame } from "../fleet/hooks.ts";

/** Fleet ids are short lowercase names, so the file name needs no escaping. */
export const taskMarks = createTaskMarks((fleetId) =>
  documentFile(`${TASK_MARKS_KEY}.${fleetId}.json`),
);

export function useTaskViews(fleetId: string): TaskViews {
  const get = useCallback(() => taskMarks.views(fleetId), [fleetId]);
  return useSyncExternalStore(taskMarks.subscribe, get, get);
}

export interface TaskList {
  found: TodoFound | null;
  life: TodoLifecycle;
  hide: () => void;
  /** Call on every send from this thread's composer. */
  sent: () => void;
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
  messages,
  busy,
  live,
  now,
}: {
  fleetId: string;
  instance: string;
  bot: string;
  messages: readonly ChatMessage[];
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
    view: (viewKey && views[viewKey]) || {},
  });
  // Keyed by the list's own session, so another one never reads as watched
  // finishing. A layout effect: a list found finished on open is cleared
  // before its line is ever painted.
  const watched = useRef<{ viewKey: string | null; phase: string } | null>(null);
  const { phase, revision } = life;
  useLayoutEffect(() => {
    const prev = watched.current;
    watched.current = { viewKey, phase };
    if (!viewKey || phase !== "finished") return;
    taskMarks.mark(fleetId, viewKey, finishedMark(prev, viewKey, revision));
  }, [fleetId, viewKey, phase, revision]);
  const hide = useCallback(() => {
    if (viewKey) taskMarks.mark(fleetId, viewKey, { hidden: revision });
  }, [fleetId, viewKey, revision]);
  const sent = useCallback(() => {
    if (viewKey && phase === "finished") taskMarks.mark(fleetId, viewKey, { cleared: revision });
  }, [fleetId, viewKey, phase, revision]);
  return { found, life, hide, sent };
}

const sameTasks = (
  a: ReadonlyMap<string, ConversationTasks>,
  b: ReadonlyMap<string, ConversationTasks>,
) =>
  a.size === b.size &&
  [...a].every(([k, v]) => {
    const w = b.get(k);
    return !!w && w.found.snapshot === v.found.snapshot && w.busy === v.busy && w.live === v.live;
  });

/**
 * Every Bot Chat this phone holds in memory (opened since launch, or sent to)
 * with a list, keyed `instance/bot`. A conversation never opened has no
 * transcript here, so its row carries no tag. Re-read at most once a frame,
 * and handed back unchanged while no list, turn or follow moved.
 */
export function useConversationTasks(
  client: HermeticClient | null,
): ReadonlyMap<string, ConversationTasks> {
  const read = useCallback((): Map<string, ConversationTasks> => {
    const out = new Map<string, ConversationTasks>();
    for (const view of client?.chat.views() ?? []) {
      if (view.target.session !== null) continue;
      const found = latestTodoList(view.live ? [...view.messages, view.live] : view.messages);
      if (!found) continue;
      const turn = turnState({ sending: view.sending, activity: view.activity, remote: !!view.remote });
      out.set(`${view.target.instance}/${view.target.bot}`, { found, ...turn });
    }
    return out;
  }, [client]);
  const [tasks, setTasks] = useState(read);
  useEffect(() => {
    if (!client) return;
    const take = () =>
      setTasks((held) => {
        const next = read();
        return sameTasks(held, next) ? held : next;
      });
    take();
    const wake = oncePerFrame(take);
    const off = client.chat.subscribe(() => wake.notify());
    return () => {
      off();
      wake.dispose();
    };
  }, [client, read]);
  return tasks;
}
