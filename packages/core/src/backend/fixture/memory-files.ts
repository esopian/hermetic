import { createHash } from "node:crypto";
import { HermeticError } from "../../errors.ts";
import { filesRefusal } from "../../files/errors.ts";
import type { FileClass, FilesCommitResult, FilesStageResult } from "../../schema/index.ts";
import {
  FILES_LIMITS,
  FILES_TTL,
  inboxRelPath,
  isImageMime,
  looksLikeKeyMaterial,
  newFileId,
  sanitizeFileName,
  sniffMime,
} from "../../shared/files.ts";
import { HERMES_HOME } from "../../shared/hermes.ts";
import type {
  FilesApi,
  FilesCallOptions,
  FilesContent,
  FilesContentOptions,
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
}
