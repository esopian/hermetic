/**
 * Socket `POST /outbox` — `share_file`: the agent hands the operator a copy of
 * a file it made.
 *
 * The path is the agent's, so every check is hermeticd's (`share-policy.ts`):
 * the written path and the path `realpath` resolves *as hermes* must both be
 * under `/data/hermes`, outside the outbox, and clear of the credential
 * denylist; the target must be a regular file within the fleet's
 * `files.max_bytes`; and nothing the box holds as a secret, nor anything whose
 * head reads as private key material, is ever copied.
 *
 * Then a **copy**, never a link or a move: read as hermes, hashed and counted
 * as it streams, written as hermes into `${FILES_OUTBOX_DIR}/<share_id>/<name>`
 * at 0600 through the same exclusive part-file-then-rename the uploads use
 * (`writeIntoPlace`). The original is untouched, and what the operator
 * downloads is what was shared, whatever the agent does to its file after.
 * The share expires after `FILES_TTL.outbox`; the sweeper removes it.
 *
 * The check and the read are separate steps, so an account that swaps a path
 * component between them reads something else — still only what hermes can
 * read, still under the size the copy was sized for, and still put through the
 * key-material sniff, which runs on the bytes actually copied. A refusal names
 * its reason and never the file's contents; the log line names neither the
 * path nor the name.
 */
import { FileEntry, type ShareFileBody, type ShareFileResult } from "@hermetic/core/schema";
import {
  FILES_LIMITS,
  FILES_OUTBOX_DIR,
  FILES_TTL,
  HERMES_ACCOUNT,
  HERMES_HOME,
  looksLikeKeyMaterial,
  newShareId,
  sanitizeFileName,
  sniffMime,
} from "@hermetic/core/shared";
import { type FilesCtx, auditFiles, isoAfter, nowIso } from "./context.ts";
import { isSecret } from "./entries.ts";
import { FilesError } from "./errors.ts";
import { removeTreeAsHermes, resolveAsHermes } from "./fs-ops.ts";
import { classFor, writeIntoPlace } from "./receive.ts";
import { checkSharePath, normaliseSharePath } from "./share-policy.ts";
import { MeteredBody, checkDiskFloor } from "./upload.ts";

function refused(code: string, why: string): FilesError {
  return new FilesError(code, `share refused: ${why}`);
}

function capText(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1 ? `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB` : `${bytes} bytes`;
}

/** The share's name: the agent's `name` if it gave one, else the file's own, through the one sanitizer. */
function shareName(body: ShareFileBody, path: string): string {
  const raw = body.name ?? path.slice(path.lastIndexOf("/") + 1);
  const clean = sanitizeFileName(raw);
  if (!clean.ok) {
    throw refused(
      "FILE_NAME_INVALID",
      `the file name is not allowed (${clean.reason}); pass a plain name such as report.pdf`,
    );
  }
  return clean.name;
}

/** Whether the box holds `path` (as written or resolved) as a secret: the drop, tmpfs, or a secret-class entry. */
function heldAsSecret(ctx: FilesCtx, paths: readonly string[]): boolean {
  return ctx.store
    .read()
    .entries.some((e) => isSecret(e) && e.path !== undefined && paths.includes(e.path));
}

/** The answer when the plugin hung up: nobody reads it, but the copy and its directory are gone. */
function abandoned(): FilesError {
  return new FilesError("VALIDATION", "share abandoned: the caller went away", 408);
}

/**
 * `POST /outbox`. Refusals are `FilesError`s whose message starts `share refused:`.
 *
 * `signal` is the socket request's: the plugin gives up on a share it no
 * longer has time for (its hook has a deadline). It is checked before the
 * work, on every read of the copy, before the index write and again right
 * after it. A share abandoned at any of those points answers 408 and leaves
 * nothing: no copy, no directory, no index entry. Only a hang-up after the
 * second check, once the share is indexed and answered, leaves the share; the
 * 24 h sweep owns it from there.
 */
export async function shareFile(
  ctx: FilesCtx,
  body: ShareFileBody,
  signal?: AbortSignal,
): Promise<ShareFileResult> {
  try {
    return await share(ctx, body, signal);
  } catch (e) {
    // The code only: the path and the name can themselves be the secret.
    if (e instanceof FilesError) ctx.log(`files share refused: ${e.code}`);
    throw e;
  }
}

async function share(
  ctx: FilesCtx,
  body: ShareFileBody,
  signal: AbortSignal | undefined,
): Promise<ShareFileResult> {
  if (signal?.aborted) throw abandoned();
  const requested = normaliseSharePath(body.path);
  checkSharePath(requested);
  const found = await resolveAsHermes(ctx.host, requested);
  if (found.kind === "missing") throw refused("FILE_NOT_FOUND", "no such file on this box");
  if (found.kind === "other") throw refused("VALIDATION", "only a regular file can be shared");
  const resolved = found.path;
  checkSharePath(resolved);
  if (heldAsSecret(ctx, [requested, resolved])) {
    throw refused("FILE_SECRET_FORBIDDEN", "secret files never leave the box");
  }
  const name = shareName(body, requested);
  const cap = ctx.settings().max_bytes;
  if (found.size > cap) {
    throw refused("FILE_TOO_LARGE", `the file is over this fleet's cap of ${capText(cap)}`);
  }
  await checkDiskFloor(ctx.host, found.size);

  const meter = new MeteredBody(ctx.host.readStreamAs(HERMES_ACCOUNT, resolved), found.size, {
    ...(ctx.uploadIdleMs !== undefined ? { idleMs: ctx.uploadIdleMs } : {}),
    // Each read checks it: a caller that hung up stops the copy at the next chunk.
    ...(signal ? { signal } : {}),
  });
  let head: Uint8Array;
  try {
    head = await meter.head(FILES_LIMITS.sniffBytes);
  } catch {
    await meter.discard();
    if (signal?.aborted) throw abandoned();
    throw refused("FILE_NOT_FOUND", "the file could not be read");
  }
  const original = resolved.slice(resolved.lastIndexOf("/") + 1);
  if (looksLikeKeyMaterial(head, name) || looksLikeKeyMaterial(head, original)) {
    await meter.discard();
    throw refused("FILE_SECRET_FORBIDDEN", "the file looks like private key material");
  }

  const id = newShareId();
  const dir = `${FILES_OUTBOX_DIR}/${id}`;
  const path = `${dir}/${name}`;
  let sha256: string;
  try {
    sha256 = await writeIntoPlace(
      ctx,
      meter,
      { declared: found.size, digest: null, notSecret: false },
      [FILES_OUTBOX_DIR],
      dir,
      path,
    );
  } catch (e) {
    // `writeIntoPlace` has already removed the share's directory.
    if (signal?.aborted) throw abandoned();
    // The file grew or shrank under the copy: what was checked is not what was read.
    const changed =
      e instanceof FilesError &&
      (e.code === "FILE_TOO_LARGE" || (e.code === "VALIDATION" && e.status === 400));
    if (changed) {
      throw refused("CONFLICT", "the file changed while it was being copied; try again");
    }
    throw e;
  }
  const mime = sniffMime(head, name);
  let stored: FileEntry;
  try {
    // The copy is on disk from here: anything that keeps it out of the index removes it.
    if (signal?.aborted) throw abandoned();
    stored = FileEntry.parse({
      id,
      dir: "outbox",
      class: classFor(mime, found.size),
      name,
      bytes: found.size,
      mime,
      sha256,
      created_at: nowIso(ctx.host),
      expires_at: isoAfter(ctx.host, FILES_TTL.outbox),
      rel: path.slice(HERMES_HOME.length + 1),
      path,
      from: { kind: "agent" },
      ...(body.note ? { note: body.note } : {}),
    });
    const entry = stored;
    await ctx.store.mutate((index) => {
      index.entries.push(entry);
    });
    if (signal?.aborted) {
      // Hung up during the index write: the plugin timed out and will never name this share.
      await ctx.store.mutate((index) => {
        index.entries = index.entries.filter((x) => x.id !== id);
      });
      throw abandoned();
    }
  } catch (e) {
    await removeTreeAsHermes(ctx.host, dir);
    throw e;
  }
  auditFiles(ctx, "share", { id, bytes: stored.bytes, sha256 });
  return { share_id: id, name, bytes: stored.bytes, mime, sha256 };
}
