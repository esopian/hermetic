/**
 * `VirtualLog` (`chat/virtual/VirtualLog.tsx`) against happy-dom.
 *
 * happy-dom does no layout, so the log's own degrade mode is what a transcript
 * test sees by default: every row, no spacers. The windowing tests force a
 * viewport through the component's `viewport` seam, feed row heights through a
 * fake `ResizeObserver`, and stub `scrollHeight` where pinning is asserted.
 * Every row is estimated at 100px and overscan is 100px, so the arithmetic in
 * the expectations is plain.
 */
import { act, cleanup, fireEvent, render } from "./dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { StrictMode, createRef, useRef } from "react";
import type { RefObject } from "react";
import type { Pin } from "../src/chat/stick-to-bottom.ts";
import { VirtualLog } from "../src/chat/virtual/VirtualLog.tsx";
import type { VirtualLogHandle, VirtualRangeReport } from "../src/chat/virtual/VirtualLog.tsx";

class FakeResizeObserver {
  static live = new Set<FakeResizeObserver>();
  readonly observed = new Set<Element>();
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.live.add(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.observed.clear();
    FakeResizeObserver.live.delete(this);
  }
}

/** Report new border-box heights for the observed rows named in `heights`. */
function resize(heights: Record<string, number>): void {
  for (const observer of FakeResizeObserver.live) {
    const entries: ResizeObserverEntry[] = [];
    for (const el of observer.observed) {
      const key = el instanceof HTMLElement ? el.dataset.vrow : undefined;
      const height = key === undefined ? undefined : heights[key];
      if (height === undefined) continue;
      entries.push({
        target: el,
        borderBoxSize: [{ blockSize: height, inlineSize: 0 }],
        contentBoxSize: [{ blockSize: height, inlineSize: 0 }],
        devicePixelContentBoxSize: [],
        contentRect: { height } as DOMRectReadOnly,
      } as ResizeObserverEntry);
    }
    if (entries.length > 0) {
      act(() => observer.callback(entries, observer as unknown as ResizeObserver));
    }
  }
}

/** Report a new size for the scroller itself (a window resize, a pane shown). */
function resizeScroller(log: HTMLElement): void {
  for (const observer of FakeResizeObserver.live) {
    if (!observer.observed.has(log)) continue;
    const entry = {
      target: log,
      borderBoxSize: [],
      contentBoxSize: [],
    } as unknown as ResizeObserverEntry;
    act(() => observer.callback([entry], observer as unknown as ResizeObserver));
  }
}

const native = globalThis.ResizeObserver;
beforeEach(() => {
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  FakeResizeObserver.live.clear();
  globalThis.ResizeObserver = native;
});

const keys = (n: number, prefix = "r") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

interface HarnessProps {
  keys: readonly string[];
  pin: { current: Pin };
  viewport?: { height: number };
  handle?: RefObject<VirtualLogHandle | null>;
  onRange?: (range: VirtualRangeReport) => void;
  /** 100 by default; null leaves it out, for the adaptive estimate. */
  estimate?: number | null;
}

function Harness({ keys, pin, viewport, handle, onRange, estimate = 100 }: HarnessProps) {
  const log = useRef<HTMLDivElement>(null);
  return (
    <div className="ch-log" ref={log}>
      <VirtualLog
        items={keys.map((key) => ({
          key,
          node: key.startsWith("img") ? (
            <img src={`/${key}.png`} alt="" />
          ) : (
            <button type="button">{key}</button>
          ),
        }))}
        scroller={log}
        pin={pin}
        viewport={viewport}
        overscan={100}
        estimate={estimate ?? undefined}
        ref={handle}
        onRange={onRange}
      />
    </div>
  );
}

const pinOf = (following: boolean) => ({ current: { following, pinnedTop: null } as Pin });
const VIEW = { height: 300 };

function logOf(container: HTMLElement): HTMLElement {
  return container.querySelector(".ch-log") as HTMLElement;
}

function mounted(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-vrow]")).map(
    (el) => el.dataset.vrow ?? "",
  );
}

function spacer(container: HTMLElement, which: "top" | "bottom"): string {
  return (
    (container.querySelector(`[data-vspacer="${which}"]`) as HTMLElement | null)?.style.height ?? ""
  );
}

function scrollTo(log: HTMLElement, top: number): void {
  log.scrollTop = top;
  fireEvent.scroll(log);
}

/**
 * Ask the handle to scroll, then wait for the row. The request goes inside
 * `act` and the wait outside it: the promise settles in the commit that
 * mounts the row, and `act` holds that commit until its callback returns.
 */
async function scrollToKey(
  handle: RefObject<VirtualLogHandle | null>,
  key: string,
  block?: "start" | "center" | "end",
): Promise<HTMLElement | null | undefined> {
  let pending: Promise<HTMLElement | null> | undefined;
  await act(async () => {
    pending = handle.current?.scrollToKey(key, block ? { block } : undefined);
  });
  return pending;
}

/**
 * happy-dom reports `scrollHeight` 0, which reads as "at the bottom" at any
 * offset and would turn following back on at every scroll.
 */
function tallLog(log: HTMLElement): void {
  stubScrollHeight(log, () => 100_000);
}

function stubScrollHeight(log: HTMLElement, height: () => number): void {
  Object.defineProperty(log, "scrollHeight", { configurable: true, get: height });
}

test("degrade: a scroller with no layout mounts every row and no spacers", () => {
  const { container } = render(<Harness keys={keys(200)} pin={pinOf(false)} />);
  expect(mounted(container)).toHaveLength(200);
  expect(container.querySelector("[data-vspacer]")).toBeNull();
});

test("degrade: an image settling late re-pins a following log", () => {
  const { container } = render(<Harness keys={["r0", "img1"]} pin={pinOf(true)} />);
  const log = logOf(container);
  stubScrollHeight(log, () => 2400);
  fireEvent.load(container.querySelector("img") as HTMLImageElement);
  expect(log.scrollTop).toBe(2400);
});

test("degrade: scrollToKey resolves the mounted row", async () => {
  const handle = createRef<VirtualLogHandle>();
  const pin = pinOf(true);
  const { container } = render(<Harness keys={keys(20)} pin={pin} handle={handle} />);
  const row = await scrollToKey(handle, "r7");
  expect(row).toBe(container.querySelector('[data-vrow="r7"]') as HTMLElement);
  expect(pin.current.following).toBe(false);
});

test("a forced viewport mounts only the window and overscan, spacers aria-hidden", () => {
  const { container } = render(<Harness keys={keys(100)} pin={pinOf(false)} viewport={VIEW} />);
  // 0..300 plus 100 below: rows touching 0..400.
  expect(mounted(container)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  expect(spacer(container, "top")).toBe("0px");
  expect(spacer(container, "bottom")).toBe("9500px");
  for (const el of container.querySelectorAll("[data-vspacer]")) {
    expect(el.getAttribute("aria-hidden")).toBe("true");
  }
});

test("scrolling moves the window", () => {
  const onRange: VirtualRangeReport[] = [];
  const { container } = render(
    <Harness
      keys={keys(100)}
      pin={pinOf(false)}
      viewport={VIEW}
      onRange={(range) => onRange.push(range)}
    />,
  );
  tallLog(logOf(container));
  scrollTo(logOf(container), 2000);
  expect(mounted(container)).toEqual(["r19", "r20", "r21", "r22", "r23", "r24"]);
  expect(spacer(container, "top")).toBe("1900px");
  expect(spacer(container, "bottom")).toBe("7500px");
  expect(onRange.at(-1)).toEqual({ start: 19, end: 25, windowed: true, held: [] });
});

test("a row growing above the viewport moves scrollTop by its growth; one below does not", () => {
  const { container } = render(<Harness keys={keys(100)} pin={pinOf(false)} viewport={VIEW} />);
  const log = logOf(container);
  tallLog(log);
  scrollTo(log, 2000);
  resize({ r19: 150 });
  expect(log.scrollTop).toBe(2050);
  resize({ r22: 300 });
  expect(log.scrollTop).toBe(2050);
});

test("a measured height survives the row unmounting and coming back", () => {
  const { container } = render(<Harness keys={keys(100)} pin={pinOf(false)} viewport={VIEW} />);
  const log = logOf(container);
  tallLog(log);
  resize({ r0: 300 });
  scrollTo(log, 2000);
  expect(mounted(container)).not.toContain("r0");
  // r0 counts 300 in the pad, not the 100 estimate: rows start at 200 + 100i.
  expect(spacer(container, "top")).toBe("1900px");
  scrollTo(log, 0);
  expect(mounted(container)).toEqual(["r0", "r1", "r2"]);
  expect(spacer(container, "bottom")).toBe("9700px");
});

test("following: the window is the live end, and an append re-pins", () => {
  const pin = pinOf(true);
  const { container, rerender } = render(<Harness keys={keys(50)} pin={pin} viewport={VIEW} />);
  const log = logOf(container);
  let height = 5000;
  stubScrollHeight(log, () => height);
  // 4700..5000 plus 100 above.
  expect(mounted(container)).toEqual(["r46", "r47", "r48", "r49"]);
  height = 5100;
  rerender(<Harness keys={keys(51)} pin={pin} viewport={VIEW} />);
  expect(log.scrollTop).toBe(5100);
  expect(mounted(container)).toContain("r50");
});

test("following: a row growing re-pins to the bottom", () => {
  const pin = pinOf(true);
  const { container } = render(<Harness keys={keys(50)} pin={pin} viewport={VIEW} />);
  const log = logOf(container);
  let height = 5000;
  stubScrollHeight(log, () => height);
  height = 5300;
  resize({ r49: 400 });
  expect(log.scrollTop).toBe(5300);
  expect(pin.current.pinnedTop).toBe(5300);
});

test("scrolling up stops following, and a later append leaves the reader where they are", () => {
  const pin = pinOf(true);
  const { container, rerender } = render(<Harness keys={keys(50)} pin={pin} viewport={VIEW} />);
  const log = logOf(container);
  stubScrollHeight(log, () => 5000);
  rerender(<Harness keys={keys(50)} pin={pin} viewport={VIEW} />);
  expect(log.scrollTop).toBe(5000);

  scrollTo(log, 1000);
  expect(pin.current.following).toBe(false);
  expect(mounted(container)).toEqual(["r9", "r10", "r11", "r12", "r13", "r14"]);

  rerender(<Harness keys={keys(52)} pin={pin} viewport={VIEW} />);
  expect(log.scrollTop).toBe(1000);
});

test("scrollToKey mounts a far row, scrolls to it and resolves it", async () => {
  const handle = createRef<VirtualLogHandle>();
  const pin = pinOf(true);
  const { container } = render(<Harness keys={keys(100)} pin={pin} viewport={VIEW} handle={handle} />);
  const log = logOf(container);
  expect(mounted(container)).not.toContain("r80");

  tallLog(log);
  let row = await scrollToKey(handle, "r80", "start");
  expect(row).toBe(container.querySelector('[data-vrow="r80"]') as HTMLElement);
  expect(log.scrollTop).toBe(8000);
  expect(pin.current.following).toBe(false);

  row = await scrollToKey(handle, "r40");
  // Centred: 4000 + 50 - 150.
  expect(log.scrollTop).toBe(3900);
  expect(handle.current?.rowFor("r40")).toBe(row);
});

test("scrollToKey for an unknown key resolves null", async () => {
  const handle = createRef<VirtualLogHandle>();
  render(<Harness keys={keys(10)} pin={pinOf(false)} viewport={VIEW} handle={handle} />);
  expect(await scrollToKey(handle, "missing")).toBeNull();
});

test("a prepend keeps the rows in view where they were", () => {
  const pin = pinOf(false);
  const { container, rerender } = render(<Harness keys={keys(100)} pin={pin} viewport={VIEW} />);
  const log = logOf(container);
  tallLog(log);
  scrollTo(log, 2000);
  rerender(<Harness keys={[...keys(10, "p"), ...keys(100)]} pin={pin} viewport={VIEW} />);
  expect(log.scrollTop).toBe(3000);
  expect(mounted(container)).toEqual(["r19", "r20", "r21", "r22", "r23", "r24"]);
});

test("unmounting disconnects the observer and restores the scroller", () => {
  const { container, unmount } = render(<Harness keys={keys(10)} pin={pinOf(false)} viewport={VIEW} />);
  const log = logOf(container);
  expect(log.style.overflowAnchor).toBe("none");
  expect(FakeResizeObserver.live.size).toBe(1);
  unmount();
  expect(FakeResizeObserver.live.size).toBe(0);
});

test("a scroller that gains a height leaves degrade mode and windows", () => {
  const { container } = render(<Harness keys={keys(100)} pin={pinOf(false)} />);
  const log = logOf(container);
  expect(mounted(container)).toHaveLength(100);
  tallLog(log);
  Object.defineProperty(log, "clientHeight", { configurable: true, value: 300 });
  resizeScroller(log);
  expect(mounted(container)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  // Hidden again (`display: none` reads 0): the window is kept, not everything mounted.
  Object.defineProperty(log, "clientHeight", { configurable: true, value: 0 });
  resizeScroller(log);
  expect(mounted(container)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
});

test("StrictMode's double render and double effects do not double a prepend shift", () => {
  const pin = pinOf(false);
  const view = (list: readonly string[]) => (
    <StrictMode>
      <Harness keys={list} pin={pin} viewport={VIEW} />
    </StrictMode>
  );
  const { container, rerender } = render(view(keys(100)));
  const log = logOf(container);
  tallLog(log);
  scrollTo(log, 2000);
  rerender(view([...keys(10, "p"), ...keys(100)]));
  expect(log.scrollTop).toBe(3000);
  expect(FakeResizeObserver.live.size).toBe(1);
});

function rowOf(container: HTMLElement, key: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-vrow="${key}"]`);
}

test("the focused row stays mounted when scrolled far away, and is let go when focus leaves", async () => {
  const onRange: VirtualRangeReport[] = [];
  const { container } = render(
    <Harness
      keys={keys(100)}
      pin={pinOf(false)}
      viewport={VIEW}
      onRange={(range) => onRange.push(range)}
    />,
  );
  const log = logOf(container);
  tallLog(log);
  const button = rowOf(container, "r2")?.querySelector("button") as HTMLButtonElement;
  scrollTo(log, 250);
  act(() => button.focus());
  const windowRow = rowOf(container, "r5");
  // r2 leaves the window and becomes a held run with a gap after it: r5, in
  // the window throughout, keeps its element (no slot shift, no remount).
  scrollTo(log, 650);
  expect(mounted(container)).toEqual(["r2", "r5", "r6", "r7", "r8", "r9", "r10"]);
  expect(rowOf(container, "r5")).toBe(windowRow);
  scrollTo(log, 5000);

  expect(mounted(container)).toEqual(["r2", "r49", "r50", "r51", "r52", "r53", "r54"]);
  expect(document.activeElement).toBe(button);
  expect(onRange.at(-1)).toEqual({ start: 49, end: 55, windowed: true, held: [2] });
  // The held row sits at its true offset: 200px above it, 4600px between.
  const pads = Array.from(log.querySelectorAll<HTMLElement>("[data-vspacer]")).map((el) => [
    el.dataset.vspacer,
    el.style.height,
  ]);
  expect(pads).toEqual([
    ["top", "200px"],
    ["gap", "4600px"],
    ["bottom", "4500px"],
  ]);

  await act(async () => {
    button.blur();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  expect(mounted(container)).toEqual(["r49", "r50", "r51", "r52", "r53", "r54"]);
});

test("data-fresh marks rows appended after the first commit, on their first mount only", () => {
  const pin = pinOf(false);
  const { container, rerender } = render(<Harness keys={keys(3)} pin={pin} viewport={VIEW} />);
  const log = logOf(container);
  tallLog(log);
  expect(container.querySelector("[data-fresh]")).toBeNull();

  rerender(<Harness keys={keys(4)} pin={pin} viewport={VIEW} />);
  expect(rowOf(container, "r3")?.getAttribute("data-fresh")).toBe("");
  expect(rowOf(container, "r0")?.hasAttribute("data-fresh")).toBe(false);

  // A prepended run is history, not news.
  rerender(<Harness keys={["h0", ...keys(4)]} pin={pin} viewport={VIEW} />);
  expect(rowOf(container, "h0")?.hasAttribute("data-fresh")).toBe(false);
  // Still the same first mount of r3: the mark stays while it lasts.
  expect(rowOf(container, "r3")?.getAttribute("data-fresh")).toBe("");

  // Scrolled away (r3 unmounts) and back (it remounts): not fresh any more.
  rerender(<Harness keys={["h0", ...keys(40)]} pin={pin} viewport={VIEW} />);
  scrollTo(log, 3000);
  expect(rowOf(container, "r3")).toBeNull();
  scrollTo(log, 0);
  expect(rowOf(container, "r3")?.hasAttribute("data-fresh")).toBe(false);
  // A row appended while the reader was elsewhere is fresh when it first mounts.
  expect(rowOf(container, "r39")).toBeNull();
  scrollTo(log, 3800);
  expect(rowOf(container, "r39")?.getAttribute("data-fresh")).toBe("");
});

test("measurements are ignored while the scroller has no height (a hidden pane)", () => {
  const { container } = render(<Harness keys={keys(100)} pin={pinOf(false)} />);
  const log = logOf(container);
  tallLog(log);
  Object.defineProperty(log, "clientHeight", { configurable: true, value: 300 });
  resizeScroller(log);
  resize({ r0: 300 });
  // r0..r2 mounted (0..500); r3..r99 below at the 100 estimate.
  expect(spacer(container, "bottom")).toBe("9700px");

  Object.defineProperty(log, "clientHeight", { configurable: true, value: 0 });
  resize({ r0: 0, r1: 0, r2: 0 });
  Object.defineProperty(log, "clientHeight", { configurable: true, value: 300 });
  resizeScroller(log);
  // r0 is still 300 and r1, r2 still estimates: the pad below is unchanged.
  expect(spacer(container, "bottom")).toBe("9700px");
  expect(mounted(container)).toEqual(["r0", "r1", "r2"]);
});

test("without a fixed estimate, unmeasured rows take the mean measured height", () => {
  const { container } = render(
    <Harness keys={keys(100)} pin={pinOf(false)} viewport={VIEW} estimate={null} />,
  );
  tallLog(logOf(container));
  // 96 until four rows are measured: three at 200 leave r0..r3 mounted
  // (0..592) and r4..r99 below at 96.
  resize({ r2: 200, r3: 200, r4: 200 });
  expect(spacer(container, "bottom")).toBe(`${9912 - 592}px`);
  // The fourth adopts the mean: every unmeasured row is 200 now, the window is
  // r0..r2 (0..600) and r3..r99 below hold 97 rows of 200.
  resize({ r0: 200 });
  expect(spacer(container, "bottom")).toBe(`${97 * 200}px`);
});

test("history arriving into an empty log is not fresh; a first single message is", () => {
  const pin = pinOf(false);
  const { container, rerender } = render(<Harness keys={[]} pin={pin} viewport={VIEW} />);
  rerender(<Harness keys={keys(3)} pin={pin} viewport={VIEW} />);
  expect(mounted(container)).toEqual(["r0", "r1", "r2"]);
  expect(container.querySelector("[data-fresh]")).toBeNull();
  // A message after the history is news again.
  rerender(<Harness keys={keys(4)} pin={pin} viewport={VIEW} />);
  expect(rowOf(container, "r3")?.getAttribute("data-fresh")).toBe("");

  cleanup();
  const second = render(<Harness keys={[]} pin={pin} viewport={VIEW} />);
  second.rerender(<Harness keys={["first"]} pin={pin} viewport={VIEW} />);
  expect(rowOf(second.container, "first")?.getAttribute("data-fresh")).toBe("");
});
