/**
 * The runtime's own chat transport: the adapter as `hermetic.ts` wires it, over
 * the runtime's `fetch` and `WebSocket`, and the fixture client that stands in
 * for it. Nothing here opens anything until a chat is sent.
 */
import { createHermesChat } from "./hermes/hermes-chat.ts";
import type { ChatFetch, ChatSocket, HermesChatClient } from "./hermes/hermes-chat.ts";

/* ── the runtime's own transport ──────────────────────────────────────────── */

/**
 * The adapter as `hermetic.ts` wires it: the runtime's `fetch` and its
 * `WebSocket`, and a clock.
 *
 * The adapter takes both as injected dependencies so that every test — the
 * adapter's own, this module's, and the fixture backend's — can drive it with a
 * double and never reach a network. Something still has to hand it the real
 * ones exactly once, and this is that place, kept beside the only caller rather
 * than inside the adapter where a test could pick it up by accident.
 *
 * Nothing here opens anything. It builds closures, so `openHermetic` costs the
 * same whether or not a chat is ever sent — including in fixture mode, which
 * must not construct a live client of any kind.
 */
export function defaultHermesChat(now: () => string): HermesChatClient {
  const http: ChatFetch = (input, init) => fetch(input, init);
  return createHermesChat({
    fetch: http,
    openSocket: runtimeSocket,
    now,
  });
}

/**
 * The chat client fixture mode gets: canned transcripts, and no transport at
 * all.
 *
 * It is a re-export rather than an implementation because it is *data* —
 * `backend/fixture-chat.ts` sits beside the other fixture tables for the same
 * reason `fixture-agents.ts` and `fixture-notifications.ts` do — but the reason
 * fixture mode has its own client at all belongs here, next to the live one it
 * stands in for. Fixture mode must not construct a live client of any kind, and
 * "no AWS" is not the whole of that rule: a seeded fleet's agents have tailnet
 * names that resolve to nothing, so a roster read on the real client would
 * spend a DNS timeout per box, and a test suite would reach the network to find
 * that out.
 *
 * Every read answers rather than throwing, and a turn against one of the boxes
 * the fixture marks unreachable answers with an error frame rather than a hang.
 * The name is kept — `hermetic.ts` wires it and every head names it — because
 * what changed is what it answers with, not what it is.
 */
export { fixtureChatClient as fixtureHermesChat } from "../backend/fixture/fixture-chat.ts";

/**
 * A `ChatSocket` over the runtime's `WebSocket`.
 *
 * The queue in the middle is the whole of it: frames arrive on an event handler
 * and are consumed by an `for await`, and those two run at different speeds. A
 * consumer that is slower than the box must not lose frames — a dropped `delta`
 * is a hole in the middle of a sentence the operator is reading — so arrivals
 * are buffered rather than dropped, and a consumer waiting on an empty queue
 * parks on a promise rather than spinning.
 */
function runtimeSocket(
  url: string,
  opts: { signal?: AbortSignal | undefined; headers?: Record<string, string> | undefined },
): ChatSocket {
  /**
   * Bun's `WebSocket` takes headers where the browser's does not, and the
   * adapter's contract is that an implementation which *can* send them must:
   * the box's dashboard has a rebinding guard that admits only the Host it
   * published, and a direct dial has to say so.
   *
   * The cast is a gap in the *types*, not in the behaviour — the DOM lib types
   * the second argument as `protocols`, and Bun reads an options object there.
   * Dropping the headers to satisfy the type would be trading a compile-time
   * complaint for a runtime refusal from the box.
   */
  const socket = new WebSocket(url, { headers: opts.headers ?? {} } as unknown as string[]);
  const buffered: string[] = [];
  /** Set while a consumer is parked on an empty queue; called on the next arrival. */
  let wake: (() => void) | null = null;
  let closed = false;

  const bump = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    // A plain `Error`: classifying a transport failure is the adapter's job, and
    // it is the only module that knows which of them mean what.
    socket.addEventListener("error", () => reject(new Error(`chat socket failed: ${url}`)), {
      once: true,
    });
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    buffered.push(typeof event.data === "string" ? event.data : String(event.data));
    bump();
  });
  socket.addEventListener("close", () => {
    closed = true;
    bump();
  });

  const close = (): void => {
    closed = true;
    try {
      socket.close();
    } catch {
      // A socket that never opened has nothing to close, and saying so is not
      // this layer's job: the consumer already learns it from `opened`.
    }
    bump();
  };

  // The caller's abort is the socket's too. Without this an aborted turn would
  // leave the box streaming into a buffer nobody reads until it times out.
  //
  // This is also the one link the hint-stream cancellation in
  // `chat-observe.ts` (`run()`'s `childAbort`) rests on: `child.abort()` on
  // its `signal` reaches this listener, which calls `close()`, which ends
  // `frames` above, which unwinds `readRpc`'s `finally` (`hermes-chat-rpc.ts`)
  // into `events.close()` and `channel.drain()`, through the adapter and
  // finally `rpc.close()`. `drain()` never inspects the signal itself — it is
  // signal-blind by design — so this listener is the only place that signal
  // turns into a closed socket.
  opts.signal?.addEventListener("abort", close, { once: true });

  return {
    send: (data: string) => socket.send(data),
    close,
    opened,
    frames: (async function* () {
      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })(),
  };
}
