/**
 * The destroy confirmation's state machine (`src/destroy-plan.ts`).
 *
 * The rule under test is one sentence — the Destroy button may only ever apply
 * a plan made for the inputs currently on screen — and every case below is a
 * way that used to be false: no plan yet, a failed read, and a plan for the
 * inputs as they were one checkbox ago.
 */
import { describe, expect, test } from "bun:test";
import type { Plan } from "../src/api/index.ts";
import {
  armedPlan,
  destroyInputsKey,
  isStalePlan,
  shownPlan,
  shownPlanError,
  type DestroyPlanState,
} from "../src/logic/destroy-plan.ts";

const PLAN = { kind: "destroy", target: "lumen" } as unknown as Plan;

const KEY = destroyInputsKey({ fleetId: "fxtr0001", name: "lumen", keepVolume: false });
const WITH_VOLUME = destroyInputsKey({ fleetId: "fxtr0001", name: "lumen", keepVolume: true });
const OTHER_FLEET = destroyInputsKey({ fleetId: "sg7k2m4p", name: "lumen", keepVolume: false });

const planned: DestroyPlanState = { status: "planned", inputs: KEY, plan: PLAN };

describe("destroyInputsKey", () => {
  test("separates fleet, name and options so no two input sets collide", () => {
    expect(KEY).not.toBe(WITH_VOLUME);
    expect(KEY).not.toBe(OTHER_FLEET);
    // `a-b` + `c` must not read as `a` + `b-c`: both halves are [a-z0-9-].
    expect(destroyInputsKey({ fleetId: "a-b", name: "c", keepVolume: false })).not.toBe(
      destroyInputsKey({ fleetId: "a", name: "b-c", keepVolume: false }),
    );
  });

  test("is stable for the same inputs, so a re-render does not invalidate a plan", () => {
    expect(destroyInputsKey({ fleetId: "fxtr0001", name: "lumen", keepVolume: false })).toBe(KEY);
  });

  test("a home with no fleet still keys, rather than colliding on undefined", () => {
    expect(destroyInputsKey({ fleetId: null, name: "lumen", keepVolume: false })).not.toBe(KEY);
  });
});

describe("shownPlan", () => {
  test("draws the plan made for the inputs on screen", () => {
    expect(shownPlan(planned, KEY)).toBe(PLAN);
  });

  test("draws nothing for a plan made for other inputs", () => {
    expect(shownPlan(planned, WITH_VOLUME)).toBeNull();
    expect(shownPlan(planned, OTHER_FLEET)).toBeNull();
  });

  test("draws nothing while the read is in flight, or before the panel opened", () => {
    expect(shownPlan({ status: "planning", inputs: KEY }, KEY)).toBeNull();
    expect(shownPlan({ status: "idle" }, KEY)).toBeNull();
  });
});

describe("shownPlanError", () => {
  test("reports a failed read for the inputs on screen, and only those", () => {
    const failed: DestroyPlanState = { status: "plan_failed", inputs: KEY, error: "offline" };
    expect(shownPlanError(failed, KEY)).toBe("offline");
    expect(shownPlanError(failed, WITH_VOLUME)).toBeNull();
    expect(shownPlanError(planned, KEY)).toBeNull();
  });
});

describe("armedPlan", () => {
  test("returns the plan on screen once the name is typed", () => {
    expect(armedPlan(planned, KEY, true, false)).toBe(PLAN);
  });

  test("stays dead until the name matches", () => {
    expect(armedPlan(planned, KEY, false, false)).toBeNull();
  });

  test("stays dead while another operation is running", () => {
    expect(armedPlan(planned, KEY, true, true)).toBeNull();
  });

  test("stays dead with no plan, a failed plan, or one still in flight", () => {
    expect(armedPlan({ status: "idle" }, KEY, true, false)).toBeNull();
    expect(armedPlan({ status: "planning", inputs: KEY }, KEY, true, false)).toBeNull();
    expect(
      armedPlan({ status: "plan_failed", inputs: KEY, error: "offline" }, KEY, true, false),
    ).toBeNull();
  });

  test("stays dead when the plan on hand belongs to different fleet, agent, or options", () => {
    expect(armedPlan(planned, WITH_VOLUME, true, false)).toBeNull();
    expect(armedPlan(planned, OTHER_FLEET, true, false)).toBeNull();
    expect(
      armedPlan(
        planned,
        destroyInputsKey({ fleetId: "fxtr0001", name: "atlas", keepVolume: false }),
        true,
        false,
      ),
    ).toBeNull();
  });
});

describe("isStalePlan", () => {
  test("recognises core's refusal of a plan whose row moved", () => {
    expect(isStalePlan("PLAN_STALE")).toBe(true);
  });

  /**
   * `CONFLICT` is the one that matters here. The server answers it for a
   * teardown, a foundation update or a fleet switch already running, and core
   * for a lock race and a volume reservation — a busy fleet, not a stale
   * document. Treating it as staleness reopened the panel and sent the operator
   * round again, retyping the agent's name against a server that was going to
   * refuse for the same unrelated reason.
   */
  test("leaves every other failure as a failure, CONFLICT included", () => {
    expect(isStalePlan("CONFLICT")).toBe(false);
    expect(isStalePlan("LOCKED")).toBe(false);
    expect(isStalePlan("RESOURCE_NOT_OWNED")).toBe(false);
    expect(isStalePlan(null)).toBe(false);
    expect(isStalePlan(undefined)).toBe(false);
  });
});
