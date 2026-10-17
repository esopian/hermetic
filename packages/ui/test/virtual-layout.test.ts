/**
 * The virtualized transcript's layout math (`virtual/virtual-layout.ts`):
 * estimates, offsets, the mounted window, measurement deltas, and how far the
 * row in view moves when rows are inserted or removed above it.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_ROW_ESTIMATE_PX, VirtualLayout } from "../src/chat/virtual/virtual-layout.ts";

const keys = (n: number, prefix = "r") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function layoutOf(n: number, estimate = 100): VirtualLayout {
  const layout = new VirtualLayout(estimate);
  layout.setKeys(keys(n));
  return layout;
}

describe("estimates and offsets", () => {
  test("an unmeasured row is the estimate, 96px by default", () => {
    const layout = new VirtualLayout();
    layout.setKeys(keys(3));
    expect(DEFAULT_ROW_ESTIMATE_PX).toBe(96);
    expect(layout.heightOf("r1")).toBe(96);
    expect(layout.offsetOf("r2")).toBe(192);
    expect(layout.totalHeight()).toBe(288);
  });

  test("a measured row replaces its estimate in every later offset", () => {
    const layout = layoutOf(4);
    layout.applyMeasurement("r1", 250);
    expect(layout.offsetOf("r1")).toBe(100);
    expect(layout.offsetOf("r2")).toBe(350);
    expect(layout.totalHeight()).toBe(550);
    expect(layout.isMeasured("r1")).toBe(true);
    expect(layout.isMeasured("r2")).toBe(false);
  });

  test("changing the estimate moves only unmeasured rows", () => {
    const layout = layoutOf(3);
    layout.applyMeasurement("r0", 40);
    layout.setEstimate(50);
    expect(layout.offsetOf("r2")).toBe(90);
  });

  test("an unknown key has no offset; an empty layout has no height", () => {
    const layout = new VirtualLayout();
    expect(layout.offsetOf("nope")).toBeNull();
    expect(layout.totalHeight()).toBe(0);
    expect(layout.indexAt(10)).toBe(-1);
  });

  test("indexAt finds the containing row and clamps at both ends", () => {
    const layout = layoutOf(5);
    expect(layout.indexAt(-30)).toBe(0);
    expect(layout.indexAt(0)).toBe(0);
    expect(layout.indexAt(99.5)).toBe(0);
    expect(layout.indexAt(100)).toBe(1);
    expect(layout.indexAt(10_000)).toBe(4);
  });
});

describe("window", () => {
  test("the viewport plus overscan on both sides, with pads for the rest", () => {
    const layout = layoutOf(100);
    // Viewport 2000..2300, overscan 100: rows touching 1900..2400.
    expect(layout.window(2000, 300, 100)).toEqual({
      start: 19,
      end: 25,
      topPad: 1900,
      bottomPad: 7500,
    });
  });

  test("at the top the overscan above is cut off", () => {
    const layout = layoutOf(100);
    expect(layout.window(0, 300, 100)).toEqual({ start: 0, end: 5, topPad: 0, bottomPad: 9500 });
  });

  test("past the end the last rows are mounted", () => {
    const layout = layoutOf(10);
    const range = layout.window(5000, 300, 0);
    expect(range.end).toBe(10);
    expect(range.start).toBe(9);
    expect(range.bottomPad).toBe(0);
  });

  test("an empty list mounts nothing", () => {
    expect(new VirtualLayout().window(0, 500, 100)).toEqual({
      start: 0,
      end: 0,
      topPad: 0,
      bottomPad: 0,
    });
  });

  test("measured heights move the window", () => {
    const layout = layoutOf(100);
    for (let i = 0; i < 10; i++) layout.applyMeasurement(`r${i}`, 300);
    // Rows 0..9 now span 0..3000.
    expect(layout.window(2950, 100, 0)).toMatchObject({ start: 9, end: 11, topPad: 2700 });
  });

  test("segments: the window between a top and a bottom pad", () => {
    const layout = layoutOf(10);
    expect(layout.segments(layout.window(300, 200, 0))).toEqual([
      { kind: "pad", at: "top", start: 0, end: 3, height: 300 },
      { kind: "rows", start: 3, end: 6 },
      { kind: "pad", at: "bottom", start: 6, end: 10, height: 400 },
    ]);
  });

  test("segments: a held row outside the window gets its own run and a gap pad", () => {
    const layout = layoutOf(10);
    const range = layout.window(500, 200, 0); // rows 5..7
    expect(layout.segments(range, [1, 6, 99, -1])).toEqual([
      { kind: "pad", at: "top", start: 0, end: 1, height: 100 },
      { kind: "rows", start: 1, end: 2 },
      { kind: "pad", at: "gap", start: 2, end: 5, height: 300 },
      { kind: "rows", start: 5, end: 8 },
      { kind: "pad", at: "bottom", start: 8, end: 10, height: 200 },
    ]);
    // Adjacent to the window: one run, no gap.
    expect(layout.segments(range, [8])).toEqual([
      { kind: "pad", at: "top", start: 0, end: 5, height: 500 },
      { kind: "rows", start: 5, end: 9 },
      { kind: "pad", at: "bottom", start: 9, end: 10, height: 100 },
    ]);
  });

  test("segments of an empty list are two empty pads", () => {
    const layout = new VirtualLayout();
    expect(layout.segments(layout.window(0, 300, 0))).toEqual([
      { kind: "pad", at: "top", start: 0, end: 0, height: 0 },
      { kind: "pad", at: "bottom", start: 0, end: 0, height: 0 },
    ]);
  });
});

describe("applyMeasurement", () => {
  test("returns the delta from the estimate, then from the last measurement", () => {
    const layout = layoutOf(3);
    expect(layout.applyMeasurement("r1", 140).delta).toBe(40);
    expect(layout.applyMeasurement("r1", 120).delta).toBe(-20);
    expect(layout.applyMeasurement("r1", 120).delta).toBe(0);
  });

  test("above: only rows wholly above the row at scrollTop", () => {
    const layout = layoutOf(10);
    // scrollTop 450 sits in r4 (400..500).
    expect(layout.applyMeasurement("r2", 150, 450)).toEqual({ delta: 50, above: true });
    // r2 grew, so scrollTop 450 now sits in r5 (450..550): the row at the top
    // is not above itself.
    expect(layout.applyMeasurement("r5", 200, 450)).toEqual({ delta: 100, above: false });
    expect(layout.applyMeasurement("r7", 50, 450)).toEqual({ delta: -50, above: false });
    expect(layout.applyMeasurement("r0", 120)).toEqual({ delta: 20, above: false });
  });

  test("an unknown key or an invalid height changes nothing", () => {
    const layout = layoutOf(3);
    expect(layout.applyMeasurement("zz", 50)).toEqual({ delta: 0, above: false });
    expect(layout.applyMeasurement("r0", Number.NaN)).toEqual({ delta: 0, above: false });
    expect(layout.applyMeasurement("r0", -1)).toEqual({ delta: 0, above: false });
    expect(layout.totalHeight()).toBe(300);
  });
});

describe("measuredMean", () => {
  test("tracks re-measurements and evictions", () => {
    const layout = layoutOf(4);
    expect(layout.measuredMean()).toBeNull();
    layout.applyMeasurement("r0", 100);
    layout.applyMeasurement("r1", 300);
    expect(layout.measuredMean()).toBe(200);
    layout.applyMeasurement("r1", 500);
    expect(layout.measuredMean()).toBe(300);
    expect(layout.measuredCount).toBe(2);
    layout.setKeys(["r0", "r2", "r3"]);
    expect(layout.measuredMean()).toBe(100);
    expect(layout.measuredCount).toBe(1);
  });
});

describe("setKeys", () => {
  test("the same list again is not a change", () => {
    const layout = layoutOf(5);
    expect(layout.setKeys(keys(5), "r2")).toEqual({
      changed: false,
      prepended: 0,
      prependShift: 0,
      shift: 0,
      evicted: 0,
      added: [],
    });
  });

  test("prepend: the compensation is the new rows' heights", () => {
    const layout = layoutOf(5);
    layout.applyMeasurement("r3", 180);
    const sync = layout.setKeys([...keys(3, "p"), ...keys(5)], "r3");
    expect(sync).toMatchObject({ changed: true, prepended: 3, prependShift: 300, shift: 300 });
    expect(sync.added).toEqual(["p0", "p1", "p2"]);
    // The kept measurement survived the move.
    expect(layout.heightOf("r3")).toBe(180);
    expect(layout.offsetOf("r3")).toBe(600);
  });

  test("an append moves nothing above it", () => {
    const layout = layoutOf(5);
    const sync = layout.setKeys(keys(8), "r2");
    expect(sync).toMatchObject({ changed: true, prepended: 0, shift: 0, evicted: 0 });
    expect(sync.added).toEqual(["r5", "r6", "r7"]);
  });

  test("the first load is not a prepend", () => {
    const layout = new VirtualLayout(100);
    expect(layout.setKeys(keys(4), null)).toMatchObject({ changed: true, prepended: 0, shift: 0 });
  });

  test("removed keys are evicted with their heights", () => {
    const layout = layoutOf(5);
    layout.applyMeasurement("r1", 300);
    const sync = layout.setKeys(["r0", "r2", "r3", "r4"], "r3");
    expect(sync).toMatchObject({ changed: true, evicted: 1, shift: -300 });
    expect(layout.has("r1")).toBe(false);
    // A key that comes back starts from the estimate.
    layout.setKeys(keys(5));
    expect(layout.isMeasured("r1")).toBe(false);
  });

  test("a removed anchor hands over to the next surviving row", () => {
    const layout = layoutOf(6);
    const sync = layout.setKeys(["r0", "r1", "r4", "r5"], "r2");
    // r4 was at 400 and is now at 200.
    expect(sync.shift).toBe(-200);
  });

  test("no anchor, or nothing survives after it: no shift", () => {
    const layout = layoutOf(4);
    expect(layout.setKeys(keys(4, "x"), "r1").shift).toBe(0);
    expect(layout.setKeys([...keys(2, "p"), ...keys(4, "x")]).shift).toBe(0);
  });
});
