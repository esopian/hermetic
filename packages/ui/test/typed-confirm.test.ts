/**
 * The one typed-confirmation control, and the comparison behind it.
 *
 * Three drawers had hand-rolled this and the three had drifted — different
 * classes, different disabled opacities, and the agent drawer's had no live
 * feedback at all, so a mistyped name showed only as a button that stayed grey.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TypedConfirm, confirmMatches } from "../src/components/TypedConfirm.tsx";

describe("confirmMatches", () => {
  test("exact after trimming — this is a value copied off the screen, not a search", () => {
    expect(confirmMatches("vol-1", "vol-1")).toBe(true);
    expect(confirmMatches("  vol-1  ", "vol-1")).toBe(true);
    expect(confirmMatches("vol-11", "vol-1")).toBe(false);
    expect(confirmMatches("VOL-1", "vol-1")).toBe(false);
  });

  /**
   * The teardown drawer mounts before its plan lands, so `expected` is "" for a
   * beat. An empty box must not read as a confirmed one.
   */
  test("nothing confirms nothing", () => {
    expect(confirmMatches("", "")).toBe(false);
    expect(confirmMatches("   ", "")).toBe(false);
    expect(confirmMatches("", "vol-1")).toBe(false);
  });
});

function html(value: string, expected = "lumen"): string {
  return renderToStaticMarkup(
    createElement(TypedConfirm, {
      label: "Type lumen to confirm",
      expected,
      value,
      onChange: () => {},
      hint: "the agent's name, exactly · lumen",
    }),
  );
}

describe("TypedConfirm", () => {
  test("says nothing has matched yet, in the hint the caller gave it", () => {
    const out = html("lume");
    expect(out).toContain("the agent&#x27;s name, exactly");
    expect(out).not.toContain(">matches<");
    expect(out).toContain("td-hint");
  });

  test("says `matches` the moment it does, and switches to the ok colour class", () => {
    const out = html("lumen");
    expect(out).toContain("matches");
    expect(out).toContain("td-hint-ok");
  });

  test("the verdict announces itself rather than only changing colour", () => {
    // The agent drawer's confirm had no live feedback at all; a colour swap
    // alone is not one either.
    expect(html("lumen")).toContain('aria-live="polite"');
  });

  test("carries the shared input class every other confirm box uses", () => {
    expect(html("")).toContain('class="name-input"');
  });
});
