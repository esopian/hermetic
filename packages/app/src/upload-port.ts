/**
 * The loopback upload port: where the page sends a dropped or pasted file.
 *
 * A webview `File` has no path, and sending its bytes over the RPC bridge in
 * base64 chunks meant holding the whole file in this process before the box
 * saw a byte. Instead the page `fetch`es the `File` as a request body to this
 * listener and the body is piped into core's upload registry (`feed`), which
 * `files.stage`/`files.put` read as it arrives and forward to hermeticd. The
 * request is read only as fast as the box takes it, so memory stays flat and
 * no file is too big for the page.
 *
 * Bound to 127.0.0.1 on a port the OS picks, started on the first upload. A
 * route exists only for an upload id `files.upload.open` handed out (an
 * unguessable `up_<uuid>`), takes one body, and is gone. CORS is open — the
 * page's origin is not `127.0.0.1` — because the id is the credential, and the
 * `Host` check keeps a rebinding page from reaching the port by another name.
 */
import { HermeticError } from "@hermetic/core";

export type UploadFeed = (body: ReadableStream<Uint8Array> | null) => Promise<void>;

export interface UploadPort {
  /** The URL the page PUTs `upload_id`'s bytes to; starts the listener on first use. */
  url(upload_id: string, feed: UploadFeed): string;
  /** Revoke a URL when its upload is discarded before the PUT arrives. */
  forget(upload_id: string): void;
  stop(): void;
}

const ROUTE = /^\/upload\/(up_[0-9a-f-]{36})$/;
/** A route nobody used in this long is forgotten. */
const ROUTE_TTL_MS = 2 * 60 * 60 * 1000;
/** Bun's default (128 MB) is below a big file; the fleet's cap is what bounds an upload. */
const MAX_BODY = 64 * 1024 * 1024 * 1024;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "PUT, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-allow-private-network": "true",
  "access-control-max-age": "600",
} as const;

function reply(status: number, body?: { code: string; message: string }): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { ...CORS, ...(body ? { "content-type": "application/json" } : {}) },
  });
}

function statusOf(e: unknown): number {
  if (!(e instanceof HermeticError)) return 500;
  switch (e.code) {
    case "VALIDATION":
      return 400;
    case "NOT_FOUND":
      return 404;
    default:
      return 409;
  }
}

export function createUploadPort(opts: { routeTtlMs?: number } = {}): UploadPort {
  const routes = new Map<string, { feed: UploadFeed; timer: ReturnType<typeof setTimeout> }>();
  let server: ReturnType<typeof Bun.serve> | null = null;

  const forget = (id: string): void => {
    const route = routes.get(id);
    if (route === undefined) return;
    clearTimeout(route.timer);
    routes.delete(id);
  };

  const start = (): ReturnType<typeof Bun.serve> => {
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      maxRequestBodySize: MAX_BODY,
      async fetch(req) {
        const host = req.headers.get("host") ?? "";
        if (host !== `127.0.0.1:${listener.port}` && host !== `localhost:${listener.port}`) {
          return reply(403, { code: "FORBIDDEN", message: "not the upload port's address" });
        }
        if (req.method === "OPTIONS") return reply(204);
        const id = ROUTE.exec(new URL(req.url).pathname)?.[1];
        const route = req.method === "PUT" && id !== undefined ? routes.get(id) : undefined;
        if (id === undefined || route === undefined) {
          return reply(404, { code: "NOT_FOUND", message: "no such upload" });
        }
        forget(id);
        try {
          await route.feed(req.body);
          return reply(200, { code: "OK", message: "received" });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return reply(statusOf(e), {
            code: e instanceof HermeticError ? e.code : "INTERNAL",
            message,
          });
        }
      },
    });
    return listener;
  };

  return {
    url(upload_id, feed) {
      server ??= start();
      forget(upload_id);
      const timer = setTimeout(() => forget(upload_id), opts.routeTtlMs ?? ROUTE_TTL_MS);
      timer.unref?.();
      routes.set(upload_id, { feed, timer });
      return `http://127.0.0.1:${server.port}/upload/${upload_id}`;
    },
    forget,
    stop() {
      void server?.stop(true);
      server = null;
      for (const id of routes.keys()) forget(id);
    },
  };
}

/** This process's one port; `files.upload.open` hands the page a URL on it. */
export const uploadPort: UploadPort = createUploadPort();
