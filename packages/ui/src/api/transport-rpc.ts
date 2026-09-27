/**
 * The transport: the seam's three verbs carried over Electrobun's
 * typed bridge. Since Phase 5b it is the only one — there is no URL left to
 * reach hermetic over, and no fallback behind it.
 *
 * The bridge is one channel, not a socket per stream, so everything a
 * connection used to imply has to be said out loud here:
 *
 * - a stream is *named* rather than connected. Opening one answers with a
 *   `stream_id`, frames arrive as pushes tagged with it, and closing is a
 *   second request rather than hanging up (`app/src/handlers/streams.ts`).
 * - there is nothing to drop, so there is no reconnect and no backoff. A
 *   subscription lives as long as the window does, and `onRetryIn` is never
 *   called — the footer that counts down to a reconnect has nothing to count.
 * - `ops.subscribe` must carry its own cursor. Nothing hides one here, so the
 *   transport remembers the last frame id it saw for each op and sends it back
 *   as `after: { generation, seq }`, which is what makes a reopened op stream
 *   resume instead of replaying from zero.
 *
 * Nothing imports the Electrobun runtime at module scope. The `electrobun`
 * package in `node_modules` is a 2.x bootstrap whose every export throws — the
 * real module comes from the Hutch devkit and only exists behind a `views://`
 * page — so the constructor arrives as an injected dependency
 * (`createRpcTransport`), and `installRpcTransport` is the one place that
 * reaches for the real one. That keeps the module importable by a test, which
 * passes its own fake `Electroview` in.
 *
 * `src/entry-app.tsx` awaits `installRpcTransport` before it renders anything:
 * `transport()` throws until something is installed, and there is nothing else
 * to install.
 */
import type { HermeticRPC } from "@hermetic/app";
import { setPageVisible } from "../lib/visibility.ts";
import { emitAppUpdate } from "../state/app-update-state.tsx";
import { ApiError, apiErrorOf, isError } from "./errors.ts";
import {
  type RequestName,
  type RequestOptions,
  type RequestParams,
  type StreamFrame,
  type StreamHandlers,
  type StreamName,
  type SubscriptionHandlers,
  type SubscriptionKind,
  type Transport,
  setTransport,
} from "./transport.ts";

/* ── the bridge, as little of it as this module needs ────────────────────── */

/** The app's half of the contract, named once so the reads below stay short. */
type Requests = HermeticRPC["bun"]["requests"];
/** Every name the bridge answers: `PUBLIC_METHODS` plus the machinery. */
export type RpcName = keyof Requests;
type Pushes = HermeticRPC["webview"]["messages"];
/** The page's own half: what it may say, as opposed to ask. */
type Sends = HermeticRPC["bun"]["messages"];
/** The sink frame the app pushes whole, on the three messages that carry one. */
type AppFrame = Pushes["op.event"]["msg"];

/**
 * What `Electroview.defineRPC` hands back: one async call per `bun.requests`
 * name, with that name's params and that name's answer.
 *
 * Typed off `HermeticRPC` rather than structurally, so a request this transport
 * spells wrong is a compile error here instead of a call that resolves to
 * nothing on a build with no HTTP fallback to notice.
 *
 * `send` is the one thing here that is not a request: `bun.messages` holds a
 * single name, `page.ready`, which `sendPageReady` below puts on the bridge for
 * the app entry.
 */
export type RpcHandle = {
  /**
   * Callable, and also a proxy with one property per request name. Only the
   * call form is safe: Electrobun's proxy answers any name the underlying
   * function already has (`prop in target`), so `request["apply"]` is
   * `Function.prototype.apply`, not the `apply` request — and calling it sends
   * a request with no method ("The requested method has no handler:
   * undefined"). `send` below always goes through the call.
   */
  request: (<K extends RpcName>(
    method: K,
    params: Requests[K]["params"],
  ) => Promise<Requests[K]["response"]>) & {
    [K in RpcName]: (params: Requests[K]["params"]) => Promise<Requests[K]["response"]>;
  };
  /**
   * Page → main. One name (`BunMessages`): `page.ready`, which the app entry
   * sends once React has mounted — the handshake a head with no socket has
   * instead of a connection to notice.
   */
  send: <K extends keyof Sends>(message: K, payload: Sends[K]) => void;
};

/** One handler per `webview.messages` name, each taking that message's payload. */
export type RpcMessageHandlers = { [K in keyof Pushes]?: (payload: Pushes[K]) => void };

/**
 * The slice of `Electroview` this transport uses, so a test can pass a fake one.
 *
 * TODO(evan): narrow to the devkit's own `Electroview` now that Hutch projects
 * it into `packages/app/.hutch/devkit` and `packages/ui/tsconfig.json` maps
 * `electrobun/view` at it. It stays hand-declared for the moment because a test
 * passes a fake in through here and the devkit's class is not one. What rides
 * on it is `HermeticRPC`'s shape, not this file's.
 */
export interface ElectroviewLike {
  new (options: { rpc?: RpcHandle }): { rpc?: RpcHandle };
  defineRPC(options: {
    maxRequestTime?: number;
    handlers: {
      requests?: Record<string, (params: never) => unknown>;
      messages?: RpcMessageHandlers;
    };
  }): RpcHandle;
}

/* ── names ───────────────────────────────────────────────────────────────── */

/**
 * Where the UI's `RequestName` and the app's own machinery name disagree.
 *
 * Everything drawn from `PUBLIC_METHODS` agrees by construction — the RPC
 * request name *is* the dotted method path — and so does every machinery name
 * the two sides happened to spell the same. This table is the rest of it.
 *
 * One entry today. `init.tailscale.oauth` is the UI's name for the OAuth
 * credential check; the handler that answers it is `init.verifyOauth`
 * (`app/src/handlers/init.ts`).
 *
 * `Divergent` is what makes the table honest: it is every `RequestName` the
 * bridge does *not* answer, and the record is total over it, so a UI name with
 * no handler behind it cannot be added without a translation being added with
 * it. The silent mismatch this guards against is not an error at runtime — it
 * is a request that reaches a dispatcher with no entry for it, in the one build
 * that has no HTTP fallback to notice.
 */
type Divergent = Exclude<RequestName, RpcName>;

const RENAMED: Record<Divergent, RpcName> = {
  "init.tailscale.oauth": "init.verifyOauth",
};

/** The name to put on the wire for one request. */
function rpcNameOf(name: RequestName): RpcName {
  // The cast is the `else` of the lookup above: `Divergent` is by construction
  // the only part of `RequestName` that is not already an `RpcName`, and `tsc`
  // does not narrow a union by a successful index.
  return RENAMED[name as Divergent] ?? (name as RpcName);
}

/**
 * The request behind each long-lived feed, and behind each finite stream. Both
 * halves are machinery names (`app/src/declare.ts`), and both close with a
 * second request rather than by closing anything.
 */
const SUBSCRIBE: Record<SubscriptionKind, { open: RpcName; close: RpcName }> = {
  fleet: { open: "fleet.subscribe", close: "fleet.unsubscribe" },
  chat: { open: "chat.subscribe", close: "chat.unsubscribe" },
};

const STREAM: Record<StreamName, { close: RpcName }> = {
  "ops.subscribe": { close: "ops.unsubscribe" },
  "logs.open": { close: "logs.close" },
  "chat.turn": { close: "chat.turn.abort" },
};

/**
 * The pushes this transport reads (`app/src/rpc/schema.ts`, `WebviewMessages`).
 *
 * Every envelope names the stream its frame belongs to: by `op_id` for an op,
 * because the page knows that before the `stream_id` comes back, and by
 * `stream_id` for the two whose name it only learns from the answer.
 *
 * The frame inside is carried two ways, and the split is the app's rather than
 * this module's. `op.event`, `fleet.event` and `chat.event` carry the whole sink
 * frame (`{ event, data, id? }`), because a reader dispatches on the frame's
 * *name* and a fleet feed emits names no value of its own carries (`snapshot`,
 * `dropped`). `chat.frame` and `logs.line` carry the value alone under `frame`
 * or `line`, with the terminal frame split out as `done` — so the name has to be
 * put back here, from the turn frame's own `type` or from the one name a console
 * tail uses.
 */
const OP_EVENT = "op.event";
const CHAT_FRAME = "chat.frame";
const LOGS_LINE = "logs.line";
const FLEET_EVENT = "fleet.event";
const CHAT_EVENT = "chat.event";
const APP_UPDATE = "app.update";

/** A source with nothing to say proves the channel alive; a channel needs no proof. */
const KEEPALIVE = "keepalive";

/**
 * How many op cursors one window remembers. Generous: a cursor is two numbers,
 * and the cost of forgetting one is a replay a first subscribe pays anyway.
 */
const MAX_CURSORS = 64;

/* ── frames ──────────────────────────────────────────────────────────────── */

/**
 * The app's sink frame as the seam's `StreamFrame`.
 *
 * A straight rename, and nothing more: the bridge carries structured data, so
 * unlike SSE there is no JSON text to parse and `data` is never `undefined` for
 * want of decoding. The app's `id` is optional where the seam's is `""` for a
 * stream that numbers nothing.
 */
function frameOf(frame: AppFrame): StreamFrame {
  return { event: frame.event, id: frame.id ?? "", data: frame.data };
}

/**
 * The frame out of a push that carries the value alone.
 *
 * `done` is the terminal frame, split out by the app so a reader can stop
 * without inspecting the value. `named` is the one name every other frame of
 * that stream wears — a console tail's `line` — or null when the value
 * discriminates itself, which is what a turn frame's `type` does. Either way
 * the rebuilt frame is what the handler's own `sink` call wrote
 * (`app/src/handlers/{agents,chat}.ts`), so a reader above the seam cannot tell
 * the two carriers apart.
 */
function valueFrameOf(value: unknown, done: unknown, named: string | null): StreamFrame | null {
  if (done !== undefined) return { event: "done", id: "", data: done };
  if (value === undefined) return null;
  const own =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)["type"]
      : undefined;
  const event = named ?? (typeof own === "string" ? own : null);
  if (event === null) return null;
  return { event, id: "", data: value };
}

/**
 * One string field off a value the contract does not type for us.
 *
 * `MachineryRequests` says every open half answers `{ stream_id: string }`, and
 * `openStream`'s `op_id` comes from a `RequestParams` the seam leaves untyped
 * (`transport.ts`) — so both reads happen here rather than through the contract.
 */
function stringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const read = (value as Record<string, unknown>)[field];
  return typeof read === "string" ? read : null;
}

/**
 * `<generation>:<seq>` back into its two numbers.
 *
 * The same parse as `streams.ts`'s `parseFrameId`, deliberately not imported
 * from it: `streams.ts` is the protocol *above* this seam and importing it here
 * would point the dependency the wrong way. The duplication is four lines and
 * one regex, and the format is the server's (`app/src/handlers/ops.ts`).
 */
function parseCursor(id: string): { generation: number; seq: number } | null {
  const parsed = /^(?:(\d+):)?(\d+)$/.exec(id);
  if (parsed === null) return null;
  return { generation: Number(parsed[1] ?? "0"), seq: Number(parsed[2]) };
}

/* ── errors ──────────────────────────────────────────────────────────────── */

/**
 * A rejection off the bridge as the `ApiError` every component already renders.
 *
 * A handler's `HermeticError` reaches the page as `code`/`message`, plus the
 * `op_id` and `details` that `RequestValidationError`/`InitInFlightError` put in
 * their 400/409 bodies. *Where* on the thrown value those fields sit is the
 * bridge's business rather than the contract's, and it is not one thing:
 * `rpc/bind.ts` nests them under `body`, and the error also carries them flat.
 * Both are read, and the flat reading wins, because a transport that only
 * understood one of them would turn every refusal into a bare `RPC_FAILED` with
 * the code — which is the whole of what a component branches on — thrown away.
 *
 * The `{ error: … }` HTTP body shape is read too, so a handler answering with
 * one verbatim is not a class of bug a component could see. Anything else — the
 * bridge itself failing, a timeout — is thrown as it came, exactly as a `fetch`
 * that never reached the server is thrown by the HTTP transport.
 *
 * Exported for the root `tests/` seam test that drives both halves of this: no
 * package may import both sides, so the assertion that the app's thrown shape is
 * the shape this reads cannot live in either package's own tree.
 */
export function asFailure(reason: unknown): unknown {
  if (typeof reason !== "object" || reason === null) return reason;
  const nested = (reason as { body?: unknown }).body;
  return refusalIn(reason) ?? refusalIn(nested) ?? reason;
}

/** One refusal, wherever it was found: flat on the error, or under its `body`. */
function refusalIn(value: unknown): ApiError | null {
  if (typeof value !== "object" || value === null) return null;
  if (isError(value)) return apiErrorOf(value);
  const body = value as Record<string, unknown>;
  if (typeof body["code"] !== "string" || typeof body["message"] !== "string") return null;
  return new ApiError(body["code"], body["message"], {
    opId: typeof body["op_id"] === "string" ? body["op_id"] : null,
    details: body["details"] ?? null,
  });
}

/**
 * `{ code, message }` for a `StreamHandlers.onEnd` failure, from whatever ended
 * the stream. Exported beside `asFailure`, for the same seam test.
 */
export function failureOf(reason: unknown): { code: string; message: string } {
  if (reason instanceof ApiError) return { code: reason.code, message: reason.message };
  const converted = asFailure(reason);
  if (converted instanceof ApiError) {
    return { code: converted.code, message: converted.message };
  }
  return { code: "RPC_FAILED", message: String((reason as Error)?.message ?? reason) };
}

/** What a caller aborting a request rejects with: `fetch`'s own reason, or its default. */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/* ── page visibility ─────────────────────────────────────── */

/**
 * The app's webview reports `document.visibilityState === "hidden"` for the
 * life of the window and fires no `visibilitychange` — activating the app does
 * not move either — so the page cannot answer "am I on screen" for itself.
 *
 * It does not have to. The main process knows: a window it owns is focused or
 * it is not, and `main/windows.ts` pushes that as `app.visibility`. This is the
 * page half — the message handler below hands each push to
 * `lib/visibility.ts`, which every gated reader already asks.
 *
 * The seed matters as much as the pushes. A window that has just been built is
 * a window the operator is looking at, and the first push may be a focus change
 * that never comes — an app opened and left alone raises no event — so the page
 * starts visible and the pushes only *move* it. Nothing is silently gated off,
 * which is the failure the shim this replaces existed to prevent: `chat.swarms`
 * was never asked for, and the bot rail read "0 instances · 0 profiles" on a
 * fleet whose instances were all being listened to.
 */
const APP_VISIBILITY = "app.visibility";

/* ── the transport ───────────────────────────────────────────────────────── */

/** One reader of a finite stream, while it is still open. */
interface OpenStream {
  handlers: StreamHandlers;
  /** Named once the open request answers; until then there is nothing to close. */
  streamId: string | null;
  closed: boolean;
  ended: boolean;
}

export interface RpcTransportOptions {
  Electroview: ElectroviewLike;
  /**
   * How long one request may take. Infinite by default and on purpose: a
   * `foundation.update` is twenty minutes of AWS and a bridge timeout would
   * abandon an op that is still running perfectly well.
   */
  maxRequestTime?: number;
}

export function createRpcTransport(options: RpcTransportOptions): Transport {
  const { Electroview } = options;

  // Before anything above the seam can read it: `entry-app.tsx` installs this
  // transport before it renders, so no gate has run yet.
  setPageVisible(true);

  /**
   * Op streams, keyed by `op_id` — known before the stream has a name.
   *
   * A *set* per op, because two readers of one op is ordinary: a drawer and the
   * fleet board can both follow the same create. They share one push, so the
   * fan-out is this map's job; each reader still opens and closes its own
   * subscription on the other side — this is routing, not sharing.
   */
  const ops = new Map<string, Set<OpenStream>>();
  /** Turn and console streams, keyed by the `stream_id` the open request answered with. */
  const byStreamId = new Map<string, OpenStream>();
  /**
   * Frames for a `stream_id` whose open request has not resolved yet.
   *
   * A stream's id is the *resolved value* of the request that opened it, so the
   * frames a handler emits before that resolves have nothing to be tagged with.
   * `rpc/bind.ts` holds those on the main side and flushes them once the id
   * exists; this is the same buffer on this side, for the ordering the page
   * cannot see — the answer and the first pushes travel the same bridge in the
   * same direction and nothing promises which arrives first. It is the
   * difference between a turn that drops its first token and one that does not.
   */
  const orphans = new Map<string, StreamFrame[]>();
  /**
   * The last frame id *delivered* per op, which is what a reopened op stream
   * resumes from.
   *
   * Outliving the stream is the point — a cursor exists so that the next
   * `openStream` for that op picks up where the last one stopped — so it is
   * pruned on the two occasions it has stopped meaning anything: the op's `done`
   * reached a reader (a finished op replays whole, which is what a page showing
   * its history wants), and the cap below.
   */
  const cursors = new Map<string, { generation: number; seq: number }>();
  /** Long-lived feeds. A set per kind, because two readers of the fleet share one subscription. */
  const feeds: Record<SubscriptionKind, Set<SubscriptionHandlers>> = {
    fleet: new Set(),
    chat: new Set(),
  };
  const feedIds: Record<SubscriptionKind, string | null> = { fleet: null, chat: null };
  /** The open request for a feed, while it is in flight. See `subscribe`. */
  const feedOpening: Record<SubscriptionKind, Promise<string | null> | null> = {
    fleet: null,
    chat: null,
  };

  /**
   * Deliver one frame, and say whether the reader actually got it.
   *
   * The answer is what the op cursor advances on. A frame that reached nobody —
   * because the reader closed, or because the close request has not landed on
   * the other side yet — must not move the cursor, or the next `openStream`
   * would send an `after` past events the page never saw and the server would
   * skip them. `makeFrameFilter` cannot notice: it drops duplicates, not gaps.
   */
  const deliver = (stream: OpenStream, frame: StreamFrame): boolean => {
    if (stream.closed || stream.ended) return false;
    if (frame.event === KEEPALIVE) return false;
    stream.handlers.onFrame(frame);
    // A finite stream ends on its own `done` frame — there is no socket whose
    // closing would say so. `ok` is true because the stream reached its end;
    // whether the *op* succeeded is in the frame the reader just got.
    if (frame.event !== "done") return true;
    stream.ended = true;
    // The reader may have closed us from inside `onFrame` — `followOp` reads
    // the `done` payload and hangs up on the spot — and `onEnd` is documented
    // never to arrive after that.
    if (!stream.closed) stream.handlers.onEnd(true, null);
    return true;
  };

  const toFeed = (kind: SubscriptionKind, frame: StreamFrame): void => {
    if (frame.event === KEEPALIVE) return;
    for (const handlers of [...feeds[kind]]) handlers.onFrame(frame);
  };

  /**
   * The push handlers, one per `webview.messages` name. Both the names and each
   * payload's shape are `HermeticRPC`'s (`app/src/rpc/schema.ts`), so a message
   * the app renames, or an envelope field it moves, is a compile error here.
   */
  const rpc = Electroview.defineRPC({
    maxRequestTime: options.maxRequestTime ?? Number.POSITIVE_INFINITY,
    handlers: {
      messages: {
        [APP_VISIBILITY]: (payload) => {
          setPageVisible(payload.visible);
        },
        [OP_EVENT]: (payload) => {
          const frame = frameOf(payload.msg);
          let delivered = false;
          for (const stream of [...(ops.get(payload.op_id) ?? [])]) {
            // A reader that does not resume the op (`StreamHandlers.resumes`)
            // may end it, but never moves where the next open picks up.
            const counts = stream.handlers.resumes !== false || frame.event === "done";
            if (deliver(stream, frame) && counts) delivered = true;
          }
          if (!delivered) return;
          if (frame.event === "done") {
            cursors.delete(payload.op_id);
            return;
          }
          const cursor = parseCursor(frame.id);
          if (cursor !== null) remember(payload.op_id, cursor);
        },
        [CHAT_FRAME]: (payload) => {
          routeById(payload.stream_id, valueFrameOf(payload.frame, payload.done, null));
        },
        [LOGS_LINE]: (payload) => {
          routeById(payload.stream_id, valueFrameOf(payload.line, payload.done, "line"));
        },
        [FLEET_EVENT]: (payload) => {
          toFeed("fleet", frameOf(payload.event));
        },
        [CHAT_EVENT]: (payload) => {
          toFeed("chat", frameOf(payload.event));
        },
        // Not a stream: the updater's state, pushed at every open window and
        // read by the footer (`state/app-update-state.tsx`). It is held here
        // rather than routed because it has no subscriber to route to — the
        // page may not have rendered its footer when the first one lands.
        [APP_UPDATE]: (payload) => {
          emitAppUpdate(payload);
        },
      },
    },
  });

  // The page's one outbound message goes through the same handle
  // (`sendPageReady`), and the entry sends it once React has mounted.
  handle = rpc;

  /**
   * Record an op's cursor, keeping the map bounded.
   *
   * A window that follows hundreds of ops over a long session would otherwise
   * hold one entry per op for ever. Oldest-first eviction is safe because an
   * evicted cursor costs a replay from the start of that op's buffer, which is
   * what a first subscribe does anyway.
   */
  function remember(opId: string, cursor: { generation: number; seq: number }): void {
    cursors.delete(opId);
    cursors.set(opId, cursor);
    while (cursors.size > MAX_CURSORS) {
      const oldest = cursors.keys().next();
      if (oldest.done === true) break;
      cursors.delete(oldest.value);
    }
  }

  function routeById(streamId: string, frame: StreamFrame | null): void {
    if (frame === null) return;
    const stream = byStreamId.get(streamId);
    if (stream === undefined) {
      const held = orphans.get(streamId) ?? [];
      held.push(frame);
      orphans.set(streamId, held);
      return;
    }
    deliver(stream, frame);
  }

  // Constructing the view is what attaches the message handlers above to the
  // bridge; the returned handle is not otherwise used, because everything this
  // transport sends goes through the `rpc` object it was given.
  const view = new Electroview({ rpc });
  void view;

  /**
   * One request, aborted the only way a channel with no cancel can be.
   *
   * The request goes through the call form, `request(name, params)`, never
   * `request[name]`: the property form resolves `apply` (a public method) to
   * `Function.prototype.apply` (see `RpcHandle`). What is erased is the
   * *pairing*: the seam hands over a `RequestParams` (`transport.ts` explains
   * why it is not narrowed until Phase 5), and the contract's responses are
   * `unknown` for every public method anyway, so threading `K` through here
   * would buy a cast at each call site instead of the one below. This is that
   * one cast, and it is the whole of it.
   */
  const call = rpc.request as (method: RpcName, params: RequestParams) => Promise<unknown>;

  async function send(name: RpcName, params: RequestParams, signal?: AbortSignal): Promise<unknown> {
    const answer = call(name, params).catch((reason: unknown) => {
      throw asFailure(reason);
    });
    if (signal === undefined) return await answer;
    if (signal.aborted) throw abortReason(signal);
    /**
     * The bridge has no cancel: the main process finishes the work either way.
     * What an abort buys the caller is what an aborted `fetch` buys it — the
     * promise settles now, and the answer, whenever it turns up, is dropped
     * rather than delivered to a view that has moved on.
     */
    return await new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", abort, { once: true });
      answer.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (reason: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(reason);
        },
      );
    });
  }

  /** The `stream_id` off an open request's answer, or null when it did not name one. */
  function streamIdOf(answer: unknown): string | null {
    return stringField(answer, "stream_id");
  }

  /** Drop this window's subscription to a feed. Idempotent, and silent on failure. */
  function closeFeed(kind: SubscriptionKind): void {
    const streamId = feedIds[kind];
    if (streamId === null) return;
    feedIds[kind] = null;
    void send(SUBSCRIBE[kind].close, { stream_id: streamId }).catch(() => {
      // A close that failed leaves a subscription the app drops with the window
      // anyway; there is nobody left to tell.
    });
  }

  return {
    async request<T>(
      name: RequestName,
      params?: RequestParams,
      requestOptions?: RequestOptions,
    ): Promise<T> {
      return (await send(rpcNameOf(name), params ?? {}, requestOptions?.signal)) as T;
    },

    /**
     * `key` is unused, as it is over HTTP: both feeds are one subscription per
     * window, multiplexed by the app, and what a reader wants is decided by
     * what it does with the frames. It stays in the signature because a
     * transport with a channel per conversation would key on it.
     */
    subscribe(kind: SubscriptionKind, _key: string | null, handlers: SubscriptionHandlers): () => void {
      let stopped = false;
      feeds[kind].add(handlers);

      if (feedIds[kind] !== null) {
        handlers.onConnected(true);
      } else {
        /**
         * One open request per feed, however many readers ask at once.
         *
         * Two components mounting in the same tick is the normal case, and
         * waiting for `feedIds[kind]` to be filled in would have both of them
         * see `null` and both send a `subscribe`: two server-side subscriptions
         * pushing into the one set of readers, every frame delivered twice, and
         * the first `stream_id` overwritten so that it is never closed. The
         * promise is the flag, set before the send rather than after the answer.
         */
        const opening =
          feedOpening[kind] ?? (feedOpening[kind] = send(SUBSCRIBE[kind].open, {}).then(streamIdOf));
        void opening.then(
          (streamId) => {
            if (feedOpening[kind] === opening) {
              feedOpening[kind] = null;
              feedIds[kind] = streamId;
            }
            // Everyone who wanted this feed unsubscribed while it was opening.
            // The subscription exists on the other side now and nobody is
            // reading it, so this is the only place that can close it.
            if (feeds[kind].size === 0) {
              closeFeed(kind);
              return;
            }
            // No socket, so no drop, so no backoff and no `onRetryIn`: the feed
            // is connected for as long as the window is, and the one connection
            // event a reader gets is its subscribe resolving.
            if (!stopped) handlers.onConnected(true);
          },
          () => {
            if (feedOpening[kind] === opening) feedOpening[kind] = null;
            if (!stopped) handlers.onConnected(false);
          },
        );
      }

      return () => {
        if (stopped) return;
        stopped = true;
        feeds[kind].delete(handlers);
        if (feeds[kind].size > 0) return;
        // A no-op while the open is still in flight — there is no id to close
        // yet — and the resolve above closes it instead.
        closeFeed(kind);
      };
    },

    openStream(name: StreamName, params: RequestParams, handlers: StreamHandlers): () => void {
      const stream: OpenStream = { handlers, streamId: null, closed: false, ended: false };
      const opId = name === "ops.subscribe" ? stringField(params, "op_id") : null;
      /**
       * The replay cursor, and the reason this transport keeps one at all: an
       * op stream reopened after the last one stopped must resume where it
       * stopped, and nothing below this seam remembers where that was — the
       * page asks for "this op" and the head answers from whatever cursor it
       * is handed. A first open has no cursor and replays the buffer whole.
       */
      const sent =
        opId === null
          ? params
          : { ...params, ...(cursors.has(opId) ? { after: cursors.get(opId) } : {}) };
      if (opId !== null) {
        const readers = ops.get(opId) ?? new Set<OpenStream>();
        readers.add(stream);
        ops.set(opId, readers);
      }

      /** Stop routing this op's pushes here, without disturbing the other readers. */
      const forget = (): void => {
        if (opId === null) return;
        const readers = ops.get(opId);
        if (readers === undefined) return;
        readers.delete(stream);
        if (readers.size === 0) ops.delete(opId);
      };

      void send(name, sent).then(
        (answer) => {
          const streamId = streamIdOf(answer);
          stream.streamId = streamId;
          if (streamId === null) return;
          if (opId === null) {
            byStreamId.set(streamId, stream);
            const held = orphans.get(streamId);
            if (held !== undefined) {
              orphans.delete(streamId);
              for (const frame of held) deliver(stream, frame);
            }
          }
          // The caller closed while the open request was in flight: the stream
          // exists on the other side now and nobody is reading it.
          if (stream.closed) close(streamId);
        },
        (reason: unknown) => {
          forget();
          if (stream.closed || stream.ended) return;
          stream.ended = true;
          handlers.onEnd(false, failureOf(reason));
        },
      );

      function close(streamId: string): void {
        void send(STREAM[name].close, { stream_id: streamId }).catch(() => {
          // Closing a stream that already ended on its own answers `{ closed:
          // false }` or refuses; either way there is nothing left to do.
        });
      }

      return () => {
        if (stream.closed) return;
        stream.closed = true;
        forget();
        if (stream.streamId !== null) {
          byStreamId.delete(stream.streamId);
          orphans.delete(stream.streamId);
          if (!stream.ended) close(stream.streamId);
        }
      };
    },
  };
}

/* ── what the bridge pushes that is not a stream ─────────────────────────── */

/** The updater's state, as the main process broadcasts it (`main/updates.ts`). */
export type AppUpdate = Pushes["app.update"];

/**
 * The handle of the transport in force, for the one message the page sends.
 *
 * Module-level because `page.ready` is not a transport verb: it is the entry
 * saying the page exists, and `Transport` has no room for it
 * (`api/transport.ts` is the same three verbs over HTTP).
 */
let handle: RpcHandle | null = null;

/**
 * Tell the main process the page has mounted, and say whether it went.
 *
 * `false` means no transport was built, which in the app is a failed boot and
 * in a test is a module that was imported without one. Either way the caller
 * stays unconditional.
 */
export function sendPageReady(): boolean {
  if (handle === null) return false;
  handle.send("page.ready", {});
  return true;
}

/* ── installing it ───────────────────────────────────────────────────────── */

/**
 * Build the RPC transport and make it the one in force.
 *
 * The `import` is dynamic and lives here rather than at module scope because
 * the `electrobun` package in `node_modules` is a bootstrap whose every export
 * throws: evaluating it at module scope would fail the moment this file was
 * loaded, in a test as much as in the app. Under `views://` the devkit's real
 * module is what resolves.
 *
 * `entry-app.tsx` awaits this before it renders, which is the whole of the
 * ordering: `transport()` throws until it has returned.
 */
export async function installRpcTransport(maxRequestTime?: number): Promise<Transport> {
  const view = await import("electrobun/view");
  const installed = createRpcTransport({
    Electroview: view.Electroview as unknown as ElectroviewLike,
    ...(maxRequestTime === undefined ? {} : { maxRequestTime }),
  });
  setTransport(installed);
  return installed;
}
