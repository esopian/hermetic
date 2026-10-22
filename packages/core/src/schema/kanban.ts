/**
 * The kanban board surface (§9.2 Bot Mode, issue #117): each box's Hermes
 * kanban plugin (`/api/plugins/kanban/*`, `plugins/kanban/dashboard/plugin_api.py`
 * at Hermes v0.21.5), read and written through the dashboard.
 *
 * Output fields keep upstream's names. Every field an older backend may omit or
 * mistype falls back through `.catch`, so one odd row never fails a board read;
 * unknown fields are stripped.
 */
import { z } from "zod";
import { KANBAN_STATUSES, KANBAN_TASK_ID_RE } from "../shared/kanban.ts";
import { AgentName } from "./requests.ts";

const optText = z.string().nullable().catch(null);
const optNum = z.number().nullable().catch(null);
const TaskId = z.string().regex(KANBAN_TASK_ID_RE, "a kanban task id (t_ + 8 hex digits)");
const Profile = z.string().min(1).max(200);

export const KanbanStatus = z.enum(KANBAN_STATUSES);
export type KanbanStatus = z.infer<typeof KanbanStatus>;
export const KanbanWorkspaceKind = z.enum(["scratch", "worktree", "dir"]);

export const KanbanTask = z.object({
  id: z.string(),
  title: z.string(),
  body: optText,
  status: KanbanStatus,
  assignee: optText,
  priority: z.number().int().catch(0),
  created_by: optText,
  created_at: z.number().catch(0),
  started_at: optNum,
  completed_at: optNum,
  last_heartbeat_at: optNum,
  worker_pid: optNum,
  workspace_kind: KanbanWorkspaceKind.catch("scratch"),
  workspace_path: optText,
  branch_name: optText,
  skills: z.array(z.string()).nullable().catch(null),
  model_override: optText,
  provider_override: optText,
  goal_mode: z.boolean().catch(false),
  goal_max_turns: optNum,
  block_kind: optText,
  last_failure_error: optText,
  consecutive_failures: z.number().int().catch(0),
  latest_summary: optText,
  comment_count: z.number().int().catch(0),
  link_counts: z
    .object({ parents: z.number().int().catch(0), children: z.number().int().catch(0) })
    .catch({ parents: 0, children: 0 }),
  session_id: optText,
  result: optText,
});
export type KanbanTask = z.infer<typeof KanbanTask>;

export const KanbanComment = z.object({
  id: z.union([z.number(), z.string()]),
  author: z.string().catch(""),
  body: z.string().catch(""),
  created_at: z.number().catch(0),
});
export type KanbanComment = z.infer<typeof KanbanComment>;

export const KanbanEvent = z.object({
  id: z.number(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()).catch({}),
  created_at: z.number().catch(0),
});
export type KanbanEvent = z.infer<typeof KanbanEvent>;

export const KanbanRun = z.object({
  id: z.union([z.number(), z.string()]),
  profile: optText,
  status: z.string().catch("unknown"),
  outcome: optText,
  summary: optText,
  error: optText,
  worker_pid: optNum,
  started_at: optNum,
  ended_at: optNum,
});
export type KanbanRun = z.infer<typeof KanbanRun>;

/** A linked card; `status` stays a plain string because a link may point at any row. */
export const KanbanLinkTask = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
});
export type KanbanLinkTask = z.infer<typeof KanbanLinkTask>;

/**
 * One instance's board. `on`: the plugin answered. `off`: the box answered
 * that the board API is not there (plugin disabled, or a Hermes too old).
 * `unknown`: the box answered, but not with a board. `unreachable`: no answer;
 * `tasks` are the last good read, if this process made one (`stale_since`).
 */
export const KanbanInstanceBoard = z.object({
  instance: z.string(),
  state: z.enum(["on", "off", "unknown", "unreachable"]),
  reason: z.string().nullable(),
  hint: z.string().nullable(),
  board: z.string().nullable(),
  profiles: z.array(z.string()),
  tasks: z.array(KanbanTask),
  read_at: z.number(),
  stale_since: z.number().nullable(),
});
export type KanbanInstanceBoard = z.infer<typeof KanbanInstanceBoard>;

export const KanbanBoard = z.object({
  fleet_id: z.string(),
  instances: z.array(KanbanInstanceBoard),
});
export type KanbanBoard = z.infer<typeof KanbanBoard>;

export const KanbanTaskDetail = z.object({
  instance: z.string(),
  task: KanbanTask,
  comments: z.array(KanbanComment),
  events: z.array(KanbanEvent),
  runs: z.array(KanbanRun),
  links: z.object({ parents: z.array(KanbanLinkTask), children: z.array(KanbanLinkTask) }),
  stale_since: z.number().nullable(),
});
export type KanbanTaskDetail = z.infer<typeof KanbanTaskDetail>;

export const KanbanLog = z.object({
  instance: z.string(),
  task_id: z.string(),
  exists: z.boolean().catch(false),
  size_bytes: z.number().catch(0),
  content: z.string().catch(""),
  truncated: z.boolean().catch(false),
});
export type KanbanLog = z.infer<typeof KanbanLog>;

const TaskRef = { instance: AgentName, id: TaskId };

/** Omit `instance` to read every instance in the fleet. */
export const KanbanBoardInput = z.object({ instance: AgentName.optional() }).strict();
export const KanbanTaskInput = z.object(TaskRef).strict();
export const KanbanLogInput = z
  .object({ ...TaskRef, tail: z.number().int().min(1).max(2_000_000).optional() })
  .strict();
export const KanbanCreateInput = z
  .object({
    instance: AgentName,
    title: z.string().trim().min(1).max(500),
    body: z.string().max(100_000).optional(),
    /** `null` parks the card with nobody on it ("Nobody · parked"). */
    assignee: Profile.nullable().optional(),
    /** `triage` hands the rough idea to the specifier first. */
    start: z.enum(["triage", "ready"]).default("ready"),
    /** Upstream's default; `dir` and `worktree` need a `workspace_path`. */
    workspace_kind: KanbanWorkspaceKind.default("scratch"),
    /** Absolute or home-relative: upstream refuses a relative path at dispatch (`kanban_db_workspace.py`). */
    workspace_path: z
      .string()
      .trim()
      .max(4096)
      .regex(/^[/~]/, "workspace_path must start with / or ~")
      .optional(),
    priority: z.number().int().min(0).max(3).default(0),
    skills: z.array(z.string().min(1).max(200)).max(64).optional(),
    goal_mode: z.boolean().optional(),
    goal_max_turns: z.number().int().min(1).max(1000).optional(),
  })
  .strict()
  // Upstream refuses `dir`/`worktree` with no path at dispatch (`kanban_db_workspace.py`), long after create.
  .refine((v) => v.workspace_kind === "scratch" || v.workspace_path !== undefined, {
    path: ["workspace_path"],
    message: "workspace_path is required when workspace_kind is dir or worktree",
  });
export const KanbanCommentInput = z
  .object({ ...TaskRef, body: z.string().min(1).max(100_000) })
  .strict();
/** A non-empty `answer` is posted as a comment before the card is unblocked. */
export const KanbanUnblockInput = z
  .object({ ...TaskRef, answer: z.string().max(100_000).optional() })
  .strict();
/** `null` unassigns. */
export const KanbanAssignInput = z.object({ ...TaskRef, profile: Profile.nullable() }).strict();
/** `running` is the dispatcher's to set, and `archived` is `kanban.archive`. */
export const KanbanMoveInput = z
  .object({
    ...TaskRef,
    status: z.enum(["triage", "todo", "scheduled", "ready", "blocked", "review", "done"]),
  })
  .strict();
export const KanbanArchiveInput = z.object(TaskRef).strict();
export const KanbanDeleteInput = z.object({ ...TaskRef, confirm: z.literal(true) }).strict();

export type KanbanBoardInput = z.infer<typeof KanbanBoardInput>;
export type KanbanTaskInput = z.infer<typeof KanbanTaskInput>;
export type KanbanLogInput = z.infer<typeof KanbanLogInput>;
export type KanbanCreateInput = z.infer<typeof KanbanCreateInput>;
export type KanbanCommentInput = z.infer<typeof KanbanCommentInput>;
export type KanbanUnblockInput = z.infer<typeof KanbanUnblockInput>;
export type KanbanAssignInput = z.infer<typeof KanbanAssignInput>;
export type KanbanMoveInput = z.infer<typeof KanbanMoveInput>;
export type KanbanArchiveInput = z.infer<typeof KanbanArchiveInput>;
export type KanbanDeleteInput = z.infer<typeof KanbanDeleteInput>;
