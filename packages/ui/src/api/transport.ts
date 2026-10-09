/**
 * The seam between the typed call sites in `api/` and however this UI actually
 * reaches hermetic.
 *
 * There is one implementation, `transport-rpc.ts`, over Electrobun's typed RPC
 * channel. The seam outlived the HTTP one it was written
 * against, which is the point: `api/{client,fleet,chat,streams}.ts` did not
 * change when the carriage did, because nothing above this line knows what
 * carries a request.
 *
 * Three verbs, because the UI does exactly three things to the server:
 *
 * - `request` — one ask, one answer. Rejects with `ApiError` when the server
 *   refused, and with whatever the transport threw when it could not ask.
 * - `subscribe` — a long-lived multiplexed feed the transport keeps alive by
 *   itself (fleet state, the chat fan-in). The server never resumes these: what
 *   it sends a new reader is a snapshot, so reconnection is the transport's
 *   business and the protocol above only wants the frames and the connected
 *   flag.
 * - `openStream` — a finite stream with a beginning and an end (an op's replay
 *   and tail, a serial console read, one chat turn). The caller closes it, or
 *   it ends itself, exactly once.
 *
 * Nothing here imports `@hermetic/core` (§3.1), and nothing here is re-exported
 * from `api/index.ts` — the public surface of `api/` is unchanged by this file
 * existing. Tests reach it directly through `setTransport`.
 */

/**
 * The dotted name of one request: core's own method path (`agents.create`,
 * `plan.destroy`) for everything in `PUBLIC_METHODS`, and the machinery names
 * for the handful of things the head does that core does not (`meta.get`,
 * `fleets.switch`, `init.*`).
 *
 * A union rather than `string` so a typo is a type error on both sides of the
 * seam: `transport-rpc.ts` maps every member onto a name the bridge answers,
 * and a fake in a test cannot canned-answer a name that does not exist.
 */
export type RequestName =
  // machinery: the heads' own, wrapping no core method
  | "meta.get"
  | "fleets.switch"
  | "ops.list"
  | "init.profiles"
  | "init.identity"
  | "init.tailscale"
  | "init.tailscale.oauth"
  | "init.acl"
  // The head raises this one: an OS banner the page cannot raise for itself.
  | "app.notify"
  // And opens this one: a link in the operator's browser (`lib/open-external.ts`).
  | "app.openExternal"
  // core methods
  | "init"
  | "agents.list"
  | "agents.create"
  | "agents.set"
  | "agents.stop"
  | "agents.start"
  | "agents.reboot"
  | "agents.recreate"
  | "agents.history"
  | "agents.destroyed"
  | "agents.rerun"
  | "agents.probe"
  | "agents.desktop"
  | "plan.destroy"
  | "plan.foundation"
  | "plan.policy"
  | "plan.network"
  | "plan.rollout"
  | "plan.teardown"
  | "apply"
  | "volumes.list"
  | "volumes.delete"
  | "doctor"
  | "policy.status"
  | "network.status"
  | "foundation.update"
  | "fleets.list"
  | "fleets.use"
  | "fleets.alias"
  | "directory.status"
  | "settings.get"
  | "settings.set"
  | "secrets.list"
  | "secrets.push"
  | "secrets.delete"
  | "providers.list"
  | "providers.create"
  | "providers.update"
  | "providers.delete"
  | "providers.models"
  | "teardowns.list"
  | "teardown"
  | "runs.list"
  | "upgrade"
  | "notifications.list"
  | "notifications.ack"
  | "notifications.mute"
  | "notifications.clear"
  | "notifications.snooze"
  | "notifications.settings"
  | "presets.get"
  | "presets.set"
  | "chat.listening"
  | "chat.listen"
  | "chat.swarms"
  | "chat.sessions"
  | "chat.history"
  | "chat.abort"
  // Machinery, listed with the core methods it sits between: the one-shot
  // "watch again" (`app/src/handlers/chat.ts`, `observeResume`). The public
  // `chat.observe` is the *subscription* and answers a `stream_id`, which is
  // not what a caller asking whether the observation came back can read.
  | "chat.observe.resume"
  // bot mode (§9.2)
  | "chat.open"
  | "chat.compact"
  | "chat.archive"
  | "chat.respond"
  | "bots.capabilities"
  | "bots.get"
  | "bots.create"
  | "bots.update"
  | "bots.delete"
  | "rooms.get"
  | "rooms.create"
  | "rooms.rename"
  | "rooms.delete"
  | "rooms.history"
  | "rooms.send"
  | "rooms.control"
  | "rooms.respond"
  | "routines.list"
  | "routines.create"
  | "routines.update"
  | "routines.delete"
  | "routines.run"
  | "routines.history";

/** The name of a finite stream. Disjoint from `RequestName` on purpose: a stream is not an answer. */
export type StreamName = "ops.subscribe" | "logs.open" | "chat.turn";

/** Which long-lived feed a `subscribe` means. One socket each, today and under RPC. */
export type SubscriptionKind = "fleet" | "chat";

/**
 * Whatever a call site passes as the request's input: the core schema's own
 * object, plus the §4.7 `target` envelope (`{account_id, region, fleet_id}`) on
 * every fleet-scoped mutation, exactly as the HTTP body carries it today.
 *
 * Untyped here and typed at the call site, which already declares its own
 * parameter and return types (`createAgent(input: CreateAgentInput)`) off the
 * bridge contract (`types.ts`, `BridgeInput`). Narrowing it *here* would buy
 * nothing: the seam takes one name and one bag of parameters, and the pairing
 * of the two is what `transport-rpc.ts` type-checks.
 */
export type RequestParams = Record<string, unknown>;

/** Per-call knobs that are about the transport rather than the request. */
export interface RequestOptions {
  /** Cancels the request. The reads that race a view switch pass one. */
  signal?: AbortSignal;
}

/**
 * One frame off a stream.
 *
 * `data` is already decoded — the transport owns the wire format, so a
 * protocol above it never sees JSON text. It is `undefined`, and only
 * `undefined`, when the frame's payload could not be read at all; every reader
 * here treats that as "skip this frame", which is what each of them did with
 * its own `try`/`catch` around `JSON.parse` before.
 *
 * `id` is the frame's place in its stream, `<generation>:<seq>` for an op
 * (§3.4), and `""` for a stream that numbers nothing. `followOp`'s replay
 * filter reads it exactly as it read `MessageEvent.lastEventId`.
 */
export interface StreamFrame {
  event: string;
  id: string;
  data: unknown;
}

/** A transport-level failure, in the shape every head already renders. */
export interface TransportFailure {
  code: string;
  message: string;
}

/** What a finite stream reports. `onEnd` fires at most once, and never after the caller closed. */
export interface StreamHandlers {
  onFrame: (frame: StreamFrame) => void;
  /**
   * The stream is over.
   *
   * `ok` is the transport's own verdict on whether the stream ran to its end —
   * true only where the transport can tell, which today is the chat turn
   * (`done` reached before the stream closed). A stream that simply died is `(false, null)`;
   * a turn that never started is `(false, failure)`. Whether that counts as a
   * *successful op* is the protocol's question, answered from the `done` frame.
   */
  onEnd: (ok: boolean, failure: TransportFailure | null) => void;
  /**
   * An op stream only: false for a reader that watches an op for its end and
   * draws nothing, so the frames it receives do not move the op's replay
   * cursor. Otherwise a drawer reopened on the op would resume past the phases
   * that ran while only the watcher was reading. Its `done` still clears the
   * cursor — a finished op replays whole either way.
   */
  resumes?: boolean;
}

/** What a long-lived subscription reports. The transport reconnects; the protocol reads frames. */
export interface SubscriptionHandlers {
  onFrame: (frame: StreamFrame) => void;
  /** The socket, which is not any one message's state: true on open, false on a drop. */
  onConnected: (connected: boolean) => void;
  /** A reconnect has been scheduled, `delayMs` from now, so a footer can count down to it. */
  onRetryIn?: (delayMs: number) => void;
  /**
   * A frame named `error` that was really the *protocol's* — one conversation
   * ending, not this socket. Returning true both consumes the frame and leaves
   * the socket alone. Absent, every `error` is the transport's.
   *
   * It exists because a conversation's terminal event and a dead feed are
   * spelled with the same word, and only the payload tells them apart
   * (`chatStream` in `streams.ts`).
   */
  isProtocolError?: (frame: StreamFrame) => boolean;
}

export interface Transport {
  /**
   * Ask once. The result is `unknown` to the seam and narrowed by the caller,
   * whose declared return type is the contract `api/index.ts` publishes.
   */
  request<T>(name: RequestName, params?: RequestParams, options?: RequestOptions): Promise<T>;
  /** Join a long-lived feed. Returns the unsubscribe. */
  subscribe(kind: SubscriptionKind, key: string | null, handlers: SubscriptionHandlers): () => void;
  /** Open a finite stream. Returns the closer; calling it silences the handlers. */
  openStream(name: StreamName, params: RequestParams, handlers: StreamHandlers): () => void;
}

/* ── which transport this bundle is using ────────────────────────────────── */

let current: Transport | null = null;

/**
 * Install a transport.
 *
 * Production calls it once, from `installRpcTransport` (`transport-rpc.ts`),
 * before the page mounts; a test calls it with a `FakeTransport` and restores
 * after. There is no default to fall back to, and that is deliberate: a build
 * that reached a request before installing one would otherwise have answered
 * from whichever module happened to be imported first.
 */
export function setTransport(next: Transport | null): void {
  current = next;
}

/**
 * The transport in force, or null when there is none.
 *
 * The one reader that may ask without committing to an answer: a test that
 * installs a fake puts *this* back afterwards rather than null, so a suite that
 * set up a refusing default keeps it (`test/fake-transport.ts`).
 */
export function installedTransport(): Transport | null {
  return current;
}

/**
 * The transport in force.
 *
 * Throws rather than answering null when nothing is installed: every caller
 * above this line is written against a transport that exists, and a thrown
 * error names the mistake where it happened instead of somewhere downstream.
 */
export function transport(): Transport {
  if (current === null) {
    throw new Error("no transport installed: call `installRpcTransport()` or `setTransport`");
  }
  return current;
}
