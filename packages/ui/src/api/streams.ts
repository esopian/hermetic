/**
 * The stream readers: an op's replay + tail, one agent's serial console, the
 * fleet stream and the chat fan-in.
 *
 * Every one of them is a protocol over frames — which names mean what, which
 * frame ends the read, what a gap heals with — and none of them knows what
 * carries those frames. Opening, closing and routing are the transport's
 * (`transport-rpc.ts`); what is left here is the reading.
 */
import type { ChatStreamFrame } from "@hermetic/app";
import { transport } from "./transport.ts";
import type { StreamFrame } from "./transport.ts";
import type { AgentView, NotificationView, OpEvent } from "./types.ts";

/* ── streams ─────────────────────────────────────────────────────────────── */

/** One line of an agent's logs, as the `logs.open` stream frames it. */
export interface AgentLogLine {
  unit: string;
  at: string;
  message: string;
}

/**
 * Where one read of an agent's logs comes from — the `logs` method's own
 * choices (`LogsInput`), as the three a request can name: a journal unit on
 * the box (the box's default when `unit` is absent), one of Hermes's own log
 * files on the data volume, or the serial console off EC2. Core refuses a
 * request naming two, so the type admits one at a time.
 */
export type AgentLogQuery =
  | { source?: "agent"; unit?: string; file?: never }
  | { source?: "agent"; file: "agent" | "errors" | "gateway"; unit?: never }
  | { source: "console"; unit?: never; file?: never };

/**
 * The serial console, read once (`source: "console"`). Not a follow: EC2
 * hands back one buffer, so the stream is a handful of `line` frames and a
 * `done`. This is the only view of a boot that failed before the tailnet came
 * up, which is the boot an operator is most likely to be staring at.
 */
export function fetchConsole(name: string): Promise<AgentLogLine[]> {
  return fetchLogs(name, { source: "console" }, "could not read the serial console");
}

/**
 * One finished read of an agent's logs over the public `logs` method — never a
 * follow, so the stream is a run of `line` frames and one `done`, and this
 * resolves with the lines once the `done` arrives.
 *
 * A stream that ends without its `done` is a read that failed on the far side:
 * the handler ends the stream rather than the process when the box or the
 * tailnet does not answer (`handlers/agents.ts`). With lines already in hand
 * that is a complete read whose `done` raced the end; with none it is the
 * failure, reported in `failure`'s words.
 */
export function fetchLogs(
  name: string,
  query: AgentLogQuery = {},
  failure = "could not read this agent's logs",
): Promise<AgentLogLine[]> {
  return new Promise((resolve, reject) => {
    const lines: AgentLogLine[] = [];
    let settled = false;
    let close: (() => void) | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      close?.();
      fn();
    };
    close = transport().openStream(
      "logs.open",
      { name, ...query },
      {
        onFrame: (frame) => {
          if (frame.event === "line") {
            // A malformed frame is not worth failing the whole read for.
            if (frame.data !== undefined) lines.push(frame.data as AgentLogLine);
            return;
          }
          if (frame.event === "done") finish(() => resolve(lines));
        },
        // A closed stream with lines already in hand is a complete read whose
        // `done` raced the stream's end; only an empty one is a failure.
        onEnd: () => finish(() => (lines.length > 0 ? resolve(lines) : reject(new Error(failure)))),
      },
    );
    // The stream may have ended inside `openStream`, before there was a closer
    // to call; close it now rather than leaving it open on nobody's behalf.
    if (settled) close();
  });
}

/** Read one frame's payload, or null: a frame that did not decode is one to skip. */
export function parseFrame<T>(frame: StreamFrame): T | null {
  return frame.data === undefined ? null : (frame.data as T);
}

/**
 * Replay + tail of one op. Returns a canceller; `onDone` fires exactly once,
 * because the server always ends the stream with a `done` message.
 */
/**
 * One frame's place in an op stream: which attempt it belongs to, and where it
 * sits in that attempt. The server writes `<generation>:<seq>`; a bare number
 * is the first attempt, which is how every op that was never resumed is framed.
 *
 * Exported for its own unit test: the rule it encodes — a later generation
 * restarts the count — is the difference between a resumed op that streams and
 * one that appears to hang for ever.
 */
export function parseFrameId(id: string): { generation: number; seq: number } | null {
  const parsed = /^(?:(\d+):)?(\d+)$/.exec(id);
  if (parsed === null) return null;
  return { generation: Number(parsed[1] ?? "0"), seq: Number(parsed[2]) };
}

/**
 * The client half of the replay filter. Answers "have I already seen this
 * frame", and answers it per attempt: an op that the server picked up again
 * after a restart keeps its id and numbers its events from zero, so a cursor
 * held over from the attempt before would swallow the whole of the new one.
 */
export function makeFrameFilter(): (id: string) => boolean {
  let generation = 0;
  let lastSeq = -1;
  return (id: string) => {
    const frame = parseFrameId(id);
    // No id at all (an older server): nothing to de-duplicate against, so the
    // frame flows — a duplicate line is better than a missing one.
    if (frame === null) return true;
    if (frame.generation > generation) {
      generation = frame.generation;
      lastSeq = frame.seq;
      return true;
    }
    if (frame.generation < generation || frame.seq <= lastSeq) return false;
    lastSeq = frame.seq;
    return true;
  };
}

export function followOp(
  opId: string,
  onEvent: (e: OpEvent) => void,
  onDone: (ok: boolean, error: { code: string; message: string } | null) => void,
  /** False for a watcher that only wants the end; see `StreamHandlers.resumes`. */
  { resumes = true }: { resumes?: boolean } = {},
): () => void {
  let settled = false;
  let close: (() => void) | null = null;
  // The transport resumes a reopened op stream from the last frame's id; this is
  // the belt to that suspender, dropping any frame that arrives twice. `done`
  // is never filtered — the end of a stream is not a frame to de-duplicate.
  const fresh = makeFrameFilter();
  const finish = (ok: boolean, error: { code: string; message: string } | null) => {
    if (settled) return;
    settled = true;
    close?.();
    onDone(ok, error);
  };
  close = transport().openStream(
    "ops.subscribe",
    { op_id: opId },
    {
      onFrame: (frame) => {
        if (frame.event === "event") {
          if (!fresh(frame.id)) return;
          const event = parseFrame<OpEvent>(frame);
          if (event !== null) onEvent(event);
          return;
        }
        if (frame.event !== "done") return;
        const body = frame.data;
        // A `done` that did not decode, or that is not the shape the server
        // promises, still ends the stream — and a stream that reached its own
        // end without saying otherwise ended well.
        if (typeof body !== "object" || body === null || !("ok" in body)) {
          finish(true, null);
          return;
        }
        const done = body as { ok: boolean; error: { code: string; message: string } | null };
        finish(done.ok, done.error ?? null);
      },
      onEnd: () => finish(false, null),
      resumes,
    },
  );
  if (settled) close();
  return () => {
    settled = true;
    close?.();
  };
}

export interface FleetHandlers {
  /**
   * `scanned` is false when the server answered before its poller had read the
   * fleet even once: an empty list that means "not read yet", not "nothing
   * there". Older servers do not send the flag; it is treated as scanned so a
   * mismatched build does not sit on a loading screen forever.
   */
  onSnapshot: (agents: AgentView[], at: string, scanned: boolean) => void;
  onAgent: (agent: AgentView) => void;
  onRemoved: (name: string) => void;
  onPoll: (at: string) => void;
  onConnected: (connected: boolean) => void;
  /** A scan that threw in the head; the feed is still fine. */
  onScanError: (message: string) => void;
  /**
   * A reconnect has been scheduled, `delayMs` from now. Reported so the footer
   * can count down to it instead of saying "disconnected" for fifteen silent
   * seconds and looking hung.
   */
  onRetryIn: (delayMs: number) => void;
  /**
   * §4.9: a notification core wrote since the last tick. It rides the
   * fleet stream rather than a feed of its own — one subscription per window —
   * so these two are optional, and a caller that does not care about the inbox
   * simply omits them.
   */
  onNotification?: (notification: NotificationView) => void;
  /** The two counts, re-sent whenever either moves (including after an ack). */
  onNotifications?: (counts: { unread: number; needs_action: number }) => void;
}

/** The one live source of fleet state, with reconnect (the server never resumes). */
export function fleetStream(handlers: FleetHandlers): () => void {
  return transport().subscribe("fleet", null, {
    onConnected: handlers.onConnected,
    onRetryIn: handlers.onRetryIn,
    onFrame: (frame) => {
      switch (frame.event) {
        case "snapshot": {
          const e = parseFrame<{ agents: AgentView[]; at: string; scanned?: boolean }>(frame);
          if (e) handlers.onSnapshot(e.agents, e.at, e.scanned ?? true);
          // A snapshot is proof of a live feed, and it arrives on a re-open
          // the `open` this transport reports may have raced.
          handlers.onConnected(true);
          return;
        }
        case "agent": {
          const e = parseFrame<{ agent: AgentView }>(frame);
          if (e) handlers.onAgent(e.agent);
          return;
        }
        case "removed": {
          const e = parseFrame<{ name: string }>(frame);
          if (e) handlers.onRemoved(e.name);
          return;
        }
        case "poll": {
          const e = parseFrame<{ at: string }>(frame);
          handlers.onPoll(e?.at ?? new Date().toISOString());
          return;
        }
        case "notification": {
          const e = parseFrame<{ notification: NotificationView }>(frame);
          if (e?.notification) handlers.onNotification?.(e.notification);
          return;
        }
        case "notifications": {
          const e = parseFrame<{ unread: number; needs_action: number }>(frame);
          if (e) handlers.onNotifications?.({ unread: e.unread, needs_action: e.needs_action });
          return;
        }
        // Named `scan_error`, not `error`: a failed scan is not a failed feed,
        // and the feed's own `error` never reaches this handler.
        case "scan_error": {
          const e = parseFrame<{ message: string }>(frame);
          handlers.onScanError(e?.message ?? "the fleet scan failed");
          return;
        }
      }
    },
  });
}

/* ── the chat fan-in (§9.2) ───────────────────────────────────────────────── */

/**
 * Which conversation a fan-in frame belongs to. `session` is null for the bot's
 * canonical conversation — the one an operator means — so a client keys its
 * state on `instance` + `bot` + `session` rather than reconstructing an
 * identity from the payload.
 */
export type ChatConversationView = ChatStreamFrame["conversation"];

/**
 * One observation event: `snapshot` replaces a transcript, `message` appends to
 * one, `reconnect` is advisory, `error` is terminal for that conversation.
 *
 * Read off the app's own frame type rather than transcribed. A stream's frames
 * are pushes rather than an answer, so `HermeticRPC` has no shape to read (the
 * reason `ChatFrameView` is written by hand), but this frame is a named export
 * of `@hermetic/app`, so the union is still the head's rather than a copy that
 * drifts.
 */
export type ChatObserveView = ChatStreamFrame["event"];

export interface ChatStreamHandlers {
  /** One conversation's event, already routed by the frame's own `conversation`. */
  onFrame: (conversation: ChatConversationView, event: ChatObserveView) => void;
  /**
   * The server's bounded queue overflowed and `count` events are gone. Nothing
   * says which conversation lost them, so the answer is to re-read history —
   * the box is authoritative and this browser's copy is a cache.
   */
  onDropped: (count: number) => void;
  /**
   * The feed itself, which is not any one conversation's state. False while
   * this consumer is between feeds; the head replays each owned conversation's
   * snapshot when it comes back, so nothing is resumed by hand.
   */
  onConnected: (connected: boolean) => void;
}

/**
 * Every conversation this server observes, over one connection.
 *
 * One feed per conversation would be one subscription per conversation, which
 * is why the head multiplexes (`packages/app/src/chat-stream.ts`). Recovery is
 * the fleet stream's: whatever the transport does to re-open, the snapshots the
 * head sends a new reader are what heals the gap. Unlike a turn's stream,
 * re-joining this feed sends nothing and cannot repeat a prompt.
 */
export function chatStream(handlers: ChatStreamHandlers): () => void {
  /**
   * Route one fan-in frame, and say whether it *was* one.
   *
   * The envelope is the discriminator, not the presence of a payload: a frame
   * is one of the server's only if its payload is an object carrying both
   * `conversation` and `event`. `isProtocolError` below depends on that being
   * a decision about content rather than about `typeof data`.
   */
  const frame = (f: StreamFrame): boolean => {
    const e = parseFrame<ChatStreamFrame>(f);
    if (!e || typeof e !== "object" || !e.conversation || !e.event) return false;
    handlers.onFrame(e.conversation, e.event);
    return true;
  };

  return transport().subscribe("chat", null, {
    onConnected: handlers.onConnected,
    onFrame: (f) => {
      if (f.event === "dropped") {
        const e = parseFrame<{ count: number }>(f);
        handlers.onDropped(e?.count ?? 0);
        return;
      }
      frame(f);
    },
    /**
     * The observation's own terminal event shares a name with the transport's
     * failure, and the two mean opposite things: one conversation is over, or
     * this feed is.
     *
     * They are told apart by *what the payload decoded to*, not by asking
     * whether there was one. A transport `error` is not specified to leave its
     * payload empty — `null`, `""` and a bare status string have all been seen
     * — and every one of those would have read as a conversation's terminal
     * event under the old test, leaving a dead feed that never recovers.
     * Nothing but a frame carrying both `conversation` and `event` is a frame;
     * everything else is the feed.
     */
    isProtocolError: frame,
  });
}
