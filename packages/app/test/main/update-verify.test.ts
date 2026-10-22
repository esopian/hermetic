/**
 * The gate before an update is installed (`main/update-verify.ts`), over a
 * real folder laid out the way Electrobun's `downloadUpdate` leaves it: a
 * prepared record and a decompressed tar under `self-extraction/`. The
 * signature is fetched from a fake release; keys are generated per run.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appUpdateSignatureFile, signAppUpdate } from "@hermetic/core";
import { type VerifyDeps, verifyPreparedUpdate } from "../../src/main/update-verify.ts";

const ASSETS = "https://releases.example/download";

function setup(overrides: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");

  const root = mkdtempSync(join(tmpdir(), "hermetic-update-"));
  const folder = join(root, "self-extraction");
  mkdirSync(folder);
  const hash = "newbuild01";
  const tarPath = resolve(folder, `${hash}.tar`);
  const tar = Buffer.from("the new Hermetic.app, as a tar");
  writeFileSync(tarPath, tar);
  const record = {
    schema_version: 1,
    identifier: "sh.hermetic.app",
    channel: "stable",
    version: "0.4.0",
    hash,
    platform: "macos",
    arch: "arm64",
    retained_tar_path: tarPath,
    artifact_file: "stable-macos-arm64-Hermetic.app.tar.zst",
    ...overrides,
  };
  const recordPath = join(folder, ".electrobun-prepared-update.json");
  writeFileSync(recordPath, JSON.stringify(record));

  const target = {
    identifier: "sh.hermetic.app",
    channel: "stable",
    platform: "macos",
    arch: "arm64",
    version: "0.4.0",
    hash,
  };
  const digest = new Bun.CryptoHasher("sha256").update(tar).digest("hex");
  const assets = new Map<string, Response | (() => Response)>([
    [
      `${ASSETS}/${appUpdateSignatureFile(target)}`,
      new Response(`${signAppUpdate(privatePem, target, digest)}\n`),
    ],
  ]);
  const fetched: string[] = [];
  const deps: VerifyDeps = {
    appDataFolder: async () => root,
    local: { identifier: "sh.hermetic.app", channel: "stable", version: "0.3.1" },
    assetsUrl: ASSETS,
    fetch: async (url) => {
      fetched.push(url);
      const hit = assets.get(url);
      if (hit === undefined) return new Response("Not Found", { status: 404 });
      return typeof hit === "function" ? hit() : hit;
    },
    publicKey: publicB64,
  };
  return { deps, tarPath, recordPath, assets, fetched, target, privatePem, digest };
}

function discarded(s: { tarPath: string; recordPath: string }): boolean {
  return !existsSync(s.tarPath) && !existsSync(s.recordPath);
}

describe("verifyPreparedUpdate", () => {
  test("a tar the release key signed verifies, and is left in place to install", async () => {
    const s = setup();
    expect(await verifyPreparedUpdate(s.deps)).toEqual({ ok: true, version: "0.4.0" });
    expect(s.fetched).toEqual([`${ASSETS}/stable-macos-arm64-newbuild01.sig`]);
    expect(existsSync(s.tarPath) && existsSync(s.recordPath)).toBe(true);
  });

  test("a tar changed after signing is refused and discarded", async () => {
    const s = setup();
    writeFileSync(s.tarPath, "something else entirely");
    const result = await verifyPreparedUpdate(s.deps);
    expect(result).toEqual({ ok: false, reason: "signature does not verify for 0.4.0" });
    expect(discarded(s)).toBe(true);
  });

  test("a release with no signature asset is refused", async () => {
    const s = setup();
    s.assets.clear();
    expect(await verifyPreparedUpdate(s.deps)).toEqual({
      ok: false,
      reason: "signature request failed with HTTP 404",
    });
    expect(discarded(s)).toBe(true);
  });

  test("a signature from another key is refused", async () => {
    const s = setup();
    const { privateKey } = generateKeyPairSync("ed25519");
    const forged = signAppUpdate(
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      s.target,
      s.digest,
    );
    s.assets.set(`${ASSETS}/${appUpdateSignatureFile(s.target)}`, new Response(forged));
    expect((await verifyPreparedUpdate(s.deps)).ok).toBe(false);
  });

  test("an oversized signature asset is refused unread", async () => {
    const s = setup();
    s.assets.set(`${ASSETS}/${appUpdateSignatureFile(s.target)}`, new Response("A".repeat(5000)));
    expect(await verifyPreparedUpdate(s.deps)).toEqual({
      ok: false,
      reason: "signature asset is too large",
    });
  });

  test("a record pointing at any other tar is refused before anything is fetched", async () => {
    const elsewhere = join(mkdtempSync(join(tmpdir(), "hermetic-elsewhere-")), "other.tar");
    writeFileSync(elsewhere, "not ours");
    const s = setup({ retained_tar_path: elsewhere });
    const result = await verifyPreparedUpdate(s.deps);
    expect(result.ok).toBe(false);
    expect(s.fetched).toEqual([]);
    expect(existsSync(s.recordPath)).toBe(false);
    // A file at a path the record merely names is not this module's to delete.
    expect(existsSync(elsewhere)).toBe(true);
  });

  test("an update for another app, another channel, or not newer is refused", async () => {
    for (const overrides of [
      { identifier: "com.example.other" },
      { channel: "canary" },
      { version: "0.3.1" },
      { version: "0.2.0" },
    ]) {
      const s = setup(overrides);
      const result = await verifyPreparedUpdate(s.deps);
      expect({ overrides, ok: result.ok }).toEqual({ overrides, ok: false });
      expect(s.fetched).toEqual([]);
    }
  });

  test("no prepared record is refused", async () => {
    const s = setup();
    const empty = mkdtempSync(join(tmpdir(), "hermetic-update-empty-"));
    const result = await verifyPreparedUpdate({ ...s.deps, appDataFolder: async () => empty });
    expect(result.ok).toBe(false);
  });

  test("a network failure fetching the signature is refused, not thrown", async () => {
    const s = setup();
    const result = await verifyPreparedUpdate({
      ...s.deps,
      fetch: async () => {
        throw new Error("offline");
      },
    });
    expect(result).toEqual({ ok: false, reason: "signature unavailable: offline" });
  });
});
