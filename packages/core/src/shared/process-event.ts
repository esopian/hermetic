/**
 * How a background-process event reads in one line (§9.2), shared so the
 * thread, the rail and the CLI word it identically. The inbox does not use the
 * sentence: a notification is worded from structured fields only
 * (`notifyProcessEvent`), never from a command or a reply.
 *
 * The block itself is parsed in core (`chat/hermes/process-notice.ts`) and
 * typed by `ProcessEventBlock` in `schema/chat.ts`. This module cannot import
 * that type — `shared/*` never imports `schema/*` — so it describes the fields
 * it reads structurally, the way the UI's `chat-logic.ts` describes a block.
 */

/** `ProcessEventBlock`, structurally: only what these helpers read. */
export interface ProcessEventLike {
  event: string;
  outcome: string;
  process_id?: string | null;
  status?: string | null;
  exit_code?: number | null;
  command?: string | null;
  message?: string | null;
  watch?: { pattern: string; suppressed?: number } | null;
  delegation?: { total: number; succeeded: number } | null;
  dm?: { to_profile: string; reply: string } | null;
  notice?: {
    variant?: string | null;
    subject?: string | null;
    detail?: string | null;
    task_id?: string | null;
    kanban_kind?: string | null;
  } | null;
}

/**
 * What a `kanban` notice says happened to the card, in upstream's words
 * (`done — <title>`, `blocked: <reason>`, `→ review`). An unknown kind is its
 * suffix verbatim.
 */
export function kanbanNoticeWhat(notice: {
  kanban_kind?: string | null;
  detail?: string | null;
}): string {
  const detail = notice.detail ?? "";
  switch (notice.kanban_kind) {
    case "completed":
      return `done — ${detail}`;
    case "blocked":
      return detail ? `blocked: ${detail}` : "blocked";
    case "gave_up":
      return "gave up after repeated spawn failures";
    case "crashed":
      return "worker crashed; dispatcher will retry";
    case "timed_out":
      return `timed out${detail ? ` (${detail})` : ""}; will retry`;
    case "status":
      return `→ ${detail}`;
    default:
      return detail;
  }
}

/** The fixed label for each `nudge` variant (`ProcessNoticeVariant`), never free text. */
export const NUDGE_LABELS: Readonly<Record<string, string>> = {
  output_limit: "output limit",
  network_cut: "network cut",
  tool_too_large: "tool call too large",
  reasoning_only: "reasoning only",
  continue_now: "continue now",
  fragment: "fragment",
  dropped_tool_call: "tool call missing",
  empty_tool_response: "empty reply",
};

/**
 * A carried-over task list's counts, the way every head states them
 * (`1 active · 2 open`): `active` is the item in progress, `open` the ones not
 * started (pending, or a status upstream printed as `[?]`). Done and cancelled
 * items are not counted, a done parent kept for its children included.
 */
export function todoCounts(tasks: readonly { status: string }[]): { active: number; open: number } {
  let active = 0;
  let open = 0;
  for (const task of tasks) {
    if (task.status === "active") active += 1;
    else if (task.status === "pending" || task.status === "unknown") open += 1;
  }
  return { active, open };
}

/** `todoCounts` as every head words it: `1 active · 2 open`, or `nothing open`. */
export function todoSummary(tasks: readonly { status: string }[]): string {
  const { active, open } = todoCounts(tasks);
  const parts = [active ? `${active} active` : null, open ? `${open} open` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "nothing open";
}

/** The width a command is cut to on an event row, before the ellipsis. */
export const PROCESS_COMMAND_MAX = 58;

/**
 * An interpreter a command line may start with. Its path is noise on an event
 * row — every command on the box runs `/usr/local/lib/hermes-agent/venv/bin/python`
 * — so the row drops it and keeps what the interpreter was asked to run.
 */
const INTERPRETER = /^(?:python[0-9.]*|node|bun|deno|ruby|perl|bash|sh|zsh)$/;

/** The last path segment of a token, or the token when it has none. */
function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

/**
 * A command line shortened for an event row: an interpreter given by path is
 * dropped, the script it runs keeps only `…/` and its file name, and the rest
 * is cut at `max` characters with an ellipsis. The full string belongs in the
 * row's `title` and its copy action, never here.
 */
export function shortCommand(command: string, max: number = PROCESS_COMMAND_MAX): string {
  let rest = command.trim().replace(/\s+/g, " ");
  const first = rest.split(" ", 1)[0] ?? "";
  if (first.includes("/") && INTERPRETER.test(basename(first))) {
    rest = rest.slice(first.length).trimStart();
    const script = rest.split(" ", 1)[0] ?? "";
    if (script.startsWith("/") && script.length > 1) {
      rest = `…/${basename(script)}${rest.slice(script.length)}`;
    }
  }
  return rest.length > max ? `${rest.slice(0, Math.max(1, max - 1)).trimEnd()}…` : rest;
}

/**
 * True for an event that may be folded into a burst and hidden by the
 * "failures only" density: a clean exit, a termination, a watch match, a
 * one-line notice, a `warn` (a resumed turn, the tool-call limit). A failure,
 * a DM reply and a subagent result are never routine — each always gets its
 * own row, and only those raise an inbox row.
 */
export function isRoutineProcessEvent(event: ProcessEventLike): boolean {
  if (event.dm) return false;
  if (event.event === "delegation") return false;
  return event.outcome !== "failed";
}

/** The first non-empty line of a string, trimmed. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * The event as one sentence, for the rail preview and anywhere else there is
 * room for one line: `↩ lead-qa: <reply>` for a DM
 * reply, `■ <command> exited 1` for a failure, `<command> completed` for a
 * clean exit. It never reads as the operator speaking.
 */
export function processEventSentence(event: ProcessEventLike): string {
  if (event.dm) return `↩ ${event.dm.to_profile}: ${firstLine(event.dm.reply)}`;
  const cmd = event.command ? shortCommand(event.command) : (event.process_id ?? "background process");
  const notice = event.notice;
  switch (event.event) {
    case "completion": {
      if (event.outcome === "ok") return `${cmd} completed`;
      if (event.outcome === "terminated") return `${cmd} ${event.status ?? "terminated"}`;
      const code = event.exit_code == null ? "" : ` ${event.exit_code}`;
      const status = event.status === "exited" || !event.status ? `exited${code}` : event.status;
      return `■ ${cmd} ${status}`;
    }
    case "watch_match":
      return `${cmd} matched "${event.watch?.pattern ?? "?"}"`;
    case "delegation": {
      const d = event.delegation;
      const counted = d ? `${d.succeeded} of ${d.total} finished` : "finished";
      return event.outcome === "failed" ? `■ subagents ${counted}` : `subagents ${counted}`;
    }
    case "cron": {
      const job = `cron ${event.message ?? "job"}`;
      if (notice?.variant === "mirrored") return `${job} mirrored`;
      return event.outcome === "failed" ? `■ ${job} failed` : `${job} delivered`;
    }
    case "webhook":
      return `webhook ${event.message ?? "delivery"} mirrored`;
    case "heartbeat":
      return notice?.detail ? `heartbeat every ${notice.detail}` : "heartbeat";
    case "loop": {
      const tick = notice?.detail?.split(" ", 1)[0];
      return tick ? `loop wakeup ${tick}` : "loop wakeup";
    }
    case "goal":
      return event.outcome === "failed" ? "■ goal gate failed" : "goal continuing";
    case "handoff":
      return `handed off from ${notice?.detail ?? "another client"}`;
    case "resume":
      if (notice?.variant === "crash") return "turn resumed after a crash";
      return notice?.detail ? `turn resumed after ${notice.detail}` : "turn resumed";
    case "nudge":
      return `nudge: ${NUDGE_LABELS[notice?.variant ?? ""] ?? "continue"}`;
    case "iteration_limit":
      return "tool-call limit reached";
    case "compaction":
      return "context compacted";
    case "todo":
      return "task list carried over";
    case "model_switch":
      return notice?.subject ? `model → ${notice.subject}` : "model changed";
    case "personality":
      return notice?.variant === "cleared" ? "personality cleared" : "personality set";
    case "kanban":
      return `Kanban ${notice?.task_id ?? "task"} ${notice ? kanbanNoticeWhat(notice) : ""}`.trimEnd();
    default:
      return firstLine(event.message ?? "") || "background notice";
  }
}
