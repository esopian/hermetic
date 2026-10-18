/**
 * The pairing link's QR encoder (`shared/qr.ts`). The pinned matrices were
 * decoded back to their exact input by macOS CoreImage's QR detector when the
 * encoder was written (versions 1, 5, 7 and 10 were checked that way) and when
 * it grew to version 40 (11, 18, 25, 31, 32, 36 and 40 were); the hashes
 * catch any change to what it draws. The structural checks below hold
 * for any input.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { encodeQr, qrToSvg, qrToTerminal, type QrMatrix } from "../src/shared/qr.ts";

const PAIR_URL =
  "hermetic://pair?host=100.101.102.103&port=7877&code=ABCD2345&fleet=fxtr0001&name=main";

function hash(qr: QrMatrix): string {
  const text = qr.modules.map((r) => r.map((b) => (b ? "1" : "0")).join("")).join("\n");
  return createHash("sha256").update(text).digest("hex");
}

const at = (qr: QrMatrix, x: number, y: number) => (qr.modules[y] as boolean[])[x] as boolean;

/** The 15 format bits read from the copy around the top-left finder. */
function formatBits(qr: QrMatrix): number {
  const bits: boolean[] = [];
  for (let i = 0; i <= 5; i++) bits.push(at(qr, 8, i));
  bits.push(at(qr, 8, 7), at(qr, 8, 8), at(qr, 7, 8));
  for (let i = 9; i < 15; i++) bits.push(at(qr, 14 - i, 8));
  return bits.reduce((acc, b, i) => acc | ((b ? 1 : 0) << i), 0);
}

function bchValid(bits: number): boolean {
  let rem = bits ^ 0x5412;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  return rem === 0;
}

describe("encodeQr", () => {
  test("the matrices verified against a real decoder are unchanged", () => {
    expect(encodeQr(PAIR_URL).size).toBe(37);
    expect(hash(encodeQr(PAIR_URL))).toBe(
      "7620e931c8d5e64d2f40628acb5198f14d3e3bd9f3446650a9b11013b0e12c50",
    );
    expect(hash(encodeQr("Z".repeat(250)))).toBe(
      "223c87c4b65e5454d8de1004e59a4d58353355884026050411e30fc148d2fa64",
    );
    // Version 32, whose alignment step is the irregular one, and version 40.
    expect(encodeQr("Z".repeat(1850)).size).toBe(145);
    expect(hash(encodeQr("Z".repeat(1850)))).toBe(
      "78bee91992c5910776c2123aedd0ee0f5a26f80117138bda5cddbdc0143f41f3",
    );
    expect(hash(encodeQr("Z".repeat(2953)))).toBe(
      "4b2e8b3ebda6a2fc253b1f9c53fd465ff8ec5736ce638cf85d51e909beca875e",
    );
  });

  test("the smallest version that fits is chosen, up to 40", () => {
    expect(encodeQr("hi").size).toBe(21);
    expect(encodeQr("x".repeat(17)).size).toBe(21);
    expect(encodeQr("x".repeat(18)).size).toBe(25);
    expect(encodeQr("x".repeat(271)).size).toBe(57);
    expect(encodeQr("x".repeat(272)).size).toBe(61);
    expect(encodeQr("x".repeat(2953)).size).toBe(177);
    expect(() => encodeQr("x".repeat(2954))).toThrow(RangeError);
  });

  test("finders, timing and a valid level-L format word", () => {
    for (const text of ["hi", PAIR_URL, "y".repeat(200)]) {
      const qr = encodeQr(text);
      const n = qr.size;
      for (const [cx, cy] of [
        [3, 3],
        [n - 4, 3],
        [3, n - 4],
      ] as const) {
        expect(at(qr, cx, cy)).toBe(true);
        expect(at(qr, cx - 2, cy)).toBe(false);
        expect(at(qr, cx - 3, cy)).toBe(true);
      }
      for (let i = 8; i < n - 8; i++) {
        expect(at(qr, i, 6)).toBe(i % 2 === 0);
        expect(at(qr, 6, i)).toBe(i % 2 === 0);
      }
      expect(at(qr, 8, n - 8)).toBe(true);
      const format = formatBits(qr);
      expect(bchValid(format)).toBe(true);
      // Level L is `01` in the top two data bits, after the 0x5412 mask comes off.
      expect(((format ^ 0x5412) >>> 13) & 0b11).toBe(0b01);
    }
  });

  test("renders for a terminal and as SVG", () => {
    const qr = encodeQr(PAIR_URL);
    const lines = qrToTerminal(qr).trimEnd().split("\n");
    expect(lines).toHaveLength(Math.ceil((qr.size + 4) / 2));
    for (const line of lines) expect([...line]).toHaveLength(qr.size + 4);
    const svg = qrToSvg(qr);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${qr.size + 8} ${qr.size + 8}"`);
  });
});
