/**
 * The composer's slash-command picker, as pure functions: when it opens, what
 * it lists, and what accepting a row does to the text.
 *
 * It opens only on a line that is nothing but a command name being typed —
 * `/` at position 0 and no whitespace or second `/` yet — which is the head of
 * the send path's own rule (`looksLikeSlashCommand`, `@hermetic/core/shared`).
 * So `run /clean` and `/usr/local` never open it, and the space that ends the
 * name closes it.
 */
import type { ChatCommandView } from "../api/types.ts";

/** A row on show: the command, and where the typed text sits in its name (slash excluded). */
export interface SlashMatch {
  command: ChatCommandView;
  start: number;
  end: number;
}

const TYPING_NAME = /^\/([^\s/]*)$/;

/** The name being typed, lower-cased and without its slash, or null when the picker is shut. */
export function slashQuery(text: string): string | null {
  const match = TYPING_NAME.exec(text);
  return match ? (match[1] ?? "").toLowerCase() : null;
}

/**
 * Whether a picker lists the command. Upstream's desktop disposition is null
 * for a command a desktop composer offers; `hidden` and every reason
 * (`terminal`, `settings`, …) keep it out, though typing it still runs it.
 */
export function offered(command: ChatCommandView): boolean {
  return command.desktop === null;
}

/**
 * The offered commands matching `query`: names starting with it first, then
 * names containing it, each group in the catalog's order. An empty query
 * lists them all.
 */
export function filterSlashCommands(commands: readonly ChatCommandView[], query: string): SlashMatch[] {
  const q = query.toLowerCase();
  const prefix: SlashMatch[] = [];
  const inner: SlashMatch[] = [];
  for (const command of commands) {
    if (!offered(command)) continue;
    const at = command.name.slice(1).toLowerCase().indexOf(q);
    if (at < 0) continue;
    (at === 0 ? prefix : inner).push({ command, start: at, end: at + q.length });
  }
  return [...prefix, ...inner];
}

/**
 * Whether accepting the command leaves room for an argument. A skill always
 * does (its argument is the request); anything the catalog names no argument
 * mode for takes none, and Enter on it sends it as it stands.
 */
export function takesArgument(command: ChatCommandView): boolean {
  return command.skill !== null || command.argument_mode !== null;
}

/** The composer's text once a row is accepted: the name and one space, caret at the end. */
export function acceptSlash(command: ChatCommandView): string {
  return `${command.name} `;
}
