/**
 * The arithmetic behind the focus trap. `useFocusTrap` itself needs a DOM and a
 * mounted dialog, which this suite has no renderer for; what *is* testable
 * without one — and what is easy to get subtly wrong — is where Tab should go
 * from a given position, so that is what lives in a pure function.
 */
import { describe, expect, test } from "bun:test";
import { nextTrapTarget } from "../src/lib/focus.ts";

describe("nextTrapTarget", () => {
  test("Tab in the middle of the list is the browser's job, not the trap's", () => {
    // Intervening on every keystroke would fight the browser's own ordering,
    // which already knows about `tabindex` and about visibility.
    expect(nextTrapTarget(4, 1, false)).toBeNull();
    expect(nextTrapTarget(4, 2, true)).toBeNull();
  });

  test("Tab off the last focusable wraps to the first", () => {
    expect(nextTrapTarget(4, 3, false)).toBe(0);
    expect(nextTrapTarget(1, 0, false)).toBe(0);
  });

  test("Shift+Tab off the first focusable wraps to the last", () => {
    expect(nextTrapTarget(4, 0, true)).toBe(3);
    expect(nextTrapTarget(1, 0, true)).toBe(0);
  });

  /**
   * Focus on the dialog root itself — where it lands when a drawer opens with
   * nothing focusable in it yet, e.g. a destroy panel still reading its plan.
   */
  test("from the dialog root, Shift+Tab goes to the end and Tab is left alone", () => {
    expect(nextTrapTarget(3, -1, true)).toBe(2);
    // Forward from the root, the browser's next stop is already the first
    // focusable inside it.
    expect(nextTrapTarget(3, -1, false)).toBeNull();
  });

  test("a dialog with nothing to tab between never nominates a target", () => {
    // The caller holds focus on the root instead; there is no index to return.
    expect(nextTrapTarget(0, -1, false)).toBeNull();
    expect(nextTrapTarget(0, -1, true)).toBeNull();
  });
});
