import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * The scanned scope is each package's `src` tree, which is what this file has
 * always checked. Package `test` trees are deliberately out of scope: a test
 * may legitimately import across an edge its package's source may not — the
 * root `tests/` directory exists precisely so seam tests can read both sides —
 * and a boundary that only holds in `src` is still the boundary that ships.
 */
function sources(pkg: string): string[] {
  return walk(join(ROOT, "packages", pkg, "src")).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".tsx"),
  );
}

/**
 * The phone app (`mobile/`) is not a workspace package, but it is a head with a
 * row in the matrix: its shipped code is `mobile/src` and the Expo Router screens
 * in `mobile/app`. Its `test` tree is out, for the same reason as the packages'.
 */
function mobileSources(): string[] {
  return [...walk(join(ROOT, "mobile", "src")), ...walk(join(ROOT, "mobile", "app"))].filter(
    (f) => f.endsWith(".ts") || f.endsWith(".tsx"),
  );
}

/** The build/lint scripts, which are outside every package and import core directly. */
function scriptSources(): string[] {
  return walk(join(ROOT, "scripts")).filter((f) => f.endsWith(".ts"));
}

// ---------------------------------------------------------------------------
// Collecting specifiers
// ---------------------------------------------------------------------------

/** One import/export specifier as written, with whether it carries values. */
type Specifier = { spec: string; typeOnly: boolean };

/** A file handed to the checker: real ones are read from disk, synthetic ones are literals. */
type SourceFile = { path: string; source: string };

const TS = new Bun.Transpiler({ loader: "ts" });
const TSX = new Bun.Transpiler({ loader: "tsx" });

/**
 * Bun's transpiler elides type-only imports, which is exactly what a bundler
 * should do and exactly what a boundary check must not: `import type { X } from
 * "@hermetic/core"` inside the UI is still the UI depending on core's shape.
 *
 * So the file is scanned twice — once as written, once with the `type`
 * modifiers removed from import/export clauses — and a specifier present only
 * in the second scan is type-only. The rewrite is scoped to the text between an
 * `import`/`export` keyword and its `from`, so a `type Foo = …` declaration
 * elsewhere in the file is untouched; the specifiers themselves are still read
 * by the parser, never by a regex.
 */
const IMPORT_CLAUSE = /\b(import|export)\b([^;'"`]*?)\bfrom\b(?=\s*["'])/g;

function stripTypeModifiers(source: string): string {
  return source.replace(
    IMPORT_CLAUSE,
    (_match, keyword: string, clause: string) => `${keyword}${clause.replace(/\btype\s+/g, "")}from`,
  );
}

function scan(transpiler: Bun.Transpiler, path: string, source: string): string[] {
  // `scanImports` rejects a shebang the way it rejects a syntax error, and the
  // CLI's entry point has one.
  const text = source.replace(/^#![^\n]*/, "");
  try {
    return transpiler.scanImports(text).map((i) => i.path);
  } catch (error) {
    // A file the transpiler cannot parse is a compile error the typecheck will
    // report; it must not silently pass the boundary check as "no imports".
    throw new Error(`could not parse ${path}: ${String(error)}`);
  }
}

/**
 * Every module specifier imported, re-exported, dynamically imported or
 * `require`d by a file — static and type-only alike.
 */
function specifiersOf(file: SourceFile): Specifier[] {
  const transpiler = file.path.endsWith(".tsx") ? TSX : TS;
  const withValues = scan(transpiler, file.path, file.source);
  const all = scan(transpiler, file.path, stripTypeModifiers(file.source));

  // Same specifier can appear both ways in one file; count rather than set.
  const remaining = new Map<string, number>();
  for (const spec of withValues) remaining.set(spec, (remaining.get(spec) ?? 0) + 1);

  return all.map((spec) => {
    const left = remaining.get(spec) ?? 0;
    if (left > 0) {
      remaining.set(spec, left - 1);
      return { spec, typeOnly: false };
    }
    return { spec, typeOnly: true };
  });
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const PACKAGES = ["core", "cli", "app", "ui", "agentd"] as const;
type Pkg = (typeof PACKAGES)[number];

/** A row of the matrix: a package, or the phone app, which imports but is never imported. */
type From = Pkg | "mobile";

/**
 * A column of the matrix: a package, plus each of core's four subpath doors as
 * its own column — `schema` (the Zod schemas, the types), `shared` (the
 * browser-safe pure values and helpers the UI and hermeticd need verbatim),
 * `chat-client` (the Hermes chat adapter, portable to the phone and the box) and
 * `chat-client-fixture` (the canned chat client, for the phone's fixture mode).
 */
type Target = Pkg | "core/schema" | "core/shared" | "core/chat-client" | "core/chat-client-fixture";

/**
 * `value` allows both value and type imports; `type` allows type-only imports
 * alone; `fixture` allows both, but only from a file under `FIXTURE_DIR`.
 */
type Allowance = "value" | "type" | "fixture";

/** The one directory of the phone app that may open the fixture chat door. */
const FIXTURE_DIR = "mobile/src/fixture/";

/**
 * The matrix from AGENTS.md, "Import boundaries", as data. A missing entry is a
 * forbidden edge. Same-package edges (the table's `—`) are internal and never
 * consulted.
 *
 * | From \ May import | core | core/schema | core/shared | core/chat-client | core/chat-client-fixture | cli | app | ui | agentd |
 * |---|---|---|---|---|---|---|---|---|---|
 * | core    | —   | —   | —   | —   | —                | no | no    | no | no |
 * | cli     | yes | yes | yes | yes | no               | —  | no    | no | no |
 * | app     | yes | yes | yes | yes | no               | no | —     | no | no |
 * | ui      | no  | no  | yes | no  | no               | no | types | —  | no |
 * | agentd  | no  | yes | yes | yes | no               | no | no    | no | —  |
 * | mobile  | no  | yes | yes | yes | fixture dir only | no | no    | no | no |
 */
const ALLOWED: Record<From, Partial<Record<Target, Allowance>>> = {
  core: {},
  cli: { core: "value", "core/schema": "value", "core/shared": "value", "core/chat-client": "value" },
  app: { core: "value", "core/schema": "value", "core/shared": "value", "core/chat-client": "value" },
  // The UI ships to a browser. `core/shared` is the one value door it may
  // open, and `packages/core/test/shared-browser-safe.test.ts` keeps what is
  // behind it free of node, bun and AWS code. The app edge is types only,
  // and a devDependency: not a byte of the app may reach the bundle.
  ui: { app: "type", "core/shared": "value" },
  // hermeticd's push watcher drives its own box's gateway through the same
  // chat adapter the desktop and the phone use.
  agentd: { "core/schema": "value", "core/shared": "value", "core/chat-client": "value" },
  // The phone talks to the boxes directly, through the portable doors only
  // (`packages/core/test/chat-client-portable.test.ts`). The canned chat client
  // is for its fixture mode, so only `mobile/src/fixture/` may open that door.
  mobile: {
    "core/schema": "value",
    "core/shared": "value",
    "core/chat-client": "value",
    "core/chat-client-fixture": "fixture",
  },
};

/**
 * Core's `exports` map, mirrored here so a specifier naming a door core does not
 * open is reported as such rather than silently resolving to the `core` column.
 */
const CORE_SUBPATHS: Record<string, Target> = {
  "": "core",
  schema: "core/schema",
  shared: "core/shared",
  "chat-client": "core/chat-client",
  "chat-client-fixture": "core/chat-client-fixture",
};

/**
 * A violation the tree may keep while someone decides what to do about it.
 * Empty, and meant to stay that way — every entry is a boundary not enforced.
 */
const ALLOW_LIST: ReadonlyArray<{ file: string; spec: string }> = [];

type Violation = {
  /** Repo-relative path of the importing file. */
  file: string;
  /** The specifier exactly as written. */
  spec: string;
  /** `from → to`, e.g. `agentd → core`. */
  edge: string;
  reason: string;
};

function packageOf(absolute: string): Pkg | null {
  const prefix = join(ROOT, "packages") + sep;
  if (!absolute.startsWith(prefix)) return null;
  const name = absolute.slice(prefix.length).split(sep)[0];
  return PACKAGES.find((p) => p === name) ?? null;
}

/** The matrix row a source file belongs to: its package, or the phone app. */
function rowOf(absolute: string): From | null {
  if (absolute.startsWith(join(ROOT, "mobile") + sep)) return "mobile";
  return packageOf(absolute);
}

/** The file a relative, absolute or `file://` specifier names, or `null` for a bare one. */
function pathOf(file: string, spec: string): string | null {
  if (spec.startsWith("file://")) return fileURLToPath(spec);
  if (spec.startsWith("/")) return spec;
  if (spec.startsWith(".")) return resolve(dirname(file), spec);
  return null;
}

/** Where a specifier lands, or `null` if it leaves the workspace entirely. */
type Resolved = { target: Target; known: boolean };

function resolveTarget(file: string, spec: string): Resolved | null {
  if (spec.startsWith("@hermetic/")) {
    const [name, ...rest] = spec.slice("@hermetic/".length).split("/");
    const pkg = PACKAGES.find((p) => p === name);
    if (!pkg) return null;
    if (pkg !== "core") return { target: pkg, known: rest.length === 0 };
    const sub = rest.join("/");
    const target = CORE_SUBPATHS[sub];
    // A deep path such as `@hermetic/core/index.ts` is not a door core opens,
    // so it counts against the `core` column *and* is reported as unknown.
    return target ? { target, known: true } : { target: "core", known: false };
  }

  const absolute = pathOf(file, spec);
  if (absolute === null) return null;

  const pkg = packageOf(absolute);
  // A relative or absolute path bypasses the `exports` map, so it can never
  // land in the `core/schema` column however deep into `src/schema` it reaches.
  return pkg ? { target: pkg, known: false } : null;
}

/**
 * The whole boundary check, over an explicit set of files rather than the repo,
 * so the negative cases below can run it on sources that do not exist on disk.
 */
function checkBoundaries(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    const from = rowOf(file.path);
    if (!from) continue;
    const relative = file.path.slice(ROOT.length);
    for (const { spec, typeOnly } of specifiersOf(file)) {
      // The phone is outside the workspace and resolves core through its
      // exports map alone: a path into `packages/` is refused whatever it
      // reaches, including a directory the matrix has no column for.
      const path = from === "mobile" ? pathOf(file.path, spec) : null;
      if (path?.startsWith(join(ROOT, "packages") + sep)) {
        const edge = `mobile → ${packageOf(path) ?? "packages"}`;
        out.push({ file: relative, spec, edge, reason: "mobile may not import a path into packages/" });
        continue;
      }
      const resolved = resolveTarget(file.path, spec);
      if (!resolved) continue;
      const { target, known } = resolved;
      if (target === from || (from === "core" && target.startsWith("core/"))) continue;
      if (ALLOW_LIST.some((a) => a.file === relative && a.spec === spec)) continue;

      const edge = `${from} → ${target}`;
      const allowance = ALLOWED[from][target];
      if (!allowance) {
        out.push({ file: relative, spec, edge, reason: `${edge} is not an allowed edge` });
        continue;
      }
      if (allowance === "fixture" && !relative.startsWith(FIXTURE_DIR)) {
        out.push({
          file: relative,
          spec,
          edge,
          reason: `${edge} is allowed only from ${FIXTURE_DIR}`,
        });
        continue;
      }
      if (allowance === "type" && !typeOnly) {
        out.push({
          file: relative,
          spec,
          edge,
          reason: `${edge} is allowed for types only, and this is a value import`,
        });
        continue;
      }
      if (!known) {
        out.push({
          file: relative,
          spec,
          edge,
          reason: `${spec} does not resolve through the package's exports map`,
        });
      }
    }
  }
  return out;
}

/** Every edge the checker actually saw, for the non-vacuity assertions. */
function observedEdges(files: readonly SourceFile[]): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    const from = rowOf(file.path);
    if (!from) continue;
    for (const { spec } of specifiersOf(file)) {
      const resolved = resolveTarget(file.path, spec);
      if (!resolved || resolved.target === from) continue;
      out.add(`${from} → ${resolved.target}`);
    }
  }
  return out;
}

function readPackage(pkg: Pkg): SourceFile[] {
  return sources(pkg).map((path) => ({ path, source: readFileSync(path, "utf8") }));
}

function allPackageSources(): SourceFile[] {
  return PACKAGES.flatMap(readPackage);
}

function readMobile(): SourceFile[] {
  return mobileSources().map((path) => ({ path, source: readFileSync(path, "utf8") }));
}

/** A synthetic phone-app file, by repo-relative path (`mobile/src/...`). */
function fakeMobile(path: string, source: string): SourceFile {
  return { path: join(ROOT, path), source };
}

/** A synthetic file, so the negative cases never touch the working tree. */
function fake(pkg: Pkg, name: string, source: string): SourceFile {
  return { path: join(ROOT, "packages", pkg, "src", name), source };
}

describe("workspace import boundaries", () => {
  test("every package has sources to check", () => {
    for (const pkg of PACKAGES) {
      expect(sources(pkg).length).toBeGreaterThan(0);
    }
    expect(mobileSources().length).toBeGreaterThan(0);
  });

  test("every import in every package, and in the phone app, obeys the matrix", () => {
    const violations = checkBoundaries([...allPackageSources(), ...readMobile()]);
    const report = violations.map((v) => `${v.file}: ${v.spec} — ${v.reason}`);
    expect(report).toEqual([]);
  });

  test("the allow-list is empty", () => {
    // Each entry here is a boundary the matrix describes but does not enforce.
    expect(ALLOW_LIST).toEqual([]);
  });

  /**
   * Not vacuous: the matrix would also pass over a tree where nothing crosses a
   * package edge at all, so the edges that are supposed to exist are named.
   */
  test("the allowed edges are really taken", () => {
    const edges = observedEdges(allPackageSources());
    for (const edge of [
      "cli → core",
      "app → core",
      "ui → app",
      "ui → core/shared",
      "agentd → core/schema",
      "agentd → core/shared",
    ] as const) {
      expect([...edges], edge).toContain(edge);
    }
  });

  test("the matrix has no exceptions left in it", () => {
    // The HTTP head used to import `../../ui/index.html` so the compiled
    // binary carried the built page, and the checker had a hand-written
    // exception for that one specifier. There is no HTTP head any more: the
    // app loads the page through Electrobun's view bundle, not through a
    // module specifier, so the exception is gone and nothing may reintroduce
    // it. An
    // asset import is a package edge like any other — reinstating one would
    // have to widen the matrix in the open, where a reviewer sees it.
    // Narrow on purpose: the UI imports its own stylesheets, which is an
    // intra-package edge the matrix never had an opinion about. What no
    // package source may do any more is import an HTML document — the one
    // asset kind that only ever existed to carry another package's page.
    const htmlImports = allPackageSources().flatMap((file) =>
      specifiersOf(file)
        .filter(({ spec }) => spec.endsWith(".html"))
        .map(({ spec }) => `${file.path.slice(ROOT.length)} → ${spec}`),
    );
    expect(htmlImports).toEqual([]);
    expect(ALLOW_LIST).toEqual([]);
  });

  test("the type-only scan really sees the UI's type imports", () => {
    // `import type { HermeticRPC } from "@hermetic/app"` is elided by the
    // transpiler, so if the two-pass scan regressed this edge would vanish
    // rather than fail, and the UI's one allowed import would go unchecked.
    const seen = readPackage("ui").flatMap((file) =>
      specifiersOf(file)
        .filter((s) => s.spec === "@hermetic/app")
        .map((s) => s.typeOnly),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((typeOnly) => typeOnly)).toBe(true);
  });

  describe("the checker reports every forbidden edge", () => {
    const cases: Array<{ name: string; file: SourceFile; spec: string; edge: string }> = [
      {
        name: "core → cli",
        file: fake("core", "a.ts", 'import { program } from "@hermetic/cli";\nprogram;\n'),
        spec: "@hermetic/cli",
        edge: "core → cli",
      },
      {
        name: "core → app",
        file: fake("core", "a.ts", 'import { app } from "@hermetic/app";\napp;\n'),
        spec: "@hermetic/app",
        edge: "core → app",
      },
      {
        name: "core → ui",
        file: fake("core", "a.ts", 'export { App } from "@hermetic/ui";\n'),
        spec: "@hermetic/ui",
        edge: "core → ui",
      },
      {
        name: "core → agentd",
        file: fake("core", "a.ts", 'const m = require("@hermetic/agentd");\nm;\n'),
        spec: "@hermetic/agentd",
        edge: "core → agentd",
      },
      {
        name: "core → app by relative path",
        file: fake("core", "a.ts", 'import { app } from "../../app/src/app.ts";\napp;\n'),
        spec: "../../app/src/app.ts",
        edge: "core → app",
      },
      {
        // There is no such exception any longer. An HTML import is not a
        // special kind of import: it resolves into `packages/ui` like any
        // other path, and `app → ui` is not an edge.
        name: "app → ui by asset import",
        file: fake("app", "a.ts", 'import index from "../../ui/index.html";\nindex;\n'),
        spec: "../../ui/index.html",
        edge: "app → ui",
      },
      {
        name: "cli → app",
        file: fake("cli", "a.ts", 'import { app } from "@hermetic/app";\napp;\n'),
        spec: "@hermetic/app",
        edge: "cli → app",
      },
      {
        name: "cli → app, type-only",
        file: fake("cli", "a.ts", 'import type { HermeticRPC } from "@hermetic/app";\n'),
        spec: "@hermetic/app",
        edge: "cli → app",
      },
      {
        name: "cli → app by dynamic import",
        file: fake("cli", "a.ts", 'const m = await import("@hermetic/app");\nm;\n'),
        spec: "@hermetic/app",
        edge: "cli → app",
      },
      {
        name: "cli → ui",
        file: fake("cli", "a.ts", 'import { App } from "@hermetic/ui";\nApp;\n'),
        spec: "@hermetic/ui",
        edge: "cli → ui",
      },
      {
        name: "cli → agentd",
        file: fake("cli", "a.ts", 'import { run } from "@hermetic/agentd";\nrun;\n'),
        spec: "@hermetic/agentd",
        edge: "cli → agentd",
      },
      {
        name: "app → cli",
        file: fake("app", "a.ts", 'import { program } from "@hermetic/cli";\nprogram;\n'),
        spec: "@hermetic/cli",
        edge: "app → cli",
      },
      {
        name: "app → cli by relative path",
        file: fake("app", "a.ts", 'import { program } from "../../cli/src/program.ts";\nprogram;\n'),
        spec: "../../cli/src/program.ts",
        edge: "app → cli",
      },
      {
        name: "app → ui",
        file: fake("app", "a.ts", 'import { App } from "@hermetic/ui";\nApp;\n'),
        spec: "@hermetic/ui",
        edge: "app → ui",
      },
      {
        // The HTML embed below is allowed; a module beside it is not, which is
        // the whole reason that exception names one exact file.
        name: "app → ui by a module beside the embedded HTML",
        file: fake("app", "a.ts", 'import { App } from "../../ui/src/app.tsx";\nApp;\n'),
        spec: "../../ui/src/app.tsx",
        edge: "app → ui",
      },
      {
        name: "app → ui by a second HTML file",
        file: fake("app", "a.ts", 'import page from "../../ui/other.html";\npage;\n'),
        spec: "../../ui/other.html",
        edge: "app → ui",
      },
      {
        name: "app → agentd",
        file: fake("app", "a.ts", 'export * from "@hermetic/agentd";\n'),
        spec: "@hermetic/agentd",
        edge: "app → agentd",
      },
      {
        name: "ui → core",
        file: fake("ui", "a.tsx", 'import { openHermetic } from "@hermetic/core";\nopenHermetic;\n'),
        spec: "@hermetic/core",
        edge: "ui → core",
      },
      {
        name: "ui → core, type-only",
        file: fake("ui", "a.tsx", 'import type { Agent } from "@hermetic/core";\n'),
        spec: "@hermetic/core",
        edge: "ui → core",
      },
      {
        name: "ui → core/schema",
        file: fake("ui", "a.tsx", 'import { Agent } from "@hermetic/core/schema";\nAgent;\n'),
        spec: "@hermetic/core/schema",
        edge: "ui → core/schema",
      },
      {
        // `shared` is a door only through the exports map: the same modules by
        // path are the `core` column, and the UI may not open that.
        name: "ui → core/shared by relative path",
        file: fake(
          "ui",
          "a.tsx",
          'import { cloudName } from "../../core/src/shared/index.ts";\ncloudName;\n',
        ),
        spec: "../../core/src/shared/index.ts",
        edge: "ui → core",
      },
      {
        name: "ui → core by relative path",
        file: fake(
          "ui",
          "a.tsx",
          'import { SLUG_RE } from "../../core/src/schema/common.ts";\nSLUG_RE;\n',
        ),
        spec: "../../core/src/schema/common.ts",
        edge: "ui → core",
      },
      {
        name: "ui → app, value import",
        file: fake("ui", "a.tsx", 'import { app } from "@hermetic/app";\napp;\n'),
        spec: "@hermetic/app",
        edge: "ui → app",
      },
      {
        name: "ui → app, mixed value and type import",
        file: fake("ui", "a.tsx", 'import { type HermeticRPC, app } from "@hermetic/app";\napp;\n'),
        spec: "@hermetic/app",
        edge: "ui → app",
      },
      {
        name: "ui → cli",
        file: fake("ui", "a.tsx", 'import { program } from "@hermetic/cli";\nprogram;\n'),
        spec: "@hermetic/cli",
        edge: "ui → cli",
      },
      {
        name: "ui → agentd",
        file: fake("ui", "a.tsx", 'import { run } from "@hermetic/agentd";\nrun;\n'),
        spec: "@hermetic/agentd",
        edge: "ui → agentd",
      },
      {
        name: "agentd → core",
        file: fake("agentd", "a.ts", 'import { openHermetic } from "@hermetic/core";\nopenHermetic;\n'),
        spec: "@hermetic/core",
        edge: "agentd → core",
      },
      {
        name: "agentd → core, type-only",
        file: fake("agentd", "a.ts", 'import type { Hermetic } from "@hermetic/core";\n'),
        spec: "@hermetic/core",
        edge: "agentd → core",
      },
      {
        name: "agentd → core by deep path past the exports map",
        file: fake("agentd", "a.ts", 'import { aws } from "@hermetic/core/index.ts";\naws;\n'),
        spec: "@hermetic/core/index.ts",
        edge: "agentd → core",
      },
      {
        name: "agentd → core by relative path",
        file: fake("agentd", "a.ts", 'import { aws } from "../../core/src/x.ts";\naws;\n'),
        spec: "../../core/src/x.ts",
        edge: "agentd → core",
      },
      {
        name: "agentd → core by relative path into core's schema tree",
        file: fake(
          "agentd",
          "a.ts",
          'import { Agent } from "../../core/src/schema/agent.ts";\nAgent;\n',
        ),
        spec: "../../core/src/schema/agent.ts",
        edge: "agentd → core",
      },
      {
        name: "agentd → core by absolute path",
        file: fake(
          "agentd",
          "a.ts",
          `import { aws } from "${join(ROOT, "packages/core/src/x.ts")}";\naws;\n`,
        ),
        spec: join(ROOT, "packages/core/src/x.ts"),
        edge: "agentd → core",
      },
      {
        name: "agentd → cli",
        file: fake("agentd", "a.ts", 'import { program } from "@hermetic/cli";\nprogram;\n'),
        spec: "@hermetic/cli",
        edge: "agentd → cli",
      },
      {
        name: "agentd → app",
        file: fake("agentd", "a.ts", 'import { app } from "@hermetic/app";\napp;\n'),
        spec: "@hermetic/app",
        edge: "agentd → app",
      },
      {
        name: "agentd → ui",
        file: fake("agentd", "a.ts", 'import { App } from "@hermetic/ui";\nApp;\n'),
        spec: "@hermetic/ui",
        edge: "agentd → ui",
      },
      {
        name: "agentd → core/chat-client-fixture",
        file: fake(
          "agentd",
          "a.ts",
          'import { fixtureChatClient } from "@hermetic/core/chat-client-fixture";\nfixtureChatClient;\n',
        ),
        spec: "@hermetic/core/chat-client-fixture",
        edge: "agentd → core/chat-client-fixture",
      },
      {
        name: "cli → core/chat-client-fixture",
        file: fake(
          "cli",
          "a.ts",
          'import { fixtureChatClient } from "@hermetic/core/chat-client-fixture";\nfixtureChatClient;\n',
        ),
        spec: "@hermetic/core/chat-client-fixture",
        edge: "cli → core/chat-client-fixture",
      },
      {
        name: "ui → core/chat-client",
        file: fake("ui", "a.tsx", 'import type { ChatFrame } from "@hermetic/core/chat-client";\n'),
        spec: "@hermetic/core/chat-client",
        edge: "ui → core/chat-client",
      },
      {
        name: "mobile → core",
        file: fakeMobile(
          "mobile/src/a.ts",
          'import { openHermetic } from "@hermetic/core";\nopenHermetic;\n',
        ),
        spec: "@hermetic/core",
        edge: "mobile → core",
      },
      {
        name: "mobile → core, type-only",
        file: fakeMobile("mobile/app/a.tsx", 'import type { Hermetic } from "@hermetic/core";\n'),
        spec: "@hermetic/core",
        edge: "mobile → core",
      },
      {
        name: "mobile → core/chat-client-fixture outside the fixture directory",
        file: fakeMobile(
          "mobile/src/gateway/client.ts",
          'import { fixtureChatClient } from "@hermetic/core/chat-client-fixture";\nfixtureChatClient;\n',
        ),
        spec: "@hermetic/core/chat-client-fixture",
        edge: "mobile → core/chat-client-fixture",
      },
      {
        name: "mobile → core/chat-client-fixture from a screen",
        file: fakeMobile(
          "mobile/app/index.tsx",
          'import type { FixtureChatOptions } from "@hermetic/core/chat-client-fixture";\n',
        ),
        spec: "@hermetic/core/chat-client-fixture",
        edge: "mobile → core/chat-client-fixture",
      },
      {
        name: "mobile → ui",
        file: fakeMobile("mobile/src/a.ts", 'import { App } from "@hermetic/ui";\nApp;\n'),
        spec: "@hermetic/ui",
        edge: "mobile → ui",
      },
      {
        name: "mobile → agentd",
        file: fakeMobile("mobile/src/a.ts", 'import { run } from "@hermetic/agentd";\nrun;\n'),
        spec: "@hermetic/agentd",
        edge: "mobile → agentd",
      },
      {
        name: "mobile → core/shared by relative path",
        file: fakeMobile(
          "mobile/src/a.ts",
          'import { cloudName } from "../../packages/core/src/shared/index.ts";\ncloudName;\n',
        ),
        spec: "../../packages/core/src/shared/index.ts",
        edge: "mobile → core",
      },
      {
        name: "mobile → the chat-client door by relative path",
        file: fakeMobile(
          "mobile/src/fixture/a.ts",
          'import type { ChatFrame } from "../../../packages/core/src/chat-client.ts";\n',
        ),
        spec: "../../../packages/core/src/chat-client.ts",
        edge: "mobile → core",
      },
      {
        name: "mobile → a packages/ directory the matrix has no column for",
        file: fakeMobile("mobile/app/a.tsx", 'import x from "../../packages/nope/x.ts";\nx;\n'),
        spec: "../../packages/nope/x.ts",
        edge: "mobile → packages",
      },
      {
        name: "mobile → packages/ by absolute path",
        file: fakeMobile(
          "mobile/src/a.ts",
          `import { aws } from "${join(ROOT, "packages/core/src/x.ts")}";\naws;\n`,
        ),
        spec: join(ROOT, "packages/core/src/x.ts"),
        edge: "mobile → core",
      },
    ];

    for (const c of cases) {
      test(c.name, () => {
        const violations = checkBoundaries([c.file]);
        expect(violations.length, JSON.stringify(violations)).toBe(1);
        expect(violations[0]!.file).toBe(c.file.path.slice(ROOT.length));
        expect(violations[0]!.spec).toBe(c.spec);
        expect(violations[0]!.edge).toBe(c.edge);
      });
    }
  });

  describe("the checker passes every allowed edge", () => {
    const cases: Array<{ name: string; file: SourceFile }> = [
      {
        name: "cli → core",
        file: fake("cli", "a.ts", 'import { openHermetic } from "@hermetic/core";\nopenHermetic;\n'),
      },
      {
        name: "cli → core, type-only",
        file: fake("cli", "a.ts", 'import type { Hermetic } from "@hermetic/core";\n'),
      },
      {
        name: "cli → core/schema",
        file: fake("cli", "a.ts", 'import { Agent } from "@hermetic/core/schema";\nAgent;\n'),
      },
      {
        name: "app → core",
        file: fake("app", "a.ts", 'import { openHermetic } from "@hermetic/core";\nopenHermetic;\n'),
      },
      {
        name: "app → core/schema",
        file: fake("app", "a.ts", 'export type { Agent } from "@hermetic/core/schema";\n'),
      },
      {
        name: "agentd → core/schema",
        file: fake("agentd", "a.ts", 'import { Agent } from "@hermetic/core/schema";\nAgent;\n'),
      },
      {
        name: "agentd → core/shared",
        file: fake(
          "agentd",
          "a.ts",
          'import { HERMES_HOME } from "@hermetic/core/shared";\nHERMES_HOME;\n',
        ),
      },
      {
        name: "agentd → core/chat-client",
        file: fake(
          "agentd",
          "a.ts",
          'import { createHermesChat } from "@hermetic/core/chat-client";\ncreateHermesChat;\n',
        ),
      },
      {
        name: "app → core/chat-client",
        file: fake("app", "a.ts", 'import type { ChatFrame } from "@hermetic/core/chat-client";\n'),
      },
      {
        name: "mobile → core/chat-client",
        file: fakeMobile(
          "mobile/src/gateway/client.ts",
          'import { createHermesChat } from "@hermetic/core/chat-client";\ncreateHermesChat;\n',
        ),
      },
      {
        name: "mobile → core/schema and core/shared",
        file: fakeMobile(
          "mobile/app/a.tsx",
          'import { Agent } from "@hermetic/core/schema";\nimport { cloudName } from "@hermetic/core/shared";\nAgent;\ncloudName;\n',
        ),
      },
      {
        name: "mobile → core/chat-client-fixture from the fixture directory",
        file: fakeMobile(
          "mobile/src/fixture/chat.ts",
          'import { fixtureChatClient } from "@hermetic/core/chat-client-fixture";\nfixtureChatClient;\n',
        ),
      },
      {
        name: "mobile's own relative imports, screens into src",
        file: fakeMobile(
          "mobile/app/a.tsx",
          'import { Composer } from "../src/chat/Composer.tsx";\nimport icon from "../assets/icon.png";\nComposer;\nicon;\n',
        ),
      },
      {
        name: "mobile's third-party imports",
        file: fakeMobile(
          "mobile/src/a.ts",
          'import { View } from "react-native";\nimport { z } from "zod";\nView;\nz;\n',
        ),
      },
      {
        name: "ui → core/shared, value import",
        file: fake("ui", "a.tsx", 'import { cloudName } from "@hermetic/core/shared";\ncloudName;\n'),
      },
      {
        name: "ui → app, type-only",
        file: fake("ui", "a.tsx", 'import type { HermeticRPC } from "@hermetic/app";\n'),
      },
      {
        name: "ui → app, inline type specifiers only",
        file: fake("ui", "a.tsx", 'import { type HermeticRPC } from "@hermetic/app";\n'),
      },
      {
        name: "ui → app, type-only re-export",
        file: fake("ui", "a.tsx", 'export type { HermeticRPC } from "@hermetic/app";\n'),
      },
      {
        name: "internal relative imports inside a package",
        file: fake(
          "core",
          "a.ts",
          'import { b } from "./b.ts";\nimport { c } from "../src/c.ts";\nb;\nc;\n',
        ),
      },
      {
        name: "third-party and builtin imports",
        file: fake(
          "core",
          "a.ts",
          'import { z } from "zod";\nimport { join } from "node:path";\nimport { file } from "bun";\nz;\njoin;\nfile;\n',
        ),
      },
      {
        name: "core reaching its own schema subpath",
        file: fake("core", "a.ts", 'import { Agent } from "@hermetic/core/schema";\nAgent;\n'),
      },
    ];

    for (const c of cases) {
      test(c.name, () => {
        expect(checkBoundaries([c.file])).toEqual([]);
      });
    }
  });

  test("package.json declares the same dependency edges the tests enforce", () => {
    const read = (pkg: string) =>
      JSON.parse(readFileSync(join(ROOT, "packages", pkg, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

    const core = read("core");
    expect(Object.keys(core.dependencies ?? {}).filter((d) => d.startsWith("@hermetic/"))).toEqual([]);

    for (const pkg of ["cli", "app", "agentd"]) {
      expect(read(pkg).dependencies?.["@hermetic/core"]).toBe("workspace:*");
    }
    expect(read("cli").dependencies?.["@hermetic/app"]).toBeUndefined();
    // The UI's dependency on the app is types-only, so it belongs in
    // devDependencies; its dependency on core is a value edge (the `shared`
    // subpath is bundled into the page), so it is a real dependency.
    expect(read("ui").dependencies?.["@hermetic/core"]).toBe("workspace:*");
    expect(read("ui").devDependencies?.["@hermetic/app"]).toBe("workspace:*");
  });

  test("the UI does not depend on hono, in any dependency field", () => {
    // The HTTP head is gone: the page talks to the app over the
    // Electrobun RPC bridge, and reads its request and response types off
    // `HermeticRPC` rather than off a Hono route type. `hc` was the only
    // reason the UI ever named hono, and a `hono` entry reappearing here
    // means something in the page is typed against a server that no longer
    // exists — or, worse, is bundling one into the webview.
    const ui = JSON.parse(readFileSync(join(ROOT, "packages/ui/package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const named = Object.entries(ui)
      .filter(([key]) => key.toLowerCase().endsWith("dependencies"))
      .flatMap(([field, value]) =>
        Object.keys((value ?? {}) as Record<string, string>)
          .filter((dep) => dep === "hono" || dep.startsWith("hono/") || dep.startsWith("@hono/"))
          .map((dep) => `${field}.${dep}`),
      );
    expect(named).toEqual([]);
  });

  /**
   * What the UI still repeats rather than imports through `core/shared`: the
   * four small vocabularies the Settings forms spell as literals — the two
   * Hermes enums, the secrets mode, and the shared-secret slug shape. `satisfies` in the UI catches a value core
   * *removed* (it stops type-checking) but not one core *added* — a new
   * `reasoning_effort` would simply be unofferable, and a slug shape that drifted
   * wider here would let the drawer submit something the route then refuses.
   *
   * This file is at the root, so it may read both sides and import the UI
   * module directly.
   */
  test("the UI's settings enums and slug shape match core", async () => {
    const schema = (file: string): string =>
      readFileSync(join(ROOT, "packages/core/src/schema", file), "utf8");

    const enumLiterals = (text: string, name: string): string[] => {
      const match = new RegExp(`export const ${name} = z\\.enum\\(\\[([^\\]]+)\\]\\)`).exec(text);
      expect(match, `${name} not found in core`).not.toBeNull();
      return (match![1]!.match(/"([a-z]+)"/g) ?? []).map((q) => q.slice(1, -1));
    };

    const ui = (await import("../packages/ui/src/logic/settings-logic.ts")) as {
      TERMINAL_BACKENDS: readonly string[];
      REASONING_EFFORTS: readonly string[];
      SECRETS_MODES: readonly string[];
      isValidSlug: (slug: string) => boolean;
    };

    const hermes = schema("hermes.ts");
    expect([...ui.TERMINAL_BACKENDS]).toEqual(enumLiterals(hermes, "TerminalBackend"));
    expect([...ui.REASONING_EFFORTS]).toEqual(enumLiterals(hermes, "ReasoningEffort"));
    expect([...ui.SECRETS_MODES]).toEqual(enumLiterals(schema("agent.ts"), "SecretsMode"));

    // The slug is concatenated into an SSM path, so the UI's copy is checked by
    // behaviour rather than by spelling: same verdict, every case, on core's own
    // regex source compiled here.
    // `common.ts`, not `fleet.ts`: the slug shape moved there when `profile.ts`
    // started naming one too and `fleet.ts` started reading `profile.ts` (§8.3).
    const source = /export const SLUG_RE = (\/.+\/);/.exec(schema("common.ts"));
    expect(source, "SLUG_RE not found in core").not.toBeNull();
    const body = source![1]!.slice(1, -1);
    const core = new RegExp(body);
    for (const candidate of [
      "a",
      "nous",
      "a-b-c",
      "0",
      "a".repeat(31),
      "a".repeat(32),
      "",
      "-lead",
      "Upper",
      "has space",
      "has/slash",
      "has.dot",
      "under_score",
      "trailing-",
    ]) {
      expect(ui.isValidSlug(candidate), `slug ${JSON.stringify(candidate)}`).toBe(core.test(candidate));
    }
  });

  /**
   * `scripts/` is not a package, so the matrix above skips it — and it is where
   * `build.ts` decides what ships beside the binaries. Its rule is the one it
   * already follows: reach into `packages/core/src` by relative path
   * (`BUILD_VERSIONS`, the CFN template) and nothing else. A script importing
   * the CLI or the app would make the build depend on a head; importing
   * `@hermetic/*` would make it depend on the workspace resolution the compiled
   * binaries deliberately do not have.
   */
  test("scripts import core directly, and no head", () => {
    const files = scriptSources();
    expect(files.length).toBeGreaterThan(3);
    let reachesCore = 0;
    for (const path of files) {
      for (const { spec } of specifiersOf({ path, source: readFileSync(path, "utf8") })) {
        expect(spec, `${path} imports ${spec}`).not.toStartWith("@hermetic/");
        for (const head of ["cli", "app", "ui", "agentd"]) {
          expect(spec, `${path} imports ${spec}`).not.toInclude(`packages/${head}/src`);
        }
        if (spec.includes("packages/core/src")) reachesCore += 1;
      }
    }
    // Not vacuous: `build.ts` really does read `BUILD_VERSIONS` from core.
    expect(reachesCore).toBeGreaterThan(0);
  });

  test("core's exports map is exactly the doors agentd, the UI and the phone can use", () => {
    const core = JSON.parse(readFileSync(join(ROOT, "packages", "core", "package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(core.exports).toEqual({
      ".": "./src/index.ts",
      "./schema": "./src/schema/index.ts",
      "./shared": "./src/shared/index.ts",
      "./chat-client": "./src/chat-client.ts",
      "./chat-client-fixture": "./src/chat-client-fixture.ts",
    });
    // The matrix's `core/*` columns are that map's subpath entries: if a sixth
    // door were added, this file would have to grow a column for it.
    expect(Object.keys(CORE_SUBPATHS).map((s) => (s ? `./${s}` : "."))).toEqual(
      Object.keys(core.exports),
    );
  });
});
