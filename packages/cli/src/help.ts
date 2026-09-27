/**
 * `hermetic --help`'s custom top-level layout: commands grouped the way
 * docs/design.md §9 groups them (fleet / agent / secrets / settings / ops) instead
 * of Commander's default alphabetical dump, plus the exit-code table in the
 * footer. Every other command keeps Commander's default `formatHelp`.
 */
import type { Command, Help } from "commander";
import { exitCodeTable } from "./exit-codes.ts";

/** Root-level command name -> group, per docs/design.md §9. */
const GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  // §4.8: `fleet` (the command group: `fleet ls`/`fleet use`) and `directory`
  // sit in the `fleet` group, so "which fleets are there" reads next to "what
  // is in this one". A group and a command may share a name — the lookup below
  // is by command name, and nothing else consults the label.
  [
    "fleet",
    [
      "init",
      "fleet",
      "directory",
      "config",
      "runs",
      "artifacts",
      "doctor",
      "foundation",
      "teardown",
      "plan",
    ],
  ],
  ["agent", ["agent"]],
  ["secrets", ["secrets"]],
  // §4.6: the fleet's shared settings, and the providers half of them. Its own
  // group rather than a line under `fleet`, because everything in `fleet` is
  // about the foundation and everything here is about what a create inherits.
  ["settings", ["settings", "providers"]],
  ["ops", ["upgrade", "ssh", "logs"]],
  // §9: talking to the fleet, and hearing back from it. `inbox` is the
  // operator's own notification list rather than anything to do with a bot, but
  // it belongs beside chat for the same reason `providers` belongs beside
  // `settings` — an operator looking for one is looking for the other.
  ["chat", ["chat", "bots", "inbox"]],
];

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - text.length));
}

export function formatRootHelp(cmd: Command, helper: Help): string {
  const lines: string[] = [];

  lines.push(`Usage: ${helper.commandUsage(cmd)}`);
  lines.push("");
  const description = helper.commandDescription(cmd);
  if (description) {
    lines.push(description);
    lines.push("");
  }

  const visible = helper.visibleCommands(cmd);
  const byName = new Map(visible.map((c) => [c.name(), c]));
  const grouped = new Set(GROUPS.flatMap(([, names]) => names));
  const termWidth = Math.max(
    ...visible.map((c) => helper.subcommandTerm(c).length),
    "help [command]".length,
  );

  lines.push("Commands, grouped as in docs/design.md §9:");
  lines.push("");
  for (const [group, names] of GROUPS) {
    lines.push(`  ${group}`);
    for (const name of names) {
      const sub = byName.get(name);
      if (!sub) continue;
      const term = helper.subcommandTerm(sub);
      const desc = helper.subcommandDescription(sub);
      lines.push(`    ${pad(term, termWidth)}  ${desc}`);
    }
  }
  const ungrouped = visible.filter((c) => !grouped.has(c.name()) && c.name() !== "help");
  if (ungrouped.length > 0) {
    lines.push("  other");
    for (const sub of ungrouped) {
      lines.push(
        `    ${pad(helper.subcommandTerm(sub), termWidth)}  ${helper.subcommandDescription(sub)}`,
      );
    }
  }
  lines.push(`    ${pad("help [command]", termWidth)}  display help for command`);
  lines.push("");

  lines.push("Global options:");
  for (const option of helper.visibleOptions(cmd)) {
    lines.push(`  ${pad(helper.optionTerm(option), termWidth)}  ${helper.optionDescription(option)}`);
  }
  lines.push("");

  lines.push("Examples:");
  lines.push("  hermetic init                      target an AWS account, first run on this laptop");
  lines.push("  hermetic agent create atlas         create an agent named atlas");
  lines.push("  hermetic --fixture agent ps         list agents against the seeded fixture fleet");
  lines.push(
    "  hermetic agent ps --json | jq .     scriptable output; --json is stdout-only, see above",
  );
  lines.push("");

  lines.push("Run `hermetic <command> --help` for a command's own options and examples.");
  lines.push("");
  lines.push("Exit codes (`hermetic help exit-codes` for the full table with names):");
  lines.push(exitCodeTable());
  lines.push("");

  return lines.join("\n");
}
