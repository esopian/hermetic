/**
 * The phone's files client: stage an attachment on one box and commit it into
 * a chat turn, and answer the box's file and secret requests, the way the
 * desktop does (`createFilesStage`, `createFilesPut` and `HermeticdFiles` in
 * core), over the channel the phone already uses —
 * hermeticd on the box's tailnet port 7434, whois-gated, behind the same
 * tunnel gate as `GET /fleet` (`hermeticd.ts`). No AWS credential, no secret,
 * no route of its own: `PUT /files/stage/:name` and `POST /files/:id/commit`
 * are hermeticd's, and `GET /healthz` says whether the box serves them.
 *
 * A send is two steps, as on the desktop. `stage` uploads the bytes while the
 * operator is still writing; `attachmentsFor(staged, files)` is the
 * `SendOptions.attachments` the Hermes adapter takes, and the adapter calls
 * `commit` once the turn's session is known (`hermes-chat-attach.ts`).
 *
 * Before a byte is sent, `stage` makes the checks the box would make and the
 * desktop makes first (`preflight` in core's `files/stage.ts`): the name rules,
 * the image or file cap for the sniffed type, and the private-key refusal. A
 * refusal from the box comes back as a `HermeticError` carrying the box's code
 * (`FILE_TOO_LARGE`, `FILE_DIGEST_MISMATCH`, `FORBIDDEN`, …), or the code its
 * status implies when the body names none. No message names the file: a
 * file's name can be as sensitive as its contents.
 *
 * A request the agent opened (`request_file`, `request_secret`) is read with
 * `request`/`requests`, answered with `fulfil` (a file) or `secret` (text),
 * and refused with `decline`: `GET`, `PUT` and `POST /files/requests/…`, the
 * same routes and headers the desktop's client sends. The phone holds no AWS
 * credential, so it has only the box's own lane, "just this once": a secret
 * goes into the box's tmpfs drop for the request, never to an SSM slot. A text
 * secret is parsed here first with the parser the box runs (`parseSecretEnv`),
 * so a paste the box would refuse is refused before a byte leaves; the
 * operator's own bytes then go to the box with the "Treat as" header, and the
 * buffer is zeroed once sent. No message, error or log names a value.
 *
 * Pure: `fetch` is injected, nothing imports React Native.
 */
import { HermeticError, type ErrorCode, type SendOptions } from "@hermetic/core/chat-client";
import {
  FileRequest,
  FilesCommitResult,
  FilesFulfilResult,
  FilesStageResult,
  RpcHealth,
} from "@hermetic/core/schema";
import {
  acceptMatches,
  CONTENT_DIGEST_HEADER,
  createSha256,
  FILES_CAPABILITY,
  FILES_ERROR_CODES,
  FILES_LIMITS,
  FILES_NAME_HEADER,
  FILES_NOT_SECRET_HEADER,
  FILES_ROUTES,
  FILES_SECRET_AS_HEADER,
  FILES_SESSION_HEADER,
  formatContentDigest,
  isImageMime,
  looksLikeKeyMaterial,
  parseContentDigest,
  parseSecretEnv,
  RPC_PATHS,
  requestFileName,
  type SecretTextAs,
  sanitizeFileName,
  secretTextSlug,
  sha256Hex,
  sniffMime,
} from "@hermetic/core/shared";
import { callHermeticd, callHermeticdBody, type FetchLike } from "./hermeticd.ts";

/** What the Hermes adapter takes as a turn's attachments (`SendOptions.attachments`). */
export type TurnAttachments = NonNullable<SendOptions["attachments"]>;

/**
 * How long a commit may take to answer. A commit moves a file the box already
 * holds, so it is quick; the bound is the desktop's (`FILES_HEADERS_TIMEOUT_MS`).
 */
export const FILES_COMMIT_TIMEOUT_MS = 30_000;

/**
 * How long a stage may take: a minute, plus the upload at 128 KB/s (a slow
 * cellular link). A 256 MiB file gets over half an hour; the caller's signal
 * is the way to stop one sooner.
 */
export function stageTimeoutMs(bytes: number): number {
  return 60_000 + Math.ceil(bytes / 128);
}

export interface PhoneFilesStageInput {
  /** The file's name as the picker reported it; sanitized here, as the box does. */
  name: string;
  bytes: Uint8Array;
  /** The chat session the upload is for, when the conversation already has one. */
  session_id?: string | undefined;
  /**
   * The operator confirmed that a file which looks like a private key is not
   * one. Without it such a file is refused with `FILE_LOOKS_SECRET`.
   */
  not_secret?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface PhoneFilesCallOptions {
  signal?: AbortSignal | undefined;
}

export interface PhoneFilesFulfilInput {
  /** The file's name as the picker reported it; the box files it as `requestFileName` says. */
  name: string;
  bytes: Uint8Array;
  /**
   * The operator confirmed that a file which looks like a private key is not
   * one. Without it, the box keeps such a file as a secret in its tmpfs drop
   * (D6), never in the inbox.
   */
  not_secret?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface PhoneFilesContentOptions {
  signal?: AbortSignal | undefined;
  /**
   * For a preview: a non-image type is refused from the headers
   * (`FILE_TYPE_REJECTED`), and the image cap applies.
   */
  image?: boolean | undefined;
  /**
   * The most bytes to accept, under the cap for the kind (image or file); a
   * larger file is `FILE_TOO_LARGE`.
   */
  maxBytes?: number | undefined;
}

/** One entry's bytes as the box served them, checked against the digest it sent. */
export interface PhoneFileContent {
  bytes: Uint8Array;
  /** The box's `content-type`, parameters dropped. */
  mime: string;
  sha256: string;
}

export interface PhoneSecretInput {
  /** What the operator typed or pasted. Never logged, never in a message. */
  text: string;
  /** "Treat as": `auto` (the default) lets the parser decide. */
  as?: SecretTextAs | undefined;
  signal?: AbortSignal | undefined;
}

/** One box's files service, as the phone uses it. */
export interface PhoneFiles {
  /**
   * Whether the box serves files (`files` in `GET /healthz`'s capabilities).
   * `false` is the box's answer; a box that did not answer throws.
   */
  capability(opts?: { signal?: AbortSignal | undefined }): Promise<boolean>;
  /** Upload one file to the box's stage area. */
  stage(input: PhoneFilesStageInput): Promise<FilesStageResult>;
  /** Commit one staged file into the box's inbox for `session` (the adapter calls this). */
  commit: TurnAttachments["commit"];
  /**
   * Every request slot on the box, its TTL applied; only `session_id`'s when
   * one is given (`GET /files/requests`).
   */
  requests(session_id?: string | null, opts?: PhoneFilesCallOptions): Promise<FileRequest[]>;
  /** One request slot, as the box holds it (`GET /files/requests/:id`). */
  request(request_id: string, opts?: PhoneFilesCallOptions): Promise<FileRequest>;
  /**
   * Answer a file request with a file (`PUT /files/requests/:id`). The slot is
   * read first: a closed one, a type outside its accept list or a file over
   * its cap is refused before the upload.
   */
  fulfil(request_id: string, input: PhoneFilesFulfilInput): Promise<FilesFulfilResult>;
  /**
   * Answer a text secret request, just this once (`PUT /files/requests/:id`
   * with the "Treat as" header): parsed here first against the slot's keys,
   * then parsed again, authoritatively, by the box into its tmpfs.
   */
  secret(request_id: string, input: PhoneSecretInput): Promise<FilesFulfilResult>;
  /** Refuse a request (`POST /files/requests/:id/decline`); the slot as the box closed it. */
  decline(request_id: string, opts?: PhoneFilesCallOptions): Promise<FileRequest>;
  /**
   * An inbox or outbox entry's bytes (`GET /files/:id/content`): an image a
   * transcript shows, or a shared file to save. The box's `Content-Digest`
   * is required and checked; a body that does not hash to it, or a box that
   * sent none, is `FILE_DIGEST_MISMATCH`, and nothing is returned.
   */
  content(id: string, opts?: PhoneFilesContentOptions): Promise<PhoneFileContent>;
}

/** The files client for the box at `host`: what the app's deps hand the chat screen. */
export type PhoneFilesFactory = (host: string) => PhoneFiles;

export interface PhoneFilesDeps {
  fetch: FetchLike;
  /** The box: its MagicDNS name or tailnet address, from the pairing or `/fleet`. */
  host: string;
}

const KNOWN_CODES: ReadonlySet<string> = new Set<string>([...FILES_ERROR_CODES, "UNSUPPORTED"]);

/** The code a status implies when the body names none this build knows (core's `codeForStatus`). */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 404:
      return "UNSUPPORTED";
    case 409:
      return "CONFLICT";
    case 410:
      return "FILE_REQUEST_EXPIRED";
    case 413:
      return "FILE_TOO_LARGE";
    case 422:
      return "FILE_DIGEST_MISMATCH";
    case 507:
      return "DISK_FULL";
    default:
      return "INTERNAL";
  }
}

/** `message` with every spelling of the file's name replaced. */
function scrub(message: string, names: readonly string[]): string {
  let out = message;
  for (const name of names) if (name) out = out.split(name).join("‹file›");
  return out;
}

/**
 * A failed files call, typed. A box that answered keeps its code when this
 * build knows it, else the status decides; `NOT_FOUND` on a files route is a
 * hermeticd without the files service, so it reads as `UNSUPPORTED`. A call
 * the caller stopped is `ABORTED`. Anything else (`TUNNEL_UNVERIFIED`,
 * `HERMETICD_UNAVAILABLE` with no answer) passes through.
 */
function filesError(
  error: unknown,
  host: string,
  signal: AbortSignal | undefined,
  names: readonly string[] = [],
): unknown {
  if (signal?.aborted) return new HermeticError("ABORTED", `${host}: the file transfer was stopped`);
  if (!(error instanceof HermeticError)) return error;
  const status = error.details?.status;
  if (typeof status !== "number") return error;
  const boxCode = error.code as string;
  if (boxCode === "NOT_FOUND" || (status === 404 && !KNOWN_CODES.has(boxCode))) {
    return new HermeticError(
      "UNSUPPORTED",
      `hermeticd on ${host} does not serve files; update it with \`hermetic artifacts push\`, then \`agent rerun\``,
      { host, status },
    );
  }
  const code = KNOWN_CODES.has(boxCode) ? (boxCode as ErrorCode) : codeForStatus(status);
  return new HermeticError(code, scrub(error.message, names), { host, status });
}

/** A reply read against the schema this build expects; another shape is an older hermeticd. */
async function parseReply<T>(
  response: Response,
  host: string,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new HermeticError(
    "UNSUPPORTED",
    `hermeticd on ${host} answered in a shape this version does not read; update hermeticd with \`hermetic artifacts push\`, then \`agent rerun\``,
    { host },
  );
}

/** A size in MiB for a refusal's message (the caps are whole MiB). */
const mib = (bytes: number): string =>
  `${Number((bytes / (1024 * 1024)).toFixed(1)).toLocaleString("en-US")} MiB`;

/**
 * The checks the box would make, made first so a refusal costs no upload.
 * Answers the sanitized name.
 */
function preflight(host: string, input: PhoneFilesStageInput): string {
  const clean = sanitizeFileName(input.name);
  if (!clean.ok) {
    throw new HermeticError("FILE_NAME_INVALID", `that file name is not allowed (${clean.reason})`, {
      host,
      reason: clean.reason,
    });
  }
  const head = input.bytes.subarray(0, FILES_LIMITS.sniffBytes);
  const image = isImageMime(sniffMime(head, clean.name));
  const cap = image ? FILES_LIMITS.imageBytes : FILES_LIMITS.fileBytes;
  const size = input.bytes.byteLength;
  if (size > cap) {
    throw new HermeticError(
      "FILE_TOO_LARGE",
      `${host}: the file is ${mib(size)}; ${image ? "images" : "files"} can be at most ${mib(cap)}`,
      { host, size, limit: cap },
    );
  }
  if (input.not_secret !== true && looksLikeKeyMaterial(head, clean.name)) {
    throw new HermeticError(
      "FILE_LOOKS_SECRET",
      `${host}: the file looks like a private key; send it as a secret, or confirm it is not one`,
      { host },
    );
  }
  return clean.name;
}

/** A request slot that is not `open`, refused with the code the box answers (core's `requestStateRefusal`). */
function closedRefusal(host: string, state: string): HermeticError {
  const code: ErrorCode =
    state === "expired"
      ? "FILE_REQUEST_EXPIRED"
      : state === "receiving" || state === "fulfilled" || state === "consumed"
        ? "FILE_REQUEST_FULFILLED"
        : "FILE_REQUEST_CLOSED";
  const why =
    code === "FILE_REQUEST_EXPIRED"
      ? "the file request has expired; the agent has to ask again"
      : code === "FILE_REQUEST_FULFILLED"
        ? "the file request was already fulfilled"
        : "the file request is closed; the agent has moved on";
  return new HermeticError(code, `${host}: ${why}`, { host, state });
}

/** The JSON body hermeticd reads, with the length it insists on (411 without one). */
function jsonInit(body: unknown): { body: string; headers: Record<string, string> } {
  const text = JSON.stringify(body);
  return {
    body: text,
    headers: { "content-length": String(new TextEncoder().encode(text).byteLength) },
  };
}

/**
 * An entry's body, checked the way desktop `readVerified` checks it: an image
 * read refuses a non-image type from the headers, before a byte of the body;
 * the declared and the actual length are held to `maxBytes`; the box's
 * `Content-Digest` is required and the bytes must hash to it. A refusal
 * cancels the body. `signal` is the request's own (the caller's stop, or the
 * body deadline), so an abort ends the read.
 */
async function readContent(
  host: string,
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
  image: boolean,
): Promise<PhoneFileContent> {
  const refuse = (code: ErrorCode, why: string): HermeticError => {
    if (typeof response.body?.cancel === "function") void response.body.cancel().catch(() => {});
    return new HermeticError(code, `${host}: ${why}`, { host });
  };
  const mime =
    (response.headers.get("content-type") ?? "").split(";")[0]?.trim() || "application/octet-stream";
  if (image && !isImageMime(mime)) throw refuse("FILE_TYPE_REJECTED", "only images have a preview");
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes)
    throw refuse("FILE_TOO_LARGE", "the file is too large to show here");
  const expected = parseContentDigest(response.headers.get(CONTENT_DIGEST_HEADER));
  if (expected === null) throw refuse("FILE_DIGEST_MISMATCH", "the box sent the file without a digest");
  let bytes: Uint8Array;
  try {
    bytes = await readCapped(response, maxBytes);
  } catch (error) {
    if (error instanceof HermeticError && error.code === "FILE_TOO_LARGE")
      throw refuse("FILE_TOO_LARGE", "the file is too large to show here");
    if (signal.aborted)
      throw new HermeticError("ABORTED", `${host}: the file transfer was stopped or timed out`, {
        host,
      });
    throw new HermeticError("FILE_DIGEST_MISMATCH", `${host}: the file transfer ended early`, {
      host,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const sha256 = sha256Hex(bytes);
  if (sha256 !== expected.toLowerCase())
    throw new HermeticError("FILE_DIGEST_MISMATCH", `${host}: the file does not match its digest`, {
      host,
    });
  return { bytes, mime, sha256 };
}

/**
 * The whole body, stopping at `maxBytes` + 1: streamed where the engine
 * gives a stream, else read at once (React Native's `fetch` has no body
 * stream; its read still ends on the request's abort).
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = (): HermeticError => new HermeticError("FILE_TOO_LARGE", "over the cap");
  const stream = response.body;
  const reader = stream && typeof stream.getReader === "function" ? stream.getReader() : null;
  if (!reader) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.byteLength > maxBytes) throw tooLarge();
    return whole;
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {});
      throw tooLarge();
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** The files client for one box. */
export function createPhoneFiles(deps: PhoneFilesDeps): PhoneFiles {
  const { fetch, host } = deps;

  async function request(request_id: string, opts: PhoneFilesCallOptions = {}): Promise<FileRequest> {
    let response: Response;
    try {
      response = await callHermeticd(fetch, host, FILES_ROUTES.request(request_id), {
        timeoutMs: FILES_COMMIT_TIMEOUT_MS,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (error) {
      throw filesError(error, host, opts.signal);
    }
    return await parseReply(response, host, FileRequest);
  }

  async function content(id: string, opts: PhoneFilesContentOptions = {}): Promise<PhoneFileContent> {
    const image = opts.image === true;
    const cap = image ? FILES_LIMITS.imageBytes : FILES_LIMITS.fileBytes;
    const maxBytes = Math.min(opts.maxBytes ?? cap, cap);
    try {
      return await callHermeticdBody(
        fetch,
        host,
        FILES_ROUTES.content(id),
        {
          timeoutMs: FILES_COMMIT_TIMEOUT_MS,
          bodyTimeoutMs: stageTimeoutMs(maxBytes),
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        (response, signal) => readContent(host, response, signal, maxBytes, image),
      );
    } catch (error) {
      throw filesError(error, host, opts.signal);
    }
  }

  return {
    content,
    async capability(opts = {}) {
      const response = await callHermeticd(fetch, host, RPC_PATHS.health, {
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const parsed = RpcHealth.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        throw new HermeticError(
          "CHAT_PROTOCOL",
          `hermeticd on ${host} answered /healthz in an unknown shape`,
          { host },
        );
      }
      return parsed.data.capabilities?.includes(FILES_CAPABILITY) ?? false;
    },

    async stage(input) {
      const name = preflight(host, input);
      const { bytes, signal } = input;
      const headers: Record<string, string> = {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
        // Hashed in place, block by block: no second copy of the upload.
        [CONTENT_DIGEST_HEADER]: formatContentDigest(createSha256().update(bytes).digestHex()),
      };
      if (input.session_id) headers[FILES_SESSION_HEADER] = input.session_id;
      if (input.not_secret === true) headers[FILES_NOT_SECRET_HEADER] = "1";
      let response: Response;
      try {
        response = await callHermeticd(fetch, host, FILES_ROUTES.stage(name), {
          method: "PUT",
          headers,
          body: bytes,
          timeoutMs: stageTimeoutMs(bytes.byteLength),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw filesError(error, host, signal, [input.name, name]);
      }
      return await parseReply(response, host, FilesStageResult);
    },

    async commit(id, session, signal) {
      const body = JSON.stringify(session ? { session_id: session } : {});
      let response: Response;
      try {
        response = await callHermeticd(fetch, host, FILES_ROUTES.commit(id), {
          method: "POST",
          // hermeticd refuses a JSON body without a length (411), as the desktop's client knows.
          headers: { "content-length": String(new TextEncoder().encode(body).byteLength) },
          body,
          timeoutMs: FILES_COMMIT_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw filesError(error, host, signal);
      }
      return await parseReply(response, host, FilesCommitResult);
    },

    async requests(session_id, opts = {}) {
      let response: Response;
      try {
        response = await callHermeticd(fetch, host, FILES_ROUTES.requests, {
          timeoutMs: FILES_COMMIT_TIMEOUT_MS,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      } catch (error) {
        throw filesError(error, host, opts.signal);
      }
      const { requests } = await parseReply(response, host, RequestList);
      return session_id ? requests.filter((r) => r.session_id === session_id) : requests;
    },

    request,

    async fulfil(request_id, input) {
      const { bytes, signal } = input;
      const slot = await request(request_id, { signal });
      if (slot.state !== "open") throw closedRefusal(host, slot.state);
      if (slot.kind !== "file") {
        throw new HermeticError(
          "VALIDATION",
          `${host}: this request asks for text; type or paste it instead of choosing a file`,
          { host },
        );
      }
      const clean = sanitizeFileName(input.name);
      if (!clean.ok) {
        throw new HermeticError(
          "FILE_NAME_INVALID",
          `that file name is not allowed (${clean.reason})`,
          {
            host,
            reason: clean.reason,
          },
        );
      }
      const head = bytes.subarray(0, FILES_LIMITS.sniffBytes);
      const mime = sniffMime(head, clean.name);
      if (!acceptMatches(slot.accept, clean.name, mime)) {
        throw new HermeticError(
          "FILE_TYPE_REJECTED",
          `${host}: this request accepts ${slot.accept.join(" ")}; the file is ${mime}`,
          { host, mime },
        );
      }
      const secretSlot = slot.sensitivity === "secret";
      const keyLike =
        !secretSlot && input.not_secret !== true && looksLikeKeyMaterial(head, clean.name);
      // A secret, asked for or forced by a key-shaped head (D6), is held whole
      // in the box's tmpfs drop, under that lane's own cap.
      const cap =
        secretSlot || keyLike
          ? Math.min(slot.max_bytes, FILES_LIMITS.secretEphemeralBytes)
          : slot.max_bytes;
      if (bytes.byteLength > cap) {
        throw new HermeticError(
          keyLike ? "FILE_LOOKS_SECRET" : "FILE_TOO_LARGE",
          keyLike
            ? `${host}: the file looks like a private key and is too large to keep as a secret; confirm it is not one`
            : `${host}: the file is ${mib(bytes.byteLength)}; this request takes at most ${mib(cap)}`,
          { host, size: bytes.byteLength, limit: cap },
        );
      }
      // The name the box files it under: the slot's hint when it agrees with
      // the chosen file on what was checked above, else the chosen name.
      const stored = requestFileName(slot, clean.name, mime);
      const headers: Record<string, string> = {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
        [FILES_NAME_HEADER]: encodeURIComponent(stored),
        [CONTENT_DIGEST_HEADER]: formatContentDigest(createSha256().update(bytes).digestHex()),
      };
      if (input.not_secret === true) headers[FILES_NOT_SECRET_HEADER] = "1";
      let response: Response;
      try {
        response = await callHermeticd(fetch, host, FILES_ROUTES.request(request_id), {
          method: "PUT",
          headers,
          body: bytes,
          timeoutMs: stageTimeoutMs(bytes.byteLength),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw filesError(error, host, signal, [input.name, clean.name, stored]);
      }
      const result = await parseReply(response, host, FilesFulfilResult);
      if (secretSlot && result.class !== "secret") {
        // The box filed a secret as a normal file: never what the operator chose.
        throw new HermeticError(
          "INTERNAL",
          `${host}: the box filed the secret as a normal file; remove it from the agent's inbox and ask for it again`,
          { host },
        );
      }
      return result;
    },

    async secret(request_id, input) {
      const { signal } = input;
      const slot = await request(request_id, { signal });
      if (slot.state !== "open") throw closedRefusal(host, slot.state);
      if (slot.kind !== "secret_text") {
        throw new HermeticError(
          "VALIDATION",
          `${host}: this request asks for a file; choose one instead of typing it`,
          { host },
        );
      }
      const bytes = new TextEncoder().encode(input.text);
      try {
        const as = input.as ?? "auto";
        const parsed = parseSecretEnv(
          bytes,
          {
            keys: slot.keys ?? [],
            optional_keys: slot.optional_keys ?? [],
            maxBytes: FILES_LIMITS.secretTextBytes,
          },
          as,
        );
        // D10: refused here, before a byte reaches the box. The parser's
        // messages name keys and lines, never a value.
        if (!parsed.ok) {
          const why =
            parsed.errors.length === 0
              ? "the secret text is not readable"
              : parsed.errors.map((e) => e.message).join(" ");
          throw new HermeticError("VALIDATION", `${host}: ${why}`, {
            host,
            issues: parsed.errors.map((e) => e.code),
          });
        }
        const name = `${slot.slug ?? secretTextSlug(slot.keys ?? [])}.env`;
        let response: Response;
        try {
          response = await callHermeticd(fetch, host, FILES_ROUTES.request(request_id), {
            method: "PUT",
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(bytes.byteLength),
              [FILES_NAME_HEADER]: encodeURIComponent(name),
              [CONTENT_DIGEST_HEADER]: formatContentDigest(sha256Hex(bytes)),
              ...(input.as ? { [FILES_SECRET_AS_HEADER]: input.as } : {}),
            },
            body: bytes,
            timeoutMs: FILES_COMMIT_TIMEOUT_MS,
            ...(signal ? { signal } : {}),
          });
        } catch (error) {
          throw filesError(error, host, signal);
        }
        return await parseReply(response, host, FilesFulfilResult);
      } finally {
        bytes.fill(0);
      }
    },

    async decline(request_id, opts = {}) {
      let response: Response;
      try {
        response = await callHermeticd(fetch, host, FILES_ROUTES.requestDecline(request_id), {
          method: "POST",
          ...jsonInit({}),
          timeoutMs: FILES_COMMIT_TIMEOUT_MS,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      } catch (error) {
        throw filesError(error, host, opts.signal);
      }
      return await parseReply(response, host, FileRequest);
    },
  };
}

/** `GET /files/requests`'s answer, read slot by slot with core's schema. */
const RequestList = {
  safeParse(value: unknown): { success: true; data: { requests: FileRequest[] } } | { success: false } {
    const list = (value as { requests?: unknown } | null)?.requests;
    if (!Array.isArray(list)) return { success: false };
    const requests: FileRequest[] = [];
    for (const item of list) {
      const parsed = FileRequest.safeParse(item);
      if (!parsed.success) return { success: false };
      requests.push(parsed.data);
    }
    return { success: true, data: { requests } };
  },
};

/**
 * A turn's attachments: the staged files' ids in the operator's order, and the
 * box's commit. Hand it to `send` as `SendOptions.attachments`.
 */
export function attachmentsFor(
  staged: readonly FilesStageResult[],
  files: Pick<PhoneFiles, "commit">,
): TurnAttachments {
  return {
    ids: staged.map((file) => file.id),
    commit: (id, session, signal) => files.commit(id, session, signal),
  };
}
