/**
 * An op drawer holds still while its op runs: only the log scrolls.
 *
 * The foundation update, network, policy and teardown drawers put `op-body` on
 * their `.drawer-body` once an op has started (the flow tests check the class
 * is there). Before that rule existed the body itself was the scroller, so the
 * log grew by a line per event and carried the progress header, the step list
 * and the callout off the top. The agent drawer's op rail had the same problem
 * from the other side: uncapped, it ate the section below it.
 *
 * Read off the stylesheet text because happy-dom does no layout: the fix is a
 * set of declarations, and this pins them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function sheet(name: string): string {
  const text = readFileSync(new URL(`../src/styles/${name}`, import.meta.url), "utf8");
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

const styles = sheet("styles.css");

describe("an op drawer's progress stage", () => {
  test("the body is a flex column that only scrolls as a fallback", () => {
    // Three classes, so it outranks `polish.css`'s short-window
    // `.drawer > .drawer-body`, which lets a body grow to its content.
    const body = ruleBody(styles, ".drawer > .drawer-body.op-body");
    expect(declaration(body, "display")).toBe("flex");
    expect(declaration(body, "flex-direction")).toBe("column");
    expect(declaration(body, "flex")).toBe("1 1 auto");
    expect(declaration(body, "overflow")).toBe("auto");
  });

  test("the stage and the progress block fill the body instead of sizing to the log", () => {
    // The progress block takes a zero basis and an explicit minimum: sized to
    // content it would be the log's full text height, which is the bug. The
    // stage around it grows from its content, so a tall result below the
    // block lengthens the stage rather than spilling out of it.
    const stage = ruleBody(styles, ".op-body > .td-stage");
    expect(declaration(stage, "flex")).toBe("1 0 auto");
    const progress = ruleBody(styles, ".op-body .wiz-progress");
    expect(declaration(progress, "flex")).toBe("1 1 0");
    expect(declaration(progress, "min-height")).toMatch(/^\d+px$/);
  });

  test("the log takes the rest and keeps a minimum; the step list gives way first", () => {
    const log = ruleBody(styles, ".op-body .wiz-progress .progress-log");
    expect(declaration(log, "flex")).toBe("1 1 0");
    expect(declaration(log, "min-height")).toBe("120px");
    // `.logpane` is the scroll container (`overflow: auto`) the log inherits.
    expect(declaration(ruleBody(styles, ".logpane"), "overflow")).toBe("auto");
    const steps = ruleBody(styles, ".op-body .wiz-progress .steps");
    expect(declaration(steps, "flex")).toBe("0 1 auto");
    expect(declaration(steps, "overflow-y")).toBe("auto");
  });
});

describe("the agent drawer's op rail", () => {
  test("caps its steps and log, and as a whole leaves room for the section", () => {
    expect(declaration(ruleBody(styles, ".drawer-op .steps"), "max-height")).toMatch(/px$/);
    expect(declaration(ruleBody(styles, ".drawer-op .progress-log"), "max-height")).toMatch(/px$/);
    const rail = ruleBody(sheet("drawer.css"), ".dr-main > .drawer-op");
    expect(declaration(rail, "max-height")).toMatch(/%$/);
    expect(declaration(rail, "overflow-y")).toBe("auto");
  });
});
