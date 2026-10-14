/**
 * The files routes on the tailnet listener (port 7434), behind the same
 * `whois` gate as every other RPC (`rpc.ts`): only an untagged tailnet member
 * reaches this function, and it arrives with that member's identity — and,
 * when the fleet requires it, must carry the files capability (`lacksFilesCap`).
 *
 * Each route answers JSON — a result, or a `FilesErrorBody` at the status its
 * code names (`errors.ts`) — except `content`, which streams the file.
 */
import { FilesCommitBody, FilesDeclineBody, FilesSecretBody } from "@hermetic/core/schema";
import { FILES_APP_CAP, type FilesRoute } from "@hermetic/core/shared";
import { type Caller, type FilesCtx, auditFiles } from "./context.ts";
import { deleteEntry, entryContent, getEntry, listFiles } from "./entries.ts";
import { FilesError, filesErrorResponse, jsonResponse, toFilesResponse } from "./errors.ts";
import { commitStaged, fulfilFromSecret, fulfilRequest, stageUpload } from "./receive.ts";
import { declineRequest, getRequest, listRequests } from "./requests.ts";
import { MeteredBody } from "./upload.ts";

/** The slice of a Zod schema `jsonBody` uses — structural, so agentd needs no `zod` dependency of its own. */
export interface BodySchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> };
      };
}

/** A small JSON body: the commit, decline and secret routes. Never a file. */
const JSON_BODY_MAX = 64 * 1024;

/**
 * Parse a JSON body against `schema`. An empty body is `{}` when `optional`
 * (a bare `POST …/commit` or `…/decline` is fine); anything unreadable is 400.
 *
 * The size is settled before a byte is read: a body needs a `Content-Length`
 * (411 without one, unless there is no body at all) of at most
 * `JSON_BODY_MAX` (413). A chunked body of unknown length would otherwise be
 * buffered whole by `text()` before anything could refuse it.
 *
 * Read through the upload's meter (`MeteredBody`), so the read has the same
 * bounds an upload has: cut off past its `Content-Length`, and 408 after
 * `idleMs` without a byte — the listeners have no idle timeout of their own.
 */
export async function jsonBody<T>(
  request: Request,
  schema: BodySchema<T>,
  optional = false,
  idleMs?: number,
): Promise<T> {
  const header = request.headers.get("content-length");
  if (header === null) {
    if (request.body !== null) {
      throw new FilesError("VALIDATION", "Content-Length is required on a JSON body", 411);
    }
  } else if (!/^\d{1,15}$/.test(header.trim())) {
    throw new FilesError("VALIDATION", "Content-Length is not a number", 400);
  } else if (Number(header.trim()) > JSON_BODY_MAX) {
    throw new FilesError("VALIDATION", "the request body is too large", 413);
  }
  const text = header === null ? "" : await boundedText(request, Number(header.trim()), idleMs);
  let raw: unknown = {};
  if (text.trim() !== "") {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new FilesError("VALIDATION", "the request body is not JSON");
    }
  } else if (!optional) {
    throw new FilesError("VALIDATION", "a JSON body is required");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FilesError(
      "VALIDATION",
      `invalid body${issue ? `: ${issue.path.map(String).join(".") || "(root)"} ${issue.message}` : ""}`,
    );
  }
  return parsed.data;
}

/** The body as text, read under `MeteredBody`'s bounds, exactly `declared` bytes long. */
async function boundedText(request: Request, declared: number, idleMs?: number): Promise<string> {
  const body = new MeteredBody(request.body, declared, idleMs !== undefined ? { idleMs } : {});
  let bytes: Uint8Array;
  try {
    bytes = await body.collect();
  } catch (e) {
    await body.discard();
    if (e instanceof FilesError && e.code === "FILE_TOO_LARGE") {
      throw new FilesError("VALIDATION", "the request body is longer than its Content-Length", 413);
    }
    throw e;
  }
  if (bytes.byteLength !== declared) {
    throw new FilesError("VALIDATION", "the request body is shorter than its Content-Length");
  }
  return new TextDecoder().decode(bytes);
}

export type FilesTailnetHandler = (
  request: Request,
  route: FilesRoute,
  caller: Caller,
) => Promise<Response>;

/**
 * The fleet's `files.require_cap` (`settings.ts`): with it on, an untagged
 * member reaches the files routes only if the tailnet policy grants it
 * `FILES_APP_CAP` on this node, as `whois` reports it. Off, any untagged
 * member does. A tagged caller never gets this far (`rpc.ts`).
 */
function lacksFilesCap(ctx: FilesCtx, caller: Caller): boolean {
  return ctx.settings().require_cap && !(caller.caps ?? []).includes(FILES_APP_CAP);
}

export function makeFilesTailnetHandler(ctx: FilesCtx): FilesTailnetHandler {
  return async (request, route, caller) => {
    if (lacksFilesCap(ctx, caller)) {
      ctx.log(`files ${route.route} refused: login=${caller.login || "-"} lacks ${FILES_APP_CAP}`);
      return filesErrorResponse(
        new FilesError(
          "FORBIDDEN",
          `this fleet requires the ${FILES_APP_CAP} capability in the tailnet policy for the files routes`,
        ),
      );
    }
    try {
      switch (route.route) {
        case "stage":
          return jsonResponse(await stageUpload(ctx, request, route.name, caller), 201);
        case "commit": {
          const body = await jsonBody(request, FilesCommitBody, true, ctx.uploadIdleMs);
          return jsonResponse(await commitStaged(ctx, route.id, body, caller));
        }
        case "requests":
          return jsonResponse({ requests: await listRequests(ctx) });
        case "request":
          return jsonResponse(await getRequest(ctx, route.id));
        case "fulfil":
          return jsonResponse(await fulfilRequest(ctx, request, route.id, caller));
        case "requestSecret": {
          const body = await jsonBody(request, FilesSecretBody, false, ctx.uploadIdleMs);
          return jsonResponse(await fulfilFromSecret(ctx, route.id, body, caller));
        }
        case "requestDecline": {
          const body = await jsonBody(request, FilesDeclineBody, true, ctx.uploadIdleMs);
          const declined = await declineRequest(ctx, route.id, body.reason);
          auditFiles(ctx, "decline", { id: route.id, login: caller.login });
          return jsonResponse(declined);
        }
        case "list":
          return jsonResponse(await listFiles(ctx));
        case "entry":
          return jsonResponse(getEntry(ctx, route.id));
        case "delete":
          await deleteEntry(ctx, route.id, caller);
          return new Response(null, { status: 204 });
        case "content":
          return await entryContent(ctx, route.id);
      }
    } catch (e) {
      return toFilesResponse(e, ctx.log, route.route);
    }
  };
}
