/**
 * The transcript's first frames, against the real FlashList: rows measured
 * 100pt in a 900pt window (FlashList's own jest measurements), and a scroll
 * view that records every `scrollTo` it receives along with the rows' height
 * FlashList had laid out at that moment. No content size is ever reported
 * (jest has no native layout): exactly the window in which the thread used to
 * open blank, below the last row or past the end entirely.
 */
import type { ChatMessage } from "@hermetic/core/chat-client";
import { act } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PinController } from "../../src/chat/follow.ts";
import { Transcript, transcriptItems } from "../../src/chat/Transcript.tsx";
import { msg } from "../helpers/fixtures.ts";
import { NOW, renderUi, scope } from "../helpers/render.tsx";

type Scroll = { y: number; rows: number };
const scrolls: Scroll[] = [];
const listRef: { current: { getChildContainerDimensions(): { height: number } } | null } = {
  current: null,
};

jest.mock("react-native-keyboard-controller", () => {
  const React = require("react");
  const { ScrollView } = require("react-native");
  const KeyboardChatScrollView = React.forwardRef(
    (props: Record<string, unknown>, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({
        scrollTo: (o: { y?: number }) => {
          if (typeof o?.y === "number")
            scrolls.push({ y: o.y, rows: listRef.current?.getChildContainerDimensions().height ?? -1 });
        },
        scrollToEnd: () => {},
        flashScrollIndicators: () => {},
        getScrollResponder: () => null,
        getScrollableNode: () => null,
        getNativeScrollRef: () => null,
      }));
      return <ScrollView {...props} />;
    },
  );
  return { KeyboardChatScrollView };
});

// The real FlashList, its ref also handed to the test.
jest.mock("@shopify/flash-list", () => {
  const React = require("react");
  const actual = jest.requireActual("@shopify/flash-list");
  const FlashList = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    const inner = React.useRef(null);
    React.useImperativeHandle(ref, () => {
      listRef.current = inner.current;
      return inner.current;
    });
    return <actual.FlashList {...props} ref={inner} />;
  });
  return { ...actual, FlashList };
});

jest.mock("@shopify/flash-list/dist/recyclerview/utils/measureLayout", () => {
  const actual = jest.requireActual("@shopify/flash-list/dist/recyclerview/utils/measureLayout");
  return {
    ...actual,
    measureParentSize: jest.fn(() => ({ x: 0, y: 0, width: 400, height: 900 })),
    measureFirstChildLayout: jest.fn(() => ({ x: 0, y: 0, width: 400, height: 0 })),
    measureItemLayout: jest.fn(() => ({ x: 0, y: 0, width: 400, height: 100 })),
  };
});

const WINDOW = 900;
const PAD_BOTTOM = 16;
/** The end of the content FlashList had laid out: its rows, the bottom padding, less the window. */
const endOf = (rows: number) => Math.max(0, rows + PAD_BOTTOM - WINDOW);

/** `n` turns, alternating, a second apart on one day (one divider row above them). */
function thread(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) =>
    msg({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "bot",
      text: `turn ${i}`,
      at: new Date(NOW - (n - i) * 1000).toISOString(),
    }),
  );
}

function draw(messages: ChatMessage[]) {
  const items = transcriptItems(messages, null, false, NOW);
  return renderUi(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: WINDOW },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <Transcript
        items={items}
        instance="atlas"
        bot="scribe"
        botTitle="Scribe"
        now={NOW}
        activity="idle"
        released={[]}
      />
    </SafeAreaProvider>,
    scope(),
  );
}

let guard: jest.SpyInstance<number, [number]>;
beforeEach(() => {
  scrolls.length = 0;
  listRef.current = null;
  guard = jest.spyOn(PinController.prototype, "guard");
  jest.useFakeTimers();
});
afterEach(() => {
  guard.mockRestore();
  jest.useRealTimers();
});

test("a thread taller than the window opens at its end, before any content size is reported", async () => {
  // Ten turns and the day's divider: eleven rows.
  const messages = thread(10);
  expect(transcriptItems(messages, null, false, NOW)).toHaveLength(11);
  await draw(messages);
  await act(() => jest.runAllTimersAsync());
  expect(scrolls.length).toBeGreaterThan(0);
  // Every scroll that reached the view was the end of the rows laid out then.
  // (The first pass lays out rows not yet measured at an estimate, so the end
  // moves as they are measured; the view is at the end at each step.)
  for (const s of scrolls) expect(s.y).toBe(endOf(s.rows));
  // Settled: eleven measured rows, 1116pt of content, the end at 216.
  expect(scrolls[scrolls.length - 1]).toEqual({ y: 216, rows: 1100 });
  // FlashList did ask, itself, for the top of its last row
  // (`startRenderingFromBottom`), past the end, which would have left most of
  // the window blank; the guard answered each with the end.
  const asked = guard.mock.calls.map(([y]) => y);
  expect(asked.some((y) => y > 216)).toBe(true);
  const furthest = Math.max(...scrolls.map((x) => endOf(x.rows)));
  for (const r of guard.mock.results) expect(r.value).toBeLessThanOrEqual(furthest);
});

test("a long thread opens at its end at every step, with the rows above only estimated", async () => {
  await draw(thread(30));
  await act(() => jest.runAllTimersAsync());
  expect(scrolls.length).toBeGreaterThan(0);
  for (const s of scrolls) expect(s.y).toBe(endOf(s.rows));
});

test("a thread shorter than the window is never scrolled past its end", async () => {
  await draw(thread(4));
  await act(() => jest.runAllTimersAsync());
  for (const s of scrolls) expect(s.y).toBe(0);
});
