/**
 * What the desktop app bundles beside itself (§3.6, `scripts/app-stage.ts`).
 *
 * The staging step is the last thing between a build and a signed bundle, and
 * the failure it exists to prevent — an app that looks complete and reports
 * `HERMETICD_UNAVAILABLE` the first time someone runs `init` from it — cannot
 * be caught later. So the refusals are tested against a temporary directory
 * rather than a real build: a real build takes minutes and would have to be
 * sabotaged to produce a missing item.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGED_ITEMS, StagingError, checkFonts, cssUrls, stageBin } from "../scripts/app-stage.ts";

/** A `dist/` with everything a staged build leaves in it. */
function completeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "hermetic-stage-"));
  for (const item of STAGED_ITEMS) {
    const path = join(dir, item.name);
    if (item.kind === "directory") {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "00-base.sh"), "#!/bin/sh\n");
    } else {
      writeFileSync(path, `${item.name} contents\n`, { mode: item.executable ? 0o755 : 0o644 });
    }
  }
  return dir;
}

function tempOut(): string {
  return join(mkdtempSync(join(tmpdir(), "hermetic-bin-")), "bin");
}

describe("stageBin", () => {
  test("copies every staged item", () => {
    const from = completeDist();
    const to = tempOut();
    try {
      const staged = stageBin(from, to);
      expect([...staged].sort()).toEqual(STAGED_ITEMS.map((i) => i.name).sort());
      for (const item of STAGED_ITEMS) {
        expect(existsSync(join(to, item.name)), item.name).toBe(true);
      }
      expect(existsSync(join(to, "stages", "00-base.sh"))).toBe(true);
    } finally {
      rmSync(from, { recursive: true, force: true });
      rmSync(to, { recursive: true, force: true });
    }
  });

  test("the CLI arrives executable", () => {
    const from = completeDist();
    const to = tempOut();
    try {
      stageBin(from, to);
      expect(statSync(join(to, "hermetic")).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(from, { recursive: true, force: true });
      rmSync(to, { recursive: true, force: true });
    }
  });

  // The whole reason this module exists. Each item is removed in turn, so no
  // single item can be the only one anybody checks for.
  for (const item of STAGED_ITEMS) {
    test(`refuses when ${item.name} is missing`, () => {
      const from = completeDist();
      const to = tempOut();
      try {
        rmSync(join(from, item.name), { recursive: true, force: true });
        expect(() => stageBin(from, to)).toThrow(StagingError);
        expect(() => stageBin(from, to)).toThrow(item.name);
      } finally {
        rmSync(from, { recursive: true, force: true });
        rmSync(to, { recursive: true, force: true });
      }
    });
  }

  // The refusal has to name every missing item, not the first one it trips
  // over: someone reading "hermeticd is missing" rebuilds the agent, ships
  // again, and discovers the stamps were missing too.
  test("names every missing item, not just the first", () => {
    const from = completeDist();
    const to = tempOut();
    try {
      rmSync(join(from, "hermeticd"), { force: true });
      rmSync(join(from, "hermeticd.version"), { force: true });
      expect(() => stageBin(from, to)).toThrow(/hermeticd, hermeticd\.version/);
    } finally {
      rmSync(from, { recursive: true, force: true });
      rmSync(to, { recursive: true, force: true });
    }
  });

  test("refuses a file where the stages directory belongs", () => {
    const from = completeDist();
    const to = tempOut();
    try {
      rmSync(join(from, "stages"), { recursive: true, force: true });
      writeFileSync(join(from, "stages"), "not a directory\n");
      expect(() => stageBin(from, to)).toThrow(StagingError);
    } finally {
      rmSync(from, { recursive: true, force: true });
      rmSync(to, { recursive: true, force: true });
    }
  });

  test("replaces what an earlier build left behind", () => {
    const from = completeDist();
    const to = tempOut();
    try {
      mkdirSync(to, { recursive: true });
      writeFileSync(join(to, "hermetic-portal"), "stale head\n");
      stageBin(from, to);
      expect(existsSync(join(to, "hermetic-portal"))).toBe(false);
    } finally {
      rmSync(from, { recursive: true, force: true });
      rmSync(to, { recursive: true, force: true });
    }
  });

  test("names no head binary: the app is the head", () => {
    expect(STAGED_ITEMS.map((i) => i.name)).not.toContain("hermetic-portal");
  });
});

/**
 * The vendored faces (§3.6).
 *
 * `build.copy` carries `packages/ui/fonts` into the bundle whole, without
 * looking inside it, and the app has no network behind `views://` — so a
 * `fonts.css` naming a file that is not beside it is not a slow first paint,
 * it is the entire portal drawn in Helvetica out of a bundle that built and
 * signed without a word. Same class of failure as a missing `hermeticd`, and
 * checked the same way.
 */
describe("checkFonts", () => {
  function fontsDir(css: string, files: readonly string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "hermetic-fonts-"));
    writeFileSync(join(dir, "fonts.css"), css);
    for (const file of files) writeFileSync(join(dir, file), "woff2");
    return dir;
  }

  test("reads every local url, quoted or bare, and skips the remote ones", () => {
    expect(
      cssUrls(
        'src: url("./a.woff2") format("woff2");' +
          "src: url('b.woff2');" +
          "src: url(c.woff2?v=2);" +
          "src: url(https://fonts.gstatic.com/d.woff2);" +
          "src: url(data:font/woff2;base64,AAA);",
      ),
    ).toEqual(["./a.woff2", "b.woff2", "c.woff2"]);
  });

  test("passes when every face named is there", () => {
    const dir = fontsDir('@font-face { src: url("./one.woff2") format("woff2"); }', ["one.woff2"]);
    try {
      expect(checkFonts(dir)).toEqual(["./one.woff2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses on a face the stylesheet names and the directory does not have", () => {
    const dir = fontsDir(
      '@font-face { src: url("./one.woff2"); } @font-face { src: url("./gone.woff2"); }',
      ["one.woff2"],
    );
    try {
      expect(() => checkFonts(dir)).toThrow(StagingError);
      expect(() => checkFonts(dir)).toThrow(/gone\.woff2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses when there is no stylesheet at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermetic-fonts-"));
    try {
      expect(() => checkFonts(dir)).toThrow(/fonts\.css is missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the repository's own fonts directory passes", () => {
    const faces = checkFonts(new URL("../packages/ui/fonts", import.meta.url).pathname);
    expect(faces.length).toBeGreaterThan(0);
  });
});
