import { HermeticError } from "../errors.ts";
import type { ErrorCode } from "../shared/error-codes.ts";

/**
 * What an operator reads for each files refusal, shared by the hermeticd client
 * (`aws/files-http.ts`), the fixture store and the stage module so that one
 * code reads the same whichever of them raised it.
 *
 * None of these names the file. A file's name may be as sensitive as its
 * contents ("termination-letter-jsmith.pdf"), and a refusal's message is what
 * the app log and the `runs` table record.
 */
export const FILES_READABLE: Partial<Record<ErrorCode, string>> = {
  FILE_TOO_LARGE: "the file is over the box's size limit",
  FILE_DIGEST_MISMATCH: "the bytes the box received do not match what was sent; try again",
  FILE_REQUEST_EXPIRED: "the file request has expired; the agent has to ask again",
  DISK_FULL: "the box is low on disk space and refused the file",
  FILE_LOOKS_SECRET: "the file looks like a private key; send it as a secret, or confirm it is not one",
  FILE_NOT_FOUND: "that file is no longer on the box",
  FILE_NAME_INVALID: "the box does not accept that file name",
  FILE_TYPE_REJECTED: "the box does not accept that type of file here",
  FILE_SECRET_FORBIDDEN: "secret files never leave the box",
  FILE_REQUEST_FULFILLED: "the file request was already fulfilled",
  FILE_REQUEST_CLOSED: "the file request is closed; the agent has moved on",
};

/** A files refusal for one agent, worded from `FILES_READABLE` (or `fallback`). */
export function filesRefusal(
  code: ErrorCode,
  agent: string,
  fallback?: string,
  details: Record<string, unknown> = {},
): HermeticError {
  const readable = FILES_READABLE[code] ?? fallback ?? code;
  return new HermeticError(code, `${agent}: ${readable}`, { name: agent, ...details });
}
