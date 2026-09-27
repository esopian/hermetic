#!/usr/bin/env bun
/**
 * Enforces a handful of the repo's own rules (AGENTS.md, docs/design.md §3.2)
 * that are cheap to check mechanically and easy to violate by accident. Rules
 * 1, 3 and 4 are three greps with a report format; 5-7 additionally shell out
 * to `git ls-files` (Bun.spawnSync) so they see every tracked text file, not
 * only `packages`/`scripts`/`tests` sources.
 *
 * Rules:
 *   1. `packages/core/src` never calls `console.*` or `process.exit` (core
 *      talks to heads through typed results, never to a human directly).
 *   2. (moved) The `any` check now lives in Biome's `noExplicitAny` rule
 *      (biome.jsonc, with packages/ui exempted by override). Rule numbers are
 *      kept stable so the docs and messages below stay true.
 *   3. No source file over 1500 lines (a smell threshold, not an architectural
 *      limit: split before adding to a file near it).
 *   4. No bare markers of the two four-letter kinds every codebase grows —
 *      "revisit this" and "this is broken" — without an owner or issue tag in
 *      parens before the colon ("no untagged markers").
 *   5. No absolute home path in a tracked file: a laptop path (`/Users/<name>`,
 *      `/home/<name>`, or the dash-encoded form an agent's own scratchpad
 *      paths use) is either a fixture that should use an allowlisted stand-in
 *      or a real machine leaking into a file meant to travel.
 *   6. No pointer to a doc this repo no longer carries: `docs/plans/`,
 *      `docs/archive/`, `docs/status.md`, or a bare `plan NNNN` reference.
 *   7. Every relative link in `docs/*.md` and the root `*.md` files resolves
 *      to a file that exists (http(s)/mailto/pure-`#anchor` targets excused).
 *
 * Run via `bun run lint` (also wired into `bun run check`). Exits non-zero and
 * prints `path:line: message` for every violation.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = "scripts/lint.ts";
/**
 * Files that must spell out what rules 5 and 6 ban: this file, and the test
 * that plants each banned shape to prove the rule fires.
 */
const NAMES_ITS_BANS = new Set([SELF, "tests/lint.test.ts"]);

export interface Violation {
  path: string;
  line: number;
  message: string;
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".hutch", "build", "artifacts"]);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    // `.hutch` is Hutch's generated devkit projection and `build`/`artifacts`
    // are Electrobun's build output — all three are regenerated, none is
    // committed, and linting a generator's output only ever fights it.
    if (SKIP_DIRS.has(entry)) return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function sourceFiles(...dirs: string[]): string[] {
  return dirs
    .flatMap((d) => walk(join(ROOT, d)))
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));
}

/** True for a line that is only a comment — prose mentioning a pattern isn't a violation. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/** Strips a trailing `// ...` line comment so a code line with a trailing note isn't skipped. */
function stripTrailingComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

/** Every file `git` tracks, root-relative, newline-split with no trailing blank entry. */
export function gitLsFiles(cwd: string): string[] {
  const proc = Bun.spawnSync(["git", "ls-files"], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return [];
  return new TextDecoder()
    .decode(proc.stdout)
    .split("\n")
    .filter((f) => f.length > 0);
}

// Extensions rules 5-7 do not read as text: bun's own lockfile format, fonts,
// images, and other binaries a home path or a stale doc pointer cannot hide
// inside in any way these rules would recognise.
const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".icns",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".zip",
  ".dmg",
]);

export function trackedTextFiles(cwd: string): string[] {
  return gitLsFiles(cwd).filter((f) => f !== "bun.lock" && !SKIP_EXTENSIONS.has(extname(f)));
}

export interface FileEntry {
  path: string;
  text: string;
}

/**
 * Matches `/Users/<name>/` and `/home/<name>/` — the trailing slash is
 * required, which is what a real path continuing onto a home directory always
 * has and a coincidental "…/home/app.log" (no further segment) does not.
 */
const HOME_PATH = /\/(Users|home)\/([A-Za-z0-9_.-]+)\//g;

/** The dash-encoded form a Claude scratchpad path takes, e.g. `-Users-evan-…-`. */
const DASH_ENCODED_HOME = /-Users-([A-Za-z0-9_-]+)-/g;

/**
 * Fixture and box home paths that are not a laptop leaking into a tracked
 * file: `nobody` (`packages/app/test/main/paths.test.ts`) and `app`, the
 * generic account name a fixture may render. Extend this rather than deleting
 * the rule when a new one is legitimately needed.
 */
const ALLOWED_HOME_PATHS = new Set(["/Users/nobody", "/home/app"]);

/** Rule 5, as a pure function of file contents so a fixture can prove it fails. */
export function homePathViolations(entries: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const { path, text } of entries) {
    if (NAMES_ITS_BANS.has(path)) continue;
    text.split("\n").forEach((raw, i) => {
      for (const match of raw.matchAll(HOME_PATH)) {
        const found = `/${match[1]}/${match[2]}`;
        if (!ALLOWED_HOME_PATHS.has(found)) {
          out.push({
            path,
            line: i + 1,
            message: `absolute home path ${found} — allowlist a real fixture or redact it before this ships public`,
          });
        }
      }
      for (const match of raw.matchAll(DASH_ENCODED_HOME)) {
        out.push({
          path,
          line: i + 1,
          message: `dash-encoded home path -Users-${match[1]}- (a scratchpad-style path) in a tracked file`,
        });
      }
    });
  }
  return out;
}

/**
 * Docs this repo no longer carries. `label` is what the report names; `plan
 * NNNN` catches a bare mention even where nothing under docs/ is named.
 */
const REMOVED_DOCS_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: "a removed docs directory", pattern: /docs\/(?:plans|archive)\// },
  { label: "a removed status doc", pattern: /docs\/status\.md/ },
  { label: "a plan number", pattern: /[Pp]lan \d{4}/ },
];

/** Rule 6, as a pure function of file contents so a fixture can prove it fails. */
export function removedDocsViolations(entries: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const { path, text } of entries) {
    if (NAMES_ITS_BANS.has(path)) continue;
    text.split("\n").forEach((raw, i) => {
      for (const { label, pattern } of REMOVED_DOCS_PATTERNS) {
        if (pattern.test(raw)) {
          out.push({ path, line: i + 1, message: `pointer to ${label} (rule 6)` });
        }
      }
    });
  }
  return out;
}

/** `docs/*.md`, recursively, plus the root's own `*.md` files. */
export function markdownFiles(root: string): string[] {
  const rootMd = readdirSync(root).filter((f) => f.endsWith(".md") && statSync(join(root, f)).isFile());
  const docsMd = walk(join(root, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => relative(root, f));
  return [...rootMd, ...docsMd];
}

const MARKDOWN_LINK = /\]\(([^)]+)\)/g;

/** A link target this rule does not resolve at all: a URL scheme, or a bare in-page anchor. */
function isExemptLinkTarget(target: string): boolean {
  if (target === "" || target.startsWith("#")) return true;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target); // http:, https:, mailto:, …
}

/** Rule 7: every relative markdown link resolves to a real file on disk. */
export function markdownLinkViolations(root: string, mdFiles: readonly string[]): Violation[] {
  const out: Violation[] = [];
  for (const relPath of mdFiles) {
    const full = join(root, relPath);
    const text = readFileSync(full, "utf8");
    text.split("\n").forEach((raw, i) => {
      for (const match of raw.matchAll(MARKDOWN_LINK)) {
        const target = (match[1] ?? "").trim();
        if (isExemptLinkTarget(target)) continue;
        const withoutAnchor = target.split("#")[0] ?? "";
        if (withoutAnchor === "") continue;
        const resolved = resolve(dirname(full), withoutAnchor);
        if (!existsSync(resolved)) {
          out.push({
            path: relPath,
            line: i + 1,
            message: `relative link target "${target}" does not exist`,
          });
        }
      }
    });
  }
  return out;
}

// Everything above is pure or read-only and safe to import for tests. The
// scan-the-whole-repo-and-exit behaviour that makes this a CLI is gated below
// so `bun test` can import the rule functions without running (or exiting)
// the linter itself — the same guard `scripts/audit-dependencies.ts` uses.
if (import.meta.main) {
  const violations: Violation[] = [];
  const report = (file: string, line: number, message: string): void => {
    violations.push({ path: relative(ROOT, file), line, message });
  };

  // Rule 1: no console.*/process.exit in core.
  for (const file of sourceFiles("packages/core/src")) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((raw, i) => {
      if (isCommentLine(raw)) return;
      const line = stripTrailingComment(raw);
      if (/\bconsole\s*\./.test(line))
        report(file, i + 1, "core must not call console.* (§3.2 rule 1)");
      if (/\bprocess\.exit\s*\(/.test(line)) {
        report(file, i + 1, "core must not call process.exit (§3.2 rule 1)");
      }
    });
  }

  // Rule 3: no source file over 1500 lines.
  const MAX_LINES = 1500;
  for (const file of sourceFiles("packages", "scripts", "tests")) {
    const count = readFileSync(file, "utf8").split("\n").length;
    if (count > MAX_LINES) {
      report(file, count, `file has ${count} lines, over the ${MAX_LINES}-line limit`);
    }
  }

  // Rule 4: no bare deferred-work marker — must carry an owner, as TODO(<who>):.
  //
  // `PHASE2`/`PHASE3` are markers too. They read as documentation ("this is
  // deliberately not built yet") rather than as debt, which is exactly how
  // three of them sat in core with nobody's name on them: the rule matched
  // TODO and FIXME only, so the one convention that says who to ask did not
  // apply to the markers most likely to outlive the person who wrote them. A
  // phase marker is recognised where it is used *as* a marker — immediately
  // followed by `:` or by its owner — so prose about phase 2 is untouched.
  const TAGGED = /\b(?:TODO|FIXME|PHASE[23])\([^)]+\):/;
  const BARE = /\b(?:TODO|FIXME)\b(?!\([^)]+\):)|\bPHASE[23](?:-[A-Z]+)?(?=[:(])(?!\([^)]+\):)/;
  const SELF_URL = import.meta.url.replace("file://", "");
  for (const file of sourceFiles("packages", "scripts", "tests")) {
    // This file defines the marker patterns as data, so it necessarily
    // contains the bare tokens the rule below is looking for.
    if (file === SELF_URL) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((raw, i) => {
      if (TAGGED.test(raw)) return;
      if (BARE.test(raw)) {
        report(file, i + 1, "TODO/FIXME/PHASE2/PHASE3 must be tagged, e.g. TODO(evan): ...");
      }
    });
  }

  // Rules 5 and 6 both read every tracked text file once.
  const trackedEntries: FileEntry[] = trackedTextFiles(ROOT).map((f) => ({
    path: f,
    text: readFileSync(join(ROOT, f), "utf8"),
  }));
  for (const v of homePathViolations(trackedEntries)) violations.push(v);
  for (const v of removedDocsViolations(trackedEntries)) violations.push(v);

  // Rule 7.
  for (const v of markdownLinkViolations(ROOT, markdownFiles(ROOT))) violations.push(v);

  if (violations.length === 0) {
    process.stdout.write("lint: no violations\n");
    process.exit(0);
  }

  violations.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)));
  for (const v of violations) {
    process.stdout.write(`${v.path}:${v.line}: ${v.message}\n`);
  }
  process.stderr.write(`\nlint: ${violations.length} violation(s)\n`);
  process.exit(1);
}
