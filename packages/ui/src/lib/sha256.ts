/**
 * SHA-256 as lowercase hex, for the page.
 *
 * WebCrypto's `crypto.subtle` is only exposed to a secure context, and whether
 * the app's `views://` page counts as one is the engine's call, not ours. So
 * `sha256Hex` feature-detects `crypto.subtle.digest` and, where it is missing,
 * falls back to the small FIPS 180-4 implementation below. Both paths give the
 * same digest; nothing here asks which engine is drawing the page.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function toHex(digest: Uint8Array): string {
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** SHA-256 of `bytes` in plain TypeScript: the fallback where WebCrypto is absent. */
export function sha256HexSync(bytes: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const length = bytes.length;
  // The message, a 0x80 byte, zero padding, and the 64-bit bit length, in whole 64-byte blocks.
  const blocks = Math.ceil((length + 9) / 64);
  const tail = new Uint8Array(blocks * 64 - Math.floor(length / 64) * 64);
  const tailStart = Math.floor(length / 64) * 64;
  tail.set(bytes.subarray(tailStart));
  tail[length - tailStart] = 0x80;
  const tailView = new DataView(tail.buffer);
  const bits = length * 8;
  tailView.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
  tailView.setUint32(tail.length - 4, bits >>> 0);
  const whole = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let block = 0; block < blocks; block++) {
    const offset = block * 64;
    const inTail = offset >= tailStart;
    const view = inTail ? tailView : whole;
    const base = inTail ? offset - tailStart : offset;
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(base + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] as number) + a;
    h[1] = (h[1] as number) + b;
    h[2] = (h[2] as number) + c;
    h[3] = (h[3] as number) + d;
    h[4] = (h[4] as number) + e;
    h[5] = (h[5] as number) + f;
    h[6] = (h[6] as number) + g;
    h[7] = (h[7] as number) + hh;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i] as number);
  return toHex(out);
}

type Digest = (algorithm: string, data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;

/** WebCrypto's digest when this page has one, else `null`. */
function webDigest(): Digest | null {
  const subtle = (globalThis as { crypto?: { subtle?: { digest?: unknown } } }).crypto?.subtle;
  const digest = subtle?.digest;
  return typeof digest === "function" ? (digest.bind(subtle) as Digest) : null;
}

/**
 * Lowercase hex SHA-256 of `bytes`: WebCrypto where the page has it, the
 * pure-TS fallback otherwise. `digest` is injectable for tests (`null` forces
 * the fallback).
 */
export async function sha256Hex(
  bytes: Uint8Array<ArrayBuffer>,
  digest: Digest | null = webDigest(),
): Promise<string> {
  if (digest === null) return sha256HexSync(bytes);
  return toHex(new Uint8Array(await digest("SHA-256", bytes)));
}
