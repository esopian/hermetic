import type { ErrorCode } from "./shared/error-codes.ts";

/**
 * The only error type core throws. Core never talks to a human (§3.2 rule 1):
 * the CLI maps `code` to an exit status, the server maps it to an HTTP status.
 */
export class HermeticError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "HermeticError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isHermeticError(e: unknown): e is HermeticError {
  return e instanceof HermeticError;
}

/** Narrow an unknown throw to a HermeticError with a specific code. */
export function hasCode(e: unknown, code: ErrorCode): boolean {
  return isHermeticError(e) && e.code === code;
}

/**
 * §4.2: the `agents` table goes with the stack, and `_fleet` is a row in it. A
 * teardown that failed partway — after `DeleteStack` took the tables, before the
 * SSM or local phases ran — is retried by running `teardown` again, and the
 * retry's first acts are to lock and to read a table that no longer exists.
 * `ResourceNotFoundException` is wrapped into `NOT_FOUND` by `aws/dynamo.ts`;
 * either spelling means the same thing, and it means "there is nothing there",
 * not "stop".
 *
 * Here rather than in `hermetic.ts` because both `hermetic.ts` and `teardown.ts`
 * ask it, and `teardown.ts` cannot import a value from the module that imports
 * it.
 */
export function isMissingTable(e: unknown): boolean {
  if (!isHermeticError(e)) return false;
  return e.code === "NOT_FOUND" || e.details?.["aws_error"] === "ResourceNotFoundException";
}
