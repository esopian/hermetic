/**
 * Hermes slash commands: how a typed line is recognised as a command, how it
 * splits into `name` + `arg`, and the `command.dispatch` reply union.
 *
 * Ported from upstream's one shared parser (`apps/shared/src/slash.ts`), with
 * the same semantics, so the chat send path and the composer agree with the
 * gateway and with Hermes's own TUI and desktop about what is a command.
 * Upstream's `tui_gateway/methods_tools.py` (`command.dispatch`, `slash.exec`)
 * is the server side.
 */

/**
 * A slash COMMAND invocation: `/` at position 0, a bare name, then whitespace
 * or the end. `/usr/local/bin is missing` (a second slash in the name) and
 * `run /clean` (not at position 0) are prose and go to the model unchanged.
 */
export const SLASH_COMMAND_RE = /^\/[^\s/]*(?:\s|$)/;

export const looksLikeSlashCommand = (text: string): boolean => SLASH_COMMAND_RE.test(text);

// `[\s\S]*`, not `.*`: the argument may span lines (`/goal <multi-line text>`,
// a skill command with pasted context). `.*$` fails the whole match on the
// first newline and turns every multi-line command into an empty name. The
// gateway splits on any whitespace (`split(maxsplit=1)`), so `\S+` for the name
// is the parity rule. Only the separator between name and argument belongs to
// the parser; the argument's interior (runs of spaces, indentation, blank
// lines) survives verbatim.
const SLASH_PARTS_RE = /^(\S+)([\s\S]*)$/;

export interface ParsedSlashCommand {
  /** Argument text with the outer whitespace removed; interior kept verbatim. */
  arg: string;
  /** Lower-cased command name without the slash; `""` for `/`, `/   `, `/ words`. */
  name: string;
}

/**
 * Split `/name arg…` the way the gateway does. The name is lower-cased because
 * every consumer upstream (`resolve_command`, `slash.exec`) is case-insensitive.
 */
export function parseSlashCommand(command: string): ParsedSlashCommand {
  const match = SLASH_PARTS_RE.exec(command.replace(/^\/+/, ""));
  return match
    ? { arg: (match[2] ?? "").trim(), name: (match[1] ?? "").toLowerCase() }
    : { arg: "", name: "" };
}

/**
 * Hermes's "start a new session": `/new [name]` or its alias `/reset`
 * (`hermes_cli/commands.py`). A bot's canonical Bot Chat compacts instead, since
 * the forever-chat never resets; any other session opens a fresh one (§9.2).
 */
export function isNewSessionCommand(text: string): boolean {
  const line = text.trim();
  return looksLikeSlashCommand(line) && ["new", "reset"].includes(parseSlashCommand(line).name);
}

/**
 * `/compress [focus]` or its alias `/compact`. Run on the gateway's
 * `session.compress`, never through the slash worker: Desktop makes it an
 * action for the same reason, since the worker's pipe times out before a large
 * session's summary call finishes (`desktop-slash-commands.ts`, hermes#44456).
 */
export function isCompactCommand(text: string): boolean {
  const line = text.trim();
  return looksLikeSlashCommand(line) && ["compact", "compress"].includes(parseSlashCommand(line).name);
}

/** Every directive `command.dispatch` can answer with (upstream's `DispatchType`). */
export const DISPATCH_TYPES = ["exec", "alias", "plugin", "send", "skill", "prefill"] as const;
export type DispatchType = (typeof DISPATCH_TYPES)[number];

export interface ExecCommandDispatch {
  output?: string | undefined;
  type: "exec" | "plugin";
}

export interface AliasCommandDispatch {
  target: string;
  type: "alias";
}

export interface SkillCommandDispatch {
  /**
   * The invocation a surface may show (`/work fix the leak`). `message` is the
   * expanded skill body: model-facing scaffolding no surface shows.
   */
  display?: string | undefined;
  message?: string | undefined;
  name: string;
  type: "skill";
}

export interface SendCommandDispatch {
  /** Set for a skill-bundle send: see `SkillCommandDispatch.display`. */
  display?: string | undefined;
  message: string;
  notice?: string | undefined;
  type: "send";
}

export interface PrefillCommandDispatch {
  message: string;
  notice?: string | undefined;
  type: "prefill";
}

export type CommandDispatch =
  | AliasCommandDispatch
  | ExecCommandDispatch
  | PrefillCommandDispatch
  | SendCommandDispatch
  | SkillCommandDispatch;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Narrow a raw `command.dispatch` (or directive-carrying `slash.exec`) result
 * to the union, or `null` when the payload is malformed: not an object, a
 * required field missing, or a `type` this build does not know.
 */
export function parseCommandDispatch(raw: unknown): CommandDispatch | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  switch (row.type) {
    case "alias":
      return typeof row.target === "string" ? { target: row.target, type: "alias" } : null;
    case "exec":
    case "plugin":
      return { output: str(row.output), type: row.type };
    case "prefill":
      return typeof row.message === "string"
        ? { message: row.message, notice: str(row.notice), type: "prefill" }
        : null;
    case "send":
      return typeof row.message === "string"
        ? { display: str(row.display), message: row.message, notice: str(row.notice), type: "send" }
        : null;
    case "skill":
      return typeof row.name === "string"
        ? { display: str(row.display), message: str(row.message), name: row.name, type: "skill" }
        : null;
    default:
      return null;
  }
}

// --- The composer's slash-command picker ----------------------------------
// When it opens, what it lists, and what accepting a row does to the text.
// It opens only on a line that is nothing but a command name being typed (`/`
// at position 0, no whitespace or second `/` yet): the head of
// `SLASH_COMMAND_RE`, so `run /clean` and `/usr/local` never open it and the
// space that ends the name closes it. Desktop and phone composers share it.

/**
 * The fields of a catalog command (`ChatCommand`, `@hermetic/core/schema`)
 * the picker reads. Structural, since `shared` may not import `schema`.
 */
export interface SlashCommandLike {
  argument_mode: string | null;
  desktop: string | null;
  name: string;
  skill: object | null;
}

/** A row on show: the command, and where the typed text sits in its name (slash excluded). */
export interface SlashMatch<C extends SlashCommandLike = SlashCommandLike> {
  command: C;
  end: number;
  start: number;
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
export function offered(command: SlashCommandLike): boolean {
  return command.desktop === null;
}

/**
 * The offered commands matching `query`: names starting with it first, then
 * names containing it, each group in the catalog's order. An empty query
 * lists them all.
 */
export function filterSlashCommands<C extends SlashCommandLike>(
  commands: readonly C[],
  query: string,
): SlashMatch<C>[] {
  const q = query.toLowerCase();
  const prefix: SlashMatch<C>[] = [];
  const inner: SlashMatch<C>[] = [];
  for (const command of commands) {
    if (!offered(command)) continue;
    const at = command.name.slice(1).toLowerCase().indexOf(q);
    if (at < 0) continue;
    (at === 0 ? prefix : inner).push({ command, end: at + q.length, start: at });
  }
  return [...prefix, ...inner];
}

/**
 * Whether accepting the command leaves room for an argument. A skill always
 * does (its argument is the request); anything the catalog names no argument
 * mode for takes none, and Enter on it sends it as it stands.
 */
export function takesArgument(command: SlashCommandLike): boolean {
  return command.skill !== null || command.argument_mode !== null;
}

/** The composer's text once a row is accepted: the name and one space, caret at the end. */
export function acceptSlash(command: SlashCommandLike): string {
  return `${command.name} `;
}
