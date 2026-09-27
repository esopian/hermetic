/**
 * §6.4's managed/seed split, and the third thing that can answer a field: the
 * fleet. `splitHermesSettings` decides which of the two files on the box a
 * setting is written into, and the rule it exists to enforce is that hermetic
 * manages what it was *told* to manage — never what it merely inherited.
 */
import { describe, expect, test } from "bun:test";
import { HERMES_DEFAULTS, splitHermesSettings } from "../src/schema/hermes.ts";

describe("splitHermesSettings", () => {
  test("a stated setting is managed; an unstated one is seeded", () => {
    const { managed, seed } = splitHermesSettings({ model: "stated-model" }, "catalog-model");
    expect(managed).toEqual({ model: "stated-model" });
    expect(seed).toEqual({
      terminal_backend: HERMES_DEFAULTS.terminal_backend,
      max_turns: HERMES_DEFAULTS.max_turns,
      reasoning_effort: HERMES_DEFAULTS.reasoning_effort,
      approvals_mode: HERMES_DEFAULTS.approvals_mode,
    });
  });

  /**
   * `approvals_mode` is the one key statedness does not route: it is seeded
   * whether or not the operator named it. Managed, it would be un-flippable on
   * the box — the managed scope wins over the agent's own config, and
   * `save_config` strips managed leaves, so an agent turning approvals on for
   * itself would be overruled and could not even persist the attempt. What the
   * operator states is the starting position; `seedCommands` re-asserts it when
   * that answer changes.
   */
  test("a stated approvals mode is seeded, never managed", () => {
    const { managed, seed } = splitHermesSettings(
      { model: "stated-model", approvals_mode: "manual" },
      "catalog-model",
    );
    expect(managed).toEqual({ model: "stated-model" });
    expect(seed.approvals_mode).toBe("manual");
  });

  /** A fleet-wide answer arrives by the same door, as every other key does. */
  test("a fleet approvals mode is seeded, and a stated one still wins", () => {
    expect(
      splitHermesSettings(undefined, "catalog-model", { approvals_mode: "smart" }).seed.approvals_mode,
    ).toBe("smart");
    expect(
      splitHermesSettings({ approvals_mode: "off" }, "catalog-model", { approvals_mode: "smart" }).seed
        .approvals_mode,
    ).toBe("off");
  });

  test("nothing stated means hermetic manages nothing", () => {
    const { managed, seed } = splitHermesSettings(null, "catalog-model");
    expect(managed).toEqual({});
    expect(seed.model).toBe("catalog-model");
  });

  /**
   * The fleet's answers reach the seed and only the seed. If one of them could
   * land in `managed`, a fleet-wide default would become a key the agent's own
   * dashboard is forbidden to change — which is the opposite of what a default
   * is.
   */
  test("fleet seed defaults fill unstated fields, and land in the seed", () => {
    const { managed, seed } = splitHermesSettings(undefined, "catalog-model", {
      model: "fleet-model",
      max_turns: 42,
    });
    expect(managed).toEqual({});
    expect(seed.model).toBe("fleet-model");
    expect(seed.max_turns).toBe(42);
    // Whatever the fleet did not state still falls through to the built-ins.
    expect(seed.reasoning_effort).toBe(HERMES_DEFAULTS.reasoning_effort);
    expect(seed.terminal_backend).toBe(HERMES_DEFAULTS.terminal_backend);
  });

  test("a stated field still wins over the fleet's", () => {
    const { managed, seed } = splitHermesSettings({ model: "stated-model" }, "catalog-model", {
      model: "fleet-model",
      max_turns: 42,
    });
    expect(managed).toEqual({ model: "stated-model" });
    expect(seed.model).toBeUndefined();
    expect(seed.max_turns).toBe(42);
  });

  test("an absent seed leaves the catalog default exactly where it was", () => {
    expect(splitHermesSettings({ max_turns: 7 }, "catalog-model")).toEqual(
      splitHermesSettings({ max_turns: 7 }, "catalog-model", undefined),
    );
    expect(splitHermesSettings({ max_turns: 7 }, "catalog-model", null).seed.model).toBe(
      "catalog-model",
    );
  });

  /** Every key is in exactly one of the two files, whatever the fleet says. */
  test("no key is ever in both", () => {
    const { managed, seed } = splitHermesSettings(
      { model: "stated-model", reasoning_effort: "high" },
      "catalog-model",
      { model: "fleet-model", reasoning_effort: "low", max_turns: 42 },
    );
    for (const key of Object.keys(managed)) expect(seed).not.toHaveProperty(key);
    expect([...Object.keys(managed), ...Object.keys(seed)].sort()).toEqual([
      "approvals_mode",
      "max_turns",
      "model",
      "reasoning_effort",
      "terminal_backend",
    ]);
  });
});
