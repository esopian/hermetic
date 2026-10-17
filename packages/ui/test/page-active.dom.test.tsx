/**
 * "Page active": on screen *and* in front (`src/lib/visibility.ts`).
 *
 * Everything decorative in the portal — the avatar loop, GSAP, every CSS
 * animation, a terminal's blinking cursor, the one-second clocks — runs only
 * while this is true. So the question is asked of all three sources the page
 * has: `document`'s visibility, the window's focus, and the head's pushed
 * `app.visibility`, which in the app is the only honest answer and wins.
 */
import { act, cleanup, flipPageHidden, render, setPageHidden } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import {
  clearPageVisible,
  isPageActive,
  markPageInactive,
  PAGE_INACTIVE_ATTR,
  setPageVisible,
  subscribePageActive,
  usePageActive,
} from "../src/lib/visibility.ts";

const hadFocus = document.hasFocus.bind(document);
let focused = true;

/** The window gaining or losing focus, the way a browser reports it. */
function setFocus(on: boolean): void {
  focused = on;
  document.hasFocus = () => focused;
  window.dispatchEvent(new Event(on ? "focus" : "blur"));
}

/** Every answer a subscriber is given, in order. */
function record(): { seen: boolean[]; stop: () => void } {
  const seen: boolean[] = [];
  const stop = subscribePageActive((active) => seen.push(active));
  return { seen, stop };
}

afterEach(() => {
  cleanup();
  setPageHidden(false);
  clearPageVisible();
  document.hasFocus = hadFocus;
  focused = true;
  document.documentElement.removeAttribute(PAGE_INACTIVE_ATTR);
});

describe("isPageActive / subscribePageActive", () => {
  test("a visible, focused page is active", () => {
    setFocus(true);
    expect(isPageActive()).toBe(true);
  });

  test("hidden is inactive, and showing the page again is a return", () => {
    const { seen, stop } = record();
    flipPageHidden(true);
    expect(isPageActive()).toBe(false);
    flipPageHidden(false);
    expect(isPageActive()).toBe(true);
    expect(seen).toEqual([false, true]);
    stop();
  });

  test("blurred is inactive, and focus is a return", () => {
    const { seen, stop } = record();
    setFocus(false);
    expect(isPageActive()).toBe(false);
    setFocus(true);
    expect(isPageActive()).toBe(true);
    expect(seen).toEqual([false, true]);
    stop();
  });

  test("hidden and blurred: coming back from one alone is not a return", () => {
    const { seen, stop } = record();
    setFocus(false);
    flipPageHidden(true);
    flipPageHidden(false);
    expect(isPageActive()).toBe(false);
    setFocus(true);
    expect(isPageActive()).toBe(true);
    // Told once on the way out and once on the way back, not per event.
    expect(seen).toEqual([false, true]);
    stop();
  });

  test("the head's push wins over the document, both ways", () => {
    const { seen, stop } = record();
    // The app: the webview says hidden for the life of the window, the head
    // says it is in front.
    setPageHidden(true);
    setPageVisible(true);
    expect(isPageActive()).toBe(true);
    setPageVisible(false);
    expect(isPageActive()).toBe(false);
    setPageVisible(true);
    expect(seen).toEqual([false, true]);
    stop();
  });

  test("an unsubscribed listener hears nothing more", () => {
    const { seen, stop } = record();
    stop();
    setFocus(false);
    flipPageHidden(true);
    expect(seen).toEqual([]);
  });
});

describe("markPageInactive", () => {
  test("the root carries the attribute exactly while the page is inactive", () => {
    const root = document.documentElement;
    const undo = markPageInactive(root);
    expect(root.hasAttribute(PAGE_INACTIVE_ATTR)).toBe(false);

    setFocus(false);
    expect(root.hasAttribute(PAGE_INACTIVE_ATTR)).toBe(true);
    setFocus(true);
    expect(root.hasAttribute(PAGE_INACTIVE_ATTR)).toBe(false);

    flipPageHidden(true);
    expect(root.hasAttribute(PAGE_INACTIVE_ATTR)).toBe(true);
    flipPageHidden(false);
    expect(root.hasAttribute(PAGE_INACTIVE_ATTR)).toBe(false);

    setPageVisible(false);
    expect(root.hasAttribute(PAGE_INACTIVE_ATTR)).toBe(true);
    undo();
    expect(root.hasAttribute(PAGE_INACTIVE_ATTR)).toBe(false);
  });

  test("installed on an inactive page, it marks the root at once", () => {
    setFocus(false);
    const undo = markPageInactive(document.documentElement);
    expect(document.documentElement.hasAttribute(PAGE_INACTIVE_ATTR)).toBe(true);
    undo();
  });
});

describe("usePageActive", () => {
  function Probe() {
    return <span data-testid="probe">{usePageActive() ? "active" : "inactive"}</span>;
  }

  test("re-renders on the way out and on the way back", () => {
    const view = render(<Probe />);
    const probe = view.getByTestId("probe");
    expect(probe.textContent).toBe("active");
    act(() => setFocus(false));
    expect(probe.textContent).toBe("inactive");
    act(() => setFocus(true));
    expect(probe.textContent).toBe("active");
  });
});
