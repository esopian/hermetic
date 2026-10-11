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
 * this file — and seven modules behind that facade, each handed an explicit deps
 * object rather than sharing one closure:
 *
 * | module | owns |
 * |---|---|
 * | `hermes-chat-connect.ts` | the session token, its cache, the socket |
 * | `hermes-chat-roster.ts` | profiles, rooms, warm processes → `Swarm` |
 * | `hermes-chat-sessions.ts` | the session registry → `Session` |
 * | `hermes-chat-history.ts` | the durable transcript → `ChatMessage` |
 * | `hermes-chat-turn.ts` | one live turn → `ChatFrame`, and its abort |
 * | `hermes-chat-peer.ts` | Bot Mode's two raw transports |
 * | `hermes-chat-observe.ts` | a socket that only listens → `ChatObserveHint` |
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
import { createChatPeer } from "./hermes-chat-peer.ts";
import { createRequestPool } from "./hermes-chat-pool.ts";
import { createChatRoster } from "./hermes-chat-roster.ts";
import { createChatObserve } from "./hermes-chat-observe.ts";
import { createChatSessions } from "./hermes-chat-sessions.ts";
import { createChatTurn } from "./hermes-chat-turn.ts";

export { CHAT_ERROR_CODES, SLOT_WAIT_MS, WARM_SLOTS_PER_GATEWAY } from "./hermes-chat-types.ts";
export type {
  BoxAddress,
  ChatFetch,
  ChatSocket,
  HermesChatClient,
  HermesChatDeps,
  HermesChatOptions,
  HistoryOptions,
  ObserveOptions,
  SendOptions,
} from "./hermes-chat-types.ts";
export {
  createRequestPool,
  disposeChatRequestPools,
  REQUEST_POOL_IDLE_MS,
} from "./hermes-chat-pool.ts";
export type { RequestPool } from "./hermes-chat-pool.ts";
export { mapSwarm } from "./hermes-chat-roster.ts";
export { mapSessions } from "./hermes-chat-sessions.ts";
export { mapHistory } from "./hermes-chat-history.ts";

/* ── the client ───────────────────────────────────────────────────────────── */

/**
 * Wires the seven modules into one client.
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
  });
  const observation = createChatObserve({ connect: connection.connect });
  const turn = createChatTurn({
    connect: connection.connect,
    now: deps.now,
    waitMs,
    conversation: canonical.conversation,
    ...(deps.resumeTuning !== undefined ? { resumeTuning: deps.resumeTuning } : {}),
  });
  return {
    token: connection.freshToken,
    swarm: roster.swarm,
    sessions: sessions.sessions,
    history: history.history,
    send: turn.send,
    abort: turn.abort,
    observe: observation.observe,
    botModeRpc: peer.botModeRpc,
    botModeRest: peer.botModeRest,
    ...canonical,
  };
}
