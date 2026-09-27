/**
 * Commander parses flags as strings; core parses them with Zod. This is the
 * seam (§3.4): every command hands its parsed options to the *same* schema core
 * uses, and a failure is exit 2 with the issues on stderr — never a call into
 * core with a shape the HTTP route could not have produced.
 */
import type { ZodType } from "zod";

export class ValidationFailure extends Error {
  readonly issues: Array<{ path: string; message: string }>;

  constructor(issues: Array<{ path: string; message: string }>) {
    super("invalid arguments");
    this.name = "ValidationFailure";
    this.issues = issues;
  }
}

export function validate<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationFailure(
    result.error.issues.map((i) => ({
      path: i.path.map(String).join(".") || "(root)",
      message: i.message,
    })),
  );
}

/** Drops keys Commander left undefined so `.optional()` fields stay optional. */
export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/** Commander hands numbers over as strings. */
export function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}
