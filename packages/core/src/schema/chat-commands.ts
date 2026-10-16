import { z } from "zod";
import { AgentName, BotName } from "./requests.ts";

/**
 * `hermetic chat commands <instance>/<bot>` — the slash commands a bot's
 * gateway offers (§9.2): built-ins, the profile's quick commands, plugin
 * commands and skills, read from upstream's `commands.catalog`
 * (`tui_gateway/methods_tools.py`). What the composer's command picker lists.
 *
 * Kept apart from `requests.ts`, which is near the file-size limit.
 *
 * `session` is the durable conversation the picker is open on. Skill discovery
 * upstream is bound to a live session's profile and workspace; while that
 * conversation is live on the gateway the catalog is read against it, and
 * otherwise against the gateway's launch profile.
 */
export const ChatCommandsInput = z.object({
  instance: AgentName,
  bot: BotName,
  session: z.string().min(1).optional(),
});
export type ChatCommandsInput = z.infer<typeof ChatCommandsInput>;

/**
 * How a command takes its argument, as upstream's desktop composer reads it
 * (`infer_argument_mode`, `hermes_cli/commands.py`): `options` picks from a
 * fixed set, `text` takes free text, `mixed` takes either. Null when the
 * catalog names no argument at all.
 */
export const ChatCommandArgumentMode = z.enum(["options", "text", "mixed"]);
export type ChatCommandArgumentMode = z.infer<typeof ChatCommandArgumentMode>;

/** One command in the catalog. */
export const ChatCommand = z.object({
  /** With its slash, as a `command` block names it: `/help`. */
  name: z.string().regex(/^\/[^\s/]+$/),
  description: z.string(),
  /** The catalog's category (`Session`, `User commands`, …); null for a skill. */
  category: z.string().nullable(),
  argument_mode: ChatCommandArgumentMode.nullable(),
  /**
   * Upstream's desktop disposition: null when a desktop composer offers the
   * command, `hidden` when it runs but stays out of the picker, and otherwise
   * the reason it does not belong in one (`terminal`, `settings`, …).
   */
  desktop: z.string().nullable(),
  /** Present for a skill command: where the skill came from, when the box says. */
  skill: z.object({ origin: z.string().nullable() }).nullable(),
});
export type ChatCommand = z.infer<typeof ChatCommand>;

export const ChatCommandsResult = z.object({
  instance: z.string(),
  bot: z.string(),
  commands: z.array(ChatCommand),
  /** The gateway's discovery warning (a loader that failed), or null. */
  warning: z.string().nullable(),
});
export type ChatCommandsResult = z.infer<typeof ChatCommandsResult>;
