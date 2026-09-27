/**
 * What a refusal looks like on the way back.
 *
 * Its own module because both sides of the transport seam need it: the RPC
 * transport throws these (`transport-rpc.ts`), and `client.ts` publishes them
 * to the rest of the UI. A shared leaf rather than a re-export chain, so the
 * transport never has to import the module that imports it.
 */

export class ApiError extends Error {
  readonly code: string;
  /**
   * The op the server was already running when it refused this request. Only
   * `POST /api/init` sends one today (`InitInFlightError` in
   * `server/init-op.ts` answers 409 with `op_id` beside the error), and it is
   * the difference between "init failed" and "init is already happening, here
   * it is" — the wizard follows it instead of showing a dead end.
   */
  readonly opId: string | null;
  /** Whatever else rode along on the error body, e.g. a zValidator issue list. */
  readonly details: unknown;
  constructor(code: string, message: string, extra: { opId?: string | null; details?: unknown } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.opId = extra.opId ?? null;
    this.details = extra.details ?? null;
  }
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
  /** Sibling of `error`, not inside it — see `init-op.ts`'s `InitInFlightError`. */
  op_id?: string | null;
}

/**
 * Narrowing by shape, not by status.
 *
 * A refusal is a body with an `error` key, whoever built it: a handler's own
 * `HermeticError`, the schema validator's issue list, or the bridge reporting
 * that the call never reached one. Exported for direct testing.
 */
export function isError(body: unknown): body is ErrorBody {
  return typeof body === "object" && body !== null && "error" in body;
}

/** One place that turns an error body into the thrown `ApiError`, sibling fields and all. */
export function apiErrorOf(body: ErrorBody): ApiError {
  return new ApiError(body.error.code, body.error.message, {
    opId: typeof body.op_id === "string" ? body.op_id : null,
    details: body.error.details ?? null,
  });
}
