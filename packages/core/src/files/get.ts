import { createHash, randomUUID } from "node:crypto";
import { open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CoreContext } from "../context.ts";
import { HermeticError } from "../errors.ts";
import { evt } from "../events.ts";
import {
  type FileEntry,
  FilesGetInput,
  type FilesGetEvent,
  type FilesGetProgressEvent,
  type FilesListResult,
} from "../schema/index.ts";
import { FILES_LIMITS, sanitizeFileName } from "../shared/files.ts";
import { validateName } from "../shared/naming.ts";
import { filesRefusal } from "./errors.ts";
import { aborted } from "./stage.ts";

/**
 * `files.get` (§9): one inbox file or outbox share from an agent's box to this
 * laptop — the only file the laptop ever writes for the files service.
 *
 * - Secret entries never leave the box. The listing's class is checked before
 *   anything is fetched, and hermeticd refuses the content route for a secret
 *   on its own (`FILE_SECRET_FORBIDDEN`), so a listing that lied is caught
 *   twice.
 * - The destination is created exclusively (`wx`) before a byte is fetched: an
 *   existing path is refused, never overwritten, and a failure at any later
 *   point unlinks the partial file this call created.
 * - The bytes are checked three ways before they are written: the box's own
 *   `Content-Length` and `Content-Digest` (`aws/files-http.ts`), then their
 *   length and SHA-256 against the listing the operator chose from.
 *
 * Nothing here names the file or the path in a message or a progress event;
 * the terminal `saved` event carries the name, as data for the head.
 */

export interface GetDeps {
  ctx: CoreContext;
  destinations: SaveDestinations;
}

/**
 * The folders the desktop head's save dialog chose (`files.saveNative`), by
 * an opaque `sv_…` id, so the page can name one without ever holding its path.
 * In memory only; each id is used once, and forgotten after an hour unused.
 */
export interface SaveDestinations {
  register(folder: string): Promise<{ dest_id: string }>;
  /** The folder an id names, keeping it. Refuses an unknown or expired id. */
  peek(destId: string): string;
  /** The folder an id names, forgetting it. Refuses an unknown or expired id. */
  take(destId: string): string;
}

const DEST_TTL_MS = 60 * 60 * 1000;

export function createSaveDestinations(deps: { now?: () => number } = {}): SaveDestinations {
  const now = deps.now ?? (() => Date.now());
  const held = new Map<string, { folder: string; at: number }>();
  const sweep = (): void => {
    for (const [id, d] of held) if (now() - d.at > DEST_TTL_MS) held.delete(id);
  };
  const peek = (destId: string): string => {
    sweep();
    const d = held.get(destId);
    if (d === undefined) {
      throw new HermeticError("NOT_FOUND", "no such save destination; choose the folder again");
    }
    return d.folder;
  };
  return {
    async register(folder) {
      sweep();
      let isDir = false;
      try {
        isDir = (await stat(folder)).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) throw new HermeticError("NOT_FOUND", "the chosen folder cannot be read");
      const dest_id = `sv_${randomUUID()}`;
      held.set(dest_id, { folder, at: now() });
      return { dest_id };
    },
    peek,
    take(destId) {
      const folder = peek(destId);
      held.delete(destId);
      return folder;
    },
  };
}

function parseInput(input: unknown): FilesGetInput {
  const result = FilesGetInput.safeParse(input);
  if (result.success) return result.data;
  throw new HermeticError("VALIDATION", "files get input does not validate", {
    issues: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  });
}

/**
 * The entry `id` names in a listing, or `FILE_NOT_FOUND`; a secret, wherever
 * it is listed, is `FILE_SECRET_FORBIDDEN`.
 */
export function downloadable(listing: FilesListResult, agent: string, id: string): FileEntry {
  if (listing.secrets.some((e) => e.id === id)) throw filesRefusal("FILE_SECRET_FORBIDDEN", agent);
  const entry = [...listing.inbox, ...listing.outbox].find((e) => e.id === id);
  if (entry === undefined) throw filesRefusal("FILE_NOT_FOUND", agent);
  if (entry.class === "secret" || entry.dir === "secret" || entry.dir === "drop") {
    throw filesRefusal("FILE_SECRET_FORBIDDEN", agent);
  }
  return entry;
}

function mismatch(agent: string, why: string): HermeticError {
  return new HermeticError("FILE_DIGEST_MISMATCH", `${agent}: ${why}`, { name: agent });
}

/**
 * What a head may do with a file once it is written and verified, before the
 * stream reports it saved: the desktop head marks it quarantined on macOS
 * (`main/quarantine.ts`). Best effort — a hook that throws leaves the saved
 * file as it is and the get still succeeds. Called with the path, which core
 * never records.
 */
export type AfterWrite = (path: string) => Promise<void>;

export interface FilesGetOptions {
  signal?: AbortSignal;
  afterWrite?: AfterWrite;
}

export function createFilesGet(deps: GetDeps) {
  const { ctx, destinations } = deps;

  function progress(phase: string, at: number, message: string): FilesGetProgressEvent {
    return { type: "progress", ...evt(phase, at, message, ctx.nowIso()) };
  }

  /**
   * Where the file goes: the CLI's path as given, or `<folder>/<sanitized
   * name>`, with the name it is saved under. The save dialog's id is only
   * read here; it is spent once the create succeeded, so a refused create
   * (`CONFLICT`) leaves it usable for another file.
   */
  function target(
    dest: FilesGetInput["dest"],
    entry: FileEntry,
  ): { path: string; name: string; destId: string | null } {
    if ("path" in dest) return { path: dest.path, name: entry.name, destId: null };
    const folder = destinations.peek(dest.dest_id);
    const clean = sanitizeFileName(entry.name);
    if (!clean.ok) {
      throw new HermeticError("FILE_NAME_INVALID", `that file name is not allowed (${clean.reason})`, {
        reason: clean.reason,
      });
    }
    return { path: join(folder, clean.name), name: clean.name, destId: dest.dest_id };
  }

  /**
   * `files.get`. Input is checked before the stream is returned, so a head
   * gets a `VALIDATION` refusal rather than a stream that fails on its first
   * step.
   */
  function get(input: unknown, opts: FilesGetOptions = {}): AsyncIterable<FilesGetEvent> {
    const parsed = parseInput(input);
    validateName(parsed.name);
    const agent = parsed.name;
    return (async function* (): AsyncGenerator<FilesGetEvent> {
      const signal = opts.signal ?? new AbortController().signal;
      let created: string | null = null;
      try {
        aborted(signal);
        await ctx.guardFleet();
        await ctx.getAgent(agent);
        yield progress("list", 0.05, "reading the box's file list");
        const listing = await ctx.backend.files.list(agent, { signal });
        const entry = downloadable(listing, agent, parsed.id);
        if (entry.bytes > FILES_LIMITS.fileBytes) {
          throw new HermeticError(
            "FILE_TOO_LARGE",
            `${agent}: the file is over the ${FILES_LIMITS.fileBytes}-byte download limit`,
            { name: agent, bytes: entry.bytes, max_bytes: FILES_LIMITS.fileBytes },
          );
        }
        aborted(signal);

        const { path, name: savedName, destId } = target(parsed.dest, entry);
        let handle: Awaited<ReturnType<typeof open>>;
        try {
          handle = await open(path, "wx");
        } catch (e) {
          const code = (e as NodeJS.ErrnoException | undefined)?.code;
          if (code === "EEXIST") {
            throw new HermeticError("CONFLICT", "a file already exists at the destination", {
              exists: true,
            });
          }
          throw new HermeticError("NOT_FOUND", "the destination cannot be written", {
            ...(code ? { errno: code } : {}),
          });
        }
        created = path;
        try {
          // Spent only now: a create refused above leaves the folder's id usable.
          if (destId !== null) destinations.take(destId);
          yield progress("fetch", 0.1, `fetching ${entry.bytes} bytes from ${agent}`);
          const content = await ctx.backend.files.content(agent, entry.id, {
            signal,
            // Exactly what the listing promised (itself within the cap, above):
            // a box that sends more is refused before the excess is read.
            maxBytes: entry.bytes,
          });
          aborted(signal);
          yield progress("verify", 0.8, "checking the bytes against the box's listing");
          const sha256 = createHash("sha256").update(content.bytes).digest("hex");
          if (content.bytes.byteLength !== entry.bytes) {
            throw mismatch(agent, "the file the box sent is not the size it listed");
          }
          if (sha256 !== content.sha256 || sha256 !== entry.sha256) {
            throw mismatch(agent, "the file the box sent does not match its digest");
          }
          yield progress("write", 0.9, "writing the file");
          let at = 0;
          while (at < content.bytes.byteLength) {
            const { bytesWritten } = await handle.write(content.bytes, at);
            at += bytesWritten;
          }
          await handle.sync();
        } finally {
          await handle.close().catch(() => undefined);
        }
        aborted(signal);
        created = null;
        if (opts.afterWrite !== undefined) {
          try {
            await opts.afterWrite(path);
          } catch {
            // Best effort: the file is written and verified either way.
          }
        }
        yield {
          type: "saved",
          file: {
            id: entry.id,
            name: savedName,
            bytes: entry.bytes,
            mime: entry.mime,
            sha256: entry.sha256,
          },
        };
      } catch (e) {
        if (created !== null) {
          await unlink(created).catch(() => undefined);
          created = null;
        }
        if (signal.aborted && !(e instanceof HermeticError && e.code === "ABORTED")) {
          throw new HermeticError("ABORTED", "the file transfer was stopped");
        }
        throw e;
      } finally {
        // A consumer that stopped reading early (`break`) leaves no partial file.
        if (created !== null) await unlink(created).catch(() => undefined);
      }
    })();
  }

  return { get };
}
