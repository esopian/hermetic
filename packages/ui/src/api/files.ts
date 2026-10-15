/**
 * The composer's attachments over the bridge (`app/src/handlers/files.ts`).
 *
 * The page never names a laptop path. A drop or paste streams to a loopback
 * upload port; a bounded text secret goes over RPC; the native dialog
 * (`files.pickNative`) registers its picks in the same registry. The page
 * stages an attachment by upload id and gets back the entry's `file_id`,
 * which is all `chat.send` carries; request answers use `files.put`.
 */
import type { HermeticRPC } from "@hermetic/app";
import { target } from "./client.ts";
import type { FleetTarget } from "./client.ts";
import { transport } from "./transport.ts";
import type { StreamName } from "./transport.ts";

type Requests = HermeticRPC["bun"]["requests"];
type Answer<K extends keyof Requests> = Requests[K]["response"];

type FileProgress = { type: "progress" };
type FileError = { type: "error"; code: string; message: string };

/** Finite file streams share completion, refusal and cancellation rules. */
function openFileStream<F extends { type: string }>(
  name: Extract<StreamName, "files.stage" | "files.put" | "files.get">,
  params: Record<string, unknown>,
  handlers: {
    onProgress?: (frame: Extract<F, FileProgress>) => void;
    onDone: (frame: Exclude<F, FileProgress>) => void;
  },
  stopped: string,
  errorFrame: (code: string, message: string) => Exclude<F, FileProgress>,
): () => void {
  let settled = false;
  const finish = (frame: Exclude<F, FileProgress>): void => {
    if (settled) return;
    settled = true;
    handlers.onDone(frame);
  };
  const close = transport().openStream(name, params, {
    onFrame: (frame) => {
      const data = frame.data as F | undefined;
      if (data === undefined || typeof data !== "object") return;
      if (data.type === "progress") handlers.onProgress?.(data as Extract<F, FileProgress>);
      else finish(data as Exclude<F, FileProgress>);
    },
    onEnd: (_ok, failure) => {
      finish(errorFrame(failure?.code ?? "STREAM_CLOSED", failure?.message ?? stopped));
    },
  });
  return () => {
    settled = true;
    close();
  };
}

function targetOrRefuse(onDone: (frame: FileError) => void): FleetTarget | null {
  try {
    return target();
  } catch (error) {
    queueMicrotask(() =>
      onDone({
        type: "error",
        code: "NO_TARGET",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

/** One frame of a staging, as the app pushes it (`FilesStageFrame`). */
export type FilesStageFrame = NonNullable<HermeticRPC["webview"]["messages"]["files.frame"]["done"]>;
/** The staged entry a `staged` frame carries. */
export type StagedFile = Extract<FilesStageFrame, { type: "staged" }>["file"];
export type FilesStageProgress = Extract<FilesStageFrame, { type: "progress" }>;

/**
 * Reserve a streamed upload for a dropped or pasted file: answers its id and
 * the loopback URL the page PUTs the file to (`putStream`).
 */
export function uploadOpen(name: string, size: number): Promise<Answer<"files.upload.open">> {
  return transport().request("files.upload.open", { name, size });
}

export function secretTextUpload(
  name: string,
  data_b64: string,
): Promise<Answer<"files.secretText.upload">> {
  return transport().request("files.secretText.upload", { name, data_b64 });
}

export function uploadDiscard(upload_id: string): Promise<Answer<"files.upload.discard">> {
  return transport().request("files.upload.discard", { upload_id });
}

export function filesCapability(instance: string): Promise<Answer<"files.capability">> {
  return transport().request("files.capability", { instance });
}

/** Deletes a staged entry on the box: a removed chip. */
export function filesDiscard(instance: string, id: string): Promise<Answer<"files.discard">> {
  return transport().request("files.discard", { instance, id, target: target() });
}

/** Verified image bytes, with an optional digest pinned by a share card. */
export function filesContent(
  instance: string,
  id: string,
  expected_sha256?: string,
): Promise<Answer<"files.content">> {
  return transport().request("files.content", {
    instance,
    id,
    ...(expected_sha256 ? { expected_sha256 } : {}),
  });
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
  const fleet = targetOrRefuse(handlers.onDone);
  if (fleet === null) return () => {};
  const params: Record<string, unknown> = {
    instance,
    source: { chunk_upload_id: upload_id },
    target: fleet,
  };
  if (opts.not_secret === true) params["not_secret"] = true;
  if (opts.session !== undefined) params["session"] = opts.session;
  return openFileStream<FilesStageFrame>(
    "files.stage",
    params,
    handlers,
    "the upload stopped before the box answered",
    (code, message) => ({ type: "error", code, message }),
  );
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
  const fleet = targetOrRefuse(handlers.onDone);
  if (fleet === null) return () => {};
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
  return openFileStream<FilesPutFrame>(
    "files.put",
    params,
    handlers,
    "the upload stopped before the box answered",
    (code, message) => ({ type: "error", code, message }),
  );
}

// ─── saving a file the agent shared (attachments plan §8.5) ──────────────────

/** One frame of a download, as the app pushes it (`FilesGetFrame`). */
export type FilesGetFrame = NonNullable<HermeticRPC["webview"]["messages"]["files.get.frame"]["done"]>;
export type FilesGetProgress = Extract<FilesGetFrame, { type: "progress" }>;
/** The saved file a `saved` frame carries: name, size and digest, never where it went. */
export type SavedFile = Extract<FilesGetFrame, { type: "saved" }>["file"];

/**
 * The native folder dialog for a download. `dest_id: null` when the operator
 * cancelled; otherwise an opaque handle for `files.get` — never the path.
 */
export function saveNative(instance: string): Promise<Answer<"files.saveNative">> {
  return transport().request("files.saveNative", { instance });
}

export interface SaveHandlers {
  /** The operator closed the folder dialog without choosing: nothing happens. */
  onCancelled: () => void;
  /** A folder was chosen and the download is under way. */
  onStarted?: () => void;
  onProgress?: (frame: FilesGetProgress) => void;
  /** The save's last word: `saved`, or `error` with the refusal's code. */
  onDone: (frame: Exclude<FilesGetFrame, FilesGetProgress>) => void;
}

/**
 * "Save…" on an inbox file (`f_…`) or an outbox share (`sh_…`) of `name`'s box:
 * the folder dialog, then `files.get` into the folder it chose, under the
 * file's own sanitized name, never over an existing file. The same contract as
 * `putUpload`: a canceller, and exactly one `onDone` (or `onCancelled`) unless
 * cancelled. Shared by the chat's share cards and the agent's Files tab.
 */
export function saveFile(name: string, id: string, handlers: SaveHandlers): () => void {
  let settled = false;
  let close: (() => void) | null = null;
  const finish = (frame: Exclude<FilesGetFrame, FilesGetProgress>): void => {
    if (settled) return;
    settled = true;
    handlers.onDone(frame);
  };
  const fail = (e: unknown): void => {
    const code = typeof e === "object" && e !== null && "code" in e ? String(e.code) : "INTERNAL";
    finish({ type: "error", code, message: e instanceof Error ? e.message : String(e) });
  };
  saveNative(name).then(({ dest_id }) => {
    if (settled) return;
    if (dest_id === null) {
      settled = true;
      handlers.onCancelled();
      return;
    }
    handlers.onStarted?.();
    close = openFileStream<FilesGetFrame>(
      "files.get",
      { name, id, dest: { dest_id } },
      { onProgress: handlers.onProgress, onDone: finish },
      "the download stopped before the box answered",
      (code, message) => ({ type: "error", code, message }),
    );
  }, fail);
  return () => {
    settled = true;
    close?.();
  };
}

// ─── the agent's Files tab (attachments plan §8.6) ───────────────────────────

/** `files.list`: what is on one box, metadata only — never a byte of content. */
export type FilesList = Answer<"files.list">;
/** One stored entry: an inbox file, an outbox share or a secret's metadata. */
export type FileEntryView = FilesList["inbox"][number];
/** One request slot as the box lists it. */
export type FileRequestView = FilesList["requests"][number];
/** `files.rm`'s plan, applied by the same `apply` every other plan goes through. */
export type FilesRmPlan = Answer<"files.rm">;

/**
 * Everything on `name`'s box, or with `requests: true` only its open request
 * slots (the entry arrays then come back empty) — what the bell and the fleet
 * badge poll.
 */
export function filesList(
  name: string,
  opts: { requests?: boolean; signal?: AbortSignal } = {},
): Promise<FilesList> {
  const params: Record<string, unknown> = { name };
  if (opts.requests === true) params["requests"] = true;
  return transport().request(
    "files.list",
    params,
    opts.signal === undefined ? undefined : { signal: opts.signal },
  );
}

/** The plan for deleting one entry; a durable secret's plan deletes its SSM slot too. */
export function filesRm(name: string, id: string): Promise<FilesRmPlan> {
  return transport().request("files.rm", { name, id });
}
