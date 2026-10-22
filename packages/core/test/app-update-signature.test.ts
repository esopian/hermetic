/**
 * The desktop app's update signature (`release/app-update-signature.ts`): the
 * one format the release workflow signs and the app verifies. Keys here are
 * generated per run; the release key's private half is never in the tree.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_UPDATE_PUBLIC_KEY,
  type AppUpdateTarget,
  appUpdateSignatureFile,
  appUpdateSignedMessage,
  sha256File,
  signAppUpdate,
  verifyAppUpdate,
} from "../src/release/app-update-signature.ts";

function keyPair(): { privatePem: string; publicB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

const TARGET: AppUpdateTarget = {
  identifier: "sh.hermetic.app",
  channel: "stable",
  platform: "macos",
  arch: "arm64",
  version: "0.4.0",
  hash: "hx17l0cwsdkl",
};
const DIGEST = "f2942f931726d676ecfd7fb052ffc321786bba6e649ac12306d5e0d6eee87fb1";

describe("app update signature", () => {
  test("the signed statement is pinned: changing it breaks every installed app's check", () => {
    expect(appUpdateSignedMessage(TARGET, DIGEST)).toBe(
      [
        "hermetic-app-update-v1",
        "identifier=sh.hermetic.app",
        "channel=stable",
        "platform=macos",
        "arch=arm64",
        "version=0.4.0",
        "hash=hx17l0cwsdkl",
        `tar-sha256=${DIGEST}`,
        "",
      ].join("\n"),
    );
    expect(appUpdateSignatureFile(TARGET)).toBe("stable-macos-arm64-hx17l0cwsdkl.sig");
  });

  test("a signature verifies for exactly the update and digest it was made over", () => {
    const k = keyPair();
    const sig = signAppUpdate(k.privatePem, TARGET, DIGEST);
    expect(verifyAppUpdate(sig, TARGET, DIGEST, k.publicB64)).toBe(true);
    expect(verifyAppUpdate(`${sig}\n`, TARGET, DIGEST, k.publicB64)).toBe(true);

    expect(verifyAppUpdate(sig, TARGET, DIGEST.replace(/^f/, "e"), k.publicB64)).toBe(false);
    for (const field of Object.keys(TARGET) as (keyof AppUpdateTarget)[]) {
      // An older signed build replayed as a newer one is this case for `version`.
      const changed = { ...TARGET, [field]: `${TARGET[field]}x` };
      expect({ field, ok: verifyAppUpdate(sig, changed, DIGEST, k.publicB64) }).toEqual({
        field,
        ok: false,
      });
    }
  });

  test("another key's signature, or no signature, does not verify", () => {
    const ours = keyPair();
    const theirs = keyPair();
    const forged = signAppUpdate(theirs.privatePem, TARGET, DIGEST);
    expect(verifyAppUpdate(forged, TARGET, DIGEST, ours.publicB64)).toBe(false);
    for (const garbage of [
      "",
      "not base64!",
      Buffer.alloc(64).toString("base64"),
      "<html>404</html>",
    ]) {
      expect(verifyAppUpdate(garbage, TARGET, DIGEST, ours.publicB64)).toBe(false);
    }
    // And by default, against the release key, which nobody here holds.
    expect(verifyAppUpdate(signAppUpdate(ours.privatePem, TARGET, DIGEST), TARGET, DIGEST)).toBe(false);
  });

  test("a field that could split the statement or the file name is refused", () => {
    for (const bad of ["0.4.0\ntar-sha256=00", "../x", "", "a b"]) {
      expect(() => appUpdateSignedMessage({ ...TARGET, version: bad }, DIGEST)).toThrow();
      expect(() => appUpdateSignatureFile({ ...TARGET, hash: bad })).toThrow();
    }
    expect(() => appUpdateSignedMessage(TARGET, "DEADBEEF")).toThrow();
  });

  test("only an Ed25519 key signs", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => signAppUpdate(pem, TARGET, DIGEST)).toThrow("not Ed25519");
  });

  test("the compiled-in release key is an Ed25519 public key", () => {
    const raw = Buffer.from(APP_UPDATE_PUBLIC_KEY, "base64");
    // SPKI DER for Ed25519: a 12-byte header (OID 1.3.101.112) and 32 key bytes.
    expect(raw.length).toBe(44);
    expect(raw.subarray(0, 12).toString("hex")).toBe("302a300506032b6570032100");
  });

  test("sha256File streams the same digest as hashing the bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermetic-sha-"));
    const path = join(dir, "x.tar");
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 0x5a);
    writeFileSync(path, bytes);
    expect(await sha256File(path)).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
  });
});
