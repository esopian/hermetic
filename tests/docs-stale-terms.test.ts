/**
 * The live documents may not describe the HTTP head that no longer exists.
 *
 * hermetic's head was a Hono server on a loopback port with an `EventSource`
 * stream and a `hermetic-portal` binary; it is now an Electrobun desktop app
 * answering RPC in-process. A prose review caught the stale sentences once —
 * this test is what keeps them from coming back, because every one of these
 * terms names a thing that is gone from the tree, so any occurrence in a live
 * document is a statement that is no longer true.
 *
 * Scope is the documents a reader is expected to trust today: every Markdown
 * file under `docs/`, plus the three root Markdown files. `EXCLUDED_DIRS` is
 * where a directory of history kept verbatim on purpose would be listed; there
 * is none today.
 *
 * A term that earns a legitimate use is deleted from `BANNED` in the same
 * change that introduces the use, with a comment saying where and why. Do not
 * add a per-file exception instead — the point of the list is that these words
 * have no live meaning at all.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(dirname(import.meta.path), "..");

/** Root-level documents a reader is expected to trust. */
const ROOT_DOCS = ["README.md", "CONTRIBUTING.md", "AGENTS.md"];

/** History, kept verbatim on purpose. Paths relative to the repo root. */
const EXCLUDED_DIRS: readonly string[] = [];

/**
 * Each term is a thing the tree no longer has.
 *
 * `hono` is matched on word boundaries so it does not fire on "honours", which
 * is an ordinary English word that happens to contain it; the framework is
 * only ever written as `Hono`, `hono` or `@hono/…`, and a slash is a boundary.
 *
 * Two words that look like they belong here do not, because they still mean
 * something live. `Playwright` is upstream Hermes's browser tool and the name
 * of the Chrome for Testing build every agent runs (§6.3, §7.3), and §11.6
 * says in as many words why hermetic has no Playwright suite. `/api/…` is the
 * box's own Hermes dashboard API, which the app and the CLI both proxy (§9.2),
 * and the Tailscale API (§5.2). Neither was ever only the deleted head's.
 */
const BANNED: readonly { term: string; pattern: RegExp }[] = [
  { term: "hermetic-portal", pattern: /hermetic-portal/gi },
  { term: "127.0.0.1:7433", pattern: /127\.0\.0\.1:7433/g },
  { term: "bun --hot", pattern: /bun --hot/gi },
  { term: "Bun.serve", pattern: /Bun\.serve/gi },
  { term: "streamSSE", pattern: /streamSSE/gi },
  { term: "EventSource", pattern: /EventSource/gi },
  { term: "hono", pattern: /\bhono\b/gi },
  { term: "portal.log", pattern: /portal\.log/gi },
  // The head's own package and the symbols only it had. A document naming one
  // is describing a file that is not there (`tests/boundaries.test.ts` proves
  // the package list, `tests/parity.test.ts` the declaration registries).
  { term: "packages/server", pattern: /packages\/server/gi },
  { term: "declareRoute", pattern: /declareRoute/gi },
  { term: "SERVER_ROUTES", pattern: /SERVER_ROUTES/gi },
  { term: "MACHINERY_ROUTES", pattern: /MACHINERY_ROUTES/gi },
  // The Playwright suite, by the paths and script names that were only ever
  // its own — the flows live in `packages/ui/test/flows/` now.
  { term: "tests/e2e", pattern: /tests\/e2e/gi },
  { term: "test:e2e", pattern: /test:e2e/gi },
  // The `hc` client the UI typed itself against.
  { term: "hc<", pattern: /\bhc</gi },
];

function markdownFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = relative(ROOT, full);
      if (EXCLUDED_DIRS.includes(rel)) continue;
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith(".md")) found.push(rel);
    }
  };
  walk(join(ROOT, "docs"));
  return [...ROOT_DOCS, ...found];
}

/** `file:line: <matched text>` for every occurrence, so a failure is actionable. */
function hits(pattern: RegExp): string[] {
  const out: string[] = [];
  for (const file of markdownFiles()) {
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        out.push(`${file}:${index + 1}: ${match[0]}`);
      }
    });
  }
  return out;
}

describe("docs carry no stale terms from the HTTP head", () => {
  test("the scan actually reaches the documents", () => {
    const files = markdownFiles();
    for (const doc of ROOT_DOCS) expect(files).toContain(doc);
    expect(files).toContain("docs/design.md");
    expect(files).toContain("docs/architecture.md");
    for (const dir of EXCLUDED_DIRS) {
      expect(files.some((f) => f.startsWith(`${dir}/`))).toBe(false);
    }
  });

  for (const { term, pattern } of BANNED) {
    test(`no live document says "${term}"`, () => {
      expect(hits(pattern)).toEqual([]);
    });
  }
});
