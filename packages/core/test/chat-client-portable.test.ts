/**
 * `@hermetic/core/chat-client` runs off the laptop: on the phone's JavaScript
 * engine and inside hermeticd. Everything reachable through it must therefore
 * run without node, bun or AWS, read no environment, and never reach the
 * laptop's transport or state — `chat-transport.ts`, `chat/chat.ts`,
 * `backend/`, `aws/`, `local/`, the node renderers. One stray import (a helper
 * moved into a file that also opens a database) would break the phone's Metro
 * bundle at best and, at worst, ship a code path that only fails on a device.
 *
 * Same walker as `shared-browser-safe.test.ts`: the import graph from the door,
 * read by `Bun.Transpiler` with `import type` counted, because a type edge into
 * a laptop module today is the value edge of tomorrow. Zod is allowed here
 * (the adapter validates with it); `process.env` is a text search because it
 * is an expression, not an import.
 *
 * `@hermetic/core/chat-client-fixture` is held to the same rules, except that
 * the canned client lives in `backend/fixture/` and may reach it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DOOR = join(ROOT, "src/chat-client.ts");
const FIXTURE_DOOR = join(ROOT, "src/chat-client-fixture.ts");
const TS = new Bun.Transpiler({ loader: "ts" });

/** Bare specifiers the closure may import: zod and nothing else. */
const BARE_ALLOWED = new Set(["zod"]);

const FORBIDDEN_SPECS: ReadonlyArray<{ name: string; test: (spec: string) => boolean }> = [
  { name: "node builtin", test: (s) => s.startsWith("node:") },
  { name: "bun builtin", test: (s) => /^bun(:|$)/.test(s) },
  { name: "aws sdk", test: (s) => s.startsWith("@aws-sdk/") || s.startsWith("@smithy/") },
  { name: "sqlite", test: (s) => s.includes("sqlite") },
  {
    name: "bare node builtin",
    test: (s) => /^(fs|os|path|child_process)(\/|$)/.test(s),
  },
  {
    name: "third-party package",
    test: (s) => !s.startsWith(".") && !s.startsWith("/") && !BARE_ALLOWED.has(s),
  },
];

/** Modules, by `src/`-relative path or prefix, the closure must never reach. */
const UNREACHABLE: readonly string[] = [
  "src/chat-transport.ts",
  "src/chat/chat-transport.ts",
  "src/chat/chat.ts",
  "src/backend/",
  "src/aws/",
  "src/local/",
  "src/render/render.ts",
  "src/render/render-browser.ts",
];

/** See `shared-browser-safe.test.ts`: strip `type` so type-only edges are walked too. */
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

const rel = (path: string): string => relative(ROOT, path);

function specOffences(modules: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of modules) {
    for (const spec of specifiers(path)) {
      const hit = FORBIDDEN_SPECS.find((f) => f.test(spec));
      if (hit) out.push(`${rel(path)} imports ${spec} (${hit.name})`);
    }
  }
  return out;
}

function reachOffences(modules: readonly string[], allowed: readonly string[] = []): string[] {
  return modules
    .map(rel)
    .filter((path) => !allowed.some((a) => path.startsWith(a)))
    .filter((path) => UNREACHABLE.some((u) => (u.endsWith("/") ? path.startsWith(u) : path === u)));
}

function envOffences(modules: readonly string[]): string[] {
  return modules.filter((path) => /\bprocess\.env\b/.test(readFileSync(path, "utf8"))).map(rel);
}

describe("@hermetic/core/chat-client is portable", () => {
  const modules = reachable(DOOR);

  test("reaches the adapter, and nothing outside src/", () => {
    const paths = modules.map(rel);
    expect(paths).toContain("src/chat/hermes/hermes-chat.ts");
    expect(paths).toContain("src/chat/chat-observe.ts");
    expect(paths).toContain("src/chat/chat-redact.ts");
    for (const path of paths) expect(path).toStartWith("src/");
  });

  test("no module it reaches imports node, bun, AWS, sqlite or a package other than zod", () => {
    expect(specOffences(modules)).toEqual([]);
  });

  test("no module it reaches reads process.env", () => {
    expect(envOffences(modules)).toEqual([]);
  });

  test("it never reaches the laptop's transport, backends, AWS, state or node renderers", () => {
    expect(reachOffences(modules)).toEqual([]);
  });
});

describe("@hermetic/core/chat-client-fixture is portable", () => {
  const modules = reachable(FIXTURE_DOOR);

  test("reaches the canned client, and nothing outside src/", () => {
    const paths = modules.map(rel);
    expect(paths).toContain("src/backend/fixture/fixture-chat.ts");
    for (const path of paths) expect(path).toStartWith("src/");
  });

  test("no module it reaches imports node, bun, AWS, sqlite or a package other than zod", () => {
    expect(specOffences(modules)).toEqual([]);
  });

  test("no module it reaches reads process.env", () => {
    expect(envOffences(modules)).toEqual([]);
  });

  test("outside backend/fixture/, it reaches nothing the real door may not", () => {
    expect(reachOffences(modules, ["src/backend/fixture/"])).toEqual([]);
  });
});

describe("the walk is not vacuous", () => {
  test("the desktop transport reaches backend/fixture, which the real door must not", () => {
    // `chat-transport.ts` picks between the fixture and the real adapter, so it
    // is exactly the module a careless re-export would drag in.
    const transport = reachable(join(ROOT, "src/chat/chat-transport.ts"));
    expect(reachOffences(transport).some((p) => p.startsWith("src/backend/fixture/"))).toBe(true);
  });

  test("the forbidden list catches core's own AWS layer", () => {
    expect(specOffences(reachable(join(ROOT, "src/aws/client.ts"))).length).toBeGreaterThan(0);
  });
});

/**
 * Runtime globals the adapter uses that the phone's engine may lack. The phone
 * installs a polyfill for each when it is absent (`mobile/src/gateway/polyfills.ts`).
 * The file list is explicit so a new use is a deliberate change: whoever adds
 * one updates this list and checks the polyfill covers it. Comments are
 * stripped first, so prose naming a global does not count.
 */
const POLYFILLED_GLOBALS = ["AbortSignal.timeout", "AbortSignal.any", "structuredClone"] as const;

const EXPECTED_GLOBAL_USES: Record<(typeof POLYFILLED_GLOBALS)[number], readonly string[]> = {
  "AbortSignal.timeout": [
    "src/chat/hermes/hermes-chat-resume.ts",
    "src/chat/hermes/hermes-chat-session-socket.ts",
  ],
  "AbortSignal.any": [
    "src/chat/hermes/hermes-chat-resume.ts",
    "src/chat/hermes/hermes-chat-session-socket.ts",
  ],
  structuredClone: ["src/chat/hermes/hermes-chat-subagent.ts"],
};

const expectedUses = (): Record<string, string[]> =>
  Object.fromEntries(Object.entries(EXPECTED_GLOBAL_USES).map(([k, v]) => [k, [...v].sort()]));

function globalUses(modules: readonly string[]): Record<string, string[]> {
  const code = new Map(
    modules.map((path) => [rel(path), TS.transformSync(readFileSync(path, "utf8"))]),
  );
  const out: Record<string, string[]> = {};
  for (const name of POLYFILLED_GLOBALS) {
    const pattern = new RegExp(`\\b${name.replace(".", "\\s*\\.\\s*")}\\b`);
    out[name] = [...code]
      .filter(([, text]) => pattern.test(text))
      .map(([path]) => path)
      .sort();
  }
  return out;
}

describe("runtime globals the phone must polyfill", () => {
  test("the real door uses them in exactly these files", () => {
    expect(globalUses(reachable(DOOR))).toEqual(expectedUses());
  });

  test("the fixture door adds no use of its own", () => {
    expect(globalUses(reachable(FIXTURE_DOOR))).toEqual(expectedUses());
  });

  test("the scan sees a use, and ignores one named only in a comment", () => {
    const pattern = /\bstructuredClone\b/;
    expect(pattern.test(TS.transformSync("export const a = structuredClone({});"))).toBe(true);
    expect(pattern.test(TS.transformSync("// structuredClone\nexport const a = 1;"))).toBe(false);
  });
});

test("the exports map opens both doors this test guards", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    exports: Record<string, string>;
  };
  expect(pkg.exports["./chat-client"]).toBe("./src/chat-client.ts");
  expect(pkg.exports["./chat-client-fixture"]).toBe("./src/chat-client-fixture.ts");
});
