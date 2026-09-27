import { z } from "zod";
import { ERROR_CODES } from "../shared/error-codes.ts";

/**
 * Every failure core can produce carries one of these codes. The CLI maps codes
 * to exit statuses; the server maps them to HTTP statuses. Adding a failure mode
 * means adding a code here first.
 */
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export { ERROR_CODES } from "../shared/error-codes.ts";
