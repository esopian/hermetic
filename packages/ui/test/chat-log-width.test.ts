/**
 * The chat transcript never scrolls sideways.
 *
 * Every row in `.ch-log` is a grid with a fixed gutter and a flexible content
 * column. Written as a bare `1fr`, that column is `minmax(auto, 1fr)`: it
 * floors at its content's min-content width, so one unbroken line in a
 * `white-space: pre` code block (or a diff, or a display equation) widened the
 * row to the length of that line and gave the whole log a horizontal
 * scrollbar. `minmax(0, 1fr)` lets the column shrink to the pane, and the wide
 * block scrolls inside its own box instead.
 *
 * Read off the stylesheet text because happy-dom does no layout: the fix is a
 * set of declarations, and this pins them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function sheet(name: string): string {
  const text = readFileSync(new URL(`../src/chat/styles/${name}`, import.meta.url), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The body of the one top-level rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

function declaration(body: string, property: string): string | null {
  return new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? null;
}

/** Every row grid that can sit inside the transcript. */
const ROWS: [file: string, selector: string][] = [
  ["chat.css", ".ch-msg"],
  ["chat.css", ".ch-event"],
  ["chat.css", ".ch-step"],
  ["chat-soft.css", '[data-skin="soft"] .ch-msg'],
  ["chat-soft.css", '[data-skin="soft"] .ch-event'],
  ["chat-events.css", ".ch-ev"],
  ["chat-events.css", ".ch-ev.sub"],
  ["chat-events.css", ".ch-ev-dm-body"],
];

describe("chat log width", () => {
  test("the log scrolls vertically only", () => {
    const body = ruleBody(sheet("chat.css"), ".ch-log");
    expect(declaration(body, "overflow-x")).toBe("hidden");
    expect(declaration(body, "overflow-y")).toBe("auto");
  });

  for (const [file, selector] of ROWS) {
    test(`${selector} has no content-floored track`, () => {
      const columns = declaration(ruleBody(sheet(file), selector), "grid-template-columns");
      expect(columns).not.toBeNull();
      expect(columns).toContain("minmax(0, 1fr)");
      expect(columns?.replace("minmax(0, 1fr)", "")).not.toMatch(/\b1fr\b/);
    });
  }
});
