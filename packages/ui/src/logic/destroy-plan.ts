/**
 * The agent drawer's destroy confirmation, as a state machine (§6.7).
 *
 * Core never asks "are you sure" (§3.2 rule 3), so the whole ceremony is the
 * head's: read the plan, show it, take a typed name, apply *that* plan. The
 * part that was missing is that the ceremony has to be about one set of inputs.
 * Typing the agent's name used to arm the button on its own, so a plan request
 * that failed — or one still in flight, or the stale one still on screen while
 * a re-plan ran after the keep-volume choice changed — left a live Destroy
 * over steps nobody had actually reviewed.
 *
 * The fix is to key every plan on the inputs it was made for and to refuse to
 * arm the button unless the plan on screen is the plan for the inputs in front
 * of the operator right now. `fleetId` is part of that key because a fleet
 * switch re-points the same agent name at a different box (§4.8) — core's
 * `apply` refuses a plan made for another fleet, and this is the same rule one
 * step earlier, where it can still be explained rather than thrown.
 */
import type { Plan } from "../api/index.ts";

/** Everything a destroy plan is a function of. */
export interface DestroyInputs {
  /** `fleetIdOf(meta)`, or null before this home is bound to one. */
  fleetId: string | null;
  name: string;
  keepVolume: boolean;
}

/**
 * The inputs as one comparable string. A space separates the fields because a
 * fleet id and an agent name are both `[a-z0-9-]`, and `a-b` + `c` must not
 * collide with `a` + `b-c`.
 */
export function destroyInputsKey(inputs: DestroyInputs): string {
  return [inputs.fleetId ?? "unbound", inputs.name, inputs.keepVolume ? "1" : "0"].join(" ");
}

/**
 * `idle` is "the panel is shut". Every other state carries the inputs key it
 * belongs to, so a reply that arrives after the operator changed something can
 * be recognised as being about a question nobody is asking any more.
 */
export type DestroyPlanState =
  | { status: "idle" }
  | { status: "planning"; inputs: string }
  | { status: "planned"; inputs: string; plan: Plan }
  | { status: "plan_failed"; inputs: string; error: string };

/**
 * The plan to draw for `current`, or null — which is "still reading", and never
 * the previous inputs' plan dressed up as this one's.
 */
export function shownPlan(state: DestroyPlanState, current: string): Plan | null {
  return state.status === "planned" && state.inputs === current ? state.plan : null;
}

/** Why there is no plan to draw, when the reason is a failed read. */
export function shownPlanError(state: DestroyPlanState, current: string): string | null {
  return state.status === "plan_failed" && state.inputs === current ? state.error : null;
}

/**
 * The plan the Destroy button would apply, or null when it must stay dead.
 *
 * Returning the plan rather than a boolean is the point: the button submits the
 * object this returned, so the thing executed is by construction the thing that
 * was on screen. There is no path from the form's own fields to `apply`.
 */
export function armedPlan(
  state: DestroyPlanState,
  current: string,
  typedMatches: boolean,
  busy: boolean,
): Plan | null {
  if (!typedMatches || busy) return null;
  return shownPlan(state, current);
}

/**
 * The code core answers an `apply` with when the row moved under the plan
 * (`plans.assertCurrent`, and again under the agent's lock in `destroy`). It is
 * the server's half of the same rule this module keeps on the screen: the
 * document being applied has to still be true. The drawer treats it as a
 * re-plan rather than a dead end, because it is one — the operator's intent did
 * not change, the world did.
 *
 * It is `PLAN_STALE` and not `CONFLICT` because only this code means that. The
 * server answers 409 `CONFLICT` for a teardown, a foundation update or a fleet
 * switch already running, and core does for a lock race and a volume
 * reservation; none of those is fixed by reading a fresh plan, so re-planning
 * on `CONFLICT` put the operator in a loop against a busy fleet, retyping the
 * agent's name under a message about staleness that was not what happened.
 * Every other refusal is shown as itself, with core's own wording.
 */
export const STALE_PLAN_CODE = "PLAN_STALE";

/** Whether a failed `apply` is asking for a fresh plan rather than reporting a dead end. */
export function isStalePlan(code: string | null | undefined): boolean {
  return code === STALE_PLAN_CODE;
}
