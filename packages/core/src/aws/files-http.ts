import { createHash } from "node:crypto";
import type { FilesContentOptions } from "../backend/files-port.ts";
import type {
  AgentStore,
  FilesApi,
  FilesCallOptions,
  FilesContent,
  FilesFulfilOptions,
  FilesFulfilUpload,
  FilesProgress,
  FilesStageUpload,
} from "../backend/types.ts";
import { HermeticError } from "../errors.ts";
import {
  CONTENT_DIGEST_HEADER,
  FILES_ROUTES,
  FILES_SESSION_HEADER,
  FileRequest,
  FilesCommitResult,
  FilesErrorBody,
  FilesFulfilResult,
  FilesListResult,
  type FilesSecretBody,
  FilesStageResult,
  RPC_PROTOCOL_VERSION,
  RPC_VERSION_HEADER,
  formatContentDigest,
  parseContentDigest,
} from "../schema/index.ts";
import { ERROR_CODES, type ErrorCode } from "../shared/error-codes.ts";
import {
  FILES_NAME_HEADER,
  FILES_NOT_SECRET_HEADER,
  FILES_SECRET_AS_HEADER,
  isImageMime,
} from "../shared/files.ts";
import { filesRefusal } from "../files/errors.ts";
import { hermeticdBase, type HermeticdRpcOptions } from "./rpc.ts";
import type { FetchLike } from "./tailscale.ts";

/**
 * The laptop's client for hermeticd's `/files` routes (§6.4):
 * the same listener, port and tailnet identity check as the RPC reader in
 * `rpc.ts`, so it reuses that module's address lookup and options.
 *
 * Unlike `/healthz` these calls are not bounded by a fixed timeout — a 256 MiB
 * upload over a slow tailnet legitimately takes minutes — so the caller's
 * signal is the only way to stop one, and hermeticd's own idle cut-off
 * (`FILES_TTL.uploadIdle`) is what ends a stalled one.
 *
 * Messages never carry the file's name: the box's are replaced by a fixed
 * sentence per code where one exists, and otherwise scrubbed of the name.
 */

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

/** The code a status implies when the body is not a files error (an older hermeticd, a proxy). */
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

function scrub(message: string, fileName: string | undefined): string {
  if (!fileName) return message;
  return message.split(fileName).join("‹file›");
}

/**
 * A non-2xx files response as a `HermeticError`. The box's code wins when this
 * build knows it; otherwise the status decides, so a code from a newer
 * hermeticd still reads as the right kind of failure.
 */
export async function filesErrorFrom(
  res: Response,
  agent: string,
  fileName?: string,
): Promise<HermeticError> {
  let body: FilesErrorBody | null = null;
  try {
    const parsed = FilesErrorBody.safeParse(await res.json());
    body = parsed.success ? parsed.data : null;
  } catch {
    body = null;
  }
  const boxCode = body?.error.code;
  const code: ErrorCode =
    boxCode !== undefined && ERROR_CODE_SET.has(boxCode)
      ? (boxCode as ErrorCode)
      : codeForStatus(res.status);
  const fallback =
    body === null && res.status === 404
      ? "hermeticd does not serve files yet; run `hermetic artifacts push`, then `agent rerun`"
      : body?.error.message
        ? scrub(body.error.message, fileName)
        : `hermeticd answered HTTP ${res.status}`;
  return filesRefusal(code, agent, fallback, { status: res.status });
}

/** A transport failure, typed: an abort is the caller's, anything else is "did not answer". */
function transportError(e: unknown, agent: string, signal: AbortSignal | undefined): HermeticError {
  if (e instanceof HermeticError) return e;
  if (signal?.aborted) return new HermeticError("ABORTED", `${agent}: the file transfer was stopped`);
  const why = e instanceof Error ? e.message : String(e);
  return new HermeticError("INTERNAL", `hermeticd on ${agent} did not answer: ${why}`, {
    name: agent,
  });
}

/** An upload body as a stream, counting bytes for `onProgress` as fetch pulls them. */
function countedStream(
  body: AsyncIterable<Uint8Array>,
  onProgress: ((sent: number) => void) | undefined,
): ReadableStream<Uint8Array> {
  const it = body[Symbol.asyncIterator]();
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await it.next();
      if (next.done) {
        controller.close();
        return;
      }
      sent += next.value.byteLength;
      controller.enqueue(next.value);
      onProgress?.(sent);
    },
    async cancel() {
      await it.return?.();
    },
  });
}

/**
 * How long a request that carries no upload waits for the box's response
 * headers. A box that took the connection and then went quiet would otherwise
 * hold a commit — and the chat turn waiting on it — until the caller gave up.
 */
export const FILES_HEADERS_TIMEOUT_MS = 30_000;

/**
 * A reply read against the schema this build expects. A box still on the
 * previous hermeticd answers without fields this build reads, which is not a
 * transport failure but an old binary: say how to update it. Never the body,
 * which can carry the file's name.
 */
async function parseReply<T>(
  res: Response,
  agent: string,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  let doc: unknown;
  try {
    doc = await res.json();
  } catch {
    doc = undefined;
  }
  const parsed = schema.safeParse(doc);
  if (parsed.success) return parsed.data;
  throw new HermeticError(
    "UNSUPPORTED",
    `hermeticd on ${agent} answered in a shape this version does not read; update hermeticd: hermetic artifacts push, then rerun`,
    { name: agent },
  );
}

export class HermeticdFiles implements FilesApi {
  constructor(
    private readonly agents: AgentStore,
    private readonly opts: HermeticdRpcOptions & { headersTimeoutMs?: number } = {},
  ) {}

  private get http(): FetchLike {
    return this.opts.fetch ?? ((input, init) => fetch(input, init));
  }

  private async call(
    agent: string,
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    fileName?: string,
    headersTimeoutMs?: number,
  ): Promise<Response> {
    const url = `${await hermeticdBase(this.agents, agent, this.opts.port)}${path}`;
    // Bounds the wait for the response headers only: disarmed once they
    // arrive, so a body still streaming is cut by the caller's signal alone.
    const deadline = headersTimeoutMs === undefined ? null : new AbortController();
    const timer = deadline ? setTimeout(() => deadline.abort(), headersTimeoutMs) : null;
    const combined = deadline
      ? signal
        ? AbortSignal.any([signal, deadline.signal])
        : deadline.signal
      : signal;
    let res: Response;
    try {
      res = await this.http(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          [RPC_VERSION_HEADER]: String(RPC_PROTOCOL_VERSION),
        },
        ...(combined ? { signal: combined } : {}),
      });
    } catch (e) {
      if (deadline?.signal.aborted && !signal?.aborted) {
        throw new HermeticError(
          "INTERNAL",
          `hermeticd on ${agent} did not answer within ${Math.round((headersTimeoutMs ?? 0) / 1000)} s`,
          { name: agent },
        );
      }
      throw transportError(e, agent, signal);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw await filesErrorFrom(res, agent, fileName);
    return res;
  }

  async stage(
    agent: string,
    upload: FilesStageUpload,
    opts: FilesCallOptions & FilesProgress,
  ): Promise<FilesStageResult> {
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "content-length": String(upload.size),
    };
    if (upload.sha256) headers[CONTENT_DIGEST_HEADER] = formatContentDigest(upload.sha256);
    if (upload.sessionId) headers[FILES_SESSION_HEADER] = upload.sessionId;
    if (upload.notSecret) headers[FILES_NOT_SECRET_HEADER] = "1";
    // The cast narrows the buffer type only: a body is never a shared buffer here.
    const body: BodyInit =
      upload.body instanceof Uint8Array
        ? (upload.body as Uint8Array<ArrayBuffer>)
        : countedStream(upload.body, opts.onProgress);
    // `duplex` is what lets a streamed body go out before it has all been read.
    const init: RequestInit & { duplex?: "half" } = {
      method: "PUT",
      headers,
      body,
      ...(upload.body instanceof Uint8Array ? {} : { duplex: "half" as const }),
    };
    const res = await this.call(
      agent,
      FILES_ROUTES.stage(upload.fileName),
      init,
      opts.signal,
      upload.fileName,
    );
    if (upload.body instanceof Uint8Array) opts.onProgress?.(upload.size);
    return await parseReply(res, agent, FilesStageResult);
  }

  async commit(
    agent: string,
    id: string,
    body: { session_id?: string },
    opts: FilesCallOptions,
  ): Promise<FilesCommitResult> {
    const text = JSON.stringify(body);
    const res = await this.call(
      agent,
      FILES_ROUTES.commit(id),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(text).byteLength),
        },
        body: text,
      },
      opts.signal,
      undefined,
      this.headersTimeoutMs,
    );
    return await parseReply(res, agent, FilesCommitResult);
  }

  async content(
    agent: string,
    id: string,
    opts: FilesCallOptions & FilesContentOptions,
  ): Promise<FilesContent> {
    const res = await this.call(
      agent,
      FILES_ROUTES.content(id),
      { method: "GET" },
      opts.signal,
      undefined,
      this.headersTimeoutMs,
    );
    return await readVerified(res, agent, opts.maxBytes, opts);
  }

  async remove(agent: string, id: string, opts: FilesCallOptions): Promise<void> {
    await this.call(
      agent,
      FILES_ROUTES.entry(id),
      { method: "DELETE" },
      opts.signal,
      undefined,
      this.headersTimeoutMs,
    );
  }

  async request(agent: string, id: string, opts: FilesCallOptions): Promise<FileRequest> {
    const res = await this.call(
      agent,
      FILES_ROUTES.request(id),
      { method: "GET" },
      opts.signal,
      undefined,
      this.headersTimeoutMs,
    );
    return await parseReply(res, agent, FileRequest);
  }

  async list(agent: string, opts: FilesCallOptions): Promise<FilesListResult> {
    const res = await this.call(
      agent,
      FILES_ROUTES.list,
      { method: "GET" },
      opts.signal,
      undefined,
      this.headersTimeoutMs,
    );
    return await parseReply(res, agent, FilesListResult);
  }

  /**
   * Like `stage`, without a header timeout: the upload is bounded by the
   * caller's signal and hermeticd's idle cut-off, never a fixed wait.
   */
  async fulfil(
    agent: string,
    id: string,
    upload: FilesFulfilUpload,
    opts: FilesCallOptions & FilesProgress & FilesFulfilOptions,
  ): Promise<FilesFulfilResult> {
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "content-length": String(upload.size),
      [FILES_NAME_HEADER]: encodeURIComponent(upload.fileName),
    };
    if (upload.sha256) headers[CONTENT_DIGEST_HEADER] = formatContentDigest(upload.sha256);
    if (opts.notSecret) headers[FILES_NOT_SECRET_HEADER] = "1";
    if (opts.secretAs) headers[FILES_SECRET_AS_HEADER] = opts.secretAs;
    const body: BodyInit =
      upload.body instanceof Uint8Array
        ? (upload.body as Uint8Array<ArrayBuffer>)
        : countedStream(upload.body, opts.onProgress);
    const init: RequestInit & { duplex?: "half" } = {
      method: "PUT",
      headers,
      body,
      ...(upload.body instanceof Uint8Array ? {} : { duplex: "half" as const }),
    };
    const res = await this.call(agent, FILES_ROUTES.request(id), init, opts.signal, upload.fileName);
    if (upload.body instanceof Uint8Array) opts.onProgress?.(upload.size);
    return await parseReply(res, agent, FilesFulfilResult);
  }

  async secret(
    agent: string,
    id: string,
    body: FilesSecretBody,
    opts: FilesCallOptions,
  ): Promise<FilesFulfilResult> {
    const res = await this.postJson(agent, FILES_ROUTES.requestSecret(id), body, opts, body.name);
    return await parseReply(res, agent, FilesFulfilResult);
  }

  async decline(
    agent: string,
    id: string,
    reason: string | undefined,
    opts: FilesCallOptions,
  ): Promise<FileRequest> {
    const res = await this.postJson(
      agent,
      FILES_ROUTES.requestDecline(id),
      reason === undefined ? {} : { reason },
      opts,
    );
    return await parseReply(res, agent, FileRequest);
  }

  private async postJson(
    agent: string,
    path: string,
    body: unknown,
    opts: FilesCallOptions,
    fileName?: string,
  ): Promise<Response> {
    const text = JSON.stringify(body);
    return await this.call(
      agent,
      path,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(text).byteLength),
        },
        body: text,
      },
      opts.signal,
      fileName,
      this.headersTimeoutMs,
    );
  }

  private get headersTimeoutMs(): number {
    return this.opts.headersTimeoutMs ?? FILES_HEADERS_TIMEOUT_MS;
  }
}

/**
 * A content response read whole and checked twice: its length against
 * `Content-Length`, and its hash against `Content-Digest`. hermeticd closes the
 * connection early when the file changed under it, which reads as a clean end
 * of stream — only the length and the digest tell the two apart.
 */
export async function readVerified(
  res: Response,
  agent: string,
  maxBytes: number,
  opts: { signal?: AbortSignal | undefined; imagesOnly?: boolean | undefined } = {},
): Promise<FilesContent> {
  const mismatch = (why: string): HermeticError =>
    new HermeticError("FILE_DIGEST_MISMATCH", `${agent}: ${why}`, { name: agent });
  const mime =
    (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]?.trim() ||
    "application/octet-stream";
  // Read from the headers, so a file that is not an image costs no body.
  if (opts.imagesOnly && !isImageMime(mime)) {
    await res.body?.cancel().catch(() => {});
    throw new HermeticError("FILE_TYPE_REJECTED", `${agent}: only images have a preview`, {
      name: agent,
    });
  }
  const declaredHeader = res.headers.get("content-length");
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (declared !== null && Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new HermeticError("FILE_TOO_LARGE", `${agent}: the file is too large to preview`, {
      name: agent,
    });
  }
  const expected = parseContentDigest(res.headers.get(CONTENT_DIGEST_HEADER));
  if (expected === null) throw mismatch("the box sent the file without a digest");

  const hash = createHash("sha256");
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    if (res.body) {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          throw new HermeticError("FILE_TOO_LARGE", `${agent}: the file is too large to preview`, {
            name: agent,
          });
        }
        hash.update(chunk);
        parts.push(chunk);
      }
    }
  } catch (e) {
    if (e instanceof HermeticError) throw e;
    // A stop is a stop, not a damaged transfer.
    if (opts.signal?.aborted)
      throw new HermeticError("ABORTED", `${agent}: the file transfer was stopped`);
    throw mismatch("the file transfer ended early");
  }
  if (declared !== null && total !== declared) throw mismatch("the file transfer ended early");
  const sha256 = hash.digest("hex");
  if (sha256 !== expected) throw mismatch("the file the box sent does not match its digest");

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  return { bytes, mime, sha256 };
}
