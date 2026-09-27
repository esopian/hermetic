/**
 * Cursor-driven turn continuation: the pump the turn loop reads its events
 * through.
 *
 * A dropped socket used to end a turn half-written — the transcript kept
 * whatever had arrived and the answer's second half was lost for good, on a
 * tailnet where a dashboard restart is a normal Tuesday. Upstream stamps every
 * session event with a monotonic `seq` and will replay from a cursor
 * (`session.events.since`), so the socket is the only thing that was actually
 * lost. This module reconnects, re-attaches, asks for everything past the
 * cursor, and hands the turn loop the events it missed as if they had never
 * stopped arriving.
 *
 * It is a pump rather than an iterator wrapper because reconnecting has to
 * produce things the turn loop must *render* — "Reconnecting…", "Reconnected",
 * "Reconnect failed" — and an `AsyncIterable<event>` has nowhere to put them.
 * `next()` returns one step, the way `nextEvent` does, with three more kinds.
 *
 * What it never does is resubmit: the prompt was accepted by the box, the turn
 * is still running there, and sending it twice would run it twice.
 */
import { abortableSleep } from "../../abort.ts";
import {
  OBSERVE_RECONNECT_ATTEMPTS,
  OBSERVE_RECONNECT_BASE_MS,
  OBSERVE_RECONNECT_MAX_MS,
} from "../chat-observe.ts";
import { HermeticError } from "../../errors.ts";
import { nextEvent, type Rpc } from "./hermes-chat-rpc.ts";
import { CHAT_ERROR_CODES, CHAT_RECONNECT_BLOCK_KEY, type BoxAddress } from "./hermes-chat-types.ts";
import { num, rec, str } from "./hermes-chat-wire.ts";
import type { ChatBlock } from "../../schema/index.ts";

/** JSON-RPC's "method not found", which is how an older gateway says no. */
const METHOD_NOT_FOUND = -32601;

/**
 * How long a gateway stays on the "no continuation here" list.
 *
 * The same window and the same reasoning as `hintsBroken` in `chat.ts`: a box
 * that has since been upgraded should not be treated as incapable for the rest
 * of the portal's life, and re-probing costs one request per turn per window.
 */
const RESUME_UNSUPPORTED_MS = 5 * 60_000;

/**
 * How long the parting `session.interrupt` may take, dial included.
 *
 * Short on purpose: it runs *after* the operator pressed stop, with the turn's
 * `done` frame queued behind it. A box that cannot be reached in five seconds
 * is a box whose turn will be reclaimed by the gateway's own timeouts anyway.
 */
const INTERRUPT_DEADLINE_MS = 5_000;

/**
 * Reject when `signal` fires, whatever the promise is still doing.
 *
 * `Promise.race` against an abort is not enough anywhere a dial is involved:
 * `connect` awaits the socket's `opened`, and a socket that neither opens nor
 * fails — a box that fell off the tailnet mid-turn — never settles it. The
 * abort signal reaches the *requests*, which is how a hung handshake unwinds,
 * but nothing settles the open itself, so the caller has to stop waiting.
 */
function within<T>(promise: Promise<T>, signal: AbortSignal, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const give = (): void => reject(new HermeticError("ABORTED", `operation aborted during ${what}`));
    if (signal.aborted) {
      give();
      return;
    }
    signal.addEventListener("abort", give, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", give);
        resolve(value);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", give);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * One step, or the reason there was not one.
 *
 * The first four are `nextEvent`'s own union, passed through unchanged. The
 * last three are the reconnect made visible: the turn loop turns them into the
 * one activity block an operator watches while the socket is being rebuilt.
 */
export type PumpStep =
  | { kind: "event"; value: Record<string, unknown> }
  | { kind: "end" }
  | { kind: "aborted" }
  | { kind: "timeout" }
  | { kind: "reconnecting"; attempt: number; of: number }
  | { kind: "reconnected" }
  | { kind: "lost"; reason: string };

/**
 * The one block an operator watches while the socket is being rebuilt.
 *
 * All three states share a key, because heads replace status blocks by key: a
 * turn that reconnected three times leaves one block rather than six, and the
 * "Reconnecting…" a head is animating is always superseded rather than left
 * logically running.
 */
export function reconnectBlock(
  step:
    | { kind: "reconnecting"; attempt: number; of: number }
    | { kind: "reconnected" }
    | { kind: "lost"; reason: string },
): ChatBlock {
  const face =
    step.kind === "reconnecting"
      ? {
          state: "running" as const,
          title: "Reconnecting…",
          detail: `attempt ${step.attempt} of ${step.of}`,
        }
      : step.kind === "reconnected"
        ? { state: "done" as const, title: "Reconnected", detail: null }
        : { state: "warning" as const, title: "Reconnect failed", detail: step.reason };
  return {
    kind: "activity",
    category: "connection",
    key: CHAT_RECONNECT_BLOCK_KEY,
    role: "status",
    request_id: null,
    ...face,
  };
}

export interface TurnPump {
  /**
   * Establish the cursor, before the prompt is submitted.
   *
   * Returns the sequence number this turn starts from. Asking for everything
   * after `Number.MAX_SAFE_INTEGER` is the cheapest possible read — the gateway
   * filters `seq > last_seen` and answers with an empty list — and the answer
   * carries the two things continuation needs: the session's current
   * `latest_seq`, and the gateway's process-lifetime `epoch`.
   *
   * Starting the cursor at `latest_seq` rather than at zero is not a
   * refinement: a socket that drops before this turn's first event would
   * otherwise replay the *previous* turn's events and render them as this one's
   * answer.
   */
  probe(signal: AbortSignal | undefined): Promise<number>;
  /** The turn loop's cursor, moved as it applies each sequenced event. */
  seen(seq: number): void;
  next(signal: AbortSignal | undefined, deadlineMs: number | null): Promise<PumpStep>;
  /**
   * Stop the turn on the box, over whatever transport is still available —
   * including none, in which case it dials once and hangs up.
   */
  interrupt(): Promise<void>;
  /**
   * Whether this turn ever lost its socket.
   *
   * A turn that did cannot claim a silence means "the box has no warm slot":
   * it means the socket went away, which is a different thing to tell an
   * operator and a different thing for them to do about it.
   */
  reconnected(): boolean;
  /** The socket a turn should interrupt or close — which may not be the one it opened. */
  current(): Rpc;
  close(): void;
}

export interface TurnResumeDeps {
  connect(box: BoxAddress, signal: AbortSignal | undefined): Promise<Rpc>;
  /** ISO-8601 now, for the unsupported memo's window. */
  now: () => string;
  /** Injected so a test need not spend a real backoff. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  attempts?: number | undefined;
  baseMs?: number | undefined;
  maxMs?: number | undefined;
  /** How long a parting `session.interrupt` may take, dial included. */
  interruptMs?: number | undefined;
}

export interface TurnPumpOptions {
  rpc: Rpc;
  box: BoxAddress;
  bot: string;
  /** The runtime session id, which a reconnect must land back on exactly. */
  session: string;
}

function isAborted(e: unknown): boolean {
  return e instanceof HermeticError && e.code === "ABORTED";
}

function isUnsupported(e: unknown): boolean {
  return (
    e instanceof HermeticError &&
    e.code === CHAT_ERROR_CODES.PROTOCOL &&
    e.details?.code === METHOD_NOT_FOUND
  );
}

/**
 * The factory, and the home of the one piece of state that outlives a turn.
 *
 * The memo is per client rather than per turn because the question it answers —
 * "does this gateway replay at all?" — has the same answer for every turn
 * against that box, and the alternative is one doomed request per turn forever.
 */
export function createTurnResume(deps: TurnResumeDeps) {
  const attempts = deps.attempts ?? OBSERVE_RECONNECT_ATTEMPTS;
  const baseMs = deps.baseMs ?? OBSERVE_RECONNECT_BASE_MS;
  const maxMs = deps.maxMs ?? OBSERVE_RECONNECT_MAX_MS;
  const sleep = deps.sleep ?? abortableSleep;
  const interruptMs = deps.interruptMs ?? INTERRUPT_DEADLINE_MS;
  const unsupported = new Map<string, number>();

  /**
   * The memo's clock, in milliseconds.
   *
   * `deps.now()` is ISO-8601 and normally parses, but a clock that answered
   * anything else would make every comparison `NaN` — which reads as "the
   * window has passed" and quietly deletes the memo on every turn, so the
   * doomed request comes back forever. An unparseable clock falls back to this
   * process's own rather than disabling the memo.
   */
  const stamp = (): number => {
    const parsed = Date.parse(deps.now());
    return Number.isNaN(parsed) ? Date.now() : parsed;
  };

  function supported(instance: string): boolean {
    const at = unsupported.get(instance);
    if (at === undefined) return true;
    if (stamp() - at < RESUME_UNSUPPORTED_MS) return false;
    unsupported.delete(instance);
    return true;
  }

  function pump(opts: TurnPumpOptions): TurnPump {
    const { box, bot, session } = opts;
    let rpc = opts.rpc;
    let it = rpc.events[Symbol.asyncIterator]();
    /** The socket mid-handshake, which `current()` prefers: the old one is gone. */
    let handshake: Rpc | null = null;
    let enabled = false;
    let epoch: string | null = null;
    let cursor = 0;
    let used = 0;
    let reconnecting = false;
    let closed = false;
    /** When this turn first lost a socket, which is where the deadline is measured from. */
    let firstDroppedAt = 0;
    /** Whether this turn ever lost a socket, which changes what a silence means. */
    let dropped = false;
    const queued: PumpStep[] = [];
    /** Server→client request ids this turn has already shown, live or replayed. */
    const requests = new Set<string>();

    async function probe(signal: AbortSignal | undefined): Promise<number> {
      if (!supported(box.instance)) return 0;
      try {
        const answer = rec(
          await rpc.request(
            "session.events.since",
            { session_id: session, last_seen: Number.MAX_SAFE_INTEGER },
            undefined,
            { signal },
          ),
        );
        cursor = num(answer?.latest_seq) ?? 0;
        const mark = str(answer?.epoch);
        // No epoch, no continuation. Without it a reconnect cannot tell "the
        // socket dropped" from "the gateway restarted and this session id now
        // names something else", and the second case replays a stranger's turn.
        // Requests already open when the turn started belong to whatever asked
        // for them. `open_requests` is session-scoped, so a replay would hand
        // this turn an approval a previous one left hanging.
        for (const row of Array.isArray(answer?.open_requests) ? answer.open_requests : []) {
          const id = rec(row)?.id;
          if (typeof id === "string" || typeof id === "number") requests.add(String(id));
        }
        if (mark === null) return cursor;
        epoch = mark;
        enabled = true;
        return cursor;
      } catch (e) {
        if (isAborted(e)) throw e;
        if (isUnsupported(e)) unsupported.set(box.instance, stamp());
        // Every other failure leaves the turn exactly as it was before this
        // module existed: it runs, and a dropped socket ends it incomplete.
        return 0;
      }
    }

    function seen(seq: number): void {
      if (seq > cursor) cursor = seq;
      // A newer sequenced event is the proof that the new socket is carrying
      // this turn. Anything less — a successful connect, an empty replay —
      // would let a gateway that accepts and drops loop forever.
      used = 0;
    }

    /** Remember what a request step showed, so a replay does not show it twice. */
    function note(step: PumpStep): PumpStep {
      if (step.kind !== "event") return step;
      const value = step.value;
      if (str(value.type) !== "hermetic.server_request") return step;
      const id = str(rec(value.payload)?.id);
      if (id !== null) requests.add(id);
      return step;
    }

    function giveUp(reason: string): void {
      reconnecting = false;
      enabled = false;
      queued.push({ kind: "lost", reason }, { kind: "end" });
    }

    function retry(): void {
      used += 1;
      if (used > attempts) {
        giveUp(`gave up after ${attempts} attempts`);
        return;
      }
      queued.push({ kind: "reconnecting", attempt: used, of: attempts });
    }

    /**
     * Turn the replay answer's `open_requests` into the events they would have
     * been.
     *
     * An approval the box is still waiting on was announced on the socket that
     * died; nothing will announce it again, and a turn that silently drops it
     * hangs until the operator gives up. The UI dedupes by request id, but the
     * CLI and JSON consumers do not, so the skip happens here.
     */
    function openRequests(value: unknown): Record<string, unknown>[] {
      if (!Array.isArray(value)) return [];
      const out: Record<string, unknown>[] = [];
      for (const entry of value) {
        const row = rec(entry);
        const method = str(row?.method);
        const id = row?.id;
        if (method === null || (typeof id !== "string" && typeof id !== "number")) continue;
        const key = String(id);
        if (requests.has(key)) continue;
        requests.add(key);
        out.push({
          type: "hermetic.server_request",
          session_id: session,
          payload: { method, id: key, params: rec(row?.params) ?? {} },
        });
      }
      return out;
    }

    function replayed(value: unknown): Record<string, unknown>[] {
      if (!Array.isArray(value)) return [];
      const out: Record<string, unknown>[] = [];
      for (const entry of value) {
        const row = rec(entry);
        if (row !== null) out.push(row);
      }
      return out;
    }

    /**
     * One reconnect attempt: dial, attach, catch up.
     *
     * The order is the whole of the race's answer. `session.resume` attaches
     * the new socket as a live peer *first*, so events the box emits from that
     * moment are queued behind the socket's buffer; the replay read then covers
     * everything up to the cursor. Anything that lands in both arrives replayed
     * first and loses the second time through the turn loop's seq dedupe.
     */
    async function attempt(signal: AbortSignal | undefined): Promise<void> {
      const wait = Math.min(maxMs, baseMs * 2 ** Math.max(0, used - 1));
      await sleep(wait, signal);
      if (signal?.aborted) {
        reconnecting = false;
        queued.push({ kind: "aborted" });
        return;
      }
      let fresh: Rpc | null = null;
      try {
        fresh = await deps.connect(box, signal);
        // The turn may have ended while this dial was in the air — a spent
        // deadline, an abort, a pump that has been closed. A socket adopted now
        // would be attached to a gateway nobody is reading.
        if (closed || signal?.aborted) {
          fresh.close();
          return;
        }
        handshake = fresh;
        const resumed = rec(
          await fresh.request(
            "session.resume",
            { session_id: session, profile: bot, defer_history: true, omit_messages: true },
            undefined,
            { signal },
          ),
        );
        // A resume that lands on a different runtime id, or on a session that
        // is not running, is not this turn. Continuing against it would wait
        // forever for a completion nobody is going to send.
        if (str(resumed?.session_id) !== session || resumed?.running !== true) {
          handshake = null;
          fresh.close();
          giveUp("gateway restarted");
          return;
        }
        const answer = rec(
          await fresh.request(
            "session.events.since",
            { session_id: session, last_seen: cursor },
            undefined,
            { signal },
          ),
        );
        const stamp = str(answer?.epoch);
        const latest = num(answer?.latest_seq);
        const reason =
          answer === null
            ? "not supported"
            : answer.truncated === true
              ? "log truncated"
              : stamp !== epoch
                ? "gateway restarted"
                : latest === null || latest < cursor
                  ? "gateway restarted"
                  : null;
        if (reason !== null) {
          handshake = null;
          fresh.close();
          giveUp(reason);
          return;
        }
        handshake = null;
        if (closed) {
          fresh.close();
          return;
        }
        rpc.close();
        rpc = fresh;
        it = fresh.events[Symbol.asyncIterator]();
        reconnecting = false;
        queued.push({ kind: "reconnected" });
        for (const value of replayed(answer?.events)) queued.push({ kind: "event", value });
        for (const value of openRequests(answer?.open_requests)) queued.push({ kind: "event", value });
      } catch (e) {
        if (signal?.aborted || isAborted(e)) {
          // The half-built socket is left open and current: it is attached if
          // the resume got that far, and it is the only thing left that can
          // carry the `session.interrupt` an abort owes the box. The turn's
          // `finally` closes it through `close()`.
          reconnecting = false;
          queued.push({ kind: "aborted" });
          return;
        }
        handshake = null;
        fresh?.close();
        if (isUnsupported(e)) {
          unsupported.set(box.instance, stamp());
          giveUp("not supported");
          return;
        }
        // Everything else is the outage itself — a refused upgrade, a socket
        // that died during the handshake, a request that timed out — and
        // waiting is exactly what might change the answer.
        retry();
      }
    }

    /**
     * Tell the box to stop, whatever is left of the transport.
     *
     * An abort during a backoff has no live socket: the one the turn opened is
     * the reason it is reconnecting. `current().request` would reject, the
     * turn's `.catch()` would swallow it, and the box would keep generating —
     * which is exactly the bill an interrupt exists to stop. So a dead socket
     * costs one last dial, made without the caller's (already aborted) signal
     * and closed immediately. A live socket costs nothing extra.
     */
    async function interrupt(): Promise<void> {
      if (closed) return;
      try {
        // Short, because this socket may be the hung one: an interrupt that
        // waits out the full request deadline delays the `done` the operator
        // pressed stop for, which is the one thing a stop must not do.
        await (handshake ?? rpc).request("session.interrupt", { session_id: session }, interruptMs);
        return;
      } catch {
        // The socket this turn was reading is gone. One dial, below.
      }
      const stop = AbortSignal.timeout(interruptMs);
      let last: Rpc | null = null;
      try {
        // Bounded by its own clock, not the caller's: the caller's signal is
        // already aborted (that is why we are here), and an unreachable box
        // would otherwise hold the turn open until the OS gave up on the TCP
        // connection — minutes, with a `done` frame waiting behind it.
        const dialled = deps.connect(box, stop);
        // A dial that lands after the bound is a socket nobody asked for.
        void dialled.then(
          (rpc2) => {
            if (stop.aborted) rpc2.close();
          },
          () => null,
        );
        last = await within(dialled, stop, "session.interrupt");
        await last.request("session.interrupt", { session_id: session }, interruptMs, {
          signal: stop,
        });
      } catch {
        // The box is unreachable, which is a stronger reason to stop trying
        // than any of the others: there is nothing left to tell.
      } finally {
        last?.close();
      }
    }

    async function next(signal: AbortSignal | undefined, deadlineMs: number | null): Promise<PumpStep> {
      for (;;) {
        const head = queued.shift();
        if (head !== undefined) return note(head);
        if (reconnecting) {
          // The caller's deadline is spent *inside* the reconnect, not added to
          // it: the wait for a turn's first frame is a promise about how long an
          // operator stares at nothing, and a reconnect budget bolted onto the
          // end of it turns thirty seconds into minutes. Measured from the
          // *first* drop of the turn, because a gateway that sends one
          // sequenced event per cycle would otherwise restart the clock forever.
          const remaining = deadlineMs === null ? null : deadlineMs - (Date.now() - firstDroppedAt);
          if (remaining !== null && remaining <= 0) return { kind: "timeout" };
          if (remaining === null) {
            await attempt(signal);
            continue;
          }
          // Raced, not merely checked beforehand: a handshake that hangs is
          // exactly the outage this deadline is about, and checking only on the
          // way in waits out the whole of it first.
          const expiry = new AbortController();
          const timer = setTimeout(() => expiry.abort(), remaining);
          timer.unref?.();
          const merged =
            signal === undefined ? expiry.signal : AbortSignal.any([signal, expiry.signal]);
          try {
            // `within`, not a bare await: the abort reaches the handshake's
            // requests but never the dial itself, so an attempt against a box
            // that stopped answering would hold this loop open past every
            // deadline it is supposed to honour. The abandoned attempt unwinds
            // on `merged` and closes whatever it opened (see `attempt`).
            await within(attempt(merged), expiry.signal, "reconnect");
          } catch {
            // The deadline, not a failure: `attempt` never throws.
          } finally {
            clearTimeout(timer);
          }
          if (expiry.signal.aborted && signal?.aborted !== true) {
            // A reconnect that landed inside the window is kept, deadline or
            // not: the deadline bounds the wait for the first content frame,
            // and the replay this attempt just queued may be that frame.
            if (!queued.some((step) => step.kind === "reconnected")) {
              queued.length = 0;
              reconnecting = false;
              return { kind: "timeout" };
            }
          }
          continue;
        }
        const step = await nextEvent(it, signal, deadlineMs);
        if (step.kind !== "end" || !enabled || signal?.aborted) return note(step);
        // The socket ended without a completion. Everything the turn has is
        // still good, the turn itself is still running on the box, and the
        // cursor says exactly where to pick it up.
        //
        // The attempt is counted here rather than reset, because a gateway that
        // accepts the handshake and then drops again without sending one new
        // event is the loop this budget exists to stop: only `seen()` — a newer
        // event actually applied — proves the new socket is carrying the turn.
        reconnecting = true;
        dropped = true;
        if (firstDroppedAt === 0) firstDroppedAt = Date.now();
        retry();
      }
    }

    return {
      probe,
      seen,
      next,
      interrupt,
      reconnected: () => dropped,
      current: () => handshake ?? rpc,
      close: () => {
        closed = true;
        handshake?.close();
        handshake = null;
        rpc.close();
      },
    };
  }

  return { pump };
}

export type TurnResume = ReturnType<typeof createTurnResume>;
