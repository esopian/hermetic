/**
 * Core never asks "are you sure" (§3.2 rule 3): it hands out a plan and the head
 * confirms. Every destructive command therefore plans first, prints the steps
 * and the account header again, and only then asks.
 */
import { confirm, isCancel, text } from "@clack/prompts";
import { HermeticError } from "@hermetic/core";
import type { Plan } from "@hermetic/core";
import { err, isInteractive } from "./io.ts";
import type { Ctx } from "./context.ts";

/**
 * How one side of a release comparison is named: `build 36` where the checkout
 * could count commits, the short fingerprint where it could not, and `—` where
 * nothing at all is known.
 *
 * The number first because it is the only one that *orders*. Two fingerprints
 * say two releases differ; two numbers say which is newer, which is what an
 * operator staring at a confirmation prompt actually needs to know before
 * answering it.
 */
function releaseSide(build: string | null, buildNumber: number | null): string {
  if (buildNumber !== null) return `build ${buildNumber}`;
  return build === null ? "—" : build.slice(0, 8);
}

export function renderPlan(plan: Plan): string {
  const lines = [`plan: ${plan.kind} ${plan.target}`];
  /**
   * §3.6's release line, on the confirmation an operator is about to answer.
   *
   * It is here and not in the step list because the steps say what will be
   * *done* and this says what is being *shipped* — and because the version
   * pair alone cannot say: both sides are `BUILD_VERSIONS.hermeticd`, a
   * hand-edited constant, so a release that changed every byte still reads
   * `0.5.0 → 0.5.0`.
   */
  const r = plan.release;
  if (r) {
    const from = releaseSide(r.published_build, r.published_build_number);
    const to = releaseSide(r.local_build, r.local_build_number);
    lines.push(`  release: ${r.published_version ?? "—"} ${from} → ${r.local_version} ${to}`);
    if (
      r.published_build_number !== null &&
      r.local_build_number !== null &&
      r.local_build_number < r.published_build_number
    ) {
      lines.push(
        "  warning: this checkout is behind the fleet — applying would move it back onto older code; pull first",
      );
    }
  }
  for (const step of plan.steps) {
    lines.push(`  ${step.destructive ? "!" : "·"} ${step.id.padEnd(14, " ")} ${step.description}`);
  }
  for (const warning of plan.warnings) lines.push(`  warning: ${warning}`);
  return lines.join("\n");
}

/**
 * The gate, checked before core is asked to plan: without `--yes` and without a
 * terminal to ask in, the command cannot succeed, and finding that out before
 * touching AWS keeps `destroy` on a name that does not exist an exit 8 rather
 * than a confusing 404.
 */
export function assertConfirmable(ctx: Ctx, question: string): void {
  if (ctx.flags.yes) return;
  if (!isInteractive()) {
    throw new HermeticError("CONFIRMATION_REQUIRED", `${question} — pass --yes`);
  }
}

/**
 * Prints the plan, then requires `--yes` or an interactive confirmation.
 * Non-interactive and no `--yes` is `CONFIRMATION_REQUIRED` — exit 8.
 */
export async function confirmPlan(ctx: Ctx, plan: Plan, question: string): Promise<void> {
  await err(`${renderPlan(plan)}\n${ctx.header}\n`);
  if (ctx.flags.yes) return;
  if (!isInteractive()) {
    throw new HermeticError("CONFIRMATION_REQUIRED", `${question} — pass --yes`, {
      target: plan.target,
    });
  }
  const answer = await confirm({ message: question, output: process.stderr });
  if (isCancel(answer)) throw new HermeticError("ABORTED", "cancelled at the confirmation prompt");
  if (answer !== true) throw new HermeticError("ABORTED", "declined at the confirmation prompt");
}

/**
 * `init` requires the twelve digits, not `y` (§4.7 step 3). Core compares what
 * was typed against the account STS actually resolved, so a wrong answer is a
 * typed `CONFIRMATION_REQUIRED` rather than a local string compare.
 */
export async function askAccountId(hint: string, subject?: string): Promise<string> {
  const answer = await text({
    message:
      subject === undefined
        ? `type the twelve-digit account id to confirm (${hint})`
        : `type the twelve-digit account id to confirm ${subject} (${hint})`,
    validate: (v) => (/^\d{12}$/.test(v ?? "") ? undefined : "twelve digits, no separators"),
    output: process.stderr,
  });
  if (isCancel(answer)) throw new HermeticError("ABORTED", "cancelled at the account confirmation");
  return answer;
}

/**
 * `teardown` confirms the same way `init --reset` does: the twelve digits,
 * never `y` — tearing down the wrong account is not a mistake a habitual
 * keypress should be able to make. Unlike `confirmPlan`, `--yes` alone never
 * stands in for this: a script needs `--confirm-account-id` too
 * (`assertConfirmable` is what still gates `--yes` itself for the
 * non-interactive case).
 */
/**
 * §4.8: an account may hold several fleets, so the twelve digits no longer say
 * *what* is being destroyed — both fleets are in the same account. The question
 * therefore names the fleet, and it names the fleet **the plan is for**, read
 * from `summary.fleet_id`, not the one this process happens to have open: a
 * confirmation that describes something other than what is about to run is
 * worse than one that describes nothing.
 *
 * The name is the local row's when the two agree (a fleet id is not something
 * an operator recognises); when they do not, only the id is honest — and
 * `apply` refuses that case before the prompt is ever reached. A plan from an
 * older hermetic carries no summary, and then the open fleet is exactly what
 * will be torn down.
 */
function teardownSubject(plan: Plan, ctx: Ctx): string {
  const planned = plan.summary?.fleet_id;
  if (planned === undefined || planned === ctx.config.fleet_id) {
    return `teardown of fleet "${ctx.config.name}" (${ctx.config.fleet_id})`;
  }
  return `teardown of fleet_id ${planned}`;
}

export async function confirmTeardown(
  ctx: Ctx,
  plan: Plan,
  accountId: string,
  opts: Record<string, unknown>,
): Promise<string> {
  const lines = [renderPlan(plan)];
  if (plan.warnings.length > 0) {
    lines.push("manual steps after teardown (not run by hermetic):");
    for (const w of plan.warnings) lines.push(`  - ${w}`);
  }
  await err(`${lines.join("\n")}\n${ctx.header}\n`);

  const subject = teardownSubject(plan, ctx);
  const supplied = opts["confirmAccountId"] as string | undefined;
  let typed: string;
  if (supplied !== undefined) {
    if (!/^\d{12}$/.test(supplied)) {
      throw new HermeticError(
        "VALIDATION",
        "--confirm-account-id takes the twelve digits, no separators",
      );
    }
    typed = supplied;
  } else if (!isInteractive()) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      `${subject} confirms by typing the twelve-digit account id; pass --confirm-account-id`,
      { fleet: subject },
    );
  } else {
    typed = await askAccountId(accountId, subject);
  }
  if (typed !== accountId) {
    throw new HermeticError("CONFIRMATION_REQUIRED", `typed account id does not match (${accountId})`);
  }
  // Returned, not just checked: core re-compares it against the frozen config,
  // so the digits travel with the request as `confirm_account_id` rather than
  // being a local string compare the head could simply forget to do.
  return typed;
}

/**
 * `volume delete` confirms by typing the volume id, not `y` — the same shape as
 * the account id above, for the same reason: deleting an agent's memory is not
 * a mistake a habitual keypress should be able to make. `--yes` stands in for
 * it, as it does for every other destructive command.
 */
export async function askVolumeId(volumeId: string): Promise<string> {
  const answer = await text({
    message: `type the volume id to confirm (${volumeId})`,
    validate: (v) => (v === volumeId ? undefined : "does not match"),
    output: process.stderr,
  });
  if (isCancel(answer)) throw new HermeticError("ABORTED", "cancelled at the volume confirmation");
  return answer;
}

/**
 * `secrets rm` confirms by typing the slug, the same shape as the volume id
 * above and for the same reason: a shared slot is a key an operator may no
 * longer have anywhere else, and its deletion should not be reachable by a
 * habitual keypress. `--yes` stands in for it, as everywhere else.
 */
export async function askSecretSlug(slug: string): Promise<string> {
  const answer = await text({
    message: `type the slug to confirm (${slug})`,
    validate: (v) => (v === slug ? undefined : "does not match"),
    output: process.stderr,
  });
  if (isCancel(answer)) throw new HermeticError("ABORTED", "cancelled at the secret confirmation");
  return answer;
}
