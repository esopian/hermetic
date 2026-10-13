/**
 * The one error type the client layer throws.
 *
 * `code`, `message` and `details` are the bridge's error body (the desktop
 * `RpcErrorBody` shape); `status` is the HTTP status, or `0` for a failure
 * that never got an answer (`NETWORK`, `TIMEOUT`, `DISCONNECTED`).
 */
export class BridgeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message: string, status = 0, details?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Codes the client raises itself, never sent by the bridge. */
export const CLIENT_ERROR_CODES = {
  NETWORK: "NETWORK",
  TIMEOUT: "TIMEOUT",
  DISCONNECTED: "DISCONNECTED",
  NOT_PAIRED: "NOT_PAIRED",
  NO_TARGET: "NO_TARGET",
  BAD_RESPONSE: "BAD_RESPONSE",
  /**
   * The bridge serves another fleet than this phone expects: the one a pairing
   * link named, or the one a stored pairing was made on (the laptop switched
   * fleets since). The bridge sends the same code itself (HTTP 403, close 4403).
   */
  WRONG_FLEET: "WRONG_FLEET",
} as const;

export function isBridgeError(error: unknown): error is BridgeError {
  return error instanceof BridgeError;
}

/** Coerce anything thrown into a `BridgeError`, keeping one that already is. */
export function toBridgeError(
  error: unknown,
  fallbackCode: string = CLIENT_ERROR_CODES.NETWORK,
): BridgeError {
  if (error instanceof BridgeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new BridgeError(fallbackCode, message);
}

/** Read an error body defensively: anything without a string `code` is not one. */
export function errorBody(value: unknown): { code: string; message: string; details?: unknown } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== "string") return null;
  return {
    code: v.code,
    message: typeof v.message === "string" ? v.message : v.code,
    ...(v.details !== undefined ? { details: v.details } : {}),
  };
}
