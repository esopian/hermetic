/**
 * The portal's own chat observations (§9.2: one upstream subscription per
 * conversation, shared by every observer).
 *
 * ## Why the server owns them
 *
 * `chat.observe` is a continuous watch on one conversation. With one SSE
 * request per observer and nothing else holding the conversation, closing the
 * last tab removes the last observer, the subscription ends, and the portal
 * goes back to learning about a Desktop message only when somebody happens to
 * look. The acceptance criterion for the phase is the opposite: an external
 * message arrives without a two-minute wait, and *tab closing detaches only
 * its observation*. So the subscriptions belong to the server, not to a
 * request.
 *
 * ## What is here and what is not
 *
 * The sharing itself — one upstream read per conversation however many tabs
 * read it, the seed a late joiner is handed, the health that is replayed, the
 * bounded memory of failures — is core's `createObservePool`
 * (`packages/core/src/chat/observe-pool.ts`), because none of it is HTTP and a
 * CLI tailing two bots needs the same thing. What this module keeps is
 * *lifetime*: which conversations are pinned and why (`sync`, one per
 * `<instance>/<bot>` the operator listens to), when the pool starts and stops
 * (boot, `chat.listen`, a §4.8 fleet switch, shutdown), the one-conversation
 * `resume` an operator's `Watch again` sends, and how an unclassified failure
 * is spelled on the wire (`classifyFailure`) and in `app.log`.
 *
 * Both browser transports — the per-conversation `GET
 * /api/chat/:instance/:bot/observe` and the fan-in `GET /api/chat/stream` —
 * read through `join()`/`subscribe()` here rather than calling
 * `hermetic().chat.observe` themselves, which is what keeps the count honest.
 *
 * "Unlisten is local observation control, not permission to interrupt remote
 * work." Stopping an observation aborts a read loop on this laptop; it sends
 * nothing. §8.3: the log records that a conversation is being watched and why
 * one stopped — never a message, a transcript, a snapshot or a session token.
 */
import { createObservePool, keyOf, refOf, redactText } from "@hermetic/core";
import type {
  ChatConversationRef,
  ChatObserveEvent,
  ChatObserveTarget,
  Hermetic,
  ObservePool,
  PooledChatEvent,
} from "@hermetic/core";
import { classifyFailure } from "./errors.ts";
import type { LogLevel, AppLog } from "./log.ts";

export type { ChatConversationRef, ChatObserveTarget } from "@hermetic/core";

/** One observation event with the identity a fan-in reader needs to route it. */
export type OwnedChatEvent = PooledChatEvent;

/** What a `resume` did, so a head can say whether the watch is back. */
export interface ChatResumeResult {
  instance: string;
  bot: string;
  session: string | null;
  /** A subscription for this conversation is live now. */
  observing: boolean;
  /** This call is what started it; false when one was already running. */
  restarted: boolean;
  /** The instance is listened to, which is what a held subscription needs. */
  listening: boolean;
}

export interface ChatOwnerDeps {
  /**
   * Read per use, never captured: `hermetic-portal` can boot uninitialized and
   * swap in a real instance when the wizard finishes, and §4.8's fleet switch
   * replaces it again (see `app.ts`).
   */
  hermetic: () => Hermetic;
  /** The portal log (`log.ts`). Core never logs (§3.2 rule 1); this head does. */
  log?: AppLog;
}

export interface ChatOwner {
  /**
   * Reconcile the held subscriptions against what the operator listens to.
   * Never throws: a fleet that cannot be read leaves the subscriptions alone
   * and says so in the log. Calls are serialized, so a boot sync and a
   * `chat.listen` sync cannot interleave.
   */
  sync(): Promise<void>;
  /** The conversations held because they are listened to. */
  owned(): ChatConversationRef[];
  /** Every conversation with a live subscription, owned or guest. */
  observing(): ChatConversationRef[];
  /** Read one conversation, joining the held subscription when there is one. */
  join(target: ChatObserveTarget, signal: AbortSignal): AsyncIterable<ChatObserveEvent>;
  /**
   * Re-establish exactly one conversation, because the operator asked for the
   * watch back.
   *
   * Emphatically **not** a `sync()`. A reconcile re-reads every listened box's
   * roster and restarts every conversation that is missing, so one click on one
   * failed conversation used to re-read the whole fleet. This starts the one
   * named and touches nothing else. It is an observation, not a write.
   *
   * A named session is resumed the same way and held the same way — until the
   * next reconcile, which keeps one conversation per bot in the owned set and
   * hands a session watch back to its own readers.
   */
  resume(target: ChatObserveTarget): Promise<ChatResumeResult>;
  /** Every event of every *owned* conversation, for the fan-in transport. */
  subscribe(listener: (event: OwnedChatEvent) => void): () => void;
  /**
   * What a fan-in reader needs to start whole: the last snapshot of each owned
   * conversation, and the current health of every one that is not well.
   */
  snapshots(): OwnedChatEvent[];
  /** Drop every subscription; the owner stays usable (a §4.8 fleet switch). */
  reset(): Promise<void>;
  /** Drop every subscription for good (shutdown). Later syncs do nothing. */
  stop(): Promise<void>;
}

const SCOPE = "chat";

export function createChatOwner(deps: ChatOwnerDeps): ChatOwner {
  function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
    deps.log?.line(level, SCOPE, message, fields);
  }

  /** A conversation, as log fields. Never carries anything the box said. */
  function where(ref: ChatConversationRef): Record<string, unknown> {
    return {
      instance: ref.instance,
      bot: ref.bot,
      ...(ref.session === null ? {} : { session: ref.session }),
    };
  }

  /**
   * Core's code and message for a throw, with an unclassified one masked the
   * way every other response from this server masks it (`classifyFailure`), so
   * a reader gets `INTERNAL_MESSAGE` on the stream and the operator gets the
   * real thing in `app.log`. The pool applies `redactText` on top.
   */
  function classify(e: unknown): { code: string; message: string; internal?: string } {
    const failure = classifyFailure(e);
    return {
      code: failure.body.error.code,
      message: failure.body.error.message,
      ...(failure.internal === undefined ? {} : { internal: failure.internal }),
    };
  }

  /** The same masking for a message this file logs itself. */
  function masked(e: unknown): Record<string, unknown> {
    const failure = classify(e);
    return {
      code: failure.code,
      message: redactText(failure.message),
      ...(failure.internal === undefined ? {} : { internal: redactText(failure.internal) }),
    };
  }

  const pool: ObservePool = createObservePool({
    observe: (input, opts) => deps.hermetic().chat.observe(input, opts),
    classify,
    log: (level, message, fields) => log(level, message, fields),
  });

  /** Syncs and drains run one at a time; `reconcile` reads state a concurrent one would move. */
  let queue: Promise<void> = Promise.resolve();
  /** Ends the roster reads a reconcile is in the middle of, so a shutdown is prompt. */
  let reading = new AbortController();

  async function reconcile(): Promise<void> {
    if (pool.stopped()) return;
    let instances: readonly string[];
    try {
      instances = (await deps.hermetic().chat.listening({})).instances;
    } catch (e) {
      // An uninitialized home, a fleet mid-switch: nothing to observe and
      // nothing wrong. The subscriptions already held are left alone.
      log("debug", "listening read failed", masked(e));
      return;
    }
    if (pool.stopped()) return;

    // `chat.listen --off` is the operator saying they no longer care what this
    // box's conversations are doing, which includes why one of them stopped.
    for (const ref of pool.failed()) {
      if (!instances.includes(ref.instance)) pool.forget(ref);
    }

    /** The `<instance>/<bot>` pairs that should be held, and whose rosters answered. */
    const wanted = new Map<string, ChatConversationRef>();
    const answered = new Set<string>();
    for (const instance of instances) {
      try {
        const { swarms } = await deps.hermetic().chat.swarms({ instance }, { signal: reading.signal });
        answered.add(instance);
        for (const swarm of swarms) {
          for (const bot of swarm.bots) {
            const ref: ChatConversationRef = { instance: swarm.instance, bot: bot.name, session: null };
            wanted.set(keyOf(ref), ref);
          }
        }
      } catch (e) {
        // A roster this laptop could not read is not a roster that changed.
        log("warn", "roster read failed", { instance, ...masked(e) });
      }
    }
    if (pool.stopped()) return;

    for (const entry of pool.held()) {
      if (!instances.includes(entry.ref.instance)) {
        // `chat.listen --off`. Core ends its own leases for the instance for
        // the same reason; this is the head letting go of what it was holding,
        // and it interrupts nothing on the box.
        pool.halt(entry.ref, "no longer listening");
        continue;
      }
      if (!entry.pinned || !answered.has(entry.ref.instance) || wanted.has(keyOf(entry.ref))) continue;
      // The bot is gone from a roster that did answer. A tab still reading it
      // keeps it alive as a guest until that tab leaves.
      pool.unpin(entry.ref, "last reader left");
    }

    for (const ref of wanted.values()) pool.pin(ref);
  }

  function drain(reason: string): Promise<void> {
    // Abort the roster reads first, so a reconcile mid-flight bails promptly.
    reading.abort();
    reading = new AbortController();
    return pool.drain(reason);
  }

  return {
    sync(): Promise<void> {
      queue = queue.then(reconcile, reconcile);
      return queue;
    },
    owned(): ChatConversationRef[] {
      return pool
        .held()
        .filter((entry) => entry.pinned)
        .map((entry) => entry.ref);
    },
    observing(): ChatConversationRef[] {
      return pool.held().map((entry) => entry.ref);
    },
    join(target: ChatObserveTarget, signal: AbortSignal): AsyncIterable<ChatObserveEvent> {
      return pool.join(target, signal);
    },
    /**
     * One conversation back, and nothing else touched.
     *
     * Not queued behind the reconcile lock: a reconcile can take as long as
     * the slowest box it is reading, and an operator pressing a button must
     * not wait on that. It does not need to — both decide whether to start by
     * reading the pool *synchronously* immediately before `pin()`, which is
     * itself synchronous, so neither can observe the other half-done. The
     * `listening` read below is the only await, and the pool is re-read after
     * it for exactly that reason. `epoch` guards the other race: a drain (a
     * fleet switch, a shutdown) landing inside that await invalidates the
     * answer rather than letting it install a subscription into the set the
     * drain emptied.
     */
    async resume(target: ChatObserveTarget): Promise<ChatResumeResult> {
      const ref = refOf(target);
      const epoch = pool.epoch();
      const answer = (
        observing: boolean,
        restarted: boolean,
        listening: boolean,
      ): ChatResumeResult => ({
        instance: ref.instance,
        bot: ref.bot,
        session: ref.session,
        observing,
        restarted,
        listening,
      });
      if (pool.stopped()) return answer(false, false, false);
      let instances: readonly string[];
      try {
        // Local: which instances the operator listens to, not a read of any
        // box. The roster-per-box fan-out a reconcile does is the thing this
        // method exists to avoid.
        instances = (await deps.hermetic().chat.listening({})).instances;
      } catch (e) {
        log("debug", "listening read failed", masked(e));
        if (pool.epoch() !== epoch) return answer(false, false, false);
        return answer(pool.has(ref), false, false);
      }
      if (pool.stopped() || pool.epoch() !== epoch) return answer(false, false, false);
      const listening = instances.includes(ref.instance);
      if (pool.has(ref)) return answer(true, false, listening);
      if (!listening) {
        // Nothing here to put back. A conversation on an instance nobody
        // listens to is watched only while a reader is reading it; the way to
        // hold it is `PUT /api/chat/listening`, which the head can see from
        // the answer.
        log("debug", "resume declined", { ...where(ref), reason: "not listening" });
        return answer(false, false, false);
      }
      /**
       * The same conversation asked for under its session id. A canonical
       * subscription's held read names the session it is currently on, so a
       * head resuming by that id means the conversation already held — and a
       * second one would be two upstream reads of one conversation (§9.2).
       * Keyed on the held read, not merely on a pinned canonical existing: a
       * session that is genuinely not the canonical one is resumed as itself.
       */
      if (ref.session !== null) {
        const canonical = pool
          .held()
          .find(
            (entry) =>
              entry.ref.instance === ref.instance &&
              entry.ref.bot === ref.bot &&
              entry.ref.session === null,
          );
        if (canonical?.pinned === true && canonical.session === ref.session)
          return answer(true, false, true);
      }
      pool.pin(ref);
      log("info", "observation resumed", where(ref));
      return answer(true, true, true);
    },
    subscribe(listener: (event: OwnedChatEvent) => void): () => void {
      return pool.subscribe(listener);
    },
    snapshots(): OwnedChatEvent[] {
      return pool.snapshots();
    },
    reset(): Promise<void> {
      // Queued rather than immediate, so a sync started against the fleet this
      // server is leaving cannot install a subscription after the drain.
      const done = (): Promise<void> => drain("fleet switch");
      queue = queue.then(done, done);
      return queue;
    },
    async stop(): Promise<void> {
      // Immediately, because a shutdown must not wait on a roster read — and
      // then again behind the queue, because a reconcile that was mid-flight
      // when the signal arrived is only guaranteed to have bailed by then.
      reading.abort();
      reading = new AbortController();
      await pool.stop();
      const done = (): Promise<void> => drain("shutdown");
      queue = queue.then(done, done);
      await queue;
    },
  };
}
