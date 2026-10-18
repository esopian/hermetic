/**
 * The adapter, together with hermes-chat-activity.ts, owns the
 * mapping from Hermes wire payloads to the stable chat schema.
 *
 * Everything above it — `chat.ts`, both heads, every renderer — sees only
 * `schema/chat.ts`'s types. That boundary is the decision that makes §4's
 * transport choice survivable: when upstream moves a route on a `hermes_ref`
 * bump, or when the transport is replaced outright, one file changes and no
 * renderer does.
 *
 * ## The transport (§8.1, verified live against a box on 2026-09-16)
 *
 * JSON-RPC 2.0, newline-delimited, bidirectional, over `wss://<box>/api/ws`.
 * A turn is `session.create` → `prompt.submit` → a run of `event`
 * notifications. There is no HTTP route that starts a turn; `/api/chat/*` has
 * exactly one member and it only stages an image.
 *
 * ## The auth, and why it is scraped out of an HTML page
 *
 * The dashboard binds in loopback/insecure mode. In that mode the only
 * credential is a per-process token minted at start-up, injected into the SPA
 * HTML as `window.__HERMES_SESSION_TOKEN__`, sent back as the
 * `X-Hermes-Session-Token` header on HTTP and as `?token=` on the WebSocket.
 * It is not a config key and it is not on disk: it dies with
 * `hermes-dashboard.service` and a new one appears on restart. So scraping it
 * out of `GET /` is not a shortcut around a real credential — it *is* the
 * documented mechanism, and the re-scrape path below is not an optimisation but
 * a requirement, because the token this adapter holds becomes wrong every time
 * the box's dashboard restarts. The tailnet ACL is the actual perimeter
 * (§7.2/§7.4); this token is a DNS-rebinding guard, not a secret from the
 * operator.
 *
 * ## The Host/Origin gate
 *
 * Upstream refuses a WebSocket upgrade whose `Host` is not the bound host and
 * whose web-scheme `Origin` does not match it. hermetic's own nginx on the box
 * rewrites *both* for the Tailscale Serve hop, and every request from here goes
 * through Serve, so this adapter gets the `Host` half for free and must not send
 * it: a client-side `Host` header is a connection target, not a claim, and
 * setting it points the request at the laptop's own `127.0.0.1:9119`. `Origin`
 * is sent explicitly because it is a claim and nothing else supplies it. See
 * `DIRECT_DIAL_HEADERS`, which carries the account of what that cost.
 *
 * ## No network in this file
 *
 * `fetch` and the socket factory both arrive through `HermesChatDeps`. Tests
 * drive recorded frames through a double. Nothing here constructs a client.
 *
 * ## The modules behind this one
 *
 * The adapter is one thing to its callers — every name below is imported from
 * this file — and nine modules behind that facade, each handed an explicit deps
 * object rather than sharing one closure:
 *
 * | module | owns |
 * |---|---|
 * | `hermes-chat-connect.ts` | the session token, its cache, the socket |
 * | `hermes-chat-roster.ts` | profiles, rooms, warm processes → `Swarm` |
 * | `hermes-chat-sessions.ts` | the session registry → `Session` |
 * | `hermes-chat-history.ts` | the durable transcript → `ChatMessage` |
 * | `hermes-chat-turn.ts` | one live turn → `ChatFrame`, its abort and steer |
 * | `hermes-chat-session-socket.ts` | one socket per conversation, held across turns |
 * | `hermes-chat-peer.ts` | Bot Mode's two raw transports |
 * | `hermes-chat-observe.ts` | a socket that only listens → `ChatObserveHint` |
 * | `hermes-chat-subagent-control.ts` | one delegated child's steer and stop |
 *
 * Delegated children are folded by per-session ledgers
 * (`hermes-chat-subagent-ledgers.ts`) that the client owns rather than any
 * turn, because a background delegation keeps reporting after its turn ends:
 * the turn, the observation and child control all read the same set.
 *
 * Three more carry what those share: `hermes-chat-rpc.ts` (the JSON-RPC
 * transport), `hermes-chat-blocks.ts` (payloads → blocks) and
 * `hermes-chat-wire.ts` (tolerant reads). `hermes-chat-types.ts` holds the
 * shapes and constants, all of which are re-exported here.
 */
import { createCanonicalSessions } from "../../render/hermes-canonical.ts";
import { SLOT_WAIT_MS } from "./hermes-chat-types.ts";
import type { HermesChatClient, HermesChatDeps } from "./hermes-chat-types.ts";
import { createChatConnection } from "./hermes-chat-connect.ts";
import { createChatHistory } from "./hermes-chat-history.ts";
import { createBusyProbe } from "./hermes-chat-busy.ts";
import { createLiveUsage } from "./hermes-chat-live-usage.ts";
import { createChatPeer } from "./hermes-chat-peer.ts";
import { createRequestPool } from "./hermes-chat-pool.ts";
import { createChatRoster } from "./hermes-chat-roster.ts";
import { createChatObserve } from "./hermes-chat-observe.ts";
import { createChatSessions } from "./hermes-chat-sessions.ts";
import { createSubagentControl } from "./hermes-chat-subagent-control.ts";
import { createSubagentLedgers } from "./hermes-chat-subagent-ledgers.ts";
import { createChatTurn } from "./hermes-chat-turn.ts";
import { fileRequestLookup } from "./hermes-chat-file-requests.ts";
import {
  createIdleBus,
  createSessionSockets,
  disposeSessionSockets,
} from "./hermes-chat-session-socket.ts";
import { disposeChatRequestPools as disposeRequestPools } from "./hermes-chat-pool.ts";

export { CHAT_ERROR_CODES, SLOT_WAIT_MS, WARM_SLOTS_PER_GATEWAY } from "./hermes-chat-types.ts";
export type {
  BoxAddress,
  ChatFetch,
  ChatSocket,
  ChatSteerStatus,
  SubagentSteerStatus,
  HermesChatClient,
  HermesChatDeps,
  HermesChatOptions,
  HistoryOptions,
  ObserveOptions,
  SendOptions,
  TurnAttachments,
} from "./hermes-chat-types.ts";
export { createRequestPool, REQUEST_POOL_IDLE_MS } from "./hermes-chat-pool.ts";
export type { RequestPool } from "./hermes-chat-pool.ts";
export { mapSwarm } from "./hermes-chat-roster.ts";
export { mapSessions } from "./hermes-chat-sessions.ts";
export { mapHistory } from "./hermes-chat-history.ts";

/**
 * Close every socket the chat clients in this process keep open between calls:
 * Bot Mode's pooled request sockets (`hermes-chat-pool.ts`) and every
 * conversation's held session socket (`hermes-chat-session-socket.ts`). The
 * name predates the second kind; heads call it on shutdown, and a one-shot CLI
 * in its `finally`. Closing a held socket lets the gateway reap its session
 * after the grace. Safe to call twice.
 */
export function disposeChatRequestPools(): void {
  disposeRequestPools();
  disposeSessionSockets();
}

/* ── the client ───────────────────────────────────────────────────────────── */

/**
 * Wires the nine modules into one client.
 *
 * The order below is the dependency order and cannot be rearranged: everything
 * reaches a box through the connection, Bot Mode's REST transport is what
 * patches a canonical session, and history and the turn both fall back to the
 * canonical session when the caller named none.
 */
export function createHermesChat(deps: HermesChatDeps): HermesChatClient {
  const waitMs = deps.slotWaitMs ?? SLOT_WAIT_MS;
  const connection = createChatConnection({
    fetch: deps.fetch,
    openSocket: deps.openSocket,
    waitMs,
  });
  /**
   * Bot Mode's RPCs share one socket per box; every other transport keeps its
   * own (`hermes-chat-pool.ts`). `pooled: false` opts a caller out — the peer
   * then behaves exactly as it did before the pool existed.
   */
  const pool =
    deps.pooled === false
      ? undefined
      : createRequestPool({
          connect: connection.connect,
          ...(deps.poolIdleMs !== undefined ? { idleMs: deps.poolIdleMs } : {}),
        });
  const peer = createChatPeer({ connection, ...(pool !== undefined ? { pool } : {}) });
  const canonical = createCanonicalSessions({
    connect: connection.connect,
    // The read-only lookups share Bot Mode's pooled socket (one per box), so
    // reads closer together than its idle timeout — an observation on its short
    // floor, a burst of hints, a pane's reads — send a frame rather than dialling.
    request: peer.botModeRpc,
    now: deps.now,
    patch: (box, session, body, opts) =>
      peer.botModeRest(box, "PATCH", `/api/sessions/${encodeURIComponent(session)}`, body, opts),
    read: (box, session, bot, opts) =>
      peer.botModeRest(
        box,
        "GET",
        `/api/sessions/${encodeURIComponent(session)}?profile=${encodeURIComponent(bot)}`,
        undefined,
        opts,
      ),
  });
  const roster = createChatRoster({ connect: connection.connect });
  const sessions = createChatSessions({ connect: connection.connect });
  const history = createChatHistory({
    connection,
    conversation: canonical.conversation,
    ...(deps.listOutbox !== undefined ? { listOutbox: deps.listOutbox } : {}),
  });
  const subagents = createSubagentLedgers({ now: deps.now });
  // Events on a conversation's idle held socket reach the observation through
  // this bus: the gateway addresses them to that socket, not the passive one.
  const idle = createIdleBus();
  const sockets = createSessionSockets({
    connect: connection.connect,
    onIdleEvent: idle.publish,
    ...(deps.sessionTuning !== undefined ? { tuning: deps.sessionTuning } : {}),
  });
  const observation = createChatObserve({ connect: connection.connect, subagents, idle });
  const live = createLiveUsage({ rpc: peer.botModeRpc });
  const probe = createBusyProbe({ rpc: peer.botModeRpc });
  const turn = createChatTurn({
    connect: connection.connect,
    now: deps.now,
    waitMs,
    conversation: canonical.conversation,
    subagents,
    sockets,
    ...(deps.resumeTuning !== undefined ? { resumeTuning: deps.resumeTuning } : {}),
    ...(deps.listFileRequests !== undefined
      ? { fileRequests: fileRequestLookup(deps.listFileRequests, deps.now) }
      : {}),
    ...(deps.listOutbox !== undefined ? { listOutbox: deps.listOutbox } : {}),
  });
  const children = createSubagentControl({
    connect: connection.connect,
    ledgers: subagents,
    conversation: canonical.conversation,
  });
  return {
    token: connection.freshToken,
    swarm: roster.swarm,
    sessions: sessions.sessions,
    history: history.history,
    liveUsage: live.liveUsage,
    busy: probe.busy,
    send: turn.send,
    abort: turn.abort,
    steer: turn.steer,
    subagentSteer: children.steer,
    subagentInterrupt: children.interrupt,
    observe: observation.observe,
    botModeRpc: peer.botModeRpc,
    botModeRest: peer.botModeRest,
    ...canonical,
    // An archived conversation has no next turn to hold the session for, so
    // its hold ends once the archive is confirmed: the socket closes and the
    // gateway reaps the session after its grace. A refused archive leaves the
    // conversation as it was, held socket included.
    //
    // A Bot Chat may be archived by its root while the hold is keyed by its
    // tip, which only the canonical lookup knows, and which the archive no
    // longer resolves once the row is archived — so the tip is read first.
    // Every id the conversation goes by is closed; a hold on the same runtime
    // under yet another id was already folded into one of them.
    archive: async (box, bot, session, opts) => {
      // A failed lookup must not stop the archive: the ids the archive itself
      // names are still closed.
      const current = await canonical
        .conversation(box, bot, {
          session,
          ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        })
        .catch(() => null);
      const archived = await canonical.archive(box, bot, session, opts);
      for (const id of new Set([session, archived.session, current?.session]))
        if (id) sockets.close(box, bot, id);
      return archived;
    },
    // Compression keeps the gateway's runtime and moves the conversation onto a
    // new tip id (`session_compression.py`'s `_sync_session_key_after_compress`),
    // so the hold follows the tip rather than closing: closing it would let the
    // gateway reap the conversation that continues, background processes and
    // all. A failed compression moves nothing.
    compact: async (box, bot, opts = {}) => {
      const target =
        opts.session ?? (await canonical.conversation(box, bot, { signal: opts.signal }))?.session;
      const result = await canonical.compact(box, bot, opts);
      const tip = result.conversation.session;
      if (target && tip !== target) sockets.rekey(box, bot, target, tip);
      return result;
    },
    release: (box, bot, session) => sockets.close(box, bot, session),
  };
}
