/**
 * The pure half of `scripts/release.ts`: version arithmetic, the package.json
 * edit, argument parsing and the asset check. The git and gh half is not run
 * here — it pushes tags, and a pushed tag is permanent.
 */
import { describe, expect, test } from "bun:test";
import { missingAssets, nextVersion, parseArgs, setVersion } from "../scripts/release.ts";

describe("nextVersion", () => {
  test("bumps by keyword", () => {
    expect(nextVersion("0.1.6", "patch")).toBe("0.1.7");
    expect(nextVersion("0.1.6", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.6", "major")).toBe("1.0.0");
  });

  test("accepts an exact newer version", () => {
    expect(nextVersion("0.1.6", "0.1.10")).toBe("0.1.10");
    expect(nextVersion("0.9.9", "1.0.0")).toBe("1.0.0");
  });

  test("refuses an exact version that is not newer", () => {
    expect(() => nextVersion("0.1.6", "0.1.6")).toThrow("not newer");
    expect(() => nextVersion("0.2.0", "0.1.9")).toThrow("not newer");
  });

  test("refuses anything that is not a keyword or x.y.z", () => {
    expect(() => nextVersion("0.1.6", "v0.1.7")).toThrow("is not patch");
    expect(() => nextVersion("0.1.6", "0.1.7-rc.1")).toThrow("is not patch");
    expect(() => nextVersion("0.1", "patch")).toThrow("is not x.y.z");
  });
});

describe("setVersion", () => {
  test("replaces the version and nothing else", () => {
    const before = '{\n  "name": "hermetic",\n  "version": "0.1.6",\n  "private": true\n}\n';
    expect(setVersion(before, "0.1.7")).toBe(
      '{\n  "name": "hermetic",\n  "version": "0.1.7",\n  "private": true\n}\n',
    );
  });

  test("refuses a package.json without a version", () => {
    expect(() => setVersion('{ "name": "x" }', "1.0.0")).toThrow('no "version"');
  });
});

describe("parseArgs", () => {
  test("defaults to a watched, checked patch release", () => {
    expect(parseArgs([])).toEqual({
      spec: "patch",
      skipCheck: false,
      yes: false,
      watch: true,
      dryRun: false,
    });
  });

  test("reads the bump and every flag", () => {
    expect(parseArgs(["minor", "--skip-check", "-y", "--no-watch", "--dry-run"])).toEqual({
      spec: "minor",
      skipCheck: true,
      yes: true,
      watch: false,
      dryRun: true,
    });
  });

  test("refuses an unknown flag or a second positional", () => {
    expect(() => parseArgs(["--force"])).toThrow("unknown option");
    expect(() => parseArgs(["patch", "minor"])).toThrow("unexpected argument");
  });
});

describe("missingAssets", () => {
  test("names what a release lacks, ignoring extras like the delta patch", () => {
    expect(
      missingAssets([
        "macos-arm64-Hermetic.dmg",
        "stable-macos-arm64-update.json",
        "stable-macos-arm64-abc.patch",
      ]),
    ).toEqual(["stable-macos-arm64-Hermetic.app.tar.zst"]);
  });
});
