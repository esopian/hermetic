/**
 * The op registry, as machinery: `ops.list`, `ops.get`, `ops.abort` and the
 * subscribe/unsubscribe pair the event stream is made of.
 *
 * None of it wraps a core method — the registry belongs to the head, and it is
 * what lets the UI close a tab without killing a create and reopen it to the
 * whole event history — so every name here is a `declareMachineryRpc` one and
 * the request shapes are this module's own rather than core's.
 *
 * The transport-agnostic half. `subscribe` is the
 * streaming shape described in `streams.ts`: it pumps frames into a sink under
 * its own `AbortController`, names the stream, and hands the id back for the
 * caller to close.
 */
import { HermeticError } from "@hermetic/core";
import { z } from "zod";
import { declareMachineryRpc } from "../declare.ts";
import type { FollowOptions, OpSummary } from "../ops.ts";
import { defined, parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";
import { KEEPALIVE_EVENT, StreamRefRequest, requireSink } from "./streams.ts";
import type { StreamSink } from "./streams.ts";

export const OPS_LIST = declareMachineryRpc("ops.list");
export const OPS_GET = declareMachineryRpc("ops.get");
export const OPS_ABORT = declareMachineryRpc("ops.abort");
export const OPS_SUBSCRIBE = declareMachineryRpc("ops.subscribe");
export const OPS_UNSUBSCRIBE = declareMachineryRpc("ops.unsubscribe");

/**
 * `?target=atlas&status=running` is how the UI re-attaches to an op it started
 * before the page was reloaded. The numbers are numbers here: a query string
 * is strings, and coercing them is the HTTP binding's job (§3.3).
 */
export const OpsListRequest = z.object({
  limit: z.number().int().positive().optional(),
  cursor: z.string().optional(),
  target: z.string().optional(),
  status: z.enum(["running", "ok", "error", "aborted"]).optional(),
});

export const OpRefRequest = z.object({ id: z.string().min(1) });

/**
 * `after` is the cursor an interrupted reader resumes from, as the two numbers
 * it is made of rather than the `<generation>:<seq>` string SSE spells it with:
 * the generation is the *attempt*, and an op resumed after a restart keeps its
 * id while counting its events from zero again, so a cursor from before the
 * restart names a stream that no longer exists (`OpRegistry.follow`).
 */
export const OpsSubscribeRequest = z.object({
  op_id: z.string().min(1),
  after: z
    .object({
      generation: z.number().int().nonnegative(),
      seq: z.number().int().nonnegative(),
    })
    .optional(),
});

export async function list(ctx: HandlerContext, params: unknown) {
  const { limit, cursor, target, status } = parseInput(OpsListRequest, params ?? {});
  return ctx.ops.list(defined({ limit, cursor, target, status }));
}

export async function get(ctx: HandlerContext, params: unknown): Promise<OpSummary> {
  const op = ctx.ops.get(parseInput(OpRefRequest, params).id);
  if (op === undefined) throw new HermeticError("NOT_FOUND", "no such op");
  return op;
}

export async function abort(ctx: HandlerContext, params: unknown): Promise<{ aborted: boolean }> {
  return { aborted: ctx.ops.abort(parseInput(OpRefRequest, params).id) };
}

/**
 * Every event of one op, from the buffer through to `done`.
 *
 * The buffer is replayed first, so a client that connects late — or reconnects
 * after the tab was closed — sees the whole op. A quiet tail yields keepalive
 * frames on the registry's own clock; what a transport does with one is its
 * business (`streams.ts`).
 */
export async function subscribe(
  ctx: HandlerContext,
  params: unknown,
  sink: StreamSink,
): Promise<{ stream_id: string }> {
  const { op_id, after } = parseInput(OpsSubscribeRequest, params);
  if (ctx.ops.get(op_id) === undefined) throw new HermeticError("NOT_FOUND", "no such op");
  const follow: FollowOptions =
    after === undefined ? {} : { after: after.seq, generation: after.generation };
  const controller = new AbortController();
  const done = (async () => {
    try {
      for await (const message of ctx.ops.follow(op_id, controller.signal, follow)) {
        if (message.type === "event") {
          await sink({
            id: `${message.generation}:${message.seq}`,
            event: "event",
            data: message.event,
          });
        } else if (message.type === "done") {
          await sink({
            id: `${message.generation}:${message.seq}`,
            event: "done",
            data: { ok: message.ok, error: message.error },
          });
        } else {
          await sink({ event: KEEPALIVE_EVENT, data: null });
        }
      }
    } catch {
      // `done` never rejects (`streams.ts`): a sink writing to a socket the
      // runtime never told us about ends the stream, and the op itself is
      // untouched — it goes on running for whoever reads it next.
    }
  })();
  const stream_id = ctx.streams.open({ close: () => controller.abort(), done });
  // A source that ran out has nothing left to close; forgetting it here is what
  // keeps the registry the size of what is actually open.
  void done.then(() => {
    ctx.streams.close(stream_id);
  });
  return { stream_id };
}

export async function unsubscribe(ctx: HandlerContext, params: unknown): Promise<{ closed: boolean }> {
  const { stream_id } = parseInput(StreamRefRequest, params);
  return { closed: ctx.streams.close(stream_id) };
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const opHandlers = {
  [OPS_LIST]: list,
  [OPS_GET]: get,
  [OPS_ABORT]: abort,
  [OPS_SUBSCRIBE]: (ctx: HandlerContext, params: unknown, sink?: StreamSink) =>
    subscribe(ctx, params, requireSink(sink)),
  [OPS_UNSUBSCRIBE]: unsubscribe,
} satisfies Record<string, Handler>;
