/**
 * Fixture mode's hermeticd files routes, for a head that speaks the tailnet
 * wire itself: the phone's fixture kit answers its `fetch` with this, so the
 * phone's real files client (`mobile/src/gateway/files.ts`) runs unchanged
 * against a canned box.
 *
 * It serves what the phone's attach path uses, and nothing else:
 *
 * - `GET /healthz`, with the `files` capability on every agent except
 *   `FIXTURE_NO_FILES_AGENT`;
 * - `PUT /files/stage/:name`, through the same checks `MemoryFiles.stage`
 *   makes (`fixtureStageName`, `fixtureStageChecks`, shared with it), so the
 *   `E2E_FILE_TOO_LARGE` and `E2E_FILE_DIGEST` name triggers behave here as
 *   they do on the desktop's fixture;
 * - `POST /files/:id/commit`, with the box's session rule;
 * - the request routes the phone answers an agent's ask with:
 *   `GET /files/requests`, `GET /files/requests/:id`, `PUT /files/requests/:id`
 *   (a file, or a text secret with the "Treat as" header, parsed by the same
 *   `parseSecretEnv` the box runs) and `POST /files/requests/:id/decline`.
 *   `POST /files/requests/:id/secret` answers `UNSUPPORTED`: it reads an SSM
 *   slot, and the phone has none to write.
 *
 * It is also the fixture chat's files service for the phone (`FixtureRequestFiles`):
 * `openRequest` and `waitFor` are what an `E2E_FILE_REQUEST*` or
 * `E2E_*SECRET*` turn opens its slot on and parks behind
 * (`fixture-chat-file-request.ts`), the way `MemoryFiles` serves the desktop's
 * fixture. The slot rules are `MemoryFiles`'s, minus what the phone cannot
 * reach (SSM slots, the secret directory's slug collisions).
 *
 * - `GET /files/:id/content`: the bytes of an entry this box holds — a staged
 *   or committed upload, a share, or one of the canned transcripts' files
 *   (`fixtureChatFileEntries`, served from every agent's box so a demo turn on
 *   any bot can show one) — with its type, length and `Content-Digest`.
 *
 * It is the `E2E_FILE_SHARE` turn's outbox too (`FixtureShareFiles`): `share`
 * files the bytes under a fresh `sh_` id from a counter and answers the
 * `ShareFileResult` the plugin returns, the way `MemoryFiles.share` does for
 * the desktop's fixture, so the share cards the turn draws load their bytes
 * from the same box.
 *
 * Any other files route is a 404 `NOT_FOUND`, which is also what an agent
 * without the capability answers for every files route, as a real hermeticd
 * built without the files service does (`rpc.ts` in agentd).
 *
 * Portable, because it is behind `@hermetic/core/chat-client-fixture`: no
 * node, no `Request`/`Response` (the caller wraps the plain answer), no
 * `crypto.getRandomValues` (ids come from a counter), no `structuredClone` or
 * `AbortSignal.timeout`, and no reach into the rest of `backend/`
 * (`test/chat-client-portable.test.ts`).
 */
import { HermeticError, isHermeticError } from "../../errors.ts";
import { filesRefusal, requestStateRefusal, secretTextRefusal } from "../../files/errors.ts";
import {
  type FileClass,
  type FileRequest,
  type FilesCommitResult,
  type FilesFulfilResult,
  type FilesStageResult,
  type RpcHealth,
  type ShareFileResult,
  OpenFileRequestBody,
  OpenSecretRequestBody,
} from "../../schema/index.ts";
import {
  CONTENT_DIGEST_HEADER,
  FILES_CAPABILITY,
  FILES_DROP_DIR,
  FILES_LIMITS,
  FILES_NAME_HEADER,
  FILES_NOT_SECRET_HEADER,
  FILES_SECRET_AS_HEADER,
  FILES_SESSION_HEADER,
  FILES_TTL,
  SECRET_TEXT_AS,
  formatContentDigest,
  SECRET_TEXT_MAX_KEYS,
  type SecretTextAs,
  acceptMatches,
  filesHttpStatus,
  inboxRelPath,
  isImageMime,
  outboxRelPath,
  looksLikeKeyMaterial,
  matchFilesRoute,
  parseContentDigest,
  sanitizeFileName,
  secretTextSlug,
  sniffMime,
} from "../../shared/files.ts";
import { HERMES_HOME } from "../../shared/hermes.ts";
import { RPC_PATHS, RPC_PROTOCOL_VERSION } from "../../shared/rpc.ts";
import { parseSecretEnv } from "../../shared/secret-env.ts";
import { sha256Hex } from "../../shared/sha256.ts";
import type { FixtureRequestFiles } from "./fixture-chat-file-request.ts";
import type { FixtureShareFiles } from "./fixture-chat-file-share.ts";
import { FIXTURE_CHAT_SCREENSHOT, fixtureChatFileEntries } from "./fixture-chat-files.ts";

/** `E2E_FILE_TOO_LARGE` anywhere in an attached file's name → `FILE_TOO_LARGE` (413). */
export const E2E_FILE_TOO_LARGE = "E2E_FILE_TOO_LARGE";
/** `E2E_FILE_DIGEST` anywhere in an attached file's name → `FILE_DIGEST_MISMATCH` (422). */
export const E2E_FILE_DIGEST = "E2E_FILE_DIGEST";

/**
 * The one fixture agent whose hermeticd reports no `files` capability: `ember`,
 * which the fixture seeds on hermeticd 0.4.0, from before the files service.
 */
export const FIXTURE_NO_FILES_AGENT = "ember";

/** The tailnet login the phone's fixture box records an answered request as from. */
export const FIXTURE_PHONE_LOGIN = "operator@fixture.example";

/**
 * A stage's file name, as the box would take it: sanitized, and refused at
 * once when it carries the `E2E_FILE_TOO_LARGE` trigger (before a byte is read,
 * as the box refuses an over-cap `Content-Length`).
 */
export function fixtureStageName(agent: string, fileName: string): string {
  const clean = sanitizeFileName(fileName);
  if (!clean.ok) throw filesRefusal("FILE_NAME_INVALID", agent, undefined, { reason: clean.reason });
  if (clean.name.includes(E2E_FILE_TOO_LARGE)) throw filesRefusal("FILE_TOO_LARGE", agent);
  return clean.name;
}

/**
 * The checks the box makes on a stage's bytes once they have all arrived: the
 * declared size, the digest (and the `E2E_FILE_DIGEST` trigger), the image or
 * file cap, and the key-material refusal. What it answers is the entry's
 * sniffed type, digest and class.
 */
export function fixtureStageChecks(
  agent: string,
  name: string,
  bytes: Uint8Array,
  expect: { size: number; sha256?: string | undefined; notSecret?: boolean | undefined },
): { mime: string; sha256: string; class: FileClass } {
  if (bytes.byteLength !== expect.size) throw filesRefusal("FILE_DIGEST_MISMATCH", agent);
  const sha256 = sha256Hex(bytes);
  if ((expect.sha256 && sha256 !== expect.sha256.toLowerCase()) || name.includes(E2E_FILE_DIGEST)) {
    throw filesRefusal("FILE_DIGEST_MISMATCH", agent);
  }
  const head = bytes.subarray(0, FILES_LIMITS.sniffBytes);
  const mime = sniffMime(head, name);
  const image = isImageMime(mime);
  if (bytes.byteLength > (image ? FILES_LIMITS.imageBytes : FILES_LIMITS.fileBytes)) {
    throw filesRefusal("FILE_TOO_LARGE", agent);
  }
  if (!expect.notSecret && looksLikeKeyMaterial(head, name)) {
    throw filesRefusal("FILE_LOOKS_SECRET", agent);
  }
  return { mime, sha256, class: image ? "image" : "file" };
}

/** One request to a fixture box's hermeticd, as plain data. */
export interface FixtureBoxRequest {
  method: string;
  /** The pathname, optionally with a query. */
  path: string;
  /** Header names in any case. */
  headers?: Readonly<Record<string, string>> | undefined;
  body?: Uint8Array | string | null | undefined;
}

/**
 * The box's answer: a status and a JSON body (`null` for none), or — for
 * `GET /files/:id/content` — the raw `bytes` with the `headers` that describe
 * them, in place of a JSON body.
 */
export interface FixtureBoxAnswer {
  status: number;
  body: unknown;
  bytes?: Uint8Array | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
}

export interface FixtureFilesBox extends FixtureRequestFiles, FixtureShareFiles {
  /**
   * The answer `agent`'s hermeticd gives `request`, or `null` when the path is
   * neither `/healthz` nor a files route (the caller answers those itself).
   */
  serve(agent: string, request: FixtureBoxRequest): Promise<FixtureBoxAnswer | null>;
  /** Fixture-only: every request slot on one agent's box, TTL applied, oldest first. */
  requestsFor(agent: string): FileRequest[];
}

export interface FixtureFilesBoxOptions {
  /** The box's clock, for expiry. Defaults to the wall clock. */
  now?: (() => Date) | undefined;
  /** Agents whose hermeticd serves no files. Defaults to `[FIXTURE_NO_FILES_AGENT]`. */
  noFiles?: readonly string[] | undefined;
  /** The `hermeticd_version` `/healthz` reports. */
  hermeticdVersion?: string | undefined;
}

interface Entry {
  agent: string;
  result: FilesStageResult;
  state: "staged" | "inbox" | "outbox";
  session_id?: string;
  rel?: string;
  /** What `GET /files/:id/content` serves; never kept for a secret. */
  bytes?: Uint8Array;
}

/** A canned transcript's file, served from every agent's box (`fixtureChatFileEntries`). */
interface SeededContent {
  bytes: Uint8Array;
  mime: string;
  sha256: string;
}

/** One request slot, and who is parked on it. */
interface HeldRequest {
  agent: string;
  request: FileRequest;
  waiters: Set<() => void>;
}

/** Live: still waiting for its file. */
function isLive(r: FileRequest): boolean {
  return r.state === "open" || r.state === "receiving";
}

/** A copy a caller may keep: plain JSON data, so no `structuredClone` is needed. */
function copyOf(r: FileRequest): FileRequest {
  return JSON.parse(JSON.stringify(r)) as FileRequest;
}

/** hermeticd's `classCap`: what a slot of this sensitivity may ever hold. */
function classCap(sensitivity: FileRequest["sensitivity"]): number {
  return sensitivity === "secret" ? FILES_LIMITS.secretEphemeralBytes : FILES_LIMITS.fileBytes;
}

const refusalBody = (code: string, message: string) => ({ error: { code, message } });

function refusalAnswer(e: unknown): FixtureBoxAnswer {
  if (isHermeticError(e)) {
    return { status: filesHttpStatus(e.code), body: refusalBody(e.code, e.message) };
  }
  return { status: 500, body: refusalBody("INTERNAL", "the fixture box failed") };
}

function header(request: FixtureBoxRequest, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (key.toLowerCase() === want) return value;
  }
  return undefined;
}

/**
 * The request body as the box's own bytes. A real box reads a copy off the
 * wire, so the routes zero what they were sent once a secret is filed; an
 * in-process caller hands over its own array, which must not be zeroed under
 * it (a shared test constant, or a buffer the caller still holds).
 */
function bodyBytes(body: FixtureBoxRequest["body"]): Uint8Array {
  if (body === null || body === undefined) return new Uint8Array(0);
  return typeof body === "string" ? new TextEncoder().encode(body) : body.slice();
}

function bodyText(body: FixtureBoxRequest["body"]): string {
  if (body === null || body === undefined) return "";
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

/** A fixture box's files routes, over an in-memory index shared by every agent it answers for. */
export function createFixtureFilesBox(opts: FixtureFilesBoxOptions = {}): FixtureFilesBox {
  const now = opts.now ?? (() => new Date());
  const noFiles = new Set(opts.noFiles ?? [FIXTURE_NO_FILES_AGENT]);
  const entries = new Map<string, Entry>();
  let counter = 0;
  /** `f_` + 12 of `[a-z0-9]`, from a counter: the phone's engine may lack `crypto.getRandomValues`. */
  const nextId = (): string => `f_fxphone${(counter++).toString(36).padStart(5, "0")}`;
  const requests = new Map<string, HeldRequest>();
  let requestCounter = 0;
  /** `fr_` + 12 of `[a-z0-9]`, from a counter, for the same reason. */
  const nextRequestId = (): string => `fr_fxphone${(requestCounter++).toString(36).padStart(5, "0")}`;
  let shareCounter = 0;
  /** `sh_` + 12 of `[a-z0-9]`, from a counter, for the same reason. */
  const nextShareId = (): string => `sh_fxphone${(shareCounter++).toString(36).padStart(5, "0")}`;
  const seeded = new Map<string, SeededContent>(
    [...fixtureChatFileEntries(), FIXTURE_CHAT_SCREENSHOT].map((e) => [
      e.id,
      { bytes: e.bytes, mime: e.mime, sha256: sha256Hex(e.bytes) },
    ]),
  );
  const isoAfter = (at: Date, seconds: number): string =>
    new Date(at.getTime() + seconds * 1000).toISOString();

  function wake(held: HeldRequest): void {
    const waiters = [...held.waiters];
    held.waiters.clear();
    for (const w of waiters) w();
  }

  function expireIfDue(held: HeldRequest): void {
    if (!isLive(held.request)) return;
    if (Date.parse(held.request.expires_at) > now().getTime()) return;
    held.request.state = "expired";
    wake(held);
  }

  /** A slot on `agent`'s box, its TTL applied, or `FILE_NOT_FOUND`. */
  function slot(agent: string, id: string): HeldRequest {
    const held = requests.get(id);
    if (held === undefined || held.agent !== agent) throw filesRefusal("FILE_NOT_FOUND", agent);
    expireIfDue(held);
    return held;
  }

  function openRequest(
    agent: string,
    body: Parameters<FixtureRequestFiles["openRequest"]>[1],
    opts: { session_id?: string; ttl_s?: number } = {},
  ): FileRequest {
    const at = now();
    for (const held of requests.values()) expireIfDue(held);
    const live = [...requests.values()].filter((r) => r.agent === agent && isLive(r.request)).length;
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
      request = {
        request_id: nextRequestId(),
        kind: "secret_text",
        purpose: parsed.purpose,
        accept: [],
        max_bytes: FILES_LIMITS.secretTextBytes,
        sensitivity: "secret",
        durable: parsed.durable ?? true,
        state: "open",
        created_at: at.toISOString(),
        expires_at: isoAfter(at, ttl),
        keys: parsed.keys,
        ...(parsed.optional_keys?.length ? { optional_keys: parsed.optional_keys } : {}),
        slug: secretTextSlug(parsed.keys, parsed.slug),
        input: parsed.input ?? "auto",
        ...(session_id ? { session_id } : {}),
      };
    } else {
      const parsed = OpenFileRequestBody.parse(body);
      const sensitivity = parsed.sensitivity ?? "normal";
      const cap = classCap(sensitivity);
      request = {
        request_id: nextRequestId(),
        kind: "file",
        purpose: parsed.purpose,
        ...(parsed.name_hint ? { name_hint: parsed.name_hint } : {}),
        accept: parsed.accept ?? [],
        max_bytes: Math.min(parsed.max_bytes ?? cap, cap),
        sensitivity,
        durable: parsed.durable ?? sensitivity === "secret",
        state: "open",
        created_at: at.toISOString(),
        expires_at: isoAfter(at, ttl),
        ...(session_id ? { session_id } : {}),
      };
    }
    requests.set(request.request_id, { agent, request, waiters: new Set() });
    return copyOf(request);
  }

  /**
   * The plugin's `await_file`: the slot once it has left `open`/`receiving`,
   * or its current copy when `timeoutMs` runs out or `signal` stops first.
   */
  async function waitFor(
    agent: string,
    id: string,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<FileRequest> {
    const deadline = opts.timeoutMs === undefined ? null : Date.now() + opts.timeoutMs;
    for (;;) {
      const held = slot(agent, id);
      const out = deadline !== null && Date.now() >= deadline;
      if (!isLive(held.request) || opts.signal?.aborted || out) return copyOf(held.request);
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const done = (): void => {
          if (timer !== null) clearTimeout(timer);
          opts.signal?.removeEventListener("abort", done);
          held.waiters.delete(done);
          resolve();
        };
        held.waiters.add(done);
        opts.signal?.addEventListener("abort", done, { once: true });
        if (deadline !== null) timer = setTimeout(done, Math.max(0, deadline - Date.now()));
      });
    }
  }

  /** `PUT /files/requests/:id`, with the box's checks; a refusal reopens the slot and is recorded. */
  function fulfil(agent: string, id: string, request: FixtureBoxRequest): FixtureBoxAnswer {
    const held = slot(agent, id);
    if (held.request.state !== "open") throw requestStateRefusal(held.request.state, agent);
    held.request.state = "receiving";
    try {
      const result = receive(agent, held, request);
      held.request.state = "fulfilled";
      const { request_id: _id, ...done } = result;
      held.request.fulfilled = { ...done, by: FIXTURE_PHONE_LOGIN, at: now().toISOString() };
      delete held.request.rejected;
      wake(held);
      return { status: 200, body: result };
    } catch (e) {
      held.request.state = "open";
      held.request.rejected = {
        code: isHermeticError(e) ? e.code : "INTERNAL",
        message: isHermeticError(e) ? e.message : "the upload failed",
        at: now().toISOString(),
      };
      wake(held);
      throw e;
    }
  }

  function receive(agent: string, held: HeldRequest, request: FixtureBoxRequest): FilesFulfilResult {
    const slotNow = held.request;
    const header_ = header(request, FILES_NAME_HEADER);
    let raw: string;
    try {
      raw = header_
        ? decodeURIComponent(header_)
        : (slotNow.name_hint?.split(/[/\\]/).pop() ?? "upload");
    } catch {
      throw filesRefusal("FILE_NAME_INVALID", agent);
    }
    const clean = sanitizeFileName(raw);
    if (!clean.ok) throw filesRefusal("FILE_NAME_INVALID", agent, undefined, { reason: clean.reason });
    const name = clean.name;
    if (name.includes(E2E_FILE_TOO_LARGE)) throw filesRefusal("FILE_TOO_LARGE", agent);
    const bytes = bodyBytes(request.body);
    const length = header(request, "content-length");
    const declared = length === undefined ? bytes.byteLength : Number(length);
    const textSecret = slotNow.kind === "secret_text";
    const cap = textSecret
      ? FILES_LIMITS.secretTextBytes
      : Math.min(slotNow.max_bytes, classCap(slotNow.sensitivity));
    if (declared > cap) throw filesRefusal("FILE_TOO_LARGE", agent);
    if (bytes.byteLength !== declared) throw filesRefusal("FILE_DIGEST_MISMATCH", agent);
    const sha = sha256Hex(bytes);
    const want = parseContentDigest(header(request, CONTENT_DIGEST_HEADER));
    if ((want && sha !== want.toLowerCase()) || name.includes(E2E_FILE_DIGEST)) {
      throw filesRefusal("FILE_DIGEST_MISMATCH", agent);
    }

    if (textSecret) {
      const asHeader = header(request, FILES_SECRET_AS_HEADER) ?? "auto";
      if (!(SECRET_TEXT_AS as readonly string[]).includes(asHeader)) {
        throw new HermeticError(
          "VALIDATION",
          `${FILES_SECRET_AS_HEADER} must be one of ${SECRET_TEXT_AS.join(", ")}`,
        );
      }
      const parsed = parseSecretEnv(
        bytes,
        {
          keys: slotNow.keys ?? [],
          optional_keys: slotNow.optional_keys ?? [],
          maxBytes: FILES_LIMITS.secretTextBytes,
        },
        asHeader as SecretTextAs,
      );
      bytes.fill(0);
      if (!parsed.ok) throw secretTextRefusal(agent, parsed.errors);
      // Only the canonical form's digest and size are kept: never the value.
      const canonical = new TextEncoder().encode(parsed.canonical);
      const sha256 = sha256Hex(canonical);
      const size = canonical.byteLength;
      canonical.fill(0);
      const stem = slotNow.slug ?? secretTextSlug(slotNow.keys ?? []);
      return {
        request_id: slotNow.request_id,
        path: `${FILES_DROP_DIR}/${slotNow.request_id}/${stem}.env`,
        sha256,
        bytes: size,
        class: "secret",
        keys: parsed.entries.map((e) => e.key),
        format: parsed.format,
      };
    }

    const head = bytes.subarray(0, FILES_LIMITS.sniffBytes);
    const mime = sniffMime(head, name);
    if (!acceptMatches(slotNow.accept, name, mime)) throw filesRefusal("FILE_TYPE_REJECTED", agent);
    const secretSlot = slotNow.sensitivity === "secret";
    const notSecret = header(request, FILES_NOT_SECRET_HEADER) === "1";
    const forced = !secretSlot && !notSecret && looksLikeKeyMaterial(head, name);
    if (forced && bytes.byteLength > FILES_LIMITS.secretEphemeralBytes) {
      throw filesRefusal("FILE_LOOKS_SECRET", agent);
    }
    if (secretSlot || forced) {
      bytes.fill(0);
      return {
        request_id: slotNow.request_id,
        path: `${FILES_DROP_DIR}/${slotNow.request_id}/${name}`,
        sha256: sha,
        bytes: declared,
        class: "secret",
      };
    }
    const at = now();
    const result: FilesStageResult = {
      id: nextId(),
      name,
      bytes: bytes.byteLength,
      mime,
      sha256: sha,
      class: isImageMime(mime) ? "image" : "file",
      expires_at: isoAfter(at, FILES_TTL.inbox),
    };
    const rel = inboxRelPath(at, result.id, name);
    entries.set(result.id, {
      agent,
      result,
      state: "inbox",
      rel,
      bytes: bytes.slice(),
      ...(slotNow.session_id ? { session_id: slotNow.session_id } : {}),
    });
    return {
      request_id: slotNow.request_id,
      path: `${HERMES_HOME}/${rel}`,
      sha256: sha,
      bytes: bytes.byteLength,
      class: result.class,
    };
  }

  function decline(agent: string, id: string, request: FixtureBoxRequest): FixtureBoxAnswer {
    const text = bodyText(request.body).trim();
    let reason: string | undefined;
    if (text !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new HermeticError("VALIDATION", "the decline body is not JSON");
      }
      const raw = (parsed as { reason?: unknown } | null)?.reason;
      if (raw !== undefined && typeof raw !== "string") {
        throw new HermeticError("VALIDATION", "reason must be a string");
      }
      reason = raw;
    }
    const held = slot(agent, id);
    if (held.request.state !== "open") throw requestStateRefusal(held.request.state, agent);
    held.request.state = "declined";
    held.request.declined = { ...(reason ? { reason } : {}), at: now().toISOString() };
    wake(held);
    return { status: 200, body: copyOf(held.request) };
  }

  function requestsFor(agent: string): FileRequest[] {
    const out: FileRequest[] = [];
    for (const held of requests.values()) {
      if (held.agent !== agent) continue;
      expireIfDue(held);
      out.push(copyOf(held.request));
    }
    return out;
  }

  function stage(agent: string, rawName: string, request: FixtureBoxRequest): FixtureBoxAnswer {
    const name = fixtureStageName(agent, rawName);
    const bytes = bodyBytes(request.body);
    const length = header(request, "content-length");
    const checked = fixtureStageChecks(agent, name, bytes, {
      size: length === undefined ? bytes.byteLength : Number(length),
      sha256: parseContentDigest(header(request, CONTENT_DIGEST_HEADER)) ?? undefined,
      notSecret: header(request, FILES_NOT_SECRET_HEADER) === "1",
    });
    const at = now();
    const result: FilesStageResult = {
      id: nextId(),
      name,
      bytes: bytes.byteLength,
      mime: checked.mime,
      sha256: checked.sha256,
      class: checked.class,
      expires_at: new Date(at.getTime() + FILES_TTL.stage * 1000).toISOString(),
    };
    const session = header(request, FILES_SESSION_HEADER);
    entries.set(result.id, {
      agent,
      result,
      state: "staged",
      bytes: bytes.slice(),
      ...(session ? { session_id: session } : {}),
    });
    return { status: 201, body: result };
  }

  function commit(agent: string, id: string, request: FixtureBoxRequest): FixtureBoxAnswer {
    const text = bodyText(request.body).trim();
    let session: string | undefined;
    if (text !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new HermeticError("VALIDATION", "the commit body is not JSON");
      }
      const raw = (parsed as { session_id?: unknown } | null)?.session_id;
      if (raw !== undefined && typeof raw !== "string") {
        throw new HermeticError("VALIDATION", "session_id must be a string");
      }
      session = raw;
    }
    const entry = entries.get(id);
    if (entry === undefined || entry.agent !== agent) throw filesRefusal("FILE_NOT_FOUND", agent);
    if (Date.parse(entry.result.expires_at) <= now().getTime()) {
      entries.delete(id);
      throw filesRefusal("FILE_NOT_FOUND", agent);
    }
    // As on the box: a second commit answers what the first did; only a staged
    // entry is held to the session it was staged for.
    if (entry.state === "staged" && session && entry.session_id && session !== entry.session_id) {
      throw new HermeticError("CONFLICT", `${agent}: that file was staged for another session`);
    }
    if (entry.state === "staged") {
      const at = now();
      entry.state = "inbox";
      entry.rel = inboxRelPath(at, entry.result.id, entry.result.name);
      entry.result = {
        ...entry.result,
        expires_at: new Date(at.getTime() + FILES_TTL.inbox * 1000).toISOString(),
      };
      if (session) entry.session_id = session;
    }
    const rel = entry.rel ?? "";
    const { expires_at: _expires, ...file } = entry.result;
    const committed: FilesCommitResult = { ...file, rel, path: `${HERMES_HOME}/${rel}` };
    return { status: 200, body: committed };
  }

  /**
   * Fixture-only: what `POST /outbox` leaves behind for a file the agent
   * shared (`MemoryFiles.share`, portably): an outbox entry under a fresh `sh_`
   * id, sniffed and digested, and the `ShareFileResult` the plugin returns.
   */
  function share(
    agent: string,
    file: { name: string; bytes: Uint8Array; note?: string; session_id?: string },
  ): ShareFileResult {
    const clean = sanitizeFileName(file.name);
    if (!clean.ok) throw filesRefusal("FILE_NAME_INVALID", agent, undefined, { reason: clean.reason });
    const at = now();
    const bytes = file.bytes.slice();
    const mime = sniffMime(bytes.subarray(0, FILES_LIMITS.sniffBytes), clean.name);
    const sha256 = sha256Hex(bytes);
    const id = nextShareId();
    entries.set(id, {
      agent,
      result: {
        id,
        name: clean.name,
        bytes: bytes.byteLength,
        mime,
        sha256,
        class: isImageMime(mime) ? "image" : "file",
        expires_at: isoAfter(at, FILES_TTL.outbox),
      },
      state: "outbox",
      rel: outboxRelPath(id, clean.name),
      bytes,
      ...(file.session_id ? { session_id: file.session_id } : {}),
    });
    return { share_id: id, name: clean.name, bytes: bytes.byteLength, mime, sha256 };
  }

  /** `GET /files/:id/content`: an entry's bytes, typed and digested, or `FILE_NOT_FOUND`. */
  function content(agent: string, id: string): FixtureBoxAnswer {
    const entry = entries.get(id);
    let served: SeededContent | undefined;
    if (entry !== undefined && entry.agent === agent && entry.bytes !== undefined) {
      if (Date.parse(entry.result.expires_at) <= now().getTime()) {
        entries.delete(id);
        throw filesRefusal("FILE_NOT_FOUND", agent);
      }
      served = { bytes: entry.bytes, mime: entry.result.mime, sha256: entry.result.sha256 };
    } else {
      served = seeded.get(id);
    }
    if (served === undefined) throw filesRefusal("FILE_NOT_FOUND", agent);
    return {
      status: 200,
      body: null,
      bytes: served.bytes.slice(),
      headers: {
        "content-type": served.mime,
        "content-length": String(served.bytes.byteLength),
        [CONTENT_DIGEST_HEADER]: formatContentDigest(served.sha256),
      },
    };
  }

  return {
    openRequest,
    waitFor,
    requestsFor,
    share,
    async serve(agent, request) {
      const method = request.method.toUpperCase();
      const pathname = request.path.split("?")[0] ?? request.path;
      if (method === "GET" && pathname === RPC_PATHS.health) {
        const health: RpcHealth = {
          name: agent,
          hermeticd_version: opts.hermeticdVersion ?? "0.0.0-fixture",
          protocol: RPC_PROTOCOL_VERSION,
          config_hash: null,
          ...(noFiles.has(agent) ? {} : { capabilities: [FILES_CAPABILITY] }),
        };
        return { status: 200, body: health };
      }
      if (pathname !== "/files" && !pathname.startsWith("/files/")) return null;
      const route = noFiles.has(agent) ? null : matchFilesRoute(method, request.path);
      try {
        if (route?.route === "stage") return stage(agent, route.name, request);
        if (route?.route === "commit") return commit(agent, route.id, request);
        if (route?.route === "requests") return { status: 200, body: { requests: requestsFor(agent) } };
        if (route?.route === "request")
          return { status: 200, body: copyOf(slot(agent, route.id).request) };
        if (route?.route === "fulfil") return fulfil(agent, route.id, request);
        if (route?.route === "requestDecline") return decline(agent, route.id, request);
        if (route?.route === "content") return content(agent, route.id);
        if (route?.route === "requestSecret") {
          return {
            status: 501,
            body: refusalBody(
              "UNSUPPORTED",
              `${agent}: the fixture box has no SSM slots; send the secret just this once`,
            ),
          };
        }
      } catch (e) {
        return refusalAnswer(e);
      }
      return {
        status: 404,
        body: refusalBody(
          "NOT_FOUND",
          `no such route: ${method} ${pathname.startsWith("/files/stage/") ? "/files/stage/…" : pathname}`,
        ),
      };
    },
  };
}
