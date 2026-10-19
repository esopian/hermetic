import { z } from "zod";
import {
  FILE_CLASSES,
  FILE_DIRS,
  FILE_REQUEST_KINDS,
  FILE_REQUEST_STATES,
  FILE_SENSITIVITIES,
  FILES_TTL,
  SECRET_TEXT_AS,
  SECRET_TEXT_FORMATS,
  SECRET_TEXT_INPUTS,
  SECRET_TEXT_KEY_RE,
  SECRET_TEXT_MAX_KEYS,
  isFileId,
  isRequestId,
  isShareId,
  sanitizeFileName,
} from "../shared/files.ts";
import { Iso, Sha256 } from "./common.ts";

/**
 * The files service's wire shapes: what hermeticd answers on its tailnet
 * `/files` routes and on the plugin's local socket, and what the laptop and the
 * plugin send it. snake_case JSON, ISO timestamps, sizes in bytes.
 *
 * The plain values these are built from — routes, id formats, the name rules,
 * caps, enums — live in `../shared/files.ts` and are re-exported here, so this
 * door opens onto all of them. `tests/files-seam.test.ts` pins the documents
 * both sides read, and `tests/fixtures/files/*.json` are the socket replies the
 * Python plugin is checked against.
 */
export {
  CONTENT_DIGEST_HEADER,
  CONTENT_PURPOSES,
  ENV_SECRET_SLOT_RE,
  FILES_CAPABILITY,
  FILES_DROP_DIR,
  FILES_ERROR_CODES,
  FILES_HTTP_STATUS,
  FILES_INBOX_DIR,
  FILES_INDEX_PATH,
  FILES_LIMITS,
  FILES_OUTBOX_DIR,
  FILES_ROUTES,
  FILES_SECRET_AS_HEADER,
  FILES_SECRET_DIR,
  FILES_SESSION_HEADER,
  FILES_SOCKET_PATH,
  FILES_SOCKET_ROUTES,
  FILES_STAGE_DIR,
  FILES_TTL,
  FILE_CLASSES,
  FILE_DIRS,
  FILE_REQUEST_KINDS,
  FILE_REQUEST_STATES,
  FILE_SECRET_SLOT_RE,
  FILE_SENSITIVITIES,
  SECRET_ENVELOPE_MAX_CHARS,
  SECRET_TEXT_AS,
  SECRET_TEXT_FORMATS,
  SECRET_TEXT_INPUTS,
  SECRET_TEXT_KEY_RE,
  SECRET_TEXT_MAX_KEYS,
  acceptMatches,
  contentPurposeAllows,
  contentPurposeBytes,
  decodeSecretEnvelope,
  encodeSecretEnvelope,
  envSecretSlot,
  fileSecretSlot,
  filesHttpStatus,
  formatContentDigest,
  inboxRelPath,
  isEnvSecretSlot,
  isFileId,
  isFileSecretSlot,
  isImageMime,
  isRequestId,
  isShareId,
  looksLikeKeyMaterial,
  matchFilesRoute,
  matchSocketRoute,
  newFileId,
  newRequestId,
  newShareId,
  parseContentDigest,
  purposeRefusal,
  sanitizeFileName,
  secretEnvelopeFits,
  secretSlotFileName,
  secretTextLoad,
  secretTextSlug,
  shortId,
  sniffMime,
} from "../shared/files.ts";
export type {
  ContentPurpose,
  FileNameRejection,
  FilesErrorCode,
  FilesRoute,
  FilesSocketRoute,
  SanitizedFileName,
  SecretEnvelope,
  SecretTextAs,
  SecretTextFormat,
  SecretTextInput,
} from "../shared/files.ts";

// The text-secret parser (plan §06b) through the schema door too, so hermeticd
// re-parses with exactly the code the card previewed with.
export {
  SECRET_ENV_ERROR_CODES,
  SECRET_ENV_WARNING_CODES,
  SECRET_KEY_RE,
  SECRET_TEXT_MAX_BYTES,
  canonicalSecretEnv,
  detectSecretFormat,
  parseSecretEnv,
  readCanonicalSecretEnv,
} from "../shared/secret-env.ts";
export type {
  SecretEnvChip,
  SecretEnvEntry,
  SecretEnvErrorCode,
  SecretEnvIssue,
  SecretEnvResult,
  SecretEnvSpec,
  SecretEnvWarningCode,
  SecretFormat,
  SecretInputMode,
} from "../shared/secret-env.ts";

// --- Primitives -------------------------------------------------------------

export const FileDir = z.enum(FILE_DIRS);
export type FileDir = z.infer<typeof FileDir>;
export const FileSensitivity = z.enum(FILE_SENSITIVITIES);
export type FileSensitivity = z.infer<typeof FileSensitivity>;
export const FileClass = z.enum(FILE_CLASSES);
export type FileClass = z.infer<typeof FileClass>;
export const FileRequestState = z.enum(FILE_REQUEST_STATES);
export type FileRequestState = z.infer<typeof FileRequestState>;
export const FileRequestKind = z.enum(FILE_REQUEST_KINDS);
export type FileRequestKind = z.infer<typeof FileRequestKind>;
export const SecretTextInputMode = z.enum(SECRET_TEXT_INPUTS);
export const SecretTextAsMode = z.enum(SECRET_TEXT_AS);
export const SecretTextFormatName = z.enum(SECRET_TEXT_FORMATS);
/** A key name a `request_secret` may ask for (`SECRET_TEXT_KEY_RE`). */
export const SecretTextKey = z.string().regex(SECRET_TEXT_KEY_RE, "not an upper-case env name");

/** An inbox, secret or staged file (`f_…`) or an outbox share (`sh_…`). */
export const FileEntryId = z
  .string()
  .refine((id) => isFileId(id) || isShareId(id), "not a file (f_…) or share (sh_…) id");
export const FileId = z.string().refine(isFileId, "not a file id (f_…)");
export const FileRequestId = z.string().refine(isRequestId, "not a file request id (fr_…)");
export const ShareId = z.string().refine(isShareId, "not a share id (sh_…)");

/** A name `sanitizeFileName` accepts unchanged — what every stored entry carries. */
export const FileName = z.string().refine((name) => {
  const clean = sanitizeFileName(name);
  return clean.ok && clean.name === name;
}, "not a safe file name");

const Bytes = z.number().int().nonnegative();
/** Session and task ids come from Hermes; bounded, otherwise opaque. */
const OpaqueId = z.string().min(1).max(256);

/** Who put an entry on the box: an operator (by tailnet identity) or the agent itself. */
export const FileOrigin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator"), login: z.string().min(1), node: z.string().min(1) }),
  z.object({ kind: z.literal("agent") }),
]);
export type FileOrigin = z.infer<typeof FileOrigin>;

// --- Entries and requests (tailnet, metadata only) ------------------------

/** One stored file, as `GET /files` and `GET /files/:id` list it. Never content. */
export const FileEntry = z.object({
  id: FileEntryId,
  dir: FileDir,
  class: FileClass,
  name: FileName,
  bytes: Bytes,
  /** Sniffed from the bytes (`sniffMime`), never taken from the sender. */
  mime: z.string().min(1),
  sha256: Sha256,
  created_at: Iso,
  /** `null` for a durable secret: it lives until `files rm`. */
  expires_at: Iso.nullable(),
  /** Inbox or outbox path relative to `HERMES_HOME` (`inbox/2026-10-13/f_…/a.png`). */
  rel: z.string().min(1).optional(),
  /** Absolute path on the box. */
  path: z.string().min(1).optional(),
  from: FileOrigin,
  session_id: OpaqueId.optional(),
  request_id: FileRequestId.optional(),
  /** A durable secret's SSM slot (`file-<slug>` or `env-<slug>`). */
  slot: z.string().min(1).optional(),
  /**
   * A durable text secret: the key names stored, never values. What tells a
   * later request for the same secret (a rotation) from another one on the
   * same slug once the request that stored it is gone.
   */
  keys: z.array(z.string().min(1).max(128)).optional(),
  /** The agent's note on a share. */
  note: z.string().max(2000).optional(),
});
export type FileEntry = z.infer<typeof FileEntry>;

/**
 * A request slot the agent opened (`request_file`). Rendered from hermeticd's
 * copy, so a model's claims in its tool arguments cannot widen what the box
 * accepts.
 */
export const FileRequest = z.object({
  request_id: FileRequestId,
  kind: FileRequestKind,
  /** Shown verbatim to the human. */
  purpose: z.string().min(1).max(2000),
  name_hint: z.string().min(1).optional(),
  /** `.ext` or MIME entries (`acceptMatches`); empty accepts anything. */
  accept: z.array(z.string()),
  max_bytes: Bytes,
  sensitivity: FileSensitivity,
  durable: z.boolean(),
  state: FileRequestState,
  created_at: Iso,
  expires_at: Iso,
  session_id: OpaqueId.optional(),
  /** `secret_text` requests: key names required, never values. */
  keys: z.array(z.string().min(1).max(128)).optional(),
  optional_keys: z.array(z.string().min(1).max(128)).optional(),
  /** `secret_text`: the file stem under the secret dir (`<slug>.env`) and the `env-<slug>` slot. */
  slug: z.string().min(1).max(48).optional(),
  /** `secret_text`: the card's starting input mode. */
  input: SecretTextInputMode.optional(),
  fulfilled: z
    .object({
      path: z.string().min(1),
      sha256: Sha256,
      bytes: Bytes,
      /** The operator's tailnet login. */
      by: z.string().min(1),
      at: Iso,
      class: FileClass,
      /** `secret_text`: the key names stored (never values) and how the text was read. */
      keys: z.array(z.string().min(1).max(128)).optional(),
      format: SecretTextFormatName.optional(),
      /** The durable SSM slot (`file-<slug>`/`env-<slug>`), absent for an ephemeral secret. */
      ssm_slot: z.string().min(1).max(128).optional(),
    })
    .optional(),
  declined: z.object({ reason: z.string().max(500).optional(), at: Iso }).optional(),
  /** The last refused upload; the slot stays `open`. */
  rejected: z.object({ code: z.string().min(1), message: z.string(), at: Iso }).optional(),
});
export type FileRequest = z.infer<typeof FileRequest>;

// --- Tailnet request and response bodies -----------------------------------

/** `201` from `PUT /files/stage/:name`. */
export const FilesStageResult = z.object({
  id: FileId,
  name: FileName,
  bytes: Bytes,
  mime: z.string().min(1),
  sha256: Sha256,
  class: FileClass,
  expires_at: Iso,
});
export type FilesStageResult = z.infer<typeof FilesStageResult>;

/** `POST /files/:id/commit`. */
export const FilesCommitBody = z.object({ session_id: OpaqueId.optional() });
export type FilesCommitBody = z.infer<typeof FilesCommitBody>;

/**
 * The committed entry: where it now is, and what it is. The metadata is the
 * index's own (the same `name`/`bytes`/`mime`/`sha256` the stage answered),
 * repeated so the turn that commits it can describe the file to the agent
 * without a second read.
 */
export const FilesCommitResult = z.object({
  id: FileId,
  path: z.string().min(1),
  /** The `@file:` reference, relative to `HERMES_HOME`. */
  rel: z.string().min(1),
  name: FileName,
  bytes: Bytes,
  mime: z.string().min(1),
  sha256: Sha256,
  class: FileClass,
});
export type FilesCommitResult = z.infer<typeof FilesCommitResult>;

/** `200` from `PUT /files/requests/:id` and `POST /files/requests/:id/secret`. */
export const FilesFulfilResult = z.object({
  request_id: FileRequestId,
  path: z.string().min(1),
  sha256: Sha256,
  bytes: Bytes,
  class: FileClass,
  /** `secret_text` only: key names stored and the format the box read. */
  keys: z.array(z.string().min(1).max(128)).optional(),
  format: SecretTextFormatName.optional(),
});
export type FilesFulfilResult = z.infer<typeof FilesFulfilResult>;

/** `POST /files/requests/:id/secret`: the slot the laptop already wrote to SSM. */
export const FilesSecretBody = z.object({
  ssm_slot: z.string().min(1).max(128),
  name: FileName,
  /**
   * `secret_text` only: how the laptop read the operator's text. The slot holds
   * the canonical `KEY="…"` form either way, which the box re-parses against
   * the request's keys; this is recorded so the agent is told the format.
   */
  format: SecretTextFormatName.optional(),
});
export type FilesSecretBody = z.infer<typeof FilesSecretBody>;

/** `POST /files/requests/:id/decline`. */
export const FilesDeclineBody = z.object({ reason: z.string().max(500).optional() });
export type FilesDeclineBody = z.infer<typeof FilesDeclineBody>;

/** `GET /files`: everything on the box, metadata only. */
export const FilesListResult = z.object({
  inbox: z.array(FileEntry),
  outbox: z.array(FileEntry),
  secrets: z.array(FileEntry),
  requests: z.array(FileRequest),
  usage: z.object({
    inbox_bytes: Bytes,
    outbox_bytes: Bytes,
    disk_used_pct: z.number().min(0).max(100).optional(),
    retention_days: z.number().int().positive(),
  }),
});
export type FilesListResult = z.infer<typeof FilesListResult>;

/** Every non-2xx files response, tailnet or socket. `code` is a `FILES_ERROR_CODES` entry. */
export const FilesErrorBody = z.object({
  error: z.object({
    // A string rather than the enum: a newer hermeticd may answer with a code
    // this laptop has never heard of, and that must still read as an error.
    code: z.string().min(1),
    message: z.string(),
  }),
});
export type FilesErrorBody = z.infer<typeof FilesErrorBody>;

// --- Plugin socket ------------------------------------------------------------

/** `GET /hello`: the plugin checks its own version against `plugin_min`. */
export const FilesHello = z.object({
  hermeticd_version: z.string().min(1),
  protocol: z.number().int().positive(),
  plugin_min: z.string().min(1).optional(),
});
export type FilesHello = z.infer<typeof FilesHello>;

/**
 * `POST /requests`: what the plugin forwards from the model's `request_file`
 * call. Not `.strict()`: the model adds fields of its own and they are dropped,
 * not refused. Every string is capped. `wait_s` above `FILES_TTL.waitMax` is
 * clamped rather than refused, for the same reason; `max_bytes` is clamped to
 * the fleet cap by hermeticd, which knows it.
 */
export const OpenFileRequestBody = z.object({
  purpose: z.string().trim().min(1).max(2000),
  name_hint: z.string().min(1).max(255).optional(),
  accept: z.array(z.string().min(1).max(128)).max(32).optional(),
  max_bytes: z.number().int().positive().optional(),
  sensitivity: FileSensitivity.optional(),
  durable: z.boolean().optional(),
  wait_s: z
    .number()
    .int()
    .nonnegative()
    .transform((s) => Math.min(s, FILES_TTL.waitMax))
    .optional(),
  session_id: OpaqueId.optional(),
  task_id: OpaqueId.optional(),
});
export type OpenFileRequestBody = z.infer<typeof OpenFileRequestBody>;

/**
 * `POST /requests` with `kind: "secret_text"`: what the plugin forwards from
 * `request_secret`. Key names only, never values. Like `OpenFileRequestBody`,
 * extra model fields are dropped and `wait_s` is clamped; unlike it, a bad key
 * name is refused, because the card and the box check pasted keys against
 * these names (D10).
 */
export const OpenSecretRequestBody = z.object({
  kind: z.literal("secret_text"),
  purpose: z.string().trim().min(1).max(2000),
  keys: z.array(SecretTextKey).min(1).max(SECRET_TEXT_MAX_KEYS),
  optional_keys: z.array(SecretTextKey).max(SECRET_TEXT_MAX_KEYS).optional(),
  /** File stem; default derived from `keys[0]` by hermeticd. Slugged like a slot. */
  slug: z.string().min(1).max(64).optional(),
  durable: z.boolean().optional(),
  input: SecretTextInputMode.optional(),
  wait_s: z
    .number()
    .int()
    .nonnegative()
    .transform((s) => Math.min(s, FILES_TTL.waitMax))
    .optional(),
  session_id: OpaqueId.optional(),
  task_id: OpaqueId.optional(),
});
export type OpenSecretRequestBody = z.infer<typeof OpenSecretRequestBody>;

/**
 * What `request_file`/`await_file` hand back to the model. `pending` means the
 * wait ran out with the slot still open; `deliver_with` then lists ways an
 * operator without a card can fulfil it (`hermetic files put …`, `curl -T …`).
 * `interrupted` is the plugin's own answer when the turn was cancelled.
 */
export const FileWaitResult = z.object({
  status: z.enum(["open", "fulfilled", "pending", "declined", "expired", "interrupted", "consumed"]),
  request_id: FileRequestId,
  path: z.string().min(1).optional(),
  sha256: Sha256.optional(),
  bytes: Bytes.optional(),
  by: z.string().min(1).optional(),
  class: FileClass.optional(),
  /** `secret_text` only: key names stored, the format read, and the shell line that loads them. */
  keys: z.array(z.string().min(1).max(128)).optional(),
  format: SecretTextFormatName.optional(),
  load: z.string().min(1).optional(),
  deliver_with: z.array(z.string()),
  expires_at: Iso,
});
export type FileWaitResult = z.infer<typeof FileWaitResult>;

/** `POST /outbox`: `share_file`'s arguments. Extra model fields are dropped. */
export const ShareFileBody = z.object({
  path: z.string().min(1).max(4096),
  note: z.string().max(2000).optional(),
  name: z.string().min(1).max(255).optional(),
});
export type ShareFileBody = z.infer<typeof ShareFileBody>;

export const ShareFileResult = z.object({
  share_id: ShareId,
  name: FileName,
  bytes: Bytes,
  mime: z.string().min(1),
  sha256: Sha256,
});
export type ShareFileResult = z.infer<typeof ShareFileResult>;
