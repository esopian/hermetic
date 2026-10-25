/**
 * One kanban card, read from the conversation's box and re-read every
 * `POLL_MS` until it is done, archived or deleted (desktop
 * `blocks/KanbanTask.tsx`). The gateway comes from the paired fleet; with no
 * fleet or no conversation the card stays unread and draws read-only.
 */
import type { KanbanTaskDetail } from "@hermetic/core/schema";
import { useCallback, useContext, useEffect, useState } from "react";
import { AppState } from "react-native";
import { reasonOf } from "../../client/errors.ts";
import { type KanbanRest, readKanbanTask } from "../../client/kanban.ts";
import { FleetContext } from "../../fleet/FleetProvider.tsx";
import { useChatScope } from "../ChatScope.tsx";

/** Hermes' own notice poll is 5 s. */
export const POLL_MS = 5_000;
/** A board that 404s (plugin off, another board) is asked again only this often. */
export const UNREADABLE_POLL_MS = 30_000;
/** `failed` when the box answered but has no such board: not an outage. */
export const UNREADABLE = "unreadable";

export interface KanbanTaskState {
  instance: string | null;
  rest: KanbanRest | null;
  detail: KanbanTaskDetail | null;
  /** The latest read failed; the last good detail stays drawn. */
  failed: string | null;
  /** The board said this task is not found: it was deleted. */
  gone: boolean;
  reload(): void;
}

/** `on`: the box the card is on, where no conversation says (the board screen). */
export function useKanbanTask(id: string | null, on?: string): KanbanTaskState {
  const scoped = useChatScope()?.instance ?? null;
  const instance = on ?? scoped;
  const rest = useContext(FleetContext)?.client?.gateway.rest ?? null;
  const [detail, setDetail] = useState<KanbanTaskDetail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [tick, setTick] = useState(0);
  const settled = gone || detail?.task.status === "done" || detail?.task.status === "archived";

  useEffect(() => {
    if (!id || !instance || !rest) return;
    const ctl = new AbortController();
    // One read at a time, so overlapping reads cannot land out of order.
    let busy = false;
    let notBefore = 0;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        setDetail(await readKanbanTask(rest, instance, id, ctl.signal));
        setFailed(null);
        notBefore = 0;
      } catch (e) {
        if (ctl.signal.aborted) return;
        const { code, message } = reasonOf(e);
        // Only the task's own 404 is a deletion; a plugin turned off answers NOT_FOUND too.
        if (code === "NOT_FOUND" && message.includes(`task ${id} not found`)) setGone(true);
        else if (code === "NOT_FOUND" || /HTTP 404\b/.test(message)) {
          setFailed(UNREADABLE);
          notBefore = Date.now() + UNREADABLE_POLL_MS;
        } else setFailed(message);
      } finally {
        busy = false;
      }
    };
    void read();
    if (settled) return () => ctl.abort();
    const timer = setInterval(() => {
      if (AppState.currentState === "active" && Date.now() >= notBefore) void read();
    }, POLL_MS);
    return () => {
      ctl.abort();
      clearInterval(timer);
    };
    // `tick` forces a read after an action.
  }, [id, instance, rest, settled, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { instance, rest, detail, failed, gone, reload };
}
