/**
 * §6.6's two commands: `foundation status` (what the fleet is on versus what
 * this build ships) and `foundation update` (repoint the stack, the release and
 * every agent at it). `plan foundation` lives beside the other plans, in
 * `commands/plan.ts` — it is a plan, not a foundation subcommand.
 *
 * Neither prints the §6.6 "update available" nag: `openCtx` skips it for
 * `foundation *`, since a command whose whole output is the version state
 * should not also warn about it.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import { openCtx } from "../context.ts";
import { destructive, globals } from "../options.ts";
import { validate } from "../validate.ts";
import { out, outJson } from "../io.ts";
import { renderOp } from "../stream.ts";
import { renderTable } from "../table.ts";
import { assertConfirmable, confirmPlan } from "../confirm.ts";
import { declare } from "../declare.ts";
import { FoundationStatusInput, FoundationUpdateInput, PlanFoundationInput } from "@hermetic/core";
import type { FoundationStatus } from "@hermetic/core";

const foundationStatusSchema = declare("foundation.status", "foundation status", FoundationStatusInput);
const foundationUpdateSchema = declare("foundation.update", "foundation update", FoundationUpdateInput);
/** `plan foundation` declares itself in `commands/plan.ts`; this is only its schema. */
const foundationPlanSchema = PlanFoundationInput;

/** A digest is only useful here as "the same one or a different one". */
function shortSha(sha: string | null): string {
  return sha === null ? "-" : sha.slice(0, 12);
}

/**
 * §6.6's advisory line about upstream Hermes.
 *
 * It is *not* part of the fleet-versus-available table above it: nothing in
 * that table is a thing an operator does by hand, and this is nothing else.
 * `foundation update` does not touch Hermes, so the sentence names what does.
 *
 * And it names *both* halves, because `hermetic upgrade --hermes <ver>` alone
 * would not do it: the version pins what `hermes --version` must report, while
 * the tag the box actually checks out is `BUILD_VERSIONS.hermes_ref`, which no
 * flag moves (§6.6). Naming only the flag would send an operator to a run that
 * checks out the old ref and then fails its own version assertion.
 */
export function renderHermesLine(hermes: FoundationStatus["hermes"]): string {
  if (!hermes) return "hermes            not checked";
  const pinned = `pinned ${hermes.pinned} (${hermes.pinned_ref})`;
  if (hermes.latest === null)
    return `hermes            ${pinned} · could not check (${hermes.error ?? "no reason given"})`;
  const latest = `latest ${hermes.latest}`;
  if (hermes.error !== null)
    return `hermes            ${pinned} · ${latest} · could not compare (${hermes.error})`;
  if (!hermes.update_available) return `hermes            ${pinned} · ${latest} · up to date`;
  return (
    `hermes            ${pinned} · ${latest} · update available — set BUILD_VERSIONS.hermes/hermes_ref ` +
    `to it, then \`hermetic upgrade <name> --hermes <version>\`, one agent first`
  );
}

/**
 * §8.3's three answers, because the field has three states and only two of them
 * are "nothing is stale".
 *
 * Core omits `stale_bedrock_grants` entirely on a fleet that predates v10 —
 * such a fleet does not record its grant, so nothing can be compared against it
 * — and sends an empty array when it compared and found nothing. Rendering both
 * as `current` would tell an operator their grant had been checked when it
 * never was, and the answer to that is the same update that would record it.
 */
export function bedrockGrantLine(stale: readonly string[] | undefined): string {
  if (stale === undefined) return "not recorded — run `hermetic foundation update`";
  if (stale.length === 0) return "current";
  return `stale: ${stale.join(", ")} — run \`hermetic foundation update\``;
}

/**
 * Two tables: the fleet-versus-available versions, then one row per agent. The
 * agent half is half the answer — a foundation update is the stack *and* the
 * hermeticd release, and only the boxes can say whether the release landed.
 */
export function renderFoundationStatus(status: FoundationStatus): string {
  const versions = renderTable(
    [
      [
        "foundation version",
        `v${status.fleet.foundation_version}`,
        `v${status.available.foundation_version}`,
      ],
      [
        "template sha256",
        shortSha(status.fleet.template_sha256),
        shortSha(status.available.template_sha256),
      ],
      ["hermeticd", status.fleet.hermeticd_version, status.available.hermeticd_version],
    ],
    ["", "FLEET", "AVAILABLE"],
  );

  const verdict = status.tool_outdated
    ? "this build is older than the fleet's foundation; upgrade hermetic"
    : status.update_available
      ? "update available — run `hermetic foundation update`"
      : "up to date";
  const lines = [
    versions,
    "",
    // Not rows in the table above: the image the fleet was built on has no
    // "available" column to compare against.
    `ubuntu release    ${status.fleet.ubuntu_release}`,
    `ami id            ${status.fleet.ami_id}`,
    `update available  ${status.update_available ? "yes" : "no"}`,
    `tool outdated     ${status.tool_outdated ? "yes" : "no"}`,
    `in progress       ${
      status.in_progress
        ? `locked by ${status.in_progress.owner} until ${status.in_progress.expires}`
        : "-"
    }`,
    /**
     * §8.3: the models something in this fleet names that its role may not
     * invoke. Not part of `update_available` — a stale grant is a fact about
     * the fleet's IAM policy rather than about its version — but the same
     * command reports it, because `foundation update` is what fixes it.
     */
    `bedrock grant     ${bedrockGrantLine(status.stale_bedrock_grants)}`,
    `verdict           ${verdict}`,
    renderHermesLine(status.hermes),
  ];

  if (status.agents.length === 0) {
    lines.push("", "no agents");
  } else {
    lines.push(
      "",
      renderTable(
        status.agents.map((a) => [
          a.name,
          a.status,
          a.hermeticd_version ?? "-",
          // Three answers, because `current` has three. A box that has reported
          // no version is not behind — it is a stopped agent, or a replacement
          // still booting — and calling it "behind" sends an operator looking
          // for a rollout that never failed.
          a.current === null ? "unknown" : a.current ? "current" : "behind",
          // Pin, and — when the box disagrees — what it actually answers with.
          // They differ between `upgrade --hermes` and the recreate that makes
          // it true, which is the window this column used to render as fact.
          a.running_hermes_version && a.running_hermes_version !== a.hermes_version
            ? `${a.hermes_version ?? "-"} (running ${a.running_hermes_version})`
            : (a.hermes_version ?? "-"),
          a.last_heartbeat ?? "-",
        ]),
        ["AGENT", "STATUS", "HERMETICD", "STATE", "HERMES", "LAST HEARTBEAT"],
      ),
    );
  }
  return lines.join("\n");
}

export function register(program: Command): void {
  const foundation = new Cmd("foundation").description(
    "the CloudFormation foundation: which contract version the fleet is on, and updating it",
  );

  foundation.addCommand(
    globals(new Cmd("status"))
      .description("fleet vs available foundation version, and every agent's hermeticd")
      .action(async (_opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        validate(foundationStatusSchema, {});
        const status = await ctx.hermetic.foundation.status();
        if (ctx.flags.json) await outJson(status);
        else await out(`${renderFoundationStatus(status)}\n`);
      }),
  );

  foundation.addCommand(
    destructive(new Cmd("update"))
      .description("apply this build's foundation: stack, release, and a rollout to every agent")
      .addHelpText(
        "after",
        "\nExamples:\n" +
          "  hermetic plan foundation                          what it would do, without doing it\n" +
          "  hermetic foundation update                        interactive: review the plan, then confirm\n" +
          "  hermetic foundation update --yes                  scripted\n",
      )
      .action(async (_opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        // The gate before core is asked to plan, exactly as `teardown` does it.
        // Unlike teardown there is no typed account id: a foundation update
        // replaces no state — it refuses (FOUNDATION_UNSAFE) rather than
        // replacing one — so the plan and a `y` are the whole ceremony.
        assertConfirmable(ctx, "update the foundation?");
        const planInput = validate(foundationPlanSchema, {});
        // The signal, so Ctrl-C during the change-set wait unwinds core's
        // `finally` — which is what deletes the change set CloudFormation is
        // still computing. Without it the abort leaves one in the console with
        // nobody's name on it.
        const plan = await ctx.hermetic.plan.foundation(planInput, { signal: ctx.signal });
        await confirmPlan(ctx, plan, "update the foundation?");
        const input = validate(foundationUpdateSchema, { yes: true });
        await renderOp(ctx.hermetic.foundation.update(input, { signal: ctx.signal }), {
          flags: ctx.flags,
          label: "foundation update",
        });
      }),
  );

  program.addCommand(foundation);
}
