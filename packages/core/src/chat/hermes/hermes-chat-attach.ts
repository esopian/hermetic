/**
 * A turn's attachments, between the session and the prompt (plan §8.2).
 *
 * The order is load-bearing:
 *
 * 1. **Commit** every staged id into the box's inbox, with the turn's session.
 *    All of them before anything is queued on the gateway, so a commit that
 *    fails leaves nothing behind in the session.
 * 2. **Frame** the prompt: the operator's message and one line per file
 *    (`hermes-chat-framing.ts`). A path Hermes could not read back is refused
 *    here, still before anything is queued.
 * 3. **Queue** each image with `image.attach`, by absolute path: upstream
 *    resolves a relative one against the gateway process's cwd, not the
 *    session's.
 * 4. `prompt.submit` (the caller), which consumes the queue.
 *
 * Upstream's per-session image queue survives an interrupt and a closed
 * socket, and `prompt.submit` is the only thing that empties it. A turn that
 * stops between 3 and 4 — aborted, or failed — must therefore take back every
 * image it queued (`detachQueued`), or the next turn in the session silently
 * carries them.
 */
import { checkAbort } from "../../abort.ts";
import { HermeticError } from "../../errors.ts";
import type { FilesCommitResult } from "../../schema/index.ts";
import { FILES_LIMITS } from "../../shared/files.ts";
import {
  attachesAsImage,
  framingBlock,
  imageAttachArg,
  withFraming,
  type FramedFile,
} from "./hermes-chat-framing.ts";
import type { Rpc } from "./hermes-chat-rpc.ts";
import type { TurnAttachments } from "./hermes-chat-types.ts";
import { rec, str } from "./hermes-chat-wire.ts";

/** How long a turn that is already ending waits for each `image.detach`. */
const DETACH_DEADLINE_MS = 5_000;

export interface AttachArgs {
  rpc: Rpc;
  instance: string;
  /** The runtime session `image.attach` and `prompt.submit` address. */
  session: string;
  /** The durable session the box records on each entry (the runtime one when the box named none). */
  commitSession: string;
  attachments: TurnAttachments;
  message: string;
  signal: AbortSignal | undefined;
  /**
   * Every path the gateway may hold for this turn, kept current as each step
   * learns more, so the caller's cleanup knows about an image even when a later
   * step throws.
   */
  queued: Set<string>;
}

/** Commit, frame and queue a turn's attachments. Returns the prompt to submit. */
export async function attachToTurn(args: AttachArgs): Promise<string> {
  const { rpc, instance, session, attachments, signal } = args;
  const ids = attachments.ids;
  if (ids.length === 0) return args.message;
  if (ids.length > FILES_LIMITS.attachmentsPerTurn || new Set(ids).size !== ids.length) {
    throw new HermeticError(
      "VALIDATION",
      `a turn carries at most ${FILES_LIMITS.attachmentsPerTurn} attachments, each once`,
    );
  }

  const committed: FilesCommitResult[] = [];
  for (const id of ids) {
    checkAbort(signal, "attachment commit");
    committed.push(await attachments.commit(id, args.commitSession, signal));
  }

  const files: FramedFile[] = committed.map((file) => ({
    name: file.name,
    mime: file.mime,
    bytes: file.bytes,
    sha256: file.sha256,
    rel: file.rel,
    image: attachesAsImage(file),
  }));
  // Framed once before anything is queued, so a path Hermes could not read
  // back is refused while there is still nothing to take back.
  framingBlock(files, instance);

  for (const [n, file] of committed.entries()) {
    const framed = files[n];
    if (!framed?.image) continue;
    checkAbort(signal, "image attach");
    const arg = imageAttachArg(file.path) ?? file.path;
    // Counted as queued the moment the request leaves: a reply lost to a
    // dropped socket says nothing about whether the gateway queued it.
    args.queued.add(file.path);
    // Not cancelled by the turn's signal, for the same reason: an abandoned
    // reply would hide the path the queue actually holds. The stop is honoured
    // at the next `checkAbort`, and the cleanup then detaches it.
    const result = rec(await rpc.request("image.attach", { session_id: session, path: arg }));
    if (result?.attached === false) {
      // The gateway said it queued nothing: the file reaches the agent as an
      // `@file:` reference instead, and there is nothing to take back.
      args.queued.delete(file.path);
      framed.image = false;
      continue;
    }
    // Detach matches the exact string the queue holds, which is the resolved
    // path upstream answers with.
    const answered = str(result?.path);
    if (answered && answered !== file.path) args.queued.add(answered);
  }
  return withFraming(args.message, framingBlock(files, instance));
}

export interface DetachArgs {
  /** The turn's own socket. An abort has usually closed it already (`chat-transport.ts`). */
  rpc: Rpc;
  /** Whether `rpc` can still carry a request: false once the turn's signal fired. */
  live: boolean;
  /**
   * A fresh connection to the same gateway, bounded by `signal` alone — never
   * the turn's, which has fired by the time a stopped turn gets here.
   */
  reconnect: (signal: AbortSignal) => Promise<Rpc>;
  /** The runtime session the images were queued on. */
  session: string;
  paths: readonly string[];
}

/**
 * Take back every image this turn queued. Best effort, and bounded: the turn
 * is already failing, and a gateway that cannot answer a detach has most
 * likely dropped the session the queue lived in.
 *
 * A stop closes the turn's socket with the signal, and that is exactly when
 * the queue most needs emptying, so whatever the turn's own socket could not
 * take back goes over a fresh one. Upstream keeps runtime sessions in one
 * process-wide table (`tui_gateway/server.py` `_sess_nowait`) and only detaches
 * a session from a closed socket, so the same runtime id still addresses the
 * queue from another connection; a session already reaped took its queue with
 * it.
 */
export async function detachQueued(args: DetachArgs): Promise<void> {
  const left: string[] = [];
  for (const path of args.paths) {
    if (!args.live || !(await detachOne(args.rpc, args.session, path))) left.push(path);
  }
  if (left.length === 0) return;
  const signal = AbortSignal.timeout(DETACH_DEADLINE_MS * 2);
  let fresh: Rpc | null = null;
  try {
    fresh = await args.reconnect(signal);
    for (const path of left) {
      if (signal.aborted) break;
      await detachOne(fresh, args.session, path);
    }
  } catch {
    // No way back to the gateway; the next turn's prompt would carry the image.
  } finally {
    fresh?.close();
  }
}

async function detachOne(rpc: Rpc, session: string, path: string): Promise<boolean> {
  try {
    await rpc.request("image.detach", { session_id: session, path }, DETACH_DEADLINE_MS);
    return true;
  } catch {
    return false;
  }
}
