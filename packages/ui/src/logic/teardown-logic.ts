/**
 * Pure gating logic for the teardown drawer (`TeardownDrawer.tsx`), pulled out
 * so it can be unit-tested without mounting React. Nothing here touches the
 * DOM, `fetch`, or any browser API.
 */
import type { TeardownOptions, TeardownPlan } from "../api/index.ts";

/** Matches the "N agent(s) still exist" warning core's plan puts in `warnings`. */
export const AGENTS_EXIST_RE = /^\d+ agent\(s\) still exist/;

/**
 * Stage 2's account-id check. The typed value must be exactly the twelve
 * digits reported by the fetched plan's `summary.account_id` — server truth,
 * never `meta.config.account_id` (the frozen config can go stale; the plan is
 * refetched on every option change and is what core will actually act on).
 */
export function accountMatches(typed: string, summaryAccountId: string | null | undefined): boolean {
  const t = typed.trim();
  if (!summaryAccountId) return false;
  return /^\d{12}$/.test(t) && t === summaryAccountId;
}

/** Stage 2's literal-word check. */
export function wordMatches(typed: string): boolean {
  return typed.trim() === "teardown";
}

/** True when a plan's own warnings say agents still exist (defense in depth alongside the live fleet check). */
export function planHasAgentsExist(plan: Pick<TeardownPlan, "warnings"> | null | undefined): boolean {
  return !!plan?.warnings?.some((w) => AGENTS_EXIST_RE.test(w));
}

export interface CanSubmitInput {
  stage: 1 | 2 | 3;
  plan: Pick<TeardownPlan, "warnings" | "summary"> | null;
  planLoading: boolean;
  planError: string | null;
  /** Computed against the live fleet (not just the plan's prose). */
  agentsExist: boolean;
  accountTyped: string;
  wordTyped: string;
}

/**
 * Whether the "Tear down the foundation" button in Stage 2 may be pressed.
 * Only true on Stage 2, with a loaded, error-free plan, no agents (live or
 * per the plan), and both typed fields matching the plan's server truth.
 */
export function canSubmit(input: CanSubmitInput): boolean {
  const { stage, plan, planLoading, planError, agentsExist, accountTyped, wordTyped } = input;
  if (stage !== 2) return false;
  if (planLoading || planError) return false;
  if (!plan) return false;
  if (agentsExist || planHasAgentsExist(plan)) return false;
  return accountMatches(accountTyped, plan.summary?.account_id) && wordMatches(wordTyped);
}

/**
 * Whether a change to the teardown options should invalidate Stage 2's typed
 * confirmation fields. Any change to any flag invalidates — a different set
 * of options produces a different plan (a different, possibly more or less
 * destructive set of steps), so a confirmation typed against the old plan
 * must not silently carry over.
 */
export function invalidateOnOptionsChange(
  prev: Required<TeardownOptions>,
  next: Required<TeardownOptions>,
): boolean {
  return (
    prev.purge !== next.purge ||
    prev.delete_snapshots !== next.delete_snapshots ||
    prev.delete_volumes !== next.delete_volumes ||
    prev.reset_local !== next.reset_local
  );
}
