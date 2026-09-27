/**
 * The toolchain pins, kept from drifting apart.
 *
 * Four files name a version of something Hutch builds this app with, and each
 * one is read by a different consumer: the installer reads `.hutch-version`,
 * the `hutch` launcher reads the pragma on the first line of `hutch.config.ts`,
 * `bun install` reads the `electrobun` devDependency, and `hutch electrobun
 * prepare` wrote what it resolved into `.hutch/dependencies.lock`. Nothing
 * makes them agree except this test, so a bump that touches one and forgets
 * another is a build failure here rather than a mismatch discovered on a
 * release machine.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import hutchConfig from "../hutch.config.ts";

const appDir = new URL("..", import.meta.url).pathname;
const repoRoot = join(appDir, "..", "..");

const dependenciesLock = join(appDir, ".hutch", "dependencies.lock");

const hutchVersionFile = readFileSync(join(repoRoot, ".hutch-version"), "utf8");
const hutchConfigText = readFileSync(join(appDir, "hutch.config.ts"), "utf8");
const appPackage = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as {
  devDependencies?: Record<string, string>;
};

/** The pinned Electrobun, refused rather than compared when it is absent. */
function electrobunPin(): string {
  const pin = appPackage.devDependencies?.["electrobun"];
  expect(pin, "packages/app must devDepend on electrobun").toBeString();
  return pin as string;
}

/** The `// @hutch cli=… cottontail=…` line the launcher reads before anything else. */
function pragma(): Record<string, string> {
  const first = hutchConfigText.split("\n")[0] ?? "";
  const match = first.match(/^\/\/ @hutch (.+)$/);
  expect(match, "hutch.config.ts must open with the `// @hutch …` pragma").not.toBeNull();
  const pairs: Record<string, string> = {};
  for (const token of (match?.[1] ?? "").split(/\s+/)) {
    const [key, value] = token.split("=");
    if (key && value) pairs[key] = value;
  }
  return pairs;
}

describe("toolchain pins", () => {
  test(".hutch-version is exactly one version and nothing else", () => {
    expect(hutchVersionFile).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  test("the pragma's cli pin is the version the installer would install", () => {
    expect(pragma()["cli"]).toBe(hutchVersionFile.trim());
  });

  test("the pragma names a cottontail runtime", () => {
    expect(pragma()["cottontail"]).toBeDefined();
  });

  /**
   * The pragma's `cottontail=` against the devkit that is actually projected.
   *
   * `.hutch/dependencies.lock` is what `hutch electrobun prepare` wrote: one
   * `release` object per product, with the version it resolved. A pragma that
   * names a different runtime than the projection would build the app against
   * types from one WebKit and ship another.
   *
   * Skipped where there is no devkit, which is every fresh clone and every CI
   * job that does not install Hutch. `bun run typecheck` is where the absence
   * is reported, once, with the command that fixes it.
   */
  test.skipIf(!existsSync(dependenciesLock))("the pragma's cottontail is the projected one", () => {
    const lock = JSON.parse(readFileSync(dependenciesLock, "utf8")) as {
      objects?: { product?: string; version?: string }[];
    };
    const cottontail = lock.objects?.find((o) => o.product === "cottontail");
    expect(cottontail?.version, "dependencies.lock must record a cottontail release").toBeString();
    expect(pragma()["cottontail"]).toBe(cottontail?.version as string);
  });

  test("the configured Electrobun version is the one bun installs", () => {
    expect(hutchConfig.electrobun.version).toBe(electrobunPin());
  });

  test("the lockfile pins Electrobun exactly, with no range", () => {
    expect(electrobunPin()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("Hutch manages no packages of its own", () => {
    // The repo has exactly one lockfile. Hutch installing into `packages/app`
    // would make a second one, which is the thing `packageManager: "bun"` says.
    expect(hutchConfig.packageManager).toBe("bun");
  });
});
