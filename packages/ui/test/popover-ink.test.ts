/**
 * The fleet popover's ink.
 *
 * `FleetMenu` draws its `Popover` inside `.envstrip`, not in a portal, and the
 * strip sets a fixed near-black ink for its coloured band. That near-black is
 * also the dark theme's `--bg`, which is the popover's background — so a
 * popover with no `color` of its own inherited the strip's and drew every value
 * (the frozen target, the fleet names, the switch confirm) invisible on it.
 *
 * Read off the stylesheet text because happy-dom has no cascade worth asserting
 * against: the premise (the strip's ink) and the fix (the popover's own) are
 * both declarations, and this pins the pair.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../src/styles/styles.css", import.meta.url), "utf8");

/** The body of the one top-level rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const start = CSS.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  const open = CSS.indexOf("{", start);
  return CSS.slice(open + 1, CSS.indexOf("}", open));
}

/** The declarations of a rule body, comments dropped. */
function colorOf(body: string): string | null {
  const bare = body.replace(/\/\*[\s\S]*?\*\//g, "");
  return /(?:^|[;\s])color:\s*([^;]+);/.exec(bare)?.[1]?.trim() ?? null;
}

describe("fleet popover ink", () => {
  test("the env strip's ink is the dark theme's background", () => {
    // The premise: if the strip stops hard-coding this, the test below is no
    // longer the guard it was written to be, and should be re-read.
    expect(colorOf(ruleBody(".envstrip"))).toBe("#0e0e0d");
  });

  test("the popover sets its own ink rather than inheriting the strip's", () => {
    expect(colorOf(ruleBody(".popover"))).toBe("var(--fg)");
  });
});
