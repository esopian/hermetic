/**
 * The guards and the after-the-fact bookkeeping more than one handler module
 * needs — moved here from the Hono head's `routes/shared.ts`, which went with
 * that head.
 */
import { HermeticError } from "@hermetic/core";
import type { ErrorCode, PlanSummary } from "@hermetic/core";
import type { AppState } from "../state.ts";
import type { HandlerContext } from "./ctx.ts";

/**
 * Every handler that *mutates* the fleet a running teardown is in the middle of
 * deleting: `agents.create`, `agents.set`, `agents.stop`, `agents.start`,
 * `agents.destroy`, `agents.recreate`, `agents.rerun`, `secrets.push`,
 * `foundation.update` and `init`. They refuse with the same shape `initBlocked`
 * uses, while `state.teardownOpId` is set (see `AppState.beginTeardown`) —
 * which now spans the reset that follows a successful teardown, not just the op.
 *
 * Reads stay open deliberately: `agents.list`, `agents.get`, `history`,
 * `probe`, `doctor`, `plan.*`, `secrets.verify`, `ssh`, `logs`, `meta` and the
 * op streams are how an operator watches a teardown happen, and blocking them
 * would blank the UI at exactly the moment it has something to show.
 */
export function teardownBlocked(state: AppState): { error: { code: string; message: string } } | null {
  if (state.teardownOpId === null) return null;
  return { error: { code: "CONFLICT", message: "teardown in progress" } };
}

/**
 * The same shape for a running `foundation.update` (§6.6). Core already refuses
 * every agent-level mutation while the `_fleet` lock is held — `acquireLock`
 * reads `_fleet` first and throws `LOCKED` — but that refusal arrives from AWS,
 * one round trip and (for a streaming method) one 202 later. This is the head
 * saying so immediately, over exactly the calls `teardownBlocked` covers.
 *
 * Applied in the other direction too: the update handler carries
 * `teardownBlocked`, so the two whole-fleet ops exclude each other.
 */
export function updateBlocked(state: AppState): { error: { code: string; message: string } } | null {
  if (state.foundationUpdateOpId === null) return null;
  return { error: { code: "CONFLICT", message: "foundation update in progress" } };
}

/**
 * §4.8, and the same shape again for the window `switchFleet` holds open.
 * Checking "is an op running" and then installing a different instance are two
 * statements with two awaits between them; without this an `agents.create`
 * accepted in that gap would run against the instance the switch is replacing,
 * and its result would land on a fleet the dashboard is no longer showing.
 */
export function switchBlocked(state: AppState): { error: { code: string; message: string } } | null {
  if (!state.switching) return null;
  return { error: { code: "CONFLICT", message: "fleet switch in progress" } };
}

/**
 * The three above, in the order every mutating handler asks them: a teardown
 * names itself first because it is the one that ends in a reset, then a
 * foundation update, then a switch. Returns the 409 body to send, or `null`
 * when the write may proceed.
 *
 * Kept as a body-returning function because `tests/` reads the shape. New code
 * calls `requireWritable`.
 */
export function writeBlocked(state: AppState): { error: { code: string; message: string } } | null {
  return teardownBlocked(state) ?? updateBlocked(state) ?? switchBlocked(state);
}

/**
 * `writeBlocked`, as a refusal rather than a body.
 *
 * A handler has no `c.json(body, 409)` to return, so the block becomes what
 * every other refusal in core already is: a thrown `HermeticError` carrying a
 * code. The wire is unchanged — the code is `CONFLICT`, `errors.ts` maps it to
 * 409, and `classifyFailure` builds the identical `{error: {code, message}}`
 * body the route used to hand `c.json` — so this is a refactor of *where* the
 * refusal is decided, not of what a client sees.
 */
export function requireWritable(state: AppState): void {
  const blocked = writeBlocked(state);
  if (blocked === null) return;
  throw new HermeticError(blocked.error.code as ErrorCode, blocked.error.message);
}

/**
 * What holds the teardown slot between "the operator confirmed" and "the op
 * exists" (§4.7).
 *
 * `beginTeardown` wants an op id and there is no op yet — planning comes first,
 * and planning is where the race was: two awaits during which the state
 * believed nothing was in flight, so a fleet switch was accepted and the
 * teardown that followed deleted a foundation nobody had planned. This is the
 * reservation that closes it, replaced by the real op id the moment there is
 * one. It is never served to a client; `teardownOpId` is read only by the
 * guards and by `switchFleet`.
 */
export const TEARDOWN_PLANNING = "teardown:planning";

/**
 * What happens once a teardown op ends, wherever it was started from:
 * `teardown` and `apply` with a teardown plan are the same operation wearing
 * different requests, and only the first of them used to do any of this.
 *
 * Not awaited: the caller is answered with the op like every other op. Ops
 * started before this one keep streaming to completion regardless of what
 * happens to `state.hermetic` below (see `OpRegistry` and
 * `AppState.resetToUninitialized`).
 */
export function afterTeardown(
  { state, ops }: HandlerContext,
  opId: string,
  plan: { summary?: PlanSummary; warnings: string[] },
  resetLocal: boolean,
): void {
  void ops.wait(opId).then(async (summary) => {
    /**
     * The block outlives the op. `endTeardown()` used to run first, which
     * opened a window — from the op finishing to `resetToUninitialized()`
     * resolving — where the mutating routes were unblocked but still holding
     * the instance whose foundation had just been deleted, and where
     * `/api/init` saw an "initialized" server with no fleet under it. The
     * `finally` is what closes it: whatever happens to the reset, the guard
     * is released only once the state has finished changing.
     */
    try {
      if (summary?.status !== "ok") return;
      if (!resetLocal) return;
      try {
        await state.resetToUninitialized({
          at: new Date().toISOString(),
          account_id: plan.summary?.account_id ?? "",
          region: plan.summary?.region ?? "",
          fleet_id: plan.summary?.fleet_id ?? "",
          manual_steps: plan.warnings,
        });
      } catch {
        // The foundation is gone either way; a reset that fails to reopen the
        // wizard session must not take the app down. The operator relaunches
        // it, same as an `adopt()` failure.
      }
    } finally {
      state.endTeardown();
    }
  });
}

/**
 * The `yes: false` a confirmable request is read as when it does not carry one
 * (§3.2 rule 3: the head confirms).
 *
 * It used to live only in the Hono head's body defaults, which made the
 * confirmation a property of the *transport*: a body-less `DELETE
 * /api/agents/x` reached core as `{name, yes: false}` and got the 428 it
 * deserved, while the same request through `dispatch` failed validation on a
 * missing boolean and never reached the confirmation at all. The default
 * belongs to the handler, where every transport gets it.
 */
export function unconfirmed(params: unknown): unknown {
  if (params === null || typeof params !== "object") return { yes: false };
  return { yes: false, ...(params as Record<string, unknown>) };
}
