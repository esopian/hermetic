/**
 * One long-lived socket per conversation, held across turns (issue #60).
 *
 * A turn used to dial, run and hang up. Upstream's gateway counts the sockets
 * attached to each session, and when the last one closes it arms a twenty
 * second "ws orphan reap" (`tui_gateway/session_lifecycle.py`): unless a socket
 * re-attaches with `session.resume`, which cancels the timer, it tears the
 * session down with `agent.close()` — and that kills every background process
 * the session started (`exit_code -15`, `termination_source agent_close`). A
 * `sleep 60 &` started in one turn was dead before the operator typed the next
 * one. Hermes Desktop never sees this because it keeps its socket; this module
 * is how hermetic keeps one too.
 *
 * ## The shape
 *
 * A *hold* is one socket per `(box, bot, stored session)`, keyed by the stored
 * id because that is what a turn names. A turn *leases* it: a live hold hands
 * over its socket, otherwise a fresh one is dialled and the turn calls `keep`
 * once `session.create` or `session.resume` has named the ids, which registers
 * the hold. When the turn ends it *releases* the socket rather than closing it,
 * and the socket idles attached to the session, so the gateway never arms the
 * reap.
 *
 * An idle socket still carries events — a background process finishing
 * (`status.update` with `kind: "process"`), and the agent turn the gateway
 * starts on its own in reply. Those go to `onIdleEvent`, which the client wires
 * to the observation stream (`hermes-chat-observe.ts`) as hints.
 *
 * An idle socket that drops is redialled within the gateway's grace and
 * re-attached with `session.resume`. A redial that spends its budget, runs past
 * the grace, or finds the gateway already answering with a different runtime
 * evicts the hold and lets the gateway reap: there is nothing left to hold the
 * session with, and the next turn resumes the durable session on a fresh socket.
 *
 * Compression moves the conversation onto a new stored id while the gateway
 * keeps the same runtime (`tui_gateway/session_compression.py`'s
 * `_sync_session_key_after_compress`), so a hold is re-keyed (`rekey`) rather
 * than closed: closing it would reap the conversation that continues.
 *
 * Ending a conversation for good is closing its socket (`close`): the gateway
 * then reaps it after the grace. `session.close` is deliberately never sent —
 * it also ends the durable row, which is not what archiving or leaving a pane
 * means.
 */
import { abortableSleep } from "../../abort.ts";
import { HermeticError } from "../../errors.ts";
import { OBSERVE_RECONNECT_ATTEMPTS } from "../chat-observe.ts";
import {
  channel,
  dialDetached,
  type Rpc,
  untilAbort,
  withdrawServerRequests,
} from "./hermes-chat-rpc.ts";
import { CHAT_ERROR_CODES, type BoxAddress } from "./hermes-chat-types.ts";
import { HERMETIC_SESSION_SOURCE, rec, str } from "./hermes-chat-wire.ts";

/** Which conversation a held socket belongs to, as the idle listeners see it. */
export interface SessionHold {
  box: BoxAddress;
  bot: string;
  /** The durable session id a turn names. */
  stored: string;
  /** The gateway's runtime id for it, as of the last attach. */
  runtime: string;
}

export type IdleEventListener = (hold: SessionHold, event: Record<string, unknown>) => void;

/**
 * How long an idle redial may take overall. Upstream reaps an orphaned session
 * twenty seconds after its last socket closes (`session_lifecycle.py`); a
 * redial still trying after that would re-attach to a session the gateway has
 * already torn down and recreated, so it gives up with margin to spare.
 */
export const SESSION_REVIVE_GRACE_MS = 15_000;
/** Each request of an idle redial, so one stalled reply cannot spend the grace. */
export const SESSION_REVIVE_REQUEST_MS = 5_000;
/** The idle redial's backoff: tighter than a watch's, because the grace is short. */
export const SESSION_REVIVE_BASE_MS = 250;
export const SESSION_REVIVE_MAX_MS = 2_000;

/** The idle redial's budget, in `ChatResumeTuning`'s shape (`hermes-chat-turn.ts`). */
export interface SessionSocketTuning {
  attempts?: number | undefined;
  baseMs?: number | undefined;
  maxMs?: number | undefined;
  /** The whole redial's deadline, from the moment the socket was found dead. */
  graceMs?: number | undefined;
  /** The deadline on each request the redial makes. */
  requestMs?: number | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

export interface SessionSocketDeps {
  /**
   * `ChatConnection.connect`. This module never builds a socket itself, and
   * never passes a caller's signal here: a dial's signal is its socket's
   * lifetime, and a held socket's must be nobody's. The signal it does pass
   * aborts only while the dial is in flight (see `dialDetached`).
   */
  connect(box: BoxAddress, signal: AbortSignal | undefined): Promise<Rpc>;
  /** Where an event on an idle held socket goes; absent discards it. */
  onIdleEvent?: IdleEventListener | undefined;
  tuning?: SessionSocketTuning | undefined;
}

/**
 * An `Rpc` that several turns can read in sequence.
 *
 * `channel().drain()` is single-consumer with a last-writer-wins `wake`, so two
 * generators over one socket steal each other's events, and an abandoned idle
 * generator cannot be `return()`ed while it is parked in an `await`. The only
 * safe shape is one reader per socket for its whole life, feeding a tap per
 * lease: `events[Symbol.asyncIterator]()` hands out the current tap, or opens a
 * new one and closes the previous; `detach()` closes it, after which events go
 * to the idle sink — the frames the tap buffered and nobody read included.
 */
export interface SharedRpc extends Rpc {
  /** Open a fresh tap, so events from now on buffer for the next reader. */
  attach(): void;
  /**
   * Close the current tap and stop answering server→client requests. Frames
   * the tap still buffered, and every later event, go to the idle sink.
   * `withdraw: false` skips the second half, for a socket that never
   * advertised (an idle redial's).
   */
  detach(opts?: { withdraw?: boolean }): void;
  /** False once the underlying socket's event stream has ended. */
  alive(): boolean;
}

export interface SessionLease {
  rpc: SharedRpc;
  /** Register this socket as the conversation's hold, once the ids are known. */
  keep(stored: string, runtime: string): void;
  /**
   * Hand the socket back. `current` is the socket the turn ended on, which may
   * be a reconnect's rather than the one leased; a live one is kept, a dead one
   * (or `null`) evicts the hold.
   */
  release(current: Rpc | null): void;
}

export interface SessionSockets {
  /** A fresh, unheld `SharedRpc`; what a turn's pump reconnects with. */
  connect(box: BoxAddress, signal: AbortSignal | undefined): Promise<SharedRpc>;
  lease(
    box: BoxAddress,
    bot: string,
    stored: string | null,
    signal: AbortSignal | undefined,
  ): Promise<SessionLease>;
  /** The held socket and runtime id for a conversation, for abort and steer. */
  peek(box: BoxAddress, bot: string, stored: string): { rpc: SharedRpc; runtime: string } | null;
  /** End a conversation's hold: close its socket and forget it. */
  close(box: BoxAddress, bot: string, stored: string): boolean;
  /**
   * Move a conversation's hold to a new stored id, socket and runtime
   * untouched: what a compression does to the session on the gateway. False
   * when nothing was held under `from`.
   */
  rekey(box: BoxAddress, bot: string, from: string, to: string): boolean;
  /** Close every hold. Idempotent; the instance stays usable. */
  dispose(): void;
}

/** What a `SharedRpc` reports to the hold that owns it. */
interface Hooks {
  idle(event: Record<string, unknown>): void;
  ended(): void;
}

const NO_HOOKS: Hooks = { idle: () => {}, ended: () => {} };

/** The binding half of a `SharedRpc`, kept off the public shape. */
const hooksOf = new WeakMap<Rpc, (hooks: Hooks) => void>();

/** Wrap `raw` in one reader loop and per-lease taps. See `SharedRpc`. */
export function shareRpc(raw: Rpc): SharedRpc {
  type Tap = ReturnType<typeof channel<Record<string, unknown>>>;
  // A fresh socket starts attached, so the frames that arrive before its first
  // reader — `gateway.ready`, `session.info` — are buffered for it, as they
  // were when a turn owned its socket outright.
  let tap: Tap | null = channel();
  let handed = false;
  let live = true;
  let hooks = NO_HOOKS;

  function attach(): void {
    tap?.close();
    tap = channel();
    handed = false;
    if (!live) tap.close();
  }

  /** Close the tap, handing back what no reader took. */
  function closeTap(): Record<string, unknown>[] {
    const rest = tap?.take() ?? [];
    tap?.close();
    tap = null;
    return rest;
  }

  function detach(opts: { withdraw?: boolean } = {}): void {
    if (tap === null) return;
    // Frames after the turn's last read — a process notice right behind
    // `message.complete`, anything after an abort or a timeout — are the idle
    // sink's now, not lost with the tap.
    for (const event of closeTap()) hooks.idle(event);
    // Idle until the next lease, which advertises again before its prompt.
    if (live && opts.withdraw !== false) withdrawServerRequests(raw);
  }

  void (async () => {
    try {
      for await (const event of raw.events) {
        if (tap) tap.push(event);
        else hooks.idle(event);
      }
    } catch {
      // A stream that errors is a stream that ended, with a worse mood.
    } finally {
      live = false;
      tap?.close();
      hooks.ended();
    }
  })();

  const events: AsyncIterable<Record<string, unknown>> = {
    [Symbol.asyncIterator]() {
      if (tap === null || handed) attach();
      handed = true;
      // `attach` always leaves a tap; the fallback only satisfies the checker.
      return (tap ?? channel<Record<string, unknown>>()).drain()[Symbol.asyncIterator]();
    },
  };

  const shared: SharedRpc = {
    request: (method, params, deadlineMs, opts) => raw.request(method, params, deadlineMs, opts),
    events,
    arrived: () => raw.arrived(),
    unref: () => raw.unref?.(),
    close: () => {
      closeTap();
      raw.close();
    },
    attach,
    detach,
    alive: () => live,
  };
  hooksOf.set(shared, (next) => {
    hooks = next;
  });
  return shared;
}

/** The `SharedRpc` behind `rpc`, when it is one this module built. */
function asShared(rpc: Rpc | null): SharedRpc | null {
  return rpc !== null && hooksOf.has(rpc) ? (rpc as SharedRpc) : null;
}

function bind(rpc: SharedRpc, hooks: Hooks): void {
  hooksOf.get(rpc)?.(hooks);
}

interface Hold extends SessionHold {
  key: string;
  rpc: SharedRpc;
  /** Turns currently between `lease` and `release`. */
  leases: number;
  /** The single-flight idle redial, which a lease arriving mid-flight awaits. */
  reconnect: Promise<void> | null;
  /** Aborted by `close`/`dispose`, so a redial's backoff ends at once. */
  stop: AbortController;
}

/**
 * Every instance holding a socket, so `disposeChatRequestPools` can end them
 * all without a reference to the client core built. Membership tracks having
 * holds, exactly like `hermes-chat-pool.ts`'s `pools` and for the same reason:
 * a client is built per fleet switch, and a set that only grew would pin them.
 */
const instances = new Set<SessionSockets>();

/** Close every held session socket in this process. Safe to call twice. */
export function disposeSessionSockets(): void {
  for (const sockets of [...instances]) sockets.dispose();
}

/** How many instances currently hold a socket. Test-only introspection. */
export function trackedSessionSockets(): number {
  return instances.size;
}

const keyOf = (box: BoxAddress, bot: string, stored: string): string =>
  JSON.stringify([box.baseUrl, bot, stored]);

export function createSessionSockets(deps: SessionSocketDeps): SessionSockets {
  const attempts = deps.tuning?.attempts ?? OBSERVE_RECONNECT_ATTEMPTS;
  const baseMs = deps.tuning?.baseMs ?? SESSION_REVIVE_BASE_MS;
  const maxMs = deps.tuning?.maxMs ?? SESSION_REVIVE_MAX_MS;
  const graceMs = deps.tuning?.graceMs ?? SESSION_REVIVE_GRACE_MS;
  const requestMs = deps.tuning?.requestMs ?? SESSION_REVIVE_REQUEST_MS;
  const sleep = deps.tuning?.sleep ?? abortableSleep;
  const live = new Map<string, Hold>();

  /**
   * A fresh socket that outlives `signal`. The signal bounds only the wait for
   * the dial: a turn's signal is aborted once the turn is over (the app does so
   * after every turn), and a socket dialled with it would close then — taking
   * the hold with it, or the reconnect a turn's pump hands to the hold.
   */
  async function connect(box: BoxAddress, signal: AbortSignal | undefined): Promise<SharedRpc> {
    return shareRpc(await dialDetached((dial) => deps.connect(box, dial), signal));
  }

  /** Drop `hold` from the map if it is still the one the map points at. */
  function evict(hold: Hold): void {
    hold.stop.abort();
    if (live.get(hold.key) === hold) live.delete(hold.key);
    if (live.size === 0) instances.delete(sockets);
  }

  /**
   * Let go of `hold`: forget it, and close its socket unless a turn is still
   * reading it, in which case that turn's `settle` closes it on release.
   */
  function drop(hold: Hold): void {
    evict(hold);
    if (hold.leases === 0) hold.rpc.close();
  }

  /**
   * Fold every other hold attached to `hold`'s runtime into it.
   *
   * The stored id can move without this client being told — upstream's
   * post-turn auto-compression re-anchors the session key on the same runtime,
   * and so does a compact from another process — so the next turn names the
   * new id, finds no hold under it, and registers a second one on the same
   * runtime. Left alone, the old hold would keep the session attached after an
   * archive that closes only the new one, and every idle event would reach the
   * watch twice. The hold the turn just named is the current one.
   */
  function absorb(hold: Hold): void {
    for (const other of [...live.values()]) {
      if (other === hold || other.runtime !== hold.runtime) continue;
      if (other.bot !== hold.bot || other.box.baseUrl !== hold.box.baseUrl) continue;
      drop(other);
    }
  }

  /** Make `rpc` the hold for `(box, bot, stored)`, replacing whatever was there. */
  function register(
    box: BoxAddress,
    bot: string,
    stored: string,
    runtime: string,
    rpc: SharedRpc,
    leases: number,
  ): Hold {
    const key = keyOf(box, bot, stored);
    const previous = live.get(key);
    if (previous) {
      evict(previous);
      previous.rpc.close();
    }
    const hold: Hold = {
      key,
      box,
      bot,
      stored,
      runtime,
      rpc,
      leases,
      reconnect: null,
      stop: new AbortController(),
    };
    adopt(hold, rpc);
    live.set(key, hold);
    instances.add(sockets);
    absorb(hold);
    return hold;
  }

  /**
   * Route `rpc`'s idle events and its end to `hold`. An end only counts once
   * the hold has adopted the socket (`ended`), so a redial's half-built socket
   * can be bound before it is known to be good.
   */
  function bindTo(hold: Hold, rpc: SharedRpc): void {
    bind(rpc, {
      idle: (event) =>
        deps.onIdleEvent?.(
          { box: hold.box, bot: hold.bot, stored: hold.stored, runtime: hold.runtime },
          event,
        ),
      ended: () => ended(hold, rpc),
    });
  }

  /** Point `hold` at `rpc`: its idle events and its end now belong to the hold. */
  function adopt(hold: Hold, rpc: SharedRpc): void {
    hold.rpc = rpc;
    bindTo(hold, rpc);
  }

  /**
   * A held socket's event stream ended.
   *
   * Leased, the turn's pump owns the outage: it reconnects from its cursor and
   * `release` adopts what it ends on, or redials if that is dead too. Idle,
   * nobody else will notice, and the gateway's reap is already counting, so the
   * redial starts now.
   */
  function ended(hold: Hold, rpc: SharedRpc): void {
    if (hold.rpc !== rpc || live.get(hold.key) !== hold) return;
    if (hold.leases > 0 || hold.stop.signal.aborted) return;
    revive(hold);
  }

  /**
   * Redial an idle hold and re-attach it, inside the gateway's grace.
   *
   * Bounded three ways, because a late re-attach is worse than none: an overall
   * deadline (`graceMs`) inside the gateway's twenty-second reap, a deadline on
   * each request, and a short backoff. Success adopts the new socket. A resume
   * that answers with a different runtime means the gateway already reaped and
   * recreated the session — its processes are gone — so the hold is evicted
   * rather than pinned to a stranger. A spent budget, the deadline, a `close` or
   * a `dispose` evict it too and leave the reap to the gateway rather than
   * fighting it.
   */
  function revive(hold: Hold): void {
    if (hold.reconnect) return;
    // The redial's deadline, never the socket's: `connect` lets it end only the
    // dial in flight, and the resume below takes it per request, so a socket that
    // re-attaches in time outlives it. Only `close` and `dispose` (`stop`) end
    // a held socket.
    const signal = AbortSignal.any([hold.stop.signal, AbortSignal.timeout(graceMs)]);
    let kept = false;
    const run = async (): Promise<void> => {
      for (let used = 1; used <= attempts; used += 1) {
        await sleep(Math.min(maxMs, baseMs * 2 ** (used - 1)), signal);
        if (signal.aborted || live.get(hold.key) !== hold) return;
        let fresh: SharedRpc | null = null;
        try {
          fresh = await connect(hold.box, signal);
          // Idle from the first frame: nothing reads it until it is leased.
          // Bound to the hold now, so an event the gateway sends between the
          // resume and its reply still reaches the idle listeners. It never
          // advertised, so there is nothing to withdraw.
          bindTo(hold, fresh);
          fresh.detach({ withdraw: false });
          const resumed = rec(
            await fresh.request(
              "session.resume",
              {
                session_id: hold.stored,
                profile: hold.bot,
                source: HERMETIC_SESSION_SOURCE,
                defer_history: true,
                omit_messages: true,
              },
              requestMs,
              { signal },
            ),
          );
          const runtime = str(resumed?.session_id);
          if (!runtime)
            throw new HermeticError(
              CHAT_ERROR_CODES.PROTOCOL,
              `${hold.box.instance}: session.resume named no runtime session`,
            );
          if (signal.aborted || live.get(hold.key) !== hold) {
            fresh.close();
            return;
          }
          if (runtime !== hold.runtime) {
            fresh.close();
            evict(hold);
            return;
          }
          if (!fresh.alive()) {
            fresh.close();
            continue;
          }
          // Cleared before the adopt rather than when this flight settles: a
          // socket that ends between the two would otherwise find a redial
          // still "in flight" and start none.
          kept = true;
          hold.reconnect = null;
          adopt(hold, fresh);
          fresh.unref?.();
          return;
        } catch {
          fresh?.close();
          if (signal.aborted) return;
        }
      }
      evict(hold);
    };
    const flight: Promise<void> = run()
      .catch(() => evict(hold))
      .finally(() => {
        // A later flight may already own the slot, started by the socket this
        // one adopted ending at once.
        if (hold.reconnect === flight) hold.reconnect = null;
        if (!kept && signal.aborted) evict(hold);
      });
    hold.reconnect = flight;
  }

  async function lease(
    box: BoxAddress,
    bot: string,
    stored: string | null,
    signal: AbortSignal | undefined,
  ): Promise<SessionLease> {
    if (stored !== null) {
      const key = keyOf(box, bot, stored);
      let hold = live.get(key);
      if (hold?.reconnect) {
        await untilAbort(hold.reconnect, signal);
        hold = live.get(key);
      }
      // A hold another turn is still reading is not handed out: a second
      // reader would take the first one's tap (see `SharedRpc`). The second
      // turn dials its own socket, as every turn used to, and the gateway fans
      // the session's events out to both.
      if (hold && hold.leases === 0 && hold.rpc.alive()) return heldLease(hold);
    }
    // Detached from `signal` (see `connect`): it bounds the dial, and the
    // turn's requests carry it themselves.
    return freshLease(box, bot, await connect(box, signal));
  }

  function heldLease(hold: Hold): SessionLease {
    hold.leases += 1;
    hold.rpc.attach();
    const rpc = hold.rpc;
    let released = false;
    return {
      rpc,
      keep: (_stored, runtime) => {
        // Evicted while this turn was attaching — folded into another turn's
        // hold on the same runtime, or closed. That hold is the conversation's
        // now, and absorbing again would drop it; this socket closes on
        // release (`settle`).
        if (live.get(hold.key) !== hold) return;
        hold.runtime = runtime;
        absorb(hold);
      },
      release: (current) => {
        if (released) return;
        released = true;
        hold.leases -= 1;
        settle(hold, current, rpc);
      },
    };
  }

  function freshLease(box: BoxAddress, bot: string, rpc: SharedRpc): SessionLease {
    let hold: Hold | null = null;
    // The ids `keep` named while another socket already held the conversation;
    // `release` takes the hold over if that one is gone by then.
    let named: { stored: string; runtime: string } | null = null;
    let released = false;
    return {
      rpc,
      keep: (stored, runtime) => {
        if (hold !== null || released) return;
        // Another turn's socket already holds this conversation; whether this
        // one replaces it is decided on release, when both turns may be over.
        if (live.has(keyOf(box, bot, stored))) {
          named = { stored, runtime };
          return;
        }
        hold = register(box, bot, stored, runtime, rpc, 1);
      },
      release: (current) => {
        if (released) return;
        released = true;
        if (hold === null) {
          if (named === null || !takeOver(box, bot, named, current, rpc)) {
            current?.close();
            rpc.close();
          }
          return;
        }
        hold.leases -= 1;
        settle(hold, current, rpc);
      },
    };
  }

  /**
   * A second turn's socket, at its release: it becomes the hold when the one it
   * deferred to is gone or dead, so the conversation stays attached rather than
   * relying on a hold that no longer holds it. A hold still alive keeps the
   * conversation, and this socket closes, as every socket did before holds.
   */
  function takeOver(
    box: BoxAddress,
    bot: string,
    named: { stored: string; runtime: string },
    current: Rpc | null,
    leased: SharedRpc,
  ): boolean {
    const next = asShared(current);
    if (next === null || !next.alive()) return false;
    const existing = live.get(keyOf(box, bot, named.stored));
    if (existing?.rpc.alive()) return false;
    register(box, bot, named.stored, named.runtime, next, 0);
    if (next !== leased) leased.close();
    next.detach();
    next.unref?.();
    return true;
  }

  /**
   * After a release: keep the socket the turn ended on, or redial for it.
   *
   * A pump that reconnected ends on a socket this lease never opened, which is
   * the one attached now; the leased one is dead, and is closed in case it is
   * not. A turn that ended on a dead socket — one that dropped before its pump
   * existed, a pump that was off or spent its budget — leaves the hold idle
   * with nothing attached, so it redials exactly as an idle drop does. A hold
   * already closed under the turn just closes.
   *
   * A hold is leased at most once at a time (`lease` hands out only an
   * unleased one), so after this release nothing else is reading it.
   */
  function settle(hold: Hold, current: Rpc | null, leased: SharedRpc): void {
    const next = asShared(current);
    if (live.get(hold.key) !== hold || hold.stop.signal.aborted) {
      evict(hold);
      current?.close();
      leased.close();
      hold.rpc.close();
      return;
    }
    if (next === null || !next.alive()) {
      current?.close();
      leased.close();
      hold.rpc.close();
      revive(hold);
      return;
    }
    if (next !== hold.rpc) {
      const old = hold.rpc;
      adopt(hold, next);
      old.close();
    }
    next.detach();
    // Like the pool: nothing waits on an idle socket, so it should not be the
    // reason a one-shot process stays up, where the transport allows it.
    next.unref?.();
  }

  function peek(
    box: BoxAddress,
    bot: string,
    stored: string,
  ): { rpc: SharedRpc; runtime: string } | null {
    const hold = live.get(keyOf(box, bot, stored));
    if (!hold || hold.reconnect || !hold.rpc.alive()) return null;
    return { rpc: hold.rpc, runtime: hold.runtime };
  }

  function close(box: BoxAddress, bot: string, stored: string): boolean {
    const hold = live.get(keyOf(box, bot, stored));
    if (!hold) return false;
    evict(hold);
    hold.rpc.close();
    return true;
  }

  function rekey(box: BoxAddress, bot: string, from: string, to: string): boolean {
    const hold = live.get(keyOf(box, bot, from));
    if (!hold) return false;
    if (from === to) return true;
    const key = keyOf(box, bot, to);
    // A socket a later turn already holds under the new id is the stale one:
    // this hold's socket is the one attached to the continuing runtime. One a
    // turn is still reading closes when that turn releases it.
    const other = live.get(key);
    if (other) drop(other);
    live.delete(hold.key);
    hold.key = key;
    hold.stored = to;
    live.set(key, hold);
    instances.add(sockets);
    return true;
  }

  function dispose(): void {
    for (const hold of [...live.values()]) {
      evict(hold);
      hold.rpc.close();
    }
    live.clear();
    instances.delete(sockets);
  }

  const sockets: SessionSockets = {
    connect,
    lease,
    peek,
    close,
    rekey,
    dispose,
  };
  return sockets;
}

/**
 * The in-process bus from idle held sockets to the observation stream.
 *
 * One per client: `createSessionSockets` publishes through `onIdleEvent`, and
 * each open observation subscribes for its own box.
 */
export function createIdleBus() {
  const listeners = new Set<{ box: string; listener: IdleEventListener }>();
  return {
    publish(hold: SessionHold, event: Record<string, unknown>): void {
      for (const entry of [...listeners]) {
        if (entry.box !== hold.box.baseUrl) continue;
        try {
          entry.listener(hold, event);
        } catch {
          // One listener's failure is not another's, nor the socket's.
        }
      }
    },
    subscribe(box: BoxAddress, listener: IdleEventListener): () => void {
      const entry = { box: box.baseUrl, listener };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
  };
}

export type IdleBus = ReturnType<typeof createIdleBus>;
