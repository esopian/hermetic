/**
 * The fleet-wide reads and the one fleet-wide destructive command of §9:
 * `config show`, `runs`, `artifacts push`, `doctor`, `teardown`.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import { openCtx, rawFleetFlag, readFlags } from "../context.ts";
import type { Ctx } from "../context.ts";
import { destructive, globals } from "../options.ts";
import { defined, toInt, validate } from "../validate.ts";
import { err, out, outJson } from "../io.ts";
import { renderOp } from "../stream.ts";
import { renderTable, renderTeardownReceipt } from "../table.ts";
import { assertConfirmable, confirmTeardown } from "../confirm.ts";
import { declare } from "../declare.ts";
import { assertFleetNamedForTeardown } from "./fleets.ts";
import {
  fleetTargetOf,
  manualRecoveries,
  openPendingOpStore,
  ArtifactsPushInput,
  ConfigShowInput,
  DoctorInput,
  PlanTeardownInput,
  RunsListInput,
  TeardownInput,
  TeardownsListInput,
} from "@hermetic/core";
import type { DoctorReport, PendingOpStore } from "@hermetic/core";

const configShowSchema = declare("config.show", "config show", ConfigShowInput);
const runsListSchema = declare("runs.list", "runs", RunsListInput);
const teardownsListSchema = declare("teardowns.list", "teardowns", TeardownsListInput);
const artifactsPushSchema = declare("artifacts.push", "artifacts push", ArtifactsPushInput);
const doctorSchema = declare("doctor", "doctor", DoctorInput);
const teardownSchema = declare("teardown", "teardown", TeardownInput);
const teardownPlanSchema = PlanTeardownInput;

/**
 * §4.6: the interrupted work on this laptop that nothing will finish on its
 * own, said where an operator goes to look at what this laptop has been doing.
 *
 * A portal that dies mid-`agent recreate` leaves a pending row, and no boot
 * replays it — replaying one can destroy the instance the interrupted attempt
 * had already built (`core/local/recovery.ts`). The portal says so in its log,
 * which an operator working in a terminal never sees; this is the same sentence
 * in the same words, from the same place, on the command that lists runs.
 *
 * On stderr, so `runs --json` stays a clean array on stdout, and swallowing its
 * own failures: a pending log that cannot be read is not a reason to fail the
 * command it is annotating.
 */
async function reportManualRecovery(ctx: Ctx): Promise<void> {
  let store: PendingOpStore | null = null;
  try {
    store = openPendingOpStore({ fixture: ctx.flags.fixture });
    // This fleet's rows only: another fleet's interrupted recreate is another
    // portal's business, and §4.7 keys that on the whole target, never the id.
    for (const recovery of manualRecoveries(store.list(fleetTargetOf(ctx.config)))) {
      await err(`⚠ ${recovery.message}\n`);
    }
  } catch {
    /* a pending log that cannot be read costs a warning, never the command */
  } finally {
    store?.close();
  }
}

/** The flags every teardown-shaped command (`teardown`, `plan teardown`) shares. */
function teardownOptions(cmd: Command): Command {
  return cmd
    .option(
      "--no-purge",
      "keep the SSM parameters under /hermetic/ and /hermes/, and a nat fleet's Elastic IP, instead of deleting them",
    )
    .option("--delete-snapshots", "also delete the DLM snapshots tagged hermetic:role=data")
    .option("--delete-volumes", "also delete leftover volumes tagged hermetic:managed=true")
    .option(
      "--no-reset-local",
      "keep this laptop's frozen config instead of resetting it so `init` can run again",
    );
}

function teardownFlags(opts: Record<string, unknown>): Record<string, unknown> {
  return {
    purge: opts["purge"],
    delete_snapshots: opts["deleteSnapshots"],
    delete_volumes: opts["deleteVolumes"],
    reset_local: opts["resetLocal"],
  };
}

/**
 * The one `doctor` line about the tailnet policy file (§4.7). Never a finding:
 * an OAuth client without `policy_file` is the state every fleet created before
 * this build is in, and a report that says PROBLEMS for ever is one nobody
 * reads.
 */
function policyLine(policy: DoctorReport["tailscale"]["policy"]): string {
  if (policy === null) return "policy: could not be read; `hermetic policy` says why";
  if (policy.scope === "none") {
    return "policy: unavailable — the OAuth client lacks policy_file:read, so hermetic's entries are unchecked";
  }
  if (policy.managed === "current") {
    return "policy: hermetic entries current (acls, ssh; tagOwners pasted by the operator)";
  }
  const which = policy.blocks_drifted.join(", ");
  return policy.scope === "read"
    ? `policy: ${policy.managed} (${which}) — the OAuth client lacks policy_file, so apply them by hand`
    : `policy: ${policy.managed} (${which}) — run \`hermetic plan policy\``;
}

/**
 * The manual Tailscale cleanup a `DeleteStack` never reaches: the account's
 * devices are not AWS resources, so nothing here removes them from the admin
 * console. `plan.teardown`'s `warnings` is exactly this checklist (§1).
 */
async function printManualChecklist(warnings: readonly string[]): Promise<void> {
  if (warnings.length === 0) return;
  await err(
    `\nmanual steps teardown does not do for you:\n${warnings.map((w) => `  - ${w}`).join("\n")}\n`,
  );
}

export function register(program: Command): void {
  const config = new Cmd("config").description("the frozen local configuration");
  config.addCommand(
    globals(new Cmd("show"))
      .description("frozen account, profile, region, fleet_id")
      .action(async (_opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        validate(configShowSchema, {});
        const shown = await ctx.hermetic.config.show();
        if (ctx.flags.json) await outJson(shown);
        else {
          const rows = Object.entries(shown).map(([k, v]) => [k, String(v)]);
          await out(`${renderTable(rows, ["KEY", "VALUE"])}\n`);
        }
      }),
  );
  program.addCommand(config);

  program.addCommand(
    globals(new Cmd("runs"))
      .description("local log of commands this laptop ran, with output")
      .option("--last", "only the most recent run")
      .option("--agent <name>", "only runs against this agent")
      .option("--limit <n>", "at most N runs")
      .option("--full", "include each run's captured output")
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          runsListSchema,
          defined({
            last: opts["last"],
            agent: opts["agent"],
            limit: toInt(opts["limit"] as string | undefined),
          }),
        );
        const runs = await ctx.hermetic.runs.list(input);
        // `--full` is a rendering choice, not part of core's request: the log of
        // every run is far more than an operator asked to see, and dumping it by
        // default is what made `runs --json` quadratic in its own output.
        const rendered = opts["full"] === true ? runs : runs.map(({ log: _log, ...rest }) => rest);
        if (ctx.flags.json) await outJson(rendered);
        else if (runs.length === 0) await out("no runs\n");
        else {
          const rows = runs.map((r) => [
            r.started_at,
            r.command,
            r.agent ?? "-",
            r.exit_code === null ? "…" : String(r.exit_code),
          ]);
          await out(`${renderTable(rows, ["STARTED", "COMMAND", "AGENT", "EXIT"])}\n`);
        }
        // Last, because it is about work that is still outstanding rather than
        // about the rows above it.
        await reportManualRecovery(ctx);
      }),
  );

  program.addCommand(
    globals(new Cmd("teardowns"))
      .description("permanent local record of every teardown this home has run")
      .option("--last", "only the most recent teardown")
      .option("--limit <n>", "at most N receipts")
      .option("--events", "include each receipt's full event log")
      .addHelpText(
        "after",
        "\nKept in ~/.hermetic/hermetic.db and never cleared — `teardown --reset-local`\n" +
          "forgets which account this home was pointed at; this is what still says\n" +
          "what was left in it.\n",
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          teardownsListSchema,
          defined({ last: opts["last"], limit: toInt(opts["limit"] as string | undefined) }),
        );
        const receipts = await ctx.hermetic.teardowns.list(input);
        if (ctx.flags.json) {
          await outJson(
            opts["events"] === true ? receipts : receipts.map(({ events: _e, ...rest }) => rest),
          );
          return;
        }
        if (receipts.length === 0) {
          await out("no teardowns recorded in this home\n");
          return;
        }
        for (const receipt of receipts)
          await out(renderTeardownReceipt(receipt, opts["events"] === true));
      }),
  );

  const artifacts = new Cmd("artifacts").description("the hermeticd artifact in the fleet bucket");
  artifacts.addCommand(
    globals(new Cmd("push"))
      .description("push hermeticd to the bucket (run by init and upgrade)")
      .argument("[version]", "version to publish; defaults to this build's")
      .option(
        "--path <file>",
        "a compiled hermeticd to push; default finds one (HERMETIC_HERMETICD, next to this binary, or built from source)",
      )
      .action(async (version: string | undefined, opts: { path?: string }, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(artifactsPushSchema, defined({ version, path: opts.path }));
        const pushed = await ctx.hermetic.artifacts.push(input);
        if (ctx.flags.json) await outJson(pushed);
        else await out(`pushed ${pushed.version} to ${pushed.key}\n`);
        /**
         * §3.6: the release went up either way. This says the Hermes mirror did
         * not, so the fleet's agents will clone Hermes from github.com at boot
         * rather than from the bucket — a warning, never a failure.
         */
        if (pushed.mirror_warning !== undefined) {
          await err(`warning: ${pushed.mirror_warning}\n`);
        }
        /**
         * §7.3, the same shape and a harder consequence: the browser build did
         * not reach the bucket, so a `--browser` agent has nothing to install —
         * still a warning, because the release itself went up.
         */
        if (pushed.browser_warning !== undefined) {
          await err(`warning: ${pushed.browser_warning}\n`);
        }
      }),
  );
  program.addCommand(artifacts);

  program.addCommand(
    globals(new Cmd("doctor"))
      .description("foundation health, account/fleet guard, drift between DynamoDB / EC2 / Tailscale")
      .action(async (_opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        validate(doctorSchema, {});
        const report = await ctx.hermetic.doctor();
        if (ctx.flags.json) await outJson(report);
        else {
          const lines = [
            `overall        ${report.ok ? "ok" : "PROBLEMS"}`,
            `account        frozen ${report.account.frozen} · observed ${report.account.observed} · ${report.account.ok ? "ok" : "MISMATCH"}`,
            `fleet          local ${report.fleet.local ?? "-"} · stack ${report.fleet.stack_tag ?? "-"} · item ${report.fleet.fleet_item ?? "-"} · ${report.fleet.ok ? "ok" : "MISMATCH"}`,
            `foundation     ${report.foundation.present ? (report.foundation.status ?? "present") : "MISSING"}`,
            `security group ${report.security_group.inbound_rules} inbound rule(s) · ${report.security_group.ok ? "sealed" : "OPEN"}`,
            `local tailscale ${report.local_tailscale.detail}`,
          ];
          // Degraded visibility is not a finding (it does not make `ok` false),
          // so it would otherwise be invisible — and an unchecked device list
          // reads exactly like a clean one.
          if (report.tailscale.detail) lines.push(`tailscale      ${report.tailscale.detail}`);
          // §4.7: hermetic's own entries in the tailnet policy. Informational
          // for the same reason the device list is — no `doctor` finding, but
          // said out loud, because "absent" and "not looked at" read alike.
          lines.push(`tailscale      ${policyLine(report.tailscale.policy)}`);
          /**
           * §5: the fleet's network mode, its NAT appliance and the agents a
           * mode change left behind. Printed unconditionally — a `public` fleet
           * reads "n/a", which is not the same as a check that passed, and the
           * distinction is exactly what `checked_nat` carries.
           */
          lines.push(
            `network        ${report.network.mode ?? "(not recorded)"} · stack ${report.network.stack_mode ?? "(unknown)"} · ${report.network.consistent ? "consistent" : "INCONSISTENT"}`,
          );
          lines.push(
            `network        nat ${
              report.network.checked_nat && report.network.nat !== null
                ? `${report.network.nat.instance_id ?? "(unknown)"} ${report.network.nat.instance_state ?? "(state unknown)"} · default route ${report.network.nat.route_state ?? "unknown"}`
                : report.network.stack_mode === "nat"
                  ? "not checked — the stack's resources could not be read"
                  : "n/a — this fleet has no NAT instance"
            }`,
          );
          if (report.network.drifted.length > 0) {
            lines.push(`network        drifted: ${report.network.drifted.join(", ")}`);
          }
          // A NAT read that could not be made. Not a finding — nobody looked, so
          // nothing is known to be wrong — but printing it is the whole point:
          // the line above would otherwise read as a check that passed.
          for (const note of report.network.notes) lines.push(`network        ${note}`);
          // Same shape, same reason: a stale device is a fact about the tailnet
          // that only the operator can clear, so it is printed rather than
          // counted as a finding — but printing it is not optional, because the
          // canonical name resolving to a dead node is exactly what an operator
          // runs `doctor` to find out.
          for (const s of report.tailscale.stale) lines.push(`tailscale      ${s.note}`);
          // §8.2: the pre-v3 copies the foundation v3 migration deliberately
          // left behind. Not a finding — nothing is broken by their being there
          // — but an operator who found two copies of every key and had to
          // guess which one is live would be right to distrust the report.
          if (report.legacy_parameters.note) {
            lines.push(`ssm            ${report.legacy_parameters.note}`);
          }
          for (const h of report.heartbeats) {
            lines.push(`heartbeat      ${h.name} ${h.status}${h.unreachable ? " UNREACHABLE" : ""}`);
          }
          for (const f of report.findings) lines.push(`finding        ${f}`);
          await out(`${lines.join("\n")}\n`);
        }
      }),
  );

  program.addCommand(
    teardownOptions(destructive(new Cmd("teardown")))
      .description("DeleteStack; refuses if agents exist")
      .option(
        "--confirm-account-id <digits>",
        "the twelve digits, for scripts; interactively you type them at the prompt",
      )
      .addHelpText(
        "after",
        "\nExamples:\n" +
          "  hermetic teardown --yes                          interactive: type the account id\n" +
          "  hermetic teardown --yes --confirm-account-id 123456789012\n" +
          "                                                    scripted, no prompt\n" +
          "  hermetic teardown --yes --no-reset-local          keep this home frozen after teardown\n",
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        /**
         * §4.8, before core is opened at all: with more than one fleet frozen
         * on this laptop, the default is not a good enough answer to "which
         * one". A `--fleet` that was merely *implied* is exactly how the wrong
         * foundation gets deleted, and no typed confirmation catches it — the
         * digits are the account's, and both fleets are in it. The names come
         * from the local database, so the refusal costs no AWS call and cannot
         * be delayed by one.
         */
        assertFleetNamedForTeardown(rawFleetFlag(cmd), readFlags(cmd));
        const ctx = await openCtx(cmd);
        // `--yes` gates the *are-you-sure* the way every destructive command's
        // does; it never stands in for the typed account id below (§3.2 rule 3).
        assertConfirmable(ctx, `tear down the whole foundation of fleet "${ctx.config.name}"?`);
        const planInput = validate(teardownPlanSchema, defined(teardownFlags(opts)));
        const plan = await ctx.hermetic.plan.teardown(planInput);
        const confirmed = await confirmTeardown(ctx, plan, ctx.config.account_id, opts);
        // Belt and braces: the head asked, and core checks the same digits
        // against the frozen config before it touches AWS (§4.7 step 3).
        const input = validate(
          teardownSchema,
          defined({ yes: true, confirm_account_id: confirmed, ...teardownFlags(opts) }),
        );
        await renderOp(ctx.hermetic.teardown(input, { signal: ctx.signal }), {
          flags: ctx.flags,
          label: "teardown",
        });
        await printManualChecklist(plan.warnings);
      }),
  );
}
