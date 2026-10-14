/**
 * Reading and removing what the box holds: the listing, one entry, an entry's
 * bytes, a delete, and the plugin's `consume` of a fulfilled request.
 *
 * Secret bytes never leave the box: `content` refuses every secret-class
 * entry outright (403), whoever asks. The listing names them, because the
 * operator needs to see what exists in order to remove it.
 *
 * `content` reads as `hermes`, and the account owns every directory on the
 * way, so it can replace an inbox file with a symlink to anything it can read
 * — `$HERMES_HOME/.env`, a tmpfs secret handed to it. Three things stand in
 * the way: a check as the account that the path is a regular file and not a
 * link (`pathKindAsHermes`), the same check again in the reader itself
 * (`READ_STREAM_SCRIPT`), and a byte count — a stream longer or shorter than
 * the index's size is aborted mid-body. What is left is the window between the
 * reader's check and its `open`, in which a same-sized swap would go through;
 * so the response carries the index's SHA-256 as `Content-Digest`, and the
 * laptop must verify it before trusting the bytes. Every download is the
 * operator's own and over the tailnet, so a swap needs a compromised agent and
 * a guessed size, and it still fails the digest.
 */
import type { FileEntry, FileRequest, FileWaitResult, FilesListResult } from "@hermetic/core/schema";
import {
  FILES_INBOX_DIR,
  FILES_STAGE_DIR,
  FILES_TTL,
  HERMES_ACCOUNT,
  HERMES_ACCOUNT_HOME,
  formatContentDigest,
} from "@hermetic/core/shared";
import { type Caller, type FilesCtx, auditFiles, waitResult } from "./context.ts";
import { FilesError } from "./errors.ts";
import { dropDirFor, mustRemoveTreeAsHermes, pathKindAsHermes, removeTreeAsHermes } from "./fs-ops.ts";
import { getRequest, listRequests } from "./requests.ts";

const DAY = 24 * 3600;

function isSecret(entry: FileEntry): boolean {
  return entry.class === "secret" || entry.dir === "drop" || entry.dir === "secret";
}

/** `GET /files` (tailnet) and `GET /files` (socket): metadata only. */
export async function listFiles(ctx: FilesCtx): Promise<FilesListResult> {
  const requests = await listRequests(ctx);
  const { entries } = ctx.store.read();
  const inbox = entries.filter((e) => e.dir === "inbox" || e.dir === "stage");
  const outbox = entries.filter((e) => e.dir === "outbox");
  const secrets = entries.filter((e) => e.dir === "drop" || e.dir === "secret");
  const fs = await ctx.host.filesystem(FILES_INBOX_DIR).catch(() => null);
  const sum = (list: readonly FileEntry[]): number => list.reduce((n, e) => n + e.bytes, 0);
  return {
    inbox,
    outbox,
    secrets,
    requests,
    usage: {
      inbox_bytes: sum(inbox),
      outbox_bytes: sum(outbox),
      ...(fs ? { disk_used_pct: Math.min(100, Math.max(0, fs.usePct)) } : {}),
      retention_days: Math.max(1, Math.round(FILES_TTL.inbox / DAY)),
    },
  };
}

export function getEntry(ctx: FilesCtx, id: string): FileEntry {
  const entry = ctx.store.read().entries.find((e) => e.id === id);
  if (!entry) throw new FilesError("FILE_NOT_FOUND", "no such file on this box");
  return entry;
}

/** RFC 5987 `filename*`, so a non-ASCII name survives the header. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** `GET /files/:id/content` — an inbox or outbox file's bytes, read as hermes. */
export async function entryContent(ctx: FilesCtx, id: string): Promise<Response> {
  const entry = getEntry(ctx, id);
  if (isSecret(entry)) {
    throw new FilesError("FILE_SECRET_FORBIDDEN", "a secret's bytes never leave the box");
  }
  if ((entry.dir !== "inbox" && entry.dir !== "outbox") || !entry.path) {
    throw new FilesError("FILE_NOT_FOUND", "only inbox and outbox files can be downloaded");
  }
  // A check that could not be made throws, and the entry is kept: only a
  // definite "nothing there" forgets it.
  const kind = await pathKindAsHermes(ctx.host, entry.path);
  if (kind === "missing") {
    await ctx.store.mutate((index) => {
      index.entries = index.entries.filter((e) => e.id !== id);
    });
    throw new FilesError("FILE_NOT_FOUND", "that file is no longer on the box");
  }
  if (kind !== "regular") {
    ctx.log(`files content id=${id}: refused, the path is not a regular file`);
    throw new FilesError("FORBIDDEN", "that file has been replaced on the box and will not be served");
  }
  const body = idleBounded(
    exactly(ctx.host.readStreamAs(HERMES_ACCOUNT, entry.path), entry.bytes),
    ctx.uploadIdleMs ?? FILES_TTL.uploadIdle * 1000,
  );
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": entry.mime,
      "content-length": String(entry.bytes),
      "content-digest": formatContentDigest(entry.sha256),
      "content-disposition": contentDisposition(entry.name),
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

/**
 * `stream`, errored the moment it yields more than `bytes` or ends short of
 * them: a file that changed size since it was indexed is not the file the
 * index vouches for, and its headers already promised `bytes`.
 */
function exactly(stream: ReadableStream<Uint8Array>, bytes: number): ReadableStream<Uint8Array> {
  let seen = 0;
  const mismatch = (): Error => new Error("the file on the box no longer matches its index entry");
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > bytes) controller.error(mismatch());
        else controller.enqueue(chunk);
      },
      flush(controller) {
        if (seen !== bytes) controller.error(mismatch());
      },
    }),
  );
}

/**
 * `source`, cancelled when its consumer stops pulling for `idleMs`. Both
 * listeners run with `idleTimeout: 0`, so a client that opened a download and
 * stopped reading would otherwise hold the `runuser cat` behind it forever;
 * cancelling the source is what kills that child (`Host.readStreamAs`).
 * `highWaterMark: 0`, so a pull is a consumer asking, not a buffer refilling.
 *
 * The stalled body is *closed*, not errored: nothing is reading it — that is
 * what stalled means — and a stream errored with no read pending is an
 * unhandled rejection in Bun, which would take hermeticd down. Closed short of
 * its `Content-Length`, the response is cut off, and the client's length and
 * `Content-Digest` checks refuse what it got.
 */
function idleBounded(source: ReadableStream<Uint8Array>, idleMs: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  const arm = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    timer = setTimeout(() => {
      stalled = true;
      reader.cancel().catch(() => undefined);
      try {
        controller.close();
      } catch {
        // Already closed or cancelled.
      }
    }, idleMs);
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        arm(controller);
      },
      async pull(controller) {
        clearTimeout(timer);
        if (stalled) return;
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
        arm(controller);
      },
      async cancel(reason) {
        clearTimeout(timer);
        await reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

/** The per-id directory an inbox, outbox or stage file lives in — refused if the path does not end in it. */
function entryDir(entry: FileEntry): string | null {
  if (entry.dir === "stage") return `${FILES_STAGE_DIR}/${entry.id}`;
  if (!entry.path) return null;
  const dir = entry.path.slice(0, entry.path.lastIndexOf("/"));
  return dir.endsWith(`/${entry.id}`) ? dir : null;
}

/**
 * Remove an entry's bytes, by where they live: as hermes under `/data`, as
 * root in the drop (its directories are root's), through the secrets module
 * for a durable secret. Shared with the sweeper.
 *
 * `strict` (a user's `DELETE`) throws when the removal under `/data` failed,
 * so the entry is kept; the sweeper's removal stays best effort, its disk pass
 * catching what is left.
 */
export async function removeEntryFiles(
  ctx: FilesCtx,
  entry: FileEntry,
  opts: { readonly strict?: boolean } = {},
): Promise<void> {
  switch (entry.dir) {
    case "stage":
    case "inbox":
    case "outbox": {
      const dir = entryDir(entry);
      if (!dir) return;
      if (opts.strict) await mustRemoveTreeAsHermes(ctx.host, dir);
      else await removeTreeAsHermes(ctx.host, dir);
      return;
    }
    case "drop":
      await ctx.host.remove(entry.request_id ? dropDirFor(entry.request_id) : (entry.path ?? ""));
      return;
    case "secret": {
      if (!ctx.removeSecret || !entry.path) return;
      await ctx.removeSecret(entry.path.slice(entry.path.lastIndexOf("/") + 1));
      return;
    }
  }
}

/**
 * `DELETE /files/:id`. For a durable secret this removes the tmpfs copy and
 * the index entry; deleting its SSM slot is the laptop's half. 409 while
 * another operation (a commit, the sweeper) is working on the id.
 */
export async function deleteEntry(ctx: FilesCtx, id: string, caller: Caller): Promise<void> {
  getEntry(ctx, id);
  const claim = ctx.store.claim(id);
  if (claim === null) throw new FilesError("CONFLICT", "that file is busy; try again in a moment");
  try {
    // Read again under the claim: a commit may have moved it meanwhile.
    const entry = getEntry(ctx, id);
    // A removal that failed keeps the entry: a 204 must mean the bytes are gone.
    await removeEntryFiles(ctx, entry, { strict: true });
    await ctx.store.mutate((index) => {
      index.entries = index.entries.filter((e) => e.id !== id);
    });
    auditFiles(ctx, "delete", {
      id,
      bytes: entry.bytes,
      sha256: entry.sha256,
      login: caller.login,
      class: entry.class,
    });
  } finally {
    claim.release();
  }
}

/**
 * Whether an entry's file is still there: asked as hermes under `/data`
 * (never a root `lstat` there), as root in the root-owned drop.
 */
export async function entryPresent(ctx: FilesCtx, entry: FileEntry): Promise<boolean> {
  if (!entry.path) return true;
  if (entry.path.startsWith(`${HERMES_ACCOUNT_HOME}/`)) {
    return (await pathKindAsHermes(ctx.host, entry.path)) !== "missing";
  }
  return (await ctx.host.lstat(entry.path)) !== null;
}

/**
 * Socket `POST /requests/:id/consume` — the agent has read what it asked for.
 * An ephemeral secret is deleted there and then; anything else keeps its TTL.
 * Consuming twice answers the same thing twice.
 */
export async function consumeRequest(ctx: FilesCtx, id: string): Promise<FileWaitResult> {
  const request: FileRequest = await getRequest(ctx, id);
  if (request.state === "consumed") return waitResult(ctx.name, request);
  if (request.state !== "fulfilled") {
    throw new FilesError("CONFLICT", `there is nothing to consume: the request is ${request.state}`);
  }
  const drops = ctx.store.read().entries.filter((e) => e.request_id === id && e.dir === "drop");
  for (const entry of drops) await removeEntryFiles(ctx, entry);
  const out = await ctx.store.mutate((index) => {
    index.entries = index.entries.filter((e) => !(e.request_id === id && e.dir === "drop"));
    const live = index.requests.find((r) => r.request_id === id);
    if (live) live.state = "consumed";
    return live ? { ...live } : request;
  });
  ctx.store.wake(id);
  auditFiles(ctx, "consume", { id, bytes: request.fulfilled?.bytes });
  return waitResult(ctx.name, out);
}
