import { z } from "zod";
import { FILES_LIMITS } from "../shared/files.ts";
import { FileId, FileName, FilesStageResult } from "./files.ts";
import { OpEvent } from "./ops.ts";
import { AgentName } from "./requests.ts";

/**
 * The laptop side of the files service: what `files.stage` takes and streams,
 * and the request shapes of the desktop head's upload machinery
 * (`files.chunk.*`, `files.capability`, `files.discard`, `files.content`).
 *
 * Kept apart from `files.ts`, which is the box's wire format and is read by
 * hermeticd, and from `requests.ts`, which is near the file-size limit. None of
 * these shapes crosses the tailnet: they are core's own surface.
 */

/**
 * A chunked webview upload held in main-process memory, or a path the native
 * dialog registered: `up_` plus a random UUID. Opaque to the page.
 */
export const CHUNK_UPLOAD_ID_RE = /^up_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ChunkUploadId = z.string().regex(CHUNK_UPLOAD_ID_RE, "not an upload id (up_…)");
export type ChunkUploadId = z.infer<typeof ChunkUploadId>;

/**
 * Where a stage reads its bytes from: a file on this laptop (the CLI, and the
 * native dialog through the main process) or an upload the registry holds. The
 * desktop bridge refuses `path` outright — the page never names a path.
 */
export const FilesStageSource = z.union([
  z.object({ path: z.string().min(1).max(4096) }).strict(),
  z.object({ chunk_upload_id: ChunkUploadId }).strict(),
]);
export type FilesStageSource = z.infer<typeof FilesStageSource>;

/** `hermetic files stage <agent> <path>`: upload one file to the box's stage area. */
export const FilesStageInput = z.object({
  instance: AgentName,
  source: FilesStageSource,
  /** Overrides the name the source carries (the path's basename, or the upload's). */
  name: FileName.optional(),
  /** The operator confirmed a key-looking file is not a secret (D6). */
  not_secret: z.boolean().optional(),
  /** The chat session the upload is for, recorded on the staged entry. */
  session: z.string().min(1).max(256).optional(),
});
export type FilesStageInput = z.infer<typeof FilesStageInput>;

/**
 * The desktop bridge's view of the same request: an upload id and never a
 * path. The page holds no paths — the native dialog registers one in the main
 * process and hands back an id — so a request naming one is refused, the same
 * way `artifacts.push` over the bridge may not name a local file.
 */
export const FilesStageApiInput = FilesStageInput.extend({
  source: z.object({ chunk_upload_id: ChunkUploadId }).strict(),
});
export type FilesStageApiInput = z.infer<typeof FilesStageApiInput>;

/**
 * Progress inside a stage: an `OpEvent` with a discriminator. `phase` is
 * `read`, `hash` or `upload`. The message never names the file: file names may
 * be sensitive, and progress is what a head is most likely to log.
 */
export const FilesStageProgressEvent = OpEvent.extend({ type: z.literal("progress") });
export type FilesStageProgressEvent = z.infer<typeof FilesStageProgressEvent>;

/** The last event of a successful stage: what the box answered. */
export const FilesStagedEvent = z.object({ type: z.literal("staged"), file: FilesStageResult });
export type FilesStagedEvent = z.infer<typeof FilesStagedEvent>;

/** What `files.stage` yields. A failure is a thrown `HermeticError`, as with every core stream. */
export const FilesStageEvent = z.discriminatedUnion("type", [
  FilesStageProgressEvent,
  FilesStagedEvent,
]);
export type FilesStageEvent = z.infer<typeof FilesStageEvent>;

/**
 * The terminal frame a head sends when a stage it pumped failed after it had
 * already answered with a stream id: the `HermeticError`'s code and message.
 */
export const FilesStageErrorEvent = z.object({
  type: z.literal("error"),
  code: z.string().min(1),
  message: z.string(),
});
export type FilesStageErrorEvent = z.infer<typeof FilesStageErrorEvent>;

/** Every frame a head may push for one stage. */
export const FilesStageFrame = z.discriminatedUnion("type", [
  FilesStageProgressEvent,
  FilesStagedEvent,
  FilesStageErrorEvent,
]);
export type FilesStageFrame = z.infer<typeof FilesStageFrame>;

// --- The desktop head's upload machinery -----------------------------------

/**
 * Open a chunked upload. `name` is checked with `sanitizeFileName` by core, so
 * a refusal can say why; `size` is the whole file, capped by core at
 * `FILES_LIMITS.chunkUploadBytes`.
 */
export const FilesChunkOpenInput = z.object({
  name: z.string().min(1).max(1024),
  // Not capped here: core refuses an oversize drop `FILE_TOO_LARGE` with the
  // advice to use the dialog instead, which a schema refusal could not carry.
  size: z.number().int().nonnegative(),
});
export type FilesChunkOpenInput = z.infer<typeof FilesChunkOpenInput>;

/** One chunk, base64, at most `FILES_LIMITS.chunkBytes` decoded. */
export const FilesChunkAppendInput = z.object({
  upload_id: ChunkUploadId,
  offset: z.number().int().nonnegative(),
  // Base64 of 1 MiB is 4/3 of it, rounded up to a multiple of four.
  data_b64: z.string().max(Math.ceil(FILES_LIMITS.chunkBytes / 3) * 4),
});
export type FilesChunkAppendInput = z.infer<typeof FilesChunkAppendInput>;

export const FilesChunkRefInput = z.object({ upload_id: ChunkUploadId });
export type FilesChunkRefInput = z.infer<typeof FilesChunkRefInput>;

export const FilesCapabilityInput = z.object({ instance: AgentName });
export type FilesCapabilityInput = z.infer<typeof FilesCapabilityInput>;

/** A staged entry on one box: the chip's remove, and its thumbnail. */
export const FilesEntryRefInput = z.object({ instance: AgentName, id: FileId });
export type FilesEntryRefInput = z.infer<typeof FilesEntryRefInput>;

/** Whether a box serves the files routes, from its `/healthz`. */
export const FilesCapability = z.object({
  files: z.boolean(),
  hermeticd_version: z.string().nullable(),
});
export type FilesCapability = z.infer<typeof FilesCapability>;
