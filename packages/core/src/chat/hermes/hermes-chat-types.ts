/**
 * The Hermes chat adapter's public shape: the seams it is handed, the options
 * it accepts, the client it answers with, and the constants that encode
 * something upstream decided.
 *
 * Every one of these names is re-exported from `hermes-chat.ts`, which is the
 * only specifier any caller uses. They live in their own file so the modules
 * behind that facade — connection, roster, sessions, history, turn, peer — can
 * share them without importing each other.
 */
import type { ChatObserveHint } from "../chat-observe.ts";
import type { createCanonicalSessions, ConversationOptions } from "../../render/hermes-canonical.ts";
import { HermeticError } from "../../errors.ts";
import type {
  ChatConversation,
  ChatFrame,
  ChatMessage,
  ChatRespondInput,
  ErrorCode,
  Session,
  Swarm,
} from "../../schema/index.ts";

/* ── the injected seams ───────────────────────────────────────────────────── */

/** Where a box is, resolved by the caller — the adapter never looks an agent up. */
export interface BoxAddress {
  /** The agent name, which is the instance name (§9.2). */
  instance: string;
  /** `https://<host>/` — already resolved from the row's tailnet DNS name. */
  baseUrl: string;
  /**
   * The fleet, when the caller knows it.
   *
   * Only `avatar_seed` reads it, and only because §9.2's identity key is
   * `fleet_id/instance/bot` — a face must not change when a bot is renamed, and
   * must not collide across fleets. The adapter cannot look a fleet up (it
   * reaches boxes, not tables), so an address without one produces a seed that
   * is stable but fleet-local. `chat.ts` has the fleet and should pass it.
   */
  fleet_id?: string | undefined;
}

/**
 * The socket, reduced to the four things this module uses.
 *
 * `frames` is *text* frames, not messages: upstream's protocol is newline
 * delimited, and a single WebSocket frame may legally carry several JSON-RPC
 * documents or half of one. The reader below splits and tolerates both.
 */
export interface ChatSocket {
  send(data: string): void;
  close(): void;
  /**
   * Optional: stop holding the event loop open, for an implementation whose
   * transport can (Bun's `WebSocket` grew an `unref` after this build's
   * wrapper was written). Only `hermes-chat-pool.ts` asks, because only a
   * pooled socket has stretches with nobody waiting on it.
   */
  unref?(): void;
  /** Resolves when the socket opens; rejects if it cannot. */
  opened: Promise<void>;
  /** Every text frame the box sends, in arrival order, until the socket closes. */
  frames: AsyncIterable<string>;
}

/**
 * `fetch`, structurally.
 *
 * Deliberately **not** `typeof fetch`: that type carries a `preconnect`
 * property in this toolchain's lib, so every double — and the one-line wrapper
 * around the real `fetch` in `chat.ts` — fails to satisfy it for a reason that
 * has nothing to do with making a request. Same shape as `FetchLike` in
 * `aws/tailscale.ts`, widened by one argument type because the token scrape
 * passes a `URL`-able string.
 */
export type ChatFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HermesChatDeps {
  /** Injected. Tests pass a recorded double; nothing here ever touches the network. */
  fetch: ChatFetch;
  /**
   * Injected WebSocket factory, for the same reason.
   *
   * `headers` carries `DIRECT_DIAL_HEADERS` — `Origin` only, for the reasons
   * given there. An implementation that cannot set headers (a browser
   * `WebSocket`, which cannot) may ignore it: through Serve, nginx has already
   * supplied everything the gate checks.
   */
  openSocket: (
    url: string,
    opts: { signal?: AbortSignal | undefined; headers?: Record<string, string> | undefined },
  ) => ChatSocket;
  /** ISO-8601 now, injected so fixtures are deterministic. */
  now: () => string;
  /**
   * How long to wait for a reply, and for a turn's first frame. Defaults to
   * `SLOT_WAIT_MS`; present so a test can exercise the timeout without
   * spending thirty seconds doing it.
   */
  slotWaitMs?: number | undefined;
  /**
   * Whether Bot Mode's RPCs share one socket per box (`hermes-chat-pool.ts`).
   *
   * On by default, because the only caller that builds a live client is
   * `defaultHermesChat` and the pane it feeds is the reason the pool exists.
   * `false` is the opt-out, for a caller that wants the old one-socket-per-RPC
   * shape — the turn, history and observation transports are unaffected either
   * way.
   */
  pooled?: boolean | undefined;
  /** The pool's idle TTL, so a test need not spend `REQUEST_POOL_IDLE_MS`. */
  poolIdleMs?: number | undefined;
  /**
   * A turn's reconnect budget and its sleep, injected so a test need not spend
   * a real backoff. Defaults come from the observation service's, because both
   * numbers are bounding the same outage.
   */
  resumeTuning?:
    | {
        attempts?: number | undefined;
        baseMs?: number | undefined;
        maxMs?: number | undefined;
        interruptMs?: number | undefined;
        sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
      }
    | undefined;
}

export interface HermesChatOptions {
  signal?: AbortSignal | undefined;
}

export interface SendOptions extends HermesChatOptions {
  /** Continue an existing session; omitted means create one. */
  session?: string | undefined;
}

export interface HistoryOptions extends HermesChatOptions {
  session?: string | undefined;
  limit?: number | undefined;
}

/**
 * What a passive observation is narrowed to.
 *
 * `session` is advisory in both directions: a client may use it to drop hints
 * that name a different conversation, and must pass through a hint that names
 * none — a gateway that stops addressing its broadcasts has to cost redundant
 * reads rather than silence.
 */
export interface ObserveOptions extends HermesChatOptions {
  session?: string | undefined;
  /**
   * The other sessions this watch answers for, asked at every event.
   *
   * A pinned session is not a fixed one: `session.compress` mints a new tip and
   * upstream broadcasts under it, so a watch that only ever accepted the id it
   * was opened with went quiet at the first compression. The caller knows the
   * tip — it is what its last authoritative read came back from — so it is
   * asked rather than guessed at here, and asked late, because the tip moves
   * while the socket stays open. Ignored by a watch that named no session: that
   * one already accepts everything.
   */
  sessions?: (() => readonly string[]) | undefined;
}

export interface HermesChatClient {
  conversation?(
    box: BoxAddress,
    bot: string,
    opts?: ConversationOptions,
  ): Promise<ChatConversation | null>;
  compact?: ReturnType<typeof createCanonicalSessions>["compact"];
  archive?: ReturnType<typeof createCanonicalSessions>["archive"];
  respond?(
    box: BoxAddress,
    input: ChatRespondInput,
    opts?: HermesChatOptions,
  ): Promise<{ status: "ok" | "expired"; remaining?: string[] }>;
  botModeRpc?(
    box: BoxAddress,
    method: string,
    params: Record<string, unknown>,
    opts?: HermesChatOptions & { deadlineMs?: number },
  ): Promise<unknown>;
  botModeRest?(
    box: BoxAddress,
    method: string,
    path: string,
    body?: unknown,
    opts?: HermesChatOptions,
  ): Promise<unknown>;
  /**
   * The box's current dashboard session token (§7.4).
   *
   * Every other method here uses the token as a means and never lets it out;
   * this one *is* the answer, because Hermes Desktop's "Remote Gateway" form
   * asks the operator to paste it and has no way to discover it for itself —
   * upstream's Electron shell scrapes `window.__HERMES_SESSION_TOKEN__` only
   * from a backend it spawned locally.
   *
   * Always a fresh scrape, never the cache: the token dies with the dashboard
   * process, so handing back a remembered one would let `agent desktop` print a
   * token that stopped working when the box last restarted — and an operator
   * pasting it would see Desktop's "Remote host rejected the saved token" with
   * nothing on this side to explain it.
   */
  token(box: BoxAddress, opts?: HermesChatOptions): Promise<string>;
  swarm(box: BoxAddress, opts?: HermesChatOptions): Promise<Swarm>;
  sessions(box: BoxAddress, bot: string, opts?: HermesChatOptions): Promise<Session[]>;
  history(box: BoxAddress, bot: string, opts?: HistoryOptions): Promise<ChatMessage[]>;
  send(box: BoxAddress, bot: string, text: string, opts?: SendOptions): AsyncIterable<ChatFrame>;
  /**
   * The passive hint stream (§9.2): "something happened on this
   * box", with no message and no transcript.
   *
   * Optional, and its absence is a supported gateway rather than a broken one —
   * `chat-observe.ts` falls back to its poll floor and keeps every guarantee it
   * makes. A client that implements it must not submit a prompt, create a
   * session or resume one: observation is passive.
   */
  observe?(box: BoxAddress, bot: string, opts?: ObserveOptions): AsyncIterable<ChatObserveHint>;
  // biome-ignore lint/suspicious/noConfusingVoidType: Existing injected adapters return Promise<void>; the live adapter additionally reports an idle no-op without breaking those implementations.
  abort(box: BoxAddress, bot: string, opts?: SendOptions): Promise<boolean | void>;
}

/* ── constants that encode something upstream decided ─────────────────────── */

/** Capacity is not advertised by the gateway; null means unknown. */
export const WARM_SLOTS_PER_GATEWAY = null;

/** Local deadline for a turn's first frame, independent of gateway capacity. */
export const SLOT_WAIT_MS = 30_000;

/**
 * How often the adapter sends a JSON-RPC `ping` on a dedicated chat socket, and
 * how long it will tolerate total silence before treating the socket as dead.
 *
 * Both numbers are Hermes Desktop's (`apps/shared/src/json-rpc-channel.ts`):
 * a probe every fifteen seconds, three probes' worth of grace. Matching it is
 * the point — the gateway is the same process either way, so a cadence it
 * already survives is a cadence that needs no new behaviour from the box.
 *
 * Liveness is **any-inbound**, not pong-matching: every frame the box sends
 * defers the deadline, so a socket that is streaming a long answer is never
 * killed for failing to answer one probe. The ping exists only to make a
 * *silent* socket say something, because a tailnet drop after the first content
 * frame is otherwise indistinguishable from a model that is thinking — and
 * `SLOT_WAIT_MS` has already been spent by then.
 */
export const CHAT_HEARTBEAT_MS = 15_000;

/** @see CHAT_HEARTBEAT_MS */
export const CHAT_HEARTBEAT_DEADLINE_MS = 45_000;

/**
 * The activity key a reconnecting turn's status block carries.
 *
 * Heads replace status blocks by key, so every stage of one outage — trying,
 * succeeded, gave up — has to be the same string, and a turn that reconnected
 * three times leaves one block rather than six.
 */
export const CHAT_RECONNECT_BLOCK_KEY = "connection:reconnect";

/**
 * What the box's WebSocket gate wants to see (§8.1's first caveat) — `Origin`,
 * and deliberately **not** `Host`.
 *
 * The plan's caveat says a proxy that terminates the connection itself must
 * send both, because the gate checks both. That is true of a proxy dialling the
 * dashboard directly on `127.0.0.1:9119`. It is not what hermetic does: every
 * request here goes through Tailscale Serve, and hermetic's own nginx already
 * rewrites `Host` on that hop. Sending `Host` from here as well is not
 * belt-and-braces, it is a broken request — Bun's `fetch` treats a `Host`
 * header as the connection target and tries to open a socket to
 * `127.0.0.1:9119` on the *laptop*, where nothing is listening. Every call
 * failed with `ConnectionRefused`, reported as "dashboard did not answer",
 * against a box that was answering `200` to `curl` at the same moment.
 *
 * This cost a live debugging session and no test caught it, because a test's
 * injected `fetch` never looks at the headers. If a direct-dial mode is ever
 * added, it needs its own header set *and* a transport that understands `Host`
 * as a header rather than as an address.
 */
export const DIRECT_DIAL_HEADERS: Record<string, string> = {
  Origin: "http://127.0.0.1:9119",
};

/**
 * Codes this module raises, named once so the adapter and its tests cannot
 * drift apart on a string literal. Every one of them is in `schema/errors.ts`'s
 * `ErrorCode` enum, which is what makes them throwable: the CLI maps a code to
 * an exit status and the server maps it to an HTTP status, so a code that
 * exists only here would be a failure neither head could classify.
 *
 * `ErrorFrame.code` in `schema/chat.ts` is a plain string, because a frame may
 * also carry a code that came *from the box* and that this build has never
 * heard of. Only a `throw` needs the enum.
 */
export const CHAT_ERROR_CODES = {
  /** The box did not answer: off the tailnet, stopped, or no dashboard behind Serve. */
  UNREACHABLE: "CHAT_UNREACHABLE",
  /** `GET /` answered, but with no `__HERMES_SESSION_TOKEN__` in it. */
  NO_TOKEN: "CHAT_NO_TOKEN",
  /** The box answered with something that is not the protocol this adapter speaks. */
  PROTOCOL: "CHAT_PROTOCOL",
  /** Thirty seconds of waiting for one of the gateway's warm backend slots. */
  NO_SLOT: "CHAT_NO_SLOT",
  /** The turn itself failed on the box — the model refused, or the agent errored. */
  TURN_FAILED: "CHAT_TURN_FAILED",
} as const;

export const chatError = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new HermeticError(code, message, details);
