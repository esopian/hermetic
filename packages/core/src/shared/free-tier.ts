/**
 * The AWS Free Tier baseline (§10): the one place that says which machine
 * fits the free allowances, and what the rest of a fleet costs against them.
 *
 * AWS changes the Free Tier every year or so — the July 2025 split between
 * the legacy 12-month plan and the credit-funded Free plan, a Graviton trial
 * that is extended one December at a time — so everything that depends on it
 * reads from this object and nothing restates a number. Edit it here, then
 * run `bun run free-tier` (`scripts/free-tier.ts`), which checks the machine
 * against the allowances below and, with `--aws`, against what EC2 itself
 * reports as free-tier eligible for the account you are signed in to.
 *
 * Read by three packages: core builds the `free-tier` built-in create preset
 * from `machine` (`presets.ts`), the UI draws Settings › Defaults' button and
 * help drawer from all of it, and the script checks it. Pure values only, so
 * the browser can import it (`shared-browser-safe.test.ts`).
 */
import { DEFAULT_ROOT_GIB } from "./box.ts";
import type { SizeId } from "./sizes.ts";

/** How a fleet resource stands against its allowance. */
export type FreeTierTreatment =
  /** The baseline sets it so one agent fits the allowance. */
  | "set"
  /** Nothing to set: hermetic's own use already sits inside the allowance. */
  | "within"
  /** Billed regardless, or billed once it grows; the baseline cannot help. */
  | "not_covered";

/**
 * Which accounts an allowance applies to. The July 2025 split matters here:
 * the legacy plan's monthly allowances do not exist on the Free plan, where
 * every billable use draws the sign-up credits instead.
 */
export type FreeTierPlan =
  /** Accounts opened before 15 July 2025, for their first 12 months. */
  | "legacy"
  /** Every account, on either plan, for as long as AWS offers it. */
  | "always"
  /** No allowance anywhere: billed from the first hour or request. */
  | "none";

export interface FreeTierResource {
  id: string;
  /** The AWS resource, as the billing console names it. */
  resource: string;
  /** What the Free Tier gives, in AWS's units. */
  allowance: string;
  /** What hermetic uses or sets, and why that fits (or does not). */
  hermetic: string;
  treatment: FreeTierTreatment;
  plan: FreeTierPlan;
}

export interface FreeTierBaseline {
  /**
   * When a contributor last checked every figure below against AWS's pages.
   * `bun run free-tier` warns once this is older than `review_after_days`.
   */
  reviewed_on: string;
  review_after_days: number;
  /** The pages the figures came from, in the order a reviewer should read them. */
  sources: readonly string[];
  /**
   * The machine the baseline sets: the fleet's `defaults.size`,
   * `defaults.volume_gib` and `defaults.root_gib`, and the `free-tier` create
   * preset. `root_gib + volume_gib` must not exceed `ebs_gib_month`.
   */
  machine: { size: SizeId; volume_gib: number; root_gib: number };
  /** The EBS storage allowance, in GB-months, shared by every volume in the account. */
  ebs_gib_month: number;
  /**
   * Instance hours per month, shared by every instance of the eligible types —
   * one agent running all month, not one per agent.
   */
  instance_hours_month: number;
  /**
   * The Graviton trial that makes an Arm box free on *every* account, legacy
   * or new: `instance_type` for `hours_per_month` until `ends_on` (inclusive).
   * When it lapses the script fails until this is moved or removed.
   */
  arm_trial: { instance_type: string; hours_per_month: number; ends_on: string } | null;
  /**
   * The instance types AWS marks "Free tier eligible", by account plan. The
   * plan follows the account's creation date: before 15 July 2025 is the legacy
   * 12-month plan, on or after it is the 6-month, credit-funded Free plan.
   */
  eligible_instance_types: {
    legacy: readonly string[];
    free_plan: readonly string[];
  };
  /** The Free plan's credits: granted at sign-up, and the most that can be earned. */
  free_plan_credits_usd: { signup: number; max: number };
  /** Every resource a fleet uses, for the help drawer's table. */
  resources: readonly FreeTierResource[];
}

export const AWS_FREE_TIER: FreeTierBaseline = {
  reviewed_on: "2026-10-14",
  review_after_days: 90,
  sources: [
    "https://aws.amazon.com/free/",
    "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html",
    "https://aws.amazon.com/ec2/instance-types/t4/",
    "https://aws.amazon.com/ebs/pricing/",
    "https://aws.amazon.com/vpc/pricing/",
  ],
  // t4g.small: 2 vCPU / 2 GiB, the largest Arm type on either list. A 20 GiB
  // system disk is `DEFAULT_ROOT_GIB` (`box.ts` says why it is not 8), which
  // leaves 10 GiB of the 30 for `/data`.
  machine: { size: "xxsmall", volume_gib: 10, root_gib: 20 },
  ebs_gib_month: 30,
  instance_hours_month: 750,
  arm_trial: { instance_type: "t4g.small", hours_per_month: 750, ends_on: "2026-12-31" },
  eligible_instance_types: {
    legacy: ["t2.micro", "t3.micro"],
    free_plan: ["t3.micro", "t3.small", "t4g.micro", "t4g.small", "c7i-flex.large", "m7i-flex.large"],
  },
  free_plan_credits_usd: { signup: 100, max: 200 },
  resources: [
    {
      id: "ec2",
      resource: "EC2 instance",
      allowance:
        "t4g.small Graviton trial: 750 hours a month until 31 Dec 2026. AWS states it is open to all customers, one trial per AWS Organization",
      hermetic:
        "Size xxsmall (t4g.small, 2 vCPU / 2 GiB). The 750 hours cover one agent running all month. 2 GiB is far below what the browser stack wants: expect a slow box for light work.",
      treatment: "set",
      plan: "always",
    },
    {
      id: "ebs",
      resource: "EBS storage (gp3)",
      allowance: "30 GB-month across every volume in the account",
      hermetic: "10 GiB data volume + 20 GiB system disk = 30 GiB, one agent's worth.",
      treatment: "set",
      plan: "legacy",
    },
    {
      id: "snapshots",
      resource: "EBS snapshots",
      allowance: "1 GB-month of snapshot storage",
      hermetic:
        "By default the fleet keeps 7 daily snapshots of every data volume, which passes 1 GB quickly. Lower the count or turn them off in Settings › Foundation › Snapshots; this button leaves them as they are.",
      treatment: "not_covered",
      plan: "legacy",
    },
    {
      id: "ipv4",
      resource: "Public IPv4 address",
      allowance:
        "750 hours a month for the legacy plan's first 12 months, then $0.005 an hour (≈$3.65/mo)",
      hermetic:
        "Public network mode gives each agent one address. Billed outside the legacy plan's first year.",
      treatment: "not_covered",
      plan: "legacy",
    },
    {
      id: "nat",
      resource: "NAT instance (network mode nat)",
      allowance: "None: t4g.nano and its Elastic IP are billed",
      hermetic: "Only fleets that opted into nat run one. The baseline does not change network mode.",
      treatment: "not_covered",
      plan: "none",
    },
    {
      id: "dynamodb",
      resource: "DynamoDB",
      allowance: "25 GB of storage",
      hermetic: "Two on-demand tables measured in kilobytes. Heartbeat writes cost cents a month.",
      treatment: "within",
      plan: "always",
    },
    {
      id: "s3",
      resource: "S3 (release artifacts)",
      allowance: "5 GB of Standard storage",
      hermetic:
        "hermeticd, the bootstrap stages, the Hermes bundle and the Chrome zip: well under 1 GB.",
      treatment: "within",
      plan: "legacy",
    },
    {
      id: "ssm",
      resource: "SSM Parameter Store",
      allowance: "Standard parameters carry no charge",
      hermetic: "Provider keys and the Tailscale key are standard SecureString parameters.",
      treatment: "within",
      plan: "always",
    },
    {
      id: "transfer",
      resource: "Data transfer out",
      allowance: "100 GB a month to the internet",
      hermetic: "Model API traffic and the tailnet. A browsing-heavy agent can exceed it.",
      treatment: "within",
      plan: "always",
    },
    {
      id: "models",
      resource: "Model provider (Bedrock, Anthropic, OpenAI…)",
      allowance: "None: tokens are billed by the provider",
      hermetic: "Billed per token whatever the machine is. Bedrock is billed on this AWS account.",
      treatment: "not_covered",
      plan: "none",
    },
  ],
};

/** The id of the built-in create preset the baseline makes this laptop's default. */
export const FREE_TIER_PRESET_ID = "free-tier";

/**
 * Whether a fleet's machine defaults are exactly the baseline's. An absent
 * `root_gib` is `DEFAULT_ROOT_GIB`, as it is at create (`FleetDefaults`).
 */
export function isFreeTierMachine(m: {
  size: string;
  volume_gib: number;
  root_gib?: number | undefined;
}): boolean {
  const b = AWS_FREE_TIER.machine;
  return (
    m.size === b.size &&
    m.volume_gib === b.volume_gib &&
    (m.root_gib ?? DEFAULT_ROOT_GIB) === b.root_gib
  );
}
