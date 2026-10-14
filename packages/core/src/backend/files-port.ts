import type { FilesCommitResult, FilesStageResult } from "../schema/index.ts";

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
   * as `Content-Digest`; the box refuses a body that does not match either.
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
  /** Lowercase hex SHA-256 of the whole body. */
  sha256: string;
  sessionId?: string;
  notSecret?: boolean;
}

export interface FilesContent {
  bytes: Uint8Array;
  /** The box's sniffed type, from `Content-Type`. */
  mime: string;
  sha256: string;
}
