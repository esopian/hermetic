/**
 * The dev renderer's seams.
 *
 * Two files that must agree on the DevTools port and cannot import each
 * other: `packages/app/renderer.ts` (which the build reads) and
 * `scripts/app-cdp.ts` (which attaches to it; scripts may not import a head).
 * And the page itself, which CEF does not receive untouched: Electrobun's
 * response filter places its preload after the first literal head start tag
 * in the document's bytes, prepending a whole prefix — before the doctype,
 * into quirks mode — when it finds none.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as renderer from "../packages/app/renderer.ts";
import * as appCdp from "../scripts/app-cdp.ts";

const ROOT = join(import.meta.dir, "..");

describe("DevTools port", () => {
  test("the build and the driver agree on the variable and the default", () => {
    expect(appCdp.CDP_PORT_ENV).toBe(renderer.CDP_PORT_ENV);
    expect(appCdp.DEFAULT_CDP_PORT).toBe(renderer.DEFAULT_CDP_PORT);
  });

  test("the driver reads --port, then the environment, then the default", () => {
    expect(appCdp.resolvePort(["snapshot"], {})).toBe(renderer.DEFAULT_CDP_PORT);
    expect(appCdp.resolvePort(["snapshot"], { [appCdp.CDP_PORT_ENV]: "9444" })).toBe(9444);
    expect(appCdp.resolvePort(["--port", "9555"], { [appCdp.CDP_PORT_ENV]: "9444" })).toBe(9555);
  });
});

describe("packages/ui/index.html under CEF", () => {
  const html = readFileSync(join(ROOT, "packages/ui/index.html"), "utf8");

  test("opens with the doctype", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  test("has exactly one literal head start tag, and it is real markup", () => {
    expect(html.split("<head>").length - 1).toBe(1);
    // Not inside a comment: every comment opened before the tag is closed before it.
    const before = html.slice(0, html.indexOf("<head>"));
    expect(before.lastIndexOf("<!--")).toBeLessThanOrEqual(before.lastIndexOf("-->"));
  });
});

describe("snapshot formatting", () => {
  test("folds ignored, structural and repeated text nodes", () => {
    const out = appCdp.formatAxTree([
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "hermetic" }, childIds: ["2"] },
      { nodeId: "2", role: { value: "generic" }, childIds: ["3", "5", "7"] },
      {
        nodeId: "3",
        role: { value: "button" },
        name: { value: "CHAT" },
        childIds: ["4"],
        properties: [
          { name: "pressed", value: { value: true } },
          { name: "disabled", value: { value: false } },
        ],
      },
      { nodeId: "4", role: { value: "StaticText" }, name: { value: "CHAT" } },
      { nodeId: "5", ignored: true, role: { value: "none" }, childIds: ["6"] },
      { nodeId: "6", role: { value: "StaticText" }, name: { value: "loose  text" } },
      { nodeId: "7", role: { value: "textbox" }, name: { value: "Filter" }, value: { value: "atl" } },
    ]);
    expect(out).toBe(
      [
        'RootWebArea "hermetic"',
        '  button "CHAT" [pressed]',
        '  text "loose text"',
        '  textbox "Filter" = "atl"',
      ].join("\n"),
    );
  });

  test("a CSS target is passed through as a JSON string literal", () => {
    expect(appCdp.findExpression('button[aria-label="x"]')).toBe(
      'document.querySelector("button[aria-label=\\"x\\"]")',
    );
  });

  test("a target cannot close a script element or break the line", () => {
    const expression = appCdp.findExpression("text=</script> ");
    expect(expression).not.toContain("</script>");
    expect(expression).not.toContain(" ");
    expect(appCdp.jsStringLiteral("</a> ")).toBe('"\\u003C\\u002Fa\\u003E\\u2028"');
    expect(JSON.parse(appCdp.jsStringLiteral('a</b>\n \\"'))).toBe('a</b>\n \\"');
  });
});
