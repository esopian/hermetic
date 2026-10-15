/** A shared image is drawn only when its digest can be checked by the main process. */
import { expect, test } from "bun:test";
import { previewDigest } from "../src/chat/use-share-preview.ts";

test("previewDigest: full verifies, none or a prefix is unverified, anything else is malformed", () => {
  const full = "A".repeat(64);
  expect(previewDigest(full)).toEqual({ kind: "full", hex: "a".repeat(64) });
  expect(previewDigest(null).kind).toBe("unverified");
  expect(previewDigest("").kind).toBe("unverified");
  expect(previewDigest("abcdef012345").kind).toBe("unverified");
  expect(previewDigest("zz-not-hex").kind).toBe("malformed");
  expect(previewDigest("a".repeat(65)).kind).toBe("malformed");
});
