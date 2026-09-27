/**
 * Whatever was thrown, as the code and sentence a caller is allowed to see.
 *
 * §3.2 rule 1: core throws `HermeticError`s carrying a `code`, and the head
 * decides what a caller is told. There used to be an HTTP status table here as
 * well — the other half of the rule, alongside the CLI's exit-status table —
 * and it went with the Hono head: the desktop bridge rejects a
 * request with the code itself, so a number that stood in for the code has
 * nothing left to do.
 */
import { isHermeticError } from "@hermetic/core";

export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/**
 * What a caller is told when nothing classified the failure. Core's own
 * messages are written to be read by an operator (§3.2 rule 1) and are
 * forwarded verbatim; an *unclassified* throw is something else — a TypeError
 * from a bug, an AWS SDK internal naming an ARN, a message built from whatever
 * the caller sent. None of that is the page's business, and the operator gets
 * the real thing anyway: the head logs message and stack to `<home>/app.log`
 * (see `log.ts` and the `internal` field below).
 */
export const INTERNAL_MESSAGE = "internal error — see the app log";

export interface Failure {
  body: ErrorBody;
  /**
   * The real message, set only when the body carries `INTERNAL_MESSAGE`
   * instead of it. For the log, never for the caller.
   */
  internal?: string;
}

export function classifyFailure(e: unknown): Failure {
  if (isHermeticError(e)) {
    return {
      body: {
        error: {
          code: e.code,
          message: e.message,
          ...(e.details ? { details: e.details } : {}),
        },
      },
    };
  }
  return {
    body: { error: { code: "INTERNAL", message: INTERNAL_MESSAGE } },
    internal: e instanceof Error ? e.message : String(e),
  };
}
