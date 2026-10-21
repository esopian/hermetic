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
 * work. Nothing in this file sends a JSON-RPC request on that socket — the
 * only writes on it are the ones the transport makes on its own behalf.
 *
 * ## The one exception: delegated children (§9.2)
 *
 * A background `delegate_task` ends the parent turn at once while its children
 * keep running, and nothing durable records their progress until the results
 * turn lands, so their `subagent.*` events are the one payload this stream
 * does not discard. Each goes through the session's ledger (shared with the
 * turn, `hermes-chat-subagent-ledgers.ts`) and rides its hint as the child's
 * whole block, addressed to the durable session it belongs to. Only for a
 * session a turn in this process registered under this bot and this watch's
 * conversation: an event names a runtime session and nothing else, and a
 * block shown in another conversation would be worse than none.
 *
 * Opening the stream also reconciles those ledgers against the gateway's live
 * roster (`reconcileSubagents`, on a socket of its own), because a reopened
 * stream is exactly the moment a child may have finished unheard.
 *
 * ## Events from held sockets
 *
 * A conversation's held socket (`hermes-chat-session-socket.ts`) stays attached
 * between turns, and the gateway addresses a finished background process — and
 * the turn it then starts on its own — to the sockets attached to that session,
 * not to this passive one. So those events arrive here over an in-process bus
 * (`idle`) and are merged with the socket's own. Such an event names the
 * gateway's runtime id, but the hold says which stored conversation it belongs
 * to, so it is filtered and reported by the stored id a watch is pinned to.
 */
import type { BoxAddress, ObserveOptions } from "./hermes-chat-types.ts";
import type { ChatObserveHint } from "../chat-observe.ts";
import { channel, type Rpc } from "./hermes-chat-rpc.ts";
import type { IdleEventListener, SessionHold } from "./hermes-chat-session-socket.ts";
import { isSubagentEvent } from "./hermes-chat-subagent.ts";
import { observedSubagent, type SubagentLedgers } from "./hermes-chat-subagent-ledgers.ts";
import { reconcileSubagents } from "./hermes-chat-resume.ts";
import { num, rec, str } from "./hermes-chat-wire.ts";

/** What `createChatObserve` needs, and nothing more. */
export interface ChatObserveAdapterDeps {
  /** An open JSON-RPC socket. The same one every other module reaches a box on. */
  connect(box: BoxAddress, signal: AbortSignal | undefined): Promise<Rpc>;
  /** The client's per-session subagent ledgers; absent relays hints only. */
  subagents?: SubagentLedgers | undefined;
  /** Events from this client's idle held sockets; absent reads the socket alone. */
  idle?: { subscribe(box: BoxAddress, listener: IdleEventListener): () => void } | undefined;
}

export function createChatObserve(deps: ChatObserveAdapterDeps) {
  async function* observe(
    box: BoxAddress,
    bot: string,
    opts: ObserveOptions = {},
  ): AsyncIterable<ChatObserveHint> {
    const ledgers = deps.subagents;
    const watch = { box, bot, session: opts.session, sessions: opts.sessions };
    // Both sources into one queue, because a generator can await only one of
    // them. The socket's loop ends the queue when the socket ends, which is
    // what ends this observation; the bus never does. Subscribed before the
    // dial, so an event published while it is in flight is buffered, not lost.
    const merged = channel<{ event: Record<string, unknown>; held: SessionHold | null }>();
    const unsubscribe =
      deps.idle?.subscribe(box, (hold, event) => {
        // Another bot's conversation is not this watch's, and a frame about
        // the socket rather than a session (`gateway.ready`) is nobody's.
        if (hold.bot !== bot || str(event.session_id) === null) return;
        if (!concerns(hold.stored, opts)) return;
        merged.push({ event, held: hold });
      }) ?? (() => {});
    let rpc: Rpc | null = null;
    try {
      rpc = await deps.connect(box, opts.signal);
      // Captured raw by the developer tools, under the watched conversation.
      rpc.tap?.bind(bot, opts.session ?? null, "hint");
      const socket = rpc;
      void (async () => {
        try {
          for await (const event of socket.events) merged.push({ event, held: null });
        } catch {
          // A stream that errors is a stream that ended, with a worse mood.
        } finally {
          merged.close();
        }
      })();
      if (ledgers) {
        const changed = await reconcileSubagents(
          { connect: deps.connect, ledgers },
          watch,
          opts.signal,
        );
        for (const { stored, block } of changed) yield { session: stored, subagent: block };
      }
      for await (const first of merged.drain()) {
        if (opts.signal?.aborted) return;
        // Everything buffered while the consumer was reading is one batch. A
        // streaming turn broadcasts faster than a durable read completes, and
        // each plain hint costs one read, so hint-per-event built a backlog the
        // watch drained for minutes after the turn ended. One plain hint per
        // session, after the batch's subagent blocks, wakes the same read.
        const plain = new Set<string | null>();
        for (const { event, held } of [first, ...merged.take()]) {
          // Always the runtime id: it is what the subagent ledgers are keyed by.
          const session = str(event.session_id);
          const type = str(event.type);
          if (ledgers && session && type && isSubagentEvent(type)) {
            const child = observedSubagent(ledgers, watch, {
              runtime: session,
              type,
              payload: rec(event.payload) ?? {},
              seq: num(event.seq) ?? 0,
            });
            if (child) {
              yield { session: child.stored, subagent: child.block };
              continue;
            }
          }
          // Already filtered by its stored id on the way in.
          if (held) {
            plain.add(held.stored);
            continue;
          }
          if (session !== null && !concerns(session, opts)) continue;
          plain.add(session);
        }
        for (const session of plain) yield { session };
      }
    } finally {
      unsubscribe();
      // The socket is this observation's, so it closes with it. A detached
      // observer that left one open would hold a connection to a box for the
      // rest of the portal's life.
      rpc?.close();
      merged.close();
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
