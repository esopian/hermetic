import type {
  FileRequest,
  FilesCommitResult,
  FilesFulfilResult,
  FilesListResult,
  FilesSecretBody,
  FilesStageResult,
} from "../schema/index.ts";
import type { SecretTextAs } from "../shared/files.ts";

/**
 * The laptop half of hermeticd's files service (`/files` on port 7434): the
 * staging upload, the commit a chat turn makes, the bytes of an entry and its
 * deletion. The real implementation is `aws/files-http.ts`; fixture mode keeps
 * an in-memory store (`backend/fixture/memory-files.ts`).
 *
 * Every refusal is a `HermeticError` carrying the box's own code
 * (`FILES_ERROR_CODES`), with a message that never repeats the file's name:
 * names may be sensitive, and these messages reach logs.
 */
export interface FilesApi {
  /**
   * `PUT /files/stage/:name`. `size` is sent as `Content-Length` and `sha256`
   * as `Content-Digest` when known; the box refuses a body that does not match either.
   * `onProgress` is called with the bytes sent so far.
   */
  stage(
    name: string,
    upload: FilesStageUpload,
    opts: FilesCallOptions & FilesProgress,
  ): Promise<FilesStageResult>;
  /** `POST /files/:id/commit`: move a staged entry into the inbox for a turn. */
  commit(
    name: string,
    id: string,
    body: { session_id?: string },
    opts: FilesCallOptions,
  ): Promise<FilesCommitResult>;
  /**
   * `GET /files/:id/content`, read whole. Refused `FILE_TOO_LARGE` before the
   * body is read when the entry is over `maxBytes`, and `FILE_DIGEST_MISMATCH`
   * when the body ends short or does not hash to its `Content-Digest`. With
   * `imagesOnly`, an entry that is not an image is refused `FILE_TYPE_REJECTED`
   * from its type alone, before the body is read.
   */
  content(
    name: string,
    id: string,
    opts: FilesCallOptions & FilesContentOptions,
  ): Promise<FilesContent>;
  /** `DELETE /files/:id`. */
  remove(name: string, id: string, opts: FilesCallOptions): Promise<void>;
  /** `GET /files/requests/:id`: one request slot, as the box holds it. */
  request(name: string, id: string, opts: FilesCallOptions): Promise<FileRequest>;
  /** `GET /files`: every entry and request slot on the box, metadata only. */
  list(name: string, opts: FilesCallOptions): Promise<FilesListResult>;
  /**
   * `PUT /files/requests/:id`: answer a request with bytes. The name travels in
   * `FILES_NAME_HEADER`; the box decides where the bytes land (inbox, or the
   * tmpfs drop for a secret) from its own copy of the slot.
   */
  fulfil(
    name: string,
    id: string,
    upload: FilesFulfilUpload,
    opts: FilesCallOptions & FilesProgress & FilesFulfilOptions,
  ): Promise<FilesFulfilResult>;
  /**
   * `POST /files/requests/:id/secret`: the laptop already wrote the bytes to the
   * agent's SSM slot; the box reads them with its instance role.
   */
  secret(
    name: string,
    id: string,
    body: FilesSecretBody,
    opts: FilesCallOptions,
  ): Promise<FilesFulfilResult>;
  /** `POST /files/requests/:id/decline`. */
  decline(
    name: string,
    id: string,
    reason: string | undefined,
    opts: FilesCallOptions,
  ): Promise<FileRequest>;
}

/** The bytes of a request fulfil. Like `FilesStageUpload`, without the stage-only fields. */
export interface FilesFulfilUpload {
  /** Already through `sanitizeFileName`. */
  fileName: string;
  size: number;
  body: AsyncIterable<Uint8Array> | Uint8Array;
  /**
   * Lowercase hex SHA-256 of the whole body. Absent for a body that is being
   * streamed through from the page: the digest travels ahead of the bytes, so
   * it cannot be known, and the box hashes what it receives and reports it.
   */
  sha256?: string;
}

export interface FilesFulfilOptions {
  /** The operator confirmed a key-looking file is not a secret (D6). */
  notSecret?: boolean;
  /** A text secret's "Treat as" override; absent means `auto`. */
  secretAs?: SecretTextAs;
}

export interface FilesCallOptions {
  signal?: AbortSignal;
}

export interface FilesContentOptions {
  maxBytes: number;
  imagesOnly?: boolean;
}

export interface FilesProgress {
  onProgress?: (sentBytes: number) => void;
}

export interface FilesStageUpload {
  /** Already through `sanitizeFileName`. */
  fileName: string;
  size: number;
  body: AsyncIterable<Uint8Array> | Uint8Array;
  /** Lowercase hex SHA-256 of the whole body; absent for a streamed-through body (see `FilesFulfilUpload`). */
  sha256?: string;
  sessionId?: string;
  notSecret?: boolean;
}

export interface FilesContent {
  bytes: Uint8Array;
  /** The box's sniffed type, from `Content-Type`. */
  mime: string;
  sha256: string;
}
