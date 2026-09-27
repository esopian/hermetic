/**
 * `@hermetic/core/shared` is the one door into core the browser may open, so
 * everything reachable through it must run there: no `node:*`, no `bun:*`, no
 * AWS client, no `process.env`. The rest of core is off limits to the UI for
 * exactly this reason, and a single stray import — a helper moved into a file
 * that also opens a socket — would take the boundary with it, silently, in a
 * bundle that still builds.
 *
 * Checked by walking the import graph from `shared/index.ts` with the same
 * transpiler `tests/boundaries.test.ts` uses, so a specifier is read by a
 * parser rather than a regex; `process.env` is a text search because it is an
 * expression, not an import.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(ROOT, "src/shared/index.ts");
const TS = new Bun.Transpiler({ loader: "ts" });

/**
 * Everything a browser bundle cannot carry — and `zod`, which it could carry
 * but must not: a schema module's top-level `z.object()` calls are not
 * tree-shakeable, so one value edge into `schema/*` drags the whole schema
 * tree and zod itself into the page (measured at +400 KB). `shared/*` holds
 * the plain values; `schema/*` imports them, never the reverse.
 */
const FORBIDDEN: ReadonlyArray<{ name: string; test: (spec: string) => boolean }> = [
  { name: "node builtin", test: (s) => s.startsWith("node:") },
  { name: "bun builtin", test: (s) => s === "bun" || s.startsWith("bun:") },
  { name: "aws sdk", test: (s) => s.startsWith("@aws-sdk/") || s.startsWith("@smithy/") },
  { name: "zod", test: (s) => s === "zod" || s.startsWith("zod/") },
  { name: "schema module", test: (s) => /(^|\/)schema(\/|$)/.test(s) },
  // Anything that is not a relative import: a bare builtin (`fs`), a package the
  // page would have to bundle, a URL. shared/ imports only its own siblings.
  { name: "non-relative import", test: (s) => !s.startsWith(".") },
];

/**
 * `import type` is elided by `scanImports`, which is right for the bundle
 * question (a type pulls no code) and wrong for the direction question: a
 * `shared` module that even *names* a schema type has made schema its
 * upstream. Same trick as `tests/boundaries.test.ts`: strip the `type`
 * modifiers and scan again, so both edges are seen.
 */
const IMPORT_CLAUSE = /\b(import|export)\b([^;'"`]*?)\bfrom\b(?=\s*["'])/g;
function withTypes(source: string): string {
  return source.replace(
    IMPORT_CLAUSE,
    (_m, keyword: string, clause: string) => `${keyword}${clause.replace(/\btype\s+/g, "")}from`,
  );
}

function specifiers(path: string): string[] {
  return TS.scanImports(withTypes(readFileSync(path, "utf8"))).map((i) => i.path);
}

/** Every module reachable from the entry, by relative import, in walk order. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const spec of specifiers(path)) {
      if (spec.startsWith(".")) queue.push(resolve(dirname(path), spec));
    }
  }
  return [...seen];
}

describe("@hermetic/core/shared is browser-safe", () => {
  const modules = reachable(ENTRY);

  test("reaches something, and nothing outside src/", () => {
    expect(modules.length).toBeGreaterThan(3);
    for (const path of modules) expect(relative(ROOT, path)).toStartWith("src/");
  });

  test("no module it reaches imports a node, bun, AWS, zod or schema module", () => {
    const offences: string[] = [];
    for (const path of modules) {
      for (const spec of specifiers(path)) {
        const hit = FORBIDDEN.find((f) => f.test(spec));
        if (hit) offences.push(`${relative(ROOT, path)} imports ${spec} (${hit.name})`);
      }
    }
    expect(offences).toEqual([]);
  });

  test("no module it reaches reads process.env", () => {
    const offences = modules
      .filter((path) => /\bprocess\.env\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path));
    expect(offences).toEqual([]);
  });

  test("the walk is not vacuous: the forbidden list catches core's own AWS layer", () => {
    // If `shared/index.ts` ever re-exported from `aws/`, this is what would fire.
    const bad = reachable(join(ROOT, "src/aws/client.ts")).flatMap((path) =>
      specifiers(path).filter((spec) => FORBIDDEN.some((f) => f.test(spec))),
    );
    expect(bad.length).toBeGreaterThan(0);
  });

  test("and it catches the schema door, both as a value and as a type", () => {
    // `schema/index.ts` imports zod on its first line; a `shared` module that
    // re-exported from it would be the +400 KB regression this file exists for.
    const viaSchema = reachable(join(ROOT, "src/schema/index.ts")).flatMap((path) =>
      specifiers(path).filter((spec) => spec === "zod"),
    );
    expect(viaSchema.length).toBeGreaterThan(0);
    expect(FORBIDDEN.some((f) => f.test("../schema/agent.ts"))).toBe(true);
    expect(FORBIDDEN.some((f) => f.test("./schema/errors.ts"))).toBe(true);
    expect(FORBIDDEN.some((f) => f.test("../errors.ts"))).toBe(false);
  });

  test("the direction holds: schema imports shared, and core's schema door still opens", () => {
    // Every value `shared/index.ts` exports is reachable from `schema/index.ts`
    // too, because schema re-exports it — so nothing outside core had to move.
    const schemaReach = new Set(reachable(join(ROOT, "src/schema/index.ts")));
    for (const path of modules) {
      if (path.endsWith("/shared/index.ts") || path.endsWith("/tailscale-urls.ts")) continue;
      expect(schemaReach.has(path), relative(ROOT, path)).toBe(true);
    }
  });

  test("the exports map opens the door this test guards", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./shared"]).toBe("./src/shared/index.ts");
  });
});
