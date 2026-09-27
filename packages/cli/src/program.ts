import * as botMode from "./commands/bot-mode.ts";
/**
 * The Commander tree. Exactly one command per public core method (§11.4), and
 * nothing else: the dashboard is its own binary, `hermetic-portal`, not a
 * subcommand of this one (§3.6). So `CLI_COMMANDS` is the whole tree rather
 * than the tree minus a launcher, and `test/registry.test.ts` asserts it.
 */
import { Command } from "commander";
import { HERMETIC_VERSION } from "@hermetic/core";
import { globals } from "./options.ts";
import { setGlobalFlags, setRunningCommand } from "./context.ts";
import { formatRootHelp } from "./help.ts";
import * as agent from "./commands/agent.ts";
import * as apply from "./commands/plan.ts";
import * as fleet from "./commands/fleet.ts";
import * as fleets from "./commands/fleets.ts";
import * as chat from "./commands/chat.ts";
import * as inbox from "./commands/inbox.ts";
import * as foundation from "./commands/foundation.ts";
import * as init from "./commands/init.ts";
import * as ops from "./commands/ops.ts";
import * as policy from "./commands/policy.ts";
import * as network from "./commands/network.ts";
import * as secrets from "./commands/secrets.ts";
import * as providers from "./commands/providers.ts";
import * as presets from "./commands/presets.ts";
import * as settings from "./commands/settings.ts";
import * as volume from "./commands/volume.ts";

export function buildProgram(): Command {
  const program = globals(new Command("hermetic"))
    .description("fleet manager for Hermes agents on AWS")
    .allowExcessArguments(false)
    .version(HERMETIC_VERSION, "--version", "print the hermetic version and exit");

  // `configureHelp` on a Command instance is not inherited by its
  // subcommands (each has its own, defaulting to `{}`), so this only changes
  // `hermetic --help` itself — `hermetic agent --help` keeps Commander's
  // default per-command formatting.
  program.configureHelp({ formatHelp: formatRootHelp });

  // Resolve the global flags for whichever leaf actually runs, so the error path
  // knows whether it owes stdout a JSON document.
  program.hook("preAction", (_this, actionCommand) => {
    setGlobalFlags(actionCommand.optsWithGlobals() as Record<string, unknown>);
    // The dotted command path, for the run log and the error path.
    const parts: string[] = [];
    for (let cmd: Command | null = actionCommand; cmd?.parent; cmd = cmd.parent) {
      parts.unshift(cmd.name());
    }
    setRunningCommand(parts.join(" "), actionCommand.args.map(String));
  });

  init.register(program);
  fleet.register(program);
  fleets.register(program);
  foundation.register(program);
  agent.register(program);
  volume.register(program);
  secrets.register(program);
  settings.register(program);
  presets.register(program);
  providers.register(program);
  inbox.register(program);
  chat.register(program);
  botMode.register(program);
  ops.register(program);
  policy.register(program);
  network.register(program);
  apply.register(program);

  /**
   * Commander's own usage errors — an unknown command, a missing argument, an
   * unknown option — call `process.exit(1)` themselves. Status 1 is the one
   * `exit-codes.ts` reserves for `INTERNAL`: an unmapped failure of the tool.
   * A typo is not that. `exitOverride` turns each of them into a thrown
   * `CommanderError` instead, which `main.ts` maps to `EXIT_VALIDATION` (2) —
   * the same status a flag that fails core's Zod schema gets, because it is
   * the same kind of mistake. `--help` and `--version` come through the same
   * door with `exitCode` 0 and are not errors at all.
   *
   * Applied to every command in the tree, not just the root: subcommands here
   * are registered with `addCommand`, which — unlike `.command()` — does not
   * copy the parent's inherited settings.
   *
   * Commander's own writers are left alone. Its defaults already put a usage
   * error on stderr and `--help` on stdout, which is the split `--json` needs,
   * and routing them through `io.ts` would mean calling that module's async
   * writers from a synchronous hook — an unawaited `Bun.write` that may not
   * flush before the process exits. Nothing is lost: `io.ts` records what it
   * writes for the local `runs` log (§4.6), and a command Commander refused to
   * parse never opened a run row to record into.
   */
  for (const command of everyCommand(program)) command.exitOverride();

  return program;
}

/** The command and everything registered under it, depth first. */
function everyCommand(command: Command): Command[] {
  return [command, ...command.commands.flatMap(everyCommand)];
}
