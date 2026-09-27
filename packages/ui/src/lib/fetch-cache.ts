/**
 * One in-flight request per endpoint, and a short memory of the last answer.
 *
 * **Why this exists.** Three reads are made by several unrelated components and
 * by a timer as well: `GET /api/chat/listening` (mount, a fifteen-second tick,
 * `focus` and `visibilitychange` — which fire together when a window comes
 * back), `GET /api/volumes` and `GET /api/provider-profiles` (two settings
 * sections each, re-mounted on every view switch). Switching views a few times
 * in twenty seconds put the listening read on the wire ten times for an answer
 * that had not moved.
 *
 * **What it is not.** Not a store, and not a cache of anything a mutation
 * writes: it holds one promise per key with a ten-second life, and every write
 * against an endpoint drops its key before it returns. A read is therefore at
 * most one tick stale, and never stale *after* this browser changed the thing
 * it read — which is the only staleness an operator can catch us in.
 *
 * A rejection is never kept. A failed read fails its callers and leaves nothing
 * behind, so the next attempt is a real attempt rather than a replay of the
 * error.
 */

/** How long an answer is reused, when the caller does not say otherwise. */
export const FETCH_CACHE_TTL_MS = 10_000;

interface Entry {
  /** When the request *started*: a read that is still open is always shared. */
  at: number;
  promise: Promise<unknown>;
  settled: boolean;
}

const entries = new Map<string, Entry>();

/**
 * Run `load`, or hand back the one already running or recently finished.
 *
 * `ttlMs` is measured from the start of the request, and a request still in
 * flight is shared whatever the TTL says — deduping concurrent callers is the
 * half of this that matters most, and it is exactly the case a TTL cannot
 * express.
 */
export function cachedFetch<T>(
  key: string,
  load: () => Promise<T>,
  ttlMs: number = FETCH_CACHE_TTL_MS,
): Promise<T> {
  const held = entries.get(key);
  if (held && (!held.settled || Date.now() - held.at <= ttlMs)) return held.promise as Promise<T>;
  const entry: Entry = {
    at: Date.now(),
    promise: Promise.resolve() as Promise<unknown>,
    settled: false,
  };
  const promise = load().then(
    (value) => {
      entry.settled = true;
      return value;
    },
    (cause: unknown) => {
      // A failure is not an answer: drop it so the next caller really retries.
      if (entries.get(key) === entry) entries.delete(key);
      throw cause;
    },
  );
  entry.promise = promise;
  entries.set(key, entry);
  return promise;
}

/** Drop one key, or the whole cache. Called by every write against an endpoint. */
export function invalidateFetchCache(key?: string): void {
  if (key === undefined) entries.clear();
  else entries.delete(key);
}

/** The keys, spelled once so a write cannot invalidate a read it does not name. */
export const FETCH_KEYS = {
  listening: "chat.listening",
  volumes: "volumes",
  profiles: "provider-profiles",
} as const;
