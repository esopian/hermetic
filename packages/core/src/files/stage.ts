import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { CoreContext } from "../context.ts";
import { HermeticError } from "../errors.ts";
import { evt } from "../events.ts";
import {
  FilesStageInput,
  type FilesStageEvent,
  type FilesStageProgressEvent,
  type FilesStageResult,
} from "../schema/index.ts";
import {
  FILES_LIMITS,
  isImageMime,
  looksLikeKeyMaterial,
  sanitizeFileName,
  sniffMime,
} from "../shared/files.ts";
import { validateName } from "../shared/naming.ts";
import { peekHead } from "./stream-source.ts";
import type { UploadRegistry } from "./uploads.ts";

/**
 * `files.stage` (§9): one file from this laptop to an agent's stage
 * area, ready for a chat turn to commit.
 *
 * A stream, like `chat.send`, and for the same reason not in
 * `STREAMING_METHODS`: an upload is a live pipe, not an op the Runs view could
 * restart, and ten chips in a composer must not become ten rows there.
 *
 * Every limit is checked before the first byte leaves: the name, the image or
 * file cap (from the sniffed type, never the extension), and the key-material
 * refusal. A path is read twice — once to hash, once to send — because the
 * digest goes in a header ahead of the body; a registered text secret is
 * already in memory and is hashed in one step.
 *
 * Nothing here names the file in a message or a progress event. The name is in
 * the terminal `staged` event, which is data for the head, not a log line.
 */

export interface StageDeps {
  ctx: CoreContext;
  uploads: UploadRegistry;
}

/** What a stage reads, once resolved: its bytes or its path, and the name it goes up under. */
type Resolved =
  | { kind: "bytes"; name: string; size: number; bytes: Uint8Array; upload_id: string }
  | { kind: "path"; name: string; size: number; path: string; upload_id: string | null }
  | { kind: "stream"; name: string; size: number; body: AsyncIterable<Uint8Array>; upload_id: string };

const READ_CHUNK = 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function parseInput(input: unknown): FilesStageInput {
  const result = FilesStageInput.safeParse(input);
  if (result.success) return result.data;
  throw new HermeticError("VALIDATION", "files stage input does not validate", {
    issues: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  });
}

export function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new HermeticError("ABORTED", "the file transfer was stopped");
}

export function nameFor(raw: string): string {
  const clean = sanitizeFileName(raw);
  if (!clean.ok) {
    throw new HermeticError("FILE_NAME_INVALID", `that file name is not allowed (${clean.reason})`, {
      reason: clean.reason,
    });
  }
  return clean.name;
}

/**
 * A filesystem failure as a refusal that does not repeat the path: node's
 * messages (`EACCES: permission denied, open '<path>'`) carry the file's name.
 * Only the errno's code survives, in `details`.
 */
export function readError(e: unknown): HermeticError {
  if (e instanceof HermeticError) return e;
  const errno = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  const code = typeof errno === "string" ? errno : null;
  if (code === "EACCES" || code === "EPERM") {
    return new HermeticError("FORBIDDEN", "the file cannot be read: permission denied", {
      errno: code,
    });
  }
  return new HermeticError("NOT_FOUND", "the file cannot be read", code ? { errno: code } : undefined);
}

export async function statFile(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new HermeticError("VALIDATION", "only a regular file can be attached");
    return info.size;
  } catch (e) {
    throw readError(e);
  }
}

export async function readHead(path: string): Promise<Uint8Array> {
  try {
    const handle = await open(path, "r");
    try {
      const buf = new Uint8Array(FILES_LIMITS.sniffBytes);
      const { bytesRead } = await handle.read(buf, 0, buf.byteLength, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (e) {
    throw readError(e);
  }
}

/**
 * A file's bytes, `size` of them exactly, stopping when `signal` does. A file
 * that grew or shrank since it was measured is refused: a short body would
 * leave the upload waiting for bytes its `Content-Length` promised.
 */
export async function* fileChunks(
  path: string,
  size: number,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const stream = createReadStream(path, { highWaterMark: READ_CHUNK });
  let seen = 0;
  try {
    const chunks = (async function* () {
      try {
        yield* stream as AsyncIterable<Uint8Array>;
      } catch (e) {
        throw readError(e);
      }
    })();
    for await (const chunk of chunks) {
      aborted(signal);
      seen += chunk.byteLength;
      if (seen > size) throw new HermeticError("CONFLICT", FILE_CHANGED);
      yield chunk;
    }
    aborted(signal);
    if (seen < size) throw new HermeticError("CONFLICT", FILE_CHANGED);
  } finally {
    stream.destroy();
  }
}

const FILE_CHANGED = "the file changed since it was attached; attach it again";

/**
 * Run `work`, yielding the progress events it emits as they happen and then its
 * result. Leaving the loop early aborts the work through `controller`.
 */
export async function* pump<T>(
  controller: AbortController,
  work: (emit: (e: FilesStageProgressEvent) => void) => Promise<T>,
): AsyncGenerator<FilesStageProgressEvent, T> {
  const queue: FilesStageProgressEvent[] = [];
  let wake: (() => void) | null = null;
  let settled = false;
  let result: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
  const poke = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  void work((e) => {
    queue.push(e);
    poke();
  })
    .then(
      (value) => {
        result = { ok: true, value };
      },
      (error: unknown) => {
        result = { ok: false, error };
      },
    )
    .finally(() => {
      settled = true;
      poke();
    });
  try {
    for (;;) {
      while (queue.length > 0) yield queue.shift() as FilesStageProgressEvent;
      if (settled) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    if (!settled) controller.abort();
  }
  const done = result as { ok: true; value: T } | { ok: false; error: unknown } | null;
  if (done === null || !done.ok)
    throw done?.error ?? new HermeticError("INTERNAL", "the stage ended without a result");
  return done.value;
}

/** Calls `emit` once per whole percent, and at the end. */
export function throttled(
  emit: (e: FilesStageProgressEvent) => void,
  phase: string,
  from: number,
  to: number,
  total: number,
  verb: string,
  nowIso: () => string,
): (done: number) => void {
  let last = -1;
  return (done) => {
    const frac = total === 0 ? 1 : Math.min(1, done / total);
    const pct = Math.floor(frac * 100);
    if (pct === last) return;
    last = pct;
    emit({
      type: "progress",
      ...evt(
        phase,
        from + (to - from) * frac,
        `${verb} ${formatBytes(done)} of ${formatBytes(total)}`,
        nowIso(),
      ),
    });
  };
}

export function createFilesStage(deps: StageDeps) {
  const { ctx, uploads } = deps;

  async function resolve(input: FilesStageInput): Promise<Resolved> {
    if ("path" in input.source) {
      const path = input.source.path;
      const size = await statFile(path);
      return { kind: "path", name: nameFor(input.name ?? basename(path)), size, path, upload_id: null };
    }
    const upload_id = input.source.chunk_upload_id;
    if (uploads.origin(upload_id) === "secret_text") {
      throw new HermeticError("VALIDATION", "a text secret can only answer a text secret request");
    }
    const source = uploads.take(upload_id);
    const name = input.name ?? source.name;
    if (source.kind === "path") {
      return { kind: "path", name: nameFor(name), size: source.size, path: source.path, upload_id };
    }
    if (source.kind === "stream") {
      return { kind: "stream", name: nameFor(name), size: source.size, body: source.body, upload_id };
    }
    return { kind: "bytes", name: nameFor(name), size: source.size, bytes: source.bytes, upload_id };
  }

  /**
   * The head the checks sniff. A streamed body is read only this far first
   * (the page's request stays blocked behind the checks, so a refusal costs no
   * upload), and the source answered carries a body that replays what was read.
   */
  async function withHead(src: Resolved): Promise<{ src: Resolved; head: Uint8Array }> {
    if (src.kind === "stream") {
      const peeked = await peekHead(src.body, FILES_LIMITS.sniffBytes);
      return { src: { ...src, body: peeked.body }, head: peeked.head };
    }
    if (src.kind === "bytes") return { src, head: src.bytes.subarray(0, FILES_LIMITS.sniffBytes) };
    return { src, head: await readHead(src.path) };
  }

  /** The two checks the box would make, made first so a refusal costs no upload. */
  function preflight(instance: string, src: Resolved, head: Uint8Array, notSecret: boolean): string {
    const mime = sniffMime(head, src.name);
    const image = isImageMime(mime);
    const cap = image ? FILES_LIMITS.imageBytes : FILES_LIMITS.fileBytes;
    if (src.size > cap) {
      throw new HermeticError(
        "FILE_TOO_LARGE",
        `${instance}: the file is ${formatBytes(src.size)}; ${image ? "images" : "files"} can be at most ${formatBytes(cap)}`,
        { name: instance, size: src.size, limit: cap },
      );
    }
    if (!notSecret && looksLikeKeyMaterial(head, src.name)) {
      throw new HermeticError(
        "FILE_LOOKS_SECRET",
        `${instance}: the file looks like a private key; send it as a secret, or confirm it is not one`,
        { name: instance },
      );
    }
    return mime;
  }

  /**
   * `files.stage`. Input is checked before the stream is returned, so a head
   * gets a `VALIDATION` or `NAME_INVALID` refusal rather than a stream that
   * fails on its first read.
   */
  function stage(input: unknown, opts: { signal?: AbortSignal } = {}): AsyncIterable<FilesStageEvent> {
    const parsed = parseInput(input);
    validateName(parsed.instance);
    const instance = parsed.instance;
    return (async function* (): AsyncGenerator<FilesStageEvent> {
      const controller = new AbortController();
      const onOuterAbort = (): void => controller.abort();
      opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
      if (opts.signal?.aborted) controller.abort();
      const signal = controller.signal;
      // A streamed upload is read once and cannot be taken again, so it ends
      // with the stage, however the stage ends.
      let streamed: string | null = null;
      try {
        aborted(signal);
        // The account and fleet this SDK was opened for, before a byte is read
        // or sent (§4.6), like every other method that reaches a box.
        await ctx.guardFleet();
        await ctx.getAgent(instance);
        const resolved = await resolve(parsed);
        if (resolved.kind === "stream") streamed = resolved.upload_id;
        const { src, head } = await withHead(resolved);
        preflight(instance, src, head, parsed.not_secret === true);
        aborted(signal);

        // The digest goes in a header ahead of the body, so a streamed body
        // has none: the box hashes what it receives and reports it.
        let sha256: string | undefined;
        if (src.kind === "stream") {
          sha256 = undefined;
        } else if (src.kind === "bytes") {
          sha256 = createHash("sha256").update(src.bytes).digest("hex");
        } else {
          const path = src.path;
          sha256 = yield* pump(controller, async (emit) => {
            const progress = throttled(emit, "hash", 0, 0.2, src.size, "checked", ctx.nowIso);
            const hash = createHash("sha256");
            let seen = 0;
            // `fileChunks` refuses a file that is no longer `src.size` long.
            for await (const chunk of fileChunks(path, src.size, signal)) {
              hash.update(chunk);
              seen += chunk.byteLength;
              progress(seen);
            }
            return hash.digest("hex");
          });
        }

        const from = src.kind === "path" ? 0.2 : 0;
        const result: FilesStageResult = yield* pump(controller, async (emit) => {
          const progress = throttled(emit, "upload", from, 1, src.size, "sent", ctx.nowIso);
          progress(0);
          return await ctx.backend.files.stage(
            instance,
            {
              fileName: src.name,
              size: src.size,
              body:
                src.kind === "stream"
                  ? src.body
                  : src.kind === "bytes"
                    ? src.bytes
                    : fileChunks(src.path, src.size, signal),
              ...(sha256 !== undefined ? { sha256 } : {}),
              ...(parsed.session ? { sessionId: parsed.session } : {}),
              ...(parsed.not_secret ? { notSecret: true } : {}),
            },
            { signal, onProgress: progress },
          );
        });
        // A consumed upload is done with: its bytes leave memory now.
        if (src.upload_id !== null) uploads.discard(src.upload_id);
        yield { type: "staged", file: result };
      } catch (e) {
        if (signal.aborted && !(e instanceof HermeticError && e.code === "ABORTED")) {
          throw new HermeticError("ABORTED", "the file transfer was stopped");
        }
        throw e;
      } finally {
        opts.signal?.removeEventListener("abort", onOuterAbort);
        if (streamed !== null) uploads.discard(streamed);
      }
    })();
  }

  return { stage };
}
