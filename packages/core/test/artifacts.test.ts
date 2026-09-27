/**
 * `artifacts.ts`: where `hermeticd` comes from (§3.6). Three lookups in order,
 * a version stamp that can refuse, and a source build that is cached by what
 * it is built from. The real compiler is never run here; `build` is injected.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTD_ENTRY,
  AGENTD_OUT,
  HERMETICD_ENV,
  findRepoRoot,
  localBuild,
  locateStages,
  resolveHermeticd,
  sourceFingerprint,
} from "../src/release/artifacts.ts";
import { HermeticError } from "../src/errors.ts";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "hermetic-artifacts-"));
  tmp.push(d);
  return d;
}
/** A fake checkout: just the files the resolver looks at. */
function checkout(): string {
  const root = dir();
  mkdirSync(join(root, "packages/agentd/src"), { recursive: true });
  mkdirSync(join(root, "packages/core/src/schema"), { recursive: true });
  writeFileSync(join(root, AGENTD_ENTRY), "console.log('hermeticd')\n");
  writeFileSync(join(root, "packages/core/src/schema/index.ts"), "export {}\n");
  return root;
}
const fakeBuild = () => {
  const calls: string[] = [];
  return {
    calls,
    build: async (req: { outfile: string; version: string }) => {
      calls.push(req.outfile);
      mkdirSync(join(req.outfile, ".."), { recursive: true });
      writeFileSync(req.outfile, `binary ${req.version}`);
    },
  };
};

describe("resolving hermeticd", () => {
  test("nothing anywhere → null, not an error", async () => {
    const empty = dir();
    const found = await resolveHermeticd({
      version: "0.4.1",
      env: {},
      execPath: join(empty, "hermetic"),
      repoRoot: null,
    });
    expect(found).toBeNull();
  });

  test("the env var wins, and a matching stamp is read", async () => {
    const d = dir();
    writeFileSync(join(d, "hd"), "bin");
    writeFileSync(join(d, "hd.version"), "0.4.1\n");
    const found = await resolveHermeticd({
      version: "0.4.1",
      env: { [HERMETICD_ENV]: join(d, "hd") },
      execPath: join(d, "elsewhere/hermetic"),
      repoRoot: null,
    });
    expect(found).toEqual({ path: join(d, "hd"), source: "explicit", version: "0.4.1", build: null });
  });

  test("a stamp that disagrees with the version being pushed is a refusal", async () => {
    const d = dir();
    writeFileSync(join(d, "hd"), "bin");
    writeFileSync(join(d, "hd.version"), "0.3.0\n");
    let err: unknown;
    try {
      await resolveHermeticd({
        version: "0.4.1",
        env: { [HERMETICD_ENV]: join(d, "hd") },
        repoRoot: null,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HermeticError);
    expect((err as HermeticError).code).toBe("HERMETICD_UNAVAILABLE");
    expect((err as HermeticError).message).toContain("0.3.0");
  });

  test("an env var pointing nowhere is an error, not a fall-through", async () => {
    let code: string | null = null;
    try {
      await resolveHermeticd({
        version: "0.4.1",
        env: { [HERMETICD_ENV]: "/nope/hermeticd" },
        repoRoot: null,
      });
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("HERMETICD_UNAVAILABLE");
  });

  test("the sibling of the running executable is the shipped-binary path", async () => {
    const d = dir();
    writeFileSync(join(d, "hermetic"), "cli");
    writeFileSync(join(d, "hermeticd"), "agent");
    writeFileSync(join(d, "hermeticd.version"), "0.4.1");
    const found = await resolveHermeticd({
      version: "0.4.1",
      env: {},
      execPath: join(d, "hermetic"),
      repoRoot: null,
    });
    expect(found).toEqual({
      path: join(d, "hermeticd"),
      source: "sibling",
      version: "0.4.1",
      build: null,
    });
  });

  test("a source checkout builds once and reuses the build until the sources change", async () => {
    const root = checkout();
    const fb = fakeBuild();
    const opts = {
      version: "0.4.1",
      env: {},
      execPath: join(dir(), "hermetic"),
      repoRoot: root,
      build: fb.build,
    };
    const first = await resolveHermeticd(opts);
    expect(first).toEqual({
      path: join(root, AGENTD_OUT),
      source: "built",
      version: "0.4.1",
      // The built candidate's build *is* the fingerprint it was cached under.
      build: sourceFingerprint(root, "0.4.1"),
    });
    expect(readFileSync(join(root, `${AGENTD_OUT}.version`), "utf8").trim()).toBe("0.4.1");
    expect(fb.calls).toHaveLength(1);

    await resolveHermeticd(opts);
    expect(fb.calls).toHaveLength(1); // cached

    writeFileSync(join(root, AGENTD_ENTRY), "console.log('hermeticd v2')\n");
    await resolveHermeticd(opts);
    expect(fb.calls).toHaveLength(2); // source changed → rebuilt

    await resolveHermeticd({ ...opts, version: "0.5.0" });
    expect(fb.calls).toHaveLength(3); // version changed → rebuilt
  });

  test("the fingerprint covers agentd's sources and core's schema, and the version", () => {
    const root = checkout();
    const a = sourceFingerprint(root, "0.4.1");
    expect(sourceFingerprint(root, "0.4.1")).toBe(a);
    expect(sourceFingerprint(root, "0.4.2")).not.toBe(a);
    writeFileSync(join(root, "packages/core/src/schema/index.ts"), "export const x = 1\n");
    expect(sourceFingerprint(root, "0.4.1")).not.toBe(a);
  });

  /**
   * The stages are not compiled into the binary, which is exactly why they were
   * missing from the fingerprint — and why the omission was invisible.
   * `releaseDrift`'s warning names them ("if hermeticd *or its stages* changed,
   * run `hermetic artifacts push`"), so a stage edit that did not move the
   * fingerprint meant the one check that catches a forgotten push stayed silent
   * for the most ordinary way to need it.
   */
  test("the fingerprint covers the bootstrap stages, which ship with the binary", () => {
    const root = checkout();
    const a = sourceFingerprint(root, "0.4.1");
    mkdirSync(join(root, "packages/agentd/stages"), { recursive: true });
    writeFileSync(join(root, "packages/agentd/stages/00-preflight.sh"), "#!/bin/bash\necho hi\n");
    const b = sourceFingerprint(root, "0.4.1");
    expect(b).not.toBe(a);
    // And an edit to an existing stage moves it again — not just its arrival.
    writeFileSync(join(root, "packages/agentd/stages/00-preflight.sh"), "#!/bin/bash\necho bye\n");
    expect(sourceFingerprint(root, "0.4.1")).not.toBe(b);
  });

  /**
   * The toolchain and the resolved dependency graph change what `bun build
   * --compile` emits without touching a single hashed source file, so a cache
   * keyed only on sources hands back a binary from before the change.
   */
  test("the fingerprint covers the pinned toolchain and the lockfile", () => {
    const root = checkout();
    writeFileSync(join(root, ".bun-version"), "1.3.10\n");
    const a = sourceFingerprint(root, "0.4.1");
    writeFileSync(join(root, ".bun-version"), "1.3.11\n");
    const b = sourceFingerprint(root, "0.4.1");
    expect(b).not.toBe(a);
    writeFileSync(join(root, "bun.lock"), '{"lockfileVersion": 1}\n');
    expect(sourceFingerprint(root, "0.4.1")).not.toBe(b);
  });

  test("a build stamp beside the binary is read; without one the build is null", async () => {
    const d = dir();
    writeFileSync(join(d, "hd"), "bin");
    writeFileSync(join(d, "hd.version"), "0.4.1\n");
    const bare = await resolveHermeticd({
      version: "0.4.1",
      env: { [HERMETICD_ENV]: join(d, "hd") },
      repoRoot: null,
    });
    expect(bare?.build).toBeNull();

    writeFileSync(join(d, "hd.build"), "abc123\n");
    const stamped = await resolveHermeticd({
      version: "0.4.1",
      env: { [HERMETICD_ENV]: join(d, "hd") },
      repoRoot: null,
    });
    expect(stamped?.build).toBe("abc123");
  });

  test("a sibling's build stamp is read the same way", async () => {
    const d = dir();
    writeFileSync(join(d, "hermetic"), "cli");
    writeFileSync(join(d, "hermeticd"), "agent");
    writeFileSync(join(d, "hermeticd.version"), "0.4.1");
    writeFileSync(join(d, "hermeticd.build"), "deadbeef\n");
    const found = await resolveHermeticd({
      version: "0.4.1",
      env: {},
      execPath: join(d, "hermetic"),
      repoRoot: null,
    });
    expect(found?.build).toBe("deadbeef");
  });

  test("the repo root is found from anywhere inside it, and nowhere outside", () => {
    const root = checkout();
    expect(findRepoRoot(join(root, "packages/core/src/schema"))).toBe(root);
    expect(findRepoRoot(dir())).toBeNull();
    // This checkout is one too — the default lookup must land on it.
    expect(existsSync(join(findRepoRoot()!, AGENTD_ENTRY))).toBe(true);
  });
});

/**
 * `localBuild` answers the question `create` and `rerun` ask on every run:
 * which build would *this* process push? It may not compile anything to find
 * out, and it may not fail because there is nothing to find.
 */
describe("localBuild", () => {
  test("on a source checkout it is the fingerprint, and it never builds", () => {
    const root = checkout();
    const fb = fakeBuild();
    expect(
      localBuild({ version: "0.4.1", env: {}, execPath: join(dir(), "hermetic"), repoRoot: root }),
    ).toBe(sourceFingerprint(root, "0.4.1"));
    // Nothing was compiled: the hook `resolveHermeticd` would have called is
    // not even reachable from here, and no output file appeared.
    expect(fb.calls).toHaveLength(0);
    expect(existsSync(join(root, AGENTD_OUT))).toBe(false);
  });

  test("off a checkout it is the sibling's stamp, or null when there is none", () => {
    const d = dir();
    writeFileSync(join(d, "hermetic"), "cli");
    writeFileSync(join(d, "hermeticd"), "agent");
    const opts = { version: "0.4.1", env: {}, execPath: join(d, "hermetic"), repoRoot: null };
    expect(localBuild(opts)).toBeNull();
    writeFileSync(join(d, "hermeticd.build"), "f00d\n");
    expect(localBuild(opts)).toBe("f00d");
  });

  test("an explicit path wins, and one pointing nowhere is null rather than a throw", () => {
    const d = dir();
    writeFileSync(join(d, "hd"), "bin");
    writeFileSync(join(d, "hd.build"), "explicit-build\n");
    expect(
      localBuild({ version: "0.4.1", env: { [HERMETICD_ENV]: join(d, "hd") }, repoRoot: null }),
    ).toBe("explicit-build");
    expect(
      localBuild({ version: "0.4.1", env: { [HERMETICD_ENV]: "/nope/hermeticd" }, repoRoot: null }),
    ).toBeNull();
  });

  test("with nothing anywhere it is null, not an error", () => {
    const empty = dir();
    expect(
      localBuild({ version: "0.4.1", env: {}, execPath: join(empty, "hermetic"), repoRoot: null }),
    ).toBeNull();
  });
});

/**
 * A distributed `dist/<target>/` directory, as an operator who downloaded and
 * unpacked one has it: no source checkout anywhere above it, and no
 * `HERMETIC_HERMETICD`/`HERMETIC_STAGES` in the environment to make up for a
 * missing file. Everything the resolver is allowed to use is inside the bundle.
 *
 * This is the case the sibling lookup exists for, and the one that was broken:
 * `scripts/build.ts` wrote `hermeticd` at the *parent* level of `dist/` while
 * cross-compiling the heads into `dist/<target>/`, so an unpacked target
 * directory held two binaries that could not find their agent. On the machine
 * that ran the build the source-build branch covered for it; everywhere else
 * `init` refused with `HERMETICD_UNAVAILABLE`.
 */
describe("a distributed target directory", () => {
  /** `dist/<target>/` as `scripts/build.ts` now lays it down. */
  function bundle(version: string): string {
    const d = dir();
    writeFileSync(join(d, "hermetic"), "cli");
    writeFileSync(join(d, "hermetic-portal"), "portal");
    writeFileSync(join(d, "hermeticd"), "agent");
    writeFileSync(join(d, "hermeticd.version"), `${version}\n`);
    writeFileSync(join(d, "hermeticd.build"), "bundled-build\n");
    mkdirSync(join(d, "stages"), { recursive: true });
    writeFileSync(join(d, "stages", "00-preflight.sh"), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(d, "stages", "01-tailscale.sh"), "#!/usr/bin/env bash\nexit 0\n");
    return d;
  }

  test("is a complete install: the binary, its stamps and the stages, with no repo above it", async () => {
    const d = bundle("0.4.1");
    // The premise of the test, asserted rather than assumed: nothing above the
    // unpacked directory is a hermetic source tree, so the third lookup — the
    // one that covers for a broken bundle on the build machine — cannot fire.
    const repoRoot = findRepoRoot(d);
    expect(repoRoot).toBeNull();

    const found = await resolveHermeticd({
      version: "0.4.1",
      env: {},
      execPath: join(d, "hermetic"),
      repoRoot,
    });
    expect(found).toEqual({
      path: join(d, "hermeticd"),
      source: "sibling",
      version: "0.4.1",
      build: "bundled-build",
    });

    const stages = locateStages({ env: {}, execPath: join(d, "hermetic"), repoRoot });
    expect(stages?.source).toBe("sibling");
    expect(stages?.names).toEqual(["00-preflight.sh", "01-tailscale.sh"]);
  });

  test("the portal binary in it resolves the same release the CLI beside it would", async () => {
    const d = bundle("0.4.1");
    const found = await resolveHermeticd({
      version: "0.4.1",
      env: {},
      execPath: join(d, "hermetic-portal"),
      repoRoot: findRepoRoot(d),
    });
    expect(found?.path).toBe(join(d, "hermeticd"));
  });

  test("a bundle stamped with another release refuses; it does not fall back", async () => {
    const d = bundle("0.3.0");
    let err: unknown;
    try {
      await resolveHermeticd({
        version: "0.4.1",
        env: {},
        execPath: join(d, "hermetic"),
        // A source tree *is* reachable here, and must still not be reached: a
        // stamp that disagrees is a refusal, never a reason to look further.
        repoRoot: checkout(),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HermeticError);
    expect((err as HermeticError).code).toBe("HERMETICD_UNAVAILABLE");
    expect((err as HermeticError).message).toContain("0.3.0");
  });

  /**
   * Why the stamps are part of the copy rather than a nicety. Without them the
   * bundle still resolves — an unstamped binary is the shape an explicit
   * `HERMETIC_HERMETICD` has, and refusing that would break it — but it pushes
   * a release whose version nothing checked and whose build nothing can name,
   * so `releaseDrift` has nothing to compare and stays quiet for good.
   */
  test("without its stamps the bundle still pushes, but says nothing about what it is", async () => {
    const d = bundle("0.4.1");
    rmSync(join(d, "hermeticd.version"));
    rmSync(join(d, "hermeticd.build"));
    const found = await resolveHermeticd({
      version: "0.4.1",
      env: {},
      execPath: join(d, "hermetic"),
      repoRoot: findRepoRoot(d),
    });
    expect(found).toEqual({
      path: join(d, "hermeticd"),
      source: "sibling",
      version: null,
      build: null,
    });
    const build = localBuild({
      version: "0.4.1",
      env: {},
      execPath: join(d, "hermetic"),
      repoRoot: null,
    });
    expect(build).toBeNull();
  });
});
