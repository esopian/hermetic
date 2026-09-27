/**
 * The seam between what `scripts/build.ts` compiles into `hermeticd` and what
 * every other part of the system believes that binary is.
 *
 * It is a root test for the usual reason (`tests/README` aside: no package may
 * import both sides) — `scripts/` builds it, `packages/core` pushes it, and
 * `packages/agentd` reads it back at runtime. Nothing but a test that sees all
 * three can hold them equal.
 *
 * The bug this exists for: `buildAgentd` used to pass root `package.json`'s
 * version — the *tool's* `HERMETIC_VERSION`, `0.1.0` — to the compile, while
 * writing `BUILD_VERSIONS.hermeticd` (`0.5.0`) into the `hermeticd.version`
 * stamp beside it. `resolveHermeticd` checks the stamp file and never the
 * binary, so the release pushed cleanly and every box then heartbeated a
 * version no fleet manifest names: `foundation.status` marked every agent out
 * of date forever and `foundation update`'s rollout never confirmed. The only
 * visible symptom was a number that would not move.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTD_ARTIFACTS,
  AGENTD_ENTRY,
  AGENTD_TARGET,
  VERSION_DEFINE,
  agentdBuildPlan,
  copyAgentd,
  stampedVersion,
} from "../scripts/agentd-build.ts";
import { BUILD_VERSIONS } from "../packages/core/src/hermetic.ts";
import { HERMETIC_VERSION } from "../packages/core/src/version.ts";

const root = new URL("..", import.meta.url).pathname;

describe("the hermeticd build stamp", () => {
  test("compiles in BUILD_VERSIONS.hermeticd, which is what the fleet manifest names", () => {
    const plan = agentdBuildPlan(root, "/tmp/hermeticd");
    expect(stampedVersion(plan.args)).toBe(BUILD_VERSIONS.hermeticd);
  });

  test("stamps the file beside the binary with the same string it compiled in", () => {
    // `build.ts` writes `<outfile>.version` from `plan.version`; the two being
    // one field is the point, so this asserts they agree at the source.
    const plan = agentdBuildPlan(root, "/tmp/hermeticd");
    const stamped = stampedVersion(plan.args);
    expect(stamped).not.toBeNull();
    expect(plan.version).toBe(stamped as string);
  });

  /**
   * The regression itself, spelled out. These are two different numbers in this
   * repo and the whole failure was passing one where the other belonged — so if
   * they are ever made equal, this test says which assumption just went away
   * rather than passing silently and leaving the next mix-up undetectable.
   */
  test("the tool's own version is not the fleet software's version", async () => {
    /**
     * Read out of `package.json`, not out of `HERMETIC_VERSION`.
     *
     * `HERMETIC_VERSION` is `"0.0.0-dev"` in the test runner — the `--define`
     * only lands in a compiled binary — so comparing against it asserted that
     * the release version is not the string `0.0.0-dev`, which it never could
     * be. The two numbers this is actually about are `package.json`'s and
     * `BUILD_VERSIONS.hermeticd`'s, and the whole bug was passing one where the
     * other belonged.
     */
    const pkg = (await Bun.file(join(root, "package.json")).json()) as { version?: string };
    expect(pkg.version).toBeTruthy();
    expect(BUILD_VERSIONS.hermeticd).not.toBe(pkg.version);
    // And the dev-run fallback is not one of them either.
    expect(HERMETIC_VERSION).toBe("0.0.0-dev");
  });

  test("builds the agentd entrypoint, for linux-arm64", () => {
    const plan = agentdBuildPlan(root, "/tmp/hermeticd");
    expect(plan.entry).toBe(join(root, AGENTD_ENTRY));
    expect(plan.args).toContain(`--target=${AGENTD_TARGET}`);
  });
});

describe("the define actually reaches hermeticd's version module", () => {
  /**
   * Bun only rewrites the exact member expression `process.env.HERMETIC_VERSION`
   * — `process.env["HERMETIC_VERSION"]` is left alone — so `agentd-build.ts`'s
   * flag and `packages/agentd/src/version.ts`'s access have to agree character
   * for character. Both say so in a comment. A comment is what was there while
   * the build passed the wrong version for however long it did, so this bundles
   * the module for real and reads the answer back out.
   *
   * Bundled, not `--compile`d, and for no particular target: this asserts the
   * substitution happened, which is a property of the bundler and not of the
   * output format. A cross-compile would download a linux-arm64 Bun runtime,
   * and no test here reaches the network.
   */
  test("bundling version.ts with the build's own flag inlines the version", async () => {
    const out = mkdtempSync(join(tmpdir(), "hermetic-stamp-"));
    try {
      const proc = Bun.spawn(
        [
          "bun",
          "build",
          "--define",
          `${VERSION_DEFINE}="${BUILD_VERSIONS.hermeticd}"`,
          join(root, "packages/agentd/src/version.ts"),
          "--outfile",
          join(out, "version.js"),
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code, `bun build failed: ${stderr}`).toBe(0);

      const bundled = await Bun.file(join(out, "version.js")).text();
      // The literal is present…
      expect(bundled).toContain(BUILD_VERSIONS.hermeticd);
      // …and the lookup it replaced is gone, which is the half that fails if
      // the access in `version.ts` is ever changed to bracket notation.
      expect(bundled).not.toContain("process.env.HERMETIC_VERSION");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

/**
 * `copyAgentd` is what makes a cross-compiled `dist/<target>/` an install
 * rather than a pair of heads (§3.6). `resolveHermeticd` looks for `hermeticd`
 * *beside the running executable*; while the build wrote it one directory up,
 * an unpacked target directory had no agent in it at all, and the only machine
 * where that did not show was the one that ran the build — which has a source
 * checkout for the resolver to fall back to.
 */
describe("the per-target bundle", () => {
  const tmp: string[] = [];
  afterEach(() => {
    for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function dir(): string {
    const d = mkdtempSync(join(tmpdir(), "hermetic-bundle-"));
    tmp.push(d);
    return d;
  }
  /** What `buildAgentd` leaves in `dist/`. */
  function built(): string {
    const d = dir();
    writeFileSync(join(d, "hermeticd"), "ELF");
    chmodSync(join(d, "hermeticd"), 0o755);
    writeFileSync(join(d, "hermeticd.version"), "0.5.0\n");
    writeFileSync(join(d, "hermeticd.build"), "f1n6erpr1nt\n");
    return d;
  }

  test("copies the binary and both stamps, which is what the resolver reads", () => {
    const from = built();
    const target = dir();
    expect(copyAgentd(from, target)).toEqual([...AGENTD_ARTIFACTS]);
    expect(readFileSync(join(target, "hermeticd"), "utf8")).toBe("ELF");
    expect(readFileSync(join(target, "hermeticd.version"), "utf8").trim()).toBe("0.5.0");
    expect(readFileSync(join(target, "hermeticd.build"), "utf8").trim()).toBe("f1n6erpr1nt");
  });

  test("the copy is still executable: a box is launched from these bytes", () => {
    const from = built();
    const target = dir();
    copyAgentd(from, target);
    // The owner-execute bit, which `copyFileSync` carries over from the source.
    expect(statSync(join(target, "hermeticd")).mode & 0o100).not.toBe(0);
  });

  test("creates the target directory when it does not exist yet", () => {
    const from = built();
    const target = join(dir(), "bun-darwin-arm64");
    copyAgentd(from, target);
    expect(existsSync(join(target, "hermeticd"))).toBe(true);
  });

  test("refuses when a stamp is missing rather than shipping a bundle that cannot say what it is", () => {
    const from = built();
    rmSync(join(from, "hermeticd.build"));
    expect(() => copyAgentd(from, dir())).toThrow("hermeticd.build");
  });

  test("refuses when there is no binary to copy at all", () => {
    expect(() => copyAgentd(dir(), dir())).toThrow("hermeticd");
  });
});
