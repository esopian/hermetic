/**
 * `hermetic network status` and `hermetic plan network` (§5): which side of a
 * NAT this fleet's agents live on, whether the record agrees with
 * CloudFormation, and what moving between the two would do.
 *
 * Colour-free and column-aligned, like every other table here. The per-agent
 * placement list is printed in full rather than summarised into a count: the
 * only action a drifted agent has is `hermetic agent recreate <name>`, and a
 * number is not something an operator can type.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import { openCtx } from "../context.ts";
import { globals } from "../options.ts";
import { validate } from "../validate.ts";
import { out, outJson } from "../io.ts";
import { renderPlan } from "../confirm.ts";
import { declare } from "../declare.ts";
import { NetworkStatusInput, PlanNetworkInput } from "@hermetic/core";
import type { NetworkReport } from "@hermetic/core";

const networkStatusSchema = declare("network.status", "network status", NetworkStatusInput);
/**
 * Declared here beside the read it shares a module with, and *registered* onto
 * the `plan` command in `commands/plan.ts` — Commander wants one owner per
 * subcommand tree, exactly as `plan policy` is arranged.
 */
export const planNetworkSchema = declare("plan.network", "plan network", PlanNetworkInput);

/** What each placement means when there is nothing more specific to say. */
const PLACEMENT_NOTE: Record<string, string> = {
  matches: "in a subnet this fleet launches into",
  drifted: "left behind by a mode change — `hermetic agent recreate` moves it",
  unknown: "no instance to place",
};

export function renderNetwork(report: NetworkReport): string {
  const lines = [
    `mode           ${report.mode ?? "(not recorded)"}`,
    `stack          ${report.stack_mode ?? "(no Network parameter)"}`,
    /**
     * Said even when it is fine. "The cache and CloudFormation agree" is the
     * whole point of the read, and a line that appeared only on failure would
     * leave an operator unsure whether it had been checked.
     */
    `consistent     ${report.consistent ? "yes" : "NO — the stack is authoritative; `hermetic foundation update` back-fills the cache"}`,
    `subnets        ${report.subnet_ids.length === 0 ? "-" : report.subnet_ids.join(", ")}`,
    `egress ip      ${report.egress_ip ?? "-"}`,
  ];
  if (report.nat === null) {
    // A `public` fleet has no NAT box; a `nat` fleet whose resources could not
    // be read has one nobody could look at. The two are different sentences.
    lines.push(
      `nat            ${report.stack_mode === "nat" ? "could not be read" : "n/a — this fleet has no NAT instance"}`,
    );
  } else {
    lines.push(
      `nat            ${report.nat.instance_id ?? "(unknown)"} ${report.nat.instance_state ?? "(state unknown)"} · default route ${report.nat.route_state ?? "unknown"}`,
    );
  }
  lines.push(`drifted        ${report.drifted}`);
  for (const agent of report.agents) {
    lines.push(
      `  ${agent.name.padEnd(12, " ")} ${agent.placement.padEnd(8, " ")} ${agent.subnet_id ?? "-"} ${PLACEMENT_NOTE[agent.placement] ?? ""}`,
    );
  }
  return lines.join("\n");
}

export function register(program: Command): void {
  const network = globals(new Cmd("network")).description(
    "the fleet's network mode (§5): public addresses or a NAT appliance",
  );
  network.addCommand(
    globals(new Cmd("status"))
      .description("which mode this fleet is in, whether the record agrees, and which agents drifted")
      .addHelpText(
        "after",
        "\nCloudFormation owns the answer: the stack's `Network` parameter decides\n" +
          "which subnets exist, and the `_fleet` item is only a cache of it. A mode\n" +
          "change strands every existing agent on the old subnets until each is\n" +
          "recreated — `hermetic plan network --to <mode>` says so before it happens.\n",
      )
      .action(async (_opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        validate(networkStatusSchema, {});
        const report = await ctx.hermetic.network.status();
        if (ctx.flags.json) await outJson(report);
        else await out(`${renderNetwork(report)}\n`);
      }),
  );
  program.addCommand(network);
}

/** The `plan network` leaf, added to the `plan` command by `commands/plan.ts`. */
export function planCommand(): Command {
  return globals(new Cmd("network"))
    .description("what `hermetic apply` would do to move this fleet between `public` and `nat`")
    .requiredOption("--to <mode>", "the mode to move to: public or nat")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const ctx = await openCtx(cmd);
      const input = validate(planNetworkSchema, { to: opts["to"] });
      const result = await ctx.hermetic.plan.network(input);
      if (ctx.flags.json) await outJson(result);
      else await out(`${renderPlan(result)}\n`);
    });
}
