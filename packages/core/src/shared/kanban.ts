/**
 * Kanban board vocabulary the dashboard and core agree on (§9.2): the lane
 * order upstream's board renders, and the colour-by-meaning rules from
 * `docs/ui-brief.md` (acc = in progress, warn = needs you, ok = done,
 * bad = failed, none = pending). Pure values; no Zod, no node.
 *
 * Field names follow upstream's task row (`hermes_cli/kanban_db.py` Task at
 * Hermes v0.21.5) so a board task can be passed straight in.
 */

export const KANBAN_LANES = [
  {
    id: "triage",
    label: "Triage",
    hint: "An agent turns the rough idea into a spec, then promotes it.",
  },
  { id: "todo", label: "Todo", hint: "Specified. Waits here until the cards it depends on are done." },
  { id: "scheduled", label: "Scheduled", hint: "Waiting on time, not on anyone. Not dispatched." },
  {
    id: "ready",
    label: "Ready",
    hint: "Claimed by a worker within about a minute, if it has an assignee.",
  },
  { id: "running", label: "Running", hint: "A worker is on it. It heartbeats while alive." },
  {
    id: "blocked",
    label: "Blocked",
    hint: "Waiting on you: a question, a missing capability, or repeated failure.",
  },
  { id: "review", label: "Review", hint: "A reviewer agent checks the work before it lands in Done." },
  { id: "done", label: "Done", hint: "Finished. The latest summary is on the card." },
] as const;

export type KanbanLaneId = (typeof KANBAN_LANES)[number]["id"];

/** Every status a task row can carry; `archived` has no lane. */
export const KANBAN_STATUSES = [...KANBAN_LANES.map((l) => l.id), "archived"] as const;
export type KanbanStatusName = (typeof KANBAN_STATUSES)[number];

export const KANBAN_LANE_INDEX: Record<string, number> = Object.fromEntries(
  KANBAN_LANES.map((l, i) => [l.id, i]),
);

/** The slice of a task the tone rules read. */
export interface KanbanTaskLike {
  status: string;
  assignee?: string | null;
  block_kind?: string | null;
}

export type KanbanTone = "acc" | "warn" | "ok" | "bad" | "none";

/** Colour by meaning: warn is "needs you", bad is "gave up", acc is a worker on it. */
export function kanbanTone(t: KanbanTaskLike): KanbanTone {
  if (t.status === "blocked") return t.block_kind === "gave_up" ? "bad" : "warn";
  if (t.status === "ready" && !t.assignee) return "warn";
  if (t.status === "running" || t.status === "review") return "acc";
  if (t.status === "done") return "ok";
  return "none";
}

/** True when nothing moves until a human acts: blocked, or parked with no assignee. */
export function kanbanNeedsYou(t: KanbanTaskLike): boolean {
  return t.status === "blocked" || (t.status === "ready" && !t.assignee);
}

/** The status word a pill shows; more specific than the lane where the lane hides the reason. */
export function kanbanStatusWord(t: KanbanTaskLike): string {
  if (t.status === "blocked") return t.block_kind === "gave_up" ? "gave up" : "needs input";
  if (t.status === "ready" && !t.assignee) return "parked";
  return t.status;
}

/** Hermes' chat notice for a card, one line: `✔ [board] @who Kanban t_ab12cd34 done — title`. */
export const KANBAN_NOTICE_RE =
  /^([✔⏸✖⏱🔄]) (?:\[([^\]\n]+)\] )?(?:@(\S+) )?Kanban (t_[0-9a-f]{8})(.*)$/u;

export const KANBAN_TASK_ID_RE = /^t_[0-9a-f]{8}$/;
