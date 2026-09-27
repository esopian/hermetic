/**
 * The open-window set.
 *
 * The factory is injected, so there is no `BrowserWindow` here and nothing that
 * needs a built app: a fake window records the listener it was given and calls
 * it when the test says the window is going, which is the whole of what the set
 * has to react to.
 */
import { describe, expect, test } from "bun:test";
import {
  clampFrame,
  createWindows,
  type Frame,
  MIN_FRAME,
  type OpenedWindow,
} from "../../src/main/windows.ts";

interface Fake extends OpenedWindow {
  /** What the window told the page. */
  sent: Array<{ name: string; payload: unknown }>;
  /** How many times the binding's cleanup ran. */
  cleanups: number;
  /** `window.close()` calls — the native half, separate from the cleanup. */
  closes: number;
  /** Pretends the window has gone, the way the native `close` event does. */
  closed(): void;
  /** Pretends the operator moved to or away from this window. */
  focused(visible: boolean): void;
  /** Every `setFrame` the set asked for, in order. */
  frames: Frame[];
  /** Pretends the operator dragged the window to this frame. */
  resize(frame: Frame): void;
}

function fakeWindow(): Fake {
  const listeners: Array<() => void> = [];
  const focusListeners = new Map<string, () => void>();
  const fake: Fake = {
    sent: [],
    frames: [],
    resize: () => {},
    cleanups: 0,
    closes: 0,
    window: {
      close() {
        fake.closes += 1;
      },
      setFrame(x, y, width, height) {
        fake.frames.push({ x, y, width, height });
      },
      on(event, listener) {
        if (event === "close") listeners.push(() => listener());
        if (event === "focus" || event === "blur") focusListeners.set(event, () => listener());
        if (event === "resize") fake.resize = (frame) => listener({ data: { id: 1, ...frame } });
      },
    },
    send: (name, payload) => {
      fake.sent.push({ name, payload });
    },
    close() {
      fake.cleanups += 1;
    },
    closed() {
      for (const listener of [...listeners]) listener();
    },
    focused(visible) {
      focusListeners.get(visible ? "focus" : "blur")?.();
    },
  };
  return fake;
}

/** A set whose factory hands out the windows the test made, in order. */
function windowsOver(queue: Fake[]) {
  let next = 0;
  return createWindows({
    open() {
      const window = queue[next++];
      if (window === undefined) throw new Error("the test asked for more windows than it made");
      return window;
    },
  });
}

const UPDATE = { status: "available", version: "0.1.3" } as const;

describe("the set", () => {
  test("grows as windows open", () => {
    const set = windowsOver([fakeWindow(), fakeWindow()]);
    set.open();
    set.open();
    expect(set.size).toBe(2);
  });

  test("shrinks when a window closes itself", () => {
    const one = fakeWindow();
    const set = windowsOver([one, fakeWindow()]);
    set.open();
    set.open();
    one.closed();
    expect(set.size).toBe(1);
  });
});

describe("broadcast", () => {
  test("reaches every open window", () => {
    const one = fakeWindow();
    const two = fakeWindow();
    const set = windowsOver([one, two]);
    set.open();
    set.open();
    set.broadcast("app.update", UPDATE);
    expect(one.sent).toEqual([{ name: "app.update", payload: UPDATE }]);
    expect(two.sent).toEqual([{ name: "app.update", payload: UPDATE }]);
  });

  test("does not reach a window that has gone", () => {
    const gone = fakeWindow();
    const live = fakeWindow();
    const set = windowsOver([gone, live]);
    set.open();
    set.open();
    gone.closed();
    set.broadcast("app.update", UPDATE);
    expect(gone.sent).toEqual([]);
    expect(live.sent).toHaveLength(1);
  });
});

/**
 * The page cannot see its own visibility (the webview reports `hidden` for the
 * life of the window), so the head is the only source of it and the gated
 * readers in the UI stop running if it goes quiet.
 */
describe("visibility", () => {
  test("focus and blur are pushed to the window they happened to", () => {
    const front = fakeWindow();
    const back = fakeWindow();
    const set = windowsOver([front, back]);
    set.open();
    set.open();
    front.focused(true);
    back.focused(false);
    expect(front.sent).toEqual([{ name: "app.visibility", payload: { visible: true } }]);
    expect(back.sent).toEqual([{ name: "app.visibility", payload: { visible: false } }]);
  });
});

describe("cleanup", () => {
  test("a window closing drops what it opened", () => {
    // The binding's `close()` is what closes that window's streams
    // (`rpc/bind.ts`); the set's job is to call it exactly when `close`
    // says the window is nobody's any more.
    const one = fakeWindow();
    const set = windowsOver([one]);
    set.open();
    one.closed();
    expect(one.cleanups).toBe(1);
  });

  test("and drops it once, however the close arrives", () => {
    // Quitting closes the set while each window fires its own `close`, in
    // an order neither of them decides.
    const one = fakeWindow();
    const set = windowsOver([one]);
    set.open();
    one.closed();
    set.closeAll();
    one.closed();
    expect(one.cleanups).toBe(1);
  });

  test("closing the set closes the native windows too", () => {
    const one = fakeWindow();
    const two = fakeWindow();
    const set = windowsOver([one, two]);
    set.open();
    set.open();
    set.closeAll();
    expect(set.size).toBe(0);
    expect([one.closes, two.closes]).toEqual([1, 1]);
    expect([one.cleanups, two.cleanups]).toEqual([1, 1]);
  });
});

describe("minimum size", () => {
  test("clampFrame grows only the axis that went under, and keeps the position", () => {
    expect(clampFrame({ x: 10, y: 20, width: 1440, height: 900 })).toBeNull();
    expect(clampFrame({ x: 10, y: 20, width: MIN_FRAME.width, height: MIN_FRAME.height })).toBeNull();
    expect(clampFrame({ x: 10, y: 20, width: 500, height: 900 })).toEqual({
      x: 10,
      y: 20,
      width: MIN_FRAME.width,
      height: 900,
    });
    expect(clampFrame({ x: 10, y: 20, width: 1440, height: 300 })).toEqual({
      x: 10,
      y: 20,
      width: 1440,
      height: MIN_FRAME.height,
    });
  });

  test("a resize under the minimum is set straight back; one at the minimum is left alone", () => {
    const fake = fakeWindow();
    const set = createWindows({ open: () => fake });
    set.open();
    fake.resize({ x: 0, y: 0, width: 400, height: 300 });
    expect(fake.frames).toEqual([{ x: 0, y: 0, width: MIN_FRAME.width, height: MIN_FRAME.height }]);
    fake.resize({ x: 0, y: 0, width: MIN_FRAME.width, height: MIN_FRAME.height });
    fake.resize({ x: 5, y: 5, width: 1600, height: 1000 });
    expect(fake.frames).toHaveLength(1);
  });
});
