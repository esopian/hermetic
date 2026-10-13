/**
 * The bridge's turn registry: a `chat.send` run to completion whether or not a
 * phone is still listening, with its frames kept so a phone that dropped can
 * pick up where it left off.
 *
 * A turn is detached from every socket. `start` resolves the conversation
 * with `chat.open` — so the turn knows the session it runs in, and an abort or
 * a push names that session rather than "the canonical one, whichever that is
 * now" — then calls `chat.send` into it (so a bad request throws to the caller
 * before anything is registered), then drains it in the background. Each frame gets a bridge-assigned `n` — 1-based, strictly
 * increasing per turn — and core's own `seq` inside the frame is left alone:
 * it is upstream's per-session counter and means something else.
 *
 * A buffer holds at most `maxFrames`; past that the oldest go and the turn is
 * marked `truncated`, which tells a resuming phone to re-read history once the
 * turn ends. A finished turn is kept for `retentionMs`, then swept.
 *
 * State: `done` when a `done` frame arrived; `aborted` when the bridge was asked
 * to stop it (or the stream simply ended) without one; `error` on an `error`
 * frame or a throw. A throw is turned into an `error` frame so a reader sees
 * why the turn ended.
 *
 * `stopAll` (a bridge shutting down) asks the box to stop every running turn
 * with `chat.abort`, waits a short, bounded while for those to land, then ends
 * the reads: a phone-started turn does not keep spending tokens on a box after
 * the bridge that started it is gone. It is final: a `start` still waiting on
 * `chat.open` when it runs refuses `ABORTED` instead of registering a turn
 * nobody would see or stop, and so does every `start` after it.
 */
import { randomUUID } from "node:crypto";
import { HermeticError, isHermeticError } from "../errors.ts";
import type { ChatFrame, ChatOpenInput, ChatSendInput, TurnSummary } from "../schema/index.ts";
import { redactText } from "../chat/chat-redact.ts";
import { MOBILE_PROTOCOL, type MobileTurnState } from "./protocol.ts";

export interface TurnFrame {
  n: number;
  frame: ChatFrame;
}

export type TurnEvent =
  | { type: "frame"; turn_id: string; n: number; frame: ChatFrame }
  | { type: "end"; turn_id: string; n: number; state: Exclude<MobileTurnState, "running"> };

export type TurnListener = (event: TurnEvent) => void;

export interface TurnStartInput {
  device_id: string;
  instance: string;
  bot: string;
  session?: string | undefined;
  new_session?: boolean | undefined;
  message: string;
}

export interface TurnRegistryDeps {
  /**
   * `chat.open`: the conversation a turn runs in, created when `new_session`
   * asks. `signal` aborts when the registry is stopped mid-open.
   */
  open: (input: ChatOpenInput, opts: { signal: AbortSignal }) => Promise<{ session: string }>;
  send: (input: ChatSendInput, opts: { signal: AbortSignal }) => AsyncIterable<ChatFrame>;
  abort: (input: { instance: string; bot: string; session?: string }) => Promise<unknown>;
  clock?: () => number;
  newId?: () => string;
  maxFrames?: number;
  retentionMs?: number;
  /** Every frame of every turn, after it is buffered (push and fan-out hooks). */
  onFrame?: (turn: TurnSummary, frame: ChatFrame) => void;
  onEnd?: (turn: TurnSummary, info: { reply: string; error: { code: string } | null }) => void;
}

export interface TurnAttach {
  summary: TurnSummary;
  /** `after` fell before the oldest buffered frame of a truncated turn. */
  truncated: boolean;
  /** Frames with `n > after`, then the `end` if the turn is over. */
  replay: TurnEvent[];
  detach(): void;
}

/** How long `stopAll` waits for the box to take its `chat.abort`s. */
export const STOP_ALL_ABORT_MS = 2_000;

export interface TurnRegistry {
  start(input: TurnStartInput): Promise<TurnSummary>;
  /** `null` for an unknown or swept turn. The listener sees only what follows `replay`. */
  attach(turnId: string, after: number, listener: TurnListener): TurnAttach | null;
  /** `false` for an unknown turn or one already over. */
  abort(turnId: string): Promise<boolean>;
  summary(turnId: string): TurnSummary | null;
  /** Running turns and finished ones still within retention. */
  list(): TurnSummary[];
  sweep(): void;
  /** Ask the box to stop every running turn (bounded), end their reads, forget everything. */
  stopAll(opts?: { timeoutMs?: number }): Promise<void>;
}

interface Turn {
  id: string;
  device_id: string;
  instance: string;
  bot: string;
  session: string | null;
  started_at: string;
  state: MobileTurnState;
  frames: TurnFrame[];
  last_n: number;
  truncated: boolean;
  finished_at: number | null;
  listeners: Set<TurnListener>;
  controller: AbortController;
  abortRequested: boolean;
  /** The reply's text so far, for a push preview. Bounded. */
  reply: string;
  error: { code: string } | null;
}

const REPLY_KEEP = 2_000;

function summaryOf(t: Turn): TurnSummary {
  return {
    turn_id: t.id,
    instance: t.instance,
    bot: t.bot,
    session: t.session,
    started_at: t.started_at,
    state: t.state,
    last_n: t.last_n,
    truncated: t.truncated,
    device_id: t.device_id,
  };
}

function appendReply(t: Turn, frame: ChatFrame): void {
  if (frame.type === "delta") t.reply += frame.text;
  else if (frame.type === "block" && frame.block.kind === "text") {
    t.reply += (t.reply === "" ? "" : "\n") + frame.block.markdown;
  }
  if (t.reply.length > REPLY_KEEP) t.reply = t.reply.slice(-REPLY_KEEP);
}

export function createTurnRegistry(deps: TurnRegistryDeps): TurnRegistry {
  const clock = deps.clock ?? (() => Date.now());
  const newId = deps.newId ?? (() => randomUUID());
  const maxFrames = deps.maxFrames ?? MOBILE_PROTOCOL.TURN_MAX_FRAMES;
  const retentionMs = deps.retentionMs ?? MOBILE_PROTOCOL.TURN_RETENTION_MS;
  const turns = new Map<string, Turn>();
  /** Aborted by `stopAll`; nothing starts once it has. */
  const life = new AbortController();

  function refuseStopped(): HermeticError {
    return new HermeticError("ABORTED", "the mobile bridge stopped before the turn started");
  }

  function emit(t: Turn, event: TurnEvent): void {
    for (const listener of [...t.listeners]) {
      try {
        listener(event);
      } catch {
        // One reader that throws must not starve the others or the buffer.
      }
    }
  }

  function push(t: Turn, frame: ChatFrame): void {
    t.last_n += 1;
    const n = t.last_n;
    t.frames.push({ n, frame });
    if (t.frames.length > maxFrames) {
      t.frames.splice(0, t.frames.length - maxFrames);
      t.truncated = true;
    }
    if (frame.type === "done") t.state = "done";
    else if (frame.type === "error" && t.state === "running") {
      t.error = { code: frame.code };
    }
    appendReply(t, frame);
    emit(t, { type: "frame", turn_id: t.id, n, frame });
    try {
      deps.onFrame?.(summaryOf(t), frame);
    } catch {
      /* a hook is a courtesy */
    }
  }

  function finish(t: Turn): void {
    if (t.state === "running") {
      t.state = !t.abortRequested && t.error !== null ? "error" : "aborted";
    }
    t.finished_at = clock();
    const state = t.state as Exclude<MobileTurnState, "running">;
    emit(t, { type: "end", turn_id: t.id, n: t.last_n, state });
    t.listeners.clear();
    try {
      deps.onEnd?.(summaryOf(t), { reply: t.reply, error: t.error });
    } catch {
      /* a hook is a courtesy */
    }
  }

  async function pump(t: Turn, stream: AsyncIterable<ChatFrame>): Promise<void> {
    try {
      for await (const frame of stream) push(t, frame);
    } catch (e) {
      const code = isHermeticError(e) ? e.code : "INTERNAL";
      const message = isHermeticError(e) ? redactText(e.message) : "internal error";
      push(t, { type: "error", code, message });
    } finally {
      finish(t);
    }
  }

  function sweep(): void {
    const now = clock();
    for (const [id, t] of turns) {
      if (t.finished_at !== null && now - t.finished_at > retentionMs) turns.delete(id);
    }
  }

  function abortOnBox(t: Turn): Promise<unknown> {
    return deps.abort({
      instance: t.instance,
      bot: t.bot,
      ...(t.session !== null ? { session: t.session } : {}),
    });
  }

  return {
    async start(input) {
      if (life.signal.aborted) throw refuseStopped();
      sweep();
      const controller = new AbortController();
      // The conversation first: a refusal here is the caller's error, and what
      // it answers is the session every later frame, abort and push names.
      const conversation = await deps.open(
        {
          instance: input.instance,
          bot: input.bot,
          ...(input.session !== undefined ? { session: input.session } : {}),
          ...(input.new_session !== undefined ? { new_session: input.new_session } : {}),
        },
        { signal: life.signal },
      );
      // `stopAll` ran while `chat.open` was out: registering now would leave a
      // turn running that no stop will ever reach.
      if (life.signal.aborted) throw refuseStopped();
      const request: ChatSendInput = {
        instance: input.instance,
        bot: input.bot,
        message: input.message,
        session: conversation.session,
      };
      // Synchronous on purpose: a request core refuses is the caller's error,
      // not a turn that ended at once.
      const stream = deps.send(request, { signal: controller.signal });
      const t: Turn = {
        id: newId(),
        device_id: input.device_id,
        instance: input.instance,
        bot: input.bot,
        session: conversation.session,
        started_at: new Date(clock()).toISOString(),
        state: "running",
        frames: [],
        last_n: 0,
        truncated: false,
        finished_at: null,
        listeners: new Set(),
        controller,
        abortRequested: false,
        reply: "",
        error: null,
      };
      turns.set(t.id, t);
      void pump(t, stream);
      return summaryOf(t);
    },

    attach(turnId, after, listener) {
      const t = turns.get(turnId);
      if (t === undefined) return null;
      const oldest = t.frames[0]?.n ?? t.last_n + 1;
      const truncated = t.truncated && after < oldest - 1;
      const replay: TurnEvent[] = t.frames
        .filter((f) => f.n > after)
        .map((f) => ({ type: "frame", turn_id: t.id, n: f.n, frame: f.frame }));
      if (t.state !== "running") {
        replay.push({ type: "end", turn_id: t.id, n: t.last_n, state: t.state });
      } else {
        t.listeners.add(listener);
      }
      return {
        summary: summaryOf(t),
        truncated,
        replay,
        detach: () => {
          t.listeners.delete(listener);
        },
      };
    },

    async abort(turnId) {
      const t = turns.get(turnId);
      if (t === undefined || t.state !== "running") return false;
      t.abortRequested = true;
      try {
        await abortOnBox(t);
      } catch {
        // The box would not take the stop; ending our read still ends the turn here.
        t.controller.abort();
      }
      return true;
    },

    summary(turnId) {
      const t = turns.get(turnId);
      return t === undefined ? null : summaryOf(t);
    },

    list() {
      sweep();
      return [...turns.values()].map(summaryOf);
    },

    sweep,

    async stopAll(opts = {}) {
      life.abort();
      const running = [...turns.values()].filter((t) => t.state === "running");
      turns.clear();
      for (const t of running) t.abortRequested = true;
      if (running.length > 0) {
        // Best effort: a box that will not answer costs at most the timeout.
        const stops = running.map((t) => Promise.resolve().then(() => abortOnBox(t)));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, opts.timeoutMs ?? STOP_ALL_ABORT_MS);
        });
        await Promise.race([Promise.allSettled(stops), timeout]);
        clearTimeout(timer);
      }
      for (const t of running) t.controller.abort();
    },
  };
}
