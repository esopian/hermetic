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
  3: "bdb624dc28c8dd5c2ffbec72a191e425040f089d7919d3709b7e9eeeff58831e",
  4: "d986ea47817e56e31801d8ea997f84213ef746963f51f4dfd021ee69d3453c43",
  5: "4e38f6d890cd3cf4b09f254404933e07d4315cd23a7aed459bef6f3e61c4c72a",
  6: "62aa95ae4e73c78befd4b45ea9b5c2c12242ef65e4e1a81bb0e22ca5766872e4",
  7: "6e4cb81ef7aa19296ce8a28d17bcc3afbf925243d216e1edf966577a9e7a6020",
  8: "6d16f91b3b6ab0c616a6ee9a164df1f89ba8bf69615f607b518d3cdd8dc3dfec",
  9: "f4e03607bef77295641d5a28b8fc7f4cfff58153366180df93e73f7c67bc4cf8",
  10: "f15c6c81845a590a86f881f995f3488cf667c2be130353e2f43118a223cac95f",
  11: "af80832162fef89e60879e0ffc7588a2c8ccc6ff34cc58c99cbcde3ac6b34a1e",
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
