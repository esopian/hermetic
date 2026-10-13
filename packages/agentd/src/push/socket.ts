/**
 * A `ChatSocket` over Bun's `WebSocket`, for the gateway watcher's chat client.
 *
 * Copied from `runtimeSocket` in `packages/core/src/chat/chat-transport.ts`,
 * which agentd may not import (that module also wires the laptop's live client
 * and the fixture backend). The adapter itself — `createHermesChat` — comes
 * through `@hermetic/core/chat-client`, which brings no transport of its own,
 * so each runtime hands it one; this is the box's. Keep the two in step: the
 * contract is `ChatSocket` in `hermes-chat-types.ts`.
 *
 * The queue in the middle is the whole of it: frames arrive on an event handler
 * and are consumed by a `for await`, at different speeds, so arrivals are
 * buffered rather than dropped and a consumer waiting on an empty queue parks
 * on a promise rather than spinning.
 */
import type { ChatSocket } from "@hermetic/core/chat-client";

export function bunChatSocket(
  url: string,
  opts: { signal?: AbortSignal | undefined; headers?: Record<string, string> | undefined },
): ChatSocket {
  /**
   * Bun's `WebSocket` takes headers where the browser's does not, and the
   * adapter's contract is that an implementation which can send them must: the
   * dashboard's gate checks `Origin` (`DIRECT_DIAL_HEADERS`). The cast is a gap
   * in the DOM *types*, which call the second argument `protocols`.
   */
  const socket = new WebSocket(url, { headers: opts.headers ?? {} } as unknown as string[]);
  const buffered: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  const bump = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`chat socket failed: ${url}`)), {
      once: true,
    });
  });
  // An unawaited rejection here would be an unhandled one; the adapter awaits
  // `opened` itself whenever it cares.
  opened.catch(() => undefined);

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
      // A socket that never opened has nothing to close.
    }
    bump();
  };

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
