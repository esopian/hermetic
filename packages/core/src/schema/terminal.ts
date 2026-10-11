/**
 * The desktop terminal's shapes (issue #18): what a head reports about one of
 * its SSH sessions so core can write the inbox row, and the spellings of the
 * key and the action ref that row carries.
 *
 * The marker grammar and the shell integration itself live in
 * `shared/shell-markers.ts`, where the browser and the box can both reach them
 * without zod; they are re-exported here so the schema door opens onto them
 * too, and so the program name a row may carry is validated by the same
 * `sanitizeProgramName` the parser's callers use.
 */
import { z } from "zod";
import { AgentName } from "./requests.ts";

export {
  DETACHABLE_PROGRAMS,
  SHELL_INTEGRATION_SCRIPT,
  SHELL_MARKER_OSC,
  SSH_LOGIN_USER,
  parseShellMarker,
  sanitizeProgramName,
} from "../shared/shell-markers.ts";
export type { ShellMarker } from "../shared/shell-markers.ts";

/**
 * A session id, as the app mints it (a UUID fits). Neither `:` nor `/` is
 * admitted, so it can sit inside the condition key and the action ref without
 * making either ambiguous.
 */
export const TerminalSessionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** What a head saw happen in a session the operator was not looking at. */
export const TerminalNoticeEvent = z.enum(["output", "finished", "input", "bell", "disconnected"]);
export type TerminalNoticeEvent = z.infer<typeof TerminalNoticeEvent>;

/**
 * One report from a head (`notifyTerminalEvent`). Deliberately narrow: there is
 * no field a session's output could ride in on. `program` is whatever the
 * shell integration's `cmd=` said, and core keeps only its sanitized program
 * name; `session_index` is the number the drawer shows (`session 1`).
 */
export const TerminalNoticeInput = z.object({
  fleet_id: z.string().min(1),
  agent: AgentName,
  session_id: TerminalSessionId,
  session_index: z.number().int().min(1),
  event: TerminalNoticeEvent,
  program: z.string().nullish(),
  exit_code: z.number().int().optional(),
  ran_ms: z.number().nonnegative().optional(),
});
export type TerminalNoticeInput = z.infer<typeof TerminalNoticeInput>;

/** What `resolveTerminalSession` is told: the session was viewed (`read`) or closed. */
export const TerminalSessionResolveInput = z.object({
  fleet_id: z.string().min(1),
  session_id: TerminalSessionId,
  read: z.boolean(),
});
export type TerminalSessionResolveInput = z.infer<typeof TerminalSessionResolveInput>;

/**
 * The key family every terminal condition belongs to. `notifications.settings`
 * resolves the whole family when `terminal_alerts` goes off, with the same
 * `openKeys` ownership rule the advisories use (`terminal` or `terminal:…`).
 */
export const TERMINAL_KEY_PREFIX = "terminal";

/**
 * `terminal:<fleet_id>:<session_id>:output`: the one condition a session holds.
 * The fleet is in it because the inbox is shared by every fleet this laptop
 * watches, and a key is unique across all of them.
 */
export function terminalOutputKey(fleet_id: string, session_id: string): string {
  return `${TERMINAL_KEY_PREFIX}:${fleet_id}:${session_id}:output`;
}

/**
 * How a `terminal` action names its session: `<agent>/<session_id>`, split on
 * the first `/` (an agent name admits none), like `chatActionRef`.
 */
export function terminalActionRef(agent: string, session_id: string): string {
  return `${agent}/${session_id}`;
}
