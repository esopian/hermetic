import type { CoreContext } from "../context.ts";
import { HermeticError } from "../errors.ts";
import type { FilesCapability, FilesCommitResult } from "../schema/index.ts";
import { FILES_CAPABILITY, isFileId } from "../shared/files.ts";
import { validateName } from "../shared/naming.ts";
import type { FilesContent } from "../backend/files-port.ts";
import { createFilesStage } from "./stage.ts";
import { createUploadRegistry, type UploadRegistry } from "./uploads.ts";

/**
 * The files module (§9), mounted on the SDK as `hermetic.files`.
 *
 * `stage` is the one public method (`files.stage`). Everything under
 * `internal` is machinery the desktop head wraps in its own requests
 * (`files.chunk.*`, `files.capability`, `files.discard`, `files.content`) and
 * the chat turn calls directly (`commit`): none of it is a §9 command, so none
 * of it is in `PUBLIC_METHODS`, and `tests/parity.test.ts` skips this one
 * sub-object by name.
 */

export interface FilesDeps {
  ctx: CoreContext;
  /** Defaults to a fresh in-memory registry. */
  uploads?: UploadRegistry;
  /** Milliseconds since the epoch, for the capability cache. */
  now?: () => number;
  /** How long a capability answer is reused. */
  capabilityTtlMs?: number;
  /** How long a capability probe waits on `/healthz`. */
  capabilityTimeoutMs?: number;
}

/** A positive answer is reused for a minute; a miss for ten seconds, so a box coming up is noticed. */
export const FILES_CAPABILITY_TTL_MS = 60_000;
const CAPABILITY_MISS_TTL_MS = 10_000;
export const FILES_CAPABILITY_TIMEOUT_MS = 3_000;

function requireFileId(id: string): void {
  if (!isFileId(id)) throw new HermeticError("VALIDATION", "not a file id (f_…)");
}

/**
 * Every method that reaches a box first runs `ctx.guardFleet` (which runs
 * `guardAccount`): the account and fleet this SDK was opened for (§4.6), the
 * same gate chat's `address()` passes before it opens a socket.
 */
export function createFiles(deps: FilesDeps) {
  const { ctx } = deps;
  const uploads = deps.uploads ?? createUploadRegistry();
  const now = deps.now ?? (() => Date.now());
  const ttl = deps.capabilityTtlMs ?? FILES_CAPABILITY_TTL_MS;
  const timeoutMs = deps.capabilityTimeoutMs ?? FILES_CAPABILITY_TIMEOUT_MS;
  const capabilityCache = new Map<string, { at: number; ttl: number; value: FilesCapability }>();

  const { stage } = createFilesStage({ ctx, uploads });

  /**
   * Whether `instance`'s hermeticd serves the files routes, from its
   * `/healthz` `capabilities`. A box that does not answer, or an older
   * hermeticd that reports no capabilities, reads as `files: false`: the head
   * hides the attach control rather than failing an upload.
   */
  async function capability(
    instance: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<FilesCapability> {
    validateName(instance);
    const cached = capabilityCache.get(instance);
    if (cached !== undefined && now() - cached.at < cached.ttl) return cached.value;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let value: FilesCapability;
    let hit = false;
    // Only on a miss: a cached answer reaches no box. A guard refusal is the
    // caller's to see, never a cached `files: false`.
    await ctx.guardFleet();
    try {
      const health = await ctx.backend.rpc.health(instance, { signal });
      value = {
        files: (health.capabilities ?? []).includes(FILES_CAPABILITY),
        hermeticd_version: health.hermeticd_version,
      };
      hit = true;
    } catch (e) {
      // A caller's own abort is theirs to see; a miss is an answer.
      if (opts.signal?.aborted) throw new HermeticError("ABORTED", "the capability check was stopped");
      if (e instanceof HermeticError && e.code === "NOT_FOUND") throw e;
      value = { files: false, hermeticd_version: null };
    }
    capabilityCache.set(instance, { at: now(), ttl: hit ? ttl : CAPABILITY_MISS_TTL_MS, value });
    return value;
  }

  /** Delete a staged (or committed) entry: the chip's remove. */
  async function discard(
    instance: string,
    id: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ discarded: true }> {
    validateName(instance);
    requireFileId(id);
    await ctx.guardFleet();
    await ctx.backend.files.remove(instance, id, opts);
    return { discarded: true };
  }

  /**
   * An entry's bytes, verified, refused over `maxBytes` — and, with
   * `imagesOnly`, refused when it is not an image — before they are read.
   */
  async function content(
    instance: string,
    id: string,
    maxBytes: number,
    opts: { signal?: AbortSignal; imagesOnly?: boolean } = {},
  ): Promise<FilesContent> {
    validateName(instance);
    requireFileId(id);
    await ctx.guardFleet();
    return await ctx.backend.files.content(instance, id, { ...opts, maxBytes });
  }

  /** Move a staged entry into the inbox for a turn; the path is what the turn names. */
  async function commit(
    instance: string,
    id: string,
    sessionId?: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<FilesCommitResult> {
    validateName(instance);
    requireFileId(id);
    await ctx.guardFleet();
    return await ctx.backend.files.commit(
      instance,
      id,
      sessionId ? { session_id: sessionId } : {},
      opts,
    );
  }

  return {
    stage,
    internal: {
      uploads: {
        open: uploads.open,
        append: uploads.append,
        close: uploads.close,
        registerPath: uploads.registerPath,
        discard: uploads.discard,
      },
      capability,
      discard,
      content,
      commit,
    },
  };
}

export type FilesSurface = ReturnType<typeof createFiles>;
export type FilesInternal = FilesSurface["internal"];
