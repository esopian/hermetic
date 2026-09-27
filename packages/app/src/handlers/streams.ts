/**
 * The long-lived pushes a transport holds open on one caller's behalf (plan
 * 0012).
 *
 * The desktop head has one bridge and many concurrent subscriptions, so each
 * one needs a name — the caller asks for a stream, gets an id back, and frames
 * arrive as pushes tagged with it until the caller closes the id or the window
 * goes away. (The HTTP head this replaced had a socket per stream to hang one
 * off instead, which is why none of this used to be needed.)
 *
 * This is the registry of those ids. It holds nothing about *what* is
 * streaming: a handler that opens one hands over a `close()` that stops
 * whatever it started and a `done` that settles when the source is exhausted,
 * and the registry's whole job is to be able to reach either again later, by
 * name, from somewhere else.
 *
 * ## The shape of a streaming handler
 *
 * An *open* handler takes a sink as its third argument, starts pumping frames
 * into it in the background under its own `AbortController`, registers the
 * pair in `ctx.streams` and returns `{ stream_id }`. The pump's promise is
 * `done`, and it never rejects: a source that throws — or a sink writing to a
 * socket the runtime never told us about — ends the stream rather than
 * surfacing as an unhandled rejection somewhere with no caller left to tell.
 *
 * A *close* handler is the other half: `{ closed }` from `close(stream_id)`.
 *
 * A binding awaits `streams.get(id)?.done` when it needs to know the source has
 * finished — a test draining a stream, and anything that has to stay alive for
 * exactly as long as the source has something to say.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HermeticError } from "@hermetic/core";

/**
 * One frame pushed to the caller that opened a stream.
 *
 * `data` is the value, not its encoding, so a transport that can carry
 * structured values does not have to parse a string back. `id` is a resume
 * cursor: a reader that was interrupted hands the last one it saw back as
 * `after` and is sent what it missed and nothing else.
 */
export interface StreamFrame {
  event: string;
  data: unknown;
  id?: string;
}

export type StreamSink = (frame: StreamFrame) => void | Promise<void>;

/**
 * The frame a source emits when it has nothing to say and wants the channel
 * proved alive anyway.
 *
 * What a transport does with one is its business — an idle channel may need
 * bytes on it, or may not — but the quiet that prompts one is the source's:
 * `OpRegistry.follow` decides it on its own clock (tests shorten it), and only
 * the source knows when a stream has gone silent rather than ended.
 */
export const KEEPALIVE_EVENT = "keepalive";

/** What a handler hands the registry: how to stop what it started, and when it stopped. */
export interface StreamHandle {
  close(): void;
  /** Settles when the source is exhausted or aborted. Never rejects. */
  done: Promise<void>;
}

/** What every close handler validates its params against. */
export const StreamRefRequest = z.object({ stream_id: z.string().min(1) });

/**
 * A streaming handler reached with no sink — a caller that asked for frames
 * over a transport that cannot carry them. `Handler` makes the sink optional
 * because the table holds both kinds; this is where that optionality is paid
 * for, once, at the edge of each streaming entry.
 */
export function requireSink(sink: StreamSink | undefined): StreamSink {
  if (sink === undefined) {
    throw new HermeticError("UNSUPPORTED", "this request pushes frames and no sink was supplied");
  }
  return sink;
}

export interface StreamRegistry {
  /** Registers an open stream and names it. Ids are opaque, as `OpRegistry`'s are. */
  open(handle: StreamHandle): string;
  /** Closes and forgets one. `false` when the id is unknown — closing twice is not an error. */
  close(id: string): boolean;
  /** The handle behind an id, for a binding that wants to await its `done`. */
  get(id: string): StreamHandle | undefined;
  has(id: string): boolean;
  /** Closes every open stream: what a window closing means for the streams it asked for. */
  closeAll(): void;
}

export function createStreamRegistry(): StreamRegistry {
  const open = new Map<string, StreamHandle>();
  return {
    open(handle) {
      // Same shape of id as an op's, and for the same reason: it is handed to a
      // caller that will send it back, and nothing may infer anything from it.
      const id = randomUUID();
      open.set(id, handle);
      return id;
    },
    close(id) {
      const handle = open.get(id);
      if (handle === undefined) return false;
      open.delete(id);
      handle.close();
      return true;
    },
    get(id) {
      return open.get(id);
    },
    has(id) {
      return open.has(id);
    },
    closeAll() {
      for (const id of [...open.keys()]) this.close(id);
    },
  };
}
