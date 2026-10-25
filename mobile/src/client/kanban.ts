/**
 * A box's kanban board, read and written through the gateway's dashboard API
 * (`GatewayOps.rest`), the calls core's `chat/kanban.ts` makes for the
 * desktop: the board, a card's detail, the roster, create, comment, unblock.
 * Pure TypeScript.
 */
import {
  type KanbanTask,
  type KanbanTaskDetail,
  KanbanCreateInput,
  parseKanbanBoardTasks,
  parseKanbanTaskDetail,
} from "@hermetic/core/schema";
import type { GatewayOps } from "../gateway/transport.ts";
import { isUnreachable, reasonOf } from "./errors.ts";

/** Upstream's kanban plugin, as core's `chat/kanban.ts` reaches it. */
const API = "/api/plugins/kanban";

export type KanbanRest = GatewayOps["rest"];

export async function readKanbanTask(
  rest: KanbanRest,
  instance: string,
  id: string,
  signal?: AbortSignal,
): Promise<KanbanTaskDetail> {
  const raw = await rest({
    instance,
    method: "GET",
    path: `${API}/tasks/${id}`,
    ...(signal ? { signal } : {}),
  });
  const detail = parseKanbanTaskDetail(instance, raw);
  if (!detail) throw new Error(`${instance}: the kanban plugin answered without the task`);
  return detail;
}

export async function commentKanbanTask(
  rest: KanbanRest,
  instance: string,
  id: string,
  body: string,
): Promise<void> {
  await rest({
    instance,
    method: "POST",
    path: `${API}/tasks/${id}/comments`,
    body: { body, author: "hermetic" },
  });
}

/** The answer lands first, so the worker that claims the card reads it. */
export async function unblockKanbanTask(
  rest: KanbanRest,
  instance: string,
  id: string,
  answer: string,
): Promise<void> {
  if (answer.trim()) await commentKanbanTask(rest, instance, id, answer);
  try {
    await rest({ instance, method: "PATCH", path: `${API}/tasks/${id}`, body: { status: "ready" } });
  } catch (error) {
    if (!answer.trim()) throw error;
    // Said plainly so the operator does not send the answer again.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Your answer was posted to ${id}, but the unblock failed: ${reason}`);
  }
}

/**
 * What one instance's board read says, as the desktop's board view sorts it:
 * `on` with its cards, `off` (the plugin 404s: off, or a Hermes before the
 * board API), `unreachable`, or `unknown` (the box answered with something else).
 */
export interface InstanceBoard {
  instance: string;
  state: "on" | "off" | "unreachable" | "unknown";
  reason: string | null;
  tasks: KanbanTask[];
}

/** The command that turns the bundled plugin on, run on the box (core's `KANBAN_ENABLE_HINT`). */
export const KANBAN_ENABLE_HINT = "hermes plugins enable kanban";

export async function readKanbanBoard(
  rest: KanbanRest,
  instance: string,
  signal?: AbortSignal,
): Promise<InstanceBoard> {
  try {
    const raw = await rest({
      instance,
      method: "GET",
      path: `${API}/board`,
      ...(signal ? { signal } : {}),
    });
    const tasks = parseKanbanBoardTasks(raw);
    if (!tasks)
      return {
        instance,
        state: "unknown",
        reason: `${instance} answered, but not with a board.`,
        tasks: [],
      };
    return { instance, state: "on", reason: null, tasks };
  } catch (error) {
    if (signal?.aborted) throw error;
    const { code, message } = reasonOf(error);
    if (code === "NOT_FOUND" || /HTTP 404\b/.test(message))
      return {
        instance,
        state: "off",
        reason: `The kanban plugin is off on ${instance}, or its Hermes predates the board API.`,
        tasks: [],
      };
    if (isUnreachable(error) || code === "ABORTED")
      return { instance, state: "unreachable", reason: `${instance} did not answer.`, tasks: [] };
    return { instance, state: "unknown", reason: message, tasks: [] };
  }
}

/** The box's profiles, for a new card's assignee; empty when the roster cannot be read. */
export async function readKanbanProfiles(rest: KanbanRest, instance: string): Promise<string[]> {
  try {
    const raw = (await rest({ instance, method: "GET", path: `${API}/profiles` })) as {
      profiles?: { name?: unknown }[];
    } | null;
    return (raw?.profiles ?? []).flatMap((p) => (typeof p?.name === "string" ? [p.name] : []));
  } catch {
    return [];
  }
}

/** File a card, checked against core's `KanbanCreateInput` first; answers its id. */
export async function createKanbanTask(
  rest: KanbanRest,
  input: {
    instance: string;
    title: string;
    body?: string;
    /** `null` parks the card with nobody on it. */
    assignee?: string | null;
    start?: "triage" | "ready";
    priority?: number;
  },
): Promise<string> {
  const { instance, start, ...fields } = KanbanCreateInput.parse(input);
  const raw = (await rest({
    instance,
    method: "POST",
    path: `${API}/tasks`,
    body: { ...fields, triage: start === "triage" },
  })) as { task?: { id?: unknown } } | null;
  const id = raw?.task?.id;
  if (typeof id !== "string")
    throw new Error(`${instance}: the kanban plugin answered without the task`);
  return id;
}
