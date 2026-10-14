/**
 * `files.stage` and the desktop head's upload machinery (§9).
 *
 * ## The one public method
 *
 * `files.stage` streams like `chat.send`: the request answers with a
 * `stream_id`, frames follow on `files.frame`, and `files.stage.abort` stops
 * it. A failure after the stream opened is a `done` frame carrying
 * `{ type: "error", code, message }` (`FilesStageFrame`), because by then the
 * request has already been answered; anything refused before that — the
 * schema, the fleet guard, a path — is a refused request like any other.
 *
 * ## No paths from the page
 *
 * The page never names a file on this laptop. A drop or a paste arrives as
 * chunks (`files.chunk.*`), held in core's in-memory registry and never written
 * to disk; the native dialog (`files.pickNative`, owned by the desktop shell)
 * registers its pick in the same registry. Either way the page stages by
 * `chunk_upload_id`, and a request carrying `source.path` is refused
 * `UNSUPPORTED` before anything reads it.
 *
 * ## Nothing here logs a file name
 *
 * A file's name can be as sensitive as its contents. The bridge logs a failed
 * request's code and core's message only (`rpc/bind.ts`), and core's files
 * messages never repeat a name or a path.
 */
import {
  FilesCapabilityInput,
  FilesChunkAppendInput,
  FilesChunkOpenInput,
  FilesChunkRefInput,
  FilesEntryRefInput,
  FilesStageApiInput,
  FILES_LIMITS,
  HermeticError,
  isImageMime,
} from "@hermetic/core";
import type {
  FilesStageApiInput as FilesStageApiInputType,
  FilesStageFrame,
  Hermetic,
} from "@hermetic/core";
import { declareMachineryRpc, declareRpc } from "../declare.ts";
import { requireTarget, withTarget } from "../target.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";
import { StreamRefRequest, requireSink } from "./streams.ts";
import type { StreamSink } from "./streams.ts";

export const filesStageSchema = declareRpc("files.stage", FilesStageApiInput);
export const filesStageBody = withTarget(filesStageSchema);

/** Closes a `files.stage` stream: the chip's cancel while it uploads. */
export const FILES_STAGE_ABORT = declareMachineryRpc("files.stage.abort");
export const FILES_CHUNK_OPEN = declareMachineryRpc("files.chunk.open");
export const FILES_CHUNK_APPEND = declareMachineryRpc("files.chunk.append");
export const FILES_CHUNK_CLOSE = declareMachineryRpc("files.chunk.close");
export const FILES_CHUNK_DISCARD = declareMachineryRpc("files.chunk.discard");
export const FILES_CAPABILITY_RPC = declareMachineryRpc("files.capability");
export const FILES_DISCARD = declareMachineryRpc("files.discard");
export const FILES_CONTENT = declareMachineryRpc("files.content");
/**
 * The native open dialog (⊕, ⌘⇧A). The dialog itself is the desktop shell's
 * (`ctx.native.pickFiles`, built in `main/index.ts`); each picked path is
 * registered with core's upload registry here, and the page gets back only
 * the `{ upload_id, name, size }` it stages by — never the path.
 */
export const FILES_PICK_NATIVE = declareMachineryRpc("files.pickNative");

/** Deleting a staged entry writes to the box, so it carries the fleet guard. */
export const filesDiscardBody = withTarget(FilesEntryRefInput);

/** Whether a request names a laptop path, read before anything else is. */
function namesPath(params: unknown): boolean {
  if (typeof params !== "object" || params === null) return false;
  const source = (params as { source?: unknown }).source;
  return typeof source === "object" && source !== null && "path" in source;
}

function frameFor(e: unknown): Extract<FilesStageFrame, { type: "error" }> {
  if (e instanceof HermeticError) return { type: "error", code: e.code, message: e.message };
  return { type: "error", code: "INTERNAL", message: "the file transfer failed" };
}

function startStage(
  ctx: HandlerContext,
  h: Hermetic,
  input: FilesStageApiInputType,
  sink: StreamSink,
): { stream_id: string } {
  const controller = new AbortController();
  // Called here, not inside the pump: core checks its input before it returns
  // the stream, and that refusal belongs to the request.
  const events = h.files.stage(input, { signal: controller.signal });
  const done = (async () => {
    try {
      for await (const e of events) {
        if (e.type === "staged") await sink({ event: "done", data: e satisfies FilesStageFrame });
        else await sink({ event: "progress", data: e satisfies FilesStageFrame });
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      // The request was answered long ago; the failure travels as the last frame.
      const frame = frameFor(e);
      // The code only: a message from outside core could carry a path.
      ctx.log?.line("warn", "files.stage", "stage failed", { code: frame.code });
      try {
        await sink({ event: "done", data: frame });
      } catch {
        // The window is gone, so is anyone to tell; `done` still settles
        // (`streams.ts`: it never rejects) and the stream is closed below.
      }
    }
  })();
  const stream_id = ctx.streams.open({ close: () => controller.abort(), done });
  void done.then(() => {
    ctx.streams.close(stream_id);
  });
  return { stream_id };
}

export async function stage(
  ctx: HandlerContext,
  params: unknown,
  sink: StreamSink,
): Promise<{ stream_id: string }> {
  if (namesPath(params)) {
    throw new HermeticError(
      "UNSUPPORTED",
      "the app never sends a file path; attach through the file dialog, a drop or a paste",
    );
  }
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(filesStageBody, params));
  return startStage(ctx, h, input, sink);
}

export async function stageAbort(ctx: HandlerContext, params: unknown): Promise<{ closed: boolean }> {
  const { stream_id } = parseInput(StreamRefRequest, params);
  return { closed: ctx.streams.close(stream_id) };
}

export async function chunkOpen(ctx: HandlerContext, params: unknown) {
  const input = parseInput(FilesChunkOpenInput, params);
  return ctx.hermetic().files.internal.uploads.open(input);
}

function decodeBase64(data: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(data);
  } catch {
    throw new HermeticError("VALIDATION", "a chunk's data is not base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

export async function chunkAppend(ctx: HandlerContext, params: unknown) {
  const input = parseInput(FilesChunkAppendInput, params);
  return ctx
    .hermetic()
    .files.internal.uploads.append(input.upload_id, input.offset, decodeBase64(input.data_b64));
}

export async function chunkClose(ctx: HandlerContext, params: unknown) {
  const { upload_id } = parseInput(FilesChunkRefInput, params);
  return ctx.hermetic().files.internal.uploads.close(upload_id);
}

export async function chunkDiscard(ctx: HandlerContext, params: unknown) {
  const { upload_id } = parseInput(FilesChunkRefInput, params);
  return ctx.hermetic().files.internal.uploads.discard(upload_id);
}

export async function capability(ctx: HandlerContext, params: unknown) {
  const { instance } = parseInput(FilesCapabilityInput, params);
  return await ctx.hermetic().files.internal.capability(instance, { signal: ctx.signal });
}

export async function discard(ctx: HandlerContext, params: unknown) {
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(filesDiscardBody, params));
  return await h.files.internal.discard(input.instance, input.id, { signal: ctx.signal });
}

/**
 * A staged image's bytes, for its thumbnail. Images only, and no larger than
 * Hermes takes one: anything else is refused from the box's response headers
 * (`Content-Type`, `Content-Length`), before its body is read.
 */
export async function content(
  ctx: HandlerContext,
  params: unknown,
): Promise<{ mime: string; data_b64: string }> {
  const { instance, id } = parseInput(FilesEntryRefInput, params);
  const file = await ctx.hermetic().files.internal.content(instance, id, FILES_LIMITS.imageBytes, {
    signal: ctx.signal,
    imagesOnly: true,
  });
  // Core already refused it from the headers; checked again on what was read.
  if (!isImageMime(file.mime)) {
    throw new HermeticError("FILE_TYPE_REJECTED", `${instance}: only images have a preview`, {
      name: instance,
    });
  }
  return { mime: file.mime, data_b64: encodeBase64(file.bytes) };
}

export async function pickNative(
  ctx: HandlerContext,
  params: unknown,
): Promise<{ files: { upload_id: string; name: string; size: number }[] }> {
  // Validated for shape only: the instance names whose composer asked, so a
  // later version can start the dialog somewhere useful for it.
  parseInput(FilesCapabilityInput, params);
  if (ctx.native === undefined) {
    throw new HermeticError("UNSUPPORTED", "files.pickNative is answered by the desktop head");
  }
  const paths = (await ctx.native.pickFiles()).filter((p) => p.length > 0);
  const uploads = ctx.hermetic().files.internal.uploads;
  const files: { upload_id: string; name: string; size: number }[] = [];
  try {
    for (const path of paths) files.push(await uploads.registerPath(path));
  } catch (e) {
    // One unreadable pick fails the dialog; nothing it registered is kept.
    for (const f of files) uploads.discard(f.upload_id);
    throw e;
  }
  return { files };
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const filesHandlers = {
  "files.stage": (ctx: HandlerContext, params: unknown, sink?: StreamSink) =>
    stage(ctx, params, requireSink(sink)),
  [FILES_STAGE_ABORT]: stageAbort,
  [FILES_CHUNK_OPEN]: chunkOpen,
  [FILES_CHUNK_APPEND]: chunkAppend,
  [FILES_CHUNK_CLOSE]: chunkClose,
  [FILES_CHUNK_DISCARD]: chunkDiscard,
  [FILES_CAPABILITY_RPC]: capability,
  [FILES_DISCARD]: discard,
  [FILES_CONTENT]: content,
  [FILES_PICK_NATIVE]: pickNative,
} satisfies Record<string, Handler>;
