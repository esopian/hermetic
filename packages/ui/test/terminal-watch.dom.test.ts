/**
 * The shared terminal watch state (issue #18): which session the page shows,
 * and whether that counts as watching it. The Terminal section writes it; the
 * toast gate and the `terminal.view` report read it.
 */
import { flipPageHidden } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import {
  isWatchingTerminal,
  onTerminalViewChange,
  resetTerminalWatch,
  setTerminalShowing,
  terminalShowing,
  viewedTerminal,
} from "../src/state/terminal-watch.ts";

const hadFocus = document.hasFocus.bind(document);
let focused = true;

function setFocus(on: boolean): void {
  focused = on;
  document.hasFocus = () => focused;
  window.dispatchEvent(new Event(on ? "focus" : "blur"));
}

afterEach(() => {
  resetTerminalWatch();
  flipPageHidden(false);
  document.hasFocus = hadFocus;
  focused = true;
});

describe("terminal watch", () => {
  test("nothing shown is nothing watched", () => {
    expect(terminalShowing()).toBeNull();
    expect(viewedTerminal()).toBeNull();
    expect(isWatchingTerminal({ kind: "terminal.output", ref: "s1" })).toBe(false);
  });

  test("a session shown in a visible, focused window is watched; only its own rows", () => {
    setFocus(true);
    setTerminalShowing("s1");
    expect(viewedTerminal()).toBe("s1");
    expect(isWatchingTerminal({ kind: "terminal.output", ref: "s1" })).toBe(true);
    expect(isWatchingTerminal({ kind: "terminal.bell", ref: "s2" })).toBe(false);
  });

  /** A session left on screen behind an editor is not being watched. */
  test("blurred or hidden, the shown session is not watched", () => {
    setTerminalShowing("s1");
    setFocus(false);
    expect(terminalShowing()).toBe("s1");
    expect(viewedTerminal()).toBeNull();
    setFocus(true);
    flipPageHidden(true);
    expect(viewedTerminal()).toBeNull();
  });

  test("a listener hears each change once: the section, then the window", () => {
    setFocus(true);
    const heard: (string | null)[] = [];
    const off = onTerminalViewChange((v) => heard.push(v));
    setTerminalShowing("s1");
    setTerminalShowing("s1");
    setFocus(false);
    setFocus(true);
    flipPageHidden(true);
    flipPageHidden(false);
    setTerminalShowing("s2");
    setTerminalShowing(null);
    off();
    setTerminalShowing("s3");
    expect(heard).toEqual(["s1", null, "s1", null, "s1", "s2", null]);
  });
});
