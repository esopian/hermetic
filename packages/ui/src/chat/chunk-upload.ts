/**
 * Bytes the page holds, into the main process.
 *
 * A drop or a paste hands the page a `File` and no path. It is sent with
 * `putStream`: one `fetch` of the `File` to the loopback upload port
 * (`app/src/upload-port.ts`), which the browser reads from disk as the request
 * goes, so the page copies nothing and no size is too big. `files.stage` or
 * `files.put` runs on the upload id at the same time and sends the bytes on to
 * the box as they arrive.
 *
 * A text secret is bytes the operator typed, small and never a `File`: it goes
 * in base64 chunks of `FILES_LIMITS.chunkBytes` (`sendChunks`) and is named
 * afterwards by the upload id this answers. The composer's tray
 * (`chat-attachments.ts`) and the request cards (`FileRequest.tsx`) share both.
 */
import { FILES_LIMITS } from "@hermetic/core/shared";
import type * as filesApi from "../api/files.ts";

/** Base64 of one chunk, in slices small enough for `String.fromCharCode`'s arguments. */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

/** The offsets a file of `size` bytes is sent at. An empty file is one empty chunk. */
export function chunkOffsets(size: number, chunk = FILES_LIMITS.chunkBytes): number[] {
  if (size <= 0) return [0];
  const out: number[] = [];
  for (let at = 0; at < size; at += chunk) out.push(at);
  return out;
}

export type ChunkCalls = Pick<typeof filesApi, "chunkOpen" | "chunkAppend" | "chunkClose">;

export interface SendChunksOptions {
  /** The registry's id, as soon as it exists: what a caller discards on cancel. */
  onOpen?: (upload_id: string) => void;
  /** After each chunk: bytes sent so far, of `size`. */
  onChunk?: (sent: number, size: number) => void;
  /** Checked between awaits; true stops the send and answers null. */
  cancelled?: () => boolean;
}

/**
 * Sends `source` and closes the upload. Answers the upload id, or null when
 * `cancelled` turned true on the way (the id was already handed to `onOpen`).
 * A refusal from the main process is thrown as it came.
 *
 * A `Uint8Array` source is read in place and never copied into a `Blob`, so a
 * caller holding secret bytes can zero its own buffer afterwards.
 */
export async function sendChunks(
  calls: ChunkCalls,
  source: Blob | Uint8Array,
  name: string,
  opts: SendChunksOptions = {},
): Promise<string | null> {
  const size = source instanceof Uint8Array ? source.byteLength : source.size;
  const stop = opts.cancelled ?? (() => false);
  const { upload_id } = await calls.chunkOpen(name, size);
  opts.onOpen?.(upload_id);
  if (stop()) return null;
  for (const offset of chunkOffsets(size)) {
    const end = Math.min(size, offset + FILES_LIMITS.chunkBytes);
    const bytes =
      source instanceof Uint8Array
        ? source.subarray(offset, end)
        : new Uint8Array(await source.slice(offset, end).arrayBuffer());
    if (stop()) {
      if (!(source instanceof Uint8Array)) bytes.fill(0);
      return null;
    }
    const data = toBase64(bytes);
    // A copy read from a Blob is this function's own: zeroed once encoded, as
    // the caller zeroes a Uint8Array source (a view of its buffer, left alone here).
    if (!(source instanceof Uint8Array)) bytes.fill(0);
    await calls.chunkAppend(upload_id, offset, data);
    if (stop()) return null;
    opts.onChunk?.(end, size);
  }
  await calls.chunkClose(upload_id);
  return stop() ? null : upload_id;
}

/**
 * PUTs `file` to the loopback URL `files.upload.open` answered. Resolves when
 * the main process has taken every byte; rejects with the refusal's `code`
 * when it did not. An `abort` resolves quietly: whoever aborted knows.
 *
 * The `File` is the request body itself, never read into the page: WebKit and
 * Chromium both stream it from disk. The request is read only as fast as the
 * box takes the bytes, so this is also how long the whole transfer takes.
 */
export async function putStream(url: string, file: Blob, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: "PUT", body: file, signal });
  } catch (e) {
    if (signal.aborted) return;
    throw Object.assign(new Error("the upload could not reach the app"), {
      code: "UPLOAD_FAILED",
      cause: e,
    });
  }
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
  throw Object.assign(
    new Error(typeof body?.message === "string" ? body.message : `the upload failed (${res.status})`),
    { code: typeof body?.code === "string" ? body.code : "UPLOAD_FAILED" },
  );
}
