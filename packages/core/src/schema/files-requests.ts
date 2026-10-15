import { z } from "zod";
import { FILES_LIMITS } from "../shared/files.ts";
import {
  FileEntryId,
  FileId,
  FileName,
  FileRequestId,
  FilesFulfilResult,
  FilesStageResult,
  SecretTextAsMode,
} from "./files.ts";
import { Sha256 } from "./common.ts";
import { OpEvent } from "./ops.ts";
import { AgentName } from "./requests.ts";

/**
 * The laptop side of the files service: what `files.stage` takes and streams,
 * and the request shapes of the desktop head's upload machinery
 * (`files.secretText.upload`, `files.upload.discard`, `files.capability`,
 * `files.discard`, `files.content`).
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
 * Open a streamed upload: the page then PUTs the file to the URL this answers
 * (`app/src/upload-port.ts`). No size cap: the fleet's `files.max_bytes` is
 * checked by the stage and by the box.
 */
export const FilesUploadOpenInput = z.object({
  name: z.string().min(1).max(1024),
  size: z.number().int().nonnegative(),
});
export type FilesUploadOpenInput = z.infer<typeof FilesUploadOpenInput>;

/** One bounded text secret, sent in one request and held by upload id. */
export const FilesSecretTextUploadInput = z.object({
  name: z.string().min(1).max(1024),
  data_b64: z.string().max(Math.ceil(FILES_LIMITS.secretTextBytes / 3) * 4),
});
export type FilesSecretTextUploadInput = z.infer<typeof FilesSecretTextUploadInput>;

export const FilesUploadRefInput = z.object({ upload_id: ChunkUploadId });
export type FilesUploadRefInput = z.infer<typeof FilesUploadRefInput>;

export const FilesCapabilityInput = z.object({ instance: AgentName });
export type FilesCapabilityInput = z.infer<typeof FilesCapabilityInput>;

/** A staged entry on one box: the chip's remove (`files.discard`). Files only, never a share. */
export const FilesEntryRefInput = z.object({ instance: AgentName, id: FileId });
export type FilesEntryRefInput = z.infer<typeof FilesEntryRefInput>;

/**
 * An entry whose bytes a preview reads (`files.content`): a committed (inbox)
 * file's thumbnail (`f_…`), or a share card's image (`sh_…`), which the box's
 * content route serves alike.
 */
export const FilesContentInput = z.object({
  instance: AgentName,
  id: FileEntryId,
  /** A share card's pinned digest; verified in the main process before bytes reach the page. */
  expected_sha256: Sha256.optional(),
});
export type FilesContentInput = z.infer<typeof FilesContentInput>;

/** Whether a box serves the files routes, from its `/healthz`. */
export const FilesCapability = z.object({
  files: z.boolean(),
  hermeticd_version: z.string().nullable(),
});
export type FilesCapability = z.infer<typeof FilesCapability>;

// --- Agent file requests: `files.put` and `files.decline` --------------------

/**
 * `hermetic files put <agent> --request <id> …`: answer a request the agent
 * opened (`request_file`/`request_secret`) with a file or a text secret.
 *
 * No field carries a value. A text secret read from stdin is registered with
 * the upload registry first and named here by its `chunk_upload_id`, so the
 * secret never sits in an input that a run log or an op record could keep.
 */
export const FilesPutInput = z.object({
  instance: AgentName,
  request_id: FileRequestId,
  source: FilesStageSource,
  /** Store it as a secret even if the request did not ask for one. */
  secret: z.boolean().optional(),
  /** A secret for this once: the box's tmpfs drop, never SSM ("Just this once"). */
  ephemeral: z.boolean().optional(),
  /** The operator confirmed a key-looking file is not a secret (D6). */
  not_secret: z.boolean().optional(),
  /** A text secret's "Treat as": `raw` one value, or `dotenv` lines. Absent is `auto`. */
  as: SecretTextAsMode.optional(),
  /**
   * The operator confirmed a durable secret may replace the one its SSM slot
   * already holds. Without it, a put to an occupied slot is refused with
   * `CONFLICT` and `details.replace_required` before anything is written.
   */
  replace: z.boolean().optional(),
});
export type FilesPutInput = z.infer<typeof FilesPutInput>;

/** The desktop bridge's view: an upload id, never a path (as `FilesStageApiInput`). */
export const FilesPutApiInput = FilesPutInput.extend({
  source: z.object({ chunk_upload_id: ChunkUploadId }).strict(),
});
export type FilesPutApiInput = z.infer<typeof FilesPutApiInput>;

/** Progress inside a put: `phase` is `read`, `hash`, `upload` or `ssm`. Never names the file. */
export const FilesPutProgressEvent = OpEvent.extend({ type: z.literal("progress") });
export type FilesPutProgressEvent = z.infer<typeof FilesPutProgressEvent>;

/**
 * The last event of a successful put: what the box answered. `ssm_slot` is
 * the durable slot the laptop wrote (`file-<slug>`/`env-<slug>`), absent when
 * the bytes went to the box directly.
 */
export const FilesPutFulfilledEvent = z.object({
  type: z.literal("fulfilled"),
  result: FilesFulfilResult,
  ssm_slot: z.string().min(1).max(128).optional(),
});
export type FilesPutFulfilledEvent = z.infer<typeof FilesPutFulfilledEvent>;

/** What `files.put` yields. A failure is a thrown `HermeticError`. */
export const FilesPutEvent = z.discriminatedUnion("type", [
  FilesPutProgressEvent,
  FilesPutFulfilledEvent,
]);
export type FilesPutEvent = z.infer<typeof FilesPutEvent>;

/**
 * A put's terminal failure: as `FilesStageErrorEvent`, plus `replace_slot` when
 * the refusal was a durable secret's occupied slot (`replace_required`), so the
 * card can ask before it sends again with `replace`. The slot name only.
 */
export const FilesPutErrorEvent = FilesStageErrorEvent.extend({
  replace_slot: z.string().min(1).max(128).optional(),
});
export type FilesPutErrorEvent = z.infer<typeof FilesPutErrorEvent>;

/** Every frame a head may push for one put: as `FilesStageFrame`, ending `fulfilled` or `error`. */
export const FilesPutFrame = z.discriminatedUnion("type", [
  FilesPutProgressEvent,
  FilesPutFulfilledEvent,
  FilesPutErrorEvent,
]);
export type FilesPutFrame = z.infer<typeof FilesPutFrame>;

/** `hermetic files decline <agent> <request>`: say no to a request. The agent is told. */
export const FilesDeclineInput = z.object({
  instance: AgentName,
  request_id: FileRequestId,
  reason: z.string().trim().min(1).max(500).optional(),
});
export type FilesDeclineInput = z.infer<typeof FilesDeclineInput>;

/** One request slot on one box: the card's read of the box's own copy (machinery). */
export const FilesRequestRefInput = z.object({ instance: AgentName, request_id: FileRequestId });
export type FilesRequestRefInput = z.infer<typeof FilesRequestRefInput>;

// --- The Files tab: `files.list`, `files.get` and `files.rm` -----------------

/**
 * `hermetic files ls <agent> [--requests]`: every entry and request slot on one
 * box, metadata only (`FilesListResult`). `requests` narrows the answer to the
 * slots still waiting for a file (`open`); the entries are then empty.
 */
export const FilesListInput = z.object({
  name: AgentName,
  requests: z.boolean().optional(),
});
export type FilesListInput = z.infer<typeof FilesListInput>;

/**
 * A folder the desktop head's save dialog chose (`files.saveNative`), held in
 * main-process memory: `sv_` plus a random UUID. Opaque to the page, which
 * never sees the folder's path.
 */
export const SAVE_DEST_ID_RE = /^sv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SaveDestId = z.string().regex(SAVE_DEST_ID_RE, "not a save destination id (sv_…)");
export type SaveDestId = z.infer<typeof SaveDestId>;

/**
 * Where a download lands: a file path on this laptop (the CLI's `-o`), or a
 * folder the save dialog registered, in which the file is created under its
 * own sanitized name. Either way the file is created exclusively — an existing
 * path is refused, never overwritten.
 */
export const FilesGetDest = z.union([
  z.object({ path: z.string().min(1).max(4096) }).strict(),
  z.object({ dest_id: SaveDestId }).strict(),
]);
export type FilesGetDest = z.infer<typeof FilesGetDest>;

/**
 * `hermetic files get <agent> <id> -o <path>`: download one inbox file
 * (`f_…`) or outbox share (`sh_…`). Secret entries are refused.
 */
export const FilesGetInput = z.object({
  name: AgentName,
  id: FileEntryId,
  dest: FilesGetDest,
});
export type FilesGetInput = z.infer<typeof FilesGetInput>;

/** The desktop bridge's view: a save-dialog handle, never a path (as `FilesPutApiInput`). */
export const FilesGetApiInput = FilesGetInput.extend({
  dest: z.object({ dest_id: SaveDestId }).strict(),
});
export type FilesGetApiInput = z.infer<typeof FilesGetApiInput>;

/** Progress inside a get: `phase` is `list`, `fetch`, `verify` or `write`. Never names the file. */
export const FilesGetProgressEvent = OpEvent.extend({ type: z.literal("progress") });
export type FilesGetProgressEvent = z.infer<typeof FilesGetProgressEvent>;

/**
 * The last event of a successful get: what was saved, by the name it was saved
 * under. Never the path it was written to: the head that chose it knows it,
 * and a page that asked through the save dialog must not learn it.
 */
export const FilesSavedEvent = z.object({
  type: z.literal("saved"),
  file: z.object({
    id: FileEntryId,
    name: FileName,
    bytes: z.number().int().nonnegative(),
    mime: z.string().min(1),
    sha256: Sha256,
  }),
});
export type FilesSavedEvent = z.infer<typeof FilesSavedEvent>;

/** What `files.get` yields. A failure is a thrown `HermeticError`. */
export const FilesGetEvent = z.discriminatedUnion("type", [FilesGetProgressEvent, FilesSavedEvent]);
export type FilesGetEvent = z.infer<typeof FilesGetEvent>;

/** Every frame a head may push for one get: ending `saved` or `error`. */
export const FilesGetFrame = z.discriminatedUnion("type", [
  FilesGetProgressEvent,
  FilesSavedEvent,
  FilesStageErrorEvent,
]);
export type FilesGetFrame = z.infer<typeof FilesGetFrame>;

/**
 * `hermetic files rm <agent> <id>`: plan the removal of one inbox file, outbox
 * share or stored secret. The answer is a `Plan` (`kind: "files-rm"`) the head
 * shows and `apply` executes (§3.2 rule 3): a durable secret's removal also
 * deletes its SSM slot, which nothing can put back.
 */
export const FilesRmInput = z.object({ name: AgentName, id: FileEntryId });
export type FilesRmInput = z.infer<typeof FilesRmInput>;
