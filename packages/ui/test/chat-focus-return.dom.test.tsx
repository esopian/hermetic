/**
 * Switching back to the app puts the caret in the chat composer, so text copied
 * elsewhere can be pasted straight in — unless the operator was typing
 * somewhere else, or something else owns the keyboard.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "./dom.ts";
import { Composer } from "../src/chat/components/Composer.tsx";

afterEach(cleanup);

function draw(opts: { enabled?: boolean } = {}) {
  const enabled = opts.enabled ?? true;
  render(
    <>
      <button type="button">a rail row</button>
      <input aria-label="Search" />
      <div data-owns-keys="">
        <textarea aria-label="Terminal" />
      </div>
      <Composer
        destination={{ state: "known", origin: "portal", detail: null }}
        placeholder="Message…"
        enabled={enabled}
        sending={false}
        onSend={() => {}}
        onAbort={() => {}}
      />
    </>,
  );
  return screen.getByLabelText("Message…") as HTMLTextAreaElement;
}

/** The window regaining focus, and the tick the hook waits for. */
async function returnToApp() {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await new Promise((done) => setTimeout(done, 5));
  });
}

describe("returning to the app", () => {
  test("lands the caret at the end of the composer's draft", async () => {
    const input = draw();
    screen.getByRole("button", { name: "a rail row" }).focus();
    input.value = "half a thought";
    await returnToApp();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe("half a thought".length);
  });

  test("from nothing focused at all", async () => {
    const input = draw();
    (document.activeElement as HTMLElement | null)?.blur();
    await returnToApp();
    expect(document.activeElement).toBe(input);
  });

  test("leaves another text field the operator was typing in", async () => {
    draw();
    const search = screen.getByLabelText("Search");
    search.focus();
    await returnToApp();
    expect(document.activeElement).toBe(search);
  });

  test("leaves an element that owns the keyboard", async () => {
    draw();
    const terminal = screen.getByLabelText("Terminal");
    terminal.focus();
    await returnToApp();
    expect(document.activeElement).toBe(terminal);
  });

  test("leaves a disabled composer alone", async () => {
    const input = draw({ enabled: false });
    screen.getByRole("button", { name: "a rail row" }).focus();
    await returnToApp();
    expect(document.activeElement).not.toBe(input);
  });

  test("does not move a caret already in the composer", async () => {
    const input = draw();
    input.value = "abcdef";
    input.focus();
    input.setSelectionRange(2, 2);
    await returnToApp();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
  });
});
