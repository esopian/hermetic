/**
 * How the files service refuses. A files route answers with a JSON
 * `FilesErrorBody` and the status `filesHttpStatus` names for its code — not
 * the NDJSON error frame the log routes use, because a client uploading a file
 * reads one JSON answer, not a stream.
 */
import type { FilesErrorBody } from "@hermetic/core/schema";
import {
  FILES_DROP_DIR,
  FILES_INBOX_DIR,
  FILES_OUTBOX_DIR,
  FILES_SECRET_DIR,
  filesHttpStatus,
} from "@hermetic/core/shared";

/**
 * A refusal raised anywhere under a files route and turned into a response at
 * the edge. `status` overrides the code's own status where HTTP has a more
 * precise word for it (411 for a missing `Content-Length`, 501 for a route the
 * socket names but does not serve yet).
 */
export class FilesError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "FilesError";
    this.code = code;
    this.status = status ?? filesHttpStatus(code);
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A path under any files root, from the root to the next quote, backtick or
 * line end. A file name may hold spaces, so a path is not cut at whitespace;
 * when the path was not quoted, the rest of the line goes with it — scrubbing
 * too much is the safe direction.
 */
const FILES_PATH_RE = new RegExp(
  `(?:${[FILES_INBOX_DIR, FILES_OUTBOX_DIR, FILES_DROP_DIR, FILES_SECRET_DIR].map(escapeRe).join("|")})(?:/[^'"\`\n]*)?`,
  "g",
);

/**
 * `message` with every path under the files roots replaced by `<files-path>`.
 * A path there carries a file name, or a request id beside one, and a name can
 * itself be the secret (`acme-prod-root.pem`); an error from `mv`, `chown` or
 * the filesystem quotes the path verbatim. Everything the files service logs
 * about a failure goes through this, and so does a 5xx body.
 */
export function scrubPaths(message: string): string {
  return message.replace(FILES_PATH_RE, "<files-path>");
}

/** An unknown error's message, scrubbed, for a log line. */
export function errorText(e: unknown): string {
  return scrubPaths(e instanceof Error ? e.message : String(e));
}

const JSON_HEADERS = { "cache-control": "no-store" };

/** The response for a refusal: `{ error: { code, message } }` at its status. A 5xx message is scrubbed. */
export function filesErrorResponse(e: FilesError): Response {
  const message = e.status >= 500 ? scrubPaths(e.message) : e.message;
  const body: FilesErrorBody = { error: { code: e.code, message } };
  return Response.json(body, { status: e.status, headers: JSON_HEADERS });
}

/** A JSON answer. `no-store`: a listing or a slot is stale the moment it is sent. */
export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

/**
 * Anything thrown under a files route, as a response. A `FilesError` says what
 * it is; anything else is an `INTERNAL` whose message is logged by the caller
 * and *not* echoed, since an unexpected error may carry a path or a name.
 */
export function toFilesResponse(e: unknown, log: (message: string) => void, route: string): Response {
  if (e instanceof FilesError) return filesErrorResponse(e);
  log(`files ${route} failed: ${errorText(e)}`);
  return filesErrorResponse(
    new FilesError("INTERNAL", "the files service failed; see the box's journal"),
  );
}
