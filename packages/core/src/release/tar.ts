/**
 * A minimal ustar writer, so `config/<name>/<hash>.tgz` is a real gzipped tar
 * that `tar -xzf` on the box unpacks (§6.2 step 5). hermetic renders final files
 * on the laptop; this is the envelope they travel in.
 *
 * Deterministic by construction — fixed mtime, fixed uid/gid, no PAX extensions —
 * so the same manifest always produces the same bytes and `config_hash` stays a
 * property of the configuration rather than of the moment it was packed.
 *
 * Written by hand rather than pulled in as a dependency: it is 60 lines, the
 * format has been frozen since 1988, and hermetic's own code ships with no
 * runtime dependency it does not need.
 */

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

export interface TarEntry {
  /** Relative path inside the archive, e.g. `manifest.json`, `etc/hermes/hermes.toml`. */
  path: string;
  /** Octal, four digits, as the manifest spells it (`0644`). */
  mode: string;
  content: string | Uint8Array;
}

function octal(value: number, width: number): string {
  // ustar numeric fields are octal, NUL- or space-terminated, zero-padded.
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function writeAscii(block: Uint8Array, offset: number, value: string, width: number): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > width) {
    throw new RangeError(`tar field does not fit in ${width} bytes: ${value}`);
  }
  block.set(bytes, offset);
}

/** ustar splits a long path across `prefix` (155) and `name` (100) at a `/`. */
function splitPath(path: string): { name: string; prefix: string } {
  if (path.length <= NAME_MAX) return { name: path, prefix: "" };
  for (let i = path.length - NAME_MAX - 1; i < path.length; i += 1) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (prefix.length <= PREFIX_MAX && name.length <= NAME_MAX) return { name, prefix };
  }
  throw new RangeError(`path is too long for a ustar header: ${path}`);
}

function header(entry: TarEntry, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const { name, prefix } = splitPath(entry.path);

  writeAscii(block, 0, name, NAME_MAX);
  writeAscii(block, 100, octal(parseInt(entry.mode, 8) & 0o7777, 8), 8); // mode
  writeAscii(block, 108, octal(0, 8), 8); // uid — root, always
  writeAscii(block, 116, octal(0, 8), 8); // gid
  writeAscii(block, 124, octal(size, 12), 12);
  writeAscii(block, 136, octal(0, 12), 12); // mtime — fixed, for determinism
  writeAscii(block, 148, "        ", 8); // checksum placeholder: eight spaces
  writeAscii(block, 156, "0", 1); // typeflag: regular file
  writeAscii(block, 257, "ustar\0", 6);
  writeAscii(block, 263, "00", 2);
  writeAscii(block, 265, "root", 32); // uname
  writeAscii(block, 297, "root", 32); // gname
  if (prefix) writeAscii(block, 345, prefix, PREFIX_MAX);

  let sum = 0;
  for (const byte of block) sum += byte;
  // The checksum field is six octal digits, a NUL, then a space.
  writeAscii(block, 148, sum.toString(8).padStart(6, "0") + "\0 ", 8);
  return block;
}

/** Pack entries into an uncompressed tar stream, ending with two zero blocks. */
export function tar(entries: readonly TarEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  let total = 0;

  for (const entry of entries) {
    const body = typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
    const head = header(entry, body.length);
    const padding = (BLOCK - (body.length % BLOCK)) % BLOCK;
    blocks.push(head, body);
    if (padding) blocks.push(new Uint8Array(padding));
    total += head.length + body.length + padding;
  }

  // End of archive: two zero blocks.
  const trailer = new Uint8Array(BLOCK * 2);
  blocks.push(trailer);
  total += trailer.length;

  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

/** `tar` plus gzip — exactly what `tar -xzf` expects. */
export function tarGz(entries: readonly TarEntry[]): Uint8Array {
  return Bun.gzipSync(tar(entries));
}

/** Absolute manifest paths become archive-relative ones: `/etc/x` → `etc/x`. */
export function archivePath(absolute: string): string {
  return absolute.replace(/^\/+/, "");
}

/**
 * One named member of an uncompressed ustar stream, or `null`.
 *
 * A reader for `tar.ts`'s writer, held to the same shape it produces — regular
 * files, fixed headers, no PAX extensions, no sparse members — rather than a
 * general-purpose untar. Written by hand for the reason the writer was: the
 * format has been frozen since 1988, this is the only reader hermetic needs,
 * and taking a dependency to read one member out of an object hermetic itself
 * packed would be the larger cost.
 */
export function ustarEntry(stream: Uint8Array, want: string): Uint8Array | null {
  const BLOCK = 512;
  const text = new TextDecoder();
  const field = (header: Uint8Array, at: number, width: number): string => {
    const bytes = header.subarray(at, at + width);
    const end = bytes.indexOf(0);
    return text.decode(end === -1 ? bytes : bytes.subarray(0, end)).trim();
  };
  for (let offset = 0; offset + BLOCK <= stream.length; ) {
    const header = stream.subarray(offset, offset + BLOCK);
    const name = field(header, 0, 100);
    // The archive ends in zero blocks, and nothing in one of these has an empty
    // name, so the first nameless header is the end either way.
    if (name === "") return null;
    const size = Number.parseInt(field(header, 124, 12) || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) return null;
    const body = offset + BLOCK;
    if (body + size > stream.length) return null;
    const prefix = field(header, 345, 155);
    if ((prefix === "" ? name : `${prefix}/${name}`) === want) {
      return stream.subarray(body, body + size);
    }
    offset = body + Math.ceil(size / BLOCK) * BLOCK;
  }
  return null;
}
