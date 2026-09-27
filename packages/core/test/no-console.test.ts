import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src", import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const FILES = walk(SRC).filter((f) => f.endsWith(".ts"));

/** Comments describe the rules; only real code may break them. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * §3.2 rule 1: core never talks to a human. Each of these is easy to break under
 * time pressure, which is why it is a test rather than a convention.
 */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["console.*", /\bconsole\s*\./],
  ["process.exit", /\bprocess\s*\.\s*exit\b/],
  ["process.stdout", /\bprocess\s*\.\s*stdout\b/],
  ["process.stderr", /\bprocess\s*\.\s*stderr\b/],
  ["Bun.stdout", /\bBun\s*\.\s*stdout\b/],
  ["prompts", /@clack\/prompts/],
  ["process.env.AWS_PROFILE", /process\s*\.\s*env\s*(\.\s*AWS_PROFILE|\[\s*["']AWS_PROFILE)/],
];

describe("core never talks to a human", () => {
  test("there are source files to check", () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  for (const [label, pattern] of FORBIDDEN) {
    test(`no ${label} anywhere in packages/core/src`, () => {
      const hits = FILES.filter((f) => pattern.test(code(f)));
      expect(hits.map((h) => h.slice(SRC.length + 1))).toEqual([]);
    });
  }

  test("core exports HermeticError rather than throwing bare strings", () => {
    for (const file of FILES) {
      const text = code(file);
      // `throw new Error(...)` is allowed in exactly four places: the render
      // guard, which is a programmer error rather than an operator-facing
      // failure; `orderStages` in `shared/release.ts`, which `agentd` also calls — it
      // cannot depend on core's error type, so its caller wraps it; and the two
      // mirrors, whose transport failures never leave the module at all
      // (`ensureHermesMirror` and `ensureBrowserMirror` catch every one and
      // return a warning, because a mirror that cannot be refreshed must not
      // stop a push). What *does* leave `browser-mirror.ts` is a
      // `HermeticError`: bytes that are not the pinned build are not a
      // transient, and it is deliberately the one thing that is not caught.
      const bare = [...text.matchAll(/throw new Error\(/g)];
      if (bare.length > 0) {
        expect(
          file.endsWith("render.ts") ||
            file.endsWith("shared/release.ts") ||
            file.endsWith("hermes-mirror.ts") ||
            file.endsWith("browser-mirror.ts"),
        ).toBe(true);
      }
    }
  });
});
