/**
 * The composer's attachments over the bridge (`app/src/handlers/files.ts`).
 *
 * The page never names a laptop path. A drop or a paste is sent in base64
 * chunks into main-process memory (`files.chunk.*`); the native dialog
 * (`files.pickNative`) registers its picks in the same registry. Either way
 * the page stages by upload id and gets back the staged entry's `file_id`,
 * which is all `chat.send` carries.
 */
import type { HermeticRPC } from "@hermetic/app";
import { target } from "./client.ts";
import type { FleetTarget } from "./client.ts";
import { transport } from "./transport.ts";

type Requests = HermeticRPC["bun"]["requests"];
type Answer<K extends keyof Requests> = Requests[K]["response"];

/** One frame of a staging, as the app pushes it (`FilesStageFrame`). */
export type FilesStageFrame = NonNullable<HermeticRPC["webview"]["messages"]["files.frame"]["done"]>;
/** The staged entry a `staged` frame carries. */
export type StagedFile = Extract<FilesStageFrame, { type: "staged" }>["file"];
export type FilesStageProgress = Extract<FilesStageFrame, { type: "progress" }>;

export function chunkOpen(name: string, size: number): Promise<Answer<"files.chunk.open">> {
  return transport().request("files.chunk.open", { name, size });
}

export function chunkAppend(
  upload_id: string,
  offset: number,
  data_b64: string,
): Promise<Answer<"files.chunk.append">> {
  return transport().request("files.chunk.append", { upload_id, offset, data_b64 });
}

export function chunkClose(upload_id: string): Promise<Answer<"files.chunk.close">> {
  return transport().request("files.chunk.close", { upload_id });
}

export function chunkDiscard(upload_id: string): Promise<Answer<"files.chunk.discard">> {
  return transport().request("files.chunk.discard", { upload_id });
}

export function filesCapability(instance: string): Promise<Answer<"files.capability">> {
  return transport().request("files.capability", { instance });
}

/** Deletes a staged entry on the box: a removed chip. */
export function filesDiscard(instance: string, id: string): Promise<Answer<"files.discard">> {
  return transport().request("files.discard", { instance, id, target: target() });
}

/** A staged image's bytes, for its thumbnail. */
export function filesContent(instance: string, id: string): Promise<Answer<"files.content">> {
  return transport().request("files.content", { instance, id });
}

/** The native open dialog. `files: []` when the operator cancelled. */
export function pickNative(instance: string): Promise<Answer<"files.pickNative">> {
  return transport().request("files.pickNative", { instance });
}

export interface StageHandlers {
  onProgress: (frame: FilesStageProgress) => void;
  /** The staging's last word: `staged`, or `error` with the refusal's code. */
  onDone: (frame: Exclude<FilesStageFrame, FilesStageProgress>) => void;
}

/**
 * Stages one upload on `instance`'s box. Answers a canceller (the chip's ×),
 * and reports exactly one `onDone` unless cancelled: a stream that died
 * without a last word reads as an error, so a chip never hangs on "uploading".
 */
export function stageUpload(
  instance: string,
  upload_id: string,
  opts: { not_secret?: boolean; session?: string },
  handlers: StageHandlers,
): () => void {
  let fleet: FleetTarget;
  try {
    fleet = target();
  } catch (error) {
    queueMicrotask(() =>
      handlers.onDone({
        type: "error",
        code: "NO_TARGET",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return () => {};
  }
  let settled = false;
  const finish = (frame: Exclude<FilesStageFrame, FilesStageProgress>): void => {
    if (settled) return;
    settled = true;
    handlers.onDone(frame);
  };
  const params: Record<string, unknown> = {
    instance,
    source: { chunk_upload_id: upload_id },
    target: fleet,
  };
  if (opts.not_secret === true) params["not_secret"] = true;
  if (opts.session !== undefined) params["session"] = opts.session;
  const close = transport().openStream("files.stage", params, {
    onFrame: (frame) => {
      const data = frame.data as FilesStageFrame | undefined;
      if (data === undefined || typeof data !== "object") return;
      if (data.type === "progress") handlers.onProgress(data);
      else finish(data);
    },
    onEnd: (_ok, failure) => {
      finish({
        type: "error",
        code: failure?.code ?? "STREAM_CLOSED",
        message: failure?.message ?? "the upload stopped before the box answered",
      });
    },
  });
  return () => {
    settled = true;
    close();
  };
}

// ─── an agent's file request (attachments plan §8.3–8.4b) ──────────────────

/** One frame of a put, as the app pushes it (`FilesPutFrame`). */
export type FilesPutFrame = NonNullable<HermeticRPC["webview"]["messages"]["files.put.frame"]["done"]>;
export type FilesPutProgress = Extract<FilesPutFrame, { type: "progress" }>;
/** The box's copy of a request slot: what a request card draws from. */
export type FileRequestSlot = Answer<"files.request.get">;

/** The box's own copy of one request slot (machinery). */
export function requestGet(instance: string, request_id: string): Promise<FileRequestSlot> {
  return transport().request("files.request.get", { instance, request_id });
}

/** Say no to a request; the agent is told. Answers the slot as the box left it. */
export function decline(instance: string, request_id: string): Promise<Answer<"files.decline">> {
  return transport().request("files.decline", { instance, request_id, target: target() });
}

export interface PutOptions {
  /** A key-looking file on a normal request is not a secret (D6). */
  not_secret?: boolean;
  /** "Store as secret" on a key-looking file (D6): durable, in SSM, whatever the slot says. */
  secret?: boolean;
  /** A secret for this once: the box's tmpfs drop, never SSM. */
  ephemeral?: boolean;
  /** A text secret's "Treat as"; absent is `auto`. */
  as?: "auto" | "raw" | "dotenv";
  /** The operator chose "Replace": the durable slot already holds a secret. */
  replace?: boolean;
}

export interface PutHandlers {
  onProgress: (frame: FilesPutProgress) => void;
  /** The put's last word: `fulfilled`, or `error` with the refusal's code. */
  onDone: (frame: Exclude<FilesPutFrame, FilesPutProgress>) => void;
}

/**
 * Answers `request_id` on `instance`'s box with one upload. The same contract
 * as `stageUpload`: a canceller, and exactly one `onDone` unless cancelled.
 */
export function putUpload(
  instance: string,
  request_id: string,
  upload_id: string,
  opts: PutOptions,
  handlers: PutHandlers,
): () => void {
  let fleet: FleetTarget;
  try {
    fleet = target();
  } catch (error) {
    queueMicrotask(() =>
      handlers.onDone({
        type: "error",
        code: "NO_TARGET",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return () => {};
  }
  let settled = false;
  const finish = (frame: Exclude<FilesPutFrame, FilesPutProgress>): void => {
    if (settled) return;
    settled = true;
    handlers.onDone(frame);
  };
  const params: Record<string, unknown> = {
    instance,
    request_id,
    source: { chunk_upload_id: upload_id },
    target: fleet,
  };
  if (opts.not_secret === true) params["not_secret"] = true;
  if (opts.secret === true) params["secret"] = true;
  if (opts.ephemeral === true) params["ephemeral"] = true;
  if (opts.as !== undefined && opts.as !== "auto") params["as"] = opts.as;
  if (opts.replace === true) params["replace"] = true;
  const close = transport().openStream("files.put", params, {
    onFrame: (frame) => {
      const data = frame.data as FilesPutFrame | undefined;
      if (data === undefined || typeof data !== "object") return;
      if (data.type === "progress") handlers.onProgress(data);
      else finish(data);
    },
    onEnd: (_ok, failure) => {
      finish({
        type: "error",
        code: failure?.code ?? "STREAM_CLOSED",
        message: failure?.message ?? "the upload stopped before the box answered",
      });
    },
  });
  return () => {
    settled = true;
    close();
  };
}
