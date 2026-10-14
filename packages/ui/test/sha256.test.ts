/**
 * The page's SHA-256 (`lib/sha256.ts`): the pure-TS fallback against known
 * vectors and node's own digest, and `sha256Hex` choosing WebCrypto or the
 * fallback by what the page has — never by engine.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sha256Hex, sha256HexSync } from "../src/lib/sha256.ts";
import { previewDigest } from "../src/chat/use-share-preview.ts";

const enc = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
const node = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

test("the fallback matches the FIPS 180-4 vectors", () => {
  expect(sha256HexSync(enc(""))).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(sha256HexSync(enc("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(sha256HexSync(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("the fallback matches node at every padding boundary and on 1 MiB", () => {
  for (const n of [1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000]) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
    expect(sha256HexSync(bytes)).toBe(node(bytes));
  }
  const big = new Uint8Array(1024 * 1024).map((_, i) => (i * 2654435761) >>> 24);
  expect(sha256HexSync(big)).toBe(node(big));
  // A view into a larger buffer hashes only its own bytes.
  const view = big.subarray(7, 7 + 300);
  expect(sha256HexSync(view)).toBe(node(view));
});

test("sha256Hex falls back when the page has no crypto.subtle, and agrees with it when it does", async () => {
  const bytes = enc("FIXTURE share bytes");
  const want = node(bytes);
  expect(await sha256Hex(bytes, null)).toBe(want);
  expect(await sha256Hex(bytes)).toBe(want);
});

test("previewDigest: full verifies, none or a prefix is unverified, anything else is malformed", () => {
  const full = "A".repeat(64);
  expect(previewDigest(full)).toEqual({ kind: "full", hex: "a".repeat(64) });
  expect(previewDigest(null).kind).toBe("unverified");
  expect(previewDigest("").kind).toBe("unverified");
  expect(previewDigest("abcdef012345").kind).toBe("unverified");
  expect(previewDigest("zz-not-hex").kind).toBe("malformed");
  expect(previewDigest("a".repeat(65)).kind).toBe("malformed");
});
