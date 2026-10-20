/**
 * The lock on the artifacts bundle (§6.6), the counterpart of
 * `foundation-version.test.ts` for the hermeticd binary and its stages.
 *
 * `ARTIFACTS_VERSION` numbers the bundle; `sourceFingerprint` is what actually
 * changed. An edit to anything a push is built from moves the fingerprint, this
 * test fails, and the author bumps the version so every fleet on the old bundle
 * is offered the update. A hand-written literal, so `bun test -u` cannot move it.
 *
 * The fingerprint is taken over the files git sees (tracked, plus untracked and
 * not ignored) copied to a scratch root, not over the checkout itself: the walk
 * hashes every file on disk, so an ignored `.DS_Store` or editor swap file would
 * otherwise make the digest machine-local.
 */
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ARTIFACTS_VERSION } from "../src/version.ts";
import { BUILD_VERSIONS } from "../src/build-versions.ts";
import {
  FINGERPRINT_DIRS,
  FINGERPRINT_FILES,
  findRepoRoot,
  sourceFingerprint,
} from "../src/release/artifacts-release.ts";

/** Artifacts version → the `sourceFingerprint` of the sources that version ships. */
const ARTIFACTS_FINGERPRINT: Record<number, string> = {
  1: "f577b064a7c7fb458f659d1676708af863a2a78b012fa03330a35aff5125e2ef",
  2: "b3971120ebf1e8176cd370acd2fa19ddd67dba320d4313ee10fde2fcd228e8c3",
  3: "2c11d67ab4869a0b5cd29c9e75e8801325b3d12b6bd95c18507930c096ecdbb1",
};

function gitVisibleFingerprint(root: string): string {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-co", "--exclude-standard", "--", ...FINGERPRINT_DIRS, ...FINGERPRINT_FILES],
    { cwd: root },
  );
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  const scratch = mkdtempSync(join(tmpdir(), "hermetic-artifacts-version-"));
  try {
    for (const file of listed.stdout.toString().split("\n").filter(Boolean)) {
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      copyFileSync(join(root, file), join(scratch, file));
    }
    return sourceFingerprint(scratch, BUILD_VERSIONS.hermeticd);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("artifacts version", () => {
  test("the bundle's sources match the fingerprint recorded for this version", () => {
    const root = findRepoRoot();
    if (root === null) throw new Error("no repo root above this test");
    expect(gitVisibleFingerprint(root)).toBe(
      ARTIFACTS_FINGERPRINT[ARTIFACTS_VERSION] ??
        "the hermeticd bundle changed — bump ARTIFACTS_VERSION (packages/core/src/version.ts) and add the new fingerprint to this table",
    );
  });

  test("the scratch copy hashes the same as the checkout when nothing stray is on disk", () => {
    const root = findRepoRoot();
    if (root === null) throw new Error("no repo root above this test");
    // Not a pin, a check that the copy above loses nothing the walk would read.
    const listed = Bun.spawnSync(
      ["git", "status", "--porcelain", "--ignored", "--", ...FINGERPRINT_DIRS, ...FINGERPRINT_FILES],
      { cwd: root },
    );
    // An ignored file on disk is exactly what the copy leaves out, so there is nothing to compare.
    if (listed.stdout.toString().includes("!! ")) return;
    expect(gitVisibleFingerprint(root)).toBe(sourceFingerprint(root, BUILD_VERSIONS.hermeticd));
  });
});
