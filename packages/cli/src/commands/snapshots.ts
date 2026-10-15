/**
 * `hermetic snapshots status` and `hermetic plan snapshots` (§7.1): the
 * fleet's data-volume snapshot policy, and what changing it would do.
 *
 * The policy is three foundation-stack parameters, so a change is a plan that
 * `hermetic apply` executes as one CloudFormation change set — the same shape
 * `plan network` has. Turning snapshots off deletes none of the snapshots
 * already taken; the status line counts them so that is never a surprise.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import { openCtx } from "../context.ts";
import { globals } from "../options.ts";
import { ValidationFailure, defined, validate } from "../validate.ts";
import { out, outJson } from "../io.ts";
import { renderPlan } from "../confirm.ts";
import { declare } from "../declare.ts";
import {
  DEFAULT_SNAPSHOT_POLICY,
  PlanSnapshotsInput,
  SNAPSHOT_INTERVAL_HOURS,
  SnapshotsStatusInput,
  describeSnapshotPolicy,
  snapshotWindowDays,
} from "@hermetic/core";
import type { SnapshotsReport } from "@hermetic/core";

const snapshotsStatusSchema = declare("snapshots.status", "snapshots status", SnapshotsStatusInput);
/** Declared beside its read and registered onto `plan` by `commands/plan.ts`, as `plan network` is. */
export const planSnapshotsSchema = declare("plan.snapshots", "plan snapshots", PlanSnapshotsInput);

export function renderSnapshots(report: SnapshotsReport): string {
  const p = report.policy;
  const lines = [
    `policy         ${p === null ? `${describeSnapshotPolicy(DEFAULT_SNAPSHOT_POLICY)} (fixed — run \`hermetic foundation update\` to make it configurable)` : describeSnapshotPolicy(p)}`,
  ];
  if (p?.enabled) {
    lines.push(`window         ≈${snapshotWindowDays(p).toFixed(1)} days of history per volume`);
  }
  lines.push(
    `existing       ${report.existing.count} snapshot(s) of ${report.existing.volume_gib} GiB of volumes (EBS bills changed blocks only)`,
  );
  return lines.join("\n");
}

/** A numeric flag as a number, or `undefined` when it was not given — validation says what is wrong. */
function num(v: unknown): number | undefined {
  return v === undefined ? undefined : Number(v);
}

export function register(program: Command): void {
  const snapshots = globals(new Cmd("snapshots")).description(
    "the fleet's data-volume snapshot policy (§7.1)",
  );
  snapshots.addCommand(
    globals(new Cmd("status"))
      .description("the policy the foundation stack runs, and how many snapshots the fleet holds")
      .action(async (_opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        validate(snapshotsStatusSchema, {});
        const report = await ctx.hermetic.snapshots.status();
        if (ctx.flags.json) await outJson(report);
        else await out(`${renderSnapshots(report)}\n`);
      }),
  );
  program.addCommand(snapshots);
}

/** The `plan snapshots` leaf, added to the `plan` command by `commands/plan.ts`. */
export function planCommand(): Command {
  return globals(new Cmd("snapshots"))
    .description("what `hermetic apply` would do to change the fleet's snapshot policy")
    .option("--enable", "turn the snapshot policy on")
    .option("--disable", "turn the snapshot policy off (existing snapshots are kept)")
    .option("--retain <count>", "snapshots kept per data volume (1–1000)")
    .option("--interval <hours>", `hours between snapshots: ${SNAPSHOT_INTERVAL_HOURS.join(", ")}`)
    .addHelpText(
      "after",
      "\nOmitted flags keep the stack's current value. Lowering --retain deletes each\n" +
        "volume's oldest snapshots past the new count on DLM's next scheduled run (up\n" +
        "to --interval hours away); --disable stops new snapshots and stops expiry, and\n" +
        "keeps every snapshot already taken. A lower --retain set while disabled takes\n" +
        "effect, and deletes, only once the policy is enabled again.\n",
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const ctx = await openCtx(cmd);
      if (opts["enable"] === true && opts["disable"] === true) {
        throw new ValidationFailure([
          { path: "enabled", message: "choose one of --enable or --disable" },
        ]);
      }
      const input = validate(
        planSnapshotsSchema,
        defined({
          enabled: opts["enable"] === true ? true : opts["disable"] === true ? false : undefined,
          retain: num(opts["retain"]),
          interval_hours: num(opts["interval"]),
        }),
      );
      const result = await ctx.hermetic.plan.snapshots(input);
      if (ctx.flags.json) await outJson(result);
      else await out(`${renderPlan(result)}\n`);
    });
}
