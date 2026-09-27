/**
 * The three tracked-file rules `scripts/lint.ts` added for the public-release
 * audit: no absolute home path, no pointer to a doc the repo no longer
 * carries, and no dangling relative markdown link.
 *
 * Each is exported as a pure function of file contents (or, for the markdown
 * link check, of real files under a directory this test controls) rather than
 * of the real repo, so a fixture can plant exactly one violation and prove the
 * rule catches it — the mutation the rest of the suite is not equipped to
 * prove on its own.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type FileEntry,
  homePathViolations,
  markdownFiles,
  markdownLinkViolations,
  removedDocsViolations,
} from "../scripts/lint.ts";

function entry(path: string, text: string): FileEntry {
  return { path, text };
}

describe("rule 5: no absolute home path in a tracked file", () => {
  test("a planted /Users/<name>/ path fails", () => {
    const violations = homePathViolations([
      entry("packages/cli/src/oops.ts", 'const p = "/Users/jdoe/dev";\n'),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe("packages/cli/src/oops.ts");
    expect(violations[0]?.line).toBe(1);
    expect(violations[0]?.message).toContain("/Users/jdoe");
  });

  test("a planted /home/<name>/ path fails", () => {
    const violations = homePathViolations([
      entry("scripts/oops.ts", "// see /home/jdoe/.hermetic for the config\n"),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("/home/jdoe");
  });

  test("the dash-encoded scratchpad form fails", () => {
    const violations = homePathViolations([
      entry("tests/oops.test.ts", "// -Users-jdoe-conductor-workspaces-hermetic-some-workspace-\n"),
    ]);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.message).toContain("-Users-jdoe-");
  });

  test("the allowlisted fixture paths pass", () => {
    const violations = homePathViolations([
      entry("packages/app/test/main/paths.test.ts", 'expect(x).toBe("/Users/nobody/.hermetic");\n'),
      entry("packages/agentd/test/fake-host.ts", 'const home = "/home/app/data";\n'),
    ]);
    expect(violations).toEqual([]);
  });

  test("the linter and its own test are never scanned", () => {
    // Real content is irrelevant: both files have to name what the rule bans,
    // so the rule skips them by path.
    const violations = homePathViolations([
      entry("scripts/lint.ts", 'const x = "/Users/somebody/whatever";\n'),
    ]);
    expect(violations).toEqual([]);
  });

  test("a clean file reports nothing", () => {
    expect(
      homePathViolations([entry("packages/cli/src/fine.ts", 'const p = "/tmp/hermetic-home";\n')]),
    ).toEqual([]);
  });
});

describe("rule 6: no pointer to a removed doc", () => {
  test("a docs/plans/ reference fails", () => {
    const violations = removedDocsViolations([
      entry("packages/cli/src/oops.ts", "// see docs/plans/pending/0009-thing.md\n"),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("removed docs directory");
  });

  test("a docs/archive/ reference fails", () => {
    const violations = removedDocsViolations([
      entry("tests/oops.test.ts", "// docs/archive/status/status-2026-09-01.md\n"),
    ]);
    expect(violations.length).toBeGreaterThan(0);
  });

  test("a docs/status.md reference fails", () => {
    const violations = removedDocsViolations([
      entry("scripts/oops.ts", "// see docs/status.md for context\n"),
    ]);
    expect(violations.some((v) => v.message.includes("removed status doc"))).toBe(true);
  });

  test("a bare plan number fails", () => {
    const violations = removedDocsViolations([
      entry("packages/cli/test/oops.test.ts", "// landed by plan 0012\n"),
    ]);
    expect(violations.some((v) => v.message.includes("plan number"))).toBe(true);
  });

  test("this file's own path is never scanned", () => {
    const violations = removedDocsViolations([
      entry("scripts/lint.ts", "// docs/plans/ docs/archive/ docs/status.md plan 0001\n"),
    ]);
    expect(violations).toEqual([]);
  });

  test("a clean file reports nothing", () => {
    expect(
      removedDocsViolations([entry("scripts/fine.ts", "// see CONTRIBUTING.md instead\n")]),
    ).toEqual([]);
  });
});

describe("rule 7: markdown relative links resolve", () => {
  function withTempDocs(files: Record<string, string>, run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "hermetic-lint-links-"));
    try {
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), content);
      }
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("a link to a real sibling file passes", () => {
    withTempDocs(
      { "README.md": "see [it](CONTRIBUTING.md)\n", "CONTRIBUTING.md": "# hi\n" },
      (root) => {
        const violations = markdownLinkViolations(root, markdownFiles(root));
        expect(violations).toEqual([]);
      },
    );
  });

  test("a link to a file that does not exist fails", () => {
    withTempDocs({ "README.md": "see [it](docs/gone.md)\n" }, (root) => {
      const violations = markdownLinkViolations(root, markdownFiles(root));
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("docs/gone.md");
    });
  });

  test("http(s), mailto and pure #anchor targets are not resolved as files", () => {
    withTempDocs(
      {
        "README.md":
          "[a](https://example.com) [b](mailto:x@example.com) [c](#section) [d](docs/design.md#3-software-architecture)\n",
        "docs/design.md": "# design\n",
      },
      (root) => {
        const violations = markdownLinkViolations(root, markdownFiles(root));
        expect(violations).toEqual([]);
      },
    );
  });

  test("an anchor on a broken target still reports the broken file", () => {
    withTempDocs({ "README.md": "see [it](docs/gone.md#section)\n" }, (root) => {
      const violations = markdownLinkViolations(root, markdownFiles(root));
      expect(violations).toHaveLength(1);
    });
  });

  test("markdownFiles finds docs/*.md recursively and the root's own *.md files", () => {
    withTempDocs(
      {
        "README.md": "# root\n",
        "CONTRIBUTING.md": "# contributing\n",
        "docs/design.md": "# design\n",
        "docs/nested/more.md": "# nested\n",
      },
      (root) => {
        const files = markdownFiles(root).sort();
        expect(files).toContain("README.md");
        expect(files).toContain("CONTRIBUTING.md");
        expect(files).toContain("docs/design.md");
        expect(files).toContain(join("docs", "nested", "more.md"));
      },
    );
  });
});
