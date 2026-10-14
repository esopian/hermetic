/**
 * What every part of the files service is handed: the host, the index, the
 * agent's own name and the two secret hooks. Built once by `makeFilesService`
 * (`service.ts`).
 */
import type { FileClass, FileRequest, FileRequestKind, FileWaitResult } from "@hermetic/core/schema";
import { FILES_ROUTES, HERMETICD_RPC_PORT, secretTextLoad } from "@hermetic/core/shared";
import type { Host } from "../host.ts";
import type { FilesStore } from "./store.ts";

/** A durable file secret, as the secrets module materialised it (`secrets.ts`). */
export interface MaterialisedFileSecret {
  readonly slot: string;
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface FilesDeps {
  readonly host: Host;
  /** This agent's name: the host part of `deliver_with`'s URLs. */
  readonly name: string;
  readonly hermeticdVersion: string;
  /** The redacting journal writer. Never handed a file name or a purpose. */
  readonly log?: (message: string) => void;
  /**
   * Read an SSM `file-<slug>`/`env-<slug>` slot and write it to tmpfs
   * (`secrets.ts`), refusing with a `VALIDATION` `FilesError` — before
   * writing — when the envelope does not name `expectName`, or when `check`
   * throws on the decoded bytes (a text secret's authoritative re-parse).
   */
  readonly materialiseSecret?: (
    slot: string,
    expectName: string,
    check?: (content: Uint8Array) => void,
  ) => Promise<MaterialisedFileSecret>;
  /** Remove a durable secret's tmpfs copy (`secrets.ts`); SSM is the laptop's job. */
  readonly removeSecret?: (name: string) => Promise<void>;
  /**
   * A long-poll's timer, injected so a test can time one out without waiting.
   * Resolves after `ms`, or as soon as `signal` aborts.
   */
  readonly delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** How long an upload may go silent, in ms; `FILES_TTL.uploadIdle` unless a test says otherwise. */
  readonly uploadIdleMs?: number;
}

export interface FilesCtx extends FilesDeps {
  readonly store: FilesStore;
  readonly log: (message: string) => void;
  readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Who is on the other end of a tailnet route: `whois` already said it is a member. */
export interface Caller {
  readonly login: string;
  readonly node: string;
}

export function nowIso(host: Host): string {
  return host.now().toISOString();
}

export function isoAfter(host: Host, seconds: number): string {
  return new Date(host.now().getTime() + seconds * 1000).toISOString();
}

/** Whether an ISO timestamp is now or in the past. */
export function isDue(host: Host, iso: string): boolean {
  return Date.parse(iso) <= host.now().getTime();
}

export function realDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The ways to answer a request with no card to drop it on (scenario D). A
 * file: the CLI, and plain `curl -T`, which needs no token because the
 * caller's tailnet identity is the credential; `<path>` is the operator's own.
 * A text secret: the CLI reading stdin only, never a flag value — runs and
 * shell history record flag values (§8.1).
 */
export function deliverWith(name: string, requestId: string, kind: FileRequestKind = "file"): string[] {
  if (kind === "secret_text")
    return [`hermetic files put ${name} --request ${requestId} --secret-stdin`];
  return [
    `hermetic files put ${name} --request ${requestId} <path>`,
    `curl -T <path> http://${name}:${HERMETICD_RPC_PORT}${FILES_ROUTES.request(requestId)}`,
  ];
}

/** What a fulfilled slot tells the agent: where the file is, and for a text secret how to load it. */
function fulfilledFields(request: FileRequest): Partial<FileWaitResult> {
  const fulfilled = request.fulfilled;
  if (!fulfilled) return {};
  if (request.kind === "secret_text") {
    // Key names and the load line, never a value — nor the digest or size:
    // a short secret's SHA-256 is a dictionary lookup away from its value,
    // and the result lands in the transcript.
    return {
      path: fulfilled.path,
      by: fulfilled.by,
      class: fulfilled.class,
      keys: fulfilled.keys ?? [],
      format: fulfilled.format ?? "dotenv",
      load: secretTextLoad(fulfilled.path),
    };
  }
  // A secret-class file (a `sensitivity: "secret"` slot, or an upload the box
  // judged to be key material) loses its digest and size for the same reason.
  if (fulfilled.class === "secret") {
    return { path: fulfilled.path, by: fulfilled.by, class: fulfilled.class };
  }
  return {
    path: fulfilled.path,
    sha256: fulfilled.sha256,
    bytes: fulfilled.bytes,
    by: fulfilled.by,
    class: fulfilled.class,
  };
}

/**
 * A slot as the plugin's long-poll reads it. `receiving` is still `open` to
 * the agent: the upload has not landed and may yet be rejected.
 */
export function waitResult(name: string, request: FileRequest): FileWaitResult {
  const status = request.state === "receiving" ? "open" : request.state;
  return {
    status,
    request_id: request.request_id,
    ...(status === "fulfilled" || status === "consumed" ? fulfilledFields(request) : {}),
    deliver_with: deliverWith(name, request.request_id, request.kind),
    expires_at: request.expires_at,
  };
}

/**
 * The audit line for a completed change: route, id, size, digest prefix and
 * who. Never the name and never the purpose — either can itself be the secret.
 * Nor a secret's digest, not even a prefix: a short secret's SHA-256 is a
 * dictionary lookup away from its value.
 */
export function auditFiles(
  ctx: FilesCtx,
  route: string,
  fields: { id: string; bytes?: number; sha256?: string; login?: string; class?: FileClass },
): void {
  const bytes = fields.bytes === undefined ? "-" : String(fields.bytes);
  const sha =
    fields.sha256 === undefined || fields.class === "secret" ? "-" : fields.sha256.slice(0, 12);
  ctx.log(`files ${route} id=${fields.id} bytes=${bytes} sha256=${sha} login=${fields.login ?? "-"}`);
}
