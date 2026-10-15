/**
 * The front half of every upload: the headers checked before a byte is read,
 * the disk floor, and the body read through a meter that hashes, counts and
 * cuts it off at its declared length.
 *
 * `Content-Digest` is optional so that the plan's no-token fallback, a bare
 * `curl -T`, works; when it is sent it is verified, and the box always
 * computes the SHA-256 itself and returns it. `Content-Length` is required:
 * the cap and the disk floor are both checked against it before anything is
 * written, which a chunked body of unknown length would make impossible.
 */
import { createHash, type Hash } from "node:crypto";
import {
  CONTENT_DIGEST_HEADER,
  FILES_INBOX_DIR,
  FILES_LIMITS,
  FILES_NOT_SECRET_HEADER,
  FILES_TTL,
  parseContentDigest,
  sanitizeFileName,
} from "@hermetic/core/shared";
import type { Host } from "../host.ts";
import { FilesError } from "./errors.ts";

/** What the headers promise about the body. */
export interface UploadHeaders {
  /** `Content-Length`, already checked against the cap. */
  readonly declared: number;
  /** The SHA-256 `Content-Digest` names, lowercase hex, or `null` when none was sent. */
  readonly digest: string | null;
  /** The operator said this is not a secret (`x-hermetic-not-secret: 1`). */
  readonly notSecret: boolean;
}

function capText(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1 ? `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB` : `${bytes} bytes`;
}

/**
 * Read and check the upload headers. 411 without a `Content-Length`, 413 over
 * `cap`, 400 for a `Content-Digest` that is present but not a SHA-256.
 */
export function uploadHeaders(request: Request, cap: number): UploadHeaders {
  const length = request.headers.get("content-length");
  if (length === null || !/^\d{1,15}$/.test(length.trim())) {
    throw new FilesError("VALIDATION", "Content-Length is required on an upload", 411);
  }
  const declared = Number(length.trim());
  if (declared > cap) {
    throw new FilesError("FILE_TOO_LARGE", `the file is over this box's cap of ${capText(cap)}`);
  }
  const header = request.headers.get(CONTENT_DIGEST_HEADER);
  const digest = parseContentDigest(header);
  if (header !== null && digest === null) {
    throw new FilesError("VALIDATION", "Content-Digest must carry a sha-256 (RFC 9530)");
  }
  return { declared, digest, notSecret: request.headers.get(FILES_NOT_SECRET_HEADER)?.trim() === "1" };
}

/**
 * A name from the path or a header, through the one sanitizer. 400 when it
 * fails — and 400, too, when it was a path: the sanitizer would keep only the
 * last segment of `../x`, but a client that sent a path where a name belongs
 * is told so rather than silently renamed.
 */
export function cleanName(raw: string): string {
  const clean = sanitizeFileName(raw);
  if (!clean.ok)
    throw new FilesError("FILE_NAME_INVALID", `the file name is not allowed (${clean.reason})`);
  if (clean.name !== raw.normalize("NFC")) {
    throw new FilesError("FILE_NAME_INVALID", "the file name is a path; send the name alone");
  }
  return clean.name;
}

/**
 * Refuse a write that would leave the data volume under the floor: less than
 * `diskFloorBytes` free, or less than `diskFloorPct` of it. A volume that
 * cannot be measured is let through — "unknown" is not "full".
 */
export async function checkDiskFloor(host: Host, bytes: number): Promise<void> {
  const fs = await host.filesystem(FILES_INBOX_DIR).catch(() => null);
  if (fs === null || !(fs.size > 0)) return;
  const after = fs.available - bytes;
  if (after < FILES_LIMITS.diskFloorBytes || (after / fs.size) * 100 < FILES_LIMITS.diskFloorPct) {
    throw new FilesError(
      "DISK_FULL",
      `the data volume is too full to take this file (${Math.round(fs.usePct)}% used)`,
    );
  }
}

export interface MeteredBodyOptions {
  /** Silence, in ms, after which the upload is cut off. `FILES_TTL.uploadIdle` by default. */
  readonly idleMs?: number;
  /** Aborts the upload from outside. */
  readonly signal?: AbortSignal;
}

/**
 * The request body, read once, through a meter.
 *
 * `head` pulls the first `sniffBytes` (or the whole body, if shorter) without
 * consuming them, so the sniffer and the key-material check can decide where
 * the bytes go *before* any of them is written. `chunks` then yields the whole
 * body from the first byte, hashing and counting as it goes, and throws
 * `FILE_TOO_LARGE` the moment more arrives than was declared.
 *
 * Every read is bounded. Both listeners run with `idleTimeout: 0` (a log
 * follow and a long-poll are silent by design), so nothing below this class
 * would ever give up on a client that stopped sending but kept the connection:
 * `idleMs` without a byte cancels the body and throws a 408, and so does
 * `signal` (a slot reclaimed from an upload that ran past
 * `FILES_TTL.receivingMax`). Either way the caller's cleanup runs as for any
 * other failed upload — part file unlinked, slot reopened.
 */
export class MeteredBody {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array> | null;
  private readonly pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private ended = false;
  private readonly hash: Hash = createHash("sha256");
  private count = 0;

  private readonly idleMs: number;
  private readonly signal: AbortSignal | undefined;

  constructor(
    body: ReadableStream<Uint8Array> | null,
    private readonly limit: number,
    options: MeteredBodyOptions = {},
  ) {
    this.reader = body?.getReader() ?? null;
    this.idleMs = options.idleMs ?? FILES_TTL.uploadIdle * 1000;
    this.signal = options.signal;
  }

  /** Bytes yielded by `chunks` so far. */
  get bytes(): number {
    return this.count;
  }

  private async pull(): Promise<Uint8Array | null> {
    if (this.ended || this.reader === null) {
      this.ended = true;
      return null;
    }
    const next = await this.boundedRead(this.reader);
    if (next.done) {
      this.ended = true;
      return null;
    }
    return next.value;
  }

  /** One `read`, raced against the idle timer and the abort signal. */
  private async boundedRead(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
    const signal = this.signal;
    if (signal?.aborted) throw await this.cutOff("the upload was stopped: it ran too long");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stop = new Promise<"idle" | "aborted">((resolve) => {
      timer = setTimeout(() => resolve("idle"), this.idleMs);
      onAbort = () => resolve("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([reader.read(), stop]);
      if (outcome === "idle") {
        throw await this.cutOff(`no bytes arrived for ${Math.round(this.idleMs / 1000)} s`);
      }
      if (outcome === "aborted") throw await this.cutOff("the upload was stopped: it ran too long");
      return outcome;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Cancel the body and say why: 408, the upload is over. */
  private async cutOff(why: string): Promise<FilesError> {
    this.ended = true;
    await this.discard();
    return new FilesError("VALIDATION", `the upload stalled (${why}); send it again`, 408);
  }

  /** The first `n` bytes (fewer if the body is shorter), left in place for `chunks`. */
  async head(n: number = FILES_LIMITS.sniffBytes): Promise<Uint8Array> {
    while (this.pendingBytes < n && this.pendingBytes <= this.limit) {
      const chunk = await this.pull();
      if (chunk === null) break;
      this.pending.push(chunk);
      this.pendingBytes += chunk.byteLength;
    }
    const all = concat(this.pending);
    return all.subarray(0, Math.min(n, all.byteLength));
  }

  async *chunks(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const chunk = this.pending.shift() ?? (await this.pull());
      if (chunk === null) return;
      this.count += chunk.byteLength;
      if (this.count > this.limit) {
        throw new FilesError("FILE_TOO_LARGE", "the body is longer than its Content-Length or the cap");
      }
      this.hash.update(chunk);
      yield chunk;
    }
  }

  /** The whole body in memory — only for the secret lane, whose cap is 1 MiB. */
  async collect(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const chunk of this.chunks()) parts.push(chunk);
    return concat(parts);
  }

  /** Stop reading: the rest of the body is not wanted. */
  async discard(): Promise<void> {
    await this.reader?.cancel().catch(() => undefined);
  }

  /**
   * After `chunks` has run dry: the SHA-256 of everything read. 400 when the
   * body was shorter than declared; 422 when it does not match the digest the
   * client sent.
   */
  finish(declared: number, expected: string | null): string {
    if (this.count !== declared) {
      throw new FilesError(
        "VALIDATION",
        `the body was ${this.count} bytes, not the ${declared} declared`,
      );
    }
    const sha256 = this.hash.digest("hex");
    if (expected !== null && expected !== sha256) {
      throw new FilesError(
        "FILE_DIGEST_MISMATCH",
        "the bytes received do not match their Content-Digest",
      );
    }
    return sha256;
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
