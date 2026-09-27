/**
 * Request validation. Core's Zod schemas are the only shapes accepted (§3.3),
 * so a handler runs its declared schema over whatever the transport handed it
 * with `parseInput` before core sees any of it.
 */
import type { ZodType } from "zod";
import { AgentName, SecretsTargetName } from "@hermetic/core";
import type { ErrorCode } from "@hermetic/core";

export interface Issue {
  path: string;
  message: string;
}

/**
 * Which *schema* a failing field was built from, and the code that field's own
 * failure deserves. Identity, not spelling: this used to read "any issue whose
 * path is literally `name` is a `NAME_INVALID`", which is true of every schema
 * on the surface today and would quietly stop being true the first time a
 * request grew a profile name, a stack name or a tag name. A field is an agent
 * name because core says it is one.
 *
 * Everything else is `VALIDATION` — the head-local code for "the request did
 * not match the schema", which core's `ErrorCode` enum has no member for.
 */
const FIELD_CODES: ReadonlyArray<readonly [ZodType, ErrorCode]> = [
  [AgentName, "NAME_INVALID"],
  // `_fleet` or an agent name (§8.3); a value that is neither is still a name
  // complaint, and the operator gets the same sentence for it.
  [SecretsTargetName, "NAME_INVALID"],
];

/**
 * Peels `.optional()`/`.default()`/`.nullable()` off a field so the wrapper a
 * schema happens to use does not hide which schema is underneath. Three is
 * further than any request schema nests.
 */
function unwrap(schema: ZodType): ZodType {
  let inner = schema;
  for (let i = 0; i < 3; i += 1) {
    const wrapper = inner as { unwrap?: () => ZodType };
    if (typeof wrapper.unwrap !== "function") return inner;
    inner = wrapper.unwrap();
  }
  return inner;
}

/**
 * The top-level fields of a request schema, seeing through the intersection a
 * fleet-scoped mutation is wrapped in (`withTarget` in `target.ts`).
 *
 * An intersection has no `shape` of its own, so without this every guarded
 * mutation's field lookup fell through to `VALIDATION` — an invalid agent name
 * sent to `agents.create` reported "the request did not match the schema"
 * rather than the sentence about agent names. The HTTP head hid that by handing
 * its validator the *unwrapped* schema; there is no second schema to hand
 * anything here, so the wrapper is peeled instead.
 */
function shapeOf(schema: ZodType | undefined): Record<string, ZodType> | undefined {
  if (schema === undefined) return undefined;
  const direct = (schema as { shape?: Record<string, ZodType> }).shape;
  if (direct !== undefined) return direct;
  const def = (schema as { def?: { type?: string; left?: ZodType; right?: ZodType } }).def;
  if (def?.type !== "intersection") return undefined;
  const left = shapeOf(def.left);
  const right = shapeOf(def.right);
  if (left === undefined && right === undefined) return undefined;
  // The envelope's own fields are in here too, which is harmless: `FIELD_CODES`
  // only matches the schemas it names.
  return { ...left, ...right };
}

/**
 * The code for a failure of `schema`. Only top-level fields are looked up: a
 * nested path is a shape complaint, not a named-value complaint.
 */
export function codeForIssues(issues: Issue[], schema?: ZodType): ErrorCode {
  const shape = shapeOf(schema);
  // No shape means no top-level fields to look up: no schema was passed at
  // all, or the request schema is rooted in a union rather than an object.
  // Those fall back to
  // `VALIDATION`, which is the honest answer — the head cannot say which arm of
  // a union the client meant to be in.
  if (shape === undefined) return "VALIDATION";
  for (const issue of issues) {
    const field = shape[issue.path];
    if (field === undefined) continue;
    const resolved = unwrap(field);
    for (const [candidate, code] of FIELD_CODES) if (resolved === candidate) return code;
  }
  return "VALIDATION";
}

/**
 * A request that did not match the schema core would have applied anyway. The
 * `code` is decided by `codeForIssues`, so the body says the same thing whether
 * the shape was caught here or one layer down inside core.
 */
export class RequestValidationError extends Error {
  readonly issues: Issue[];
  readonly code: ErrorCode;

  constructor(issues: Issue[], schema?: ZodType) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join("; ") || "invalid request");
    this.name = "RequestValidationError";
    this.issues = issues;
    this.code = codeForIssues(issues, schema);
  }
}

/** As much of a Zod failure as an `Issue` is built from. */
interface ZodFailure {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}

function toIssues(error: ZodFailure | undefined): Issue[] {
  return [...(error?.issues ?? [])].map((i) => ({
    path: i.path.map(String).join(".") || "(root)",
    message: i.message,
  }));
}

export function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new RequestValidationError(toIssues(result.error), schema);
}

export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
