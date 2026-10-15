/**
 * Text secrets (`request_secret`, plan §06b): the operator's text, parsed here
 * authoritatively and stored in one canonical `KEY="…"` form the agent sources
 * (`secretTextLoad`).
 *
 * The card and core run the same parser first (`parseSecretEnv`,
 * `@hermetic/core/shared`), but only this parse decides. It runs against the
 * slot's own key names — the box's copy, not anything the client says — so a
 * key the request did not name is refused, not dropped (D10), and nothing is
 * written. A refusal leaves the slot `open` with the parser's reason, which
 * names keys and lines, never a value.
 *
 * Two ways in:
 *  - **just this once** — `PUT /files/requests/:id` with the text as the body
 *    and the operator's "Treat as" in `FILES_SECRET_AS_HEADER`. The canonical
 *    bytes go to the request's tmpfs drop as `<slug>.env`, exactly like an
 *    ephemeral file secret, and `consume` or the drop TTL removes them.
 *  - **durable** — the laptop wrote the canonical text to `env-<slug>`, and
 *    `POST /files/requests/:id/secret` asks the box to read it. The slot must
 *    be this request's own, and its bytes must re-parse, as `.env` lines
 *    against this request's keys, to exactly themselves (`durableTextCheck`).
 *
 * The body is held in memory only for the parse (64 KiB cap) and zeroed after.
 * The parsed values and the canonical string are JS strings, which cannot be
 * zeroed; they go out of scope at the end of the request.
 */
import { createHash } from "node:crypto";
import {
  FileEntry,
  type FileRequest,
  type FilesFulfilResult,
  type SecretTextAs,
  type SecretTextFormat,
} from "@hermetic/core/schema";
import {
  FILES_LIMITS,
  FILES_SECRET_AS_HEADER,
  FILES_TTL,
  SECRET_TEXT_AS,
  type SecretEnvIssue,
  newFileId,
  parseSecretEnv,
  secretTextSlug,
} from "@hermetic/core/shared";
import { type Caller, type FilesCtx, auditFiles, isoAfter, nowIso } from "./context.ts";
import { FilesError } from "./errors.ts";
import { writeDropSecret } from "./fs-ops.ts";
import { markFulfilled } from "./requests.ts";
import type { Claim } from "./store.ts";
import { MeteredBody, uploadHeaders } from "./upload.ts";

/** The status a text the box will not store is refused with: well-formed HTTP, unacceptable content. */
const UNPROCESSABLE = 422;

/** The longest refusal message a slot records; the parser's issues are joined up to it. */
const REASON_MAX = 480;

/** The slot's file stem: its recorded slug, or the one its keys derive (an index from before slugs). */
export function secretTextStem(slot: FileRequest): string {
  return slot.slug ?? secretTextSlug(slot.keys ?? []);
}

/** `<slug>.env`: the one name a text secret has, ephemeral or durable. */
export function secretTextFileName(slot: FileRequest): string {
  return `${secretTextStem(slot)}.env`;
}

function specFor(slot: FileRequest): { keys: string[]; optional_keys: string[]; maxBytes: number } {
  return {
    keys: slot.keys ?? [],
    optional_keys: slot.optional_keys ?? [],
    maxBytes: FILES_LIMITS.secretTextBytes,
  };
}

/** The parser's errors as one refusal. Its messages name keys and lines, never a value. */
function refusal(errors: readonly SecretEnvIssue[]): FilesError {
  const text = errors.map((e) => e.message).join(" ");
  const message = text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
  return new FilesError("VALIDATION", message || "the text was refused", UNPROCESSABLE);
}

/** `FILES_SECRET_AS_HEADER`: absent is `auto`; anything outside `SECRET_TEXT_AS` is 400. */
function secretAs(request: Request): SecretTextAs {
  const header = request.headers.get(FILES_SECRET_AS_HEADER);
  if (header === null) return "auto";
  const as = header.trim().toLowerCase();
  if (!(SECRET_TEXT_AS as readonly string[]).includes(as)) {
    throw new FilesError(
      "VALIDATION",
      `${FILES_SECRET_AS_HEADER} must be one of ${SECRET_TEXT_AS.join(", ")}`,
    );
  }
  return as as SecretTextAs;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `PUT /files/requests/:id` on a `secret_text` slot ("just this once"). The
 * caller holds the slot's claim and turns a throw into a rejection.
 */
export async function receiveSecretText(
  ctx: FilesCtx,
  request: Request,
  slot: FileRequest,
  claim: Claim,
  caller: Caller,
): Promise<FilesFulfilResult> {
  const as = secretAs(request);
  const headers = uploadHeaders(request, Math.min(slot.max_bytes, FILES_LIMITS.secretTextBytes));
  const body = new MeteredBody(request.body, headers.declared, {
    ...(ctx.uploadIdleMs !== undefined ? { idleMs: ctx.uploadIdleMs } : {}),
    signal: claim.signal,
  });
  let text: Uint8Array;
  try {
    text = await body.collect();
    body.finish(headers.declared, headers.digest);
  } catch (e) {
    await body.discard();
    throw e;
  }
  let canonical: Uint8Array;
  let keys: string[];
  let format: SecretTextFormat;
  try {
    const parsed = parseSecretEnv(text, specFor(slot), as);
    if (!parsed.ok) throw refusal(parsed.errors);
    canonical = new TextEncoder().encode(parsed.canonical);
    keys = parsed.entries.map((e) => e.key);
    format = parsed.format;
  } finally {
    text.fill(0);
  }

  const name = secretTextFileName(slot);
  let path: string;
  let sha256: string;
  const bytes = canonical.byteLength;
  try {
    sha256 = sha256Hex(canonical);
    path = await writeDropSecret(ctx.host, slot.request_id, name, canonical);
  } finally {
    canonical.fill(0);
  }
  const stored = FileEntry.parse({
    id: newFileId(),
    dir: "drop",
    class: "secret",
    name,
    bytes,
    mime: "text/plain",
    sha256,
    created_at: nowIso(ctx.host),
    expires_at: isoAfter(ctx.host, FILES_TTL.drop),
    path,
    from: { kind: "operator", login: caller.login, node: caller.node },
    request_id: slot.request_id,
  });
  try {
    await ctx.store.mutate((index) => {
      markFulfilled(ctx, index, slot.request_id, claim, {
        path,
        sha256,
        bytes,
        by: caller.login,
        class: "secret",
        keys,
        format,
      });
      index.entries.push(stored);
    });
  } catch (e) {
    // Reclaimed while it landed, or the index would not save: nothing points at it.
    await ctx.host.remove(path.slice(0, path.lastIndexOf("/"))).catch(() => undefined);
    throw e;
  }
  auditFiles(ctx, "fulfil", { id: slot.request_id, bytes, login: caller.login, class: "secret" });
  return { request_id: slot.request_id, path, sha256, bytes, class: "secret", keys, format };
}

/**
 * The check a durable text secret's bytes must pass before they are written:
 * UTF-8 that parses, as `.env` lines against `slot`'s keys, to exactly
 * itself. So the slot holds only keys this request named, every required one,
 * and nothing but the canonical form. `stored` receives the key names.
 */
export function durableTextCheck(
  slot: FileRequest,
  stored: { keys: string[] },
): (content: Uint8Array) => void {
  return (content) => {
    const parsed = parseSecretEnv(content, specFor(slot), "dotenv");
    if (!parsed.ok) throw refusal(parsed.errors);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      throw new FilesError("VALIDATION", "the stored secret is not valid UTF-8", UNPROCESSABLE);
    }
    if (parsed.canonical !== text) {
      throw new FilesError(
        "VALIDATION",
        'the stored secret is not in canonical KEY="value" form for this request',
        UNPROCESSABLE,
      );
    }
    stored.keys = parsed.entries.map((e) => e.key);
  };
}
