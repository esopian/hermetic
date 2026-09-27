/**
 * Binding a request to the fleet the operator meant (§4.7).
 *
 * Fleet selection in the portal is a property of the *server*, not of the
 * request: `POST /api/fleets/switch` repoints the whole process, every open tab
 * at once. So a browser tab that has been open since before a switch will
 * happily send `DELETE /api/agents/atlas` believing it means the `atlas` it is
 * showing, and the server will destroy an `atlas` in another account.
 *
 * The fix is that a fleet-scoped mutation names the fleet it means, in terms
 * nothing can rename — `{account_id, region, fleet_id}`, core's `FleetTarget` —
 * and the server refuses it with `FLEET_MISMATCH` when that is not the fleet it
 * is currently serving. It is the portal's half of the guard core already runs
 * against AWS (`guardAccount`/`guardFleet`): same triple, one round trip
 * earlier, and before anything has been spent.
 *
 * Two deliberate non-goals:
 *
 * - **Core's schemas are untouched.** `target` is a fact about the HTTP head's
 *   statefulness; the CLI resolved its fleet before it opened core at all and
 *   has nothing to say here. So the route validates against
 *   `withTarget(coreSchema)` and hands core the same object it always did,
 *   while `declareRoute` goes on recording core's own schema — which is what
 *   `tests/parity.test.ts` compares, and what a resumed op re-validates a
 *   pending row against.
 * - **Reads are not covered.** A stale tab reading the wrong fleet's plan or
 *   log shows the wrong thing; a stale tab *destroying* against the wrong
 *   fleet deletes the wrong thing. This guards the second.
 */
import { z } from "zod";
import type { ZodType } from "zod";
import { FleetTarget, HermeticError, describeFleetTarget, sameFleetTarget } from "@hermetic/core";
import type { Hermetic } from "@hermetic/core";
import type { AppState } from "./state.ts";

/**
 * The one field every guarded request grows.
 *
 * `.optional()` in the *schema*, and required by the *guard* below. Two things
 * turn on that split, and neither of them weakens it:
 *
 * - A validator refusal is a 400 with a field list, decided before the route
 *   body runs. `requireTarget` refuses with `FLEET_MISMATCH`, which is a
 *   sentence about fleets and is what the browser turns into "reload the page"
 *   — so the refusal belongs to the guard, not to zod. (`jsonBody` supplies a
 *   default body for the no-body case; a required `target` would make that
 *   default unparseable and answer 400 for a request that has a better answer.)
 * - A server that has not been initialized has no fleet to check against, and
 *   every fleet-scoped core method already refuses it `NOT_INITIALIZED`, which
 *   is the more useful answer. That is the only case the guard lets past.
 *
 * On any head that *has* a fleet selected — the desktop app, and any state
 * built around a single `Hermetic`, from the moment it has one to mutate — an
 * absent target is refused exactly as firmly as a wrong one. `fleet-target.test.ts` holds that line.
 */
export const FleetTargetEnvelope = z.object({ target: FleetTarget.optional() });

/**
 * A core request schema, plus the `target` naming the fleet it is for.
 *
 * An intersection rather than `.extend()`: several request schemas are
 * `.refine()`d (`UpgradeInput`, `SettingsSetInput`, `ProvidersUpdateInput`),
 * and a refined schema has no `.extend()` to call. The intersection parses both
 * halves and merges them, so a refusal from core's own refinement still reads
 * as core's refusal.
 */
export function withTarget<T extends ZodType>(schema: T) {
  return z.intersection(schema, FleetTargetEnvelope);
}

/** What a guarded handler gets back: the instance it must use, and core's own input. */
export interface Targeted<T> {
  /**
   * The instance that was serving the named fleet at the instant the target
   * matched. Captured here and used for everything the handler does — planning,
   * and the op closure — so a switch landing mid-request cannot move the fleet
   * out from under a decision already taken (`app.ts`'s `hermetic()` used to be
   * read twice, once to plan and once to execute).
   */
  hermetic: Hermetic;
  /** The request without `target`: exactly the object core's schema describes. */
  input: T;
  /**
   * The fleet that check passed against — `state.target` as it was read, not as
   * it is now. Kept so a handler that has to `await` something before it acts
   * can say what it was bound to when it decided (`stillBound`).
   *
   * `null` only where `state.target` is: an uninitialized server, where there
   * is nothing to be bound to.
   */
  boundTo: FleetTarget | null;
}

/**
 * Refuse unless the request names the fleet this server is serving, and hand
 * back the instance that was serving it.
 *
 * Synchronous on purpose, and called before the handler's first `await`. A
 * switch installs its new instance in one synchronous step
 * (`AppState.#install`), so a check and a capture that share a turn of the
 * event loop cannot be separated by one.
 *
 * `state.target` is null in exactly one case, and it cannot be bound: a server
 * with no fleet selected, where every fleet-scoped core method already refuses
 * `NOT_INITIALIZED`, which is the more useful answer. A server built around a
 * single `Hermetic` instance used to be the second case, on the grounds that it
 * cannot *switch* fleets (`fixedInstance` refuses with `UNSUPPORTED`) so there
 * was no second fleet a request could have meant. That was a hole rather than a
 * simplification — a browser still sends whatever target it last read, and the
 * app suite is built almost entirely on that overload, so the guard was inert
 * everywhere it was tested. Such a state now takes its target from the instance
 * it was handed and is guarded like any other.
 */
export function requireTarget<T extends { target?: FleetTarget | undefined }>(
  state: AppState,
  body: T,
): Targeted<Omit<T, "target">> {
  const { target, ...input } = body;
  const current = state.target;
  const hermetic = state.hermetic;
  if (current === null) return { hermetic, input, boundTo: null };
  if (target === undefined) {
    throw new HermeticError(
      "FLEET_MISMATCH",
      `this request does not say which fleet it is for; this portal is serving ${describeFleetTarget(current)}`,
      { current },
    );
  }
  if (!sameFleetTarget(target, current)) {
    throw new HermeticError(
      "FLEET_MISMATCH",
      `this request names ${describeFleetTarget(target)}, but this portal is serving ${describeFleetTarget(current)}; reload the page and try again`,
      { requested: target, current },
    );
  }
  return { hermetic, input, boundTo: current };
}

/**
 * Re-assert, after an `await`, the binding this handler took before it (§4.7).
 *
 * `requireTarget` is synchronous so that the check and the capture cannot be
 * separated by a switch, and every route that acts in the same turn is finished
 * with the problem there. Three are not. `agents.destroy` and `agents.recreate`
 * read the agent's identity for the pending log before they start their op, and
 * that read is a round trip; `POST /api/teardown` computes its plan before
 * starting the op, for the receipt. Teardown is additionally protected by the
 * block it claims before planning (`beginTeardown(TEARDOWN_PLANNING)`), which
 * makes a switch refuse outright — it re-asserts the binding anyway, so that
 * removing the block could never silently unbind a teardown instead. A switch landing in that gap left the op running
 * against the captured instance while the registry stamped the run and pending
 * rows with the fleet the server had moved *to* — and a pending row that names
 * the wrong fleet is a row a later boot replays against the wrong fleet.
 *
 * Rather than carry the captured target down into `ops.start` — which makes
 * every future call site responsible for remembering to pass it — the binding
 * is simply re-taken: if the server has moved, the request is refused with the
 * same `FLEET_MISMATCH` it would have got a moment earlier, and the operator
 * reloads and decides again. Nothing was spent, and a destroy confirmed against
 * a fleet this portal has left is not one to finish on its way out.
 *
 * The instance is compared as well as the triple, because it is the instance
 * the identity was read from: same fleet, same instance, or this is not the
 * request that was checked.
 */
export function stillBound(state: AppState, bound: Targeted<unknown>): void {
  const current = state.target;
  const same =
    state.hermetic === bound.hermetic &&
    (bound.boundTo === null ? current === null : sameFleetTarget(bound.boundTo, current));
  if (same) return;
  throw new HermeticError(
    "FLEET_MISMATCH",
    `this portal moved to ${describeFleetTarget(current)} while this request was in flight; reload the page and try again`,
    { requested: bound.boundTo, current },
  );
}

/**
 * The same refusal for a fleet named somewhere other than a `target` field —
 * `apply`'s plan carries its own `summary` (`{account_id, region, fleet_id}`),
 * written when the plan was computed, and a plan computed against one fleet
 * must not be applied to another however it reached this server.
 *
 * A plan with *no* summary is not refused: `apply` parses a document the caller
 * handed in, and one written by an older hermetic has none (see `Plan.summary`).
 * The `target` on the request itself is required either way, so such a plan is
 * still bound to the fleet the *request* named.
 *
 * A plan whose summary is present but does not parse is a different thing, and
 * is refused. "Absent" is a fact about an older document; "present and
 * unreadable" is a document claiming to name a fleet in terms this build cannot
 * check, and reading the second as the first is how the guard is disarmed —
 * hand `apply` a summary with one malformed field and the binding that was the
 * whole point of carrying a summary stops applying. `PlanSummary` is built on
 * the same `AccountId`/`Region` primitives as `FleetTarget`, so anything core
 * produced parses here and only something else cannot.
 */
export function requirePlanTarget(
  state: AppState,
  summary: { account_id: string; region: string; fleet_id: string } | undefined,
): void {
  const current = state.target;
  if (current === null || summary === undefined) return;
  const planned = FleetTarget.safeParse(summary);
  if (!planned.success) {
    throw new HermeticError(
      "VALIDATION",
      "this plan's summary does not name a fleet this portal can check it against; re-plan against the fleet you mean",
      { current, fields: planned.error.issues.map((i) => i.path.join(".")) },
    );
  }
  if (sameFleetTarget(planned.data, current)) return;
  throw new HermeticError(
    "FLEET_MISMATCH",
    `this plan was computed against ${describeFleetTarget(planned.data)}, but this portal is serving ${describeFleetTarget(current)}; re-plan against the fleet you mean`,
    { requested: planned.data, current },
  );
}
