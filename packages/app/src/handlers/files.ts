/**
 * `files.stage`, `files.put`, `files.decline`, the Files tab's `files.list`,
 * `files.get` and `files.rm`, and the desktop head's upload and save
 * machinery (§9).
 *
 * ## The public methods
 *
 * `files.stage` streams like `chat.send`: the request answers with a
 * `stream_id`, frames follow on `files.frame`, and `files.stage.abort` stops
 * it. `files.put` (answering an agent's request) is the same shape, its frames
 * on `files.put.frame` and ending `fulfilled` or `error`, stopped by
 * `files.put.abort`. `files.get` (a download) is the same shape again, its
 * frames on `files.get.frame`, ending `saved` or `error`, stopped by
 * `files.get.abort`. `files.decline`, `files.list` and `files.rm` (a plan,
 * executed by `apply`) answer once. A failure after the stream opened is a `done` frame carrying
 * `{ type: "error", code, message }` (`FilesStageFrame`), because by then the
 * request has already been answered; anything refused before that — the
 * schema, the fleet guard, a path — is a refused request like any other.
 *
 * ## No paths from the page
 *
 * The page never names a file on this laptop. A drop or a paste is PUT by the
 * page to the loopback upload port (`files.upload.open`, `upload-port.ts`) and
 * piped through core's upload registry to the box as it arrives, never held
 * whole and never written to disk; a bounded text secret arrives in one RPC
 * (`files.secretText.upload`) and is held in the same registry; the native dialog
 * (`files.pickNative`, owned by the desktop shell) registers its pick there
 * too. Either way the page stages by the upload id (`chunk_upload_id` in the
 * public request schema), and a request
 * carrying `source.path` is refused `UNSUPPORTED` before anything reads it.
 *
 * A download is the mirror image: the native folder dialog
 * (`files.saveNative`) registers the folder with core and answers an opaque
 * `dest_id`; `files.get` names that id, core writes `<folder>/<sanitized name>`
 * with exclusive create, and the answer reports the saved name only. A
 * `files.get` naming `dest.path` is refused `UNSUPPORTED`. On macOS the saved
 * file is then marked quarantined (`ctx.native.quarantine`,
 * `main/quarantine.ts`), as a browser marks a download.
 *
 * ## Which requests carry the fleet guard
 *
 * The ones that write to a box (`files.stage`, `files.put`, `files.decline`,
 * `files.discard`) carry `target` and `requireTarget` (§4.7). `files.list`,
 * `files.get` and `files.rm` are reads of a box, like `agents.get` and the
 * `plan.*` requests: `files.rm` only plans, and the `apply` that executes it
 * is guarded and re-reads the box (`PLAN_STALE`); `files.get` writes only to
 * this laptop, into the folder this window's dialog chose, and the `f_`/`sh_`
 * id it names is random per box, so a stale window gets `FILE_NOT_FOUND`
 * rather than another fleet's file.
 *
 * ## Nothing here logs a file name
 *
 * A file's name can be as sensitive as its contents. The bridge logs a failed
 * request's code and core's message only (`rpc/bind.ts`), and core's files
 * messages never repeat a name or a path.
 */
import { open } from "node:fs/promises";
import {
  FilesCapabilityInput,
  FilesSecretTextUploadInput,
  FilesUploadRefInput,
  FilesUploadOpenInput,
  FilesContentInput,
  FilesDeclineInput,
  FilesEntryRefInput,
  FilesGetApiInput,
  FilesListInput,
  FilesPutApiInput,
  FilesRmInput,
  FilesRequestRefInput,
  FilesStageApiInput,
  FILES_LIMITS,
  HermeticError,
  contentPurposeAllows,
  contentPurposeBytes,
  purposeRefusal,
} from "@hermetic/core";
import type {
  FilesGetApiInput as FilesGetApiInputType,
  FilesGetFrame,
  FilesPutApiInput as FilesPutApiInputType,
  FilesPutFrame,
  FilesStageApiInput as FilesStageApiInputType,
  FilesStageFrame,
  Hermetic,
} from "@hermetic/core";
import { looksLikeKeyMaterial } from "@hermetic/core/shared";
import { declareMachineryRpc, declareRpc } from "../declare.ts";
import { requireTarget, stillBound, withTarget } from "../target.ts";
import { uploadPort } from "../upload-port.ts";
import type { Targeted } from "../target.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";
import { StreamRefRequest, requireSink } from "./streams.ts";
import type { StreamSink } from "./streams.ts";

export const filesStageSchema = declareRpc("files.stage", FilesStageApiInput);
export const filesStageBody = withTarget(filesStageSchema);
export const filesPutSchema = declareRpc("files.put", FilesPutApiInput);
export const filesPutBody = withTarget(filesPutSchema);
export const filesDeclineSchema = declareRpc("files.decline", FilesDeclineInput);
export const filesDeclineBody = withTarget(filesDeclineSchema);
export const filesListSchema = declareRpc("files.list", FilesListInput);
export const filesGetSchema = declareRpc("files.get", FilesGetApiInput);
export const filesRmSchema = declareRpc("files.rm", FilesRmInput);

/** Closes a `files.stage` stream: the chip's cancel while it uploads. */
export const FILES_STAGE_ABORT = declareMachineryRpc("files.stage.abort");
export const FILES_UPLOAD_OPEN = declareMachineryRpc("files.upload.open");
export const FILES_SECRET_TEXT_UPLOAD = declareMachineryRpc("files.secretText.upload");
export const FILES_UPLOAD_DISCARD = declareMachineryRpc("files.upload.discard");
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
/** Closes a `files.put` stream: the request card's cancel while it uploads. */
export const FILES_PUT_ABORT = declareMachineryRpc("files.put.abort");
/**
 * One request slot, read from the box: the card renders destination, accept
 * list, cap and expiry from hermeticd's copy, never from the agent's tool args.
 */
export const FILES_REQUEST_GET = declareMachineryRpc("files.request.get");
/** Closes a `files.get` stream: the Files tab's cancel while it downloads. */
export const FILES_GET_ABORT = declareMachineryRpc("files.get.abort");
/**
 * The native folder dialog for a download (`ctx.native.pickFolder`, built in
 * `main/index.ts`). The chosen folder is registered with core here, and the
 * page gets back only an opaque `dest_id` for `files.get` — never the path.
 */
export const FILES_SAVE_NATIVE = declareMachineryRpc("files.saveNative");

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

/**
 * A put's failure: `frameFor`, plus the occupied slot when core refused to
 * replace a stored secret unasked (`replace_required`), so the card can ask.
 */
function putFrameFor(e: unknown): Extract<FilesPutFrame, { type: "error" }> {
  const frame = frameFor(e);
  const details = e instanceof HermeticError ? e.details : undefined;
  const slot = details?.["ssm_slot"];
  if (details?.["replace_required"] === true && typeof slot === "string" && slot !== "") {
    return { ...frame, replace_slot: slot };
  }
  return frame;
}

/**
 * Pump one files stream to its sink: progress as `progress`, the terminal
 * event (`isLast`) or a failure as `done`. A failure is logged by code only:
 * a message from outside core could carry a path.
 */
function pumpFiles<E extends { type: string }>(
  ctx: HandlerContext,
  method: string,
  controller: AbortController,
  events: AsyncIterable<E>,
  sink: StreamSink,
  isLast: (e: E) => boolean,
  failure: (e: unknown) => { type: "error"; code: string } = frameFor,
): { stream_id: string } {
  const done = (async () => {
    try {
      for await (const e of events) {
        if (isLast(e)) await sink({ event: "done", data: e });
        else await sink({ event: "progress", data: e });
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      // The request was answered long ago; the failure travels as the last frame.
      const frame = failure(e);
      ctx.log?.line("warn", method, "file transfer failed", { code: frame.code });
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
  return pumpFiles(
    ctx,
    "files.stage",
    controller,
    events,
    sink,
    (e) => (e satisfies FilesStageFrame).type === "staged",
  );
}

function startPut(
  ctx: HandlerContext,
  h: Hermetic,
  input: FilesPutApiInputType,
  sink: StreamSink,
): { stream_id: string } {
  const controller = new AbortController();
  const events = h.files.put(input, { signal: controller.signal });
  return pumpFiles(
    ctx,
    "files.put",
    controller,
    events,
    sink,
    (e) => (e satisfies FilesPutFrame).type === "fulfilled",
    putFrameFor,
  );
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

/**
 * `files.put`: answer an agent's request from an upload the registry holds.
 * Like `files.stage`, a request naming a laptop path is refused before
 * anything reads it.
 */
export async function put(
  ctx: HandlerContext,
  params: unknown,
  sink: StreamSink,
): Promise<{ stream_id: string }> {
  if (namesPath(params)) {
    throw new HermeticError(
      "UNSUPPORTED",
      "the app never sends a file path; answer through the file dialog, a drop or a paste",
    );
  }
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(filesPutBody, params));
  return startPut(ctx, h, input, sink);
}

export async function decline(ctx: HandlerContext, params: unknown) {
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(filesDeclineBody, params));
  return await h.files.decline(input, { signal: ctx.signal });
}

/** `files.list`: what is on one box, metadata only. A read. */
export async function list(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().files.list(parseInput(filesListSchema, params), {
    signal: ctx.signal,
  });
}

/** `files.rm`: the plan. A read; the page confirms and sends it to `apply`. */
export async function rm(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().files.rm(parseInput(filesRmSchema, params), { signal: ctx.signal });
}

/** Whether a request names a laptop path as its destination, read before anything else is. */
function namesDestPath(params: unknown): boolean {
  if (typeof params !== "object" || params === null) return false;
  const dest = (params as { dest?: unknown }).dest;
  return typeof dest === "object" && dest !== null && "path" in dest;
}

function startGet(
  ctx: HandlerContext,
  h: Hermetic,
  input: FilesGetApiInputType,
  sink: StreamSink,
): { stream_id: string } {
  const controller = new AbortController();
  const quarantine = ctx.native?.quarantine;
  const events = h.files.get(input, {
    signal: controller.signal,
    ...(quarantine ? { afterWrite: (path: string) => quarantine(path) } : {}),
  });
  return pumpFiles(
    ctx,
    "files.get",
    controller,
    events,
    sink,
    (e) => (e satisfies FilesGetFrame).type === "saved",
  );
}

/**
 * `files.get`: download one inbox file or outbox share into the folder the
 * save dialog chose. The page names the folder by its `dest_id` only.
 */
export async function get(
  ctx: HandlerContext,
  params: unknown,
  sink: StreamSink,
): Promise<{ stream_id: string }> {
  if (namesDestPath(params)) {
    throw new HermeticError(
      "UNSUPPORTED",
      "the app never sends a file path; choose the folder through the save dialog",
    );
  }
  return startGet(ctx, ctx.hermetic(), parseInput(filesGetSchema, params), sink);
}

/**
 * The save dialog. Validated for shape only, like `files.pickNative`: the
 * instance names whose Files tab asked. Answers `{ dest_id: null }` when the
 * operator cancelled.
 */
export async function saveNative(
  ctx: HandlerContext,
  params: unknown,
): Promise<{ dest_id: string | null }> {
  parseInput(FilesCapabilityInput, params);
  if (ctx.native === undefined) {
    throw new HermeticError("UNSUPPORTED", "files.saveNative is answered by the desktop head");
  }
  const folder = await ctx.native.pickFolder();
  if (folder === null || folder === "") return { dest_id: null };
  const { dest_id } = await ctx.hermetic().files.internal.registerDestination(folder);
  return { dest_id };
}

export async function requestGet(ctx: HandlerContext, params: unknown) {
  const { instance, request_id } = parseInput(FilesRequestRefInput, params);
  return await ctx.hermetic().files.internal.request(instance, request_id, { signal: ctx.signal });
}

export async function stageAbort(ctx: HandlerContext, params: unknown): Promise<{ closed: boolean }> {
  const { stream_id } = parseInput(StreamRefRequest, params);
  return { closed: ctx.streams.close(stream_id) };
}

/**
 * A drop or paste: reserve a streamed upload and answer the loopback URL the
 * page PUTs the file to (`upload-port.ts`). The page then runs `files.stage`
 * or `files.put` on the id at the same time, which reads the bytes as they
 * arrive and sends them on.
 */
export async function uploadOpen(ctx: HandlerContext, params: unknown) {
  const input = parseInput(FilesUploadOpenInput, params);
  const uploads = ctx.hermetic().files.internal.uploads;
  const { upload_id } = uploads.openStream(input);
  return { upload_id, url: uploadPort.url(upload_id, (body) => uploads.feed(upload_id, body)) };
}

function decodeBase64(data: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(data);
  } catch {
    throw new HermeticError("VALIDATION", "text secret data is not base64");
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

export async function secretTextUpload(ctx: HandlerContext, params: unknown) {
  const { name, data_b64 } = parseInput(FilesSecretTextUploadInput, params);
  const bytes = decodeBase64(data_b64);
  try {
    if (bytes.byteLength > FILES_LIMITS.secretTextBytes) {
      throw new HermeticError("FILE_TOO_LARGE", "text input exceeds the 64 KiB limit");
    }
    return ctx.hermetic().files.internal.uploads.registerBytes(name, bytes, { secretText: true });
  } finally {
    bytes.fill(0);
  }
}

export async function uploadDiscard(ctx: HandlerContext, params: unknown) {
  const { upload_id } = parseInput(FilesUploadRefInput, params);
  uploadPort.forget(upload_id);
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
 * An entry's bytes for the page to show: a committed (inbox) file's thumbnail
 * (`f_…`), or a share card's image, audio or video to play, or text to show
 * (`sh_…`). Each `purpose` admits only its own types, under its own cap
 * (`contentPurposeBytes`): anything else is refused from the box's response
 * headers (`Content-Type`, `Content-Length`), before its body is read. The
 * page turns the answer into a `blob:` URL it minted; it never names a path.
 */
export async function content(
  ctx: HandlerContext,
  params: unknown,
): Promise<{ mime: string; data_b64: string }> {
  const { instance, id, expected_sha256, purpose } = parseInput(FilesContentInput, params);
  const file = await ctx.hermetic().files.internal.content(instance, id, contentPurposeBytes(purpose), {
    signal: ctx.signal,
    purpose,
  });
  // Core already refused it from the headers; checked again on what was read.
  if (!contentPurposeAllows(purpose, file.mime)) {
    throw new HermeticError("FILE_TYPE_REJECTED", `${instance}: ${purposeRefusal(purpose)}`, {
      name: instance,
    });
  }
  if (expected_sha256 !== undefined && file.sha256 !== expected_sha256) {
    throw new HermeticError("FILE_DIGEST_MISMATCH", `${instance}: the shared file changed`, {
      name: instance,
    });
  }
  return { mime: file.mime, data_b64: encodeBase64(file.bytes) };
}

/** One native pick as the page sees it: never its path. */
export interface PickedFile {
  upload_id: string;
  name: string;
  size: number;
  /**
   * D6, read here because the page never holds a picked file's bytes: whether
   * its first `FILES_LIMITS.sniffBytes` look like a private key, so a request
   * card can ask "store as secret?" before the put, as it does for a drop.
   */
  looks_like_key: boolean;
}

/** The head of a picked file, sniffed for key material and zeroed. Unreadable reads as no. */
async function pickLooksLikeKey(path: string, name: string): Promise<boolean> {
  const head = new Uint8Array(FILES_LIMITS.sniffBytes);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const { bytesRead } = await handle.read(head, 0, head.byteLength, 0);
    return looksLikeKeyMaterial(head.subarray(0, bytesRead), name);
  } catch {
    // Core sniffs again on the put, so a miss here only skips the question.
    return false;
  } finally {
    head.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

export async function pickNative(
  ctx: HandlerContext,
  params: unknown,
): Promise<{ files: PickedFile[] }> {
  // Validated for shape only: the instance names whose composer asked, so a
  // later version can start the dialog somewhere useful for it.
  parseInput(FilesCapabilityInput, params);
  if (ctx.native === undefined) {
    throw new HermeticError("UNSUPPORTED", "files.pickNative is answered by the desktop head");
  }
  // The dialog stays open for as long as the operator likes, and a fleet
  // switch can land meanwhile. The picks belong to the fleet whose composer
  // asked: pinned here, before the dialog, and re-asserted after every await,
  // so a switch refuses the pick (`FLEET_MISMATCH`) instead of registering it
  // with the fleet the head moved to.
  const bound: Targeted<null> = {
    hermetic: ctx.state.hermetic,
    input: null,
    boundTo: ctx.state.target,
  };
  const paths = (await ctx.native.pickFiles()).filter((p) => p.length > 0);
  stillBound(ctx.state, bound);
  const uploads = bound.hermetic.files.internal.uploads;
  const files: PickedFile[] = [];
  try {
    for (const path of paths) {
      const picked = await uploads.registerPath(path);
      files.push({ ...picked, looks_like_key: await pickLooksLikeKey(path, picked.name) });
    }
    stillBound(ctx.state, bound);
  } catch (e) {
    // One unreadable pick, or a switch while reading them, fails the dialog;
    // nothing it registered is kept.
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
  [FILES_UPLOAD_OPEN]: uploadOpen,
  [FILES_SECRET_TEXT_UPLOAD]: secretTextUpload,
  [FILES_UPLOAD_DISCARD]: uploadDiscard,
  [FILES_CAPABILITY_RPC]: capability,
  [FILES_DISCARD]: discard,
  [FILES_CONTENT]: content,
  [FILES_PICK_NATIVE]: pickNative,
  "files.put": (ctx: HandlerContext, params: unknown, sink?: StreamSink) =>
    put(ctx, params, requireSink(sink)),
  "files.decline": decline,
  [FILES_PUT_ABORT]: stageAbort,
  [FILES_REQUEST_GET]: requestGet,
  "files.list": list,
  "files.get": (ctx: HandlerContext, params: unknown, sink?: StreamSink) =>
    get(ctx, params, requireSink(sink)),
  [FILES_GET_ABORT]: stageAbort,
  [FILES_SAVE_NATIVE]: saveNative,
  "files.rm": rm,
} satisfies Record<string, Handler>;
