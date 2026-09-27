/**
 * One `chat.observe` per conversation, shared by every reader of it.
 *
 * ## What this is
 *
 * `chat.observe` is a continuous watch on one conversation, and core shares
 * one upstream subscription between every observer of a given call. A head
 * that holds several readers of one conversation — N browser tabs, a CLI
 * tailing two bots — needs the same sharing one level up: one call into
 * `observe` per conversation, whoever asked first, with each reader handed the
 * subscription's last read on arrival and the live events after it.
 *
 * That policy — how many upstream reads per conversation, who shares them,
 * what a late reader is seeded with, what is remembered once a read ends — is
 * not a property of HTTP, so it lives here rather than in a head. What a head
 * keeps is *lifetime*: which conversations are pinned and why, when the pool
 * is started and stopped, and how a failure is spelled on its own wire. The
 * portal's `chat-owner.ts` is that layer; it decides, this executes.
 *
 * ## Pinned and guest
 *
 * A subscription is either *pinned* — held because the head said so, for as
 * long as the head says so — or a *guest*, refcounted, ended when its last
 * reader leaves. `pin()`/`unpin()` move one between the two; `join()` opens a
 * guest when nothing is held. A pinned subscription is not refcounted: that is
 * the whole point of pinning.
 *
 * ## Health is replayed, not only broadcast
 *
 * The events that say a watch is in trouble — `reconnect` while the upstream
 * read is being retried, `error` once it is over — would otherwise reach only
 * the readers connected when they were emitted. Everyone else would get a
 * transcript and no band: a conversation silently unwatched looks exactly
 * like a healthy one. So the current health of a conversation is *state*
 * here. A live subscription keeps its last health event (`Subscription.health`,
 * cleared by the next successful read); a pinned one that ended for a reason
 * leaves a bounded record behind it (`RememberedFailure`). Both are replayed to
 * whoever attaches next, under the event's own name and after the snapshot.
 *
 * ## What this is not
 *
 * Stopping an observation aborts a read loop on this laptop. It sends nothing
 * to the box, and there is no path from here to `chat.abort`.
 *
 * §8.3: what the `log` dep is handed records that a conversation is being
 * watched and why one stopped — never a message, a transcript, a snapshot or a
 * session token. Health events kept here are masked with `redactText` before
 * they are stored, so nothing replayed later carries what core's own redaction
 * did not already cover.
 */
import { isHermeticError } from "../errors.ts";
import type { ChatObserveEvent, ChatObserveInput } from "../schema/index.ts";
import { OBSERVE_WINDOW } from "./chat-observe.ts";
import { redactText } from "./chat-redact.ts";

/** Which conversation an observation is of. `session` null means the canonical one. */
export interface ChatConversationRef {
  instance: string;
  bot: string;
  session: string | null;
}

/** What a caller names when it joins; `session` omitted means the canonical one. */
export interface ChatObserveTarget {
  instance: string;
  bot: string;
  session?: string | undefined;
}

/** One observation event with the identity a fan-in reader needs to route it. */
export interface PooledChatEvent {
  conversation: ChatConversationRef;
  event: ChatObserveEvent;
}

/** One held subscription, as the head that decides lifetimes sees it. */
export interface ObservePoolEntry {
  ref: ChatConversationRef;
  pinned: boolean;
  /** The session the held read names, or `null` before the first read. */
  session: string | null;
}

/**
 * The two observation events that describe the *health* of a watch rather than
 * the conversation it is watching.
 *
 * They are the only members of the union a reader can miss and be wrong about.
 * A missed `message` is caught up by the next `snapshot`, which is
 * authoritative and replaces; a missed `reconnect` or `error` is a tab showing
 * a healthy-looking transcript of a conversation nobody is watching any more.
 */
type ChatHealthEvent = Extract<ChatObserveEvent, { type: "reconnect" | "error" }>;

/** One incremental message, the form every read after the first takes. */
type ChatMessageEvent = Extract<ChatObserveEvent, { type: "message" }>;

/** The terminal half of health: the observation is over and said why. */
type ChatFailureEvent = Extract<ChatObserveEvent, { type: "error" }>;

/**
 * A pinned conversation whose subscription ended with a reason, kept after the
 * subscription itself is gone.
 *
 * A terminated subscription is deleted from `subs` — it has no read loop, no
 * listeners and nothing to emit — and with it would go the only record that
 * the conversation had failed. Silence is the one answer this must never give.
 *
 * Bounded by count (`maxRememberedFailures`), least-recently failed evicted
 * first — a count rather than an age, because an age needs a timer and what
 * the bound has to guarantee is a ceiling on memory rather than a promise
 * about staleness. Entries also leave early, and normally do: when the
 * conversation is observed again (`pin`), when the head forgets one
 * (`forget`), and when everything is dropped (`drain`). The transcript is
 * deliberately *not* kept.
 */
interface RememberedFailure {
  ref: ChatConversationRef;
  event: ChatFailureEvent;
}

/**
 * How many terminated conversations are remembered at once.
 *
 * Sized for an outage that takes a whole fleet at one go rather than for the
 * common case: a dozen boxes of a few bots each fits inside it. The worst case
 * is a few kilobytes — each entry is a conversation ref and two short strings.
 */
export const OBSERVE_POOL_MAX_REMEMBERED_FAILURES = 64;

export type ObservePoolLogLevel = "debug" | "info" | "warn" | "error";

/** A throw, classified for the log and for the `error` event a reader gets. */
export interface ObservePoolFailure {
  code: string;
  message: string;
  /** The real message when `message` is a mask; for a log, never for a reader. */
  internal?: string;
}

export interface ObservePoolDeps {
  /**
   * The read this pool multiplexes. Called once per subscription, never
   * captured, so a head whose `Hermetic` is replaced (a fleet switch) hands
   * the pool the current one on every start.
   */
  observe: (input: ChatObserveInput, opts: { signal: AbortSignal }) => AsyncIterable<ChatObserveEvent>;
  /**
   * Code and message for a throw. The default forwards a `HermeticError` and
   * masks anything else as `INTERNAL`; a head with its own wire spelling of an
   * unclassified failure supplies it here so the log and the reader agree.
   */
  classify?: (e: unknown) => ObservePoolFailure;
  /** Where the pool says what it is doing. Core never logs on its own (rule 1). */
  log?: (level: ObservePoolLogLevel, message: string, fields: Record<string, unknown>) => void;
  /** Override for tests; the ceiling on `RememberedFailure` entries. */
  maxRememberedFailures?: number;
}

export interface ObservePool {
  /** Hold this conversation regardless of readers; starts it if nothing is held. */
  pin(ref: ChatConversationRef): void;
  /** Stop holding it: a guest now, ended at once when nothing reads it. */
  unpin(ref: ChatConversationRef, reason: string): void;
  /** End it now, readers or not; they are told the stream ended. */
  halt(ref: ChatConversationRef, reason: string): void;
  /** Every live subscription, pinned or guest. */
  held(): ObservePoolEntry[];
  has(ref: ChatConversationRef): boolean;
  /** The conversations remembered as failed, oldest first. */
  failed(): ChatConversationRef[];
  /** Drop a remembered failure without observing the conversation again. */
  forget(ref: ChatConversationRef): void;
  /**
   * Read one conversation, joining the held subscription or opening a guest.
   * A remembered failure is replayed and the stream ends; a stopped pool
   * answers with a terminal `ABORTED`.
   */
  join(target: ChatObserveTarget, signal: AbortSignal): AsyncIterable<ChatObserveEvent>;
  /** Every event of every *pinned* conversation, for a fan-in transport. */
  subscribe(listener: (event: PooledChatEvent) => void): () => void;
  /**
   * What a fan-in reader needs to start whole: the last read of each pinned
   * conversation, then its health if it is not well, then every remembered
   * failure.
   */
  snapshots(): PooledChatEvent[];
  /**
   * Which set of subscriptions the ones held now belong to; bumped by every
   * `drain`. A caller that suspended before a drain and resumes after it must
   * not install anything into the set the drain emptied.
   */
  epoch(): number;
  /** Drop every subscription and every remembered failure; the pool stays usable. */
  drain(reason: string): Promise<void>;
  /** Drain, and refuse everything after: joins end at once, pins start nothing. */
  stop(): Promise<void>;
  stopped(): boolean;
}

function defaultClassify(e: unknown): ObservePoolFailure {
  if (isHermeticError(e)) return { code: e.code, message: e.message };
  return {
    code: "INTERNAL",
    message: "internal error",
    internal: e instanceof Error ? e.message : String(e),
  };
}

export function refOf(target: ChatObserveTarget): ChatConversationRef {
  return { instance: target.instance, bot: target.bot, session: target.session ?? null };
}

/**
 * The subscription key: `<instance>/<bot>/<session>`, with the session's own
 * `null` distinguished from a session literally named "null". JSON rather than
 * a delimiter because a session id is an upstream string this file does not
 * get to constrain, and two conversations must never collide into one.
 */
export function keyOf(ref: ChatConversationRef): string {
  return JSON.stringify([ref.instance, ref.bot, ref.session]);
}

/**
 * The held read with one incremental message folded into it.
 *
 * Core sends a given observer a `snapshot` on its first reconcile and on every
 * later read whose session differs from the held one; every other read is a
 * `message` delta (`chat-observe.ts`). The pool attaches once per subscription
 * and holds it across readers, so without this the held read is frozen at the
 * instant the subscription started.
 *
 * Deduplication is on `ChatMessage.id`, upstream's own identity and the key
 * the browser's append is written against. Core deduplicates per observer
 * against its own window, but that is a property of one `observe` call and
 * does not survive a restart, so the fold does its own.
 *
 * Bounded to `OBSERVE_WINDOW`, newest kept, because that is the bound core's
 * own read carries and a pinned observation outlives every reader. A new array
 * rather than a `push`, because a reader may be mid-yield on the old one.
 *
 * `at` is left untouched: it is the stamp core put on the read this envelope
 * describes, and a fold does not redo that reconcile. The folded message's own
 * `at` is the box's row time, not the laptop's read time.
 */
export function folded(
  held: ChatObserveEvent | null,
  event: ChatMessageEvent,
): ChatObserveEvent | null {
  // Nothing authoritative to fold into, and deliberately not a synthesised
  // one: a partial transcript presented as the whole read is worse than none.
  if (held === null || held.type !== "snapshot") return held;
  // A message from a session the held read did not come from, refused. Core
  // leads a rollover with a fresh `snapshot`, which replaces the held read, so
  // this is defensive; but folding it would mislabel every later seed.
  if (held.session !== event.session) return held;
  if (held.messages.some((message) => message.id === event.message.id)) return held;
  const messages = [...held.messages, event.message];
  return { ...held, messages: messages.slice(-OBSERVE_WINDOW) };
}

interface Subscription {
  ref: ChatConversationRef;
  controller: AbortController;
  /** A `null` event means the subscription itself ended. */
  listeners: Set<(event: ChatObserveEvent | null) => void>;
  /**
   * The last authoritative read *plus every message since*, replayed to
   * whoever joins next. `folded` keeps it current.
   *
   * ## Why a late joiner cannot be handed a stale snapshot
   *
   * A reader is given this and then the live events. The obvious worry is the
   * gap between the two: a message emitted *while* the snapshot is delivered
   * would be newer than the state it describes.
   *
   * There is no such gap. `join()` does `sub.listeners.add(listener)` and then
   * `yield sub.snapshot` with no `await` between them; a fan-in reader does
   * `subscribe(…)` and then `snapshots()` likewise. The only writer of this
   * field is `run()`'s `for await` loop, which can only resume at a suspension
   * point, and there is none inside either attach. `run()` also assigns
   * `sub.snapshot` *before* it emits the same event, so the two never disagree.
   * `tests/chat-stream-seam.test.ts` asserts the absence of that `await`
   * against the source.
   */
  snapshot: ChatObserveEvent | null;
  /**
   * The last thing this subscription said about its own health, or `null`
   * while it is well. Replayed after `snapshot` to whoever attaches next;
   * cleared by the next `snapshot` or `message`, because a read that arrived is
   * a read that worked.
   */
  health: ChatHealthEvent | null;
  pinned: boolean;
  joiners: number;
  done: Promise<void>;
}

export function createObservePool(deps: ObservePoolDeps): ObservePool {
  const classify = deps.classify ?? defaultClassify;
  const maxFailures = deps.maxRememberedFailures ?? OBSERVE_POOL_MAX_REMEMBERED_FAILURES;
  const subs = new Map<string, Subscription>();
  const failures = new Map<string, RememberedFailure>();
  const fanIn = new Set<(event: PooledChatEvent) => void>();
  let stopped = false;
  let generation = 0;

  function log(level: ObservePoolLogLevel, message: string, fields: Record<string, unknown> = {}) {
    deps.log?.(level, message, fields);
  }

  /** A conversation, as log fields. Never carries anything the box said. */
  function where(ref: ChatConversationRef): Record<string, unknown> {
    return {
      instance: ref.instance,
      bot: ref.bot,
      ...(ref.session === null ? {} : { session: ref.session }),
    };
  }

  /** A throw, classified and then masked (§8.3) for the log. */
  function classified(e: unknown): ObservePoolFailure {
    const failure = classify(e);
    return {
      code: failure.code,
      message: redactText(failure.message),
      ...(failure.internal === undefined ? {} : { internal: redactText(failure.internal) }),
    };
  }

  /**
   * A health event as it is *kept*. A live reader is handed core's event
   * untouched, because core redacts before it emits; a replayed one is a copy
   * held here, read back minutes later by any reader, so it goes through the
   * second door as well.
   */
  function masked(event: ChatHealthEvent): ChatHealthEvent {
    return { ...event, message: redactText(event.message) };
  }

  /**
   * Remember a terminated conversation, evicting the least recently failed
   * once the bound is reached. Re-inserting deletes first, so the Map's
   * insertion order really is recency order.
   */
  function remember(ref: ChatConversationRef, event: ChatFailureEvent): void {
    const key = keyOf(ref);
    failures.delete(key);
    failures.set(key, { ref, event });
    while (failures.size > maxFailures) {
      const oldest = failures.keys().next();
      if (oldest.done === true) break;
      failures.delete(oldest.value);
    }
  }

  function emit(sub: Subscription, event: ChatObserveEvent | null): void {
    for (const listener of [...sub.listeners]) {
      try {
        listener(event);
      } catch {
        // A reader that throws loses its own events. It never ends the
        // subscription the other readers are sharing.
      }
    }
    if (event === null || !sub.pinned) return;
    const pooled: PooledChatEvent = { conversation: sub.ref, event };
    for (const listener of [...fanIn]) {
      try {
        listener(pooled);
      } catch {
        // Same rule, for the fan-in.
      }
    }
  }

  /**
   * The read loop for one conversation: the only caller of `deps.observe`,
   * which is what makes "one upstream stream per conversation" a property of
   * this module rather than a hope about callers.
   */
  async function run(sub: Subscription): Promise<void> {
    const { instance, bot, session } = sub.ref;
    const input: ChatObserveInput = { instance, bot, ...(session === null ? {} : { session }) };
    try {
      for await (const event of deps.observe(input, { signal: sub.controller.signal })) {
        // A snapshot replaces outright, which is also how the held read
        // follows a session rollover.
        if (event.type === "snapshot") sub.snapshot = event;
        else if (event.type === "message") sub.snapshot = folded(sub.snapshot, event);
        // A read that arrived is a read that worked, so it is also the end of
        // whatever this subscription was last complaining about.
        if (event.type === "snapshot" || event.type === "message") sub.health = null;
        else sub.health = masked(event);
        if (event.type === "error") {
          log("error", "observation failed", {
            ...where(sub.ref),
            code: event.code,
            message: redactText(event.message),
          });
        }
        emit(sub, event);
      }
      log("info", "observation ended", where(sub.ref));
    } catch (e) {
      if (sub.controller.signal.aborted) {
        // This laptop let go; not a failure, not something a reader needs an
        // `error` event about.
        log("debug", "observation detached", where(sub.ref));
      } else {
        const failure = classified(e);
        log("error", "observation failed", { ...where(sub.ref), ...failure });
        // A throw is terminal too, and a reader mid-stream can only be told
        // so in the stream. Already masked, so a late reader gets the same.
        const ended: ChatFailureEvent = {
          type: "error",
          instance,
          bot,
          code: failure.code,
          message: failure.message,
        };
        sub.health = ended;
        emit(sub, ended);
      }
    } finally {
      if (subs.get(keyOf(sub.ref)) === sub) subs.delete(keyOf(sub.ref));
      // Only a pinned one is remembered: a guest exists only while somebody is
      // reading it, and that somebody saw the failure live.
      if (sub.pinned && sub.health?.type === "error") remember(sub.ref, sub.health);
      emit(sub, null);
    }
  }

  function start(ref: ChatConversationRef, pinned: boolean): Subscription {
    const sub: Subscription = {
      ref,
      controller: new AbortController(),
      listeners: new Set(),
      snapshot: null,
      health: null,
      pinned,
      joiners: 0,
      done: Promise.resolve(),
    };
    // Nothing new is observed once stopped. The subscription is returned inert
    // — unregistered, with no read loop — so callers need no second shape.
    if (stopped) return sub;
    // Watching it again is the answer to having failed.
    failures.delete(keyOf(ref));
    subs.set(keyOf(ref), sub);
    log("info", "observing", { ...where(ref), pinned });
    // A microtask later, so a `join` that started this subscription has
    // attached its listener before the first event can be emitted. `observe`
    // refusing eagerly is otherwise an `error` emitted to nobody.
    sub.done = Promise.resolve().then(() => run(sub));
    return sub;
  }

  function haltSub(sub: Subscription, reason: string): void {
    if (subs.get(keyOf(sub.ref)) === sub) subs.delete(keyOf(sub.ref));
    sub.controller.abort();
    log("info", "observation stopped", { ...where(sub.ref), reason });
  }

  /** A guest subscription lives exactly as long as it has a reader. */
  function release(sub: Subscription, reason: string): void {
    if (sub.pinned || sub.joiners > 0) return;
    if (subs.get(keyOf(sub.ref)) !== sub) return;
    haltSub(sub, reason);
  }

  async function drain(reason: string): Promise<void> {
    // Before anything is torn down, so a caller suspended on its own await
    // cannot resume into the set this drain is clearing.
    generation += 1;
    const held = [...subs.values()];
    subs.clear();
    // A fleet switch must not carry the previous fleet's failures into the
    // next one, and a shutdown keeps nothing at all.
    failures.clear();
    for (const sub of held) {
      sub.pinned = false;
      sub.controller.abort();
    }
    // `run` swallows its own failures; `allSettled` is belt and braces so a
    // shutdown can never end in an unhandled rejection.
    await Promise.allSettled(held.map((sub) => sub.done));
    if (held.length > 0) log("info", "observations stopped", { count: held.length, reason });
  }

  return {
    pin(ref) {
      const existing = subs.get(keyOf(ref));
      if (existing !== undefined) {
        existing.pinned = true;
        return;
      }
      start(ref, true);
    },
    unpin(ref, reason) {
      const sub = subs.get(keyOf(ref));
      if (sub === undefined) return;
      sub.pinned = false;
      release(sub, reason);
    },
    halt(ref, reason) {
      const sub = subs.get(keyOf(ref));
      if (sub === undefined) return;
      sub.pinned = false;
      haltSub(sub, reason);
    },
    held() {
      return [...subs.values()].map((sub) => ({
        ref: sub.ref,
        pinned: sub.pinned,
        session: sub.snapshot?.type === "snapshot" ? sub.snapshot.session : null,
      }));
    },
    has(ref) {
      return subs.has(keyOf(ref));
    },
    failed() {
      return [...failures.values()].map((failure) => failure.ref);
    },
    forget(ref) {
      failures.delete(keyOf(ref));
    },
    join(target, signal) {
      return (async function* () {
        const ref = refOf(target);
        if (stopped) {
          // A reader that arrives mid-drain is told so terminally — the shape
          // a reader whose watch ended already gets — rather than handed a
          // fresh upstream read the shutdown has finished waiting for.
          yield {
            type: "error",
            instance: ref.instance,
            bot: ref.bot,
            code: "ABORTED",
            message: "the portal stopped observing",
          };
          return;
        }
        const key = keyOf(ref);
        const held = subs.get(key);
        const failure = held === undefined ? failures.get(key) : undefined;
        if (failure !== undefined) {
          // Remembered, and terminal: the reader is told what it missed and
          // the stream ends. Opening a fresh upstream read here would be a
          // retry loop nobody asked for; `pin` is how the watch comes back.
          yield failure.event;
          return;
        }
        const sub = held ?? start(ref, false);
        sub.joiners += 1;
        const pending: ChatObserveEvent[] = [];
        let live = true;
        let wake: (() => void) | null = null;
        const nudge = (): void => {
          const resume = wake;
          wake = null;
          resume?.();
        };
        const listener = (event: ChatObserveEvent | null): void => {
          if (event === null) live = false;
          else pending.push(event);
          nudge();
        };
        sub.listeners.add(listener);
        // Read in the same synchronous run as the snapshot below: this is the
        // health *at attach*, and anything that has changed it since is
        // already queued behind it in `pending`.
        const health = sub.health;
        const onAbort = (): void => {
          live = false;
          nudge();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          // The cached authoritative read, read with no `await` since
          // `sub.listeners.add` above. See `Subscription.snapshot`.
          if (sub.snapshot !== null) yield sub.snapshot;
          // After the transcript, because that is the order it happened in.
          if (health !== null) yield health;
          for (;;) {
            while (pending.length > 0) {
              const head = pending.shift();
              if (head !== undefined) yield head;
            }
            if (!live || signal.aborted) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        } finally {
          signal.removeEventListener("abort", onAbort);
          sub.listeners.delete(listener);
          sub.joiners -= 1;
          release(sub, "last reader left");
        }
      })();
    },
    subscribe(listener) {
      fanIn.add(listener);
      return () => {
        fanIn.delete(listener);
      };
    },
    snapshots() {
      const seeds: PooledChatEvent[] = [];
      for (const sub of subs.values()) {
        if (!sub.pinned) continue;
        if (sub.snapshot !== null) seeds.push({ conversation: sub.ref, event: sub.snapshot });
        // The transcript, and then what is wrong with the watch on it.
        if (sub.health !== null) seeds.push({ conversation: sub.ref, event: sub.health });
      }
      // And the conversations that have no subscription left to carry them.
      for (const failure of failures.values()) {
        seeds.push({ conversation: failure.ref, event: failure.event });
      }
      return seeds;
    },
    epoch() {
      return generation;
    },
    drain,
    async stop() {
      stopped = true;
      await drain("shutdown");
    },
    stopped() {
      return stopped;
    },
  };
}
