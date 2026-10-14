import { createHash } from "node:crypto";
import { HermeticError } from "../../errors.ts";
import { filesRefusal, requestStateRefusal, secretTextRefusal } from "../../files/errors.ts";
import {
  type FileClass,
  type FileEntry,
  type FileRequest,
  type FilesCommitResult,
  type FilesFulfilResult,
  type FilesListResult,
  type FilesSecretBody,
  type FilesStageResult,
  OpenFileRequestBody,
  OpenSecretRequestBody,
} from "../../schema/index.ts";
import type { ErrorCode } from "../../shared/error-codes.ts";
import {
  FILES_DROP_DIR,
  FILES_LIMITS,
  FILES_SECRET_DIR,
  FILES_TTL,
  SECRET_TEXT_MAX_KEYS,
  type SecretTextAs,
  type SecretTextFormat,
  acceptMatches,
  decodeSecretEnvelope,
  envSecretSlot,
  inboxRelPath,
  isFileSecretSlot,
  isImageMime,
  looksLikeKeyMaterial,
  newFileId,
  newRequestId,
  sanitizeFileName,
  secretTextSlug,
  sniffMime,
} from "../../shared/files.ts";
import { HERMES_HOME } from "../../shared/hermes.ts";
import { canonicalSecretEnv, parseSecretEnv } from "../../shared/secret-env.ts";
import { agentParamPath } from "../constants.ts";
import type {
  FilesApi,
  FilesCallOptions,
  FilesContent,
  FilesContentOptions,
  FilesFulfilOptions,
  FilesFulfilUpload,
  FilesProgress,
  FilesStageUpload,
} from "../files-port.ts";

/**
 * Fixture mode's files store: hermeticd's `/files` stage, commit, content and
 * delete, in memory, with real bytes. The same checks the box makes — the name
 * rules, the image and file caps, the digest, the key-material refusal — so a
 * head exercised against the fixture meets the refusals it will meet for real.
 *
 * Two failures are staged by the attached file's *name*, the way fixture chat
 * stages its failures by prompt text:
 *
 * - `E2E_FILE_TOO_LARGE` anywhere in the name → `FILE_TOO_LARGE` (413).
 * - `E2E_FILE_DIGEST` anywhere in the name → `FILE_DIGEST_MISMATCH` (422).
 */

export const E2E_FILE_TOO_LARGE = "E2E_FILE_TOO_LARGE";
export const E2E_FILE_DIGEST = "E2E_FILE_DIGEST";

/** One entry of the fixture store: what hermeticd's index would hold, plus the bytes. */
export interface MemoryFileEntry {
  id: string;
  agent: string;
  name: string;
  bytes: Uint8Array;
  mime: string;
  sha256: string;
  class: FileClass;
  state: "staged" | "inbox";
  created_at: string;
  expires_at: string;
  session_id?: string;
  /** Set on commit: the `@file:` reference relative to `HERMES_HOME`. */
  rel?: string;
  /** Set on commit: the absolute path on the box. */
  path?: string;
}

export interface MemoryFilesHost {
  /** Whether the fixture has a row by this name. */
  hasAgent(name: string): boolean;
  now(): Date;
  /**
   * The real clock, for request slots only: a request card counts its expiry
   * down against the operator's wall clock, so a slot stamped with the
   * fixture's frozen `now` would read as expired the moment it opened. Staged
   * and inbox entries keep `now`. Defaults to `new Date()`; tests inject one.
   */
  wallNow?(): Date;
  /**
   * The fleet's SSM parameter, the way the instance role reads it: what a
   * durable secret's `POST /files/requests/:id/secret` materialises from.
   * Absent on a host that has no parameters; the secret route then refuses.
   */
  readParam?(path: string): string | undefined;
  /** The fleet id the agent parameter paths are under. */
  fleetId?(): string | null;
}

/** The tailnet login the fixture's operator answers requests as. */
export const FIXTURE_OPERATOR_LOGIN = "operator@fixture.example";

/** One request slot, plus what only the fixture keeps about it. */
interface MemoryRequest {
  agent: string;
  request: FileRequest;
  /** The last text-secret fulfil's "Treat as", as the box received it. */
  secretAs?: SecretTextAs;
  /** A secret's bytes on the box (tmpfs): a text secret's canonical form, never the paste. */
  secretBytes?: Uint8Array;
  waiters: Set<() => void>;
}

/** Live: still waiting for its file. */
function isLive(r: FileRequest): boolean {
  return r.state === "open" || r.state === "receiving";
}

function isoAfter(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

async function readAll(
  body: AsyncIterable<Uint8Array> | Uint8Array,
  onProgress: ((sent: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    onProgress?.(body.byteLength);
    return body;
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    if (signal?.aborted) throw new HermeticError("ABORTED", "the file transfer was stopped");
    parts.push(chunk);
    total += chunk.byteLength;
    onProgress?.(total);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export class MemoryFiles implements FilesApi {
  /** Every entry, staged or committed, by id. */
  readonly entries = new Map<string, MemoryFileEntry>();

  constructor(private readonly host: MemoryFilesHost) {}

  /** The request slots' clock (`MemoryFilesHost.wallNow`). */
  private wallNow(): Date {
    return this.host.wallNow?.() ?? new Date();
  }

  private requireAgent(name: string): void {
    if (!this.host.hasAgent(name)) {
      throw new HermeticError("NOT_FOUND", `no such agent: ${name}`, { name });
    }
  }

  private find(agent: string, id: string): MemoryFileEntry {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.agent !== agent) throw filesRefusal("FILE_NOT_FOUND", agent);
    return entry;
  }

  async stage(
    agent: string,
    upload: FilesStageUpload,
    opts: FilesCallOptions & FilesProgress,
  ): Promise<FilesStageResult> {
    this.requireAgent(agent);
    if (opts.signal?.aborted) throw new HermeticError("ABORTED", "the file transfer was stopped");
    const clean = sanitizeFileName(upload.fileName);
    if (!clean.ok) throw filesRefusal("FILE_NAME_INVALID", agent, undefined, { reason: clean.reason });
    const name = clean.name;
    if (name.includes(E2E_FILE_TOO_LARGE)) throw filesRefusal("FILE_TOO_LARGE", agent);

    const bytes = await readAll(upload.body, opts.onProgress, opts.signal);
    if (bytes.byteLength !== upload.size) throw filesRefusal("FILE_DIGEST_MISMATCH", agent);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== upload.sha256.toLowerCase() || name.includes(E2E_FILE_DIGEST)) {
      throw filesRefusal("FILE_DIGEST_MISMATCH", agent);
    }
    const head = bytes.subarray(0, FILES_LIMITS.sniffBytes);
    const mime = sniffMime(head, name);
    const image = isImageMime(mime);
    if (bytes.byteLength > (image ? FILES_LIMITS.imageBytes : FILES_LIMITS.fileBytes)) {
      throw filesRefusal("FILE_TOO_LARGE", agent);
    }
    if (!upload.notSecret && looksLikeKeyMaterial(head, name)) {
      throw filesRefusal("FILE_LOOKS_SECRET", agent);
    }

    const now = this.host.now();
    const entry: MemoryFileEntry = {
      id: newFileId(),
      agent,
      name,
      bytes,
      mime,
      sha256,
      class: image ? "image" : "file",
      state: "staged",
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + FILES_TTL.stage * 1000).toISOString(),
      ...(upload.sessionId ? { session_id: upload.sessionId } : {}),
    };
    this.entries.set(entry.id, entry);
    return {
      id: entry.id,
      name,
      bytes: bytes.byteLength,
      mime,
      sha256,
      class: entry.class,
      expires_at: entry.expires_at,
    };
  }

  async commit(
    agent: string,
    id: string,
    body: { session_id?: string },
    _opts: FilesCallOptions,
  ): Promise<FilesCommitResult> {
    this.requireAgent(agent);
    const entry = this.live(agent, id);
    // As on the box (`commitStaged`): a second commit of a committed id answers
    // what the first did, whatever session it names; only a staged entry is
    // held to the session it was staged for.
    if (
      entry.state === "staged" &&
      body.session_id &&
      entry.session_id &&
      body.session_id !== entry.session_id
    ) {
      throw new HermeticError("CONFLICT", `${agent}: that file was staged for another session`, {
        name: agent,
      });
    }
    if (entry.state === "staged") {
      const now = this.host.now();
      const rel = inboxRelPath(now, entry.id, entry.name);
      entry.state = "inbox";
      entry.rel = rel;
      entry.path = `${HERMES_HOME}/${rel}`;
      entry.expires_at = new Date(now.getTime() + FILES_TTL.inbox * 1000).toISOString();
      if (body.session_id) entry.session_id = body.session_id;
    }
    return {
      id: entry.id,
      path: entry.path ?? "",
      rel: entry.rel ?? "",
      name: entry.name,
      bytes: entry.bytes.byteLength,
      mime: entry.mime,
      sha256: entry.sha256,
      class: entry.class,
    };
  }

  async content(
    agent: string,
    id: string,
    opts: FilesCallOptions & FilesContentOptions,
  ): Promise<FilesContent> {
    this.requireAgent(agent);
    const entry = this.live(agent, id);
    if (opts.imagesOnly && !isImageMime(entry.mime)) {
      throw new HermeticError("FILE_TYPE_REJECTED", `${agent}: only images have a preview`, {
        name: agent,
      });
    }
    if (entry.bytes.byteLength > opts.maxBytes) {
      throw new HermeticError("FILE_TOO_LARGE", `${agent}: the file is too large to preview`, {
        name: agent,
      });
    }
    return { bytes: entry.bytes.slice(), mime: entry.mime, sha256: entry.sha256 };
  }

  async remove(agent: string, id: string, _opts: FilesCallOptions): Promise<void> {
    this.requireAgent(agent);
    // A durable secret's entry: gone from the box's index, so it holds no slug any more.
    const secret = this.secretEntries.get(id);
    if (secret !== undefined && secret.agent === agent) {
      this.secretEntries.delete(id);
      return;
    }
    this.live(agent, id);
    this.entries.delete(id);
  }

  /**
   * An entry the box's sweeper has not yet deleted. It deletes a stage entry
   * an hour after the upload and an inbox entry seven days after its commit;
   * anything after that finds nothing, here as there.
   */
  private live(agent: string, id: string): MemoryFileEntry {
    const entry = this.find(agent, id);
    if (Date.parse(entry.expires_at) <= this.host.now().getTime()) {
      this.entries.delete(id);
      throw filesRefusal("FILE_NOT_FOUND", agent);
    }
    return entry;
  }

  /**
   * The read helper fixture chat uses: one entry by id, or `undefined` when it
   * is not on that agent's box.
   */
  entry(agent: string, id: string): MemoryFileEntry | undefined {
    const entry = this.entries.get(id);
    return entry !== undefined && entry.agent === agent ? entry : undefined;
  }

  /** Every committed (inbox) entry on one agent's box, oldest first. */
  committed(agent: string): MemoryFileEntry[] {
    return [...this.entries.values()].filter((e) => e.agent === agent && e.state === "inbox");
  }

  // ─── Request slots (`request_file` / `request_secret`) ─────────────────────

  /** Every request slot, by id. */
  private readonly requests = new Map<string, MemoryRequest>();

  /**
   * The box's `secret`-dir entries — every durable secret placed from SSM, a
   * text one with the key names it stored, a file one with none — by entry
   * id. One per agent and slot, a re-sent secret replacing it, as
   * `placeSecret` keeps them; `remove` deletes one. What `textSlug` compares.
   */
  private readonly secretEntries = new Map<string, FileEntry & { agent: string }>();

  /** A slot on `agent`'s box, its TTL applied, or `FILE_NOT_FOUND`. */
  private slot(agent: string, id: string): MemoryRequest {
    const held = this.requests.get(id);
    if (held === undefined || held.agent !== agent) throw filesRefusal("FILE_NOT_FOUND", agent);
    this.expireIfDue(held);
    return held;
  }

  private expireIfDue(held: MemoryRequest): void {
    if (!isLive(held.request)) return;
    if (Date.parse(held.request.expires_at) > this.wallNow().getTime()) return;
    held.request.state = "expired";
    this.wake(held);
  }

  private wake(held: MemoryRequest): void {
    const waiters = [...held.waiters];
    held.waiters.clear();
    for (const w of waiters) w();
  }

  /** A copy, so a caller holding one does not see later changes land under it. */
  private copy(held: MemoryRequest): FileRequest {
    return structuredClone(held.request);
  }

  /**
   * Open a request slot, as the plugin's `request_file` (`OpenFileRequestBody`)
   * or `request_secret` (`OpenSecretRequestBody`) would over the socket. The
   * body is parsed with the box's own schema, so the defaults are the box's:
   * a file request is `normal` and non-durable unless it says `secret`; a text
   * secret is durable, its slug `secretTextSlug` of `keys[0]` (or the slug it
   * names), and its file is `/run/hermetic/files/<slug>.env`. A key named
   * twice, or more than `SECRET_TEXT_MAX_KEYS` required and optional together,
   * is refused here, as the box refuses it. Fixture-only: no head calls this.
   */
  openRequest(
    agent: string,
    body: OpenFileRequestBody | OpenSecretRequestBody,
    opts: { session_id?: string; ttl_s?: number } = {},
  ): FileRequest {
    this.requireAgent(agent);
    const now = this.wallNow();
    for (const held of this.requests.values()) this.expireIfDue(held);
    const live = [...this.requests.values()].filter(
      (r) => r.agent === agent && isLive(r.request),
    ).length;
    if (live >= FILES_LIMITS.openRequests) {
      throw new HermeticError(
        "CONFLICT",
        `${agent}: ${FILES_LIMITS.openRequests} requests are already waiting for a file`,
        { name: agent },
      );
    }
    const session_id = opts.session_id ?? body.session_id;
    const ttl = opts.ttl_s ?? FILES_TTL.request;
    let request: FileRequest;
    if ("kind" in body && body.kind === "secret_text") {
      const parsed = OpenSecretRequestBody.parse(body);
      const all = [...parsed.keys, ...(parsed.optional_keys ?? [])];
      if (all.length > SECRET_TEXT_MAX_KEYS) {
        throw new HermeticError(
          "VALIDATION",
          `a secret request names at most ${SECRET_TEXT_MAX_KEYS} keys, required and optional together`,
        );
      }
      const twice = all.find((key, i) => all.indexOf(key) !== i);
      if (twice !== undefined) throw new HermeticError("VALIDATION", `${twice} is named twice`);
      const slug = this.textSlug(
        agent,
        parsed.keys,
        parsed.optional_keys ?? [],
        secretTextSlug(parsed.keys, parsed.slug),
      );
      request = {
        request_id: newRequestId(),
        kind: "secret_text",
        purpose: parsed.purpose,
        accept: [],
        max_bytes: FILES_LIMITS.secretTextBytes,
        sensitivity: "secret",
        durable: parsed.durable ?? true,
        state: "open",
        created_at: now.toISOString(),
        expires_at: isoAfter(now, ttl),
        keys: parsed.keys,
        ...(parsed.optional_keys?.length ? { optional_keys: parsed.optional_keys } : {}),
        slug,
        input: parsed.input ?? "auto",
        ...(session_id ? { session_id } : {}),
      };
    } else {
      const parsed = OpenFileRequestBody.parse(body);
      const sensitivity = parsed.sensitivity ?? "normal";
      const cap = classCap(sensitivity);
      request = {
        request_id: newRequestId(),
        kind: "file",
        purpose: parsed.purpose,
        ...(parsed.name_hint ? { name_hint: parsed.name_hint } : {}),
        accept: parsed.accept ?? [],
        max_bytes: Math.min(parsed.max_bytes ?? cap, cap),
        sensitivity,
        durable: parsed.durable ?? sensitivity === "secret",
        state: "open",
        created_at: now.toISOString(),
        expires_at: isoAfter(now, ttl),
        ...(session_id ? { session_id } : {}),
      };
    }
    this.requests.set(request.request_id, { agent, request, waiters: new Set() });
    return structuredClone(request);
  }

  /**
   * `base`, unless it is held for another secret — by a live text-secret
   * request with a different key set, or by a `secret`-dir `<slug>.env` entry
   * that is not this secret (`sameSecret`: a file secret's counts too, and a
   * removed entry no longer does): then `base-2`,
   * `base-3`, … — two different secrets must not write one `env-<slug>` slot.
   * The same secret asked for again keeps the slug, which is how it is rotated,
   * however long ago the request that first stored it was answered. The box's
   * `freeSlug`, rule for rule.
   */
  private textSlug(
    agent: string,
    required: readonly string[],
    optional: readonly string[],
    base: string,
  ): string {
    const want = [...required, ...optional].sort().join(",");
    for (let n = 1; ; n += 1) {
      const suffix = n === 1 ? "" : `-${n}`;
      const slug = `${base.slice(0, 48 - suffix.length).replace(/-+$/, "")}${suffix}`;
      const live = [...this.requests.values()].some(
        (r) =>
          r.agent === agent &&
          r.request.kind === "secret_text" &&
          isLive(r.request) &&
          r.request.slug === slug &&
          [...(r.request.keys ?? []), ...(r.request.optional_keys ?? [])].sort().join(",") !== want,
      );
      const stored = [...this.secretEntries.values()].some(
        (e) => e.agent === agent && e.name === `${slug}.env` && !this.sameSecret(e, required, want),
      );
      if (!live && !stored) return slug;
    }
  }

  /**
   * Whether a stored `<slug>.env` entry is the secret a new request asks for:
   * by its stored keys, or — none recorded, as for a file secret — by the key
   * set of the request it answered, while that is still held. A keyless entry
   * whose request is gone, or was a file request, is another secret.
   */
  private sameSecret(entry: FileEntry, required: readonly string[], want: string): boolean {
    if (entry.keys) return storedKeysFit(entry.keys, required);
    const from = entry.request_id ? this.requests.get(entry.request_id)?.request : undefined;
    return (
      from?.kind === "secret_text" &&
      [...(from.keys ?? []), ...(from.optional_keys ?? [])].sort().join(",") === want
    );
  }

  async request(agent: string, id: string, _opts: FilesCallOptions): Promise<FileRequest> {
    this.requireAgent(agent);
    return this.copy(this.slot(agent, id));
  }

  async list(agent: string, _opts: FilesCallOptions): Promise<FilesListResult> {
    this.requireAgent(agent);
    const now = this.host.now().getTime();
    const mine = [...this.entries.values()].filter(
      (e) => e.agent === agent && Date.parse(e.expires_at) > now,
    );
    const inbox = mine.filter((e) => e.state === "inbox").map((e) => this.listed(e));
    const requests: FileRequest[] = [];
    for (const held of this.requests.values()) {
      if (held.agent !== agent) continue;
      this.expireIfDue(held);
      requests.push(this.copy(held));
    }
    const secrets = [...this.secretEntries.values()]
      .filter((e) => e.agent === agent)
      .map(({ agent: _agent, ...entry }) => entry);
    return {
      inbox,
      outbox: [],
      secrets,
      requests,
      usage: {
        inbox_bytes: inbox.reduce((n, e) => n + e.bytes, 0),
        outbox_bytes: 0,
        retention_days: Math.round(FILES_TTL.inbox / 86_400),
      },
    };
  }

  private listed(e: MemoryFileEntry): FileEntry {
    return {
      id: e.id,
      dir: "inbox",
      class: e.class,
      name: e.name,
      bytes: e.bytes.byteLength,
      mime: e.mime,
      sha256: e.sha256,
      created_at: e.created_at,
      expires_at: e.expires_at,
      ...(e.rel ? { rel: e.rel } : {}),
      ...(e.path ? { path: e.path } : {}),
      from: { kind: "operator", login: FIXTURE_OPERATOR_LOGIN, node: "fixture" },
      ...(e.session_id ? { session_id: e.session_id } : {}),
    };
  }

  /** `takeSlot`: an `open` slot becomes `receiving`; anything else is refused with the box's code. */
  private take(agent: string, id: string): MemoryRequest {
    const held = this.slot(agent, id);
    if (held.request.state !== "open") throw requestStateRefusal(held.request.state, agent);
    held.request.state = "receiving";
    return held;
  }

  /** `rejectReceiving`: back to `open`, the refusal recorded for the card. */
  private reject(held: MemoryRequest, e: unknown): void {
    if (held.request.state !== "receiving") return;
    held.request.state = "open";
    const code: ErrorCode = e instanceof HermeticError ? e.code : "INTERNAL";
    const message = e instanceof HermeticError ? e.message : "the upload failed";
    held.request.rejected = { code, message, at: this.wallNow().toISOString() };
    this.wake(held);
  }

  private markFulfilled(
    held: MemoryRequest,
    fulfilled: Omit<NonNullable<FileRequest["fulfilled"]>, "at" | "by">,
  ): void {
    held.request.state = "fulfilled";
    held.request.fulfilled = {
      ...fulfilled,
      by: FIXTURE_OPERATOR_LOGIN,
      at: this.wallNow().toISOString(),
    };
    delete held.request.rejected;
    this.wake(held);
  }

  /**
   * `PUT /files/requests/:id`, with the box's checks: the slot's cap and accept
   * list, the digest, the key-material sniff (D6: forced to the secret lane
   * without `notSecret`), and for a text secret the authoritative parse, with
   * the operator's `secretAs`. Only a text secret's canonical bytes are kept.
   */
  async fulfil(
    agent: string,
    id: string,
    upload: FilesFulfilUpload,
    opts: FilesCallOptions & FilesProgress & FilesFulfilOptions,
  ): Promise<FilesFulfilResult> {
    this.requireAgent(agent);
    if (opts.signal?.aborted) throw new HermeticError("ABORTED", "the file transfer was stopped");
    const held = this.take(agent, id);
    try {
      return await this.receive(agent, held, upload, opts);
    } catch (e) {
      this.reject(held, e);
      throw e;
    }
  }

  private async receive(
    agent: string,
    held: MemoryRequest,
    upload: FilesFulfilUpload,
    opts: FilesCallOptions & FilesProgress & FilesFulfilOptions,
  ): Promise<FilesFulfilResult> {
    const slot = held.request;
    const name = this.requestFileName(agent, slot, upload.fileName);
    if (name.includes(E2E_FILE_TOO_LARGE)) throw filesRefusal("FILE_TOO_LARGE", agent);
    const textSecret = slot.kind === "secret_text";
    const cap = textSecret
      ? FILES_LIMITS.secretTextBytes
      : Math.min(slot.max_bytes, classCap(slot.sensitivity));
    if (upload.size > cap) throw filesRefusal("FILE_TOO_LARGE", agent);
    const bytes = await readAll(upload.body, opts.onProgress, opts.signal);
    if (bytes.byteLength !== upload.size) throw filesRefusal("FILE_DIGEST_MISMATCH", agent);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== upload.sha256.toLowerCase() || name.includes(E2E_FILE_DIGEST)) {
      throw filesRefusal("FILE_DIGEST_MISMATCH", agent);
    }

    if (textSecret) {
      const as = opts.secretAs ?? "auto";
      held.secretAs = as;
      const parsed = parseSecretEnv(bytes, secretSpec(slot), as);
      if (!parsed.ok) throw secretTextRefusal(agent, parsed.errors);
      const canonical = new TextEncoder().encode(parsed.canonical);
      const sha256 = createHash("sha256").update(canonical).digest("hex");
      // Just this once: the request's tmpfs drop, as on the box; never the durable directory.
      const path = `${FILES_DROP_DIR}/${slot.request_id}/${textStem(slot)}.env`;
      held.secretBytes = canonical;
      const keys = parsed.entries.map((e) => e.key);
      this.markFulfilled(held, {
        path,
        sha256,
        bytes: canonical.byteLength,
        class: "secret",
        keys,
        format: parsed.format,
      });
      return {
        request_id: slot.request_id,
        path,
        sha256,
        bytes: canonical.byteLength,
        class: "secret",
        keys,
        format: parsed.format,
      };
    }

    const head = bytes.subarray(0, FILES_LIMITS.sniffBytes);
    const mime = sniffMime(head, name);
    if (!acceptMatches(slot.accept, name, mime)) throw filesRefusal("FILE_TYPE_REJECTED", agent);
    const secretSlot = slot.sensitivity === "secret";
    const forced = !secretSlot && !opts.notSecret && looksLikeKeyMaterial(head, name);
    if (forced && bytes.byteLength > FILES_LIMITS.secretEphemeralBytes) {
      throw filesRefusal("FILE_LOOKS_SECRET", agent);
    }
    if (secretSlot || forced) {
      const path = `${FILES_DROP_DIR}/${slot.request_id}/${name}`;
      held.secretBytes = bytes.slice();
      this.markFulfilled(held, { path, sha256: sha, bytes: bytes.byteLength, class: "secret" });
      return {
        request_id: slot.request_id,
        path,
        sha256: sha,
        bytes: bytes.byteLength,
        class: "secret",
      };
    }
    const now = this.host.now();
    const fileId = newFileId();
    const rel = inboxRelPath(now, fileId, name);
    const entry: MemoryFileEntry = {
      id: fileId,
      agent,
      name,
      bytes: bytes.slice(),
      mime,
      sha256: sha,
      class: isImageMime(mime) ? "image" : "file",
      state: "inbox",
      created_at: now.toISOString(),
      expires_at: isoAfter(now, FILES_TTL.inbox),
      rel,
      path: `${HERMES_HOME}/${rel}`,
      ...(slot.session_id ? { session_id: slot.session_id } : {}),
    };
    this.entries.set(fileId, entry);
    this.markFulfilled(held, {
      path: entry.path as string,
      sha256: sha,
      bytes: bytes.byteLength,
      class: entry.class,
    });
    return {
      request_id: slot.request_id,
      path: entry.path as string,
      sha256: sha,
      bytes: bytes.byteLength,
      class: entry.class,
    };
  }

  /** The header's name, else the hint's last segment, else `upload`; sanitized either way. */
  private requestFileName(agent: string, slot: FileRequest, header: string): string {
    const raw = header !== "" ? header : (slot.name_hint?.split(/[/\\]/).pop() ?? "upload");
    const clean = sanitizeFileName(raw);
    if (!clean.ok) throw filesRefusal("FILE_NAME_INVALID", agent, undefined, { reason: clean.reason });
    return clean.name;
  }

  /**
   * `POST /files/requests/:id/secret`: read the slot the laptop wrote, from the
   * fixture's SSM parameters, the way the instance role would. The body is
   * held to the box's guards first (`expectSecret`): a text secret only from
   * its own `env-<slug>`, named `<slug>.env`, and only for a durable request.
   * Its stored bytes must then re-parse against the request's keys to exactly
   * themselves, the canonical form.
   */
  async secret(
    agent: string,
    id: string,
    body: FilesSecretBody,
    _opts: FilesCallOptions,
  ): Promise<FilesFulfilResult> {
    this.requireAgent(agent);
    const name = this.expectSecret(agent, this.slot(agent, id).request, body);
    const held = this.take(agent, id);
    try {
      return this.place(agent, held, body, name);
    } catch (e) {
      this.reject(held, e);
      throw e;
    }
  }

  /** The box's guards on a `/secret` body, before the slot is taken; the file name it must hold. */
  private expectSecret(agent: string, slot: FileRequest, body: FilesSecretBody): string {
    // As on the box: a secret slot opened `durable: false` takes no SSM slot,
    // a file one as much as a text one. A normal slot's `durable` is no choice.
    if (slot.sensitivity === "secret" && !slot.durable) {
      throw new HermeticError(
        "VALIDATION",
        `${agent}: this request is for this once; it does not take a stored secret`,
        { name: agent },
      );
    }
    if (slot.kind !== "secret_text") {
      if (!isFileSecretSlot(body.ssm_slot)) {
        throw new HermeticError("VALIDATION", `${agent}: ssm_slot must be a file-<slug> slot`, {
          name: agent,
        });
      }
      const clean = sanitizeFileName(body.name);
      if (!clean.ok)
        throw filesRefusal("FILE_NAME_INVALID", agent, undefined, { reason: clean.reason });
      return clean.name;
    }
    const own = envSecretSlot(textStem(slot));
    if (body.ssm_slot !== own) {
      throw new HermeticError(
        "VALIDATION",
        `${agent}: ssm_slot must be this request's own slot, ${own}`,
        {
          name: agent,
        },
      );
    }
    const name = `${textStem(slot)}.env`;
    if (body.name !== name) {
      throw new HermeticError(
        "VALIDATION",
        `${agent}: a text secret for this request is named ${name}`,
        {
          name: agent,
        },
      );
    }
    return name;
  }

  private place(
    agent: string,
    held: MemoryRequest,
    body: FilesSecretBody,
    name: string,
  ): FilesFulfilResult {
    const slot = held.request;
    const textSecret = slot.kind === "secret_text";
    const fleet = this.host.fleetId?.() ?? null;
    const raw =
      fleet === null ? undefined : this.host.readParam?.(agentParamPath(fleet, agent, body.ssm_slot));
    if (raw === undefined) {
      throw new HermeticError("NOT_FOUND", `${agent}: the secret's SSM slot is empty`, {
        name: agent,
      });
    }
    const envelope = decodeSecretEnvelope(raw);
    if (envelope === null) {
      throw new HermeticError("VALIDATION", `${agent}: the secret's SSM slot is not readable`, {
        name: agent,
      });
    }
    const sha256 = createHash("sha256").update(envelope.bytes).digest("hex");
    if (sha256 !== envelope.sha256) throw filesRefusal("FILE_DIGEST_MISMATCH", agent);
    if (envelope.name !== name) {
      throw new HermeticError("VALIDATION", `${agent}: the stored secret is not for this request`, {
        name: agent,
      });
    }
    let keys: string[] | undefined;
    let format: SecretTextFormat | undefined;
    if (textSecret) {
      const parsed = parseSecretEnv(envelope.bytes, secretSpec(slot), "dotenv");
      if (!parsed.ok) throw secretTextRefusal(agent, parsed.errors);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(envelope.bytes);
      } catch {
        throw new HermeticError("VALIDATION", `${agent}: the stored secret is not valid UTF-8`, {
          name: agent,
        });
      }
      if (canonicalSecretEnv(parsed.entries) !== text) {
        throw new HermeticError(
          "VALIDATION",
          `${agent}: the stored secret is not in canonical KEY="value" form for this request`,
          { name: agent },
        );
      }
      keys = parsed.entries.map((e) => e.key);
      format = body.format ?? "dotenv";
    }
    const path = `${FILES_SECRET_DIR}/${name}`;
    held.secretBytes = envelope.bytes;
    // One entry per slot: a re-sent secret replaces the old one, as on the box.
    for (const [entryId, e] of this.secretEntries) {
      if (e.agent === agent && e.slot === body.ssm_slot) this.secretEntries.delete(entryId);
    }
    const id = newFileId();
    this.secretEntries.set(id, {
      agent,
      id,
      dir: "secret",
      class: "secret",
      name,
      bytes: envelope.bytes.byteLength,
      mime: textSecret ? "text/plain" : "application/octet-stream",
      sha256,
      created_at: this.host.now().toISOString(),
      expires_at: null,
      path,
      from: { kind: "operator", login: FIXTURE_OPERATOR_LOGIN, node: "fixture" },
      request_id: slot.request_id,
      slot: body.ssm_slot,
      ...(keys ? { keys: [...keys] } : {}),
    });
    const fulfilled = {
      path,
      sha256,
      bytes: envelope.bytes.byteLength,
      class: "secret" as const,
      ...(keys ? { keys } : {}),
      ...(format ? { format } : {}),
    };
    this.markFulfilled(held, { ...fulfilled, ssm_slot: body.ssm_slot });
    return { request_id: slot.request_id, ...fulfilled };
  }

  async decline(
    agent: string,
    id: string,
    reason: string | undefined,
    _opts: FilesCallOptions,
  ): Promise<FileRequest> {
    this.requireAgent(agent);
    const held = this.slot(agent, id);
    if (held.request.state !== "open") throw requestStateRefusal(held.request.state, agent);
    held.request.state = "declined";
    held.request.declined = {
      ...(reason ? { reason } : {}),
      at: this.wallNow().toISOString(),
    };
    this.wake(held);
    return this.copy(held);
  }

  /** Fixture-only: the slot's timeout, now. A live slot becomes `expired`; anything else is unchanged. */
  expire(agent: string, id: string): FileRequest {
    const held = this.slot(agent, id);
    if (isLive(held.request)) {
      held.request.state = "expired";
      held.request.expires_at = this.wallNow().toISOString();
      this.wake(held);
    }
    return this.copy(held);
  }

  /**
   * Resolves at the slot's next change (fulfilled, rejected, declined,
   * expired), or when `signal` stops — the plugin's long-poll, one step of it.
   */
  changed(agent: string, id: string, signal?: AbortSignal): Promise<void> {
    const held = this.slot(agent, id);
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const done = (): void => {
        signal?.removeEventListener("abort", done);
        held.waiters.delete(done);
        resolve();
      };
      held.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * The plugin's `await_file`: the slot once it has left `open`/`receiving`,
   * or its current copy when `timeoutMs` runs out or `signal` stops first.
   */
  async waitFor(
    agent: string,
    id: string,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<FileRequest> {
    const timeout = opts.timeoutMs === undefined ? null : AbortSignal.timeout(opts.timeoutMs);
    const signals = [opts.signal, timeout].filter((s): s is AbortSignal => s != null);
    const stop = signals.length === 0 ? undefined : AbortSignal.any(signals);
    for (;;) {
      const held = this.slot(agent, id);
      if (!isLive(held.request) || stop?.aborted) return this.copy(held);
      await this.changed(agent, id, stop);
    }
  }

  /** Fixture-only: the "Treat as" the last text-secret fulfil carried to the box. */
  lastSecretAs(agent: string, id: string): SecretTextAs | undefined {
    const held = this.requests.get(id);
    return held !== undefined && held.agent === agent ? held.secretAs : undefined;
  }

  /** Fixture-only: every request slot on one agent's box, TTL applied, oldest first. */
  requestsFor(agent: string): FileRequest[] {
    const out: FileRequest[] = [];
    for (const held of this.requests.values()) {
      if (held.agent !== agent) continue;
      this.expireIfDue(held);
      out.push(this.copy(held));
    }
    return out;
  }
}

/** hermeticd's `classCap`: what a slot of this sensitivity may ever hold. */
function classCap(sensitivity: FileRequest["sensitivity"]): number {
  return sensitivity === "secret" ? FILES_LIMITS.secretEphemeralBytes : FILES_LIMITS.fileBytes;
}

/**
 * Whether a stored text secret is the one a request for `required` asks for:
 * every required key stored, and every stored key a required one (an optional
 * key does not count). hermeticd's `storedKeysFit`.
 */
function storedKeysFit(stored: readonly string[], required: readonly string[]): boolean {
  return required.every((k) => stored.includes(k)) && stored.every((k) => required.includes(k));
}

/** A text secret slot's file stem: its recorded slug, or (a slot from before slugs) what its keys derive. */
function textStem(slot: FileRequest): string {
  return slot.slug ?? secretTextSlug(slot.keys ?? []);
}

function secretSpec(slot: FileRequest): {
  keys: string[];
  optional_keys: string[];
  maxBytes: number;
} {
  return {
    keys: slot.keys ?? [],
    optional_keys: slot.optional_keys ?? [],
    maxBytes: FILES_LIMITS.secretTextBytes,
  };
}
