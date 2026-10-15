/**
 * The per-agent operations that are not part of the `agent` group in §9:
 * `upgrade`, `ssh`, `logs`.
 */
import type { Command } from "commander";
import { Command as Cmd, Option } from "commander";
import { openCtx } from "../context.ts";
import { globals } from "../options.ts";
import { defined, toInt, validate } from "../validate.ts";
import { err, out, outJson } from "../io.ts";
import { renderOp } from "../stream.ts";
import { declare } from "../declare.ts";
import { HermesLogFile, LogsInput, SshInput, UpgradeInput } from "@hermetic/core";

const upgradeSchema = declare("upgrade", "upgrade", UpgradeInput);
const sshSchema = declare("ssh", "ssh", SshInput);
const logsSchema = declare("logs", "logs", LogsInput);

export function register(program: Command): void {
  program.addCommand(
    globals(new Cmd("upgrade"))
      .description("pin a new hermes version per agent, or move the whole fleet to a new hermeticd")
      .argument("[name]", "a single agent for --hermes; omit with --all, and always for --hermeticd")
      .option(
        "--hermes <version>",
        "hermes version to pin; takes effect on the next recreate, or at once with --now",
      )
      .option(
        "--hermeticd <version>",
        "hermeticd version the whole fleet moves to; rewrites the fleet manifest, takes no agent name",
      )
      .option("--all", "every agent in the fleet")
      .option(
        "--now",
        "apply it to running boxes now: with --hermes, converge each box onto the pin in place; with --hermeticd, ask every box to take the release even if the fleet does not auto-update (§6.5)",
      )
      .option(
        "--no-rollout",
        "with --hermeticd: move the pointer only; leave each box to its own update check",
      )
      .option(
        "--rollout-wait-ms <ms>",
        "with --hermeticd: how long to watch the boxes land before reporting stragglers (default ten minutes)",
      )
      .addHelpText(
        "after",
        "\nExamples:\n" +
          "  hermetic upgrade atlas --hermes 0.22.0             pin it; the box installs it on its next recreate\n" +
          "  hermetic upgrade atlas --hermes 0.22.0 --now       pin it and converge the running box in place\n" +
          "  hermetic upgrade --all --hermes 0.22.0 --now       the same, one agent at a time across the fleet\n" +
          "  hermetic upgrade --hermeticd 0.6.1                 the fleet's hermeticd; rolled out now if the fleet auto-updates\n" +
          "  hermetic upgrade --hermeticd 0.6.1 --now           rolled out now whatever the fleet's setting\n" +
          "\n--now writes the same converge request `hermetic plan rollout` does: hermeticd\n" +
          "reinstalls Hermes and restarts its units, and this waits up to ten minutes per\n" +
          "box for it to report the new config. A box that is not up (stopped, still\n" +
          "booting) is skipped and keeps the pin for its next boot; one that does not\n" +
          "report in time is a warning, not a failure. The box installs this build's\n" +
          "Hermes ref, exactly as a recreate from this checkout would.\n" +
          "\nWith --hermeticd, a fleet that auto-updates hermeticd (the default; see\n" +
          "`hermetic settings set --no-auto-update-hermeticd`) asks every running box to\n" +
          "take a changed release at once and watches it land; --no-rollout skips that\n" +
          "once, and a fleet with auto-update off waits for each box's nightly check\n" +
          "unless --now is given.\n",
      )
      .action(async (name: string | undefined, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          upgradeSchema,
          defined({
            name,
            hermes: opts["hermes"],
            hermeticd: opts["hermeticd"],
            all: opts["all"],
            now: opts["now"],
            // Commander answers `true` for an absent `--no-rollout`, which the
            // schema would refuse beside `--hermes` alone; only the flag
            // itself is worth stating.
            rollout: opts["rollout"] === false ? false : undefined,
            rollout_wait_ms: toInt(opts["rolloutWaitMs"] as string | undefined),
          }),
        );
        await renderOp(ctx.hermetic.upgrade(input, { signal: ctx.signal }), {
          flags: ctx.flags,
          label: `upgrade ${input.name ?? (input.hermeticd !== undefined ? "the fleet" : "--all")}`,
        });
      }),
  );

  program.addCommand(
    globals(new Cmd("ssh"))
      .description("tailscale ssh into an agent")
      .argument("<name>", "agent name")
      .action(async (name: string, _opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(sshSchema, { name });
        // Core returns argv and never spawns (§3.2 rule 1); the head execs it.
        const argv = await ctx.hermetic.ssh(input);
        if (ctx.flags.json) {
          await outJson({ argv });
          return;
        }
        await err(`${argv.join(" ")}\n`);
        const child = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        process.exitCode = await child.exited;
      }),
  );

  program.addCommand(
    globals(new Cmd("logs"))
      .description("stream an agent's logs over the loopback RPC")
      .argument("<name>", "agent name")
      .argument("[unit]", "systemd unit; defaults to every hermetic unit")
      .option("-f, --follow", "keep the stream open")
      // Hermes's own logs, which are files on the data volume rather than
      // anything journald ever sees: upstream attaches no stderr handler unless
      // it is run verbose, so a failed turn shows up in `errors.log` and not in
      // the unit's journal. Mutually exclusive with `[unit]` and `--console`,
      // which `LogsInput` enforces so every head refuses it the same way.
      // `choices` so a misspelt file is a usage error on the laptop rather than
      // an empty stream from the box.
      .addOption(
        new Option(
          "--file <name>",
          "one of Hermes's own log files on the data volume, instead of a systemd unit",
        ).choices([...HermesLogFile.options]),
      )
      // The fallback for the case the RPC cannot serve: a boot that failed
      // before the tailnet came up. Reads EC2's serial console buffer instead,
      // which needs nothing from the box (§6.3). `[unit]` and `--follow` do not
      // apply — the console is one buffer, not a stream.
      .option("--console", "read the instance's serial console instead of the RPC")
      .action(
        async (name: string, unit: string | undefined, opts: Record<string, unknown>, cmd: Command) => {
          const ctx = await openCtx(cmd);
          const input = validate(
            logsSchema,
            defined({
              name,
              unit,
              file: opts["file"],
              follow: opts["follow"],
              source: opts["console"] ? "console" : undefined,
            }),
          );
          for await (const l of ctx.hermetic.logs(input, { signal: ctx.signal })) {
            if (ctx.flags.json) await out(`${JSON.stringify(l)}\n`);
            else await out(`${l.at} ${l.unit}  ${l.message}\n`);
          }
        },
      ),
  );
}
