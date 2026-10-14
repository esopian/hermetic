/**
 * The write path: a staged attachment, its commit into the inbox, a request
 * fulfilled with bytes, and a request fulfilled from a durable SSM secret.
 *
 * Every write lands at a fixed root under a fresh, random id — never at a path
 * the caller chose — and is created exclusively, so nothing is overwritten and
 * nothing is executed. Bytes stream to `<dir>/.part-<id>` as `hermes`, are
 * checked, and only then renamed into place; any failure removes the per-id
 * directory and with it the part file (`writeIntoPlace`).
 *
 * Secret bytes never touch the data volume. A request marked `secret`, and an
 * upload that looks like private key material (D6), are read into memory —
 * the secret lane's cap is 1 MiB — and written straight to tmpfs
 * (`writeDropSecret`). The decision is made on the first 4 KiB, before a byte
 * is written anywhere.
 *
 * Every id an operation is working on is claimed in the store for as long as
 * it does (`FilesStore.claim`): an upload's file id while its bytes stream
 * (the sweeper's disk pass skips it), a staged id while it is committed (a
 * delete or a second commit is told 409, not raced), a request slot while it
 * receives.
 */
import {
  FileEntry,
  type FileClass,
  type FileRequest,
  type FilesCommitBody,
  type FilesCommitResult,
  type FilesFulfilResult,
  type FilesSecretBody,
  type FilesStageResult,
} from "@hermetic/core/schema";
import {
  FILES_INBOX_DIR,
  FILES_LIMITS,
  FILES_NAME_HEADER,
  FILES_SESSION_HEADER,
  FILES_STAGE_DIR,
  FILES_TTL,
  HERMES_ACCOUNT,
  HERMES_HOME,
  acceptMatches,
  inboxRelPath,
  isFileSecretSlot,
  isImageMime,
  looksLikeKeyMaterial,
  newFileId,
  sniffMime,
} from "@hermetic/core/shared";
import { type Caller, type FilesCtx, auditFiles, isoAfter, nowIso } from "./context.ts";
import { FilesError, errorText } from "./errors.ts";
import {
  mkdirAsHermes,
  moveNoClobberAsHermes,
  pathKindAsHermes,
  removeTreeAsHermes,
  writeDropSecret,
} from "./fs-ops.ts";
import { beginReceiving, classCap, markFulfilled, rejectReceiving } from "./requests.ts";
import type { Claim } from "./store.ts";
import { MeteredBody, type UploadHeaders, checkDiskFloor, cleanName, uploadHeaders } from "./upload.ts";

/** Previewable when it sniffs as an image and fits Hermes's own image cap; a chip otherwise. */
function classFor(mime: string, bytes: number): FileClass {
  return isImageMime(mime) && bytes <= FILES_LIMITS.imageBytes ? "image" : "file";
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

/** Checked against core's schema before it enters the index, so the index always reloads. */
function entry(fields: FileEntry): FileEntry {
  return FileEntry.parse(fields);
}

/** The upload's body, metered, bounded by the idle timeout and by `signal`. */
function meter(ctx: FilesCtx, request: Request, declared: number, signal?: AbortSignal): MeteredBody {
  return new MeteredBody(request.body, declared, {
    ...(ctx.uploadIdleMs !== undefined ? { idleMs: ctx.uploadIdleMs } : {}),
    ...(signal ? { signal } : {}),
  });
}

/** Claim `id`, or refuse: another operation is working on it. */
function claimOrConflict(ctx: FilesCtx, id: string, what: string): Claim {
  const claim = ctx.store.claim(id);
  if (claim === null) throw new FilesError("CONFLICT", `${what} is busy; try again in a moment`);
  return claim;
}

/** How long a commit waits for another operation to let go of its id, and how often it looks. */
const CLAIM_WAIT_MS = 5000;
const CLAIM_POLL_MS = 50;

/**
 * Wait, at most `CLAIM_WAIT_MS`, for whoever holds `id` to let go. The holder
 * is usually brief — the sweeper checking the entry, a first commit of the
 * same id finishing — and a commit that lost that race is a legitimate Send,
 * not a conflict.
 */
async function waitForRelease(ctx: FilesCtx, id: string): Promise<void> {
  const never = new AbortController().signal;
  for (let waited = 0; waited < CLAIM_WAIT_MS && ctx.store.claimed(id); waited += CLAIM_POLL_MS) {
    await ctx.delay(CLAIM_POLL_MS, never);
  }
}

function looksSecretError(): FilesError {
  return new FilesError(
    "FILE_LOOKS_SECRET",
    "this looks like private key material; send it through a secret request, or resend with " +
      "x-hermetic-not-secret: 1 if it is not a secret",
  );
}

/**
 * Stream `body` into `<idDir>/.part-<id>` as hermes, check it, and rename it
 * to `finalPath`. `parents` are created first, as hermes, in order. Any
 * failure removes `idDir` — fresh and unique to this upload — with the part.
 */
async function writeIntoPlace(
  ctx: FilesCtx,
  body: MeteredBody,
  headers: UploadHeaders,
  parents: readonly string[],
  idDir: string,
  finalPath: string,
): Promise<string> {
  const id = idDir.slice(idDir.lastIndexOf("/") + 1);
  // Held while the bytes stream, so the sweeper's disk pass leaves the id's
  // directory and part file alone however long the upload takes.
  const claim = claimOrConflict(ctx, id, "that file");
  const part = `${idDir}/.part-${id}`;
  try {
    await mkdirAsHermes(ctx.host, ...parents, idDir);
    await ctx.host.writeStreamAs(HERMES_ACCOUNT, part, body.chunks(), { mode: "0600" });
    const sha256 = body.finish(headers.declared, headers.digest);
    await moveNoClobberAsHermes(ctx.host, part, finalPath);
    return sha256;
  } catch (e) {
    await body.discard();
    await removeTreeAsHermes(ctx.host, idDir);
    throw e;
  } finally {
    claim.release();
  }
}

/** `PUT /files/stage/:name` — an attachment uploaded ahead of Send, 1 h to be committed. */
export async function stageUpload(
  ctx: FilesCtx,
  request: Request,
  rawName: string,
  caller: Caller,
): Promise<FilesStageResult> {
  const name = cleanName(rawName);
  const headers = uploadHeaders(request, FILES_LIMITS.fileBytes);
  await checkDiskFloor(ctx.host, headers.declared);
  const body = meter(ctx, request, headers.declared);
  const head = await body.head();
  if (!headers.notSecret && looksLikeKeyMaterial(head, name)) {
    await body.discard();
    throw looksSecretError();
  }
  const id = newFileId();
  const dir = `${FILES_STAGE_DIR}/${id}`;
  const path = `${dir}/${name}`;
  const sha256 = await writeIntoPlace(
    ctx,
    body,
    headers,
    [FILES_INBOX_DIR, FILES_STAGE_DIR],
    dir,
    path,
  );
  const mime = sniffMime(head, name);
  const session = request.headers.get(FILES_SESSION_HEADER)?.trim();
  const staged = entry({
    id,
    dir: "stage",
    class: classFor(mime, body.bytes),
    name,
    bytes: body.bytes,
    mime,
    sha256,
    created_at: nowIso(ctx.host),
    expires_at: isoAfter(ctx.host, FILES_TTL.stage),
    path,
    from: { kind: "operator", login: caller.login, node: caller.node },
    ...(session ? { session_id: session.slice(0, 256) } : {}),
  });
  await ctx.store.mutate((index) => {
    index.entries.push(staged);
  });
  auditFiles(ctx, "stage", { id, bytes: staged.bytes, sha256, login: caller.login });
  return {
    id,
    name,
    bytes: staged.bytes,
    mime,
    sha256,
    class: staged.class,
    expires_at: staged.expires_at as string,
  };
}

/**
 * `POST /files/:id/commit` — Send: the staged file moves to the inbox, 7 d retention.
 *
 * Resumable. The move and the index update are two steps; if the index will
 * not save, the file is moved back to the stage, and if even that fails, a
 * retry that finds the stage path empty and the file already at its inbox
 * path finishes the index update instead of failing on a move with no source.
 */
export async function commitStaged(
  ctx: FilesCtx,
  id: string,
  body: FilesCommitBody,
  caller: Caller,
): Promise<FilesCommitResult> {
  const committed = (): FilesCommitResult | null => {
    const e = ctx.store.read().entries.find((x) => x.id === id);
    return e?.dir === "inbox" && e.path && e.rel ? { id, path: e.path, rel: e.rel } : null;
  };
  // A second commit of a committed id answers what the first did.
  const done = committed();
  if (done) return done;
  let claim = ctx.store.claim(id);
  if (claim === null) {
    await waitForRelease(ctx, id);
    const after = committed();
    if (after) return after;
    claim = claimOrConflict(ctx, id, "that file");
  }
  try {
    // Read again under the claim: a commit or delete may have finished meanwhile.
    const again = committed();
    if (again) return again;
    const found = ctx.store.read().entries.find((e) => e.id === id);
    if (!found) throw new FilesError("FILE_NOT_FOUND", "no such staged file on this box");
    if (found.dir !== "stage" || !found.path)
      throw new FilesError("CONFLICT", "that file is not staged");
    if (body.session_id && found.session_id && body.session_id !== found.session_id) {
      throw new FilesError("CONFLICT", "that file was staged for another session");
    }
    const stagePath = found.path;
    const rel = inboxRelPath(ctx.host.now(), id, found.name);
    const path = `${HERMES_HOME}/${rel}`;
    const idDir = dirname(path);
    let moved = false;
    if ((await pathKindAsHermes(ctx.host, stagePath)) === "missing") {
      // An earlier commit moved it and could neither save the index nor move
      // it back: finish that commit. Anything else is a stage file that is gone.
      if ((await pathKindAsHermes(ctx.host, path)) !== "regular") {
        throw new FilesError("FILE_NOT_FOUND", "the staged file is no longer on the box");
      }
    } else {
      await mkdirAsHermes(ctx.host, FILES_INBOX_DIR, dirname(idDir), idDir);
      await moveNoClobberAsHermes(ctx.host, stagePath, path);
      moved = true;
    }
    try {
      await ctx.store.mutate((index) => {
        const live = index.entries.find((e) => e.id === id);
        if (!live) return;
        live.dir = "inbox";
        live.rel = rel;
        live.path = path;
        live.expires_at = isoAfter(ctx.host, FILES_TTL.inbox);
        if (body.session_id) live.session_id = body.session_id;
      });
    } catch (e) {
      // The index still says `stage`: put the file back where it says, so a
      // retry is an ordinary commit and the sweeper's stage TTL still applies.
      if (moved) {
        try {
          await moveNoClobberAsHermes(ctx.host, path, stagePath);
          await removeTreeAsHermes(ctx.host, idDir);
        } catch (back) {
          ctx.log(
            `files commit id=${id}: could not move the file back to the stage: ${errorText(back)}`,
          );
        }
      }
      throw e;
    }
    await removeTreeAsHermes(ctx.host, `${FILES_STAGE_DIR}/${id}`);
    auditFiles(ctx, "commit", {
      id,
      bytes: found.bytes,
      sha256: found.sha256,
      login: caller.login,
      class: found.class,
    });
    return { id, path, rel };
  } finally {
    claim.release();
  }
}

/** The name an upload to a request is stored under: header, then the slot's hint, then `upload`. */
function requestFileName(request: Request, slot: FileRequest): string {
  const header = request.headers.get(FILES_NAME_HEADER);
  if (header !== null) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(header);
    } catch {
      throw new FilesError("FILE_NAME_INVALID", "the file name header is not valid URL encoding");
    }
    return cleanName(decoded);
  }
  // The hint is the agent's, and may be a path (`~/keys/deploy.pem`): its last segment names the file.
  if (slot.name_hint) return cleanName(slot.name_hint.split(/[/\\]/).pop() ?? "");
  return "upload";
}

/** `PUT /files/requests/:id` — a human answers the agent's request with a file. */
export async function fulfilRequest(
  ctx: FilesCtx,
  request: Request,
  requestId: string,
  caller: Caller,
): Promise<FilesFulfilResult> {
  const { slot, claim } = await beginReceiving(ctx, requestId);
  try {
    const result = await receiveForRequest(ctx, request, slot, claim, caller);
    ctx.store.wake(requestId);
    return result;
  } catch (e) {
    await rejectReceiving(ctx, requestId, e, claim);
    throw e;
  } finally {
    claim.release();
  }
}

async function receiveForRequest(
  ctx: FilesCtx,
  request: Request,
  slot: FileRequest,
  claim: Claim,
  caller: Caller,
): Promise<FilesFulfilResult> {
  const name = requestFileName(request, slot);
  const headers = uploadHeaders(request, Math.min(slot.max_bytes, classCap(slot.sensitivity)));
  const secretSlot = slot.sensitivity === "secret";
  if (!secretSlot) await checkDiskFloor(ctx.host, headers.declared);
  const body = meter(ctx, request, headers.declared, claim.signal);
  const head = await body.head();
  const mime = sniffMime(head, name);
  if (!acceptMatches(slot.accept, name, mime)) {
    await body.discard();
    throw new FilesError(
      "FILE_TYPE_REJECTED",
      `this request accepts ${slot.accept.join(", ")}; this file is ${mime}`,
    );
  }
  const forced = !secretSlot && !headers.notSecret && looksLikeKeyMaterial(head, name);
  if (forced && headers.declared > FILES_LIMITS.secretEphemeralBytes) {
    await body.discard();
    throw looksSecretError();
  }

  const id = newFileId();
  let stored: FileEntry;
  if (secretSlot || forced) {
    // The secret lane: memory, then tmpfs. Never the data volume.
    const bytes = await body.collect();
    const sha256 = body.finish(headers.declared, headers.digest);
    const path = await writeDropSecret(ctx.host, slot.request_id, name, bytes);
    stored = entry({
      id,
      dir: "drop",
      class: "secret",
      name,
      bytes: bytes.byteLength,
      mime,
      sha256,
      created_at: nowIso(ctx.host),
      expires_at: isoAfter(ctx.host, FILES_TTL.drop),
      path,
      from: { kind: "operator", login: caller.login, node: caller.node },
      request_id: slot.request_id,
    });
  } else {
    const rel = inboxRelPath(ctx.host.now(), id, name);
    const path = `${HERMES_HOME}/${rel}`;
    const idDir = dirname(path);
    const sha256 = await writeIntoPlace(
      ctx,
      body,
      headers,
      [FILES_INBOX_DIR, dirname(idDir)],
      idDir,
      path,
    );
    stored = entry({
      id,
      dir: "inbox",
      class: classFor(mime, body.bytes),
      name,
      bytes: body.bytes,
      mime,
      sha256,
      created_at: nowIso(ctx.host),
      expires_at: isoAfter(ctx.host, FILES_TTL.inbox),
      rel,
      path,
      from: { kind: "operator", login: caller.login, node: caller.node },
      request_id: slot.request_id,
    });
  }
  const path = stored.path as string;
  try {
    await ctx.store.mutate((index) => {
      markFulfilled(ctx, index, slot.request_id, claim, {
        path,
        sha256: stored.sha256,
        bytes: stored.bytes,
        by: caller.login,
        class: stored.class,
      });
      index.entries.push(stored);
    });
  } catch (e) {
    // The slot was reclaimed while the bytes landed, or the index would not
    // save: either way nothing points at them, so they go.
    if (stored.dir === "drop") await ctx.host.remove(dirname(path)).catch(() => undefined);
    else await removeTreeAsHermes(ctx.host, dirname(path));
    throw e;
  }
  auditFiles(ctx, "fulfil", {
    id: slot.request_id,
    bytes: stored.bytes,
    sha256: stored.sha256,
    login: caller.login,
    class: stored.class,
  });
  return {
    request_id: slot.request_id,
    path,
    sha256: stored.sha256,
    bytes: stored.bytes,
    class: stored.class,
  };
}

/**
 * `POST /files/requests/:id/secret` — the bytes went from the laptop to SSM
 * with the operator's credentials; hermeticd reads the slot with the instance
 * role and writes it to tmpfs. No bytes over HTTP.
 */
export async function fulfilFromSecret(
  ctx: FilesCtx,
  requestId: string,
  body: FilesSecretBody,
  caller: Caller,
): Promise<FilesFulfilResult> {
  if (!isFileSecretSlot(body.ssm_slot)) {
    throw new FilesError("VALIDATION", "ssm_slot must be a file-<slug> slot");
  }
  const materialise = ctx.materialiseSecret;
  if (!materialise) throw new FilesError("UNSUPPORTED", "this hermeticd cannot read file secrets", 501);
  const name = cleanName(body.name);
  // One tmpfs file per name: another slot's secret is never overwritten.
  const holder = ctx.store
    .read()
    .entries.find((e) => e.dir === "secret" && e.name === name && e.slot !== body.ssm_slot);
  if (holder) {
    throw new FilesError(
      "CONFLICT",
      "another durable secret on this box already has that file name; remove it or rename this one",
    );
  }
  // And no two placements of one name at once, whichever slots they come from.
  const nameClaim = claimOrConflict(ctx, `secret-name:${name}`, "a secret with that file name");
  try {
    const { claim } = await beginReceiving(ctx, requestId);
    try {
      const result = await placeSecret(ctx, requestId, body.ssm_slot, name, claim, caller);
      ctx.store.wake(requestId);
      return result;
    } catch (e) {
      await rejectReceiving(ctx, requestId, e, claim);
      throw e;
    } finally {
      claim.release();
    }
  } finally {
    nameClaim.release();
  }
}

async function placeSecret(
  ctx: FilesCtx,
  requestId: string,
  slot: string,
  name: string,
  claim: Claim,
  caller: Caller,
): Promise<FilesFulfilResult> {
  const materialise = ctx.materialiseSecret as NonNullable<FilesCtx["materialiseSecret"]>;
  let got: Awaited<ReturnType<typeof materialise>>;
  try {
    // The envelope must name `name`, checked before the write: an envelope
    // naming another file would otherwise land on top of it.
    got = await materialise(slot, name);
  } catch (e) {
    if (e instanceof FilesError) throw e;
    ctx.log(`files secret: could not materialise ${slot}: ${errorText(e)}`);
    throw new FilesError("FILE_NOT_FOUND", "the secret slot could not be read from SSM");
  }
  const stored = entry({
    id: newFileId(),
    dir: "secret",
    class: "secret",
    name: got.name,
    bytes: got.bytes,
    mime: "application/octet-stream",
    sha256: got.sha256,
    created_at: nowIso(ctx.host),
    expires_at: null,
    path: got.path,
    from: { kind: "operator", login: caller.login, node: caller.node },
    request_id: requestId,
    slot: got.slot,
  });
  await ctx.store.mutate((index) => {
    markFulfilled(ctx, index, requestId, claim, {
      path: got.path,
      sha256: got.sha256,
      bytes: got.bytes,
      by: caller.login,
      class: "secret",
    });
    // One entry per slot: a re-sent secret replaces the old entry, not the file's history.
    index.entries = index.entries.filter((e) => !(e.dir === "secret" && e.slot === got.slot));
    index.entries.push(stored);
  });
  auditFiles(ctx, "secret", {
    id: requestId,
    bytes: got.bytes,
    sha256: got.sha256,
    login: caller.login,
    class: "secret",
  });
  return {
    request_id: requestId,
    path: got.path,
    sha256: got.sha256,
    bytes: got.bytes,
    class: "secret",
  };
}
