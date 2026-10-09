/**
 * The shortcuts sheet is a hand-written list, because the shell's handler is a
 * chain of `e.key === "…"` tests with nothing to read a description off. A
 * hand-written list is a list that goes stale, so this reads the handler's key
 * literals back out of the source and insists the two agree — the sheet exists
 * precisely because these shortcuts are otherwise undiscoverable, and one that
 * lies is worse than none.
 *
 * The second half pins the guard. Every non-Escape shortcut has to be refused
 * while a modal overlay owns the screen; `/` was not, and focused the fleet's
 * filter input behind an open drawer.
 */
import { describe, expect, test } from "bun:test";
import type { OverlayState } from "../src/nav/shortcuts.ts";
import { SHORTCUTS, overlayIsOpen, shortcutAllowed } from "../src/nav/shortcuts.ts";

// The shell's handler is `useNavKeys` (`nav-state.tsx`); chat's is `ChatShell`.
const APP =
  (await Bun.file(new URL("../src/nav/nav-state.tsx", import.meta.url)).text()) +
  (await Bun.file(new URL("../src/App.tsx", import.meta.url)).text()) +
  (await Bun.file(new URL("../src/chat/components/ChatShell.tsx", import.meta.url)).text());

/** Every `e.key === "x"` the shell's keydown handler compares against. */
function handledKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const m of source.matchAll(/e\.key === "([^"]+)"/g)) {
    const key = m[1];
    if (key) keys.add(key);
  }
  return keys;
}

/** The `Esc`/`Escape` spelling difference is the sheet's, for the key cap. */
function asKeyName(s: { keys: string }): string {
  if (s.keys === "⇧ I") return "I";
  return s.keys === "Esc" ? "Escape" : s.keys === "j / k" ? "j" : s.keys.includes("K") ? "k" : s.keys;
}

function overlays(over: Partial<OverlayState> = {}): OverlayState {
  return {
    shortcutsOpen: false,
    notifyOpen: false,
    popoverOpen: false,
    teardownOpen: false,
    createOpen: false,
    selected: null,
    settingsOpen: false,
    foundationTeardownOpen: false,
    foundationUpdateOpen: false,
    ...over,
  };
}

describe("the shortcuts sheet", () => {
  test("lists every key the app shell handles", () => {
    const handled = handledKeys(APP);
    // `Enter` is a row/card activation handled inside the fleet layouts, not a
    // global shortcut, so it is not in `App.tsx` and not on the sheet.
    const listed = new Set(SHORTCUTS.map(asKeyName));
    listed.add("k");
    for (const key of handled) {
      expect(listed.has(key)).toBe(true);
    }
  });

  test("lists nothing the app shell does not handle", () => {
    const handled = handledKeys(APP);
    for (const s of SHORTCUTS) {
      expect(handled.has(asKeyName(s))).toBe(true);
    }
  });

  test("includes the shortcut for the sheet itself", () => {
    // The one that makes the other four findable at all.
    expect(SHORTCUTS.some((s) => s.keys === "?")).toBe(true);
  });

  test("every row says what the key does", () => {
    for (const s of SHORTCUTS) {
      expect(s.what.length).toBeGreaterThan(0);
      expect(s.keys.length).toBeGreaterThan(0);
    }
  });
});

describe("overlayIsOpen", () => {
  test("nothing on screen is nothing open", () => {
    expect(overlayIsOpen(overlays())).toBe(false);
  });

  test("every modal surface counts", () => {
    const modal: Array<Partial<OverlayState>> = [
      { shortcutsOpen: true },
      { notifyOpen: true },
      { popoverOpen: true },
      { createOpen: true },
      { selected: "lumen" },
      { teardownOpen: true },
      { foundationTeardownOpen: true },
      { foundationUpdateOpen: true },
    ];
    for (const over of modal) {
      expect(overlayIsOpen(overlays(over))).toBe(true);
    }
  });

  /**
   * Settings replaces the fleet rather than covering it: nothing traps focus,
   * and Escape falls through to it last. Counting it as an overlay would
   * disable `,` on the page `,` is for.
   */
  test("the full-page Settings view is not an overlay", () => {
    expect(overlayIsOpen(overlays({ settingsOpen: true }))).toBe(false);
  });
});

describe("shortcutAllowed", () => {
  /**
   * The bug this rule exists for: `/` reached through an `aria-modal` drawer
   * and put focus on an input behind it.
   */
  test("`/` is refused while a drawer owns the screen", () => {
    expect(shortcutAllowed("/", overlays())).toBe(true);
    expect(shortcutAllowed("/", overlays({ selected: "lumen" }))).toBe(false);
    expect(shortcutAllowed("/", overlays({ createOpen: true }))).toBe(false);
    expect(shortcutAllowed("/", overlays({ foundationUpdateOpen: true }))).toBe(false);
  });

  test("`n` and `,` are refused by the same rule, not by three hand-written ones", () => {
    for (const key of ["n", ","]) {
      expect(shortcutAllowed(key, overlays())).toBe(true);
      expect(shortcutAllowed(key, overlays({ createOpen: true }))).toBe(false);
      expect(shortcutAllowed(key, overlays({ selected: "lumen" }))).toBe(false);
      expect(shortcutAllowed(key, overlays({ popoverOpen: true }))).toBe(false);
    }
  });

  test("`n` alone is also refused on the Settings page, which has no fleet under it", () => {
    expect(shortcutAllowed("n", overlays({ settingsOpen: true }))).toBe(false);
    expect(shortcutAllowed(",", overlays({ settingsOpen: true }))).toBe(true);
  });

  /**
   * `?` is the exception on purpose: it is what an operator reaches for when
   * they are stuck inside an overlay, and it opens a popover that is itself a
   * focus trap, so it cannot strand focus behind anything.
   */
  test("`?` always fires, including from inside an overlay", () => {
    expect(shortcutAllowed("?", overlays())).toBe(true);
    expect(shortcutAllowed("?", overlays({ selected: "lumen", teardownOpen: true }))).toBe(true);
    expect(shortcutAllowed("?", overlays({ shortcutsOpen: true }))).toBe(true);
  });

  test("every listed shortcut but Escape is gated by the guard", () => {
    // Escape is routed around `shortcutAllowed` by design — its whole job is to
    // close whatever is open, so `App.tsx` owns its priority stack instead.
    const blocking = overlays({ createOpen: true });
    for (const s of SHORTCUTS) {
      if (s.keys === "Esc" || s.keys === "?") continue;
      expect(shortcutAllowed(s.keys, blocking)).toBe(false);
    }
  });
});
