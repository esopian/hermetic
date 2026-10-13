/**
 * A minimal QR Code encoder: byte mode, error correction level L, versions 1
 * to 10 (up to 271 bytes) — enough for a `hermetic://pair?…` URL, and nothing
 * more. It exists so `hermetic mobile pair` can draw its QR in a terminal and
 * the desktop Settings page can draw the same one as SVG without a dependency.
 *
 * Follows ISO/IEC 18004 in the shape of Project Nayuki's reference encoder:
 * function patterns, Reed–Solomon over GF(2^8) with 0x11D, interleaved blocks,
 * the zig-zag placement, and the mask with the lowest (rules 1, 2 and 4)
 * penalty.
 *
 * Pure values only — no Zod, no `node:*` — because `shared/` is bundled into
 * the browser (`packages/core/test/shared-browser-safe.test.ts`).
 */

/** Error-correction codewords per block and the block count, for level L, versions 1–10. */
const ECC_PER_BLOCK_L = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const BLOCKS_L = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
const MAX_VERSION = 10;

export interface QrMatrix {
  size: number;
  /** `modules[y][x]`, `true` for dark. No quiet zone. */
  modules: boolean[][];
}

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - (ECC_PER_BLOCK_L[ver] ?? 0) * (BLOCKS_L[ver] ?? 0);
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result: number[] = new Array<number>(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j] as number, root);
      if (j + 1 < result.length) result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = (result[i] as number) ^ gfMultiply(coef, factor);
    });
  }
  return result;
}

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function encodeData(bytes: readonly number[], ver: number): number[] {
  const capacityBits = dataCodewords(ver) * 8;
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0x4, 4);
  append(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) append(b, 8);
  append(0, Math.min(4, capacityBits - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] as number);
    out.push(byte);
  }
  return out;
}

function interleave(data: readonly number[], ver: number): number[] {
  const numBlocks = BLOCKS_L[ver] as number;
  const eccLen = ECC_PER_BLOCK_L[ver] as number;
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  const width = (blocks[0] as number[]).length;
  for (let i = 0; i < width; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i] as number);
    });
  }
  return result;
}

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;

class Builder {
  readonly modules: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  set(x: number, y: number, dark: boolean): void {
    (this.modules[y] as boolean[])[x] = dark;
    (this.fn[y] as boolean[])[x] = true;
  }
  finder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= this.size || y < 0 || y >= this.size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  alignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  format(mask: number): void {
    // Level L is format bits 01.
    const data = (1 << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(bits, i));
    this.set(8, this.size - 8, true);
  }
  versionInfo(ver: number): void {
    if (ver < 7) return;
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, bit(bits, i));
      this.set(b, a, bit(bits, i));
    }
  }
}

function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** Rules 1 (runs), 2 (2×2 blocks) and 4 (balance); rule 3 only refines the choice. */
function penalty(m: boolean[][], size: number): number {
  let score = 0;
  const at = (x: number, y: number) => (m[y] as boolean[])[x] as boolean;
  for (let y = 0; y < size; y++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let i = 1; i < size; i++) {
        const same = horizontal ? at(i, y) === at(i - 1, y) : at(y, i) === at(y, i - 1);
        if (same) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else run = 1;
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (at(x, y)) dark++;
      if (x < size - 1 && y < size - 1) {
        const c = at(x, y);
        if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3;
      }
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encode `text` (UTF-8). Throws if it does not fit in version 10-L. */
export function encodeQr(text: string): QrMatrix {
  const bytes = utf8(text);
  let ver = 1;
  for (; ver <= MAX_VERSION; ver++) {
    const needed = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
    if (needed <= dataCodewords(ver) * 8) break;
  }
  if (ver > MAX_VERSION) throw new RangeError("text too long for this QR encoder");
  const size = ver * 4 + 17;
  const codewords = interleave(encodeData(bytes, ver), ver);

  const b = new Builder(size);
  for (let i = 0; i < size; i++) {
    b.set(6, i, i % 2 === 0);
    b.set(i, 6, i % 2 === 0);
  }
  b.finder(3, 3);
  b.finder(size - 4, 3);
  b.finder(3, size - 4);
  const align = alignmentPositions(ver, size);
  const n = align.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      b.alignment(align[i] as number, align[j] as number);
    }
  }
  b.format(0);
  b.versionInfo(ver);

  // Zig-zag placement, two columns at a time from the right, skipping the timing column.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!(b.fn[y] as boolean[])[x] && i < codewords.length * 8) {
          (b.modules[y] as boolean[])[x] = bit(codewords[i >>> 3] as number, 7 - (i & 7));
          i++;
        }
      }
    }
  }

  let best: boolean[][] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const base = b.modules.map((row) => [...row]);
  for (let mask = 0; mask < 8; mask++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = (base[y] as boolean[])[x] as boolean;
        (b.modules[y] as boolean[])[x] = !(b.fn[y] as boolean[])[x] && maskHit(mask, x, y) ? !v : v;
      }
    }
    b.format(mask);
    const score = penalty(b.modules, size);
    if (score < bestScore) {
      bestScore = score;
      best = b.modules.map((row) => [...row]);
    }
  }
  return { size, modules: best as boolean[][] };
}

/**
 * The matrix as terminal text, two module rows per line with half blocks, on a
 * light quiet zone of `margin` modules. Light modules are drawn, so it reads on
 * a dark terminal.
 */
export function qrToTerminal(qr: QrMatrix, margin = 2): string {
  const span = qr.size + margin * 2;
  const light = (x: number, y: number): boolean => {
    const mx = x - margin;
    const my = y - margin;
    if (mx < 0 || my < 0 || mx >= qr.size || my >= qr.size) return true;
    return !((qr.modules[my] as boolean[])[mx] as boolean);
  };
  const lines: string[] = [];
  for (let y = 0; y < span; y += 2) {
    let line = "";
    for (let x = 0; x < span; x++) {
      const top = light(x, y);
      const bottom = y + 1 < span ? light(x, y + 1) : false;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

/** The matrix as a standalone SVG, dark modules on white, with a 4-module quiet zone. */
export function qrToSvg(qr: QrMatrix, margin = 4): string {
  const span = qr.size + margin * 2;
  let path = "";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if ((qr.modules[y] as boolean[])[x]) path += `M${x + margin},${y + margin}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges">` +
    `<rect width="${span}" height="${span}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  );
}
