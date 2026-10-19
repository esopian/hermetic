import type { CoreContext } from "../context.ts";
import { HermeticError } from "../errors.ts";
import {
  type FileRequest,
  type FilesCapability,
  type FilesCommitResult,
  FilesDeclineInput,
  FilesListInput,
  type FilesListResult,
} from "../schema/index.ts";
import { FILES_CAPABILITY, isFileId, isRequestId, isShareId } from "../shared/files.ts";
import type { ContentPurpose } from "../shared/files.ts";
import { validateName } from "../shared/naming.ts";
import type { FilesContent } from "../backend/files-port.ts";
import { requestStateRefusal } from "./errors.ts";
import { createFilesGet, createSaveDestinations, type SaveDestinations } from "./get.ts";
import { createFilesPut } from "./put.ts";
import { createFilesRm } from "./rm.ts";
import { createFilesStage } from "./stage.ts";
import { createUploadRegistry, type UploadRegistry } from "./uploads.ts";

/**
 * The files module (§9), mounted on the SDK as `hermetic.files`.
 *
 * `stage`, `put`, `decline`, `list`, `get` and `rm` are the public methods
 * (`files.stage`, `files.put`, `files.decline`, `files.list`, `files.get`,
 * `files.rm`). Everything under `internal` is machinery the desktop head wraps
 * in its own requests (`files.secretText.upload`, `files.upload.discard`,
 * `files.capability`, `files.discard`,
 * `files.content`, `files.request.get`, `files.saveNative`) and the chat turn
 * and `apply` call directly (`commit`, `applyRm`): none of it is a §9 command,
 * so none of it is in
 * `PUBLIC_METHODS`, and `tests/parity.test.ts` skips this one sub-object by
 * name.
 */

export interface FilesDeps {
  ctx: CoreContext;
  /** Defaults to a fresh in-memory registry. */
  uploads?: UploadRegistry;
  /** The save dialog's folders (`files.saveNative`); defaults to a fresh registry. */
  destinations?: SaveDestinations;
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

/** A file or a share: what the box's content route serves. */
function requireEntryId(id: string): void {
  if (!isFileId(id) && !isShareId(id)) {
    throw new HermeticError("VALIDATION", "not a file (f_…) or share (sh_…) id");
  }
}

function requireRequestId(id: string): void {
  if (!isRequestId(id)) throw new HermeticError("VALIDATION", "not a file request id (fr_…)");
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

  const destinations = deps.destinations ?? createSaveDestinations();

  const { stage } = createFilesStage({ ctx, uploads });
  const { put } = createFilesPut({ ctx, uploads });
  const { get } = createFilesGet({ ctx, destinations });
  const { rm, applyRm } = createFilesRm({ ctx });

  /**
   * `files.list`: every entry and request slot on one box, metadata only —
   * never a byte of content. With `requests`, only the slots still waiting
   * for a file, and no entries.
   */
  async function list(input: unknown, opts: { signal?: AbortSignal } = {}): Promise<FilesListResult> {
    const parsed = FilesListInput.safeParse(input);
    if (!parsed.success) {
      throw new HermeticError("VALIDATION", "files ls input does not validate", {
        issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      });
    }
    const { name, requests } = parsed.data;
    validateName(name);
    await ctx.guardFleet();
    await ctx.getAgent(name);
    const listing = await ctx.backend.files.list(name, opts);
    if (!requests) return listing;
    return {
      inbox: [],
      outbox: [],
      secrets: [],
      requests: listing.requests.filter((r) => r.state === "open"),
      usage: listing.usage,
    };
  }

  /**
   * One request slot, as the box holds it: what a request card renders from,
   * so a model's tool arguments cannot widen what the card says the box takes.
   */
  async function request(
    instance: string,
    requestId: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<FileRequest> {
    validateName(instance);
    requireRequestId(requestId);
    await ctx.guardFleet();
    return await ctx.backend.files.request(instance, requestId, opts);
  }

  /**
   * `files.decline`: say no to an open request. The agent's wait ends with
   * `declined` and the reason, if one was given. A request that is no longer
   * open is refused with the box's code before anything is sent.
   */
  async function decline(input: unknown, opts: { signal?: AbortSignal } = {}): Promise<FileRequest> {
    const parsed = FilesDeclineInput.safeParse(input);
    if (!parsed.success) {
      throw new HermeticError("VALIDATION", "files decline input does not validate", {
        issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      });
    }
    const { instance, request_id, reason } = parsed.data;
    validateName(instance);
    await ctx.guardFleet();
    await ctx.getAgent(instance);
    const slot = await ctx.backend.files.request(instance, request_id, opts);
    if (slot.state !== "open") throw requestStateRefusal(slot.state, instance);
    return await ctx.backend.files.decline(instance, request_id, reason, opts);
  }

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
   * An entry's bytes — a file (`f_…`) or a share (`sh_…`) — verified, refused
   * over `maxBytes` and, with a `purpose`, refused when that purpose does not
   * admit its type, before they are read. The box refuses a secret's content
   * on its own.
   */
  async function content(
    instance: string,
    id: string,
    maxBytes: number,
    opts: { signal?: AbortSignal; purpose?: ContentPurpose } = {},
  ): Promise<FilesContent> {
    validateName(instance);
    requireEntryId(id);
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
    put,
    decline,
    list,
    get,
    rm,
    internal: {
      uploads: {
        openStream: uploads.openStream,
        feed: uploads.feed,
        registerPath: uploads.registerPath,
        registerBytes: uploads.registerBytes,
        discard: uploads.discard,
      },
      capability,
      discard,
      content,
      commit,
      request,
      /** The save dialog's folder, registered for `files.get` by an opaque id. */
      registerDestination: destinations.register,
      /** Execute a `files-rm` plan; `apply` is the only caller. */
      applyRm,
    },
  };
}

export type FilesSurface = ReturnType<typeof createFiles>;
export type FilesInternal = FilesSurface["internal"];
