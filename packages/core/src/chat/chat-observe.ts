/**
 * Continuous conversation observation (§9.2).
 *
 * ## What it is for
 *
 * Before this module the portal learned that a conversation had moved only
 * while somebody was looking at it: a panel that was visible and idle polled,
 * and everything else waited. A message sent from Hermes Desktop, typed into
 * the CLI on another machine, or produced by a cron routine at 03:00 was
 * therefore invisible until an operator happened to refresh. Observation is the
 * missing half — a watch on a conversation that exists with no outgoing message
 * at all.
 *
 * ## Four rules it is built on
 *
 * **Upstream owns the transcript.** Hermetic owns viewer preferences and the
 * coordination state below; it does not own an independent authoritative
 * transcript. So every event this service emits is derived from an
 * *authoritative read* of the box's durable history, never from an accumulated
 * log. The live hints it can be handed are advisory: a hint says "something
 * happened over there", it never says what, and the answer to what always comes
 * from the snapshot. A gateway that broadcasts nothing at all degrades to the
 * poll below and stays correct — and that is a supported configuration rather
 * than a tolerated accident: the hint channel has its own bounded budget, and
 * spending it stops the reopening rather than ending the watch.
 *
 * **Observation is passive.** It does not create a canonical session, warm a
 * model, submit a prompt or trigger a job. `snapshot` is the durable REST read
 * (`chat.history`), which pages stored rows without allocating a backend, and
 * the hint stream is a socket that listens. Nothing here writes.
 *
 * **Unknown delivery is not permission to replay.** This service has no send
 * path and cannot acquire one: a dropped stream reconnects and *re-reads*, so a
 * prompt accepted by the box before the drop is reconciled from the transcript
 * rather than sent a second time.
 *
 * **Unlisten is local observation control.** Detaching stops watching. It never
 * interrupts a remote turn, and nothing in this file calls `abort`.
 *
 * ## Deduplication
 *
 * The cursor is the set of `ChatMessage.id` values in the last snapshot window,
 * plus that window's newest timestamp. `ChatMessage.id` is upstream's own
 * identity, not one invented here: `mapHistory` in `hermes-chat-history.ts`
 * takes the durable REST row's `id` (`message_id` where upstream sends one),
 * which is the numeric primary key of the dashboard's message table, and only
 * falls back to a `<session>:<offset>` composite for a row that carried
 * neither. It is the canonical-history equivalent of the `event_id` the hosted
 * room work keys its deduplication on.
 *
 * Reconciling is then a set difference against the previous window. A replayed
 * hint produces an identical snapshot and therefore no events; two overlapping
 * reads cannot happen at all, because one subscription reconciles at a time.
 *
 * The window is bounded (`OBSERVE_WINDOW`), which bounds the cursor with it. A
 * message that has scrolled out of the window can never scroll back in — a
 * transcript only grows — so forgetting its id cannot resurrect it.
 *
 * ## One upstream subscription, many observers
 *
 * Observers are keyed by `instance/bot/session`. The first attaches a
 * subscription: one hint stream, one reconcile loop. Every later observer on the
 * same key joins it, is handed the snapshot the subscription already holds — no
 * extra upstream read — and shares the same deduplicated event flow, so two
 * browser tabs cannot double a turn. An observation writes no inbox row at all:
 * §4.9 gives `chat.message` one source, the `chat.swarms` roster diff.
 * Detaching removes one observer; the subscription ends only when the last one
 * leaves.
 */
import { abortableSleep } from "../abort.ts";
import { redactText } from "./chat-redact.ts";
import { HermeticError } from "../errors.ts";
import type { ChatMessage, ChatObserveEvent } from "../schema/index.ts";

/* ── the policy constants ─────────────────────────────────────────────────── */

/**
 * How many of the newest messages an observation reads each time.
 *
 * It is the deduplication window as well as the read, so it has to be larger
 * than anything that can plausibly arrive between two reconciles. Two hundred
 * messages against a five-second cadence is four orders of magnitude of
 * headroom, and it is still a bounded read: the durable route pages stored
 * rows, so the cost is one page rather than a whole transcript per tick.
 */
export const OBSERVE_WINDOW = 200;

/**
 * The reconcile floor, and the poll when no live hint stream exists.
 *
 * Five seconds is chosen against the operator, not against the box: it is
 * inside the window in which somebody who has just been told "the agent is
 * working on it" will wait rather than reach for refresh, and the two-minute
 * idle poll this replaces is outside it. The read is the durable REST route, so
 * a tick takes no warm backend slot and competes with nothing the agent is
 * doing. A hint, when there is a hint stream, wakes the loop sooner; the floor
 * exists so that a gateway which drops a broadcast cannot strand a transcript.
 */
export const OBSERVE_POLL_MS = 5_000;

/**
 * The retry budget: five attempts, `1s, 2s, 4s, 8s, 16s`, capped at 30s.
 *
 * It is spent by two different things and means a different thing to each, so
 * `run` keeps two counters rather than one (see the comment on `run`).
 *
 * Against the **authoritative read** it is bounded because past half a minute
 * the box is not restarting, it is down or off the tailnet, and the honest
 * answer is an `error` event telling the operator so. An unbounded retry loop
 * against a tailnet name that no longer resolves is a laptop that burns a
 * request every second forever and never says why.
 *
 * Against the **hint channel** it is bounded because a gateway that does not
 * broadcast must not be reconnect-stormed. Spending it there is not a failure
 * of the observation: it ends the reopening and leaves the loop on
 * `OBSERVE_POLL_MS`, which is a complete design.
 *
 * The usual reason a chat socket drops is the box's dashboard restarting —
 * which also mints a new session token, so the adapter has to re-scrape — and
 * that is back inside a few seconds; five attempts covers a restart with room
 * to spare. The hint counter **resets once the stream has survived a wait**, so
 * it bounds one outage rather than one observation's lifetime: a watch left
 * open for a day across three brief drops is not supposed to fall back to
 * polling because it has now seen three.
 *
 * The first delay is a whole second rather than something smaller because every
 * retry costs the box a token scrape; a tighter first attempt would turn a
 * dashboard restart into a small stampede and would still be too early.
 */
export const OBSERVE_RECONNECT_ATTEMPTS = 5;
export const OBSERVE_RECONNECT_BASE_MS = 1_000;
export const OBSERVE_RECONNECT_MAX_MS = 30_000;

/**
 * Read failures worth retrying. Everything else ends the observation at once.
 *
 * The distinction is whether waiting could change the answer. A box that did
 * not answer may answer in four seconds; an instance this laptop has stopped
 * listening to, a fleet that no longer matches, or a request that failed
 * validation will fail identically five times and then produce the same error
 * event four minutes later than it should have.
 *
 * This set governs the *authoritative read* alone. The hint channel has a
 * budget and an ending of its own, because losing a hint is never evidence that
 * a conversation cannot be observed — only the read can prove that.
 */
const RETRYABLE = new Set([
  "CHAT_UNREACHABLE",
  "CHAT_PROTOCOL",
  "CHAT_NO_SLOT",
  "CHAT_TURN_FAILED",
  "TIMEOUT",
]);

/**
 * The synthetic code for "the hint stream ended", kept apart from
 * `CHAT_UNREACHABLE`.
 *
 * It used to *be* `CHAT_UNREACHABLE`, which conflated two unlike things: a box
 * that did not answer a read, and a gateway that simply does not broadcast. The
 * first is a reason to retry the read and eventually to give up on the
 * conversation; the second is a reason to stop asking for hints and keep
 * polling. Separate codes on separate budgets say which happened, and
 * `CHAT_UNREACHABLE` keeps its retryable meaning on the read path alone.
 *
 * Deliberately not an `ErrorCode`: nothing throws it. It is only ever the
 * `code` of an advisory `reconnect` event, whose `code` is a free-form string
 * exactly as `UNKNOWN` from `reason` already is.
 */
export const OBSERVE_HINTS_ENDED = "CHAT_HINTS_ENDED";

/* ── the seams ────────────────────────────────────────────────────────────── */

/** One conversation, named the way §9.2 addresses one. */
export interface ChatObserveTarget {
  instance: string;
  bot: string;
  /** Watch one session; omitted means the bot's canonical one. */
  session?: string | undefined;
}

/**
 * "Something happened over there", and deliberately nothing more.
 *
 * A hint never carries a message, because a message that arrived on a socket
 * this service did not drive is not evidence the box's durable transcript says
 * the same thing. Its only job is to make the next authoritative read happen
 * now rather than at the next poll.
 */
export interface ChatObserveHint {
  /** The session the hint concerned, when the source could tell. Advisory. */
  session?: string | null | undefined;
}

/** The authoritative read: the box's own transcript, already redacted. */
export interface ChatObserveSnapshot {
  /** The session the transcript came from, or null when the bot has none. */
  session: string | null;
  /** The newest `OBSERVE_WINDOW` messages, oldest first. */
  messages: ChatMessage[];
}

export interface ChatObserveOptions {
  signal?: AbortSignal | undefined;
  /**
   * Every session this watch answers for, asked at each hint rather than fixed
   * when the stream opened.
   *
   * Passed to `hints` and to nothing else. A watch pinned to one session still
   * has to hear about that conversation's continuation: upstream compresses a
   * session into a new tip and broadcasts under the tip, so the pinned id stops
   * appearing in events while the conversation carries on. The tip is whatever
   * the last authoritative read came back from, which is why this is a function
   * — the stream outlives any one read.
   */
  sessions?: (() => readonly string[]) | undefined;
}

export interface ChatObserveDeps {
  /**
   * The authoritative transcript read. Must be passive — the durable history
   * route, never a session resume — and must already have been through the
   * redaction door, because this module is not a second one.
   */
  snapshot(target: ChatObserveTarget, opts: ChatObserveOptions): Promise<ChatObserveSnapshot>;
  /**
   * The live hint source, when the gateway has one. Optional, and its absence
   * is a complete design rather than a degraded one: without it the loop
   * reconciles on `pollMs` alone and every guarantee above still holds.
   */
  hints?(target: ChatObserveTarget, opts: ChatObserveOptions): AsyncIterable<ChatObserveHint>;
  /**
   * Whether a hint channel is worth opening for this conversation *now*.
   *
   * `hints` says a hint channel exists as code; this says it works as a
   * deployment. Answering only the first question is what made the documented
   * degrade-to-poll path unreachable in production: the real adapter always
   * defines its `observe`, so a gateway whose socket closes the instant it is
   * opened — an older Hermes, a proxy that drops the upgrade, a middlebox —
   * looked supported while delivering nothing.
   *
   * Consulted before every open, so a caller that learns the answer between two
   * polls is obeyed on the next one, and a caller that later changes its mind
   * gets its stream back. Absent means "always try", which is what a caller
   * with no opinion wants.
   */
  hintsUsable?(target: ChatObserveTarget): boolean;
  /** ISO-8601 now, injected so a fixture's events are deterministic. */
  now(): string;
  /** Injected so a test asserts the backoff instead of waiting for it. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  pollMs?: number | undefined;
  reconnect?:
    | { attempts?: number | undefined; baseMs?: number | undefined; maxMs?: number | undefined }
    | undefined;
}

/* ── the observer queue ───────────────────────────────────────────────────── */

/**
 * One observer's mailbox: a bounded-by-nothing FIFO the subscription pushes
 * into and the caller's generator drains.
 *
 * Buffered rather than dropping, for `hermes-chat-rpc.ts`'s reason: the
 * subscription reconciles on its own schedule and a consumer that is slow for
 * one tick must not lose the message that arrived during it. Closed exactly
 * once, from either end — the subscription ending, or the caller walking away.
 */
interface Mailbox {
  push(event: ChatObserveEvent): void;
  close(): void;
  /** The next event, or `undefined` once the mailbox is closed and drained. */
  next(): Promise<ChatObserveEvent | undefined>;
}

/**
 * Deliberately a `next()` rather than an inner async generator.
 *
 * An async generator suspended on an unresolved `await` cannot be returned
 * until that `await` settles, so a mailbox that parked on a promise nothing was
 * going to resolve would make `for await (… of drain())` un-exitable — and the
 * caller's `finally`, which is what closes the mailbox, sits *outside* that
 * loop. The result was a consumer that walked away from an idle observation and
 * hung. With a plain `next()` the observer generator is suspended at its own
 * `yield`, so returning it runs the cleanup immediately.
 */
function mailbox(): Mailbox {
  const buffer: ChatObserveEvent[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const nudge = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    push(event) {
      if (done) return;
      buffer.push(event);
      nudge();
    },
    close() {
      done = true;
      nudge();
    },
    async next() {
      for (;;) {
        const head = buffer.shift();
        if (head !== undefined) return head;
        if (done) return undefined;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/* ── the subscription ─────────────────────────────────────────────────────── */

interface Subscription {
  key: string;
  target: ChatObserveTarget;
  observers: Set<Mailbox>;
  /** The last authoritative read, handed to every observer that joins late. */
  snapshot: ChatObserveSnapshot | null;
  /** The cursor: every message id in that read. */
  window: Set<string>;
  controller: AbortController;
  /** How many upstream hint streams this subscription has opened. */
  streams: number;
}

/**
 * Why the loop woke.
 *
 * `ended` carries the throw when the hint iterator rejected rather than
 * finishing, for two reasons: the loop can then report the gateway's own code
 * instead of inventing one, and a rejection that *loses* the race is consumed
 * here rather than left to surface as an unhandled rejection later.
 */
type Wake =
  | { kind: "hint" }
  | { kind: "tick" }
  | { kind: "ended"; error?: unknown }
  | { kind: "aborted" };

/**
 * One hint stream, with its in-flight read held across a wait that ended
 * without it.
 *
 * Losing a race must not abandon the pull. An async iterator queues every
 * `next()` and answers them in order, so a second call made after the poll
 * floor won would be answered *second*: the hint that arrives next settles the
 * promise the race already threw away, and the read it should have woken waits
 * for the tick after it instead. One hint swallowed per elapsed tick, silently,
 * and the sparser a gateway's hints are the more of them are lost — which is
 * the difference between "an external message arrives immediately" and "within
 * `OBSERVE_POLL_MS`".
 *
 * So the pull is made once and held until it is the answer. The test helper in
 * `chat-observe.test.ts` holds its own `next()` across a closed window for
 * exactly this reason; this is the same shape, on the production side.
 *
 * A pull that settles while the loop is busy reconciling is not lost either: it
 * is still held, so the next wait sees it already resolved and returns at once.
 */
interface HintChannel {
  /** The read to race. The same promise until it is consumed. */
  pull(): Promise<Wake>;
  /** That read was the answer, so the next one starts a fresh read. */
  consumed(): void;
  /**
   * Done with this stream: let the gateway side unwind.
   *
   * Dropping the reference is not enough. The iterator is a generator suspended
   * inside `chat.ts`, whose own `for await` over `hermes.observe` only unwinds
   * when the signal it was opened on aborts — so a watch that merely stops
   * reading one stream and opens another leaves the first socket open for the
   * life of the observation. A pinned portal observation is long-lived and
   * re-opens its hint stream on every read outage, so that is one live upstream
   * socket per outage.
   *
   * Both levers are pulled, because neither is sufficient alone. `return()` is
   * what ends a well-behaved iterator that ignores signals. The abort is what
   * makes `return()` answerable at all: an async generator queues every request
   * and answers them in order, so a `return()` issued while a `next()` is still
   * parked on a gateway that says nothing is answered *after* that `next()` —
   * which on a quiet stream is never. The abort is what settles the parked
   * pull, and only then does the queued `return()` run the generator's unwind.
   *
   * Idempotent: the read-failure path and the stream-ended path both reach it,
   * and a subscription may reach it twice on the way out.
   */
  close(): void;
}

/**
 * One stream's own abort, chained to the observation's.
 *
 * The subscription's signal is the wrong lever for a single stream: aborting it
 * ends the whole watch, so before this every hint stream was opened on it and
 * nothing short of hanging up could cancel one. Each stream therefore gets a
 * controller of its own that the parent can abort but that `close()` can also
 * abort alone.
 *
 * `AbortSignal.any` would express the chaining and nothing else — the caller
 * cannot abort what it returns — so the listener is kept by hand, and dropped
 * in `cancel()` for the same reason `wake()` drops its own: a watch that
 * re-opens its stream on every outage would otherwise pin one dead listener per
 * pass on a signal the caller holds for the life of the observation.
 */
function childAbort(parent: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const child = new AbortController();
  // Already hung up: there is nothing to listen for, and a stream opened on a
  // live signal here would outlive the observation that asked for it.
  if (parent.aborted) {
    child.abort(parent.reason);
    return { signal: child.signal, cancel: (): void => undefined };
  }
  const onAbort = (): void => child.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  let detached = false;
  return {
    signal: child.signal,
    cancel: (): void => {
      if (detached) return;
      detached = true;
      parent.removeEventListener("abort", onAbort);
      child.abort();
    },
  };
}

/**
 * The sessions a hint about this subscription may name.
 *
 * The pinned one, and the one the last authoritative read actually came back
 * from. They differ after upstream compresses: the transcript continues under a
 * new tip and the gateway broadcasts under the tip, so a filter that knew only
 * the pinned id dropped every hint about the live conversation and left the
 * watch on its poll floor. This side is the only one that knows the tip —
 * `snapshot` is what resolved it.
 */
function sessionsOfInterest(sub: Subscription): readonly string[] {
  const out: string[] = [];
  if (sub.target.session !== undefined) out.push(sub.target.session);
  const read = sub.snapshot?.session;
  if (read != null && read !== sub.target.session) out.push(read);
  return out;
}

function hintChannel(it: AsyncIterator<ChatObserveHint>, cancel: () => void): HintChannel {
  let pending: Promise<Wake> | null = null;
  let closed = false;
  return {
    pull(): Promise<Wake> {
      pending ??= it.next().then(
        (r): Wake => (r.done === true ? { kind: "ended" } : { kind: "hint" }),
        (error): Wake => ({ kind: "ended", error }),
      );
      return pending;
    },
    consumed(): void {
      pending = null;
    },
    close(): void {
      if (closed) return;
      closed = true;
      pending = null;
      /**
       * Every step guarded, because `close()` is called from the read-failure
       * path inside a detached `void run(sub)`. A throw escaping here would
       * take the loop out from under its own cleanup: the subscription would
       * stay registered and every observer mailbox would be left open, waiting
       * for events from a watch that had stopped. The `try` has to wrap the
       * *call*, not just the promise it returns — a conforming iterator may
       * throw synchronously from `return()`, and that throw happens before
       * `Promise.resolve` is ever reached.
       */
      try {
        cancel();
      } catch {
        // An abort that refuses is still an abort that was asked for; the
        // `return()` below is the other half of the same instruction.
      }
      try {
        // Not awaited: unwinding the gateway side must not hold up the read
        // loop, and a generator that throws on the way out has nothing left to
        // tell us.
        void Promise.resolve(it.return?.()).catch(() => undefined);
      } catch {
        // Thrown synchronously rather than returned as a rejection. Same
        // verdict, and it must not reach the loop either.
      }
    },
  };
}

/**
 * What a failure means to a head.
 *
 * The message goes through `redactText` on the way out, and that is not
 * belt-and-braces. The snapshot path is a `chat.history` read whose *result* is
 * sealed by `chat.ts`, but a failure raised on the hint stream — a gateway
 * handshake that echoed the session token it was refused with, a `fetch` whose
 * message carries the URL it was given — never passes that door: it is caught
 * here, turned into a `reconnect` or an `error` event, and emitted straight to
 * every observer and into the portal log. So this is the door for it. It is a
 * mask, not a classifier: an unrecognised code is still reported honestly, and
 * `chat-redact.ts` stays the single place that knows what a secret looks like.
 */
function reason(error: unknown): { code: string; message: string } {
  if (error instanceof HermeticError) return { code: error.code, message: redactText(error.message) };
  return {
    code: "UNKNOWN",
    message: redactText(error instanceof Error ? error.message : String(error)),
  };
}

export function createChatObservation(deps: ChatObserveDeps) {
  const sleep = deps.sleep ?? abortableSleep;
  const pollMs = deps.pollMs ?? OBSERVE_POLL_MS;
  const attempts = deps.reconnect?.attempts ?? OBSERVE_RECONNECT_ATTEMPTS;
  const baseMs = deps.reconnect?.baseMs ?? OBSERVE_RECONNECT_BASE_MS;
  const maxMs = deps.reconnect?.maxMs ?? OBSERVE_RECONNECT_MAX_MS;
  const subscriptions = new Map<string, Subscription>();

  const keyOf = (target: ChatObserveTarget): string =>
    `${target.instance}\0${target.bot}\0${target.session ?? ""}`;

  function emit(sub: Subscription, event: ChatObserveEvent): void {
    for (const observer of sub.observers) observer.push(event);
  }

  /**
   * One authoritative read, turned into the events it justifies.
   *
   * The first read of a subscription is a `snapshot` and nothing else: an
   * observer that has just attached has no prior state, and announcing a
   * transcript from last Tuesday one message at a time would be noise dressed
   * as news. Every read after it is a set difference, so only what the box
   * gained since the last read is announced.
   *
   * A read whose `session` differs from the one the held read came from is the
   * other authoritative case. The canonical session rolls over — a conversation
   * is archived and `chat.open` establishes a new one — and every row of the
   * new transcript is then unseen, so a set difference would announce a whole
   * conversation as a run of arrivals, each labelled with a session the
   * consumer has never heard of and none of them replacing the transcript they
   * supersede. That is a new read of a different conversation, and it is
   * emitted as what it is. `null` counts: a bot with no session yet acquiring
   * one is a rollover, and so is a session being retired back to none.
   */
  async function reconcile(sub: Subscription): Promise<void> {
    const snapshot = await deps.snapshot(sub.target, { signal: sub.controller.signal });
    if (sub.controller.signal.aborted) return;
    // Both read before `sub.snapshot` is overwritten below: the comparison is
    // against the session the *held* read came from, not the one just fetched.
    const rolled = sub.snapshot !== null && sub.snapshot.session !== snapshot.session;
    const whole = sub.snapshot === null || rolled;
    /**
     * The window is built as the read is walked rather than from the read as a
     * whole, so a row upstream returned *twice inside one page* — a replay
     * across a page edge, a retransmit — is one message and not two. Filtering
     * the array against the previous window alone would have let both copies
     * through, because neither had been seen before and each proved the other
     * new.
     */
    const window = new Set<string>();
    const unique: ChatMessage[] = [];
    const fresh: ChatMessage[] = [];
    for (const message of snapshot.messages) {
      if (window.has(message.id)) continue;
      window.add(message.id);
      unique.push(message);
      if (!whole && !sub.window.has(message.id)) fresh.push(message);
    }
    snapshot.messages = unique;
    sub.snapshot = snapshot;
    sub.window = window;
    if (whole) {
      emit(sub, {
        type: "snapshot",
        instance: sub.target.instance,
        bot: sub.target.bot,
        session: snapshot.session,
        messages: snapshot.messages,
        at: deps.now(),
      });
    } else {
      for (const message of fresh) {
        emit(sub, {
          type: "message",
          instance: sub.target.instance,
          bot: sub.target.bot,
          session: snapshot.session,
          message,
        });
      }
    }
  }

  /**
   * Wait for the next reason to reconcile: a hint, the poll floor, the hint
   * stream ending, or the caller hanging up.
   *
   * The timer and the abort listener are both torn down on every path — an
   * observation that ticks every five seconds for an hour would otherwise pin
   * seven hundred dead listeners to a signal the caller still holds.
   */
  async function wake(hints: HintChannel | null, signal: AbortSignal): Promise<Wake> {
    if (signal.aborted) return { kind: "aborted" };
    const races: Promise<Wake>[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    if (hints !== null) races.push(hints.pull());
    races.push(
      new Promise<Wake>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "tick" }), pollMs);
        timer.unref?.();
      }),
    );
    races.push(
      new Promise<Wake>((resolve) => {
        onAbort = () => resolve({ kind: "aborted" });
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
    try {
      const answer = await Promise.race(races);
      // Only the hint read can answer with either of these, so this is how the
      // channel learns its pull was spent rather than merely outrun.
      if (answer.kind === "hint" || answer.kind === "ended") hints?.consumed();
      return answer;
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (onAbort !== null) signal.removeEventListener("abort", onAbort);
    }
  }

  /** `1s, 2s, 4s, 8s, 16s`, capped. Deterministic, so a test can assert it. */
  const backoff = (attempt: number): number => Math.min(baseMs * 2 ** (attempt - 1), maxMs);

  /**
   * The subscription's one loop: reconcile, wait, reconcile.
   *
   * Two counters, because there are two unlike failures and one counter could
   * not be right about both.
   *
   * The **read** is the observation. A retryable failure of `deps.snapshot`
   * spends `readAttempt`, and spending it all is the one thing that ends the
   * watch: nothing else can honestly tell the operator the conversation is
   * unobservable. A read that worked resets it, because the read is the thing
   * being retried and it has just been shown to work.
   *
   * The **hint channel** is an optimisation on top of that read. A stream that
   * ends or throws spends `hintAttempt` and is reopened after the same backoff;
   * surviving a wait resets it. Spending it all does *not* end the watch — it
   * sets `pollOnly` and leaves the loop on `pollMs`, which is what the module
   * docstring has always promised. Before this the two shared one counter, so a
   * gateway whose socket closed the instant it was opened burnt the budget in
   * 31 seconds and emitted a terminal `error`, taking a conversation out of
   * service in the portal while every authoritative read was still succeeding.
   *
   * Keeping them apart is also what keeps the bound. One shared counter reset
   * after a successful read made a stream that ends on open retry for ever
   * (open, read, end, spend, reset, open …), which is why that reset used to
   * demand surviving a wait. Counted separately, the read may reset on a read
   * and the hint channel still resets only on survival, so neither can spin.
   *
   * `hints` is nulled on every failure path so the next pass reopens rather
   * than reusing an iterator whose source is gone.
   */
  async function run(sub: Subscription): Promise<void> {
    const signal = sub.controller.signal;
    let hints: HintChannel | null = null;
    /** The read budget. Reset by a read that worked; spending it is terminal. */
    let readAttempt = 0;
    /** The hint budget. Reset by a stream that survived a wait. */
    let hintAttempt = 0;
    /** Set once the hint channel has been shown not to work. Poll from then on. */
    let pollOnly = false;
    while (!signal.aborted) {
      // Asked every pass rather than once, so a caller that only learns the
      // gateway is hintless after the first conversation is obeyed by the
      // second — and so one that changes its mind back gets its stream again.
      const wantHints =
        deps.hints !== undefined && !pollOnly && (deps.hintsUsable?.(sub.target) ?? true);
      if (wantHints && hints === null) {
        /**
         * Opened on a controller of this stream's own rather than on `signal`
         * directly, so that dropping one stream is a thing the loop can do.
         * The chaining is what keeps the old guarantee — the caller hanging up
         * still ends every stream it started — and `close()` is what drops the
         * listener again on the way out. See `childAbort`.
         *
         * `child` is created before the `try` and the factory call is inside
         * it, so a `deps.hints` that throws synchronously still gets its
         * listener on `signal` dropped via `child.cancel()` in the catch —
         * the same leak `hintChannel.close()` exists to close on the other
         * side of a stream's life. `hints` is left `null` rather than
         * rethrown, so the loop falls through to a poll-only pass this time
         * around.
         *
         * The catch also spends `hintAttempt`, the same budget a stream that
         * opens and then ends spends — a factory that throws on every call is
         * the same failure as a stream that never delivers anything, just
         * caught one step earlier, and the module's two-budget contract
         * promises every hint failure is bounded. Left unspent, `wantHints`
         * would retry the open every pass forever: `pollMs` floors the pace
         * (never a spin), but never a stop either. Spending it here and
         * checking it against `attempts` the same way the "ended" path does
         * below means a permanently-throwing factory reaches `pollOnly` in
         * the same number of attempts a permanently-ending stream would,
         * silently, with no event — reusing the reasoning at that check
         * rather than duplicating the reconnect/backoff dance for a stream
         * that was never open to reconnect.
         */
        const child = childAbort(signal);
        try {
          const stream = deps.hints?.(sub.target, {
            signal: child.signal,
            // Read at each hint, not here: the tip moves under a stream that
            // stays open across a compression.
            sessions: () => sessionsOfInterest(sub),
          });
          if (stream === undefined) child.cancel();
          else {
            sub.streams += 1;
            hints = hintChannel(stream[Symbol.asyncIterator](), child.cancel);
          }
        } catch {
          child.cancel();
          hintAttempt += 1;
          if (hintAttempt > attempts) pollOnly = true;
        }
      }
      try {
        await reconcile(sub);
        readAttempt = 0;
      } catch (error) {
        if (signal.aborted) break;
        hints?.close();
        hints = null;
        const why = reason(error);
        if (!RETRYABLE.has(why.code)) {
          emit(sub, {
            type: "error",
            instance: sub.target.instance,
            bot: sub.target.bot,
            code: why.code,
            message: why.message,
          });
          break;
        }
        readAttempt += 1;
        if (readAttempt > attempts) {
          emit(sub, {
            type: "error",
            instance: sub.target.instance,
            bot: sub.target.bot,
            code: why.code,
            message: `${why.message} (gave up after ${attempts} attempts)`,
          });
          break;
        }
        const delay = backoff(readAttempt);
        emit(sub, {
          type: "reconnect",
          instance: sub.target.instance,
          bot: sub.target.bot,
          attempt: readAttempt,
          delay_ms: delay,
          code: why.code,
          message: why.message,
        });
        await sleep(delay, signal);
        continue;
      }
      const next = await wake(hints, signal);
      if (next.kind === "aborted" || signal.aborted) break;
      if (next.kind !== "ended") {
        // A hint, or a whole poll interval with the stream still open, is the
        // evidence that the outage is over. Completing a read is not: the read
        // does not go through the thing that broke.
        if (hints !== null) hintAttempt = 0;
        continue;
      }
      hints?.close();
      hints = null;
      hintAttempt += 1;
      if (hintAttempt > attempts) {
        /**
         * The degrade, and deliberately silent.
         *
         * `error` is terminal by contract — the portal shows `Watch again` and
         * stops — so emitting one here would take a conversation out of service
         * that the laptop can still read perfectly well. A further `reconnect`
         * would either claim a retry that is not scheduled or carry an
         * `attempt` past the bound its schema documents. So the loop says
         * nothing and keeps reading: the operator already has the reconnect
         * advisories that led here, and the next message or snapshot puts every
         * head back to `live`.
         */
        pollOnly = true;
        continue;
      }
      const why =
        next.error === undefined
          ? {
              code: OBSERVE_HINTS_ENDED,
              message: `${sub.target.instance}: the chat hint stream closed`,
            }
          : reason(next.error);
      const delay = backoff(hintAttempt);
      emit(sub, {
        type: "reconnect",
        instance: sub.target.instance,
        bot: sub.target.bot,
        attempt: hintAttempt,
        delay_ms: delay,
        code: why.code,
        message: why.message,
      });
      await sleep(delay, signal);
    }
    // Whoever ends the loop closes every mailbox: an observer waiting on a
    // subscription that has stopped would otherwise wait forever.
    if (subscriptions.get(sub.key) === sub) subscriptions.delete(sub.key);
    for (const observer of sub.observers) observer.close();
    sub.observers.clear();
  }

  /**
   * Join the subscription for this conversation, starting one if this is the
   * first observer.
   *
   * A late joiner is handed the snapshot the subscription already holds rather
   * than provoking a read of its own. That is not only a saved request: it is
   * what makes two tabs one upstream subscription rather than two, which is the
   * whole of requirement five.
   */
  function attach(target: ChatObserveTarget): { sub: Subscription; box: Mailbox } {
    const key = keyOf(target);
    let sub = subscriptions.get(key);
    const box = mailbox();
    if (!sub) {
      sub = {
        key,
        target,
        observers: new Set([box]),
        snapshot: null,
        window: new Set<string>(),
        controller: new AbortController(),
        streams: 0,
      };
      subscriptions.set(key, sub);
      void run(sub);
      return { sub, box };
    }
    sub.observers.add(box);
    if (sub.snapshot !== null) {
      box.push({
        type: "snapshot",
        instance: target.instance,
        bot: target.bot,
        session: sub.snapshot.session,
        messages: sub.snapshot.messages,
        at: deps.now(),
      });
    }
    return { sub, box };
  }

  /**
   * Leave. Local observation control and nothing else: no remote turn is
   * interrupted, no job is stopped, and the other observers of this
   * conversation do not notice.
   */
  function detach(sub: Subscription, box: Mailbox): void {
    sub.observers.delete(box);
    box.close();
    if (sub.observers.size > 0) return;
    if (subscriptions.get(sub.key) === sub) subscriptions.delete(sub.key);
    sub.controller.abort();
  }

  /**
   * Watch one conversation until the caller stops iterating or aborts.
   *
   * The stream is endless by design — there is no "the conversation is over" —
   * so it ends three ways: the caller's `signal`, the caller leaving the
   * `for await`, or a terminal `error` event.
   */
  function observe(
    target: ChatObserveTarget,
    opts: ChatObserveOptions = {},
  ): AsyncIterable<ChatObserveEvent> {
    return (async function* () {
      if (opts.signal?.aborted) return;
      const { sub, box } = attach(target);
      const onAbort = (): void => box.close();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        for (;;) {
          const event = await box.next();
          if (event === undefined || opts.signal?.aborted === true) return;
          yield event;
          if (event.type === "error") return;
        }
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
        detach(sub, box);
      }
    })();
  }

  /** How many upstream hint streams this conversation has cost. For tests. */
  const streams = (target: ChatObserveTarget): number => subscriptions.get(keyOf(target))?.streams ?? 0;

  /** How many observers share this conversation's subscription. For tests. */
  const observers = (target: ChatObserveTarget): number =>
    subscriptions.get(keyOf(target))?.observers.size ?? 0;

  return { observe, streams, observers };
}

export type ChatObservation = ReturnType<typeof createChatObservation>;
