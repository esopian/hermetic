/**
 * The owned-key boundary (#53, §6.4): the leaves of the managed file are what
 * hermetic owns, and the drift check compares those and nothing else.
 */
import { describe, expect, test } from "bun:test";
import { hermesConfigLeaves, hermesOwnedDrift } from "@hermetic/core/shared";
import { hermesManagedConfig, hermesOwnedKeys } from "../src/render/render-hermes.ts";
import { renderAgentConfig, type RenderInput } from "../src/render/render.ts";

function testRenderInput(over: Partial<RenderInput>): RenderInput {
  return {
    name: "atlas",
    size: "small",
    provider: "bedrock",
    secrets_mode: "none",
    tailnet: "hermetic.ts.net",
    hermes_version: "0.15.0",
    hermes_ref: "v2026.8.31",
    chrome_ref: "153.0.8010.12",
    region: "us-west-2",
    ...over,
  };
}

describe("hermesConfigLeaves", () => {
  test("reads hermetic's block mappings as dotted leaves, unquoting strings", () => {
    const yaml = [
      "# a comment",
      "model:",
      '  provider: "custom:nous"',
      "providers:",
      "  nous:",
      '    base_url: "https://x.example/v1"',
      '    key_env: "NOUS_API_KEY"',
      "updates:",
      "  check: false",
      "command_allowlist:",
      '  - "apt *"',
      'quoted: "a \\"b\\" \\\\ c"',
      "",
    ].join("\n");
    expect(hermesConfigLeaves(yaml)).toEqual({
      "model.provider": "custom:nous",
      "providers.nous.base_url": "https://x.example/v1",
      "providers.nous.key_env": "NOUS_API_KEY",
      "updates.check": "false",
      quoted: 'a "b" \\ c',
    });
  });

  test("reads a long run of whitespace in linear time", () => {
    const tabs = "\t".repeat(50_000);
    for (const line of [`${tabs}!`, `a${tabs}!`]) {
      const start = performance.now();
      expect(hermesConfigLeaves(line)).toEqual({});
      expect(performance.now() - start).toBeLessThan(200);
    }
  });

  test("keeps a key's trailing whitespace and a CRLF value out of the leaves", () => {
    expect(hermesConfigLeaves("a :  b  \nc:d\ne:\r\n  f: g\r\nh: i")).toEqual({ a: "b", h: "i" });
  });
});

describe("hermesOwnedDrift", () => {
  const owned = { "model.provider": "bedrock", "agent.max_turns": "600" };
  const clean = 'model:\n  provider: "bedrock"\nagent:\n  max_turns: 600\n';

  test("drift on an owned key is reported", () => {
    const moved = 'model:\n  provider: "openrouter"\nagent:\n  max_turns: 600\n';
    expect(hermesOwnedDrift(owned, moved)).toEqual([
      { key: "model.provider", expected: "bedrock", found: "openrouter" },
    ]);
  });

  test("a change to a key hermetic does not own is not reported", () => {
    expect(hermesOwnedDrift(owned, clean)).toEqual([]);
    const extra = clean + 'model_extra:\n  x: 1\nterminal:\n  backend: "docker"\n';
    expect(hermesOwnedDrift(owned, extra)).toEqual([]);
  });
});

describe("hermesOwnedKeys", () => {
  const base = testRenderInput({ provider: "anthropic" });

  test("is every leaf of the managed file, with the value rendered there", () => {
    expect(hermesOwnedKeys(base)).toEqual(hermesConfigLeaves(hermesManagedConfig(base)));
    expect(hermesOwnedKeys(base)["model.provider"]).toBe("anthropic");
    expect(hermesOwnedKeys(base)["updates.check"]).toBe("false");
  });

  /** A seeded model is the agent's; a held one is hermetic's. */
  test("owns the model only when it is held", () => {
    const seeded: RenderInput = { ...base, hermes: { model: "m-1" }, hermes_hold: [] };
    expect(hermesOwnedKeys(seeded)).not.toHaveProperty("model.default");
    const held: RenderInput = { ...seeded, hermes_hold: ["model"] };
    expect(hermesOwnedKeys(held)["model.default"]).toBe("m-1");
  });

  test("never owns a seed-only or seeded key", () => {
    const keys = Object.keys(
      hermesOwnedKeys({ ...base, hermes: { max_turns: 9, approvals_mode: "smart" }, hermes_hold: [] }),
    );
    expect(keys).not.toContain("agent.max_turns");
    expect(keys).not.toContain("approvals.mode");
    expect(keys).not.toContain("command_allowlist");
  });

  test("is recorded in the manifest, outside config_hash", () => {
    const out = renderAgentConfig(base);
    expect(out.manifest.hermes_owned).toEqual(hermesOwnedKeys(base));
  });
});
