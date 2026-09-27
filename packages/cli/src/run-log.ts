/**
 * §4.6: `hermetic runs` is the local log of everything this laptop ran, with
 * the output it produced. One row per process, in three acts.
 *
 * - `startRun()` opens the row from Commander's `preAction` hook, before the
 *   command has done anything, so a command that crashed or was interrupted is
 *   still in the log with the status it ended on.
 * - `annotateRun()` stamps it with the fleet the command turned out to be
 *   against, from `openCtx()` — the first moment anyone knows (§4.8).
 * - `finishRun()` closes it in a `finally`, with the exit code and what the
 *   operator saw.
 *
 * It lives here rather than in `main.ts` because two entry points write to it
 * and `main.ts` is the one module nothing may import: it parses argv and exits
 * at import time.
 *
 * A run log that cannot be opened — a read-only home, a full disk — is never
 * allowed to stop the fleet working, so every call here swallows its failure.
 */
import { isFleetId, runRecorderFor } from "@hermetic/core";
import type { RunRecorder, RunTarget } from "@hermetic/core";
import { capturedOutput } from "./io.ts";
import { secretWasRead } from "./secret.ts";

let runs: RunRecorder | null = null;
let runId: string | null = null;

/**
 * §4.8: what the row says about its fleet *before* core has resolved one.
 *
 * The row is opened from Commander's `preAction` hook, which runs before the
 * action and therefore before `openCtx()` has opened core, so the resolved
 * `fleet_id` does not exist yet. Guessing it here would mean this head
 * re-implementing core's selection chain, and a run log that guessed which
 * fleet a command hit is worse than one that says nothing.
 *
 * So this is provisional: only what `--fleet` itself said, and only when the
 * flag is already a `fleet_id`. A display alias is a label another laptop may
 * move, so recording `staging` as though it were an identity can name a
 * different fleet a month later. `HERMETIC_FLEET` is left out on the same
 * terms — it is the shell's standing answer, not this invocation's.
 *
 * Every one of those cases is covered by `annotateRun` a moment later, which
 * writes the resolved identity over whatever this left. What survives is the
 * run that *never* resolved a fleet: it keeps what the operator asked for, and
 * the readers show a row with no identity as unknown rather than as the fleet
 * they happen to have open.
 *
 * Validating also keeps a rejected `--fleet` out of the column: a bad flag
 * still opens a row, and `fleet: "../../etc"` in the field a later query
 * filters on would be this head recording an argument it knows core refused.
 */
export function provisionalFleet(flag: string | null): string | null {
  return flag !== null && isFleetId(flag) ? flag : null;
}

/**
 * Everything the row can be opened with. Passed in rather than read from
 * `context.ts` so this module sits *below* it: `openCtx` calls `annotateRun`,
 * and a run log that imported the context which imports it back would be a
 * cycle for the sake of two field reads.
 */
export interface StartRunInput {
  fixture: boolean;
  /** `--fleet` as typed, or null. Not `HERMETIC_FLEET`: see `provisionalFleet`. */
  fleetFlag: string | null;
  command: string;
  args: string[];
}

export function startRun(input: StartRunInput): void {
  try {
    runs = runRecorderFor({ fixture: input.fixture });
    if (input.command === "") return;
    runId = runs.start({
      command: input.command,
      args: input.args,
      agent: input.args[0] ?? null,
      fleet: provisionalFleet(input.fleetFlag),
    }).id;
  } catch {
    runs = null;
  }
}

/**
 * §4.6: which fleet this command was against, now that core has said.
 *
 * `hermetic.target` is `null` before `init` — there is no frozen fleet to name —
 * and the row is then left exactly as `startRun` opened it.
 */
export function annotateRun(target: RunTarget | null): void {
  if (!runs || runId === null || target === null) return;
  try {
    runs.annotate(runId, target);
  } catch {
    // Recording is a convenience; failing to record is not a command failure.
  }
}

/** One row's captured output. A command is a command, not a log shipper. */
const MAX_LOGGED_OUTPUT = 4 * 1024;

/**
 * What goes in the `log` column. Two commands get nothing:
 *
 * - `secrets push` reads a value from a prompt or stdin. It never reaches the
 *   transcript, but the log is redacted outright rather than relying on that
 *   (§8.3).
 * - `runs` *prints* the log, so recording its output would fold every previous
 *   row into the next one — 295 bytes becomes 11 KiB in five invocations, and
 *   keeps squaring. The command that reads the log does not write to it.
 */
function loggedOutput(command: string): string {
  if (command.startsWith("secrets push")) return "[redacted]";
  // Any command that read a secret this run — `agent create` with a provider
  // key, say — is redacted on the same principle rather than on a name.
  if (secretWasRead()) return "[redacted]";
  if (command === "runs") return "";
  return capturedOutput().slice(0, MAX_LOGGED_OUTPUT);
}

/**
 * How a long operation settled, for the notification core writes from the row
 * (§4.9). Decided by `main.ts` — which op it was, and whether it is
 * one worth telling the operator about — because that judgement needs the
 * command registry and the abort state this module deliberately sits below.
 */
export interface SettledOp {
  method: string;
  error?: { code: string; message: string };
}

export function finishRun(exitCode: number, command: string, op?: SettledOp): void {
  if (!runs || runId === null) return;
  try {
    runs.finish(runId, {
      exit_code: exitCode,
      log: loggedOutput(command),
      ...(op === undefined ? {} : { op }),
    });
  } catch {
    // Recording is a convenience; failing to record is not a command failure.
  } finally {
    try {
      runs.close();
    } catch {
      // Nothing useful left to do at process exit.
    }
  }
}
