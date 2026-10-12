import { describe, expect, test } from "bun:test";
import { mapUsage } from "../src/chat/hermes/hermes-chat-blocks.ts";
import { ChatUsage } from "../src/schema/index.ts";

describe("mapUsage context window", () => {
  test("keeps the gateway's context figures alongside the token counts", () => {
    const usage = mapUsage({
      input: 120_000,
      output: 40,
      context_used: 128_000,
      context_max: 272_000,
      context_percent: 47,
      context_estimated: true,
      context_source: "local_estimate",
    });
    expect(usage).toEqual({
      input_tokens: 120_000,
      output_tokens: 40,
      cost_usd: null,
      model: null,
      context_used: 128_000,
      context_max: 272_000,
      context_percent: 47,
      context_estimated: true,
    });
    expect(ChatUsage.parse(usage)).toEqual(usage!);
  });

  test("derives the percentage when upstream sent none", () => {
    const usage = mapUsage({ context_used: 150_000, context_max: 200_000 });
    expect(usage?.context_percent).toBe(75);
    expect(usage?.context_estimated).toBeUndefined();
  });

  test("rounds a fractional percentage from upstream", () => {
    expect(
      mapUsage({ context_used: 1, context_max: 3, context_percent: 33.3333 })?.context_percent,
    ).toBe(33);
  });

  test("clamps an out-of-range percentage", () => {
    expect(mapUsage({ context_used: 210_000, context_max: 200_000 })?.context_percent).toBe(100);
    expect(mapUsage({ context_used: 1, context_max: 2, context_percent: 140 })?.context_percent).toBe(
      100,
    );
  });

  test("drops the pair when either half is missing, not a number, or the window is zero", () => {
    for (const raw of [
      { context_used: 100 },
      { context_max: 200_000 },
      { context_used: "100", context_max: 200_000 },
      { context_used: 100, context_max: 0 },
      { context_used: Number.NaN, context_max: 200_000 },
    ]) {
      const usage = mapUsage({ input: 5, ...raw });
      expect(usage).not.toHaveProperty("context_used");
      expect(usage).not.toHaveProperty("context_max");
      expect(usage).not.toHaveProperty("context_percent");
    }
  });

  test("old usage without context fields still parses", () => {
    expect(
      ChatUsage.parse({ input_tokens: 1, output_tokens: 2, cost_usd: null, model: "m" }),
    ).toBeTruthy();
  });
});
