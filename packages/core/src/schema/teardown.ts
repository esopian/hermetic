import { z } from "zod";
import { FleetIdSchema, Iso } from "./common.ts";
import { OpEvent, PlanOptions } from "./ops.ts";

/**
 * What became of one thing a teardown touched. `teardown` reports counts as it
 * runs (§9), but an event stream is prose that scrolls past: the receipt is the
 * same facts as data, so a head can show "removed" and "still there" as two
 * lists rather than asking the operator to read back a log.
 */
export const ResourceDisposition = z.enum([
  /** Gone, and this run is what removed it. */
  "removed",
  /** Still there on purpose: the flag that would have removed it was off. */
  "retained",
  /** Nothing to do — there was none of it to begin with. */
  "skipped",
  /** hermetic has no credential that reaches it; the operator must (§4.7). */
  "manual",
  /** Attempted and failed. The teardown may be resumable by re-running it. */
  "failed",
]);
export type ResourceDisposition = z.infer<typeof ResourceDisposition>;

export const ResourceOutcome = z.object({
  /** The teardown phase this belongs to: `bucket`, `stack`, `ssm`, … */
  phase: z.string(),
  disposition: ResourceDisposition,
  /** What it is, named the way AWS names it: `hermetic-fxtr0001-agents table`. */
  what: z.string(),
  /** How many, when a count is meaningful; null when the thing is singular. */
  count: z.number().int().nonnegative().nullable(),
  /** Why it was retained, what it cost, which flag would change it. */
  detail: z.string().nullable(),
});
export type ResourceOutcome = z.infer<typeof ResourceOutcome>;

/**
 * An idle Elastic IPv4 address, USD per month: AWS bills $0.005 an hour for
 * every allocation in the account, associated or not, at 730 hours to the
 * month. One number, one place, quoted as an estimate wherever it surfaces —
 * like `GP3_USD_PER_GIB_MONTH`, hermetic makes no Cost Explorer call and the
 * bill is whatever AWS says it is.
 */
export const EIP_USD_PER_MONTH = 3.65;

/** `$3.65`, spelled once so every message and every head agrees. */
export const EIP_MONTHLY_COST = `$${EIP_USD_PER_MONTH.toFixed(2)}`;

/**
 * Has this fleet an Elastic IP of its own to account for? Only a `nat`
 * foundation allocates one (§5), and `plan.teardown` and `teardown` must not
 * disagree about that: the plan is the promise the operator confirms, so both
 * read the mode through this one function.
 *
 * The stack's `Network` parameter is authoritative; `_fleet.network` is the
 * cache, and it is the only answer for a fleet whose stack is already gone or
 * predates the parameter.
 */
export function fleetHasNatAddress(
  stackNetwork: string | undefined,
  cachedNetwork: string | undefined,
): boolean {
  return (stackNetwork ?? cachedNetwork) === "nat";
}

/**
 * What became of the fleet's Elastic IP allocations (§4.6). A `nat` foundation
 * owns one, and it is the single stack resource that can outlive the stack: an
 * allocation whose association did not release survives `DeleteStack`, costs
 * `EIP_MONTHLY_COST` a month for ever and is named by nothing else the teardown
 * prints.
 *
 * `kept` is what is still there — `associated` says whether hermetic could have
 * released it at all, since `ReleaseAddress` fails on an attached address and
 * disassociating one is not teardown's call. `released` is what `--purge` took.
 */
export const AddressOutcome = z.object({
  allocation_id: z.string(),
  public_ip: z.string(),
  associated: z.boolean(),
});
export type AddressOutcome = z.infer<typeof AddressOutcome>;

export const AddressOutcomes = z.object({
  kept: z.array(AddressOutcome),
  released: z.array(z.string()),
});
export type AddressOutcomes = z.infer<typeof AddressOutcomes>;

/**
 * The permanent record of one teardown (§4.6). It is written to the local
 * `teardowns` table, which `--reset-local` deliberately does *not* clear: the
 * one moment an operator most needs to know what is left in the account is
 * after the home has forgotten which account it was.
 *
 * It carries no secret — every field is a name, a count or an event message,
 * and core never puts a value in either (§8.3).
 */
export const TeardownReceipt = z.object({
  id: z.string(),
  /** The op that produced it, when a head started one; null for a direct call. */
  op_id: z.string().nullable(),
  started_at: Iso,
  finished_at: Iso,
  account_id: z.string(),
  region: z.string(),
  fleet_id: FleetIdSchema,
  /** The stack this teardown deleted, by the name it actually had (§5). */
  stack_name: z.string(),
  options: PlanOptions,
  outcome: z.enum(["ok", "failed"]),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  resources: z.array(ResourceOutcome),
  /**
   * §4.6: the Elastic IP allocations this fleet's stack left behind, as data
   * rather than as prose. They are in `resources` too — that is what a head
   * renders — but an allocation id is something an operator has to *type* into
   * `aws ec2 release-address` or paste into the console, and a list that only
   * exists inside an English sentence is a list they have to retype from.
   *
   * Defaulted, so a receipt written by a build from before the sweep existed
   * still parses out of the local `teardowns` table.
   */
  addresses: AddressOutcomes.default({ kept: [], released: [] }),
  /** The full event stream, exactly as it was emitted. */
  events: z.array(OpEvent),
});
export type TeardownReceipt = z.infer<typeof TeardownReceipt>;

/** Convenience for heads: the receipt split the way it is displayed. */
export function groupByDisposition(
  receipt: TeardownReceipt,
): Record<ResourceDisposition, ResourceOutcome[]> {
  const groups: Record<ResourceDisposition, ResourceOutcome[]> = {
    removed: [],
    retained: [],
    skipped: [],
    manual: [],
    failed: [],
  };
  for (const resource of receipt.resources) groups[resource.disposition].push(resource);
  return groups;
}
