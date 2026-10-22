/**
 * The update-signing private key lives in exactly two places: the
 * `UPDATE_SIGNING_KEY` repository secret and the maintainer's offline backup.
 * Never in the tree (CONTRIBUTING.md "Update signing").
 *
 * Every Ed25519 private key in PKCS#8 form starts with the same 16 bytes, so
 * that prefix — in base64 (a PEM body) or hex — finds one in any file without
 * this test knowing the key. The prefix is derived from a key generated here,
 * so this file holds no literal for itself to match.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const der = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" });
/** 15 bytes encode to exactly 20 base64 characters, with no dependence on what follows. */
const PEM_PREFIX = der.subarray(0, 15).toString("base64");
const HEX_PREFIX = der.subarray(0, 16).toString("hex");

function trackedFiles(): string[] {
  // Tracked plus untracked-but-not-ignored: a key file about to be committed counts.
  const out = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: ROOT,
  });
  expect(out.exitCode).toBe(0);
  return out.stdout
    .toString()
    .split("\0")
    .filter((f) => f !== "");
}

describe("the update-signing private key", () => {
  test("the prefix is the one every Ed25519 PKCS#8 key has", () => {
    expect(HEX_PREFIX).toBe(["302e0201003005", "06032b6570", "04220420"].join(""));
  });

  test("no file in the repository holds an Ed25519 private key", () => {
    const files = trackedFiles();
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((file) => {
      let text: string;
      try {
        text = readFileSync(join(ROOT, file), "latin1");
      } catch {
        return false; // deleted in the working tree
      }
      return text.includes(PEM_PREFIX) || text.toLowerCase().includes(HEX_PREFIX);
    });
    expect(offenders).toEqual([]);
  });
});
