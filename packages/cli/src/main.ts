#!/usr/bin/env bun
/**
 * `bun run cli -- <args>`. Owns the two things core refuses to do: talking to a
 * human, and exiting (§3.2 rule 1).
 */
import { CommanderError } from "commander";
import { STREAMING_METHODS, disposeChatRequestPools, isHermeticError } from "@hermetic/core";
import { buildProgram } from "./program.ts";
import { CLI_COMMANDS } from "./registry.ts";
import { abortAll, aborted, globalFlags, runningCommand } from "./context.ts";
import {
  EXIT_ABORTED,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_VALIDATION,
  exitCodeFor,
  exitCodeTable,
} from "./exit-codes.ts";
import { err, outJson } from "./io.ts";
/**
 * §4.6: the local run log, opened before the command and closed after it. Its
 * third act — stamping the row with the fleet core resolved — belongs to
 * `openCtx`, which is where that first becomes knowable (§4.8).
 */
import { finishRun, startRun } from "./run-log.ts";
import { ValidationFailure } from "./validate.ts";

/** How long a graceful unwind gets before Ctrl-C stops being a request. */
const ABORT_GRACE_MS = 1500;

let interrupts = 0;
process.on("SIGINT", () => {
  interrupts += 1;
  // The first Ctrl-C trips the AbortSignal so core can unwind and the head can
  // print what happened; a second one is an order. The timer covers the case
  // where nothing is listening to the signal at all — a command blocked reading
  // a secret from stdin, say — so Ctrl-C always ends the process.
  if (interrupts > 1) process.exit(EXIT_ABORTED);
  abortAll();
  setTimeout(() => process.exit(EXIT_ABORTED), ABORT_GRACE_MS).unref();
});

/**
 * What the command failed with, for the notification `finishRun` writes (§4.9). Recorded rather than re-derived: by the time the run row is
 * finalised the error is gone and only the exit status is left, and "exit 1" is
 * not something core could have worded a row from.
 */
let failure: { code: string; message: string } | null = null;

/**
 * The one place a failure becomes an exit status and some text.
 *
 * The double write in each branch is deliberate, not a leftover: in `--json`
 * mode stdout gets exactly one machine document and stderr gets the sentence a
 * human reads (§4.7). They are not the same message and they do not go to the
 * same place — `hermetic … --json | jq` has to keep working while the operator
 * still sees what went wrong in the terminal. Without `--json`, stdout is left
 * untouched entirely: a command that failed printed no result, so a script
 * reading its stdout reads nothing rather than reading prose.
 */
async function report(e: unknown): Promise<number> {
  const flags = globalFlags();

  /**
   * Commander refused to parse: unknown command, missing argument, unknown
   * option — or `--help`/`--version`, which come through here too and are not
   * failures. Commander has already written its own output (a usage error to
   * stderr, help and the version to stdout), so this owes stderr nothing and
   * `--json` its one document.
   *
   * The carve-out: `--json --help` still prints help prose to stdout and exits
   * 0. Help is not a result, it is the thing an operator asked to read, and a
   * `--json` document saying "here is some help" would be neither readable nor
   * parseable. `usage.test.ts` pins it.
   */
  if (e instanceof CommanderError) {
    if (e.exitCode === 0) return EXIT_OK;
    // The flags were never resolved: a command that never started never ran
    // the `preAction` hook that reads them. argv is what there is.
    if (flags.json || process.argv.slice(2).includes("--json")) {
      await outJson({ error: { code: "VALIDATION", message: usageMessage(e) } });
    }
    return EXIT_VALIDATION;
  }

  if (e instanceof ValidationFailure) {
    const detail = e.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n");
    if (flags.json) {
      await outJson({ error: { code: "VALIDATION", message: e.message, issues: e.issues } });
    }
    await err(`error: invalid arguments\n${detail}\n`);
    return EXIT_VALIDATION;
  }

  if (isHermeticError(e)) {
    failure = { code: e.code, message: e.message };
    if (flags.json) await outJson({ error: { code: e.code, message: e.message } });
    await err(`error: ${e.code}: ${e.message}\n`);
    return exitCodeFor(e.code);
  }

  const message = e instanceof Error ? e.message : String(e);
  failure = { code: "INTERNAL", message };
  if (flags.json) await outJson({ error: { code: "INTERNAL", message } });
  await err(`error: ${message}\n`);
  return EXIT_FAILURE;
}

/**
 * Commander's message, as the JSON document should carry it. Two adjustments:
 * `commander.help` — no command typed at all, so Commander printed the help to
 * stderr and refused — has no sentence, only the literal `(outputHelp)`; and
 * every other message is prefixed `error: `, which belongs to the terminal line
 * Commander already wrote and not inside a field called `message`.
 *
 * (`commander.helpDisplayed`, the `--help` the operator asked for, never
 * reaches here: it exits 0, which `report` returns on above.)
 */
function usageMessage(e: CommanderError): string {
  if (e.code === "commander.help") return "no command given";
  return e.message.replace(/^error: /, "");
}

/**
 * Whether this command was a *long operation*, and how it settled (§4.9).
 * Core writes the `operation.failed` / `operation.done` row from what
 * this returns; the head only says which op it was.
 *
 * Three commands get nothing, for three different reasons:
 *
 * - Anything that is not a `STREAMING_METHODS` member. `agent ps` finishing is
 *   not news, and an inbox that recorded every read would be an inbox nobody
 *   opens.
 * - An **aborted** run. Ctrl-C is the operator's own action; telling them about
 *   it is telling them what they just did.
 * - A **validation** refusal. Nothing was attempted — the flags were wrong, the
 *   terminal said so a second ago, and a row saying `create failed: VALIDATION`
 *   is a note about a typo.
 */
function settledOp(
  command: string,
  exitCode: number,
): { method: string; error?: { code: string; message: string } } | undefined {
  if (aborted() || exitCode === EXIT_ABORTED || exitCode === EXIT_VALIDATION) return undefined;
  const declared = CLI_COMMANDS.find((c) => c.command === command);
  if (!declared || !STREAMING_METHODS.includes(declared.path)) return undefined;
  if (exitCode === EXIT_OK) return { method: declared.path };
  return {
    method: declared.path,
    // §8.3: a code and a message, both already safe to write down. An exit
    // status with no error behind it still names the op that produced it.
    error: failure ?? { code: "INTERNAL", message: `exited ${exitCode}` },
  };
}

// `hermetic help exit-codes` is a help topic, not a command wrapping a core
// method — it isn't in `CLI_COMMANDS` and never will be, so it's handled ahead
// of Commander entirely rather than registered as a subcommand (which would
// make it indistinguishable from the real, core-backed command tree). The
// same table is in the `--help` footer (packages/cli/src/help.ts).
{
  const rest = process.argv.slice(2).join(" ");
  if (rest === "help exit-codes" || rest === "exit-codes") {
    process.stdout.write(`exit codes:\n${exitCodeTable()}\n`);
    process.exit(0);
  }
}

const program = buildProgram();
// The command name is only known once Commander has parsed, so the row opens in
// the same hook that resolves the global flags.
program.hook("preAction", () => {
  const flags = globalFlags();
  const { command, args } = runningCommand();
  startRun({ fixture: flags.fixture, fleetFlag: flags.fleetFlag, command, args });
});

try {
  await program.parseAsync(process.argv);
  // A command that finished after Ctrl-C still exited because of Ctrl-C.
  if (aborted()) process.exitCode = EXIT_ABORTED;
} catch (e) {
  process.exitCode = await report(e);
} finally {
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
  const { command } = runningCommand();
  finishRun(exitCode, command, settledOp(command, exitCode));
  /**
   * Core pools Bot Mode's request sockets per box, and `hermetic bots …` is the
   * one command family that opens one. This process is over: the pool would
   * hold that socket for its idle TTL, and the whole point of a one-shot CLI is
   * that it stops when the command does.
   *
   * Dispose rather than opt out of pooling entirely, because the commands that
   * open a socket at all open several — `bots capabilities` is three probes —
   * and one dial instead of two is worth having even inside a single command.
   */
  disposeChatRequestPools();
}
