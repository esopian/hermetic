/**
 * The JSON-RPC transport: a text-frame socket turned into request/response plus
 * an event stream, the buffer between the two, and the one-event wait the turn
 * loop is built on.
 *
 * Split out of `hermes-chat.ts` because it is the one part of the adapter that
 * knows nothing about chat: it reads documents off a wire and hands them up.
 */
import { HermeticError } from "../../errors.ts";
import {
  CHAT_ERROR_CODES,
  CHAT_HEARTBEAT_DEADLINE_MS,
  CHAT_HEARTBEAT_MS,
} from "./hermes-chat-types.ts";
import type { ChatSocket } from "./hermes-chat-types.ts";
import { num, parseJson, rec, str } from "./hermes-chat-wire.ts";

export interface Rpc {
  request(
    method: string,
    params: Record<string, unknown>,
    deadlineMs?: number,
    /**
     * Per-request cancellation, for a socket whose callers are strangers to
     * each other (`hermes-chat-pool.ts`).
     *
     * An abort here removes *this* request's pending entry, timer and listener
     * and nothing else: the socket stays open, its peers keep waiting, and a
     * reply that arrives after the hang-up is dropped by `route` because there
     * is no longer anyone registered for that id. Closing the socket instead —
     * which is what a dedicated per-request socket could afford — would fail
     * every other caller sharing it.
     */
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<unknown>;
  events: AsyncIterable<Record<string, unknown>>;
  /**
   * How many event frames the socket has delivered so far, buffered ones
   * included. Snapshotted around `prompt.submit` so a turn can tell "the box
   * has said nothing since I asked" — which is what a full warm-slot queue
   * looks like — from "the box is talking, just not to this turn yet".
   */
  arrived(): number;
  /**
   * Ask the underlying socket to stop holding the event loop open, if it can.
   *
   * A no-op against every `ChatSocket` in this build — neither the runtime's
   * `WebSocket` wrapper nor the test doubles implement it — and present so a
   * pooled socket, which by definition has nobody waiting on it between
   * requests, cannot become the reason a one-shot process will not exit.
   *
   * Optional on the interface so the hand-written `Rpc` doubles in the test
   * tree need not grow a method that does nothing; `readRpc` always supplies
   * it.
   */
  unref?(): void;
  close(): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Turns a text-frame socket into request/response plus an event stream.
 *
 * Everything in here is written to survive garbage. A half-line, a truncated
 * document, a frame carrying three documents, a server→client request this
 * build does not answer yet (upstream 0.21.3 replaced the `*.respond`
 * notification pairs with real JSON-RPC requests) — none
 * of those may throw, because the process on the other end is a thing hermetic
 * does not control and `web_server_chat.py` is explicitly not a stable API.
 * An unparseable line is skipped and the next one is read.
 */
/**
 * The heartbeat's two numbers, injectable so a test need not spend a minute
 * proving the deadline fires.
 */
export interface HeartbeatOptions {
  intervalMs?: number | undefined;
  deadlineMs?: number | undefined;
}

export function readRpc(
  socket: ChatSocket,
  waitMs: number,
  instance: string,
  heartbeat: HeartbeatOptions = {},
): Rpc {
  const pending = new Map<number, Pending>();
  const events = channel<Record<string, unknown>>();
  let nextId = 0;
  let closed = false;
  let eventsSeen = 0;

  const beatMs = heartbeat.intervalMs ?? CHAT_HEARTBEAT_MS;
  const graceMs = heartbeat.deadlineMs ?? CHAT_HEARTBEAT_DEADLINE_MS;
  /** The probe timer, and the proof the heartbeat is running at all. */
  let beat: ReturnType<typeof setInterval> | null = null;
  /** The silence timer, re-armed by every inbound frame. */
  let dead: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start probing — but only once the box has said it answers probes.
   *
   * `gateway.ready` carries `heartbeat: true` on the WebSocket transport
   * (upstream `tui_gateway/ws.py`, `GatewayReadyPayload.heartbeat`, "WebSocket
   * transport only"). An older gateway omits the flag, and this build refuses
   * to guess on its behalf: with no flag there is **no ping and no deadline**,
   * which is exactly the behaviour every release before this one had. That is
   * the conservative half of the trade — any-inbound liveness would arguably
   * have been safe even against a gateway that never answered `ping`, since a
   * streaming turn defers the deadline on its own frames, but a *silent* older
   * gateway on a perfectly healthy socket would then be closed every 45s, and a
   * watch socket is silent by design.
   */
  function startHeartbeat(): void {
    if (beat !== null || closed) return;
    beat = setInterval(() => {
      if (closed) return;
      try {
        socket.send(
          `${JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: "ping", params: {} })}\n`,
        );
      } catch {
        // A socket that will not take a write is already the deadline's
        // problem; raising here would only lose the timer.
      }
    }, beatMs);
    beat.unref?.();
    armDeadline();
  }

  /**
   * Any inbound frame means the socket is alive, whatever it carried.
   *
   * Matching pongs to pings would be stricter and worse: a gateway busy
   * streaming a long answer can be slow to answer a probe while delivering
   * content the whole time, and killing that turn is the failure this exists to
   * prevent. No-op while the heartbeat is not running, so a gateway that never
   * advertised one is never on a clock.
   */
  function armDeadline(): void {
    if (beat === null || closed) return;
    if (dead !== null) clearTimeout(dead);
    dead = setTimeout(() => {
      shutdown(`chat socket went silent for ${Math.round(graceMs / 1000)}s`);
    }, graceMs);
    dead.unref?.();
  }

  function stopHeartbeat(): void {
    if (beat !== null) clearInterval(beat);
    beat = null;
    if (dead !== null) clearTimeout(dead);
    dead = null;
  }

  function settleAll(e: unknown): void {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    pending.clear();
  }

  /**
   * The tail of the last frame, when it did not end on a document boundary.
   *
   * A WebSocket frame is not a message. The protocol is newline-delimited JSON,
   * so one frame may carry three documents, or the first 40 bytes of one — and
   * splitting each frame in isolation drops *both* halves of a split document:
   * the head is unparseable and the tail arrives with no head. When the split
   * document is `message.complete`, the consequence is a turn that never ends.
   */
  let carry = "";

  /**
   * How much unterminated text to hold before giving up on it. A box that sends
   * megabytes with no newline is malfunctioning, and buffering it forever turns
   * that into the laptop's problem.
   */
  const MAX_CARRY = 4 * 1024 * 1024;

  function consume(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = parseJson(trimmed);
    // Not a document. A truncated frame with no continuation, a keepalive, a
    // banner — all of them are the box's business and none end this stream.
    if (parsed !== undefined) route(parsed);
  }

  void (async () => {
    try {
      for await (const frame of socket.frames) {
        // Before anything is parsed: a frame this reader cannot read is still
        // the box proving it is there.
        armDeadline();
        carry += frame;
        if (carry.length > MAX_CARRY) carry = "";
        const lines = carry.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) consume(line);
        // The remainder is either a complete document that simply arrived
        // without its trailing newline — the ordinary case on this wire — or the
        // first half of one. Parsing tells the two apart: if it parses, it is
        // whole and is consumed now; if it does not, it waits for the rest.
        const rest = carry.trim();
        if (!rest) {
          carry = "";
        } else if (parseJson(rest) !== undefined) {
          consume(rest);
          carry = "";
        }
      }
      // A last document the box sent without a newline before closing.
      consume(carry);
      carry = "";
    } catch {
      // The socket erroring mid-read is a close with a worse mood.
    } finally {
      closed = true;
      stopHeartbeat();
      events.close();
      settleAll(
        new HermeticError(
          CHAT_ERROR_CODES.PROTOCOL,
          `${instance}: chat socket closed before the box answered`,
        ),
      );
    }
  })();

  function route(parsed: unknown): void {
    const doc = rec(parsed);
    if (!doc) return;
    /**
     * A JSON-RPC *response* is the frame with an `id` and **no `method`**.
     *
     * Testing `id` alone was wrong in a way that only shows up against a real
     * box: since 0.21.3 upstream sends genuine server→client *requests* for the
     * approval and clarify round-trips (§8.2), and those carry both an `id` and
     * a `method`. Both id counters start at 1, so a collision is not the edge
     * case — it is the normal case. The caller waiting on outbound id 1 would be
     * resolved with the inbound request's `result`, which does not exist, and
     * `session.create` would come back `undefined`.
     */
    const id = doc.method === undefined ? num(doc.id) : null;
    if (id !== null && pending.has(id)) {
      const p = pending.get(id);
      pending.delete(id);
      if (!p) return;
      clearTimeout(p.timer);
      const err = rec(doc.error);
      if (err) {
        p.reject(
          new HermeticError(
            CHAT_ERROR_CODES.PROTOCOL,
            `${instance}: ${str(err.message) ?? "the box refused the request"}`,
            { code: num(err.code) },
          ),
        );
        return;
      }
      p.resolve(doc.result);
      return;
    }
    if (str(doc.method) === "event") {
      const params = rec(doc.params) ?? {};
      if (str(params.type) === "gateway.ready" && rec(params.payload)?.heartbeat === true) {
        startHeartbeat();
      }
      eventsSeen += 1;
      events.push(params);
      return;
    }
    if (typeof doc.method === "string" && (typeof doc.id === "string" || typeof doc.id === "number")) {
      const params = rec(doc.params) ?? {};
      eventsSeen += 1;
      events.push({
        type: "hermetic.server_request",
        session_id: params.session_id,
        payload: { method: doc.method, id: String(doc.id), params },
      });
    }
  }

  function request(
    method: string,
    params: Record<string, unknown>,
    deadlineMs = waitMs,
    opts: { signal?: AbortSignal | undefined } = {},
  ): Promise<unknown> {
    if (closed) {
      return Promise.reject(
        new HermeticError(CHAT_ERROR_CODES.PROTOCOL, `${instance}: chat socket is closed`),
      );
    }
    const signal = opts.signal;
    if (signal?.aborted) return Promise.reject(abortedDuring(method));
    const id = ++nextId;
    return new Promise<unknown>((resolve, reject) => {
      let onAbort: (() => void) | null = null;
      /**
       * Everything this request registered, undone exactly once.
       *
       * Three things can end a request — the reply, the deadline, the caller —
       * and each of them has to take the other two down. The abort listener is
       * the new one and the one that leaks: a pane that probes and cancels
       * would otherwise pin a listener per attempt to a signal it keeps.
       */
      const retire = (): void => {
        pending.delete(id);
        clearTimeout(timer);
        if (onAbort !== null) {
          signal?.removeEventListener("abort", onAbort);
          onAbort = null;
        }
      };
      const timer = setTimeout(() => {
        retire();
        reject(
          new HermeticError(
            CHAT_ERROR_CODES.UNREACHABLE,
            `${instance}: no answer to ${method} within ${Math.round(waitMs / 1000)}s`,
          ),
        );
      }, deadlineMs);
      // Never keep the process alive for a reply nobody is waiting on any more.
      timer.unref?.();
      if (signal) {
        onAbort = () => {
          retire();
          reject(abortedDuring(method));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      pending.set(id, {
        resolve: (v) => {
          retire();
          resolve(v);
        },
        reject: (e) => {
          retire();
          reject(e);
        },
        timer,
      });
      socket.send(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** The `ABORTED` a hung-up caller gets, worded like `checkAbort`'s. */
  function abortedDuring(method: string): HermeticError {
    return new HermeticError("ABORTED", `operation aborted during ${method}`, { phase: method });
  }

  /**
   * Tear the socket down for a stated reason, running every path a real close
   * runs: the event channel ends (a turn's pump sees `end` and reconnects from
   * its cursor — only a spent reconnect budget yields an *incomplete* `done`; a
   * watch's hint stream returns and its own reconnect budget takes over)
   * and every in-flight request is settled.
   */
  function shutdown(reason: string): void {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    events.close();
    settleAll(new HermeticError(CHAT_ERROR_CODES.PROTOCOL, `${instance}: ${reason}`));
    socket.close();
  }

  function close(): void {
    shutdown("chat socket closed");
  }

  const unref = (): void => socket.unref?.();

  return { request, events: events.drain(), arrived: () => eventsSeen, unref, close };
}

/**
 * A one-producer, one-consumer async queue.
 *
 * The reader loop cannot `yield` — it is a plain async function draining the
 * socket — and the turn generator cannot poll, so the two need a buffer between
 * them. Buffered rather than dropping: `prompt.submit`'s reply and the first
 * event frames can arrive in the same tick, before the turn generator has begun
 * iterating events at all.
 */
function channel<T>(): { push(v: T): void; close(): void; drain(): AsyncIterable<T> } {
  const buffer: T[] = [];
  let done = false;
  let wake: (() => void) | null = null;

  function nudge(): void {
    const w = wake;
    wake = null;
    w?.();
  }

  return {
    push(v: T): void {
      buffer.push(v);
      nudge();
    },
    close(): void {
      done = true;
      nudge();
    },
    async *drain(): AsyncIterable<T> {
      for (;;) {
        while (buffer.length > 0) {
          const head = buffer.shift();
          if (head !== undefined) yield head;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

type Step =
  | { kind: "event"; value: Record<string, unknown> }
  | { kind: "end" }
  | { kind: "aborted" }
  | { kind: "timeout" };

/**
 * How long a capability advertisement may take before the turn goes on without
 * it. It is one in-memory flag on the gateway, so anything slower is a socket
 * that is about to fail its next request anyway.
 */
const CAPABILITIES_DEADLINE_MS = 5_000;

/**
 * Tell the gateway this socket answers server→client requests — approvals,
 * clarifications, sudo and secret prompts — so it sends them here.
 *
 * From Hermes `v2026.9.21` the gateway delivers a prompt only to a client on
 * the session that has sent `client.capabilities {server_requests: true}`; with
 * none attached it withdraws an approval at once ("the attached client cannot
 * answer approval requests") and resolves a clarify to nothing
 * (`tui_gateway/server_requests.py:117-122`). This socket does answer them:
 * `readRpc` surfaces each one as a `hermetic.server_request` event and the
 * operator replies through `request.answer`.
 *
 * Only for a socket a turn is read from — the one that submits the prompt and
 * the one a dropped turn reconnects on. A socket that cannot surface a prompt
 * must not claim it can, or a prompt sent to it alone waits out its whole
 * deadline instead of failing fast.
 *
 * Best effort. An older gateway answers `-32601` (method not found) and behaves
 * as it always did; any other refusal leaves prompts failing fast, which is no
 * worse than not asking. Only the caller's own abort is passed through.
 */
export async function advertiseServerRequests(rpc: Rpc, signal?: AbortSignal): Promise<void> {
  try {
    await rpc.request("client.capabilities", { server_requests: true }, CAPABILITIES_DEADLINE_MS, {
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
  }
}

/**
 * One event, or the reason there was not one.
 *
 * Three things can end a wait and they mean three different things to the
 * operator, so they are three values rather than three exceptions. The listener
 * and the timer are both torn down on every path — a turn that races an abort
 * signal thirty times would otherwise pin thirty dead listeners to a signal the
 * caller still holds, which is the bug `abortableSleep` exists to avoid
 * elsewhere in core.
 */
export async function nextEvent(
  it: AsyncIterator<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  deadlineMs: number | null,
): Promise<Step> {
  if (signal?.aborted) return { kind: "aborted" };
  const races: Promise<Step>[] = [
    it.next().then((r) => (r.done === true ? { kind: "end" } : { kind: "event", value: r.value })),
  ];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;

  if (deadlineMs !== null) {
    races.push(
      new Promise<Step>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), deadlineMs);
        timer.unref?.();
      }),
    );
  }
  if (signal) {
    races.push(
      new Promise<Step>((resolve) => {
        onAbort = () => resolve({ kind: "aborted" });
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }

  try {
    return await Promise.race(races);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onAbort !== null) signal?.removeEventListener("abort", onAbort);
  }
}
