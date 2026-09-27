/**
 * The adapter's live *hint* stream: a socket that listens and never speaks.
 *
 * `hermes-chat-turn.ts` owns a turn, which is a socket opened around one
 * `prompt.submit`. This module owns the other kind of socket — one opened
 * around nothing. It connects, reads the gateway's `event` notifications and
 * reports, for each of them, only that *something happened*. It never maps a
 * payload onto a block, never mints a message and never returns a transcript.
 *
 * ## Why a hint rather than a message
 *
 * Upstream owns the transcript. An event that arrives on a socket this laptop
 * did not drive is not evidence the box's durable history says the same thing —
 * the gateway broadcasts progress, and what is finally written down is decided
 * elsewhere and later. So the hint's whole job is to make
 * `chat-observe.ts`'s next authoritative read happen now instead of at the next
 * poll. Getting a hint wrong therefore costs one extra durable read; getting a
 * *message* wrong would cost a transcript that disagrees with the box.
 *
 * That also means this module does not have to be right about what a gateway
 * broadcasts. A build of Hermes that fans out every profile's events produces a
 * few redundant reads; one that fans out none leaves the observation service on
 * its poll floor, which is a complete design rather than a degraded one.
 *
 * ## Passivity
 *
 * `connect` opens a socket and scrapes a session token. It does not call
 * `session.create`, `session.resume` or `prompt.submit`, so it allocates no
 * session, occupies none of the gateway's ~3 warm backend slots and starts no
 * work. Nothing in this file sends a JSON-RPC request at all — the only writes
 * on this socket are the ones the transport makes on its own behalf.
 */
import type { BoxAddress, ObserveOptions } from "./hermes-chat-types.ts";
import type { ChatObserveHint } from "../chat-observe.ts";
import type { Rpc } from "./hermes-chat-rpc.ts";
import { str } from "./hermes-chat-wire.ts";

/** What `createChatObserve` needs, and nothing more. */
export interface ChatObserveAdapterDeps {
  /** An open JSON-RPC socket. The same one every other module reaches a box on. */
  connect(box: BoxAddress, signal: AbortSignal | undefined): Promise<Rpc>;
}

export function createChatObserve(deps: ChatObserveAdapterDeps) {
  async function* observe(
    box: BoxAddress,
    _bot: string,
    opts: ObserveOptions = {},
  ): AsyncIterable<ChatObserveHint> {
    const rpc = await deps.connect(box, opts.signal);
    try {
      for await (const event of rpc.events) {
        if (opts.signal?.aborted) return;
        const session = str(event.session_id);
        if (session !== null && !concerns(session, opts)) continue;
        yield { session };
      }
    } finally {
      // The socket is this observation's, so it closes with it. A detached
      // observer that left one open would hold a connection to a box for the
      // rest of the portal's life.
      rpc.close();
    }
  }
  return { observe };
}

/**
 * Is an event about the conversation this watch was opened for?
 *
 * A watch that named no session takes everything: it is the canonical one, and
 * over-reading costs one durable read. A watch pinned to a session takes that
 * session and whatever the caller currently answers for — which is how a
 * compression survives. Upstream's `session.compress` writes the continuation
 * under a new id and broadcasts under that id, so comparing against the pinned
 * id alone made every hint after the first compression look like somebody
 * else's conversation, and the watch fell back to the five-second poll without
 * ever saying so.
 */
function concerns(session: string, opts: ObserveOptions): boolean {
  if (opts.session === undefined || session === opts.session) return true;
  return opts.sessions?.().includes(session) === true;
}
