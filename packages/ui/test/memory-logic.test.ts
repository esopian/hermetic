/**
 * The agent drawer's memory chooser, as pure logic: which choices it offers,
 * which it refuses and why — the refusals core's `agents.set` would answer
 * with, said before the request instead of after it.
 */
import { describe, expect, test } from "bun:test";
import { MEMORY_PROVIDERS } from "@hermetic/core/shared";
import type { AgentView } from "../src/api/index.ts";
import {
  currentMemoryChoice,
  memoryCheckGib,
  memoryChoiceHint,
  memoryOptions,
  memorySwitchesLive,
  memoryVendorRefusal,
} from "../src/logic/memory-logic.ts";
import { ApiError } from "../src/api/index.ts";
import { saveErrorMessage } from "../src/logic/set-errors.ts";

function agent(over: Partial<AgentView> = {}): AgentView {
  return {
    name: "lumen",
    size: "small",
    instance_type: "r8g.large",
    provider: "anthropic",
    memory: null,
    pending: null,
    ...over,
  } as AgentView;
}

const byValue = (a: AgentView) => new Map(memoryOptions(a).map((o) => [o.value, o]));

describe("memoryOptions", () => {
  test("none first, then every provider; the current one is marked and never disabled", () => {
    const opts = memoryOptions(agent({ memory: { provider: "holographic" } } as Partial<AgentView>));
    expect(opts.map((o) => o.value)).toEqual([
      "none",
      "holographic",
      "hindsight",
      "openviking",
      "honcho",
    ]);
    const current = opts.filter((o) => o.current);
    expect(current.map((o) => o.value)).toEqual(["holographic"]);
    expect(current[0]?.label).toBe("Holographic (local) · current");
    expect(current[0]?.disabled).toBe(false);
    expect(currentMemoryChoice(agent())).toBe("none");
  });

  test("a size too small for a server disables it, naming the memory it needs", () => {
    const o = byValue(agent({ size: "xxsmall", instance_type: "t4g.small" }));
    expect(o.get("hindsight")?.disabled).toBe(true);
    expect(o.get("hindsight")?.label).toBe(
      `${MEMORY_PROVIDERS.hindsight.label} — needs ≥ ${String(MEMORY_PROVIDERS.hindsight.min_mem_gib)} GiB`,
    );
    expect(o.get("hindsight")?.reason).toContain("xxsmall has 2 GiB");
    expect(o.get("holographic")?.disabled).toBe(false);
  });

  test("an explicit instance type is not held to its size's memory, as core does not hold it", () => {
    const a = agent({ size: "xxsmall", instance_type: "r8g.xlarge" });
    expect(memoryCheckGib(a)).toBeNull();
    expect(byValue(a).get("hindsight")?.disabled).toBe(false);
    expect(memoryCheckGib(agent({ size: "xxsmall", instance_type: "t4g.small" }))).toBe(2);
    expect(memoryCheckGib(agent({ size: undefined } as Partial<AgentView>))).toBeNull();
  });

  test("a vendor the provider cannot call through disables it, the running one or a staged one", () => {
    expect(byValue(agent()).get("honcho")?.label).toBe(
      `${MEMORY_PROVIDERS.honcho.label} — not for anthropic`,
    );
    expect(byValue(agent()).get("honcho")?.disabled).toBe(true);
    expect(byValue(agent({ provider: "openrouter" })).get("honcho")?.disabled).toBe(false);

    // Running on openrouter, but an anthropic profile is staged: the switch
    // rolls out with it, so Honcho would be refused after the same apply.
    const staged = agent({
      provider: "openrouter",
      pending: { provider: "anthropic" } as AgentView["pending"],
    });
    expect(memoryVendorRefusal("honcho", staged)?.vendor).toBe("anthropic");
    expect(byValue(staged).get("honcho")?.disabled).toBe(true);
  });
});

test("the hint is the provider's summary and tags, or the built-in answer", () => {
  expect(memoryChoiceHint("none")).toContain("built-in");
  expect(memoryChoiceHint("hindsight")).toContain(MEMORY_PROVIDERS.hindsight.summary);
  expect(memoryChoiceHint("hindsight")).toContain("Runs on the box");
});

test("saveErrorMessage keeps core's code in front of a memory refusal", () => {
  expect(saveErrorMessage(new ApiError("MEMORY_PROVIDER_UNDERSIZED", "too small"))).toBe(
    "MEMORY_PROVIDER_UNDERSIZED · too small",
  );
  expect(saveErrorMessage(new ApiError("CONFLICT", "v7"))).toContain("reload before saving again");
  expect(saveErrorMessage(new ApiError("INTERNAL", "boom"))).toBe("boom");
});

test("a switch applies live only where core's rollout converges: ready, degraded, error", () => {
  const live = (status: string) =>
    memorySwitchesLive({ status, display_status: status } as Pick<
      AgentView,
      "status" | "display_status"
    >);
  expect(["ready", "degraded", "error"].every(live)).toBe(true);
  expect(["creating", "bootstrapping", "stopping", "stopped", "destroyed"].some(live)).toBe(false);
});
