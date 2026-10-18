/**
 * The fixture's stand-in for the gateway's command layer (`slash.exec` /
 * `command.dispatch`, and `commands.catalog`), so a slash command typed into a
 * fixture chat is answered the way a real box answers it, with no model turn,
 * and the composer's picker has a catalog to list.
 *
 * A handful of commands, one per directive the live adapter treats apart
 * (`hermes-chat-command.ts`): `/help` and `/version` are plain worker output,
 * `/goal <text>` and `/queue <text>` are `send` directives whose message
 * becomes the prompt, `/sketch-helper` is a skill whose message does, `/undo`
 * is a `prefill` this chat reports as unsupported, and anything else is the
 * worker's unknown-command answer.
 */
import type { CommandBlock } from "../../schema/index.ts";
import { looksLikeSlashCommand, parseSlashCommand } from "../../shared/slash.ts";
import { mapCommandCatalog } from "../../chat/hermes/hermes-chat-commands.ts";
import type { CommandCatalog } from "../../chat/hermes/hermes-chat-commands.ts";

export const FIXTURE_HELP_OUTPUT = [
  "Available commands:",
  "  /help            Show this list",
  "  /goal <text>     Set a standing goal and start on it",
  "  /queue <text>    Queue a prompt for the next turn",
  "  /undo            Rewind the last exchange",
  "  /version         Show the Hermes version",
].join("\n");

/**
 * The fixture box's `commands.catalog` reply, in the gateway's own wire shape
 * and read through the live adapter's mapper, so the fixture exercises it.
 * `/skin` is terminal-only upstream (`desktop: "terminal"`), so a picker
 * leaves it out; `/version` takes no argument; `/sketch-helper` is a skill.
 */
const FIXTURE_CATALOG_WIRE = {
  pairs: [
    ["/goal", "Set a standing goal Hermes works on across turns until achieved"],
    ["/queue", "Queue a prompt for the next turn"],
    ["/undo", "Back up N user turns and re-prompt (default 1)"],
    ["/skin", "Show or change the display skin/theme"],
    ["/help", "Show available commands"],
    ["/version", "Show Hermes Agent version"],
    ["/sketch-helper", "Sketch a diagram from a description"],
  ],
  commands: {
    "/goal": { argument_mode: "mixed", desktop: null },
    "/queue": { argument_mode: "mixed", desktop: null },
    "/q": { argument_mode: "mixed", desktop: null },
    "/undo": { argument_mode: "text", desktop: null },
    "/skin": { argument_mode: "options", desktop: "terminal" },
    "/help": { argument_mode: "text", desktop: null },
    "/version": { argument_mode: null, desktop: null },
  },
  categories: [
    {
      name: "Session",
      pairs: [
        ["/goal", ""],
        ["/queue", ""],
        ["/undo", ""],
      ],
    },
    { name: "Configuration", pairs: [["/skin", ""]] },
    {
      name: "Info",
      pairs: [
        ["/help", ""],
        ["/version", ""],
      ],
    },
  ],
  skills: { "/sketch-helper": { usage: 3, origin: "bundled" } },
  skill_count: 1,
  warning: "",
};

/** The fixture box's command catalog, fresh each call. */
export function fixtureCommandCatalog(): CommandCatalog {
  return mapCommandCatalog(FIXTURE_CATALOG_WIRE);
}

/** What a fixture command came to: the blocks to show, and the prompt still to submit. */
export interface FixtureCommand {
  blocks: CommandBlock[];
  prompt: string | null;
}

/** The fixture's answer to `text`, or null when `text` is not a command. */
export function fixtureCommand(text: string, attachments: number): FixtureCommand | null {
  if (!looksLikeSlashCommand(text)) return null;
  const { name, arg } = parseSlashCommand(text);
  const command = `/${name}`;
  const answered = (b: Omit<CommandBlock, "kind" | "command">, prompt: string | null = null) => ({
    blocks: [{ kind: "command" as const, command, ...b }],
    prompt,
  });
  if (attachments > 0)
    return answered({
      output: "A slash command cannot carry attachments. Send the files in a message of their own.",
      state: "error",
    });
  switch (name) {
    case "help":
      return answered({ output: FIXTURE_HELP_OUTPUT, state: "done" });
    case "version":
      return answered({ output: "Hermes Agent v2026.9.24 (fixture)", state: "done" });
    case "goal":
      return arg
        ? answered({ output: `⊙ Goal set: ${arg}`, state: "done", dispatch: "send" }, arg)
        : answered({ output: "usage: /goal <text>", state: "error" });
    case "queue":
      return arg
        ? { blocks: [], prompt: arg }
        : answered({ output: "usage: /queue <prompt>", state: "error" });
    case "sketch-helper":
      // A skill answers with its expanded body as the prompt, and no block.
      return { blocks: [], prompt: `Sketch a diagram of: ${arg || "this conversation"}` };
    case "undo":
      return answered({
        output:
          "↶ Rewound the last exchange.\nThis chat cannot put text back into the composer; the text it returned is below.",
        state: "unsupported",
        dispatch: "prefill",
        prefill: "the message before last",
      });
    default:
      return answered({
        output: `Unknown command ${command} — nothing was sent.\nType /help for the full list.`,
        state: "error",
      });
  }
}
