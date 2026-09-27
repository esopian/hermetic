/**
 * The window's native minimum size.
 *
 * The objc call is injected, so this runs without `libobjc`, without a window
 * and on any platform: what is worth asserting is the selector and the two
 * doubles that reach it, plus that every way of not having a native window
 * comes back as `false` rather than an exception — the caller reads that
 * `false` as "keep the resize clamp", and a throw would take the app's only
 * window down with it.
 */
import { describe, expect, test } from "bun:test";
import { memoryLog } from "../../src/log.ts";
import { applyMinimumSize, MIN_SIZE_SELECTOR } from "../../src/main/min-size.ts";
import { MIN_FRAME } from "../../src/main/windows.ts";

interface Sent {
  target: number;
  selector: string;
  width: number;
  height: number;
}

describe("applyMinimumSize", () => {
  test("sends setContentMinSize: with MIN_FRAME's two doubles to the window pointer", () => {
    const sent: Sent[] = [];
    const log = memoryLog();
    const applied = applyMinimumSize({
      window: { ptr: 0x1234 },
      size: MIN_FRAME,
      log,
      send: (target, selector, width, height) => sent.push({ target, selector, width, height }),
    });
    expect(applied).toBe(true);
    expect(sent).toEqual([
      {
        target: 0x1234,
        selector: "setContentMinSize:",
        width: MIN_FRAME.width,
        height: MIN_FRAME.height,
      },
    ]);
    // The content minimum, not the frame minimum: `MIN_FRAME` measures the page.
    expect(MIN_SIZE_SELECTOR).toBe("setContentMinSize:");
  });

  test("a window with no native pointer is a warn and a false, not a throw", () => {
    const log = memoryLog();
    let calls = 0;
    const applied = applyMinimumSize({
      window: { ptr: null },
      size: MIN_FRAME,
      log,
      send: () => {
        calls += 1;
      },
    });
    expect(applied).toBe(false);
    expect(calls).toBe(0);
    expect(log.lines.some((line) => line.includes("WARN") && line.includes("no native pointer"))).toBe(
      true,
    );
  });

  test("an objc call that throws is caught, warned with its message, and reported false", () => {
    const log = memoryLog();
    const applied = applyMinimumSize({
      window: { ptr: 7 },
      size: MIN_FRAME,
      log,
      send: () => {
        throw new Error("objc_msgSend exploded");
      },
    });
    expect(applied).toBe(false);
    expect(
      log.lines.some((line) => line.includes("WARN") && line.includes("objc_msgSend exploded")),
    ).toBe(true);
  });
});
