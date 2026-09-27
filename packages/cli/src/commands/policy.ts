/**
 * `hermetic policy` and `hermetic plan policy` (§4.7): what the tailnet policy
 * says about hermetic, and what a write would change.
 *
 * Colour-free, like every other table here, and the diff is printed verbatim —
 * a unified diff is the one format an operator already knows how to read, and
 * inventing a prettier one would only make it harder to paste into a review.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import { openCtx } from "../context.ts";
import { globals } from "../options.ts";
import { validate } from "../validate.ts";
import { out, outJson } from "../io.ts";
import { renderPlan } from "../confirm.ts";
import { declare } from "../declare.ts";
import { PlanPolicyInput, PolicyStatusInput } from "@hermetic/core";
import type { PolicyReport } from "@hermetic/core";

const policyStatusSchema = declare("policy.status", "policy", PolicyStatusInput);
/**
 * Declared here beside the read it shares a module with, and *registered* onto
 * the `plan` command in `commands/plan.ts` — Commander wants one owner per
 * subcommand tree, and the tailnet policy is not a fifth kind of plan so much
 * as the same plan-then-apply shape (§3.2 rule 3) over a different target.
 */
export const planPolicySchema = declare("plan.policy", "plan policy", PlanPolicyInput);

/** What each block state says when there is no reason attached. */
const STATE_NOTE: Record<string, string> = {
  absent: "hermetic's block is not in the policy yet",
  current: "already what hermetic would write",
  drifted: "hermetic's block is there but says something else",
  skipped: "left as you wrote it",
};

const SCOPE_LINE: Record<PolicyReport["scope"], string> = {
  write: "read + write (policy_file)",
  read: "read only (policy_file:read) — `hermetic apply` will be refused",
  none: "none — the OAuth client cannot see the tailnet policy file",
};

const MANAGED_LINE: Record<PolicyReport["managed"], string> = {
  current: "current",
  absent: "absent — nothing of hermetic's is in the policy",
  drifted: "DRIFTED — run `hermetic plan policy`",
  unavailable: "unknown — the policy file could not be read",
};

export function renderPolicy(report: PolicyReport): string {
  const lines = [`scope          ${SCOPE_LINE[report.scope]}`];
  // Why the scope could not be proved `write`, when there is a reason — said
  // here, under the scope it is about, and nowhere else in the output.
  if (report.scope_reason !== null) lines.push(`               ${report.scope_reason}`);
  lines.push(`managed        ${MANAGED_LINE[report.managed]}`, `etag           ${report.etag ?? "-"}`);
  for (const block of report.blocks) {
    lines.push(
      `  ${block.key.padEnd(12, " ")} ${block.state.padEnd(8, " ")} ${block.reason ?? STATE_NOTE[block.state] ?? ""}`,
    );
  }
  // Only when there is something to say: an operator whose policy is current
  // should read three lines, not three lines and an empty diff header.
  if (report.diff !== null) lines.push("", report.diff);
  return lines.join("\n");
}

export function register(program: Command): void {
  program.addCommand(
    globals(new Cmd("policy"))
      .description("hermetic's own entries in the tailnet policy file, and any drift")
      .addHelpText(
        "after",
        "\nhermetic manages only the lines between its `// hermetic:managed` markers.\n" +
          "Everything else in the policy — your comments, your key order, your own\n" +
          "rules — is written back byte for byte. `hermetic plan policy` shows the\n" +
          "diff; `hermetic apply` writes it.\n",
      )
      .action(async (_opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        validate(policyStatusSchema, {});
        const report = await ctx.hermetic.policy.status();
        if (ctx.flags.json) await outJson(report);
        else await out(`${renderPolicy(report)}\n`);
      }),
  );
}

/** The `plan policy` leaf, added to the `plan` command by `commands/plan.ts`. */
export function planCommand(): Command {
  return globals(new Cmd("policy"))
    .description("the change `hermetic apply` would make to the tailnet policy file")
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = await openCtx(cmd);
      const input = validate(planPolicySchema, {});
      const result = await ctx.hermetic.plan.policy(input);
      // `renderPlan` already prints the warnings, and the diff is one of them —
      // so the steps and the change the operator is being asked about stay in
      // one block rather than in two places that could disagree.
      if (ctx.flags.json) await outJson(result);
      else await out(`${renderPlan(result)}\n`);
    });
}
