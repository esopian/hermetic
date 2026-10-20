import { act, renderHook } from "@testing-library/react-native";
import type { TranscriptItem } from "../../src/chat/Transcript.tsx";
import {
  endOffset,
  fromBottom,
  INSET_SETTLE_MS,
  MOMENTUM_GRACE_MS,
  nextFollowing,
  PinController,
  shouldRepin,
} from "../../src/chat/follow.ts";
import { transcriptItems } from "../../src/chat/Transcript.tsx";
import { usePullRefresh } from "../../src/ui/usePullRefresh.ts";
import { useThrottled } from "../../src/ui/useThrottled.ts";
import type { ChatMessage } from "@hermetic/core/chat-client";
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

  test("with the keyboard up, the end is past the content by the bottom inset", () => {
    // KeyboardChatScrollView adds the keyboard's height to the bottom inset:
    // pinning to content − viewport would park the newest line under it.
    expect(endOffset(1000, 600, 300)).toBe(700);
    expect(endOffset(300, 600, 400)).toBe(100);
    // Pinned there, the reader is at the bottom; at the inset-less end they are not.
    expect(
      fromBottom({ offsetY: 700, contentHeight: 1000, viewportHeight: 600, insetBottom: 300 }),
    ).toBe(0);
    expect(
      fromBottom({ offsetY: 400, contentHeight: 1000, viewportHeight: 600, insetBottom: 300 }),
    ).toBe(300);
  });

  test("a growth under the reader's finger or fling does not re-pin", () => {
    expect(shouldRepin({ following: true, dragging: false, momentum: false })).toBe(true);
    expect(shouldRepin({ following: true, dragging: true, momentum: false })).toBe(false);
    expect(shouldRepin({ following: true, dragging: false, momentum: true })).toBe(false);
    expect(shouldRepin({ following: false, dragging: false, momentum: false })).toBe(false);
  });
});

describe("PinController", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function controller() {
    const scrollTo = jest.fn<void, [number, boolean]>();
    const pin = new PinController({ scrollTo, onFollowing: jest.fn() });
    pin.onViewport(600);
    pin.onContentSize(1000);
    scrollTo.mockClear();
    return { pin, scrollTo };
  }

  test("the keyboard's per-frame inset changes re-pin once, to the settled inset", () => {
    const { pin, scrollTo } = controller();
    // KeyboardChatScrollView reports every frame of the keyboard animation;
    // the native whenAtEnd lift is moving the content meanwhile.
    for (const bottom of [40, 120, 210, 280, 300]) {
      pin.onInset(bottom);
      jest.advanceTimersByTime(16);
    }
    expect(scrollTo).not.toHaveBeenCalled();
    jest.advanceTimersByTime(INSET_SETTLE_MS);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // The follow math still counts the inset: the end is past the content by it.
    expect(scrollTo).toHaveBeenCalledWith(endOffset(1000, 600, 300), false);
  });

  test("a settled inset does not re-pin a reader who scrolled away", () => {
    const { pin, scrollTo } = controller();
    pin.dragBegin();
    pin.onScroll({ offsetY: 100, contentHeight: 1000, viewportHeight: 600 });
    pin.dragEnd(0);
    expect(pin.following).toBe(false);
    pin.onInset(300);
    jest.advanceTimersByTime(INSET_SETTLE_MS);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test("a fling whose momentum never begins still catches up the skipped growth", () => {
    const { pin, scrollTo } = controller();
    pin.dragBegin();
    pin.onContentSize(1200); // grew under the finger: not re-pinned
    expect(scrollTo).not.toHaveBeenCalled();
    pin.dragEnd(0.4);
    expect(scrollTo).not.toHaveBeenCalled();
    jest.advanceTimersByTime(MOMENTUM_GRACE_MS);
    expect(scrollTo).toHaveBeenCalledWith(endOffset(1200, 600), false);
  });

  test("a fling whose momentum begins waits for momentum end", () => {
    const { pin, scrollTo } = controller();
    pin.dragBegin();
    pin.onContentSize(1200);
    pin.dragEnd(0.4);
    pin.momentumBegin();
    jest.advanceTimersByTime(MOMENTUM_GRACE_MS * 2);
    expect(scrollTo).not.toHaveBeenCalled();
    pin.momentumEnd();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  test("a pin does not answer the momentum end its own scroll raises", () => {
    // What RCTScrollViewComponentView does with a scrollToOffset that is not
    // animated: UIKit rounds the offset to the pixel grid (3x here), then the
    // view sends a scroll event and a momentum end, with no momentum begin.
    // The requested offset never equals the rounded one, so every pin moved
    // the view and raised the pair again.
    const scrollTo = jest.fn<void, [number, boolean]>();
    let offsetY = 0;
    const pin = new PinController({
      scrollTo: (offset, animated) => {
        scrollTo(offset, animated);
        if (scrollTo.mock.calls.length > 50) return; // the loop, cut short
        if (offset === offsetY) return;
        offsetY = Math.round(offset * 3) / 3;
        pin.onScroll({ offsetY, contentHeight: pin.size.content, viewportHeight: 600 });
        pin.momentumEnd();
      },
      onFollowing: jest.fn(),
    });
    pin.onViewport(600);
    pin.onContentSize(1000.1);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    pin.onContentSize(1200.1);
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith(endOffset(1200.1, 600), false);
    expect(pin.following).toBe(true);
  });

  test("dispose drops pending re-pins", () => {
    const { pin, scrollTo } = controller();
    pin.onInset(300);
    pin.dragBegin();
    pin.dragEnd(0.4);
    pin.dispose();
    jest.advanceTimersByTime(MOMENTUM_GRACE_MS + INSET_SETTLE_MS);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe("PinController: opening a thread", () => {
  // A thread of 20 rows of 100pt in a 600pt viewport, with 16pt of padding
  // below: the end is 2016 − 600.
  const END = 1416;

  function opening(measured: { content: number; viewport: number } | null = null) {
    const scrollTo = jest.fn<void, [number, boolean]>();
    const pin = new PinController({ scrollTo, onFollowing: jest.fn(), measure: () => measured });
    return { pin, scrollTo };
  }

  test("a content size before the viewport is known pins nowhere, rather than past the end", () => {
    // The old pin went to endOffset(2016, 0) = 2016: every row above the
    // viewport, the screen blank until the next growth re-pinned.
    const { pin, scrollTo } = opening();
    pin.onContentSize(2016);
    expect(scrollTo).not.toHaveBeenCalled();
    pin.onViewport(600);
    expect(scrollTo).toHaveBeenLastCalledWith(END, false);
  });

  test("the list's first commit pins to the end from its own layout, before any size is reported", () => {
    const { pin, scrollTo } = opening({ content: 2016, viewport: 600 });
    pin.onCommit();
    expect(scrollTo.mock.calls).toEqual([[END, false]]);
    expect(pin.pinnedY).toBe(END);
  });

  test("FlashList's own first scroll, to the top of the last row, is sent to the end", () => {
    const { pin } = opening({ content: 2016, viewport: 600 });
    // The last row starts at 1900: unclamped, that offset leaves 484pt of the
    // 600pt viewport blank under a 100pt row.
    expect(pin.guard(1900)).toBe(END);
    // A tall last row (its top above the end) would open mid-reply: also the end.
    expect(pin.guard(900)).toBe(END);
  });

  test("once the scroll view reports, its size is the content, and commits no longer pin", () => {
    const { pin, scrollTo } = opening({ content: 2016, viewport: 600 });
    pin.onViewport(600);
    pin.onContentSize(2100);
    expect(scrollTo).toHaveBeenLastCalledWith(1500, false);
    scrollTo.mockClear();
    pin.onCommit();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(pin.guard(1900)).toBe(1500);
  });

  test("the guard lets our own pins through, and leaves a reader who scrolled away alone", () => {
    const { pin, scrollTo } = opening({ content: 2016, viewport: 600 });
    scrollTo.mockImplementation((y) => {
      // Our pin passes through the same scroll view, so through the guard too.
      expect(pin.guard(y)).toBe(y);
    });
    pin.onCommit();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    pin.dragBegin();
    expect(pin.guard(300)).toBe(300);
    pin.onScroll({ offsetY: 300, contentHeight: 2016, viewportHeight: 600 });
    pin.dragEnd(0);
    expect(pin.following).toBe(false);
    expect(pin.guard(300)).toBe(300);
  });

  test("with no layout anywhere yet, nothing is pinned and the guard passes through", () => {
    const { pin, scrollTo } = opening(null);
    pin.onCommit();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(pin.guard(1900)).toBe(1900);
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

  test("only an agent turn directly after an own run answers it", () => {
    const local = msg({ id: "local:x#1", role: "user", at: at(0), text: "hi" });
    // Another bot's message lands between the prompt and a later agent row.
    const other = msg({
      id: "dm-1",
      role: "user",
      at: at(1),
      text: "ping",
      from_bot: { name: "rook", handle: null },
    });
    const later = msg({ id: "b1", role: "bot", at: at(2), text: "unrelated" });
    const items = transcriptItems([local, other, later], null, false, NOW);
    const mine = items.find((i) => i.kind === "turn" && i.mine);
    expect(mine?.kind === "turn" && mine.answered).toBe(false);

    // A run of own messages is answered together by the reply after it.
    const second = msg({ id: "local:x#2", role: "user", at: at(1), text: "and this" });
    const reply = msg({ id: "b2", role: "bot", at: at(2), text: "both" });
    const run = transcriptItems([local, second, reply], null, false, NOW);
    expect(
      run.filter((i) => i.kind === "turn" && i.mine).map((i) => i.kind === "turn" && i.answered),
    ).toEqual([true, true]);
  });

  test("unchanged rows keep their identity across a live delta", () => {
    const history = [
      msg({ id: "u0", role: "user", at: at(-120), text: "look into it" }),
      // A tool step and the prose closing it merge into one row (a fresh merged object per call).
      msg({
        id: "t0",
        at: at(-110),
        blocks: [
          { kind: "tool", name: "terminal", args: { command: "ls" }, status: "ok" },
        ] as ChatMessage["blocks"],
      }),
      msg({ id: "b0", at: at(-100), text: "found it" }),
      msg({ id: "u1", role: "user", at: at(-10), text: "now fix it" }),
    ];
    const live1 = msg({ id: "live-1", at: at(0), text: "on" });
    const first = transcriptItems(history, live1, true, NOW);
    const live2 = { ...live1, blocks: [{ kind: "text", markdown: "on it" }] } as ChatMessage;
    const second = transcriptItems(history, live2, true, NOW, first);

    const turns = (items: TranscriptItem[]) =>
      items.filter((i): i is Extract<TranscriptItem, { kind: "turn" }> => i.kind === "turn");
    const [a, b] = [turns(first), turns(second)];
    expect(a.length).toBe(b.length);
    expect(a.some((i) => i.sources.length > 1)).toBe(true);
    for (let i = 0; i < a.length - 1; i++) {
      expect(b[i]).toBe(a[i]);
      expect(b[i]?.row).toBe(a[i]?.row);
    }
    // The live row itself is new.
    expect(b[b.length - 1]).not.toBe(a[a.length - 1]);
    expect(b[b.length - 1]?.row.message).toBe(live2);
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

  test("a change outside the window renders once, already carrying the new value", async () => {
    const seen: number[] = [];
    const { rerender } = await renderHook(
      ({ v }: { v: number }) => {
        const shown = useThrottled(v, 80);
        seen.push(shown);
        return shown;
      },
      { initialProps: { v: 0 } },
    );
    seen.length = 0;
    await rerender({ v: 1 });
    expect(seen).toEqual([1]);
  });

  test("an `immediate` value skips the window", async () => {
    const isNull = (v: number | null) => v === null;
    const { result, rerender } = await renderHook(
      ({ v }: { v: number | null }) => useThrottled(v, 80, isNull),
      { initialProps: { v: 0 as number | null } },
    );
    await rerender({ v: 1 });
    await rerender({ v: 2 });
    expect(result.current).toBe(1);
    // The turn ended: `live` went null, and it must not linger for the window.
    await rerender({ v: null });
    expect(result.current).toBeNull();
  });
});

describe("usePullRefresh", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("a read that answers at once still holds the spinner for the floor", async () => {
    const read = jest.fn(() => Promise.resolve());
    const { result } = await renderHook(() => usePullRefresh(read, 600));
    await act(async () => {
      result.current.onRefresh();
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.refreshing).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(599);
    });
    expect(result.current.refreshing).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.refreshing).toBe(false);
  });

  test("a failed read still ends the refresh", async () => {
    const { result } = await renderHook(() => usePullRefresh(() => Promise.reject(new Error("x")), 10));
    await act(async () => {
      result.current.onRefresh();
      jest.advanceTimersByTime(10);
    });
    expect(result.current.refreshing).toBe(false);
  });
});
