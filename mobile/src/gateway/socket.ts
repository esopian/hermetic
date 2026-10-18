/**
 * React Native's `WebSocket` as core's `ChatSocket`: an `opened` promise, the
 * text frames as an async iterable, `send` and `close`.
 *
 * The queue in the middle is the point, as in desktop's `runtimeSocket`
 * (`packages/core/src/chat/chat-transport.ts`): frames arrive on an event
 * handler and are consumed by a `for await`, at different speeds, so arrivals
 * are buffered rather than dropped. A dropped `delta` is a hole in a sentence.
 *
 * Headers go in React Native's third constructor argument (`{ headers }`); the
 * adapter passes `DIRECT_DIAL_HEADERS` (`Origin`). iOS's `NSURLSession` may
 * ignore or rewrite a custom `Origin` on a WebSocket upgrade. That is fine:
 * the dial goes through Tailscale Serve, whose nginx supplies what the
 * dashboard's gate checks, and the `?token=` in the URL is what authenticates.
 *
 * The constructor is injected, so the root e2e test can hand in Bun's
 * `WebSocket`. Nothing here imports React Native.
 */
import type { ChatSocket } from "@hermetic/core/chat-client";

/** The slice of a WebSocket instance this wrapper uses (RN's and Bun's both fit). */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "error" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

/** React Native's constructor shape: `new WebSocket(url, protocols, { headers })`. */
export type WebSocketCtor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocketLike;

export type OpenSocket = (
  url: string,
  opts: { signal?: AbortSignal | undefined; headers?: Record<string, string> | undefined },
) => ChatSocket;

/** A `ChatSocket` factory over `Ctor` (the global `WebSocket` in the app). */
export function createSocketOpener(Ctor: WebSocketCtor): OpenSocket {
  return (url, opts) => {
    // No subprotocol: `undefined`, not `null` (a browser-style WebSocket would send "null").
    const socket = new Ctor(url, undefined, { headers: opts.headers ?? {} });
    const buffered: string[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const bump = (): void => {
      const resume = wake;
      wake = null;
      resume?.();
    };

    const opened = new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.addEventListener("open", () => {
        settled = true;
        resolve();
      });
      // A plain `Error`, with no URL in it: the URL carries the session token.
      // Classifying the failure is the adapter's job.
      socket.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        reject(new Error("chat socket failed"));
      });
      socket.addEventListener("close", () => {
        if (settled) return;
        settled = true;
        reject(new Error("chat socket closed before it opened"));
      });
    });
    // Nobody may be awaiting `opened` when it rejects (the adapter reads it once).
    opened.catch(() => {});

    socket.addEventListener("message", (event) => {
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
    // The caller's abort is the socket's too, or an aborted turn would leave the
    // box streaming into a buffer nobody reads.
    if (opts.signal?.aborted) close();
    else opts.signal?.addEventListener("abort", close, { once: true });

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
  };
}
