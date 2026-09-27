/**
 * The machine-readable command table `tests/parity.test.ts` reads.
 *
 * It is not a table: it is whatever the command tree declared about itself when
 * it was built. Importing the program is what fills it in, so a command that
 * changes the schema it validates with, or is renamed, or disappears, changes
 * this too — there is no second copy for the parity test to agree with.
 */
import { PUBLIC_METHODS } from "@hermetic/core";
import type { PublicMethod } from "@hermetic/core";
import { declarations, type CliCommand } from "./declare.ts";
// Imported for its side effect: every module under `commands/` declares itself
// at import time, and `program.ts` is what pulls all of them in.
import "./program.ts";

export type { CliCommand };

export const CLI_COMMANDS: readonly CliCommand[] = declarations();

/** `{ "agents.list": "agent ps", … }`, as declared. */
export const COMMAND_NAMES: Partial<Record<PublicMethod, string>> = Object.fromEntries(
  CLI_COMMANDS.map((c) => [c.path, c.command]),
);

/** Public methods no command declared itself for. Empty is the contract. */
export function undeclaredMethods(): PublicMethod[] {
  const declared = new Set(CLI_COMMANDS.map((c) => c.path));
  return [...PUBLIC_METHODS].filter((p) => !declared.has(p));
}
