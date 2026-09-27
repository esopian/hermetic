/**
 * Connection and auth: the box's dashboard session token, the cache that holds
 * it, and the socket dialled with it.
 *
 * Every other module of the adapter reaches a box through this one, which is
 * why the token cache lives here and nowhere else. Two rules it owns:
 *
 * - a *cached* token that is refused is worth one re-scrape, and a freshly
 *   scraped one that is refused is not (see `connect`);
 * - nothing built from the socket URL may reach an error message without
 *   passing `stripToken` first (see `dial`).
 */
import { checkAbort } from "../../abort.ts";
import {
  CHAT_ERROR_CODES,
  chatError,
  DIRECT_DIAL_HEADERS,
  type BoxAddress,
  type ChatFetch,
  type HermesChatDeps,
  type HermesChatOptions,
} from "./hermes-chat-types.ts";
import { readRpc, type Rpc } from "./hermes-chat-rpc.ts";
import { describe, isHermeticCode, originOf, socketUrl, stripToken } from "./hermes-chat-wire.ts";

/** `window.__HERMES_SESSION_TOKEN__="…"`, as the SPA HTML writes it. */
const TOKEN_IN_HTML = /__HERMES_SESSION_TOKEN__\s*=\s*["']([^"']+)["']/;

/** What `createChatConnection` needs, and nothing more. */
export interface ChatConnectionDeps {
  fetch: ChatFetch;
  openSocket: HermesChatDeps["openSocket"];
  /** How long to wait for a reply, resolved by the caller from `slotWaitMs`. */
  waitMs: number;
}

/** One box's reachability, shared by every module that talks to one. */
export interface ChatConnection {
  /** The injected `fetch`, so an authenticated read need not be handed two deps. */
  fetch: ChatFetch;
  /** Whether the token about to be used came from the cache rather than the box. */
  cached(box: BoxAddress): boolean;
  /** The cached token, scraping one if there is none. */
  token(box: BoxAddress, signal: AbortSignal | undefined): Promise<string>;
  /** Forget this box's token, after the box refused it. */
  invalidate(box: BoxAddress): void;
  /** A freshly scraped token, which also refreshes the cache. */
  freshToken(box: BoxAddress, opts?: HermesChatOptions): Promise<string>;
  /** An open JSON-RPC socket, retrying once if a cached token was stale. */
  connect(box: BoxAddress, signal: AbortSignal | undefined): Promise<Rpc>;
}

export function createChatConnection(deps: ChatConnectionDeps): ChatConnection {
  const waitMs = deps.waitMs;
  /**
   * One token per box, remembered until it stops working.
   *
   * Caching matters more than it looks: without it every `swarm`, `sessions`
   * and `history` call costs an extra HTML fetch, and a rail that polls a
   * thirteen-box fleet would fetch the SPA thirteen times a tick. Invalidating
   * on a refused connection matters more still — the token dies with the
   * dashboard process, so a cache with no invalidation path breaks permanently
   * the first time a box restarts.
   */
  const tokens = new Map<string, string>();

  async function scrapeToken(box: BoxAddress, signal: AbortSignal | undefined): Promise<string> {
    let res: Response;
    try {
      res = await deps.fetch(box.baseUrl, {
        method: "GET",
        headers: DIRECT_DIAL_HEADERS,
        signal: signal ?? null,
      });
    } catch (e) {
      checkAbort(signal, "chat token scrape");
      throw chatError(
        CHAT_ERROR_CODES.UNREACHABLE,
        `${box.instance}: dashboard did not answer (${describe(e)})`,
        { instance: box.instance },
      );
    }
    if (!res.ok) {
      throw chatError(
        CHAT_ERROR_CODES.UNREACHABLE,
        `${box.instance}: dashboard answered HTTP ${res.status}`,
        { instance: box.instance, status: res.status },
      );
    }
    const html = await res.text().catch(() => "");
    const found = TOKEN_IN_HTML.exec(html);
    const token = found?.[1];
    if (!token) {
      // Gated/OAuth mode does not inject the token at all, and so does a box
      // whose dashboard is still starting. Both land here, and both are the
      // same answer for the operator: this box will not take a chat request yet.
      throw chatError(
        CHAT_ERROR_CODES.NO_TOKEN,
        `${box.instance}: no session token in the dashboard page ` +
          `(gated auth mode, or the dashboard is still starting)`,
        { instance: box.instance },
      );
    }
    return token;
  }

  async function token(box: BoxAddress, signal: AbortSignal | undefined): Promise<string> {
    const cached = tokens.get(box.baseUrl);
    if (cached) return cached;
    const fresh = await scrapeToken(box, signal);
    tokens.set(box.baseUrl, fresh);
    return fresh;
  }

  /**
   * The interface's `token`: scrape now, and let the cache learn from it.
   *
   * It bypasses the cache on the way in and refreshes it on the way out, so
   * `agent desktop` both answers with a token that was valid a moment ago and
   * leaves the rail holding the same one rather than a dead entry.
   */
  async function freshToken(box: BoxAddress, opts: HermesChatOptions = {}): Promise<string> {
    const scraped = await scrapeToken(box, opts.signal);
    tokens.set(box.baseUrl, scraped);
    return scraped;
  }

  /** Opens the socket, retrying once with a freshly scraped token if the first is stale. */
  async function connect(box: BoxAddress, signal: AbortSignal | undefined): Promise<Rpc> {
    checkAbort(signal, "chat connect");
    const hadCached = tokens.has(box.baseUrl);
    try {
      return await dial(box, await token(box, signal), signal);
    } catch (e) {
      // Only a *cached* token is worth a retry. A token scraped one line ago
      // that is already refused is a box saying no for some other reason, and
      // retrying would turn one failure into two round trips and the same
      // failure.
      if (!hadCached || isHermeticCode(e, CHAT_ERROR_CODES.NO_TOKEN)) throw e;
      tokens.delete(box.baseUrl);
      checkAbort(signal, "chat connect");
      return await dial(box, await token(box, signal), signal);
    }
  }

  /**
   * Opens one socket.
   *
   * The `catch` is doing security work, not ergonomics. The session token is
   * carried in the socket's *query string*, so the URL is a live credential —
   * and the `ChatSocket` implementations that reject `opened` build their
   * message from that URL (`chat.ts`'s does: `chat socket failed: ${url}`).
   * Interpolating that message into a `HermeticError` would put the token into
   * the server's `~/.hermetic/portal.log`, into the JSON error body a head
   * returns, and into the `runs` table — three places it outlives the process it
   * belongs to. `stripToken` is therefore applied to every string that leaves
   * this function, whatever produced it, and the message names the box's origin
   * rather than the URL that was dialled.
   */
  async function dial(box: BoxAddress, tok: string, signal: AbortSignal | undefined): Promise<Rpc> {
    const socket = deps.openSocket(socketUrl(box.baseUrl, tok), {
      signal,
      headers: DIRECT_DIAL_HEADERS,
    });
    const rpc = readRpc(socket, waitMs, box.instance);
    try {
      await socket.opened;
    } catch (e) {
      rpc.close();
      throw chatError(
        CHAT_ERROR_CODES.UNREACHABLE,
        `${box.instance}: chat socket refused by ${originOf(box.baseUrl)} ` +
          `(${stripToken(describe(e), tok)})`,
        { instance: box.instance },
      );
    }
    return rpc;
  }

  const cached = (box: BoxAddress): boolean => tokens.has(box.baseUrl);

  const invalidate = (box: BoxAddress): void => {
    tokens.delete(box.baseUrl);
  };

  return { fetch: deps.fetch, cached, token, invalidate, freshToken, connect };
}
