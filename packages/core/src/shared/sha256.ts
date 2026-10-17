/**
 * SHA-256 (FIPS 180-4) in plain TypeScript: the hex digest of a string's UTF-8
 * bytes, or of raw bytes.
 *
 * It exists so the chat adapter can run where `node:crypto` does not — the
 * phone's JavaScript engine and anything else behind `@hermetic/core/chat-client`.
 * The adapter hashes a transcript row into its message id (`rowId` in
 * `chat/hermes/hermes-chat-history.ts`), and those ids are what a client keys
 * read state and de-duplication on, so this must agree with `node:crypto` byte
 * for byte. `packages/core/test/sha256.test.ts` pins that.
 *
 * No imports and no runtime globals — not even `TextEncoder`, which an older
 * Hermes engine lacks — so the UTF-8 encoder is written out here too. It
 * encodes a lone surrogate as U+FFFD, which is what `node:crypto` (and
 * `TextEncoder`) do with a JavaScript string that is not well-formed UTF-16.
 *
 * Synchronous and unhurried: the adapter hashes a few hundred bytes per row.
 * `createSha256` takes its input in pieces, for an upload too large to copy.
 */

import { HermeticError } from "../errors.ts";

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

const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** A JavaScript string as UTF-8 bytes, lone surrogates as U+FFFD. */
export function utf8Bytes(text: string): Uint8Array {
  // Worst case three bytes per UTF-16 unit (a surrogate pair is two units, four bytes).
  const out = new Uint8Array(text.length * 3);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    }
    if (c < 0x80) {
      out[n++] = c;
    } else if (c < 0x800) {
      out[n++] = 0xc0 | (c >> 6);
      out[n++] = 0x80 | (c & 0x3f);
    } else if (c < 0x10000) {
      out[n++] = 0xe0 | (c >> 12);
      out[n++] = 0x80 | ((c >> 6) & 0x3f);
      out[n++] = 0x80 | (c & 0x3f);
    } else {
      out[n++] = 0xf0 | (c >> 18);
      out[n++] = 0x80 | ((c >> 12) & 0x3f);
      out[n++] = 0x80 | ((c >> 6) & 0x3f);
      out[n++] = 0x80 | (c & 0x3f);
    }
  }
  return out.subarray(0, n);
}

/**
 * One 64-byte block of `data` at `offset` folded into the state `h`. `w` is the
 * message schedule, reused across blocks so a long input allocates nothing.
 */
function compress(h: number[], w: Uint32Array, data: Uint8Array, offset: number): void {
  for (let t = 0; t < 16; t++) {
    const j = offset + t * 4;
    w[t] = ((data[j]! << 24) | (data[j + 1]! << 16) | (data[j + 2]! << 8) | data[j + 3]!) >>> 0;
  }
  for (let t = 16; t < 64; t++) {
    const a = w[t - 15]!;
    const b = w[t - 2]!;
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
  }

  let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
  for (let t = 0; t < 64; t++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + S1 + ch + K[t]! + w[t]!) >>> 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  h[0] = (h[0]! + a) >>> 0;
  h[1] = (h[1]! + b) >>> 0;
  h[2] = (h[2]! + c) >>> 0;
  h[3] = (h[3]! + d) >>> 0;
  h[4] = (h[4]! + e) >>> 0;
  h[5] = (h[5]! + f) >>> 0;
  h[6] = (h[6]! + g) >>> 0;
  h[7] = (h[7]! + hh) >>> 0;
}

/** The final block(s): a 0x80 byte, zero padding, then the length in bits, big-endian. */
function lengthTail(tail: Uint8Array, length: number): Uint8Array {
  const blocks = Math.ceil((tail.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(tail);
  padded[tail.length] = 0x80;
  const bitsHigh = Math.floor(length / 0x20000000);
  const bitsLow = (length * 8) >>> 0;
  const end = padded.length;
  padded[end - 8] = bitsHigh >>> 24;
  padded[end - 7] = bitsHigh >>> 16;
  padded[end - 6] = bitsHigh >>> 8;
  padded[end - 5] = bitsHigh;
  padded[end - 4] = bitsLow >>> 24;
  padded[end - 3] = bitsLow >>> 16;
  padded[end - 2] = bitsLow >>> 8;
  padded[end - 1] = bitsLow;
  return padded;
}

function hexOf(h: readonly number[]): string {
  let hex = "";
  for (const word of h) hex += word.toString(16).padStart(8, "0");
  return hex;
}

/** The lowercase hex SHA-256 digest of `input` (a string is hashed as UTF-8). */
export function sha256Hex(input: string | Uint8Array): string {
  return createSha256().update(input).digestHex();
}

/** A SHA-256 fed in pieces: the same digest as `sha256Hex` of the pieces joined. */
export interface Sha256 {
  /** Hash `chunk` next (a string as UTF-8). Answers the hasher, for chaining. */
  update(chunk: string | Uint8Array): Sha256;
  /** The lowercase hex digest of everything fed so far. The hasher is spent after. */
  digestHex(): string;
}

/**
 * A streaming SHA-256. Whole blocks are hashed in place from each chunk, and
 * only a partial block (under 64 bytes) is carried over, so hashing a large
 * upload makes no second copy of it.
 */
export function createSha256(): Sha256 {
  const h = H0.slice();
  const w = new Uint32Array(64);
  const carry = new Uint8Array(64);
  let carried = 0;
  let length = 0;
  let done = false;
  const hasher: Sha256 = {
    update(chunk) {
      if (done) throw new HermeticError("INTERNAL", "sha256: update after digest");
      const bytes = typeof chunk === "string" ? utf8Bytes(chunk) : chunk;
      length += bytes.length;
      let at = 0;
      if (carried > 0) {
        const take = Math.min(64 - carried, bytes.length);
        carry.set(bytes.subarray(0, take), carried);
        carried += take;
        at = take;
        if (carried < 64) return hasher;
        compress(h, w, carry, 0);
        carried = 0;
      }
      for (; at + 64 <= bytes.length; at += 64) compress(h, w, bytes, at);
      if (at < bytes.length) {
        carry.set(bytes.subarray(at), 0);
        carried = bytes.length - at;
      }
      return hasher;
    },
    digestHex() {
      if (done) throw new HermeticError("INTERNAL", "sha256: digest taken twice");
      done = true;
      const tail = lengthTail(carry.subarray(0, carried), length);
      for (let offset = 0; offset < tail.length; offset += 64) compress(h, w, tail, offset);
      return hexOf(h);
    },
  };
  return hasher;
}
