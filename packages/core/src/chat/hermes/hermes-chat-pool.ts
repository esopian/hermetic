/**
 * One *request-only* socket per box, shared by the Bot Mode RPCs.
 *
 * Bot Mode's `botModeRpc` used to dial a WebSocket, send one document, read one
 * reply and close again. A single `bots.capabilities` is three probes — two
 * RPCs and a REST call — so opening the Bot Chat pane cost two full dials
 * (TLS through Tailscale Serve, the dashboard's upgrade gate, the token) for
 * two frames of traffic, and a jobs pane refreshing a few bots multiplied that
 * by the roster.
 *
 * What this module adds, and deliberately nothing more:
 *
 * - **Only `botModeRpc` routes through it.** A turn's socket (`send`, `abort`,
 *   `observe`) stays dedicated: those carry an event subscription whose frames
 *   belong to exactly one consumer, and sharing one would mean demultiplexing a
 *   stream upstream does not tag. `connect()` keeps its old contract for every
 *   other caller — you get a socket, you own it, you close it.
 * - **A request never replays.** The dial is retried (that is `connect`'s own
 *   cached-token retry, unchanged); a document that reached the wire is not.
 *   A socket that dies with requests in flight rejects them once — `readRpc`
 *   already does that — and the entry is evicted so the *next* call redials.
 * - **One caller's abort is one caller's abort.** It removes that request's
 *   pending entry and leaves the socket, and its peers, alone. That is why
 *   `request` never hands the caller's signal to `connect`: a shared dial that
 *   any participant could cancel is a shared dial that fails for the others.
 *
 * Idle TTL is 15 s. It is picked against what the pane actually does rather
 * than against a network constant: the three capability probes and the reads
 * that follow them land within a second or two of each other, the jobs pane
 * re-probes on a switch between bots, and an operator who has stopped clicking
 * should not be holding a socket open on a box. Long enough that one pane's
 * burst of work is one dial; short enough that a closed tab costs at most one
 * idle socket for fifteen seconds. The timer is `unref`'d, so it is never the
 * reason a process stays up, and `dispose()` is the explicit end.
 */
import { HermeticError } from "../../errors.ts";
import { CHAT_ERROR_CODES } from "./hermes-chat-types.ts";
import type { BoxAddress, HermesChatOptions } from "./hermes-chat-types.ts";
import type { Rpc } from "./hermes-chat-rpc.ts";

/** How long a socket with no leases is kept before it is closed. See the header. */
export const REQUEST_POOL_IDLE_MS = 15_000;

export interface RequestPoolDeps {
  /** `ChatConnection.connect`. The pool never builds a socket itself. */
  connect(box: BoxAddress, signal: AbortSignal | undefined): Promise<Rpc>;
  /** Overridable so a test need not spend fifteen seconds proving the TTL. */
  idleMs?: number | undefined;
}

export interface RequestPool {
  request(
    box: BoxAddress,
    method: string,
    params: Record<string, unknown>,
    opts?: HermesChatOptions & { deadlineMs?: number | undefined },
  ): Promise<unknown>;
  /** Close every socket this pool holds. Idempotent; the pool stays usable. */
  dispose(): void;
  /** How many sockets are currently held. Test-only introspection. */
  size(): number;
}

/**
 * One box's shared socket, at one generation.
 *
 * Eviction is by *object identity* rather than by a counter: an entry is only
 * ever removed from the map when the map still points at that same object, so
 * a socket that closed while its replacement was already dialling cannot take
 * the replacement down with it.
 */
interface Entry {
  key: string;
  /** Callers currently between `acquire` and `release`. */
  leases: number;
  /** The single-flight dial. Every caller for this key awaits this one promise. */
  dial: Promise<Rpc>;
  /** Set once the dial resolved, so idle close and dispose have something to close. */
  rpc: Rpc | null;
  idle: ReturnType<typeof setTimeout> | null;
  /** Set once this entry is finished, so a dial that lands late closes itself. */
  dead: boolean;
}

/**
 * Every pool built in this process, so a head can end them all without holding
 * a reference to the chat client core wired for it.
 *
 * A module-level set rather than a field on `Hermetic` because the thing being
 * released is a *process* resource — a one-shot CLI has to be able to say "no
 * open sockets now" in a `finally` without threading a handle through the
 * command tree, and the portal's shutdown path has the same shape.
 *
 * Membership tracks *having sockets*, not having been constructed. A pool joins
 * when it first dials and leaves when it is disposed, because a pool is built
 * per chat client and the portal builds a new one on every `reopen` — a set
 * that only ever grew would pin one dead pool per fleet switch for the life of
 * the process.
 */
const pools = new Set<RequestPool>();

/** Close every pooled request socket in this process. Safe to call twice. */
export function disposeChatRequestPools(): void {
  // A copy: each `dispose` removes itself from the set it is being read from.
  for (const pool of [...pools]) pool.dispose();
}

/** How many pools currently hold a socket. Test-only introspection. */
export function trackedChatRequestPools(): number {
  return pools.size;
}

export function createRequestPool(deps: RequestPoolDeps): RequestPool {
  const idleMs = deps.idleMs ?? REQUEST_POOL_IDLE_MS;
  const live = new Map<string, Entry>();

  /** Drop `entry` from the map if it is still the one the map points at. */
  function evict(entry: Entry): void {
    if (entry.idle !== null) {
      clearTimeout(entry.idle);
      entry.idle = null;
    }
    if (live.get(entry.key) === entry) live.delete(entry.key);
  }

  /**
   * Drain and discard the socket's event stream.
   *
   * Two jobs in one loop. It bounds the buffer: `readRpc`'s channel is
   * unbounded, and a request-only socket that nobody reads events from would
   * accumulate every unsolicited frame the box broadcasts for as long as the
   * socket is pooled. And it is the close signal: the stream ends exactly when
   * the socket does, which is when this entry has to stop being reused.
   */
  function watch(entry: Entry, rpc: Rpc): void {
    void (async () => {
      try {
        for await (const _frame of rpc.events) {
          // Discarded on purpose: nothing subscribes on a request-only socket.
        }
      } catch {
        // A stream that errors is a stream that ended, with a worse mood.
      } finally {
        evict(entry);
      }
    })();
  }

  function open(key: string, box: BoxAddress): Entry {
    const entry: Entry = {
      key,
      leases: 0,
      rpc: null,
      idle: null,
      dead: false,
      // The raw dial, replaced below by the chain that records its outcome on
      // the entry. Two steps because those handlers close over `entry` itself.
      dial: deps.connect(box, undefined),
    };
    entry.dial = entry.dial.then(
      (rpc) => {
        if (entry.dead) {
          rpc.close();
          throw new HermeticError(CHAT_ERROR_CODES.PROTOCOL, `${box.instance}: chat socket closed`);
        }
        entry.rpc = rpc;
        // Belt and braces: a socket implementation that can leave the event
        // loop alone should, since nothing is waiting on a pooled socket
        // between requests. The runtime's `WebSocket` does not expose it yet,
        // and the optional call is how that stays a no-op rather than a crash.
        rpc.unref?.();
        watch(entry, rpc);
        return rpc;
      },
      (error: unknown) => {
        // A dial that failed must not be remembered: the next caller redials,
        // which is what lets `connect` re-scrape a token that has died.
        evict(entry);
        throw error;
      },
    );
    // A caller that aborts mid-dial stops awaiting this promise. Without this
    // it would be an unhandled rejection when the dial then fails.
    entry.dial.catch(() => {});
    return entry;
  }

  function acquire(box: BoxAddress): Entry {
    const key = box.baseUrl;
    let entry = live.get(key);
    if (!entry) {
      entry = open(key, box);
      live.set(key, entry);
      // This pool now holds a socket, so a process-wide dispose has to find it.
      pools.add(pool);
    }
    if (entry.idle !== null) {
      clearTimeout(entry.idle);
      entry.idle = null;
    }
    entry.leases += 1;
    return entry;
  }

  function release(entry: Entry): void {
    entry.leases -= 1;
    if (entry.leases > 0) return;
    // Already evicted — the socket closed under us, or `dispose` ran while this
    // request was in flight. Close rather than arm a timer for a dead entry.
    if (live.get(entry.key) !== entry) {
      entry.dead = true;
      entry.rpc?.close();
      return;
    }
    entry.idle = setTimeout(() => {
      if (entry.leases > 0) return;
      evict(entry);
      entry.dead = true;
      entry.rpc?.close();
    }, idleMs);
    entry.idle.unref?.();
  }

  const aborted = (): HermeticError =>
    new HermeticError("ABORTED", "operation aborted during chat connect", {
      phase: "chat connect",
    });

  /**
   * Await `promise`, but stop awaiting it if the caller hangs up.
   *
   * The dial itself is not cancelled — it is shared, and one participant
   * leaving is not the others' problem. The listener is removed on every path,
   * for the reason `nextEvent` gives: a pane that probes and aborts repeatedly
   * would otherwise pin a dead listener per attempt to a signal it still holds.
   */
  async function untilAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw aborted();
    let onAbort: (() => void) | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(aborted());
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort !== null) signal.removeEventListener("abort", onAbort);
    }
  }

  async function request(
    box: BoxAddress,
    method: string,
    params: Record<string, unknown>,
    opts: HermesChatOptions & { deadlineMs?: number | undefined } = {},
  ): Promise<unknown> {
    const entry = acquire(box);
    try {
      const rpc = await untilAbort(entry.dial, opts.signal);
      return await rpc.request(method, params, opts.deadlineMs, { signal: opts.signal });
    } finally {
      release(entry);
    }
  }

  function dispose(): void {
    for (const entry of [...live.values()]) {
      evict(entry);
      entry.dead = true;
      entry.rpc?.close();
    }
    live.clear();
    // Nothing left to close, so nothing for `disposeChatRequestPools` to reach.
    // `acquire` re-registers if this pool is used again.
    pools.delete(pool);
  }

  const pool: RequestPool = { request, dispose, size: () => live.size };
  return pool;
}
