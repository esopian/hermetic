import { act, renderHook } from "@testing-library/react-native";
import { endOffset, fromBottom, nextFollowing } from "../../src/chat/follow.ts";
import { transcriptItems } from "../../src/chat/Transcript.tsx";
import { useThrottled } from "../../src/ui/useThrottled.ts";
import { msg } from "../helpers/fixtures.ts";
import { NOW } from "../helpers/render.tsx";

// The transcript module imports the keyboard-aware scroll view, which needs its native half.
jest.mock("react-native-keyboard-controller", () => require("react-native-keyboard-controller/jest"));

describe("following the live end", () => {
  test("at the bottom always follows", () => {
    expect(nextFollowing({ following: false, atBottom: true, offsetY: 0, pinnedY: null })).toBe(true);
  });

  test("a scroll at or past the last pin keeps following; above it stops", () => {
    // Content grew after our pin: the event reports "not at the bottom" at the pinned offset.
    expect(nextFollowing({ following: true, atBottom: false, offsetY: 500, pinnedY: 500 })).toBe(true);
    expect(nextFollowing({ following: true, atBottom: false, offsetY: 499.5, pinnedY: 500 })).toBe(
      true,
    );
    expect(nextFollowing({ following: true, atBottom: false, offsetY: 420, pinnedY: 500 })).toBe(false);
  });

  test("once off, only reaching the bottom turns it back on", () => {
    expect(nextFollowing({ following: false, atBottom: false, offsetY: 900, pinnedY: 500 })).toBe(
      false,
    );
    expect(nextFollowing({ following: true, atBottom: false, offsetY: 900, pinnedY: null })).toBe(
      false,
    );
  });

  test("offsets", () => {
    expect(fromBottom({ offsetY: 100, contentHeight: 1000, viewportHeight: 600 })).toBe(300);
    expect(endOffset(1000, 600)).toBe(400);
    expect(endOffset(300, 600)).toBe(0);
  });
});

describe("transcriptItems", () => {
  const at = (s: number) => new Date(NOW + s * 1000).toISOString();

  test("an own message still in flight says so until a reply follows it", () => {
    const local = msg({ id: "local:x#1", role: "user", at: at(0), text: "hi" });
    const alone = transcriptItems([msg({ id: "b0", at: at(-60) }), local], null, true, NOW);
    const mine = alone.filter((i) => i.kind === "turn" && i.mine);
    expect(mine.map((i) => i.kind === "turn" && i.answered)).toEqual([false]);

    const live = msg({ id: "live-1", at: at(1), text: "on it" });
    const replied = transcriptItems([local], live, true, NOW);
    const turn = replied.find((i) => i.kind === "turn" && i.mine);
    expect(turn?.kind === "turn" && turn.answered).toBe(true);
  });
});

describe("useThrottled", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("leading edge at once, a burst lands as its last value when the window closes", async () => {
    const { result, rerender } = await renderHook(({ v }: { v: number }) => useThrottled(v, 80), {
      initialProps: { v: 0 },
    });
    expect(result.current).toBe(0);
    await rerender({ v: 1 });
    expect(result.current).toBe(1);
    await rerender({ v: 2 });
    await rerender({ v: 3 });
    expect(result.current).toBe(1);
    await act(async () => {
      jest.advanceTimersByTime(80);
    });
    expect(result.current).toBe(3);
  });
});
