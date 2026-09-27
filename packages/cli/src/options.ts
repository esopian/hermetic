/**
 * The global flags, added to every leaf command as well as the root so they can
 * be written on either side of the subcommand (`hermetic --fixture agent ps`
 * and `hermetic agent ps --fixture` both work). None of them carries a default,
 * so `optsWithGlobals()` merges them without a parent clobbering a child.
 */
import type { Command } from "commander";

export function globals(cmd: Command): Command {
  return cmd
    .option("--json", "print a machine-readable document on stdout and nothing else")
    .option("--fixture", "run against the in-memory fixture fleet, no AWS")
    .option(
      "--fleet <fleet-id|alias>",
      "which frozen fleet to run against, by fleet id or display alias; else HERMETIC_FLEET, else the default from `hermetic fleet use`",
    );
}

/** Destructive commands additionally take `--yes`. */
export function destructive(cmd: Command): Command {
  return globals(cmd).option("--yes", "skip the interactive confirmation");
}
