/**
 * The plugin socket, `FILES_SOCKET_PATH`: how the Hermes plugin on this box
 * opens a request slot, long-polls it, consumes what arrived, lists files, and
 * shares one of its own files with the operator (`POST /outbox`, `outbox.ts`).
 * It never accepts upload bytes, so the agent cannot fulfil its own request.
 *
 * **Access is filesystem-gated, deliberately.** The plan called for
 * `SO_PEERCRED` (peer uid = hermes), and Bun's `serve({ unix })` exposes no
 * peer credentials. So the socket file itself is the gate: it is created by
 * root, `chown root:hermes`, mode 0660, inside the 0711 `/run/hermetic` — only
 * root and members of group `hermes` can `connect(2)` to it, which on this box
 * is the agent's own account. The bind itself happens under umask 0177, so
 * the socket is born 0600 (root only) and only the chmod opens it to the
 * group — there is no window in which anyone else can connect, whatever umask
 * the process was started with.
 */
import type { FileEntry, FileRequest, FilesHello } from "@hermetic/core/schema";
import { OpenFileRequestBody, OpenSecretRequestBody, ShareFileBody } from "@hermetic/core/schema";
import { FILES_SOCKET_PATH, HERMES_ACCOUNT, matchSocketRoute } from "@hermetic/core/shared";
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { type FilesCtx, waitResult } from "./context.ts";
import { consumeRequest, isSecret, listFiles } from "./entries.ts";
import { FilesError, filesErrorResponse, jsonResponse, toFilesResponse } from "./errors.ts";
import { shareFile } from "./outbox.ts";
import { getRequest, openRequest, waitForRequest } from "./requests.ts";
import { type BodySchema, jsonBody } from "./routes.ts";

/** The socket protocol the plugin handshakes against in `GET /hello`. */
export const FILES_SOCKET_PROTOCOL = 1;

export type FilesSocketHandler = (request: Request) => Promise<Response>;

/**
 * `POST /requests`'s body: `request_secret`'s when it says `kind:
 * "secret_text"`, `request_file`'s otherwise — a body without `kind` is the
 * Phase 1 plugin's, and stays a file request.
 */
const OpenRequestBody: BodySchema<OpenFileRequestBody | OpenSecretRequestBody> = {
  safeParse(value) {
    const kind =
      typeof value === "object" && value !== null ? (value as { kind?: unknown }).kind : undefined;
    return kind === "secret_text"
      ? OpenSecretRequestBody.safeParse(value)
      : OpenFileRequestBody.safeParse(value);
  },
};

/** A slot whose answer is a secret: a text secret, a secret-sensitivity slot, or a file the box filed as one. */
function isSecretRequest(request: FileRequest): boolean {
  return (
    request.kind === "secret_text" ||
    request.sensitivity === "secret" ||
    request.fulfilled?.class === "secret"
  );
}

/**
 * A slot as the socket shows it to the agent. A secret slot (text or file)
 * loses its fulfilled `sha256` and `bytes`, as its wait result does
 * (`waitResult`): a short secret's SHA-256 is a dictionary lookup away from
 * its value, and whatever the agent reads can land in the transcript. The
 * tailnet routes, which only the operator reaches, keep both.
 *
 * The socket's shape is intentionally narrower than core's `FileRequest` and
 * `FileEntry` (which require both fields); only the plugin reads it, as plain JSON.
 */
function forAgent(request: FileRequest): FileRequest {
  if (!request.fulfilled || !isSecretRequest(request)) return request;
  const { sha256: _sha256, bytes: _bytes, ...fulfilled } = request.fulfilled;
  return { ...request, fulfilled: fulfilled as FileRequest["fulfilled"] };
}

/** A listed entry as the agent sees it: a secret-class one without its digest and size (`forAgent`). */
function entryForAgent(entry: FileEntry): FileEntry {
  if (!isSecret(entry)) return entry;
  const { sha256: _sha256, bytes: _bytes, ...rest } = entry;
  return rest as FileEntry;
}

/** The socket's `(Request) → Response`, pure so a test can drive it without a socket. */
export function makeFilesSocketHandler(ctx: FilesCtx): FilesSocketHandler {
  return async (request) => {
    const url = new URL(request.url);
    const route = matchSocketRoute(request.method, `${url.pathname}${url.search}`);
    if (route === null) {
      return filesErrorResponse(
        new FilesError("NOT_FOUND", `no such route: ${request.method} ${url.pathname}`),
      );
    }
    try {
      switch (route.route) {
        case "hello": {
          const hello: FilesHello = {
            hermeticd_version: ctx.hermeticdVersion,
            protocol: FILES_SOCKET_PROTOCOL,
          };
          return jsonResponse(hello);
        }
        case "openRequest": {
          const body = await jsonBody(request, OpenRequestBody, false, ctx.uploadIdleMs);
          const opened = await openRequest(ctx, body);
          const result =
            body.wait_s && body.wait_s > 0
              ? await waitForRequest(ctx, opened.request_id, body.wait_s, request.signal)
              : waitResult(ctx.name, opened);
          return jsonResponse(result, 201);
        }
        case "request":
          return jsonResponse(forAgent(await getRequest(ctx, route.id)));
        case "wait":
          return jsonResponse(await waitForRequest(ctx, route.id, route.s, request.signal));
        case "consume":
          return jsonResponse(await consumeRequest(ctx, route.id));
        case "outbox": {
          const body = await jsonBody(request, ShareFileBody, false, ctx.uploadIdleMs);
          return jsonResponse(await shareFile(ctx, body, request.signal), 201);
        }
        case "files": {
          const listed = await listFiles(ctx);
          return jsonResponse({
            ...listed,
            inbox: listed.inbox.map(entryForAgent),
            outbox: listed.outbox.map(entryForAgent),
            secrets: listed.secrets.map(entryForAgent),
            requests: listed.requests.map(forAgent),
          });
        }
      }
    } catch (e) {
      return toFilesResponse(e, ctx.log, `socket ${route.route}`);
    }
  };
}

/** Starts listening on a unix socket; `Bun.serve` in the service, a recorder in tests. */
export type UnixListen = (path: string, fetch: FilesSocketHandler) => { stop(): void };

export const bunUnixListen: UnixListen = (path, fetch) => {
  /**
   * `idleTimeout: 0` because a long-poll holds the connection for up to
   * `FILES_TTL.waitMax` seconds of silence, and Bun's default (10 s) cuts
   * every one. Bun's types leave `idleTimeout` off the unix-socket overload,
   * but the runtime honours it (Bun 1.3.10: a 13 s handler is cut at 10 s
   * without it and answers with it), hence the widening cast.
   */
  const options = { unix: path, idleTimeout: 0, fetch: (request: Request) => fetch(request) };
  const server = Bun.serve(options as unknown as Parameters<typeof Bun.serve>[0]);
  return { stop: () => void server.stop(true) };
};

/** The umask the socket is bound under: born 0600. */
export const FILES_SOCKET_UMASK = 0o177;

/**
 * Bind the socket: set its directory to 0711 (`mkdir` keeps an existing mode,
 * and a box hot-updated from before files may have it 0700, which would lock
 * the account out), remove a stale socket (a previous process's, which would
 * make the bind fail), listen under `FILES_SOCKET_UMASK`, then
 * `chown root:hermes` and `chmod 0660` — see the module header for why that is
 * the access control.
 */
export async function serveFilesSocket(
  host: Host,
  handler: FilesSocketHandler,
  listen: UnixListen = bunUnixListen,
  path: string = FILES_SOCKET_PATH,
): Promise<{ stop(): void }> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await host.mkdir(dir, "0711");
  await host.chmod(dir, "0711");
  await host.remove(path);
  // Synchronous between the two umask calls: nothing else in this process
  // creates a file under the narrowed umask.
  const previous = process.umask(FILES_SOCKET_UMASK);
  let server: { stop(): void };
  try {
    server = listen(path, handler);
  } finally {
    process.umask(previous);
  }
  try {
    await must(host, ["chown", `root:${HERMES_ACCOUNT}`, path]);
    await host.chmod(path, "0660");
  } catch (e) {
    server.stop();
    throw e;
  }
  return server;
}
