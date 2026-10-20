/**
 * The composer grows with its text up to a cap, then scrolls (`autosize.ts`).
 *
 * happy-dom does no layout, so `scrollHeight` is stubbed from the text — twenty
 * pixels a line, the line height the input is given here — and the claim is
 * about the inline height the hook writes: fitted, clamped, re-fitted when the
 * text changes from outside (the clear after a send) and when the window does.
 */
import { cleanup, fireEvent, render } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { autosizeMax } from "../src/chat/autosize.ts";
import { Composer } from "../src/chat/components/Composer.tsx";
import { PORTAL } from "./chat-fixtures.tsx";

const LINE = 20;
const originalInnerHeight = window.innerHeight;

function setInnerHeight(px: number): void {
  Object.defineProperty(window, "innerHeight", { value: px, configurable: true, writable: true });
}

beforeEach(() => {
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return this.value.split("\n").length * LINE;
    },
  });
  setInnerHeight(500);
});

afterEach(() => {
  cleanup();
  delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
  setInnerHeight(originalInnerHeight);
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

function mountComposer(sent: string[] = []) {
  const { container } = render(
    <Composer
      destination={PORTAL}
      placeholder="Message…"
      enabled
      sending={false}
      onSend={(text) => sent.push(text)}
      onAbort={() => {}}
    />,
  );
  const input = container.querySelector<HTMLTextAreaElement>(".ch-input-field > .ch-input")!;
  input.style.lineHeight = `${LINE}px`;
  return input;
}

describe("autosizeMax", () => {
  test("twelve lines or 40% of the window, whichever is smaller, never under one line", () => {
    expect(autosizeMax(20, 500)).toBe(200);
    expect(autosizeMax(20, 2000)).toBe(240);
    expect(autosizeMax(20, 10)).toBe(20);
  });
});

describe("the composer's height", () => {
  test("follows the text up to the cap, then scrolls inside", () => {
    const input = mountComposer();
    fireEvent.change(input, { target: { value: "one line" } });
    expect(input.style.height).toBe("20px");
    expect(input.style.overflowY).toBe("hidden");

    fireEvent.change(input, { target: { value: lines(5) } });
    expect(input.style.height).toBe("100px");

    // 30 lines is 600px of text; 40% of a 500px window is the cap.
    fireEvent.change(input, { target: { value: lines(30) } });
    expect(input.style.height).toBe("200px");
    expect(input.style.overflowY).toBe("auto");
  });

  test("re-fits when the window resizes and when a send clears the input", () => {
    const sent: string[] = [];
    const input = mountComposer(sent);
    fireEvent.change(input, { target: { value: lines(30) } });
    expect(input.style.height).toBe("200px");

    // A taller window lifts the 40% cap above twelve lines, so twelve lines wins.
    setInnerHeight(1000);
    fireEvent(window, new Event("resize"));
    expect(input.style.height).toBe("240px");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(sent).toHaveLength(1);
    expect(input.value).toBe("");
    expect(input.style.height).toBe("20px");
    expect(input.style.overflowY).toBe("hidden");
  });
});
