/**
 * The in-app terminal's requests and messages (issue #18).
 *
 * All machinery: none of these is a core method, because a terminal session
 * is something this head owns — a PTY in the main process — and core's whole
 * part in it is the `ssh` argv and the inbox rows (`TerminalHost`). The
 * requests validate and call the host; the three page → main messages
 * (`terminal.input`, `terminal.ack`, `terminal.view`) are fire-and-forget,
 * routed here by `rpc/bind.ts`, and never answer, never throw and never log —
 * a keystroke is exactly what must not reach `app.log`.
 */
import { AgentName, HermeticError, TerminalSessionId } from "@hermetic/core";
import { z } from "zod";
import { declareMachineryRpc } from "../declare.ts";
import { bridgeChannel } from "../terminal/channel.ts";
import type { TerminalHost } from "../terminal/host.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";
import { type StreamSink, StreamRefRequest, requireSink } from "./streams.ts";

export const TERMINAL_OPEN = declareMachineryRpc("terminal.open");
export const TERMINAL_ATTACH = declareMachineryRpc("terminal.attach");
export const TERMINAL_DETACH = declareMachineryRpc("terminal.detach");
export const TERMINAL_RESIZE = declareMachineryRpc("terminal.resize");
export const TERMINAL_CLOSE = declareMachineryRpc("terminal.close");
export const TERMINAL_LIST = declareMachineryRpc("terminal.list");
export const TERMINAL_EXTERNAL = declareMachineryRpc("terminal.external");

/** The page's xterm size, as `fit` reports it. Bounds are the spec's, not xterm's. */
const Cols = z.number().int().min(2).max(500);
const Rows = z.number().int().min(2).max(200);

export const TerminalOpenRequest = z.object({ name: AgentName, cols: Cols, rows: Rows });
export const TerminalSessionRequest = z.object({ session_id: TerminalSessionId });
export const TerminalResizeRequest = z.object({
  session_id: TerminalSessionId,
  cols: Cols,
  rows: Rows,
});
export const TerminalListRequest = z.object({ name: AgentName.optional() });
export const TerminalExternalRequest = z.object({ name: AgentName });

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * One keystroke chunk: text from xterm's `onData`, or bytes from `onBinary`
 * as base64 — exactly one of the two. Size is not refused here: a chunk over
 * `INPUT_CHUNK_MAX` takes its place in the sequence and comes back as an
 * `input_error` frame (`input.ts`), which a silent drop could not.
 */
export const TerminalInputMessage = z
  .object({
    session_id: TerminalSessionId,
    in_seq: z.number().int().min(0),
    data: z.string().optional(),
    binary: z.string().regex(BASE64).optional(),
  })
  .refine((m) => (m.data === undefined) !== (m.binary === undefined), {
    message: "exactly one of data and binary",
  });
export const TerminalAckMessage = z.object({
  stream_id: z.string().min(1),
  gen: z.number().int().min(0),
  upto: z.number().int().min(0),
});
export const TerminalViewMessage = z.object({ session_id: TerminalSessionId.nullable() });

/** A context built without a host (a test, a head with no PTY) refuses rather than pretends. */
function requireHost(ctx: HandlerContext): TerminalHost {
  if (ctx.terminals === undefined) {
    throw new HermeticError("UNSUPPORTED", "this head has no terminal sessions");
  }
  return ctx.terminals;
}

export async function open(ctx: HandlerContext, params: unknown) {
  const input = parseInput(TerminalOpenRequest, params);
  return await requireHost(ctx).open(input);
}

/**
 * A stream of `TerminalFrame`s for one session: its snapshot first, then live
 * output under credit flow control, `exit` last (`channel.ts`). The frames the
 * attach sends before this returns are held by the binding's pump until the
 * page has the `stream_id` (`rpc/bind.ts`).
 */
export async function attach(
  ctx: HandlerContext,
  params: unknown,
  sink?: StreamSink,
): Promise<{ stream_id: string }> {
  const out = requireSink(sink);
  const { session_id } = parseInput(TerminalSessionRequest, params);
  const host = requireHost(ctx);
  const stream = host.attach(session_id, bridgeChannel(out));
  const stream_id = ctx.streams.open({ close: () => stream.close(), done: stream.done });
  host.track(stream_id, stream);
  // An attach that sent `exit` has nothing left to close; forgetting it keeps
  // the registry the size of what is open.
  void stream.done.then(() => {
    ctx.streams.close(stream_id);
  });
  return { stream_id };
}

export async function detach(ctx: HandlerContext, params: unknown): Promise<{ closed: boolean }> {
  const { stream_id } = parseInput(StreamRefRequest, params);
  return { closed: ctx.streams.close(stream_id) };
}

export async function resize(ctx: HandlerContext, params: unknown): Promise<{ resized: true }> {
  const { session_id, cols, rows } = parseInput(TerminalResizeRequest, params);
  requireHost(ctx).resize(session_id, cols, rows);
  return { resized: true };
}

export async function close(ctx: HandlerContext, params: unknown): Promise<{ closed: boolean }> {
  const { session_id } = parseInput(TerminalSessionRequest, params);
  return await requireHost(ctx).close(session_id);
}

export async function list(ctx: HandlerContext, params: unknown) {
  const { name } = parseInput(TerminalListRequest, params ?? {});
  return { sessions: requireHost(ctx).list(name), alerts: requireHost(ctx).alertsOn };
}

export async function external(ctx: HandlerContext, params: unknown): Promise<{ opened: true }> {
  const { name } = parseInput(TerminalExternalRequest, params);
  return await requireHost(ctx).external(name);
}

export const terminalHandlers = {
  [TERMINAL_OPEN]: open,
  [TERMINAL_ATTACH]: attach,
  [TERMINAL_DETACH]: detach,
  [TERMINAL_RESIZE]: resize,
  [TERMINAL_CLOSE]: close,
  [TERMINAL_LIST]: list,
  [TERMINAL_EXTERNAL]: external,
} satisfies Record<string, Handler>;

export type TerminalMessageName = "terminal.input" | "terminal.ack" | "terminal.view";

/**
 * The page → main messages for one window. `windowKey` names the window for
 * `terminal.view`, so two windows showing the same session each count.
 *
 * A payload that does not parse is dropped, and so is anything a handler
 * throws: a message has no caller to refuse, and an exception escaping into
 * the bridge would be logged with whatever it carried.
 */
export function terminalMessageHandlers(
  ctx: HandlerContext,
  windowKey: string,
): Record<TerminalMessageName, (payload: unknown) => void> {
  const quietly = (run: (host: TerminalHost) => void): void => {
    const host = ctx.terminals;
    if (host === undefined) return;
    try {
      run(host);
    } catch {
      // See above: nothing to tell, and nothing safe to log.
    }
  };
  return {
    "terminal.input": (payload) =>
      quietly((host) => {
        const m = TerminalInputMessage.safeParse(payload);
        if (!m.success) return;
        const { session_id, in_seq, data, binary } = m.data;
        const chunk = data ?? new Uint8Array(Buffer.from(binary ?? "", "base64"));
        host.input(windowKey, session_id, in_seq, chunk);
      }),
    "terminal.ack": (payload) =>
      quietly((host) => {
        const m = TerminalAckMessage.safeParse(payload);
        // Only a stream this window opened: another window's ids are not its to ack.
        if (!m.success || !ctx.streams.has(m.data.stream_id)) return;
        host.ack(m.data.stream_id, m.data.gen, m.data.upto);
      }),
    "terminal.view": (payload) =>
      quietly((host) => {
        const m = TerminalViewMessage.safeParse(payload);
        if (!m.success) return;
        host.view(windowKey, m.data.session_id);
      }),
  };
}
