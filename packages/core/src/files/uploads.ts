import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { HermeticError } from "../errors.ts";
import { FILES_LIMITS, sanitizeFileName } from "../shared/files.ts";
import { streamChunks } from "./stream-source.ts";

/**
 * The upload registry: bytes a webview drop sent over the bridge in chunks,
 * bytes the page streams to the loopback upload port, and paths the native
 * file dialog picked, each under an opaque `up_…` id the page can stage by.
 *
 * In memory only. A chunked upload's bytes are never written to the laptop's
 * disk — they live here until `files.stage` sends them or the entry is
 * discarded or idles out — and a registered path is never shown to the page,
 * which only ever holds the id. A streamed upload holds no more than the
 * pipe's own buffer: the page's request body is read only as fast as the box
 * takes it, so a file of any size passes through.
 */

const MiB = 1024 * 1024;

export const UPLOAD_LIMITS = {
  /** One chunked upload (`FILES_LIMITS.chunkUploadBytes`). */
  uploadBytes: FILES_LIMITS.chunkUploadBytes,
  /** One `append` (`FILES_LIMITS.chunkBytes`). */
  chunkBytes: FILES_LIMITS.chunkBytes,
  /** Every chunked upload held at once, across every window. */
  totalBytes: 256 * MiB,
  /** An upload untouched this long is dropped. */
  idleMs: 60 * 60 * 1000,
} as const;

/** What `files.stage` reads a registered upload as. */
export type UploadSource =
  | { kind: "bytes"; name: string; size: number; bytes: Uint8Array }
  | { kind: "path"; name: string; size: number; path: string }
  /** One pass only: the bytes are read as the page sends them and cannot be taken again. */
  | { kind: "stream"; name: string; size: number; body: AsyncIterable<Uint8Array> };

interface ChunkEntry {
  kind: "bytes";
  name: string;
  size: number;
  received: number;
  parts: Uint8Array[];
  closed: boolean;
  touched: number;
  /** Set by `registerBytes`: bytes this process already held, never a drop. */
  held?: "bytes" | "secret_text";
}

interface PathEntry {
  kind: "path";
  name: string;
  size: number;
  path: string;
  touched: number;
}

interface StreamEntry {
  kind: "stream";
  name: string;
  size: number;
  touched: number;
  /** The pipe: `feed` writes the page's request body in, `take`'s reader pulls it out. */
  pipe: TransformStream<Uint8Array, Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  fed: boolean;
  taken: boolean;
  /** A request body is being written: not swept as idle, however long the upload takes. */
  active: boolean;
}

type Entry = ChunkEntry | PathEntry | StreamEntry;

/**
 * Where an upload came from: a webview drop sent in chunks, a path the native
 * dialog picked, or bytes this process already held (`registerBytes`) — and,
 * of those, the CLI's `--secret-stdin` text, which answers a text secret
 * request and nothing else.
 */
export type UploadOrigin = "chunks" | "path" | "held" | "secret_text" | "stream";

export interface UploadRegistry {
  /** Reserve a chunked upload of `size` bytes. */
  open(input: { name: string; size: number }): { upload_id: string };
  /**
   * Reserve a streamed upload of `size` bytes: nothing is held until `feed`
   * is called with the page's request body, and `files.stage`/`files.put`
   * read it as it arrives. No size cap here — the fleet's cap is checked by
   * the stage and by the box.
   */
  openStream(input: { name: string; size: number }): { upload_id: string };
  /**
   * Pipe a request body into a streamed upload, as fast as its reader takes
   * it. Resolves once all `size` bytes are through; rejects (and fails the
   * reader) on a short or long body, a second feed, or a discard.
   */
  feed(upload_id: string, body: ReadableStream<Uint8Array> | null): Promise<void>;
  /** Add the next chunk. `offset` must be exactly the bytes received so far. */
  append(upload_id: string, offset: number, bytes: Uint8Array): { received: number };
  /** Finish a chunked upload; the bytes received must be the size it was opened with. */
  close(upload_id: string): { upload_id: string; name: string; size: number };
  /**
   * Hold bytes already in this process (the CLI's `--secret-stdin`) under an
   * upload id, closed and ready to take, so the value travels to core as an id
   * and never as an input field. The registry keeps its own copy; the caller
   * should zero its buffer. `secretText` marks the CLI's `--secret-stdin`
   * text, which `files.put` takes for a text secret request only.
   */
  registerBytes(
    name: string,
    bytes: Uint8Array,
    opts?: { secretText?: boolean },
  ): { upload_id: string; name: string; size: number };
  /** Register a laptop path (the native dialog's pick) without reading it. */
  registerPath(path: string): Promise<{ upload_id: string; name: string; size: number }>;
  /** Forget an upload, zeroing any bytes it held; `false` when there was nothing to forget. */
  discard(upload_id: string): { discarded: boolean };
  /** Where an upload came from, or `null` for an unknown id. Does not touch it. */
  origin(upload_id: string): UploadOrigin | null;
  /** The source a stage reads. Refuses an unknown id and an unclosed upload. */
  take(upload_id: string): UploadSource;
  /** The bytes every chunked upload holds right now. */
  heldBytes(): number;
}

export interface UploadRegistryDeps {
  /** Milliseconds since the epoch. */
  now?: () => number;
  limits?: Partial<typeof UPLOAD_LIMITS>;
}

function cleanName(raw: string): string {
  const clean = sanitizeFileName(raw);
  if (!clean.ok) {
    throw new HermeticError("FILE_NAME_INVALID", `that file name is not allowed (${clean.reason})`, {
      reason: clean.reason,
    });
  }
  return clean.name;
}

function unknownUpload(): HermeticError {
  return new HermeticError("NOT_FOUND", "no such upload; it may have expired after an hour idle");
}

export function createUploadRegistry(deps: UploadRegistryDeps = {}): UploadRegistry {
  const now = deps.now ?? (() => Date.now());
  const limits = { ...UPLOAD_LIMITS, ...deps.limits };
  const entries = new Map<string, Entry>();

  const held = (): number => {
    let total = 0;
    for (const e of entries.values()) if (e.kind === "bytes") total += e.size;
    return total;
  };

  /**
   * Remove one entry, zeroing its chunks first: a dropped secret must not
   * linger in a buffer the garbage collector has yet to reclaim.
   */
  const forget = (id: string): boolean => {
    const entry = entries.get(id);
    if (entry === undefined) return false;
    if (entry.kind === "bytes") for (const p of entry.parts) p.fill(0);
    // Fails whoever reads the pipe and whoever feeds it; a no-op once it closed cleanly.
    if (entry.kind === "stream") {
      void entry.writer
        .abort(new HermeticError("ABORTED", "the upload was discarded"))
        .catch(() => undefined);
    }
    return entries.delete(id);
  };

  /** Drop everything idle past `idleMs`. Run on every call: there is no timer to leak. */
  const sweep = (): void => {
    const cutoff = now() - limits.idleMs;
    for (const [id, e] of entries) {
      if (e.touched < cutoff && !(e.kind === "stream" && e.active)) forget(id);
    }
  };

  const get = (upload_id: string): Entry => {
    sweep();
    const entry = entries.get(upload_id);
    if (entry === undefined) throw unknownUpload();
    entry.touched = now();
    return entry;
  };

  const getChunked = (upload_id: string): ChunkEntry => {
    const entry = get(upload_id);
    if (entry.kind !== "bytes") {
      throw new HermeticError("VALIDATION", "that upload is not a chunked one and takes no chunks");
    }
    return entry;
  };

  return {
    open({ name, size }) {
      sweep();
      const clean = cleanName(name);
      if (!Number.isInteger(size) || size < 0) {
        throw new HermeticError("VALIDATION", "an upload's size must be a whole number of bytes");
      }
      if (size > limits.uploadBytes) {
        throw new HermeticError(
          "FILE_TOO_LARGE",
          `a dropped file can be at most ${Math.floor(limits.uploadBytes / MiB)} MB; use the attach button for larger files`,
          { size, limit: limits.uploadBytes },
        );
      }
      if (held() + size > limits.totalBytes) {
        throw new HermeticError(
          "CONFLICT",
          "too many dropped files are still uploading; wait for them to finish",
          { limit: limits.totalBytes },
        );
      }
      const upload_id = `up_${randomUUID()}`;
      entries.set(upload_id, {
        kind: "bytes",
        name: clean,
        size,
        received: 0,
        parts: [],
        closed: false,
        touched: now(),
      });
      return { upload_id };
    },

    openStream({ name, size }) {
      sweep();
      const clean = cleanName(name);
      if (!Number.isInteger(size) || size < 0) {
        throw new HermeticError("VALIDATION", "an upload's size must be a whole number of bytes");
      }
      const pipe = new TransformStream<Uint8Array, Uint8Array>();
      const upload_id = `up_${randomUUID()}`;
      entries.set(upload_id, {
        kind: "stream",
        name: clean,
        size,
        touched: now(),
        pipe,
        writer: pipe.writable.getWriter(),
        fed: false,
        taken: false,
        active: false,
      });
      return { upload_id };
    },

    async feed(upload_id, body) {
      const entry = get(upload_id);
      if (entry.kind !== "stream") {
        throw new HermeticError("VALIDATION", "that upload does not take a streamed body");
      }
      if (entry.fed) throw new HermeticError("CONFLICT", "that upload already has its body");
      entry.fed = true;
      entry.active = true;
      const reader = body?.getReader() ?? null;
      let received = 0;
      try {
        for (;;) {
          const next = reader === null ? { done: true as const } : await reader.read();
          if (next.done) break;
          const chunk = next.value;
          received += chunk.byteLength;
          if (received > entry.size) {
            throw new HermeticError(
              "VALIDATION",
              "the body is longer than the size the upload declared",
            );
          }
          // Resolves when the reader has room: this is the backpressure that keeps memory flat.
          await entry.writer.write(chunk);
        }
        if (received !== entry.size) {
          throw new HermeticError(
            "VALIDATION",
            `the body was ${received} bytes, not the ${entry.size} declared`,
            { received, size: entry.size },
          );
        }
        await entry.writer.close();
      } catch (e) {
        const failure =
          e instanceof HermeticError
            ? e
            : new HermeticError("ABORTED", "the upload stopped before it finished");
        await entry.writer.abort(failure).catch(() => undefined);
        await reader?.cancel().catch(() => undefined);
        throw failure;
      } finally {
        entry.active = false;
        entry.touched = now();
      }
    },

    append(upload_id, offset, bytes) {
      const entry = getChunked(upload_id);
      if (entry.closed) throw new HermeticError("CONFLICT", "that upload is already complete");
      if (bytes.byteLength > limits.chunkBytes) {
        throw new HermeticError(
          "VALIDATION",
          `a chunk can be at most ${Math.floor(limits.chunkBytes / 1024)} KiB`,
        );
      }
      if (offset !== entry.received) {
        throw new HermeticError(
          "CONFLICT",
          `chunk out of order: expected offset ${entry.received}, got ${offset}`,
          { expected: entry.received, offset },
        );
      }
      if (entry.received + bytes.byteLength > entry.size) {
        throw new HermeticError(
          "VALIDATION",
          "the chunks run past the size the upload was opened with",
        );
      }
      // Copied: the caller's buffer may be a view onto something it reuses.
      entry.parts.push(bytes.slice());
      entry.received += bytes.byteLength;
      return { received: entry.received };
    },

    close(upload_id) {
      const entry = getChunked(upload_id);
      if (entry.received !== entry.size) {
        throw new HermeticError(
          "VALIDATION",
          `the upload is incomplete: ${entry.received} of ${entry.size} bytes received`,
          { received: entry.received, size: entry.size },
        );
      }
      entry.closed = true;
      return { upload_id, name: entry.name, size: entry.size };
    },

    registerBytes(name, bytes, opts = {}) {
      sweep();
      const clean = cleanName(name);
      if (bytes.byteLength > limits.uploadBytes) {
        throw new HermeticError(
          "FILE_TOO_LARGE",
          `held input can be at most ${Math.floor(limits.uploadBytes / MiB)} MB`,
          { size: bytes.byteLength, limit: limits.uploadBytes },
        );
      }
      if (held() + bytes.byteLength > limits.totalBytes) {
        throw new HermeticError("CONFLICT", "too many uploads are held in memory; try again shortly", {
          limit: limits.totalBytes,
        });
      }
      const upload_id = `up_${randomUUID()}`;
      entries.set(upload_id, {
        kind: "bytes",
        name: clean,
        size: bytes.byteLength,
        received: bytes.byteLength,
        parts: [bytes.slice()],
        closed: true,
        touched: now(),
        held: opts.secretText === true ? "secret_text" : "bytes",
      });
      return { upload_id, name: clean, size: bytes.byteLength };
    },

    async registerPath(path) {
      sweep();
      let size: number;
      try {
        const info = await stat(path);
        if (!info.isFile())
          throw new HermeticError("VALIDATION", "only a regular file can be attached");
        size = info.size;
      } catch (e) {
        if (e instanceof HermeticError) throw e;
        throw new HermeticError("NOT_FOUND", "the picked file cannot be read");
      }
      const name = cleanName(basename(path));
      const upload_id = `up_${randomUUID()}`;
      entries.set(upload_id, { kind: "path", name, size, path, touched: now() });
      return { upload_id, name, size };
    },

    discard(upload_id) {
      sweep();
      return { discarded: forget(upload_id) };
    },

    origin(upload_id) {
      sweep();
      const entry = entries.get(upload_id);
      if (entry === undefined) return null;
      if (entry.kind === "path") return "path";
      if (entry.kind === "stream") return "stream";
      if (entry.held === "secret_text") return "secret_text";
      return entry.held === "bytes" ? "held" : "chunks";
    },

    take(upload_id) {
      const entry = get(upload_id);
      if (entry.kind === "path") {
        return { kind: "path", name: entry.name, size: entry.size, path: entry.path };
      }
      if (entry.kind === "stream") {
        if (entry.taken) {
          throw new HermeticError(
            "CONFLICT",
            "that upload is already being sent; upload the file again",
          );
        }
        entry.taken = true;
        return {
          kind: "stream",
          name: entry.name,
          size: entry.size,
          body: streamChunks(entry.pipe.readable),
        };
      }
      if (!entry.closed) {
        throw new HermeticError("CONFLICT", "the upload is still receiving chunks; close it first");
      }
      const bytes = new Uint8Array(entry.size);
      let at = 0;
      for (const p of entry.parts) {
        bytes.set(p, at);
        at += p.byteLength;
      }
      return { kind: "bytes", name: entry.name, size: entry.size, bytes };
    },

    heldBytes: () => {
      sweep();
      return held();
    },
  };
}
