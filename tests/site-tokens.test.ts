/**
 * Seam: `site/src/styles/tokens.css` must carry the dark token set from
 * `docs/ui-brief.md` ("Look", the `dark :` line) verbatim. Files only, no
 * imports from `packages/` — the site is not a workspace, and this test does
 * not need it to be one; it reads both documents as text, the same way a
 * reader diffing them by hand would.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

type Token = [name: string, value: string];

/** Parses `--name:value --name2:value2 ...` (ui-brief's space-separated form). */
export function parseBriefLine(line: string): Token[] {
  const matches = line.matchAll(/--([\w-]+)\s*:\s*(\S+)/g);
  return [...matches].map(([, name, value]) => [name as string, value as string]);
}

/** Pulls the `dark :` token line out of ui-brief's fenced token block. */
export function parseUiBrief(text: string): Token[] {
  const line = text.split("\n").find((l) => /^dark\s*:/.test(l.trim()));
  if (line === undefined) throw new Error('docs/ui-brief.md: no "dark :" token line found');
  return parseBriefLine(line.trim().replace(/^dark\s*:\s*/, ""));
}

/**
 * Pulls the `--bg`..`--sel` declarations out of tokens.css's first `:root`
 * block only — the second `:root` (further down) carries `--sans`/`--mono`/
 * `--max`, which have no counterpart in ui-brief and are not part of this seam.
 */
export function parseTokensCss(text: string): Token[] {
  const match = text.match(/:root\s*\{([^}]*)\}/);
  if (match?.[1] === undefined) throw new Error("tokens.css: no :root block found");
  const matches = match[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g);
  return [...matches].map(([, name, value]) => [name as string, (value as string).trim()]);
}

describe("site design tokens match docs/ui-brief.md", () => {
  test("dark palette in site/src/styles/tokens.css equals the ui-brief dark line", () => {
    const brief = parseUiBrief(readFileSync(join(ROOT, "docs/ui-brief.md"), "utf8"));
    const css = parseTokensCss(readFileSync(join(ROOT, "site/src/styles/tokens.css"), "utf8"));
    expect(css).toEqual(brief);
  });
});

describe("parsers are not accidentally vacuous", () => {
  test("parseBriefLine reads a mutated token apart correctly", () => {
    expect(parseBriefLine("--bg:#000000 --fg:#ffffff")).toEqual([
      ["bg", "#000000"],
      ["fg", "#ffffff"],
    ]);
  });

  test("parseTokensCss ignores a second :root block and stops at the closing brace", () => {
    const css = `
      :root {
        --bg: #111111;
        --fg: #222222;
      }
      :root {
        --sans: "Archivo", sans-serif;
      }
    `;
    expect(parseTokensCss(css)).toEqual([
      ["bg", "#111111"],
      ["fg", "#222222"],
    ]);
  });

  test("a drifted value is caught, not silently matched", () => {
    const brief = parseBriefLine("--bg:#0e0e0d --fg:#f1efe9");
    const css = parseTokensCss(":root { --bg: #0e0e0d; --fg: #ffffff; }");
    expect(css).not.toEqual(brief);
  });
});
