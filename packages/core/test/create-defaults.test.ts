/**
 * §4.6 and §8.1: what a create inherits from the fleet, decided in one pure
 * function so that the CLI's "do I prompt for a key?" and core's "where does
 * this key come from?" are the same question asked once.
 */
import { describe, expect, test } from "bun:test";
import { providerKeySource, resolveCreateDefaults } from "../src/render/create-defaults.ts";
import { PROVIDERS, defaultFleetSettings } from "../src/schema/index.ts";
import type { FleetDefaults, FleetSettings } from "../src/schema/index.ts";

const DEFAULTS: FleetDefaults = {
  size: "medium",
  provider: "bedrock",
  volume_gib: 100,
  secrets: "none",
};

function settingsWith(patch: Partial<FleetSettings> = {}): FleetSettings {
  return {
    ...defaultFleetSettings(DEFAULTS, "operator", "2026-09-06T00:00:00.000Z"),
    ...patch,
  };
}

describe("resolveCreateDefaults", () => {
  test("an unnamed provider is the fleet's default", () => {
    const nous = settingsWith({ defaults: { ...DEFAULTS, provider: "nous" } });
    expect(resolveCreateDefaults({}, nous).provider).toBe("nous");
    expect(resolveCreateDefaults({ provider: "anthropic" }, nous).provider).toBe("anthropic");
  });

  /**
   * The precedence the whole feature turns on. Only the first of these is
   * *managed*; everything below it is seeded, and `resolveCreateDefaults` is
   * only ever asked about the seed — `input.hermes.model` never reaches it.
   */
  describe("the seeded model", () => {
    test("falls back to the provider catalog when the fleet overrides nothing", () => {
      expect(resolveCreateDefaults({ provider: "nous" }, settingsWith()).seed_model).toBe(
        PROVIDERS.nous.default_model,
      );
    });

    test("a provider override beats the catalog", () => {
      const s = settingsWith({
        providers: { nous: { enabled: true, default_model: "deepseek-v4-flash-0731" } },
      });
      expect(resolveCreateDefaults({ provider: "nous" }, s).seed_model).toBe("deepseek-v4-flash-0731");
      // …for that provider only. Another one still gets its own catalog default.
      expect(resolveCreateDefaults({ provider: "anthropic" }, s).seed_model).toBe(
        PROVIDERS.anthropic.default_model,
      );
    });

    test("`agent_defaults.model` sits between the two", () => {
      const s = settingsWith({ agent_defaults: { model: "fleet-wide-model" } });
      expect(resolveCreateDefaults({ provider: "nous" }, s).seed_model).toBe("fleet-wide-model");

      const overridden = settingsWith({
        agent_defaults: { model: "fleet-wide-model" },
        providers: { nous: { enabled: true, default_model: "provider-model" } },
      });
      expect(resolveCreateDefaults({ provider: "nous" }, overridden).seed_model).toBe("provider-model");
    });
  });

  test("the seed carries every fleet-wide setting, with the resolved model in it", () => {
    const s = settingsWith({
      agent_defaults: { model: "ignored-here", max_turns: 42, reasoning_effort: "high" },
      providers: { nous: { enabled: true, default_model: "provider-model" } },
    });
    expect(resolveCreateDefaults({ provider: "nous" }, s).seed).toEqual({
      model: "provider-model",
      max_turns: 42,
      reasoning_effort: "high",
    });
  });

  test("a fleet that states nothing seeds only the model", () => {
    expect(resolveCreateDefaults({ provider: "bedrock" }, settingsWith()).seed).toEqual({
      model: PROVIDERS.bedrock.default_model,
    });
  });

  /**
   * The resolution refuses nothing: it is asked by the CLI on a command that
   * may equally be resuming an agent that already exists, and by core before it
   * knows which of the two this is.
   */
  test("a disabled provider still resolves", () => {
    const s = settingsWith({ providers: { nous: { enabled: false } } });
    expect(() => resolveCreateDefaults({ provider: "nous" }, s)).not.toThrow();
    expect(resolveCreateDefaults({ provider: "nous" }, s).provider).toBe("nous");
  });

  /**
   * A provider nobody has written an entry for is enabled with no override —
   * the same rule `FleetSettings.providers` is a `partialRecord` for.
   */
  test("a provider with no settings entry is enabled and un-overridden", () => {
    const s = settingsWith({ providers: {} });
    const resolved = resolveCreateDefaults({ provider: "openrouter" }, s);
    expect(resolved.seed_model).toBe(PROVIDERS.openrouter.default_model);
    expect(resolved.key_source).toBe("prompt");
  });
});

describe("providerKeySource", () => {
  test("a role-authenticated provider needs no key at all", () => {
    expect(providerKeySource("bedrock", settingsWith())).toBe("none");
    // Even one handed a key: bedrock has no slot for it.
    expect(providerKeySource("bedrock", settingsWith(), "sk-FIXTURE")).toBe("input");
  });

  test("a key on the request wins over anything the fleet holds", () => {
    const s = settingsWith({ providers: { nous: { enabled: true, secret: "nous-key" } } });
    expect(providerKeySource("nous", s, "sk-FIXTURE")).toBe("input");
  });

  test("a provider naming a shared slot names it, and never a value", () => {
    const s = settingsWith({ providers: { nous: { enabled: true, secret: "nous-key" } } });
    expect(providerKeySource("nous", s)).toEqual({ shared: "nous-key" });
  });

  test("a keyed provider with no shared slot leaves the head to ask", () => {
    expect(providerKeySource("anthropic", settingsWith())).toBe("prompt");
  });

  test("resolveCreateDefaults reports the same source", () => {
    const s = settingsWith({ providers: { nous: { enabled: true, secret: "nous-key" } } });
    expect(resolveCreateDefaults({ provider: "nous" }, s).key_source).toEqual({
      shared: "nous-key",
    });
    expect(resolveCreateDefaults({ provider: "nous", api_key: "sk-FIXTURE" }, s).key_source).toBe(
      "input",
    );
  });
});
