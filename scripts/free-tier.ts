#!/usr/bin/env bun
/**
 * Checks the AWS Free Tier baseline (`packages/core/src/shared/free-tier.ts`)
 * — the one object Settings › Defaults' "Set to AWS Free Tier" button, its
 * help drawer and the `free-tier` built-in create preset all read.
 *
 *   bun run free-tier                    offline: the baseline against itself and today's date
 *   bun run free-tier --aws [--region r] [--profile p]
 *                                        also asks EC2 which Arm types are free-tier
 *                                        eligible for the account you are signed in to
 *
 * Exits 1 on an error (the machine no longer fits, the Graviton trial has
 * lapsed, EC2 no longer lists the size as eligible), 0 otherwise; warnings —
 * a review that is due, an eligible type the baseline does not list — print
 * without failing. When it fails, edit `free-tier.ts` and run it again.
 *
 * `--aws` checks the plan lists only. EC2's `free-tier-eligible` filter is
 * the signed-in account's plan list, and says nothing about the Graviton trial
 * (`arm_trial`), which is a separate offer: its end date is checked against
 * today, and its terms are a human read of aws.amazon.com/ec2/instance-types/t4/.
 *
 * `--aws` shells out to the `aws` CLI rather than building an SDK client: this
 * is a contributor's check against their own account, outside core's account
 * guard (AGENTS.md: SDK clients come only from `aws.client()`), and the CLI
 * already resolves whatever profile and region the contributor uses.
 */
import { ROOT_GIB_MAX, ROOT_GIB_MIN } from "../packages/core/src/shared/box.ts";
import { AWS_FREE_TIER } from "../packages/core/src/shared/free-tier.ts";
import type { FreeTierBaseline } from "../packages/core/src/shared/free-tier.ts";
import { SIZES } from "../packages/core/src/schema/agent.ts";

/** The data volume's floor (`CustomPreset.volume_gib`, `schema/presets.ts`). */
const VOLUME_GIB_MIN = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Finding {
  level: "error" | "warn";
  message: string;
}

function day(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

/**
 * Everything that can be checked without AWS: the machine against the
 * allowances it is meant to fit, and the dates against `today` (`YYYY-MM-DD`).
 */
export function checkBaseline(b: FreeTierBaseline, today: string): Finding[] {
  const out: Finding[] = [];
  const { size, volume_gib, root_gib } = b.machine;
  const spec = SIZES[size];
  const type = spec.instance_type;
  const trial = b.arm_trial;
  const trialLive = trial !== null && day(today) <= day(trial.ends_on);

  if (
    !b.eligible_instance_types.free_plan.includes(type) &&
    !(trialLive && trial.instance_type === type)
  ) {
    out.push({
      level: "error",
      message: `size ${size} is ${type}, which is neither on the Free plan's list nor the live Arm trial`,
    });
  }
  if (
    !b.eligible_instance_types.legacy.includes(type) &&
    !(trialLive && trial.instance_type === type)
  ) {
    out.push({
      level: "warn",
      message: `${type} is not free on legacy (pre-15 July 2025) accounts${trialLive ? "" : " now the Arm trial is over"}`,
    });
  }
  if (trial !== null && !trialLive) {
    out.push({
      level: "error",
      message: `the ${trial.instance_type} trial ended on ${trial.ends_on}: check aws.amazon.com/ec2/instance-types/t4/ and move ends_on, or set arm_trial to null`,
    });
  }
  if (root_gib + volume_gib > b.ebs_gib_month) {
    out.push({
      level: "error",
      message: `${root_gib} GiB system + ${volume_gib} GiB data = ${root_gib + volume_gib} GiB, over the ${b.ebs_gib_month} GB-month EBS allowance`,
    });
  }
  if (volume_gib < VOLUME_GIB_MIN) {
    out.push({
      level: "error",
      message: `data volume ${volume_gib} GiB is under the ${VOLUME_GIB_MIN} GiB floor`,
    });
  }
  if (root_gib < ROOT_GIB_MIN || root_gib > ROOT_GIB_MAX) {
    out.push({
      level: "error",
      message: `system disk ${root_gib} GiB is outside ${ROOT_GIB_MIN}–${ROOT_GIB_MAX}`,
    });
  }
  const age = Math.floor((day(today) - day(b.reviewed_on)) / DAY_MS);
  if (Number.isNaN(age)) {
    out.push({ level: "error", message: `reviewed_on ${b.reviewed_on} is not a YYYY-MM-DD date` });
  } else if (age > b.review_after_days) {
    out.push({
      level: "warn",
      message: `last reviewed ${age} days ago (${b.reviewed_on}); re-read the sources and bump reviewed_on`,
    });
  }
  return out;
}

/**
 * The baseline against EC2's own answer: `eligible` is every Arm instance type
 * `describe-instance-types --filters free-tier-eligible=true` returned for the
 * signed-in account. That list is per account plan, so a legacy account and a
 * Free plan account disagree, and only a missing *size* is an error.
 */
export function checkEligibility(b: FreeTierBaseline, eligible: readonly string[]): Finding[] {
  const out: Finding[] = [];
  const type = SIZES[b.machine.size].instance_type;
  const known = new Set([...b.eligible_instance_types.free_plan, ...b.eligible_instance_types.legacy]);
  if (!eligible.includes(type)) {
    out.push({
      level: "error",
      message: `EC2 does not list ${type} (size ${b.machine.size}) as free-tier eligible on this account`,
    });
  }
  for (const t of eligible) {
    if (!known.has(t)) {
      out.push({ level: "warn", message: `EC2 lists ${t} as eligible; free-tier.ts does not` });
    }
  }
  return out;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

async function eligibleArmTypes(argv: readonly string[]): Promise<string[]> {
  const cmd = [
    "aws",
    "ec2",
    "describe-instance-types",
    "--filters",
    "Name=free-tier-eligible,Values=true",
    "Name=processor-info.supported-architecture,Values=arm64",
    "--query",
    "InstanceTypes[].InstanceType",
    "--output",
    "json",
  ];
  const region = flag(argv, "--region");
  const profile = flag(argv, "--profile");
  if (region !== undefined) cmd.push("--region", region);
  if (profile !== undefined) cmd.push("--profile", profile);
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`aws ec2 describe-instance-types failed (${code}): ${stderr.trim()}`);
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) {
    throw new Error(`unexpected describe-instance-types output: ${stdout.slice(0, 200)}`);
  }
  return [...parsed].sort();
}

function summary(b: FreeTierBaseline): string {
  const { size, volume_gib, root_gib } = b.machine;
  const spec = SIZES[size];
  const lines = [
    `AWS Free Tier baseline — reviewed ${b.reviewed_on}`,
    `  machine     ${size} (${spec.instance_type}, ${spec.vcpu} vCPU / ${spec.memGib} GiB)`,
    `  disks       ${volume_gib} GiB data + ${root_gib} GiB system = ${volume_gib + root_gib} of ${b.ebs_gib_month} GB-month`,
    `  hours       ${b.instance_hours_month} a month, shared by every instance in the account`,
    `  arm trial   ${b.arm_trial === null ? "none" : `${b.arm_trial.instance_type} until ${b.arm_trial.ends_on}`}`,
    `  legacy      ${b.eligible_instance_types.legacy.join(", ")}`,
    `  free plan   ${b.eligible_instance_types.free_plan.join(", ")}`,
    "  sources",
    ...b.sources.map((s) => `    ${s}`),
  ];
  return lines.join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  console.log(summary(AWS_FREE_TIER));
  const findings = checkBaseline(AWS_FREE_TIER, today);
  if (argv.includes("--aws")) {
    const eligible = await eligibleArmTypes(argv);
    console.log(`\nEC2 free-tier eligible Arm types on this account: ${eligible.join(", ") || "none"}`);
    findings.push(...checkEligibility(AWS_FREE_TIER, eligible));
  }
  console.log("");
  for (const f of findings) console.log(`${f.level === "error" ? "✗" : "!"} ${f.message}`);
  const errors = findings.filter((f) => f.level === "error").length;
  if (findings.length === 0) console.log("✓ the baseline fits every allowance it states");
  if (errors > 0) console.log("\nEdit packages/core/src/shared/free-tier.ts, then run this again.");
  return errors > 0 ? 1 : 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    },
  );
}
