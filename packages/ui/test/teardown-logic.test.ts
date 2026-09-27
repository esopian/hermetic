import { describe, expect, test } from "bun:test";
import type { TeardownPlan } from "../src/api/index.ts";
import {
  accountMatches,
  canSubmit,
  invalidateOnOptionsChange,
  planHasAgentsExist,
  wordMatches,
} from "../src/logic/teardown-logic.ts";

const OPTIONS = { purge: true, delete_snapshots: false, delete_volumes: false, reset_local: true };

function plan(overrides: Partial<TeardownPlan> = {}): TeardownPlan {
  return {
    kind: "teardown",
    target: "hermetic",
    options: {},
    steps: [{ id: "stack", description: "delete the stack", destructive: true }],
    warnings: [],
    summary: { account_id: "123456789012", region: "us-west-2", fleet_id: "f-1", stack_id: "s-1" },
    ...overrides,
  };
}

describe("accountMatches", () => {
  test("requires exact 12 digits equal to the plan's summary account id", () => {
    expect(accountMatches("123456789012", "123456789012")).toBe(true);
  });

  test("rejects a mismatched id", () => {
    expect(accountMatches("999999999999", "123456789012")).toBe(false);
  });

  test("rejects fewer or more than 12 digits even if a prefix/superset matches", () => {
    expect(accountMatches("12345678901", "12345678901")).toBe(false); // 11 digits
    expect(accountMatches("1234567890123", "1234567890123")).toBe(false); // 13 digits
  });

  test("rejects non-digit input and trims whitespace", () => {
    expect(accountMatches(" 123456789012 ", "123456789012")).toBe(true);
    expect(accountMatches("12345678901a", "12345678901a")).toBe(false);
  });

  test("false when there is no summary account id (no plan / plan failed)", () => {
    expect(accountMatches("123456789012", undefined)).toBe(false);
    expect(accountMatches("123456789012", null)).toBe(false);
    expect(accountMatches("123456789012", "")).toBe(false);
  });
});

describe("wordMatches", () => {
  test("must be exactly the literal word teardown", () => {
    expect(wordMatches("teardown")).toBe(true);
  });

  test("rejects case variants, partial matches, and surrounding text", () => {
    expect(wordMatches("Teardown")).toBe(false);
    expect(wordMatches("TEARDOWN")).toBe(false);
    expect(wordMatches("tear down")).toBe(false);
    expect(wordMatches("teardown ")).toBe(true); // trimmed
    expect(wordMatches(" teardown")).toBe(true); // trimmed
    expect(wordMatches("teardown!")).toBe(false);
    expect(wordMatches("")).toBe(false);
  });
});

describe("invalidateOnOptionsChange", () => {
  test("false when nothing changed", () => {
    expect(invalidateOnOptionsChange(OPTIONS, { ...OPTIONS })).toBe(false);
  });

  test("true when any single flag changes", () => {
    expect(invalidateOnOptionsChange(OPTIONS, { ...OPTIONS, purge: false })).toBe(true);
    expect(invalidateOnOptionsChange(OPTIONS, { ...OPTIONS, delete_snapshots: true })).toBe(true);
    expect(invalidateOnOptionsChange(OPTIONS, { ...OPTIONS, delete_volumes: true })).toBe(true);
    expect(invalidateOnOptionsChange(OPTIONS, { ...OPTIONS, reset_local: false })).toBe(true);
  });
});

describe("planHasAgentsExist", () => {
  test("true when a warning matches the agents-still-exist pattern", () => {
    expect(
      planHasAgentsExist(plan({ warnings: ["3 agent(s) still exist and must be destroyed first"] })),
    ).toBe(true);
  });

  test("false for unrelated warnings or no plan", () => {
    expect(planHasAgentsExist(plan({ warnings: ["Tailscale ACL entries are not removed"] }))).toBe(
      false,
    );
    expect(planHasAgentsExist(null)).toBe(false);
    expect(planHasAgentsExist(undefined)).toBe(false);
  });
});

const BASE_INPUT = {
  stage: 2 as const,
  plan: plan(),
  planLoading: false,
  planError: null,
  agentsExist: false,
  accountTyped: "123456789012",
  wordTyped: "teardown",
};

describe("canSubmit", () => {
  test("true on stage 2 with a clean plan and two matching fields", () => {
    expect(canSubmit(BASE_INPUT)).toBe(true);
  });

  test("false off stage 2 (stage 1 or 3), even with matching fields", () => {
    expect(canSubmit({ ...BASE_INPUT, stage: 1 })).toBe(false);
    expect(canSubmit({ ...BASE_INPUT, stage: 3 })).toBe(false);
  });

  test("false when either typed field does not match", () => {
    expect(canSubmit({ ...BASE_INPUT, accountTyped: "000000000000" })).toBe(false);
    expect(canSubmit({ ...BASE_INPUT, wordTyped: "Teardown" })).toBe(false);
  });

  test("an agents-exist plan can never submit, even if the live agentsExist flag is false", () => {
    const agentsPlan = plan({ warnings: ["2 agent(s) still exist and must be destroyed first"] });
    expect(canSubmit({ ...BASE_INPUT, plan: agentsPlan, agentsExist: false })).toBe(false);
  });

  test("live agentsExist=true can never submit, even with a clean plan", () => {
    expect(canSubmit({ ...BASE_INPUT, agentsExist: true })).toBe(false);
  });

  test("a loading plan can never submit", () => {
    expect(canSubmit({ ...BASE_INPUT, planLoading: true })).toBe(false);
  });

  test("an errored plan can never submit", () => {
    expect(canSubmit({ ...BASE_INPUT, planError: "network error" })).toBe(false);
  });

  test("a missing plan can never submit", () => {
    expect(canSubmit({ ...BASE_INPUT, plan: null })).toBe(false);
  });
});
