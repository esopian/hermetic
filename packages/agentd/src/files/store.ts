/**
 * The files index: every entry (inbox, outbox, stage, drop, durable secret)
 * and every request slot this box knows, at `FILES_INDEX_PATH`.
 *
 * Metadata only — ids, names, digests, sizes, owners, expiry — never content.
 * The file is root's (directory 0700, file 0600), because a name can itself be
 * sensitive and the agent has no business editing its own audit trail.
 *
 * One writer: hermeticd's own process. Every mutation runs through `mutate`,
 * which serialises them on a promise chain, applies each to a copy, writes the
 * copy back atomically (`Host.writeFile` stages and renames) and only then
 * makes it the live index — so two uploads finishing at once cannot lose each
 * other's entry, and a write that fails leaves memory agreeing with disk. The sweeper is an in-process loop for
 * the same reason (`sweeper.ts`) rather than a systemd timer: a second process
 * would be a second writer.
 *
 * Waiters are the long-polls on the plugin socket (`GET /requests/:id/wait`):
 * every change to a slot's state wakes the slot's waiters, which re-read it.
 *
 * Claims are the in-memory half: an id (a file, a request slot, a secret's
 * name) some long operation is working on right now — an upload streaming, a
 * commit moving bytes, a delete unlinking them. Those steps run outside
 * `mutate`, because they take as long as the disk does; a claim is how commit,
 * delete and the sweeper keep off one another's id meanwhile. Claims live and
 * die with the process, which is the right lifetime: an operation that died
 * with the previous process is not in flight.
 */
import { FileEntry, FileRequest } from "@hermetic/core/schema";
import { FILES_INDEX_PATH } from "@hermetic/core/shared";
import type { Host } from "../host.ts";
import { errorText } from "./errors.ts";

export const FILES_INDEX_DIR = FILES_INDEX_PATH.slice(0, FILES_INDEX_PATH.lastIndexOf("/"));

export interface FilesIndex {
  entries: FileEntry[];
  requests: FileRequest[];
}

const Entries = FileEntry.array();
const Requests = FileRequest.array();

/** The index's own shape, checked with core's schemas for its two halves. */
function parseIndex(raw: string): FilesIndex {
  const doc = JSON.parse(raw) as { entries?: unknown; requests?: unknown } | null;
  if (doc === null || typeof doc !== "object") throw new Error("not an object");
  const entries = Entries.safeParse(doc.entries);
  if (!entries.success) throw new Error(`entries: ${entries.error.issues[0]?.message ?? "invalid"}`);
  const requests = Requests.safeParse(doc.requests);
  if (!requests.success) throw new Error(`requests: ${requests.error.issues[0]?.message ?? "invalid"}`);
  return { entries: entries.data, requests: requests.data };
}

/** An id held by one in-flight operation. */
export interface Claim {
  /** When it was taken, in ms since the epoch (the host's clock). */
  readonly since: number;
  /** Aborted when something reclaims the id from an operation that ran too long. */
  readonly signal: AbortSignal;
  /** Let go. Idempotent. */
  release(): void;
}

export interface FilesStore {
  /** A snapshot of the index. Callers must not mutate it; `mutate` is the only writer. */
  read(): FilesIndex;
  /**
   * Run `fn` against a copy of the index, persist the copy, then make it the
   * live index. Serialised: `fn` never overlaps another mutation, so a
   * check-then-set inside it is atomic. A throw from `fn`, or a failed write,
   * rejects and leaves the live index exactly as it was.
   */
  mutate<T>(fn: (index: FilesIndex) => T | Promise<T>): Promise<T>;
  /** Take `id` for an in-flight operation; `null` when another operation holds it. */
  claim(id: string): Claim | null;
  /** The live claim on `id`, if any. */
  claimed(id: string): Claim | undefined;
  /** Every id currently claimed. */
  inFlight(): string[];
  /** Abort `id`'s holder (its `signal` fires) and free the id. `false` when it was not claimed. */
  reclaim(id: string): boolean;
  /** Resolves on the next change to `requestId`'s slot, or when `signal` aborts. */
  changed(requestId: string, signal?: AbortSignal): Promise<void>;
  /** Wake every waiter on `requestId`. */
  wake(requestId: string): void;
}

/**
 * Read the index from disk. A missing file is an empty index; so is a corrupt
 * one, said in the log — the files it described are still on disk and the
 * sweeper's TTLs still clear them, so refusing to start would cost uploads and
 * buy nothing.
 *
 * A slot left `receiving` belonged to an upload that died with the previous
 * process: it is `open` again, and its part file is the sweeper's.
 */
export async function loadFilesIndex(host: Host, log: (message: string) => void): Promise<FilesIndex> {
  const raw = await host.readFile(FILES_INDEX_PATH).catch(() => null);
  if (raw === null) return { entries: [], requests: [] };
  let parsed: FilesIndex;
  try {
    parsed = parseIndex(raw);
  } catch (e) {
    log(`files index at ${FILES_INDEX_PATH} is unreadable (${errorText(e)}); starting empty`);
    return { entries: [], requests: [] };
  }
  for (const request of parsed.requests) if (request.state === "receiving") request.state = "open";
  return parsed;
}

export function makeFilesStore(host: Host, initial: FilesIndex): FilesStore {
  let index: FilesIndex = structuredClone(initial);
  let chain: Promise<unknown> = Promise.resolve();
  const waiters = new Map<string, Set<() => void>>();
  const claims = new Map<string, { claim: Claim; abort: AbortController }>();

  async function persist(next: FilesIndex): Promise<void> {
    // 0755 like every other writer of hermeticd's state directory (`fleet.ts`);
    // the index file itself is 0600, which is what keeps the names private.
    await host.mkdir(FILES_INDEX_DIR, "0755");
    await host.writeFile(FILES_INDEX_PATH, `${JSON.stringify(next)}\n`, "0600");
  }

  return {
    read: () => index,

    mutate<T>(fn: (index: FilesIndex) => T | Promise<T>): Promise<T> {
      const run = chain.then(async () => {
        const draft = structuredClone(index);
        const out = await fn(draft);
        await persist(draft);
        index = draft;
        return out;
      });
      // The chain carries on past a failure: one refused mutation must not
      // wedge every later one.
      chain = run.catch(() => undefined);
      return run;
    },

    changed(requestId, signal) {
      return new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        let set = waiters.get(requestId);
        if (!set) {
          set = new Set();
          waiters.set(requestId, set);
        }
        const done = (): void => {
          set?.delete(done);
          if (set?.size === 0) waiters.delete(requestId);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        set.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    },

    claim(id) {
      if (claims.has(id)) return null;
      const abort = new AbortController();
      const claim: Claim = {
        since: host.now().getTime(),
        signal: abort.signal,
        release: () => {
          if (claims.get(id)?.claim === claim) claims.delete(id);
        },
      };
      claims.set(id, { claim, abort });
      return claim;
    },

    claimed: (id) => claims.get(id)?.claim,

    inFlight: () => [...claims.keys()],

    reclaim(id) {
      const held = claims.get(id);
      if (!held) return false;
      claims.delete(id);
      held.abort.abort();
      return true;
    },

    wake(requestId) {
      for (const done of [...(waiters.get(requestId) ?? [])]) done();
    },
  };
}
