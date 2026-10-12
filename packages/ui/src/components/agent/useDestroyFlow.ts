/**
 * The destroy confirmation's state machine (§6.7): read a plan for the inputs
 * on screen, arm the button only for that plan, apply exactly that plan. Split
 * out of `AgentDrawer.tsx`; `DestroyConfirm` draws it.
 */
import { useEffect, useState } from "react";
import { ApiError, applyPlan, planDestroy } from "../../api/index.ts";
import type { Plan } from "../../api/index.ts";
import {
  armedPlan,
  destroyInputsKey,
  isStalePlan,
  shownPlan,
  shownPlanError,
  type DestroyPlanState,
} from "../../logic/destroy-plan.ts";
import { confirmMatches } from "../TypedConfirm.tsx";

export function useDestroyFlow({
  confirmOpen,
  setConfirmOpen,
  fleetId,
  name,
  busy,
  setBusy,
  setFailure,
  accept,
}: {
  confirmOpen: boolean;
  setConfirmOpen: (open: boolean) => void;
  fleetId: string | null;
  name: string;
  /** Shared with the drawer's other actions: one op at a time. */
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setFailure: (failure: string | null) => void;
  /** Hands the accepted op to the drawer's progress rail (`useAgentOp`). */
  accept: (opId: string, label: string) => void;
}) {
  /**
   * The destroy confirmation's plan, keyed on the inputs it was made for
   * (`destroy-plan.ts`). Never a bare `Plan | null`: "there is a plan" and
   * "there is a plan for what is on screen" are different claims, and only the
   * second one may arm the button.
   */
  const [planState, setPlanState] = useState<DestroyPlanState>({ status: "idle" });
  /** Bumped to re-read a plan for unchanged inputs: the retry after a failed read. */
  const [replan, setReplan] = useState(0);
  /** §6.7: a destroy deletes the data volume unless the operator keeps it. */
  const [keepVolume, setKeepVolume] = useState(false);
  const [typed, setTyped] = useState("");

  /**
   * Read the plan for the inputs currently on screen. Closing the panel returns
   * the machine to `idle` rather than leaving the last plan behind it, so
   * reopening cannot show — or arm — a plan from a previous visit.
   *
   * The reply is stamped with the key it was asked for and dropped when the key
   * has moved on. `alive` already covers the common re-render, but a request
   * whose cleanup ran and whose successor has not answered yet would otherwise
   * be free to land as the current plan.
   */
  useEffect(() => {
    if (!confirmOpen) {
      setPlanState({ status: "idle" });
      return;
    }
    const inputs = destroyInputsKey({ fleetId, name, keepVolume });
    let alive = true;
    setPlanState({ status: "planning", inputs });
    planDestroy(name, keepVolume)
      .then((p) => {
        if (alive) setPlanState({ status: "planned", inputs, plan: p });
      })
      .catch((e: unknown) => {
        if (alive) {
          setPlanState({
            status: "plan_failed",
            inputs,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [confirmOpen, fleetId, name, keepVolume, replan]);

  /**
   * The typed name is a confirmation *of the plan on screen*, so it does not
   * survive the plan it confirmed. Without this, choosing "keep volume"
   * with the name already typed would leave the button armed across the gap
   * where the replacement plan is still being read.
   */
  useEffect(() => {
    setTyped("");
  }, [fleetId, name, keepVolume, confirmOpen]);

  /** The inputs this render is about, and the plan (if any) that belongs to them. */
  const destroyKey = destroyInputsKey({ fleetId, name, keepVolume });
  const plan = shownPlan(planState, destroyKey);
  const planError = shownPlanError(planState, destroyKey);
  const armed = armedPlan(planState, destroyKey, confirmMatches(typed, name), busy);

  /** Read the plan again for unchanged inputs: the retry after a failed read. */
  const retryPlan = () => setReplan((n) => n + 1);

  /**
   * Apply the reviewed destroy plan (§6.7). `POST /api/apply` rather than
   * `DELETE /api/agents/:name`, because the plan carries the instance and
   * volume ids the operator just read and core re-checks them — first against
   * the row, then again with the agent's lock held. A direct delete would
   * recompute the intent from the name and terminate whatever the row happens
   * to point at by then.
   *
   * `null` cannot reach here through the button, which is disabled without a
   * plan; it is refused anyway, because "no plan" is the one thing this panel
   * must never treat as "go ahead".
   */
  async function runDestroy(reviewed: Plan | null) {
    if (!reviewed) {
      setFailure("no current destroy plan to apply; reopen the panel and read the plan first");
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const accepted = await applyPlan(reviewed);
      accept(accepted.op_id, "destroy");
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      /**
       * The row moved between the plan and the apply, so core refused rather
       * than destroying something nobody reviewed. That is a re-plan, not a
       * dead end: reopen the panel, which reads a fresh plan and leaves the
       * button dead until the operator reads and confirms that one.
       */
      if (e instanceof ApiError && isStalePlan(e.code)) {
        setConfirmOpen(true);
        setReplan((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  return {
    plan,
    planError,
    armed,
    keepVolume,
    setKeepVolume,
    typed,
    setTyped,
    retryPlan,
    runDestroy,
  };
}
