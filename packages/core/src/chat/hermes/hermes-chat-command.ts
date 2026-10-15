/**
 * A slash command typed into the chat, run by the gateway's command layer
 * instead of being sent to the model as a prompt (§9.2).
 *
 * The flow is upstream's own, as Hermes's TUI and desktop run it
 * (`ui-tui/src/app/createSlashHandler.ts`): `slash.exec` first, which answers
 * a worker command with its text and forwards pending-input built-ins and
 * bundles to `command.dispatch` itself; then `command.dispatch` only when
 * `slash.exec` refused because it does not own the command (a skill command,
 * a snapshot restore). Any other refusal is the answer: re-dispatching after
 * a command that already ran (`/retry`, `/undo`, `/compress`) would run a
 * mutating command twice.
 *
 * Every directive is either carried out or said to be unsupported:
 * `exec`/`plugin` (and plain `slash.exec` output) become a `command` block;
 * `alias` dispatches its target; `send`/`skill` hand their `message` back to
 * the turn as the prompt; `prefill` (put text back in the composer) has no
 * way to reach a composer from here and is reported `unsupported`, with the
 * text it returned.
 */
import { HermeticError } from "../../errors.ts";
import type { ChatFrame, CommandBlock } from "../../schema/index.ts";
import { parseCommandDispatch, parseSlashCommand, type CommandDispatch } from "../../shared/slash.ts";
import type { Rpc } from "./hermes-chat-rpc.ts";
import { describe, rec, str } from "./hermes-chat-wire.ts";

/**
 * How long a command may take to answer. Longer than a prompt's first-frame
 * wait, because the gateway answers only when the command is done: `/compress`
 * runs a model call, a first `slash.exec` starts the session's worker process.
 */
export const COMMAND_DEADLINE_MS = 120_000;

/** How many `alias` hops one line may take before it is called a loop. */
const ALIAS_HOPS_MAX = 4;

/** Upstream's "not dispatchable here" refusal code (`methods_tools.py`). */
const NOT_DISPATCHABLE = 4018;

/**
 * The two 4018 texts with which `slash.exec` says a command is not its own.
 * Every other 4018 came from a `command.dispatch` handler it already forwarded
 * to — mirrored from upstream's `NOT_MINE_REFUSAL_RE` (`userMessages.ts`).
 */
const NOT_MINE =
  /skill command: use command\.dispatch for \/|use command\.dispatch for \/snapshot restore/;

/**
 * The slash worker's answer to a name it has no handler for, which arrives as
 * ordinary output rather than an error: `Unknown command /x — nothing was
 * sent.` (`hermes_cli/cli_unknown_command.py`). Read so the block says the
 * command failed instead of drawing the refusal as a success.
 */
const UNKNOWN_COMMAND = /^\W*Unknown command \/\S*/;

/** What a command line came to: answered in full, or a prompt to submit. */
export type CommandOutcome = { prompt: null } | { prompt: string };

/** Whether a failed `slash.exec` may fall through to `command.dispatch`. */
export function dispatchFallback(e: unknown): boolean {
  return e instanceof HermeticError && e.details?.code === NOT_DISPATCHABLE && NOT_MINE.test(e.message);
}

/** The gateway's refusal text, without the instance prefix the transport adds. */
function refusal(e: unknown, instance: string): string {
  const text = describe(e);
  return text.startsWith(`${instance}: `) ? text.slice(instance.length + 2) : text;
}

/** `slash.exec`'s `warning`, as a field only when there is one. */
function warningOf(reply: Record<string, unknown> | null): { warning?: string } {
  const warning = str(reply?.warning);
  return warning ? { warning } : {};
}

const unreadable = (method: string): string =>
  `The gateway answered ${method} with a reply this build cannot read.`;

export interface CommandTurn {
  rpc: Rpc;
  instance: string;
  /** The runtime session the command runs against. */
  session: string;
  /** The line as typed. */
  line: string;
  /** The turn's message id, which every frame here carries. */
  message: string;
  signal: AbortSignal | undefined;
}

/**
 * Run one command line. Yields the `command` blocks the transcript shows and
 * returns the prompt the turn must still submit (`send`/`skill`), or none.
 *
 * Exactly one dispatch per line: one `slash.exec`, plus one `command.dispatch`
 * only when `slash.exec` disowned the command; an `alias` re-runs the same
 * pair for its target.
 */
export async function* runCommand(turn: CommandTurn): AsyncGenerator<ChatFrame, CommandOutcome> {
  const block = (b: Omit<CommandBlock, "kind">): ChatFrame => ({
    type: "block",
    seq: 0,
    message: turn.message,
    block: { kind: "command", ...b },
  });

  let line = turn.line;
  for (let hop = 0; ; hop += 1) {
    const { name, arg } = parseSlashCommand(line);
    const command = `/${name}`;
    if (!name) {
      yield block({ command: "/", output: "No command name after the slash.", state: "error" });
      return { prompt: null };
    }

    let raw: unknown;
    let dispatched: CommandDispatch | null;
    try {
      raw = await turn.rpc.request(
        "slash.exec",
        { session_id: turn.session, command: line.replace(/^\/+/, "") },
        COMMAND_DEADLINE_MS,
        { signal: turn.signal },
      );
      dispatched = parseCommandDispatch(raw);
    } catch (e) {
      if (!dispatchFallback(e)) {
        if (e instanceof HermeticError && e.code === "ABORTED") throw e;
        yield block({ command, output: refusal(e, turn.instance), state: "error" });
        return { prompt: null };
      }
      try {
        raw = await turn.rpc.request(
          "command.dispatch",
          { session_id: turn.session, name, arg },
          COMMAND_DEADLINE_MS,
          { signal: turn.signal },
        );
      } catch (err) {
        if (err instanceof HermeticError && err.code === "ABORTED") throw err;
        yield block({ command, output: refusal(err, turn.instance), state: "error" });
        return { prompt: null };
      }
      dispatched = parseCommandDispatch(raw);
      if (!dispatched) {
        yield block({ command, output: unreadable("command.dispatch"), state: "error" });
        return { prompt: null };
      }
    }

    if (!dispatched) {
      // A directive `slash.exec` forwarded, but one this build cannot read.
      if (rec(raw)?.type != null) {
        yield block({ command, output: unreadable("slash.exec"), state: "error" });
        return { prompt: null };
      }
      // Plain `slash.exec` output: a worker or plugin command's text. An
      // unknown command is answered here too, as text, not as a refusal.
      const reply = rec(raw);
      const output = str(reply?.output) ?? "";
      yield block({
        command,
        output,
        ...warningOf(reply),
        state: UNKNOWN_COMMAND.test(output) ? "error" : "done",
      });
      return { prompt: null };
    }

    switch (dispatched.type) {
      case "exec":
      case "plugin":
        yield block({
          command,
          output: dispatched.output ?? "",
          ...warningOf(rec(raw)),
          state: "done",
          dispatch: dispatched.type,
        });
        return { prompt: null };
      case "alias": {
        if (hop + 1 >= ALIAS_HOPS_MAX) {
          yield block({
            command,
            output: `Alias loop: ${command} still names another command after ${ALIAS_HOPS_MAX} hops.`,
            state: "error",
            dispatch: "alias",
          });
          return { prompt: null };
        }
        line = `/${dispatched.target.replace(/^\/+/, "")}${arg ? ` ${arg}` : ""}`;
        continue;
      }
      case "send":
      case "skill": {
        const notice = dispatched.type === "send" ? dispatched.notice?.trim() : undefined;
        const prompt = dispatched.message?.trim() ? dispatched.message : null;
        if (notice || !prompt)
          yield block({
            command,
            output: prompt ? (notice ?? "") : `${command} returned no message to send.`,
            state: prompt ? "done" : "error",
            dispatch: dispatched.type,
          });
        return { prompt };
      }
      case "prefill":
        yield block({
          command,
          output: [
            dispatched.notice?.trim(),
            "This chat cannot put text back into the composer; the text it returned is below.",
          ]
            .filter(Boolean)
            .join("\n"),
          state: "unsupported",
          dispatch: "prefill",
          prefill: dispatched.message,
        });
        return { prompt: null };
    }
  }
}
