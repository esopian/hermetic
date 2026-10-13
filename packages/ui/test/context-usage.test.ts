import { describe, expect, test } from "bun:test";
import type { ChatBlockView, ChatUsageView } from "../src/api/types.ts";
import {
  CONTEXT_BAD_PERCENT,
  CONTEXT_WARN_PERCENT,
  contextDetail,
  contextLabel,
  contextLevel,
  frameContext,
  latestContextUsage,
  newerReading,
  usageContext,
} from "../src/chat/context-usage.ts";

describe("contextLevel", () => {
  test("the thresholds are 80 and 95", () => {
    expect(CONTEXT_WARN_PERCENT).toBe(80);
    expect(CONTEXT_BAD_PERCENT).toBe(95);
  });

  test("neutral below the warn line, warn from it, bad from the bad line", () => {
    expect(contextLevel(0)).toBe("neutral");
    expect(contextLevel(79)).toBe("neutral");
    expect(contextLevel(79.9)).toBe("neutral");
    expect(contextLevel(80)).toBe("warn");
    expect(contextLevel(94)).toBe("warn");
    expect(contextLevel(95)).toBe("bad");
    expect(contextLevel(100)).toBe("bad");
  });
});

const usage = (fields: Partial<ChatUsageView>): ChatUsageView => ({
  input_tokens: 1,
  output_tokens: 1,
  cost_usd: null,
  model: "m",
  ...fields,
});

const tick = (payload: unknown): ChatBlockView =>
  ({
    kind: "activity",
    category: "usage",
    key: "usage",
    title: "Current usage",
    state: "running",
    detail: null,
    payload,
  }) as ChatBlockView;

const text: ChatBlockView = { kind: "text", markdown: "hi" };
const T0 = "2026-10-12T08:00:00.000Z";
const T1 = "2026-10-12T09:00:00.000Z";

describe("latestContextUsage", () => {
  test("null when nothing in the thread carries a window", () => {
    expect(latestContextUsage([])).toBeNull();
    expect(
      latestContextUsage([
        { at: T0, usage: null, blocks: [text] },
        { at: T0, usage: usage({}), blocks: [] },
      ]),
    ).toBeNull();
  });

  test("the newest message with a window wins, and a later one without leaves it standing", () => {
    const got = latestContextUsage([
      {
        at: T0,
        usage: usage({ context_used: 10_000, context_max: 200_000, context_percent: 5 }),
        blocks: [],
      },
      {
        at: T0,
        usage: usage({
          context_used: 128_000,
          context_max: 272_000,
          context_percent: 47,
          context_estimated: true,
        }),
        blocks: [],
      },
      { at: T0, usage: null, blocks: [text] },
    ]);
    expect(got).toEqual({ used: 128_000, max: 272_000, percent: 47, estimated: true });
  });

  test("derives the percentage when the usage has none", () => {
    expect(
      latestContextUsage([
        { at: T0, usage: usage({ context_used: 160_000, context_max: 200_000 }), blocks: [] },
      ]),
    ).toEqual({ used: 160_000, max: 200_000, percent: 80, estimated: false });
  });

  test("a live message's newest usage tick answers before the turn completes", () => {
    const got = latestContextUsage([
      {
        at: T0,
        usage: usage({ context_used: 10_000, context_max: 200_000, context_percent: 5 }),
        blocks: [],
      },
      {
        at: T0,
        usage: null,
        blocks: [
          tick({ at: T0, usage: { context_used: 50_000, context_max: 200_000, context_percent: 25 } }),
          text,
          tick({
            usage: {
              context_used: 69_685,
              context_max: 1_048_576,
              context_percent: 7,
              context_estimated: false,
            },
          }),
        ],
      },
    ]);
    expect(got).toEqual({ used: 69_685, max: 1_048_576, percent: 7, estimated: false });
  });

  test("a completed turn's usage outranks the ticks it received while running", () => {
    const got = latestContextUsage([
      {
        at: T0,
        usage: usage({ context_used: 90_000, context_max: 200_000, context_percent: 45 }),
        blocks: [tick({ at: T0, usage: { context_used: 50_000, context_max: 200_000 } })],
      },
    ]);
    expect(got?.used).toBe(90_000);
  });

  test("a malformed tick is skipped, never read as a figure", () => {
    for (const payload of [
      null,
      "x",
      { at: T0, usage: "x" },
      { at: T0, usage: { context_used: "1", context_max: 2 } },
      { at: T0, usage: { context_used: 1, context_max: 0 } },
    ]) {
      expect(latestContextUsage([{ at: T0, usage: null, blocks: [tick(payload)] }])).toBeNull();
    }
  });
});

describe("labels", () => {
  test("a short percentage, marked when estimated, and the exact figures in en-US", () => {
    const exact = { used: 128_000, max: 200_000, percent: 64, estimated: false };
    expect(contextLabel(exact)).toBe("64%");
    expect(contextDetail(exact)).toBe("Context: 128,000 / 200,000 tokens (64%)");
    const rough = { ...exact, estimated: true };
    expect(contextLabel(rough)).toBe("~64%");
    expect(contextDetail(rough)).toBe("Context: about 128,000 / 200,000 tokens (64%)");
  });
});

describe("newerReading", () => {
  const a = { usage: { used: 10, max: 100, percent: 10, estimated: false }, at: T1 };
  const older = { usage: { used: 5, max: 100, percent: 5, estimated: false }, at: T0 };

  test("keeps the newer by time, whichever side it is on", () => {
    expect(newerReading(a, older)).toBe(a);
    expect(newerReading(older, a)).toBe(a);
    expect(newerReading(null, a)).toBe(a);
    expect(newerReading(a, null)).toBe(a);
    expect(newerReading(null, null)).toBeNull();
  });

  test("on a tie the arriving reading wins: two frames can share a millisecond", () => {
    const same = { ...a, usage: { ...a.usage, used: 11 } };
    expect(newerReading(a, same)).toBe(same);
  });
});

describe("frameContext", () => {
  test("a done frame's usage and a usage tick each carry a figure; anything else none", () => {
    expect(
      frameContext(
        { type: "done", seq: 1, message: "m", usage: usage({ context_used: 50, context_max: 100 }) },
        T1,
      ),
    ).toEqual({ usage: { used: 50, max: 100, percent: 50, estimated: false }, at: T1 });
    expect(
      frameContext(
        {
          type: "block",
          seq: 1,
          message: "m",
          block: tick({ usage: { context_used: 1, context_max: 4 } }),
        },
        T1,
      )?.usage.percent,
    ).toBe(25);
    expect(frameContext({ type: "done", seq: 1, message: "m", usage: usage({}) }, T1)).toBeNull();
    expect(frameContext({ type: "delta", seq: 1, message: "m", text: "x" }, T1)).toBeNull();
    expect(frameContext({ type: "block", seq: 1, message: "m", block: text }, T1)).toBeNull();
  });

  test("a gateway percentage is rounded", () => {
    expect(
      latestContextUsage([
        {
          at: T0,
          usage: usage({ context_used: 1, context_max: 3, context_percent: 33.3333 }),
          blocks: [],
        },
      ])?.percent,
    ).toBe(33);
  });
});

describe("usageContext", () => {
  test("a live usage with a window is a figure stamped when it was asked; without one, none", () => {
    const live = usageContext(usage({ context_used: 24_400, context_max: 200_000 }), T0);
    expect(live).toEqual({
      usage: { used: 24_400, max: 200_000, percent: 12, estimated: false },
      at: T0,
    });
    expect(usageContext(usage({ input_tokens: 10 }), T0)).toBeNull();
    expect(usageContext(null, T0)).toBeNull();
    expect(usageContext(undefined, T0)).toBeNull();
  });

  test("a turn frame that arrived after the live read was asked stays the figure", () => {
    // The read was asked at T0 and answered late; the turn's done landed at T1.
    const done = frameContext(
      { type: "done", seq: 1, message: "m", usage: usage({ context_used: 6, context_max: 100 }) },
      T1,
    );
    const live = usageContext(usage({ context_used: 12, context_max: 100 }), T0);
    expect(newerReading(done, live)?.usage.percent).toBe(6);
  });
});
