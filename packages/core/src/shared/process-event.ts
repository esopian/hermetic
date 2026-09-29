/**
 * How a background-process event reads in one line (§9.2), shared so the
 * thread, the rail, the CLI and the inbox word it identically.
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
 * one-line notice. A failure, a DM reply and a subagent result are never
 * routine — each always gets its own row.
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
 * The event as one sentence, for the rail preview, an inbox row's title and
 * anywhere else there is room for one line: `↩ lead-qa: <reply>` for a DM
 * reply, `■ <command> exited 1` for a failure, `<command> completed` for a
 * clean exit. It never reads as the operator speaking.
 */
export function processEventSentence(event: ProcessEventLike): string {
  if (event.dm) return `↩ ${event.dm.to_profile}: ${firstLine(event.dm.reply)}`;
  const cmd = event.command ? shortCommand(event.command) : (event.process_id ?? "background process");
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
    default:
      return firstLine(event.message ?? "") || "background notice";
  }
}
