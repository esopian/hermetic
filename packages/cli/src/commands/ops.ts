/**
 * The per-agent operations that are not part of the `agent` group in §9:
 * `upgrade`, `ssh`, `logs`.
 */
import type { Command } from "commander";
import { Command as Cmd, Option } from "commander";
import { openCtx } from "../context.ts";
import { globals } from "../options.ts";
import { defined, validate } from "../validate.ts";
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
      .option("--hermes <version>", "hermes version to pin; takes effect on the next recreate")
      .option(
        "--hermeticd <version>",
        "hermeticd version the whole fleet moves to; rewrites the fleet manifest, takes no agent name",
      )
      .option("--all", "every agent in the fleet")
      .action(async (name: string | undefined, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          upgradeSchema,
          defined({
            name,
            hermes: opts["hermes"],
            hermeticd: opts["hermeticd"],
            all: opts["all"],
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
