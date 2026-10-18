/**
 * The main-process half of the bridge: `HermeticRPC` bound to one window (plan
 * 0012, Phase 4a).
 *
 * One binding per window, and everything it holds is that window's: the
 * requests it answers, the frames it pushes, and the streams it opened. A
 * window going away closes those streams and nothing else — which is why
 * `close()` exists and why `ctx.streams` is per binding rather than per process.
 *
 * Everything Electrobun is injected. `defineRPC` and `send` arrive as functions,
 * so this module never imports `electrobun/bun` — the npm package's every
 * export throws, the real one comes from a devkit that is not on most
 * checkouts, and a bridge that can only be exercised inside a built `.app` is a
 * bridge with no tests. `main/index.ts` is the one file that passes the real
 * ones.
 */
import { classifyFailure } from "../errors.ts";
import type { HandlerContext } from "../handlers/ctx.ts";
import { dispatch } from "../handlers/dispatch.ts";
import { KEEPALIVE_EVENT } from "../handlers/streams.ts";
import type { StreamFrame, StreamSink } from "../handlers/streams.ts";
import { terminalMessageHandlers } from "../handlers/terminal.ts";
import type { TerminalFrame } from "../terminal/channel.ts";
import type { FilesGetFrame, FilesPutFrame, FilesStageFrame } from "@hermetic/core";
import { InitInFlightError } from "../init-op.ts";
import type { AppLog } from "../log.ts";
import { RequestValidationError } from "../validation.ts";
import {
  MESSAGE_FOR_REQUEST,
  REQUEST_NAMES,
  type StreamMessageName,
  type WebviewMessages,
} from "./schema.ts";

/** Pushing one `webview.messages` entry at the page this binding belongs to. */
export type SendMessage = <K extends keyof WebviewMessages>(
  name: K,
  payload: WebviewMessages[K],
) => void;

/**
 * What `BrowserView.defineRPC` takes, declared structurally for the same reason
 * nothing here imports it: `never` in the parameter position is the devkit's
 * own signature, and it is what makes a table of `(params: unknown) => …`
 * assignable.
 */
export interface RpcOptions {
  maxRequestTime?: number;
  handlers: {
    requests: Record<string, (params: never) => unknown>;
    messages?: Record<string, (payload: never) => unknown>;
  };
}

export interface RpcBindingDeps<Rpc> {
  /** `BrowserView.defineRPC`, or a fake. Called once, synchronously. */
  defineRPC: (options: RpcOptions) => Rpc;
  send: SendMessage;
  /** This window's context. Its `streams` registry is dropped by `close()`. */
  ctx: HandlerContext;
  log?: AppLog;
  /**
   * Names this window to the terminal host, which keys `terminal.view` by it
   * (two windows can show one session). Minted here when absent.
   */
  windowKey?: string;
}

/** Window keys for bindings that were not given one. */
let nextWindow = 0;

export interface RpcBinding<Rpc> {
  /** Whatever `defineRPC` returned, for the `BrowserWindow` that wants it. */
  rpc: Rpc;
  /**
   * The window has gone. Every stream it opened is closed — a tail nobody can
   * read, a poller listener nobody is attached to and an observation nobody
   * joined all stop here rather than running for the life of the process.
   */
  close(): void;
}

/** What a refusal looks like on the wire: a code and a sentence, never a stack. */
export interface RpcErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  /** `init`'s in-flight refusal names the op that holds the slot (`init-op.ts`). */
  op_id?: string | null;
}

/**
 * A refusal, as the page receives it.
 *
 * An `Error` because that is what a promise rejection travelling over an RPC
 * layer is expected to be, and with `stack` cleared because the page is not
 * entitled to one: a stack names this machine's paths, and the operator gets
 * the real thing in the log (`errors.ts` makes the same distinction for HTTP).
 *
 * **Flat, and that is the contract.** The page reads `code`, `message`,
 * `op_id` and `details` as own top-level properties — `asFailure` in
 * `packages/ui/src/api/transport-rpc.ts` gives up and reports `RPC_FAILED` the
 * moment `reason["code"]` is not a string — so every one of them is set here
 * as its own property rather than only inside a body object. That is not a
 * detail of presentation: `NOT_INITIALIZED`, `FLEET_MISMATCH`, `NAME_TAKEN`
 * and `INIT_IN_FLIGHT` are each a branch some component takes, and a refusal
 * that arrives without its code silently loses all four.
 *
 * `body` is kept alongside for the callers that already read it, and because
 * it is the same `{code, message, details}` the HTTP head puts under `error`.
 * `tests/rpc-refusal.test.ts` is what holds the flat half honest: it takes a
 * refusal this module actually threw and runs it through the UI's own failure
 * conversion, which is the only place the two shapes meet.
 */
export class RpcRefusal extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  /** `init`'s in-flight refusal names the op that holds the slot; null when it has none yet. */
  readonly op_id?: string | null;
  readonly body: RpcErrorBody;

  constructor(body: RpcErrorBody) {
    super(body.message);
    this.name = "RpcRefusal";
    this.code = body.code;
    if (body.details !== undefined) this.details = body.details;
    if (body.op_id !== undefined) this.op_id = body.op_id;
    this.body = body;
    this.stack = undefined;
  }
}

/**
 * Whatever a handler threw, as a refusal — the same three cases `app.ts`'s
 * `onError` makes, minus the status codes, because there is no response to give
 * one to. Returns the line to log as well, set exactly when the page was told
 * nothing useful.
 */
export function refusalFor(e: unknown): { refusal: RpcRefusal; internal?: string } {
  if (e instanceof RequestValidationError) {
    return {
      refusal: new RpcRefusal({
        code: e.code,
        message: e.message,
        details: { issues: e.issues },
      }),
    };
  }
  if (e instanceof InitInFlightError) {
    return { refusal: new RpcRefusal({ code: e.code, message: e.message, op_id: e.opId }) };
  }
  const { body, internal } = classifyFailure(e);
  return {
    refusal: new RpcRefusal(body.error),
    ...(internal !== undefined ? { internal } : {}),
  };
}

/**
 * Turning a handler's frames into pushes, once there is something to tag them
 * with.
 *
 * The correlation problem, and the whole reason this is a type rather than a
 * closure inline: a stream's `stream_id` is the *resolved value* of the request
 * that opened it, but the handler starts pumping frames into the sink before it
 * returns — `fleet.subscribe` writes its snapshot from an async body that runs
 * the moment it is built, well before `ctx.streams.open` has named anything. A
 * sink that sent as it went would push frames the page cannot match to the
 * request it is still waiting on.
 *
 * So frames buffer until `settle` is handed the resolved value, and are flushed
 * in order with the id it carried. `ops.subscribe` is no exception: its frames
 * also carry the `op_id` the page sent, but correlating on that alone shared
 * every frame between all of one op's readers in the window, and a live frame
 * sent for one reached another that was still waiting for its replay.
 */
export interface StreamPump {
  sink: StreamSink;
  /** The request resolved. Flushes what buffered, tagged with the id it carried. */
  settle(result: unknown): void;
  /** The request was refused. Nothing will ever correlate these; drop them. */
  abandon(): void;
  /**
   * How many frames are held waiting for a correlator.
   *
   * Exported because the alternative has no behavioural signature: a pump that
   * goes on buffering after it is dead sends nothing either way, and the only
   * symptom is an array that grows for as long as the source runs. This is what
   * lets a test see it.
   */
  pending(): number;
  /**
   * The source is exhausted. Pushes a terminal frame if the source never wrote
   * one of its own — see `STREAM_ENDED` for why a stream can end in silence,
   * and why the page cannot be left waiting for a frame that is not coming.
   */
  end(): void;
}

/**
 * The terminal frame a stream that ended in silence is closed with.
 *
 * Over HTTP the socket closing *is* the terminal: `streamSSE` returns and the
 * browser's reader fires. There is no socket here, so a source that stops
 * without a last word leaves the page's reader waiting for the life of the
 * window — and three of them can:
 *
 * - `ops.subscribe` on an op the registry has aged out answers with a
 *   `stream_id` and follows nothing (`ops.ts`, `follow`'s missing-record
 *   return);
 * - a chat turn that ends on an `error` frame emits no `done` after it
 *   (`handlers/chat.ts`);
 * - `logs`, `chat.send` and `ops.subscribe` all swallow a throwing source in a
 *   bare `catch {}`, because `done` may never reject (`streams.ts`), and write
 *   nothing to the sink on the way out.
 *
 * So the binding watches the handle's `done` and writes this when nothing else
 * did. The shape is `{ ok, error }` — what `ops.subscribe`'s own `done` carries,
 * and a superset of the `{ ok: true }` a finished tail carries — so the two
 * readers that already parse a `done` payload are reading the shape they expect.
 *
 * `STREAM_ENDED` is the bridge's own code, not a core `ErrorCode`: nothing in
 * core failed, the stream simply had no more to say than it had already said.
 */
export const STREAM_ENDED = {
  ok: false,
  error: { code: "STREAM_ENDED", message: "the stream ended without a final frame" },
} as const;

/**
 * The messages whose readers wait for a terminal.
 *
 * `fleet.event` and `chat.event` are absent on purpose: they are long-lived
 * feeds that end when the *reader* closes them, and their readers have no
 * terminal to be waiting on — a synthetic `done` on one would be a frame with
 * no meaning at the other end.
 */
const FINITE_MESSAGES: readonly StreamMessageName[] = [
  "op.event",
  "chat.frame",
  "logs.line",
  "files.frame",
  "files.put.frame",
  "files.get.frame",
];

function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const read = (value as Record<string, unknown>)[field];
  return typeof read === "string" && read !== "" ? read : undefined;
}

/** One frame, on the message its request's frames ride (`schema.ts`). */
function push(
  send: SendMessage,
  message: StreamMessageName,
  id: string,
  frame: StreamFrame,
  opId: string | null,
): void {
  switch (message) {
    case "op.event":
      send("op.event", { op_id: opId ?? "", stream_id: id, msg: frame });
      return;
    case "fleet.event":
      send("fleet.event", { event: frame });
      return;
    case "chat.event":
      send("chat.event", { event: frame });
      return;
    case "chat.frame":
      send(
        "chat.frame",
        frame.event === "done"
          ? { stream_id: id, done: frame.data }
          : { stream_id: id, frame: frame.data },
      );
      return;
    case "logs.line":
      send(
        "logs.line",
        frame.event === "done"
          ? { stream_id: id, done: frame.data }
          : { stream_id: id, line: frame.data },
      );
      return;
    case "files.frame":
      // `handlers/files.ts` sends only `FilesStageFrame`s on a stage stream,
      // and its last word as `done`.
      send(
        "files.frame",
        frame.event === "done"
          ? { stream_id: id, done: frame.data as FilesStageFrame }
          : { stream_id: id, frame: frame.data as FilesStageFrame },
      );
      return;
    case "files.put.frame":
      // …and only `FilesPutFrame`s on a put stream.
      send(
        "files.put.frame",
        frame.event === "done"
          ? { stream_id: id, done: frame.data as FilesPutFrame }
          : { stream_id: id, frame: frame.data as FilesPutFrame },
      );
      return;
    case "files.get.frame":
      // …and only `FilesGetFrame`s on a get stream.
      send(
        "files.get.frame",
        frame.event === "done"
          ? { stream_id: id, done: frame.data as FilesGetFrame }
          : { stream_id: id, frame: frame.data as FilesGetFrame },
      );
      return;
    case "terminal.frame":
      // The terminal's sink is only ever handed `TerminalFrame`s
      // (`bridgeChannel`), and those are already `{ event, data }`.
      send("terminal.frame", { stream_id: id, frame: frame as TerminalFrame });
      return;
  }
}

/**
 * The pump for one streaming request. Exported for its own test: the buffering
 * is the part of this module with a race in it, and driving it through a real
 * handler would test the handler instead.
 *
 * `keepalive` is dropped here rather than by the page. It exists to prove a
 * socket alive on a transport that has one, and this one does not (`streams.ts`).
 */
export function createStreamPump(
  message: StreamMessageName,
  params: unknown,
  send: SendMessage,
): StreamPump {
  // Every stream is named by what its request resolves to. An op's frames also
  // carry the op the page asked about, which is what its replay cursor keys on.
  const opId = message === "op.event" ? (stringField(params, "op_id") ?? null) : null;
  let id: string | null = null;
  const buffered: StreamFrame[] = [];
  /**
   * Nothing will ever correlate this pump's frames: the request was refused, or
   * it answered with no `stream_id`. Without it `sink` went on appending to a
   * buffer that could never be flushed — a source that had already started
   * pumping then grew that array for as long as it ran, which for a fleet
   * subscription is the life of the window.
   */
  let dead = false;
  /** Set by the source's own last word, so `end()` does not write a second one. */
  let terminated = false;
  const die = (): void => {
    dead = true;
    buffered.length = 0;
  };
  return {
    sink(frame) {
      if (dead || frame.event === KEEPALIVE_EVENT) return;
      if (frame.event === "done") terminated = true;
      if (id === null) {
        buffered.push(frame);
        return;
      }
      push(send, message, id, frame, opId);
    },
    settle(result) {
      if (dead) return;
      if (id === null) {
        const resolved = stringField(result, "stream_id");
        // A streaming name that answered with no id opened no stream: whatever
        // buffered belongs to nothing and is dropped rather than guessed at.
        if (resolved === undefined) {
          die();
          return;
        }
        id = resolved;
      }
      for (const frame of buffered.splice(0)) push(send, message, id, frame, opId);
    },
    abandon: die,
    pending() {
      return buffered.length;
    },
    end() {
      if (dead || terminated || id === null) return;
      if (!FINITE_MESSAGES.includes(message)) return;
      terminated = true;
      push(send, message, id, { event: "done", data: STREAM_ENDED }, opId);
    },
  };
}

/**
 * Close the page's reader when the source runs out in silence.
 *
 * The handle is read *now*, not from inside the `then`: a source with nothing
 * to say settles `done` at once — an aged-out op follows no records — and the
 * handlers forget a finished stream on their own `done.then` (`ops.ts`,
 * `handlers/chat.ts`, `handlers/agents.ts`), so by the time a later tick looked
 * the registry would have nothing under that id. A handle that is already gone
 * is a stream that has already ended, which is `end()` immediately.
 *
 * A stream its reader closed gets no terminal. That reader asked to stop and is
 * waiting for nothing. (When `op.event` was routed by `op_id` alone, every other
 * reader of the same op in the window — the fleet's watcher, a drawer reopened
 * on the op, StrictMode's second mount of the same drawer — took a
 * `STREAM_ENDED` written for the one that left as the end of the op itself.)
 */
function watchForSilence(ctx: HandlerContext, result: unknown, pump: StreamPump): void {
  const streamId = stringField(result, "stream_id");
  if (streamId === undefined) return;
  const handle = ctx.streams.get(streamId);
  if (handle === undefined) {
    pump.end();
    return;
  }
  void handle.done.then(() => {
    if (!ctx.streams.hungUp(handle)) pump.end();
  });
}

function pumpFor(name: string, params: unknown, send: SendMessage): StreamPump | null {
  const message = (MESSAGE_FOR_REQUEST as Record<string, StreamMessageName | undefined>)[name];
  return message === undefined ? null : createStreamPump(message, params, send);
}

export function createRpcBinding<Rpc>(deps: RpcBindingDeps<Rpc>): RpcBinding<Rpc> {
  const { ctx, send, log } = deps;
  const windowKey = deps.windowKey ?? `window-${++nextWindow}`;

  const requests: Record<string, (params: never) => unknown> = {};
  for (const name of REQUEST_NAMES) {
    requests[name] = async (params: unknown): Promise<unknown> => {
      const pump = pumpFor(name, params, send);
      try {
        const result = await dispatch(ctx, name, params, pump?.sink);
        // Before the answer goes back, so the page cannot receive a frame for a
        // stream it has not been told the id of.
        pump?.settle(result);
        if (pump !== null) watchForSilence(ctx, result, pump);
        return result;
      } catch (e) {
        pump?.abandon();
        const { refusal, internal } = refusalFor(e);
        // `internal` is set exactly when the page was told nothing useful, so
        // this is the only copy of what actually happened (`errors.ts`).
        log?.line(internal === undefined ? "debug" : "error", "rpc", `${name} refused`, {
          code: refusal.body.code,
          message: internal ?? refusal.body.message,
        });
        throw refusal;
      }
    };
  }

  const rpc = deps.defineRPC({
    /**
     * A request may be a create that runs for twenty minutes. There is no
     * socket to time out and no second caller waiting behind it, so a deadline
     * here could only ever abandon work the page still wants.
     */
    maxRequestTime: Number.POSITIVE_INFINITY,
    handlers: {
      requests,
      messages: {
        "page.ready": () => {
          log?.line("debug", "rpc", "page ready");
          // A reload keeps this binding, and so this window's key: whatever
          // the old page said it was viewing, and the keystroke count it was
          // on, belong to a page that is gone. The new one reports afresh.
          ctx.terminals?.forgetWindow(windowKey);
          // Every stream the old page opened died with it, and the new page
          // opens its own. Left open, a terminal attach would stall on credits
          // it can never be acked for and resync once a second until its
          // session ends, and a fleet, chat or op feed would push to nobody
          // (a chat feed's first frames are every watched transcript) for the
          // life of the process. `page.ready` is sent before the new page's
          // first render (`entry-app.tsx`), so only the old page's streams are
          // here to close.
          ctx.streams.closeAll();
        },
        // Keystrokes, acks and the view state. Never logged — not here, not
        // in the handlers — because the first of them is what the operator
        // typed, passwords included (`handlers/terminal.ts`).
        ...terminalMessageHandlers(ctx, windowKey),
      },
    },
  });

  return {
    rpc,
    close() {
      ctx.streams.closeAll();
      // Whatever this window showed is no longer shown by it; the sessions
      // themselves belong to the process and carry on.
      ctx.terminals?.forgetWindow(windowKey);
    },
  };
}
