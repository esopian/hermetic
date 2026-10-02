/**
 * Plan, then apply (§3.2 rule 3). `plan destroy` / `plan teardown` write a plan
 * document to stdout; `apply <plan-file>` reads one back and executes it. A
 * dry-run costs nothing and the file is reviewable.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import { openCtx, rawFleetFlag, readFlags } from "../context.ts";
import { destructive, globals } from "../options.ts";
import { ValidationFailure, defined, validate } from "../validate.ts";
import { out, outJson } from "../io.ts";
import { renderOp } from "../stream.ts";
import { assertConfirmable, confirmPlan, confirmTeardown, renderPlan } from "../confirm.ts";
import { declare } from "../declare.ts";
import { planCommand as policyPlanCommand } from "./policy.ts";
import { planCommand as networkPlanCommand } from "./network.ts";
import { assertFleetNamedForTeardown } from "./fleets.ts";
import { HermeticError } from "@hermetic/core";
import type { Plan } from "@hermetic/core";
import {
  ApplyInput,
  PlanDestroyInput,
  PlanFoundationInput,
  PlanRecreateInput,
  PlanRolloutInput,
  PlanTeardownInput,
} from "@hermetic/core";

const planDestroySchema = declare("plan.destroy", "plan destroy", PlanDestroyInput);
const planRecreateSchema = declare("plan.recreate", "plan recreate", PlanRecreateInput);
const planTeardownSchema = declare("plan.teardown", "plan teardown", PlanTeardownInput);
const planFoundationSchema = declare("plan.foundation", "plan foundation", PlanFoundationInput);
const planRolloutSchema = declare("plan.rollout", "plan rollout", PlanRolloutInput);
const applySchema = declare("apply", "apply", ApplyInput);

/**
 * A plan is a document about one fleet. `summary` is absent only on a plan
 * written by a hermetic that predates it, which is unchecked rather than
 * refused — core makes the same call, for the same reason: refusing to parse an
 * old plan is a worse answer than applying one whose target agrees.
 */
function assertPlanFleet(plan: Plan, fleetId: string, fleetName: string): void {
  const planned = plan.summary?.fleet_id;
  if (planned === undefined || planned === fleetId) return;
  /**
   * `FLEET_MISMATCH`, which is what core's own `apply` throws for this exact
   * disagreement — the head is saying it earlier, not saying something else.
   * A different code here would mean the same mistake exited 4 through the
   * portal and 7 through the CLI, and scripts would only ever see the head's.
   */
  throw new HermeticError(
    "FLEET_MISMATCH",
    `plan was made for fleet ${planned}; this command is running against ${fleetName} (${fleetId}) — pass \`--fleet\` naming the fleet the plan is for`,
    { plan_fleet: planned, fleet: fleetName, fleet_id: fleetId, kind: plan.kind },
  );
}

export function register(program: Command): void {
  const plan = new Cmd("plan").description("what a destructive command would do, without doing it");

  plan.addCommand(
    globals(new Cmd("destroy"))
      .description("the plan `agent destroy` would execute")
      .argument("<name>", "agent name")
      .option("--keep-volume", "plan keeping the data volume (default: it is deleted)")
      .action(async (name: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(planDestroySchema, defined({ name, keep_volume: opts["keepVolume"] }));
        const result = await ctx.hermetic.plan.destroy(input);
        if (ctx.flags.json) await outJson(result);
        else await out(`${renderPlan(result)}\n`);
      }),
  );

  plan.addCommand(
    globals(new Cmd("recreate"))
      .description("the plan `agent recreate` would execute")
      .argument("<name>", "agent name")
      .action(async (name: string, _opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(planRecreateSchema, { name });
        const result = await ctx.hermetic.plan.recreate(input);
        if (ctx.flags.json) await outJson(result);
        else await out(`${renderPlan(result)}\n`);
      }),
  );

  plan.addCommand(
    globals(new Cmd("teardown"))
      .description("the plan `teardown` would execute")
      .option(
        "--no-purge",
        "keep the SSM parameters under /hermetic/ and /hermes/ instead of deleting them",
      )
      .option("--delete-snapshots", "also delete the DLM snapshots tagged hermetic:role=data")
      .option("--delete-volumes", "also delete leftover volumes tagged hermetic:managed=true")
      .option(
        "--no-reset-local",
        "keep this laptop's frozen config instead of resetting it so `init` can run again",
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          planTeardownSchema,
          defined({
            purge: opts["purge"],
            delete_snapshots: opts["deleteSnapshots"],
            delete_volumes: opts["deleteVolumes"],
            reset_local: opts["resetLocal"],
          }),
        );
        const result = await ctx.hermetic.plan.teardown(input);
        if (ctx.flags.json) await outJson(result);
        else await out(`${renderPlan(result)}\n`);
      }),
  );

  plan.addCommand(
    globals(new Cmd("foundation"))
      .description("the plan `foundation update` would execute (§6.6)")
      .action(async (_opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(planFoundationSchema, {});
        // Same reason as `foundation update`'s: the plan creates a real change
        // set, and only core's `finally` deletes it again.
        const result = await ctx.hermetic.plan.foundation(input, { signal: ctx.signal });
        if (ctx.flags.json) await outJson(result);
        else await out(`${renderPlan(result)}\n`);
      }),
  );

  plan.addCommand(
    globals(new Cmd("rollout"))
      .description("re-render every agent's config and converge the boxes that are behind (§6.5)")
      .option("--agent <name...>", "converge only these agents; default is every agent in the fleet")
      .option(
        "--concurrency <n>",
        "how many boxes converge at once (default 1 — a bad render then stops at the first)",
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const concurrency = opts["concurrency"];
        const input = validate(
          planRolloutSchema,
          defined({
            agents: opts["agent"],
            concurrency: concurrency === undefined ? undefined : Number(concurrency),
          }),
        );
        const result = await ctx.hermetic.plan.rollout(input);
        if (ctx.flags.json) await outJson(result);
        else await out(`${renderPlan(result)}\n`);
      }),
  );

  /**
   * §4.7: the tailnet policy is planned and applied like everything else, so
   * its leaf lives on this tree — but its rendering belongs beside the read it
   * shares a report with (`commands/policy.ts`).
   */
  plan.addCommand(policyPlanCommand());

  /**
   * §5: the same arrangement for the network mode. Its rendering belongs beside
   * the read it shares a report with (`commands/network.ts`).
   */
  plan.addCommand(networkPlanCommand());

  program.addCommand(plan);

  program.addCommand(
    destructive(new Cmd("apply"))
      .description("execute a plan written by `hermetic plan …`")
      .argument("<plan-file>", "path to a plan JSON document, or - for stdin")
      .option(
        "--confirm-account-id <digits>",
        "the twelve digits, required for a teardown plan; interactively you type them at the prompt",
      )
      .addHelpText(
        "after",
        "\nExamples:\n" +
          "  hermetic apply plan.json                          interactive: confirm, then apply\n" +
          "  hermetic apply plan.json --yes                    scripted, for a destroy or recreate plan\n" +
          "  hermetic apply teardown.json --yes --confirm-account-id 123456789012\n" +
          "                                                    a teardown plan also needs the account id\n",
      )
      .action(async (file: string, opts: Record<string, unknown>, cmd: Command) => {
        /**
         * §4.8. `apply` is the other door into a whole-foundation delete, and it
         * was the unguarded one: `plan teardown --fleet staging > t.json` and
         * then a bare `apply t.json` opened `main` and tore *that* down, with a
         * confirmation that asked for the account id both fleets share. The
         * plan file does not select the fleet — it is a document, and the
         * invocation that applies it must name its own target.
         *
         * Checked before core is opened, as in `commands/fleet.ts`, so the
         * refusal costs nothing. The plan is read afterwards; a plan file that
         * turns out not to be a teardown was not made less valid by this call.
         */
        const explicitFleet = rawFleetFlag(cmd);
        const preflightFlags = readFlags(cmd);
        const ctx = await openCtx(cmd);
        assertConfirmable(ctx, `apply ${file}?`);
        const raw = file === "-" ? await Bun.stdin.text() : await Bun.file(file).text();
        let document: unknown;
        try {
          document = JSON.parse(raw);
        } catch (e) {
          // A truncated plan file is bad input, not a crash: exit 2 like any
          // other argument that failed to parse.
          throw new ValidationFailure([
            { path: file, message: `not valid JSON (${e instanceof Error ? e.message : String(e)})` },
          ]);
        }
        const { plan } = validate(applySchema, { plan: document, yes: true });
        /**
         * A teardown plan is the account, not an agent, so it confirms the way
         * `hermetic teardown` does: the twelve digits, never `y` (§4.7 step 3).
         * `apply plan.json --yes` used to be the one door into a whole-foundation
         * delete that asked for nothing more than a habitual keypress.
         */
        let confirmed: string | undefined;
        if (plan.kind === "teardown") {
          assertFleetNamedForTeardown(explicitFleet, preflightFlags);
        }
        /**
         * Every plan this build writes carries the fleet it was made against
         * (§4.8), so a plan reviewed on one fleet and applied to another is a
         * refusal rather than a surprise. Core refuses the same thing, but it
         * refuses *after* the operator has typed twelve digits at a prompt for
         * a fleet they were never going to touch; saying it here is the same
         * answer, before the ceremony.
         */
        assertPlanFleet(plan, ctx.config.fleet_id, ctx.config.name ?? ctx.config.fleet_id);
        if (plan.kind === "teardown") {
          confirmed = await confirmTeardown(ctx, plan, ctx.config.account_id, opts);
        } else {
          await confirmPlan(ctx, plan, `apply this ${plan.kind} plan?`);
        }
        const parsed = validate(
          applySchema,
          defined({ plan: document, yes: true, confirm_account_id: confirmed }),
        );
        await renderOp(ctx.hermetic.apply(parsed, { signal: ctx.signal }), {
          flags: ctx.flags,
          label: `apply ${parsed.plan.kind} ${parsed.plan.target}`,
        });
      }),
  );
}
