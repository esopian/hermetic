/**
 * `hermetic settings …` (§9): the fleet's *shared* settings, as against the
 * per-laptop `prefs` table (§4.6).
 *
 * `hermetic providers …` writes the same `_fleet.settings` object through the
 * same conditional write, but it is five commands over five methods and it lives
 * in `providers.ts`: since §8.3 that group is about *profiles*, which are their
 * own objects with their own key space, and keeping them here would have made
 * this file the settings surface plus a second surface that happens to share a
 * DynamoDB item.
 *
 * The write takes `--expected-version`, which is how a script says "apply this
 * to the settings I read a moment ago, or fail" rather than last-write-wins.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import { openCtx } from "../context.ts";
import { globals } from "../options.ts";
import { defined, toInt, validate } from "../validate.ts";
import { out, outJson } from "../io.ts";
import { renderSettings } from "../table.ts";
import { declare } from "../declare.ts";
import { SettingsGetInput, SettingsSetInput } from "@hermetic/core";
import type { HermesSettings } from "@hermetic/core";

const getSchema = declare("settings.get", "settings show", SettingsGetInput);
const setSchema = declare("settings.set", "settings set", SettingsSetInput);

/** `--expected-version 3`, shared by both writes. */
function expected(opts: Record<string, unknown>): { expected_version?: number } {
  const n = toInt(opts["expectedVersion"] as string | undefined);
  return n === undefined ? {} : { expected_version: n };
}

export function register(program: Command): void {
  const settings = new Cmd("settings").description(
    "the fleet's shared settings: defaults every laptop inherits",
  );

  settings.addCommand(
    globals(new Cmd("show"))
      .description("the fleet's shared defaults, agent defaults and provider profiles")
      .addHelpText(
        "after",
        "\nThese live on `_fleet` in DynamoDB, so a second laptop that attaches to this\n" +
          "fleet reads the same answers. `version (not written yet)` means the fleet\n" +
          "predates shared settings and this is what it would have: run\n" +
          "`hermetic foundation update`, or simply set something.\n",
      )
      .action(async (_opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const result = await ctx.hermetic.settings.get(validate(getSchema, {}));
        if (ctx.flags.json) await outJson(result);
        else await out(`${renderSettings(result)}\n`);
      }),
  );

  settings.addCommand(
    globals(new Cmd("set"))
      .description("change the fleet's defaults, or the Hermes settings a create seeds")
      .option("--size <size>", "default instance size for a new agent")
      .option("--default-profile <id|name>", "the provider profile a create with no flags uses")
      .option("--volume-gib <gib>", "default data volume size in GiB")
      .option("--root-gib <gib>", "default root (system) disk size in GiB")
      .option("--secrets <mode>", "none | bitwarden")
      .option("--model <id>", "fleet-wide default model id")
      .option("--terminal <backend>", "local | docker")
      .option("--max-turns <n>", "ceiling on tool-calling turns in one agent run")
      .option("--reasoning <effort>", "low | medium | high")
      .option("--approvals <mode>", "smart | manual | off (default off)")
      .option("--clear-agent-defaults", "drop the fleet-wide Hermes settings entirely")
      .option("--expected-version <n>", "refuse unless the settings are still at this version")
      .addHelpText(
        "after",
        "\nA fleet default is not a per-agent instruction: an agent that never stated a\n" +
          "setting is *seeded* with the fleet's answer and then owns it, so its own\n" +
          "dashboard can still change it (§6.4).\n" +
          "\nExamples:\n" +
          "  hermetic settings set --default-profile anthropic-main\n" +
          "  hermetic settings set --size large --volume-gib 200\n" +
          "  hermetic settings set --model claude-sonnet-5 --expected-version 3\n",
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const defaults = defined({
          size: opts["size"],
          volume_gib: toInt(opts["volumeGib"] as string | undefined),
          root_gib: toInt(opts["rootGib"] as string | undefined),
          secrets: opts["secrets"],
        });
        const hermes = defined({
          model: opts["model"],
          terminal_backend: opts["terminal"],
          max_turns: toInt(opts["maxTurns"] as string | undefined),
          reasoning_effort: opts["reasoning"],
          // Seeded rather than managed on every agent it reaches (§6.4), so
          // this is the fleet's starting answer and not a hold on the box.
          approvals_mode: opts["approvals"],
        }) as HermesSettings;
        // `--clear-agent-defaults` is the one thing an absent flag cannot say,
        // so it is a flag of its own rather than an empty `--model`.
        const agentDefaults =
          opts["clearAgentDefaults"] === true
            ? { agent_defaults: null }
            : Object.keys(hermes).length > 0
              ? { agent_defaults: hermes }
              : {};
        const input = validate(setSchema, {
          ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
          // §8.3: an id or a name, resolved by core — the same vocabulary
          // `agent create --provider-profile` takes, so an operator does not
          // learn two ways to name the same object.
          ...defined({ default_profile: opts["defaultProfile"] }),
          ...agentDefaults,
          ...expected(opts),
        });
        const result = await ctx.hermetic.settings.set(input);
        if (ctx.flags.json) await outJson(result);
        else await out(`${renderSettings(result)}\n`);
      }),
  );

  program.addCommand(settings);
}
