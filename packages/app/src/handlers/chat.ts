/**
 * §9.2's chat surface, and its continuous per-conversation observation.
 *
 * Every function here takes the same two things — a `HandlerContext` and the
 * caller's raw params — and nothing in it knows what a status code is: a
 * refusal is a thrown `HermeticError`. The schemas are declared
 * here, so the method and the schema the parity contract compares cannot drift
 * apart (`declare.ts`).
 *
 * ## Nothing here is write-guarded, deliberately
 *
 * `requireWritable` is absent from this module and that is not an omission.
 * The guards exist to stop a mutation racing a whole-fleet operation, and a
 * chat mutates nothing in AWS: it is a conversation with a process on a box,
 * and an operator asking an agent what is happening while a foundation update
 * runs is doing the thing the portal is for.
 *
 * ## Three streams, five machinery names
 *
 * A turn, a single conversation's watch and the multiplexed fan-in are all
 * pushes rather than answers, so they take the streaming shape `streams.ts`
 * describes: pump frames into a sink under an `AbortController`, name the
 * stream, hand the id back for the caller to close it by.
 *
 * `chat.send` wears two names, exactly as `logs` does: it is the public method,
 * and `chat.turn`/`chat.turn.abort` is how a transport with no socket works it
 * — an `EventSource` closes a connection to stop a turn, and a bridge sends the
 * id back instead. `chat.observe` is the same story on the read side, closed
 * with `chat.unsubscribe` — the one close half both observation transports
 * share, because closing either is the same registry call.
 */
import {
  ChatAbortInput,
  ChatHistoryInput,
  ChatListenInput,
  ChatListeningInput,
  ChatObserveInput,
  ChatSendInput,
  ChatSessionsInput,
  ChatSwarmsInput,
} from "@hermetic/core";
import type { Hermetic } from "@hermetic/core";
import { z } from "zod";
import { CHAT_STREAM_MAX_QUEUED } from "../chat-stream.ts";
import type { ChatStreamFrame } from "../chat-stream.ts";
import { declareMachineryRpc, declareRpc } from "../declare.ts";
import { FOLLOW_KEEPALIVE_MS } from "../ops.ts";
import { requireTarget, withTarget } from "../target.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";
import { KEEPALIVE_EVENT, StreamRefRequest, requireSink } from "./streams.ts";
import type { StreamSink } from "./streams.ts";

/**
 * §9.2: the chat surface. The roster read is fleet-wide; the other
 * five address one bot on one box, because `<instance>/<bot>` is the unit and
 * every one of them needs both halves to know which gateway to reach.
 */
export const chatListeningSchema = declareRpc("chat.listening", ChatListeningInput);
export const chatListenSchema = declareRpc("chat.listen", ChatListenInput);
export const chatSwarmsSchema = declareRpc("chat.swarms", ChatSwarmsInput);
export const chatSessionsSchema = declareRpc("chat.sessions", ChatSessionsInput);
export const chatHistorySchema = declareRpc("chat.history", ChatHistoryInput);
export const chatSendSchema = declareRpc("chat.send", ChatSendInput);
export const chatAbortSchema = declareRpc("chat.abort", ChatAbortInput);
/**
 * §9.2: a continuous watch on one conversation. It is a declared
 * method rather than machinery because there *is* a core method behind it, and
 * the CLI's `chat watch` calls the same one — but this head reads it through
 * `chat-owner.ts` rather than calling core directly, so that N readers of one
 * conversation are one call into core whoever opened first.
 */
export const chatObserveSchema = declareRpc("chat.observe", ChatObserveInput);

/**
 * The live turn, for a transport that cannot hold a socket open per turn.
 * `chat.turn` is `chat.send` under another name — same function, same schema —
 * and `chat.turn.abort` replaces hanging up on it.
 */
export const CHAT_TURN = declareMachineryRpc("chat.turn");
export const CHAT_TURN_ABORT = declareMachineryRpc("chat.turn.abort");
/**
 * Every observed conversation over one channel (`chat-stream.ts`). Machinery
 * rather than a second method: it is a second *transport* of `chat.observe`,
 * and it exists because a browser allows about six connections per origin,
 * which a fleet view watching a dozen bots would spend on chat alone.
 */
export const CHAT_SUBSCRIBE = declareMachineryRpc("chat.subscribe");
/** The close half of both `chat.observe` and `chat.subscribe`. */
export const CHAT_UNSUBSCRIBE = declareMachineryRpc("chat.unsubscribe");
/**
 * `Watch again`. Machinery because it wraps no core method: it asks *this
 * server* to hold a subscription it dropped, which is the same kind of thing
 * the fleet switch is — a change to the portal, not to the account or the box.
 *
 * Deliberately not a listen write, which is what a resume used to be: writing
 * the listen preference reconciles the whole fleet, so one click on one bot
 * re-read every listened box and re-opened every dropped conversation. It is
 * also not a write of any kind to the box — resuming an observation reads a
 * conversation that is already there and sends nothing.
 */
export const CHAT_OBSERVE_RESUME = declareMachineryRpc("chat.observe.resume");

/**
 * Chat writes take the same envelope as every other fleet-scoped
 * mutation (`handlers/shared.ts`, `target.ts`): a chat turn reaches a box in
 * one account.
 */
export const chatListenBody = withTarget(chatListenSchema);
export const chatSendBody = withTarget(chatSendSchema);
export const chatAbortBody = withTarget(chatAbortSchema);

/** A subscription to the fan-in takes nothing: it is every conversation this server owns. */
export const ChatSubscribeRequest = z.object({});

export async function listening(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().chat.listening(parseInput(chatListeningSchema, params ?? {}));
}

/**
 * Turning an instance on or off is what decides which conversations this
 * server observes continuously, so the owner is reconciled before the answer
 * goes out: a caller that has just been told it is listening can connect to
 * the fan-in and find the subscriptions already there.
 *
 * The reconcile cannot fail the request. It is a roster read over one box, and
 * a box that did not answer is a conversation this server is not watching yet
 * — not a listen preference that failed to save.
 */
export async function listen(ctx: HandlerContext, params: unknown) {
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(chatListenBody, params));
  const result = await h.chat.listen(input);
  await ctx.chatOwner.sync();
  return result;
}

/**
 * A roster read is a fan-out over every box in the fleet, each with its own
 * timeout. The caller's own signal ends all of it at once when it goes away,
 * rather than paying for thirteen answers nobody will see.
 */
export async function swarms(ctx: HandlerContext, params: unknown) {
  const input = parseInput(chatSwarmsSchema, params ?? {});
  return await ctx.hermetic().chat.swarms(input, { signal: ctx.signal });
}

export async function sessions(ctx: HandlerContext, params: unknown) {
  const input = parseInput(chatSessionsSchema, params);
  return await ctx.hermetic().chat.sessions(input, { signal: ctx.signal });
}

export async function history(ctx: HandlerContext, params: unknown) {
  const input = parseInput(chatHistorySchema, params);
  return await ctx.hermetic().chat.history(input, { signal: ctx.signal });
}

export async function abort(ctx: HandlerContext, params: unknown) {
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(chatAbortBody, params));
  return await h.chat.abort(input, { signal: ctx.signal });
}

/**
 * One turn, streamed. No op id, no registry, nothing buffered: §9.2's whole
 * point is that a turn is a live pipe to a process already running elsewhere.
 * A drop on the box socket is core's to handle, and it continues the turn from
 * its cursor (§9.2); a client that loses the frames has no buffer here to
 * resume from and re-reads the transcript instead.
 *
 * One frame per event, named by the frame's own `type`, so a reader listens
 * for `delta`/`block`/`done`/`error` rather than parsing every message to find
 * out which it got. An `error` frame ends the stream and is *not* a failed
 * request: over HTTP the response has been committed with a 200 by the time one
 * exists, so the failure travels in the body — which is why `ChatFrame` carries
 * a code at all.
 */
function startTurn(
  ctx: HandlerContext,
  h: Hermetic,
  input: ChatSendInput,
  sink: StreamSink,
): { stream_id: string } {
  const controller = new AbortController();
  const done = (async () => {
    try {
      for await (const frame of h.chat.send(input, { signal: controller.signal })) {
        await sink({ event: frame.type, data: frame });
      }
    } catch {
      // `done` never rejects (`streams.ts`): a turn that dies with the socket,
      // or with the box, ends the stream rather than the process.
    }
  })();
  const stream_id = ctx.streams.open({ close: () => controller.abort(), done });
  // A turn that ran out has nothing left to close; forgetting it here is what
  // keeps the registry the size of what is actually open.
  void done.then(() => {
    ctx.streams.close(stream_id);
  });
  return { stream_id };
}

/**
 * `chat.send`: the turn a caller wrote a body for, so it carries the fleet
 * target every other fleet-scoped mutation does.
 */
export async function send(
  ctx: HandlerContext,
  params: unknown,
  sink: StreamSink,
): Promise<{ stream_id: string }> {
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(chatSendBody, params));
  return startTurn(ctx, h, input, sink);
}

/**
 * `chat.turn`: the same turn for a transport that cannot set a body — an
 * `EventSource` can only issue a `GET`, so the message rides in the query
 * string and there is no envelope around it. Validated against the schema
 * `chat.send` validates against, because it is the same request.
 */
export async function turn(
  ctx: HandlerContext,
  params: unknown,
  sink: StreamSink,
): Promise<{ stream_id: string }> {
  const input = parseInput(chatSendSchema, params);
  return startTurn(ctx, ctx.hermetic(), input, sink);
}

/** Hanging up, for a transport with nothing to hang up. */
export async function turnAbort(ctx: HandlerContext, params: unknown): Promise<{ closed: boolean }> {
  const { stream_id } = parseInput(StreamRefRequest, params);
  return { closed: ctx.streams.close(stream_id) };
}

/**
 * The watch. One frame per observation event, named by its own `type`, so a
 * reader listens for `snapshot`/`message`/`reconnect`/`error` rather than
 * parsing every payload to find out which it got.
 *
 * Closing one detaches *this* reader and nothing else. The subscription belongs
 * to `chat-owner.ts`, which holds one per listened conversation for as long as
 * the server is up, so a closed tab stops its own watch while the other tabs —
 * and anything the box is doing — carry on. Closing a watch is never an
 * interruption of remote work.
 *
 * Reading through the owner rather than calling `chat.observe` here is what
 * makes that true of the *first* reader as well as the second: N readers of one
 * conversation are one call into core, whoever opened first, and a joiner is
 * handed the snapshot the owner already holds.
 */
export async function observe(
  ctx: HandlerContext,
  params: unknown,
  sink: StreamSink,
): Promise<{ stream_id: string }> {
  const input = parseInput(chatObserveSchema, params);
  const controller = new AbortController();
  const done = (async () => {
    try {
      for await (const event of ctx.chatOwner.join(input, controller.signal)) {
        await sink({ event: event.type, data: event });
      }
    } catch {
      // `done` never rejects (`streams.ts`).
    }
  })();
  const stream_id = ctx.streams.open({ close: () => controller.abort(), done });
  void done.then(() => {
    ctx.streams.close(stream_id);
  });
  return { stream_id };
}

/**
 * Every observed conversation over one channel (`chat-stream.ts` explains why
 * this exists at all, and why it is not folded into the fleet stream).
 *
 * The seed is the snapshot each owned conversation already holds, and the
 * current health of every one that is not well. A reader that connects to a
 * server which has been watching for an hour starts whole — with the same
 * transcripts *and* the same bands a reader that connected an hour ago has —
 * and at no upstream cost, because these are reads already made. The health
 * half is what a late connection used to miss entirely: a conversation whose
 * watch had failed arrived looking healthy, with no band and no `Watch again`
 * (`chat-owner.ts`, "Health is replayed").
 *
 * What follows is the queue drained in order, with a `dropped` frame whenever
 * the reader fell far enough behind to lose events, and a keepalive whenever
 * the fleet goes quiet — a quiet fleet must not let a transport idle out and
 * force a reconnect and a re-seed.
 */
export async function subscribe(
  ctx: HandlerContext,
  params: unknown,
  sink: StreamSink,
): Promise<{ stream_id: string }> {
  parseInput(ChatSubscribeRequest, params ?? {});
  const owner = ctx.chatOwner;
  const queue: ChatStreamFrame[] = [];
  let dropped = 0;
  let open = true;
  let wake: (() => void) | null = null;
  const nudge = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  /**
   * The one door into the queue, so the bound and the `dropped` count are
   * properties of the queue rather than of the caller.
   *
   * The seed used to push straight past this. A server owning more
   * conversations than the cap therefore started over the bound, and the first
   * live event trimmed *seed* frames — transcripts the client had not been sent
   * yet — and reported them as a gap in the live stream. Trimming here means
   * the oldest go and the count is honest whichever half they came from.
   */
  const enqueue = (frames: ChatStreamFrame[]): void => {
    queue.push(...frames);
    while (queue.length > CHAT_STREAM_MAX_QUEUED) {
      queue.shift();
      dropped += 1;
    }
  };
  const unsubscribe = owner.subscribe((event) => {
    enqueue([event]);
    nudge();
  });
  const stop = (): void => {
    open = false;
    nudge();
  };
  enqueue(owner.snapshots());
  const done = (async () => {
    try {
      while (open) {
        if (queue.length === 0) {
          let timer: ReturnType<typeof setTimeout> | null = null;
          const quiet = await new Promise<boolean>((resolve) => {
            wake = () => resolve(false);
            timer = setTimeout(() => resolve(true), FOLLOW_KEEPALIVE_MS);
          });
          wake = null;
          if (timer !== null) clearTimeout(timer);
          if (quiet && open) await sink({ event: KEEPALIVE_EVENT, data: null });
          continue;
        }
        if (dropped > 0) {
          const gap = dropped;
          dropped = 0;
          await sink({ event: "dropped", data: { count: gap } });
        }
        const frame = queue.shift();
        if (frame === undefined) continue;
        await sink({ event: frame.event.type, data: frame });
      }
    } catch {
      // `done` never rejects (`streams.ts`).
    } finally {
      unsubscribe();
    }
  })();
  const stream_id = ctx.streams.open({ close: stop, done });
  void done.then(() => {
    ctx.streams.close(stream_id);
  });
  return { stream_id };
}

/** The close half both observation transports share. */
export async function unsubscribe(ctx: HandlerContext, params: unknown): Promise<{ closed: boolean }> {
  const { stream_id } = parseInput(StreamRefRequest, params);
  return { closed: ctx.streams.close(stream_id) };
}

/**
 * `Watch again`, for one conversation. One call into the owner: it re-reads a
 * conversation that is already there, and the whole-fleet reconcile a listen
 * write triggers is what it replaces (`chat-owner.ts`, `resume`).
 */
export async function observeResume(ctx: HandlerContext, params: unknown) {
  return await ctx.chatOwner.resume(parseInput(chatObserveSchema, params));
}

/** The open halves, with the sink `Handler` leaves optional made required again. */
const sendEntry: Handler = (ctx, params, sink) => send(ctx, params, requireSink(sink));
const turnEntry: Handler = (ctx, params, sink) => turn(ctx, params, requireSink(sink));

/**
 * This module's contribution to the dispatch table (`dispatch.ts`).
 *
 * `chat.send` appears twice — once as the public method, once under the
 * machinery name a socketless transport opens a turn with — for the same
 * reason `logs` appears three times in `handlers/agents.ts`: they are the same
 * request reached over two transports, not two requests.
 */
export const chatHandlers = {
  "chat.listening": listening,
  "chat.listen": listen,
  "chat.swarms": swarms,
  "chat.sessions": sessions,
  "chat.history": history,
  "chat.send": sendEntry,
  "chat.abort": abort,
  "chat.observe": (ctx: HandlerContext, params: unknown, sink?: StreamSink) =>
    observe(ctx, params, requireSink(sink)),
  [CHAT_TURN]: turnEntry,
  [CHAT_TURN_ABORT]: turnAbort,
  [CHAT_SUBSCRIBE]: (ctx: HandlerContext, params: unknown, sink?: StreamSink) =>
    subscribe(ctx, params, requireSink(sink)),
  [CHAT_UNSUBSCRIBE]: unsubscribe,
  [CHAT_OBSERVE_RESUME]: observeResume,
} satisfies Record<string, Handler>;
