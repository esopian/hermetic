/**
 * The agent drawer's memory chooser, as pure logic: which choices it offers,
 * which it refuses and why — the refusals core's `agents.set` would answer
 * with, said before the request instead of after it.
 */
import { describe, expect, test } from "bun:test";
import { MEMORY_PROVIDERS, MEMORY_PROVIDER_IDS, PROVIDER_IDS } from "@hermetic/core/shared";
import type { AgentView } from "../src/api/index.ts";
import {
  currentMemoryChoice,
  memoryAgentCard,
  memoryCheckGib,
  memoryFit,
  memoryOptions,
  memoryResourceChips,
  memoryUndersized,
  memoryVendorBlock,
  smallestSizeFor,
  memorySwitchesLive,
  memoryUnavailableNote,
  memoryVendorRefusal,
} from "../src/logic/memory-logic.ts";
import { ApiError } from "../src/api/index.ts";
import { saveErrorMessage } from "../src/logic/set-errors.ts";
import { SIZES } from "../src/logic/format.ts";

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
      "prism",
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

describe("memoryFit", () => {
  test("undersized names the smallest size that fits, in the selected size's family", () => {
    expect(memoryFit("hindsight", { sizeId: "xsmall", vendor: "anthropic" })).toEqual({
      state: "undersized",
      message: "Needs size small (16 GiB) or larger. Selected: xsmall (4 GiB)",
      switchTo: "small",
    });
    // gpu-xsmall has 8 GiB, which fits hindsight, but a CPU selection stays CPU.
    expect(memoryFit("hindsight", { sizeId: "micro" }).switchTo).toBe("small");
    expect(memoryFit("openviking", { sizeId: "xxsmall" }).switchTo).toBe("xsmall");
    expect(smallestSizeFor(8)?.id).toBe("small");
    expect(smallestSizeFor(8, "gpu")?.id).toBe("gpu-xsmall");
    expect(smallestSizeFor(4096)).toBeNull();
  });

  test("an explicit memGib wins over the size's, and null skips the size check", () => {
    expect(memoryFit("hindsight", { sizeId: "xsmall", memGib: null, vendor: "anthropic" }).state).toBe(
      "unknown",
    );
    expect(memoryFit("hindsight", { sizeId: "small", memGib: 2 }).state).toBe("undersized");
    expect(memoryFit("hindsight", { memGib: 2 }).message).toBe(
      "Needs size small (16 GiB) or larger. Selected: 2 GiB",
    );
  });

  test("vendor-blocked carries the catalogue's note and offers no size", () => {
    expect(memoryFit("honcho", { sizeId: "medium", vendor: "anthropic" })).toEqual({
      state: "vendor-blocked",
      message: MEMORY_PROVIDERS.honcho.vendors_note as string,
      switchTo: null,
    });
  });

  test("fits, and unknown when a check that could fail has nothing to check against", () => {
    expect(memoryFit("none", {}).state).toBe("fits");
    expect(memoryFit("holographic", {}).state).toBe("fits");
    expect(memoryFit("hindsight", { sizeId: "small", vendor: "anthropic" }).state).toBe("fits");
    expect(memoryFit("honcho", { sizeId: "small", vendor: "openrouter" })).toEqual({
      state: "fits",
      message: null,
      switchTo: null,
    });
    // Honcho serves only some vendors: no vendor yet is not a yes.
    expect(memoryFit("honcho", { sizeId: "small" }).state).toBe("unknown");
    expect(memoryFit("hindsight", { vendor: "anthropic" }).state).toBe("unknown");
  });

  test("agrees with memoryUndersized and memoryVendorBlock on every provider, size and vendor", () => {
    for (const id of MEMORY_PROVIDER_IDS) {
      for (const size of SIZES) {
        for (const vendor of PROVIDER_IDS) {
          const fit = memoryFit(id, { sizeId: size.id, vendor });
          const expected = memoryUndersized(id, size.memGib)
            ? "undersized"
            : memoryVendorBlock(id, vendor) !== null
              ? "vendor-blocked"
              : "fits";
          expect(`${id}/${size.id}/${vendor}: ${fit.state}`).toBe(
            `${id}/${size.id}/${vendor}: ${expected}`,
          );
          if (fit.switchTo !== null) {
            const target = SIZES.find((s) => s.id === fit.switchTo);
            expect(target?.family).toBe(size.family);
            expect(memoryUndersized(id, target?.memGib ?? 0)).toBe(false);
          }
        }
      }
    }
  });
});

describe("memoryResourceChips", () => {
  test("the RAM floor names the smallest CPU size that meets it", () => {
    const floor = (c: Parameters<typeof memoryResourceChips>[0]) =>
      memoryResourceChips(c).find((f) => f.key === "ram_floor")?.value;
    expect(floor("hindsight")).toBe("≥ 8 GiB (small+)");
    expect(floor("openviking")).toBe("≥ 4 GiB (xsmall+)");
    expect(floor("holographic")).toBe("any size");
    expect(floor("none")).toBe("—");
  });
});

describe("memoryUnavailableNote", () => {
  test("names the vendors a provider cannot serve, from the catalogue, and only for those", () => {
    const honcho = MEMORY_PROVIDERS.honcho;
    const excluded = PROVIDER_IDS.filter((v) => !honcho.vendors.includes(v)).sort();
    expect(excluded.length).toBeGreaterThan(0);
    expect(memoryUnavailableNote("honcho")).toBe(
      `Not available for ${excluded.join(" / ")} agents: no embeddings API`,
    );
    for (const id of MEMORY_PROVIDER_IDS) {
      if (MEMORY_PROVIDERS[id].vendors_note === undefined) expect(memoryUnavailableNote(id)).toBeNull();
    }
  });
});

describe("memoryAgentCard", () => {
  test("the card's fit refuses exactly what the chooser disables, on every agent shape", () => {
    const shapes: AgentView[] = [
      agent(),
      agent({ provider: "bedrock" }),
      agent({ provider: "openrouter" }),
      agent({ provider: "openrouter", pending: { provider: "anthropic" } as AgentView["pending"] }),
      agent({ size: "xxsmall", instance_type: "t4g.small" }),
      agent({ size: "xxsmall", instance_type: "m8g.xlarge" }),
      agent({ provider: undefined } as Partial<AgentView>),
      agent({ memory: { provider: "honcho" } } as Partial<AgentView>),
    ];
    for (const a of shapes) {
      for (const o of memoryOptions(a)) {
        const { fit } = memoryAgentCard(o.value, a);
        const refused = fit !== null && (fit.state === "undersized" || fit.state === "vendor-blocked");
        expect([a.size, a.provider, o.value, refused]).toEqual([
          a.size,
          a.provider,
          o.value,
          o.disabled,
        ]);
      }
    }
  });

  test("the vendor is the refusing one, else the one the agent runs after the rollout", () => {
    const staged = agent({
      provider: "openrouter",
      pending: { provider: "anthropic" } as AgentView["pending"],
    });
    expect(memoryAgentCard("honcho", staged).vendor).toBe("anthropic");
    expect(memoryAgentCard("honcho", staged).fit?.state).toBe("vendor-blocked");
    const toOpenrouter = agent({
      provider: "bedrock",
      pending: { provider: "openrouter" } as AgentView["pending"],
    });
    // Bedrock refuses Honcho now; the staged vendor would not, but core checks both.
    expect(memoryAgentCard("honcho", toOpenrouter).vendor).toBe("bedrock");
    expect(memoryAgentCard("openviking", toOpenrouter).vendor).toBe("openrouter");
    expect(memoryAgentCard("openviking", agent({ provider: "bedrock" })).vendor).toBe("bedrock");
  });

  test("the current choice has no fit: choosing it is no change", () => {
    const small = agent({
      size: "xxsmall",
      instance_type: "t4g.small",
      memory: { provider: "hindsight" },
    } as Partial<AgentView>);
    expect(memoryAgentCard("hindsight", small).fit).toBeNull();
    expect(memoryAgentCard("none", agent()).fit).toBeNull();
    expect(memoryAgentCard("hindsight", agent()).fit?.state).toBe("fits");
  });
});
