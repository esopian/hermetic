/**
 * The fixture's stand-in for the gateway's command layer (`slash.exec` /
 * `command.dispatch`), so a slash command typed into a fixture chat is
 * answered the way a real box answers it, with no model turn.
 *
 * A handful of commands, one per directive the live adapter treats apart
 * (`hermes-chat-command.ts`): `/help` is plain worker output, `/goal <text>`
 * and `/queue <text>` are `send` directives whose message becomes the prompt,
 * `/undo` is a `prefill` this chat reports as unsupported, and anything else
 * is the worker's unknown-command answer.
 */
import type { CommandBlock } from "../../schema/index.ts";
import { looksLikeSlashCommand, parseSlashCommand } from "../../shared/slash.ts";

export const FIXTURE_HELP_OUTPUT = [
  "Available commands:",
  "  /help            Show this list",
  "  /goal <text>     Set a standing goal and start on it",
  "  /queue <text>    Queue a prompt for the next turn",
  "  /undo            Rewind the last exchange",
].join("\n");

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
    case "goal":
      return arg
        ? answered({ output: `⊙ Goal set: ${arg}`, state: "done", dispatch: "send" }, arg)
        : answered({ output: "usage: /goal <text>", state: "error" });
    case "queue":
      return arg
        ? { blocks: [], prompt: arg }
        : answered({ output: "usage: /queue <prompt>", state: "error" });
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
