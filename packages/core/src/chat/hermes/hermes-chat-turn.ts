/**
 * One turn, as frames: `chat.send` and `chat.abort`, and the whole of the
 * mapping from upstream's event vocabulary onto `ChatFrame`.
 *
 * Two shapes of failure are deliberately not thrown out of the iterable — an
 * unreachable box and a turn that failed on the box both arrive as an `error`
 * frame — because by the time either happens a head has already drawn the
 * bubble that would otherwise be left empty.
 */
import { checkAbort } from "../../abort.ts";
import { HermeticError } from "../../errors.ts";
import {
  CHAT_ERROR_CODES,
  chatError,
  WARM_SLOTS_PER_GATEWAY,
  type BoxAddress,
  type SendOptions,
} from "./hermes-chat-types.ts";
import { hermesActivity, hermesRequest } from "./hermes-chat-activity.ts";
import { approvalBlock, mapUsage, questionBlock, toolBlock } from "./hermes-chat-blocks.ts";
import { createTurnResume, reconnectBlock, type TurnPump } from "./hermes-chat-resume.ts";
import type { Rpc } from "./hermes-chat-rpc.ts";
import { describe, num, rec, scaleSeconds, str } from "./hermes-chat-wire.ts";
import type { createCanonicalSessions } from "../../render/hermes-canonical.ts";
import type { ChatBlock, ChatFrame, ChatStatusState } from "../../schema/index.ts";

/**
 * Events that carry no transcript content and are dropped rather than turned
 * into an `unknown` block.
 *
 * **Every entry here was observed on the wire.** That rule is the whole of the
 * list's design, and it was learned the expensive way: an earlier version also
 * dropped `tool.started`, `tool.generating`, `status.update`, `message.interim`,
 * `session.status` and `session.usage`, every one of them taken from a *list of
 * declared RPC method names* in upstream's source rather than from a frame
 * anybody had seen. `tool.started` and `tool.start` are both declared. If the
 * spelling upstream actually emits is the one on the drop list, every tool call
 * in every transcript disappears silently, and the symptom is a transcript that
 * merely looks a bit thin.
 *
 * Other recognized events are normalized by hermes-chat-activity.ts without
 * discarding their payload. Unfamiliar events survive as unknown blocks.
 * The four below are the four
 * whose frames the probe counted in its single recorded turn (§8 — `gateway.ready`
 * ×1, `session.info` ×2, `session.title` ×2, `sessions.changed` ×5): nine frames
 * of pure chatter around a four-token answer, which is what makes dropping them
 * worth the risk that the list is wrong.
 *
 * Adding an entry means recording a frame first.
 */
const CONTROL_EVENTS = new Set([
  // Observed ×1. Emitted immediately after the socket is accepted. The adapter
  // mints its own status frames instead, so this is redundant rather than new.
  "gateway.ready",
  // Observed ×2. Model, toolsets, cwd, approval mode. Useful, but not a
  // transcript block — and the model it names also rides on `done`'s usage.
  "session.info",
  // Observed ×2. The box renaming the conversation; a head reads titles from
  // `sessions()`.
  "session.title",
  // Observed ×5, for one four-token answer.
  "sessions.changed",
]);

/**
 * `prompt.submit`'s reply, mapped onto a status the transcript can show.
 *
 * Everything upstream names is passed through literally; everything else —
 * including a reply with no `status` at all, which is what an older gateway or
 * a shape change looks like — reads as `submitted`, because the request did
 * come back without an error.
 */
function submitState(status: string | null): ChatStatusState {
  return status === "queued" || status === "redirected" || status === "steered" ? status : "submitted";
}

/** Titles for the states `hermesActivity` does not mint (see `status`). */
const SUBMIT_TITLES: Record<ChatStatusState, string> = {
  connecting: "Connecting to Hermes",
  submitted: "Agent is working",
  queued: "Waiting for the agent",
  redirected: "Redirecting the running turn",
  steered: "Steering the running turn",
};

/** What `createChatTurn` needs, and nothing more. */
export interface ChatTurnDeps {
  connect(box: BoxAddress, signal: AbortSignal | undefined): Promise<Rpc>;
  /** ISO-8601 now, which is also what a turn's minted message id is built from. */
  now: () => string;
  /** The deadline for a turn's first frame, resolved by the caller. */
  waitMs: number;
  /** The canonical Bot Chat session, for an abort that named none. */
  conversation: ReturnType<typeof createCanonicalSessions>["conversation"];
  /**
   * Continuation tuning: the reconnect budget and its sleep, both injected so a
   * test need not spend a real backoff. Defaults are the observation service's
   * (`chat-observe.ts`), because both are bounding the same outage.
   */
  resumeTuning?: ChatResumeTuning | undefined;
}

/** What a caller may tune about a turn's reconnect. */
export interface ChatResumeTuning {
  attempts?: number | undefined;
  baseMs?: number | undefined;
  maxMs?: number | undefined;
  interruptMs?: number | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

export function createChatTurn(deps: ChatTurnDeps) {
  const waitMs = deps.waitMs;
  // One factory per client, because the "this gateway cannot replay" memo it
  // holds has the same answer for every turn against that box.
  const continuation = createTurnResume({ connect: deps.connect, now: deps.now, ...deps.resumeTuning });

  /**
   * One turn, as frames.
   *
   * Two shapes of failure are deliberately *not* thrown out of this iterable.
   * A box that cannot be reached and a turn that fails on the box both yield an
   * `error` frame and end, because by the time either happens the head has
   * already drawn a message bubble, and a rejected async iterator leaves that
   * bubble on screen with nothing in it and nothing to say. `ErrorFrame` exists
   * so a head can tell "off the tailnet" from "no warm slot" from "the model
   * refused" without reading English; this is where that pays.
   */
  function send(
    box: BoxAddress,
    bot: string,
    text: string,
    opts: SendOptions = {},
  ): AsyncIterable<ChatFrame> {
    return turn(box, bot, text, opts);
  }

  // A new turn has no durable ID in the browser yet. Keep its exact runtime
  // address locally so a bot-scoped abort can stop that turn before its first
  // transcript refresh; never infer an address from another profile's roster.
  const activeTurns = new Map<string, Set<{ runtime: string; stored: string | null }>>();
  const turnKey = (box: BoxAddress, bot: string): string => JSON.stringify([box.baseUrl, bot]);

  async function resume(rpc: Rpc, box: BoxAddress, bot: string, stored: string): Promise<string> {
    const result = rec(
      await rpc.request("session.resume", {
        session_id: stored,
        profile: bot,
        defer_history: true,
        omit_messages: true,
      }),
    );
    const runtime = str(result?.session_id);
    if (!runtime)
      throw chatError(
        CHAT_ERROR_CODES.PROTOCOL,
        `${box.instance}: session.resume named no runtime session`,
      );
    return runtime;
  }

  async function* turn(
    box: BoxAddress,
    bot: string,
    text: string,
    opts: SendOptions,
  ): AsyncIterable<ChatFrame> {
    // A message id before the box has named one. Nothing upstream sends carries
    // a message identifier — `message.start` has no id — so the adapter mints
    // one and holds it for the whole turn. It is minted from the injected clock
    // so fixtures are deterministic.
    const message = `${box.instance}:${deps.now()}`;

    // The slot wait, made visible at once (§9.2). `prompt.submit` answers
    // `{"status":"streaming"}` the instant it is accepted and *then* waits up to
    // thirty seconds for one of the gateway's three warm backends. On a laptop
    // that is a pause; on thirteen unattended boxes it is a dead click. A head
    // renders the most recent `chat.status` block and drops it when real content
    // arrives.
    yield status(message, "connecting");

    let rpc: Rpc;
    try {
      rpc = await deps.connect(box, opts.signal);
    } catch (e) {
      yield errorFrame(e);
      return;
    }

    let active: { runtime: string; stored: string | null } | null = null;
    let pump: TurnPump | null = null;
    const key = turnKey(box, bot);
    try {
      let session: string;
      let stored = opts.session ?? null;
      if (opts.session) {
        session = await resume(rpc, box, bot, opts.session);
      } else {
        const created = rec(await rpc.request("session.create", { profile: bot }));
        const runtime = str(created?.session_id);
        if (!runtime)
          throw chatError(
            CHAT_ERROR_CODES.PROTOCOL,
            `${box.instance}: session.create named no runtime session`,
          );
        session = runtime;
        stored = str(created?.stored_session_id);
      }
      active = { runtime: session, stored };
      const entries = activeTurns.get(key) ?? new Set();
      entries.add(active);
      activeTurns.set(key, entries);
      // Before the prompt, because the cursor this turn continues from is the
      // session's sequence *as it was when the turn started*: a baseline taken
      // after the first events had arrived would skip them on a reconnect, and
      // one taken at zero would replay the previous turn as this one.
      pump = continuation.pump({ rpc, box, bot, session });
      const baseline = await pump.probe(opts.signal);
      const submitted = rec(
        await rpc.request("prompt.submit", { session_id: session, profile: bot, text }),
      );
      // Everything the socket delivered before this point — `gateway.ready`,
      // `session.info` — arrived because the socket opened, not because a turn
      // started. The snapshot is what lets the deadline below distinguish "the
      // gateway has not said one word since I asked", which is a warm-slot
      // queue, from "the model is taking its time", which is not.
      const arrivedAtSubmit = rpc.arrived();
      // What the gateway did with the prompt, in its own words. A quiet session
      // answers `streaming`; a busy one answers whatever `display.busy_input_mode`
      // decided, and an operator who typed into a working agent needs to be told
      // which of the three happened rather than a flat "queued" that is wrong
      // two times in three.
      yield status(message, submitState(str(submitted?.status)));
      yield* stream(rpc, pump, session, message, opts.signal, waitMs, arrivedAtSubmit, baseline);
    } catch (e) {
      yield errorFrame(e);
    } finally {
      if (active) {
        const entries = activeTurns.get(key);
        entries?.delete(active);
        if (entries?.size === 0) activeTurns.delete(key);
      }
      // The pump, not `rpc`: a turn that reconnected is holding a socket this
      // scope never opened, and closing the original would leave the live one
      // attached to a gateway nobody is reading.
      if (pump) pump.close();
      else rpc.close();
    }
  }

  /**
   * The event loop, and the whole of the mapping from upstream's vocabulary to
   * `ChatFrame`.
   *
   * Reasoning is buffered rather than streamed. `DeltaFrame` appends to the
   * *last text block* and there is no frame that appends to a reasoning block,
   * so the three thinking/reasoning streams upstream emits are accumulated and
   * flushed as one `reasoning` block the moment anything else arrives. That
   * puts the reasoning ahead of the answer, which is where a reader wants it,
   * and it costs live token-by-token reasoning, which nothing in §9.2 asks
   * for. A separate activity snapshot announces reasoning immediately so
   * heads can animate the thinking phase while its text is still buffered.
   */
  async function* stream(
    rpc: Rpc,
    pump: TurnPump,
    session: string,
    message: string,
    signal: AbortSignal | undefined,
    deadlineMs: number,
    arrivedAtSubmit: number,
    baseline: number,
  ): AsyncIterable<ChatFrame> {
    let reasoning = "";
    let reasoningTokens: number | null = null;
    let reasoningMs: number | null = null;
    let textOpen = false;
    let delivered = "";
    let seenContent = false;
    // The session's sequence when the prompt was submitted, not zero: the
    // dedupe below is also the filter that keeps a replay of *this* turn from
    // dragging the previous one back onto the screen.
    let lastSeq = baseline;

    /**
     * Every block leaves through here, because every block that is not text
     * closes the open paragraph.
     *
     * `DeltaFrame` appends to the *last text block*, so a text block that is
     * still considered open after a tool renders the agent's next sentence
     * above the tool it was commenting on. Text → tool → text is the ordinary
     * shape of a turn, which made this the ordinary case rather than an edge
     * one.
     */
    function* emit(seq: number, block: ChatBlock): Generator<ChatFrame> {
      if (block.kind !== "text") textOpen = false;
      yield { type: "block", seq, message, block };
    }

    function* flushReasoning(seq: number): Generator<ChatFrame> {
      if (!reasoning) return;
      yield {
        type: "block",
        seq,
        message,
        block: {
          kind: "activity",
          category: "generation",
          key: "reasoning",
          title: "Thinking complete",
          state: "done",
          role: "status",
        },
      };
      // A buffer that is character-for-character the answer already streamed is
      // an echo, not thinking. `reasoning.available` produced exactly that on a
      // live box and the fix for it is above; this is the backstop, because the
      // next event to echo the answer will be found the same way — by an
      // operator reading a duplicate paragraph and not knowing which half to
      // believe. A model whose private reasoning is genuinely identical to its
      // reply has said it once, which is enough.
      if (delivered && reasoning === delivered) {
        reasoning = "";
        reasoningTokens = null;
        reasoningMs = null;
        return;
      }
      const block: ChatBlock = {
        kind: "reasoning",
        text: reasoning,
        duration_ms: reasoningMs,
        tokens: reasoningTokens,
      };
      reasoning = "";
      reasoningTokens = null;
      reasoningMs = null;
      yield* emit(seq, block);
    }

    /**
     * Opens the paragraph a `delta` is about to append into.
     *
     * Called **only immediately before a delta**, never on `message.start`.
     * `message.start` used to open one too, on the reasoning that a text block
     * has to exist before a delta can append to it — but a turn that then
     * flushes reasoning closes that block again (see `emit`) and opens a second
     * one when the first delta arrives, so the first is left empty forever. The
     * live wire showed exactly that: `{"kind":"text","markdown":""}` at `seq: 2`,
     * which a renderer draws as an empty bubble above the answer. A turn whose
     * text never arrives at all now produces no text block rather than a blank
     * one.
     */
    function* openText(seq: number): Generator<ChatFrame> {
      if (textOpen) return;
      textOpen = true;
      yield { type: "block", seq, message, block: { kind: "text", markdown: "" } };
    }

    /**
     * Tell the box to stop.
     *
     * Called on every path that abandons a turn, not just on an operator's
     * abort. A turn nobody is reading still holds one of the gateway's three
     * warm backends, still runs whatever tools it was going to run, and still
     * bills the provider — on thirteen unattended boxes that is the difference
     * between a timeout and a bill.
     */
    async function interrupt(): Promise<void> {
      // The pump's, because the socket this turn opened may already be dead —
      // and an abort still owes the box a stop, whichever socket carries it.
      await pump.interrupt().catch(() => null);
    }

    for (;;) {
      // The deadline only guards the wait for the *first* content frame. After
      // that a silence is a tool thinking, and thirty seconds is nothing.
      const step = await pump.next(signal, seenContent ? null : deadlineMs);

      if (step.kind === "reconnecting" || step.kind === "reconnected" || step.kind === "lost") {
        // The reconnect, made visible. `lost` is said before the `done` that
        // follows it, so a head is never left animating a finished reconnect.
        yield { type: "block", seq: lastSeq, message, block: reconnectBlock(step) };
        continue;
      }

      if (step.kind === "aborted") {
        await interrupt();
        // The reasoning buffered so far is flushed first. An operator who
        // pressed stop generally pressed it *because* of what the thinking said,
        // and throwing it away is throwing away the answer to "why did I stop
        // this".
        yield* flushReasoning(lastSeq);
        // Incomplete rather than failed: `ChatMessage.incomplete` is documented
        // for exactly this — aborted, timed out, a reconnect that ran out of
        // attempts — and an operator who pressed stop did not encounter an error.
        yield { type: "done", seq: lastSeq, message, usage: null, incomplete: true };
        return;
      }

      if (step.kind === "timeout") {
        await interrupt();
        yield* flushReasoning(lastSeq);
        const seconds = Math.round(deadlineMs / 1000);
        // `CHAT_NO_SLOT` is a specific claim about *why* nothing came back, and
        // it is only defensible when nothing came back at all. A model that
        // thinks for thirty-one seconds before its first token looks identical
        // from up here, and telling an operator to go and free a warm slot when
        // the gateway was talking the whole time sends them after the wrong
        // problem.
        // Only a turn that never lost its socket can answer this. One that did
        // is counting a different socket's frames — or waited out the deadline
        // reconnecting — and "the gateway sent nothing at all" would then name
        // a warm-slot queue for what was an outage, sending the operator after
        // a problem the box does not have.
        const silent =
          !pump.reconnected() && pump.current() === rpc && rpc.arrived() === arrivedAtSubmit;
        yield {
          type: "error",
          code: silent ? CHAT_ERROR_CODES.NO_SLOT : CHAT_ERROR_CODES.TURN_FAILED,
          message: silent
            ? `no warm backend slot: the gateway sent nothing at all in ${seconds}s, ` +
              "so the box is running its limit of concurrent bots"
            : `the box accepted the prompt but sent no content in ${seconds}s`,
        };
        return;
      }

      if (step.kind === "end") {
        // The pump gave up: either this gateway cannot replay from a cursor, or
        // the reconnect spent its budget, or what came back was not this turn.
        // A lost socket by itself no longer reaches here. Everything already
        // yielded stands; the turn is incomplete, not failed.
        yield* flushReasoning(lastSeq);
        yield { type: "done", seq: lastSeq, message, usage: null, incomplete: true };
        return;
      }

      const ev = step.value;
      const type = str(ev.type);
      if (!type) continue;
      const sourceSeq = num(ev.seq) ?? 0;
      const payload = rec(ev.payload) ?? {};
      if (CONTROL_EVENTS.has(type)) continue;

      const evSession = typeof ev.session_id === "string" ? ev.session_id : null;
      // Reclamation is broadcast globally, but its payload addresses one runtime.
      // A different conversation releasing a slot is not a failure of this turn.
      if (type === "session.reclaimed" && str(payload.session_id) !== session) continue;
      if (evSession !== null && evSession !== "" && evSession !== session) {
        // A subagent turn mirrors the same vocabulary onto a *child* session id.
        // Rendering it inline would interleave two transcripts, and hermetic has
        // no delegated-turn renderer yet — but dropping it means a
        // turn that delegated all its work renders as nothing at all. So it is
        // kept whole, addressed, and left for a head to fold or ignore.
        seenContent = true;
        yield* emit(lastSeq, {
          kind: "unknown",
          name: "subagent",
          payload: { session: evSession, type, seq: sourceSeq, payload: ev.payload ?? null },
        });
        continue;
      }

      // Server requests and global notifications do not share the parent session's
      // event counter. Keep their output at the last parent seq so a head neither
      // drops these blocks nor mistakes the next parent delta for an old replay.
      const unsequenced = type === "hermetic.server_request" || evSession === "";
      const seq = unsequenced ? lastSeq : sourceSeq;
      // `seq` is monotonic per session and exists for reconnect catch-up
      // (upstream's `event_replay.replay_epoch`), so a frame at or below the
      // highest one already handled is a replay. Without this a retransmitted
      // delta doubles a word in the middle of a sentence and nothing notices.
      // Adapter-minted and seq-less frames carry 0 and are never deduplicated.
      if (!unsequenced && seq > 0 && seq <= lastSeq) continue;
      if (!unsequenced && seq > lastSeq) {
        lastSeq = seq;
        // The cursor a reconnect resumes from is the last event actually
        // *applied*, not the last one the socket delivered.
        pump.seen(seq);
      }

      if (type === "hermetic.server_request") {
        seenContent = true;
        yield* flushReasoning(seq);
        for (const block of hermesRequest(
          str(payload.method) ?? "request",
          str(payload.id) ?? "unknown",
          rec(payload.params) ?? {},
        ))
          yield* emit(seq, block);
        continue;
      }
      const activity = hermesActivity(type, payload);
      if (activity) {
        if (type === "tool.generating" || type === "session.usage") seenContent = true;
        // Progress snapshots do not divide a streamed sentence or flush reasoning.
        yield { type: "block", seq, message, block: activity };
        continue;
      }

      switch (type) {
        case "message.start": {
          // The turn is alive, which is all this event says. It deliberately
          // opens no text block — see `openText`.
          seenContent = true;
          yield* flushReasoning(seq);
          break;
        }
        case "message.delta": {
          seenContent = true;
          yield* flushReasoning(seq);
          yield* openText(seq);
          const t = str(payload.text) ?? "";
          if (!t) break;
          delivered += t;
          yield { type: "delta", seq, message, text: t };
          break;
        }
        case "message.interim": {
          seenContent = true;
          yield* flushReasoning(seq);
          const text = str(payload.text);
          if (text && payload.already_streamed !== true)
            yield* emit(seq, { kind: "text", markdown: text });
          textOpen = false;
          break;
        }
        case "thinking.delta":
        case "reasoning.delta": {
          const text = str(payload.text) ?? "";
          if (!text) break;
          seenContent = true;
          if (!reasoning) {
            yield {
              type: "block",
              seq,
              message,
              block: {
                kind: "activity",
                category: "generation",
                key: "reasoning",
                title: "Thinking…",
                state: "running",
                role: "status",
              },
            };
          }
          reasoning += text;
          break;
        }
        case "reasoning.available": {
          /**
           * A signal, and **not a source of reasoning text**.
           *
           * This payload's shape had never been observed, until a live 0.21.3
           * box produced one: its `text` was `"pong"` —
           * the model's *answer*, already streamed as a delta at `seq: 6` — while
           * the genuine reasoning (`"(⊙_⊙) analyzing..."`) had arrived separately
           * as `thinking.delta` and flushed correctly. Reading `text` here
           * therefore reprinted the whole answer a second time, labelled as the
           * model's private thinking, which is worse than losing it: an operator
           * reads a reasoning block as something the model did not intend to say.
           *
           * The two trustworthy sources of reasoning text are `thinking.delta`
           * and `reasoning.delta`, both of which are `{"text": …}` by upstream's
           * own callbacks (`tui_gateway/server.py`, `_agent_cbs`). This event
           * closes the reasoning stream and may carry its accounting; it does not
           * supply its words.
           */
          reasoningTokens = num(payload.tokens);
          reasoningMs = num(payload.duration_ms) ?? scaleSeconds(num(payload.duration_s));
          yield* flushReasoning(seq);
          break;
        }
        case "message.complete": {
          seenContent = true;
          yield* flushReasoning(seq);
          const final = str(payload.text) ?? "";
          // Upstream coalesces deltas on a 33 ms timer and flushes the buffer
          // ahead of any non-streaming frame, so a short, fast answer can arrive
          // entirely inside `message.complete` with no delta before it. That is
          // what this reconciliation is for.
          //
          // It fires **only when the final text extends what was streamed**. An
          // earlier version emitted the whole of `final` whenever `startsWith`
          // failed, which appends the entire answer a second time the moment
          // upstream merely normalises what it already sent — a trimmed lead,
          // rewrapped markdown, a stripped trailing newline. A final text that
          // is shorter than, or simply different from, what the reader already
          // has is upstream restating it, and restating is not new content.
          if (final.length > delivered.length && final.startsWith(delivered)) {
            yield* openText(seq);
            yield { type: "delta", seq, message, text: final.slice(delivered.length) };
          }
          const statusText = str(payload.status);
          const failure = str(payload.error);
          if (statusText === "error" || failure) {
            yield {
              type: "error",
              code: CHAT_ERROR_CODES.TURN_FAILED,
              message: failure ?? "the turn failed on the box",
            };
            return;
          }
          yield {
            type: "done",
            seq,
            message,
            usage: mapUsage(rec(payload.usage)),
            incomplete: statusText !== null && statusText !== "complete" ? true : null,
          };
          return;
        }
        case "tool.start": {
          seenContent = true;
          yield* flushReasoning(seq);
          yield* emit(seq, toolBlock(payload, "running"));
          break;
        }
        case "tool.complete": {
          seenContent = true;
          yield* flushReasoning(seq);
          yield* emit(seq, toolBlock(payload, null));
          break;
        }
        case "approval.request": {
          seenContent = true;
          yield* flushReasoning(seq);
          yield* emit(seq, approvalBlock(payload));
          break;
        }
        case "clarify.request": {
          seenContent = true;
          yield* flushReasoning(seq);
          yield* emit(seq, questionBlock(payload));
          break;
        }
        case "turn.error": {
          yield* flushReasoning(seq);
          yield {
            type: "error",
            code: str(payload.code) ?? CHAT_ERROR_CODES.TURN_FAILED,
            message: str(payload.message) ?? str(payload.error) ?? "the turn failed on the box",
          };
          return;
        }
        default: {
          // §9.2's contract, and the reason a `hermes_ref` bump cannot blank a
          // transcript: an event this build has never heard of is content until
          // proven otherwise, so it survives with its name and its whole payload
          // rather than being dropped on the floor.
          seenContent = true;
          yield* flushReasoning(seq);
          yield* emit(seq, { kind: "unknown", name: type, payload });
          break;
        }
      }
    }
  }

  /* ── abort ──────────────────────────────────────────────────────────────── */

  async function abort(box: BoxAddress, bot: string, opts: SendOptions = {}): Promise<boolean> {
    checkAbort(opts.signal, "chat.abort");
    const entries = [...(activeTurns.get(turnKey(box, bot)) ?? [])];
    const matches = opts.session ? entries.filter((entry) => entry.stored === opts.session) : entries;
    if (matches.length > 1)
      throw new HermeticError("VALIDATION", "chat.abort needs an unambiguous session");
    const stored = matches[0]?.runtime
      ? undefined
      : (opts.session ?? (await deps.conversation(box, bot, opts))?.session);
    if (!matches[0]?.runtime && !stored) return false;
    const rpc = await deps.connect(box, opts.signal);
    try {
      let runtime = matches[0]?.runtime;
      if (!runtime) {
        if (!stored) return false;
        // A separate CLI process has no local turn map. Lazy profile-scoped
        // resume can attach to its durable session without warming a backend.
        // Only an explicitly running, non-watch runtime may then be stopped:
        // interrupting an idle/lazy watch record itself starts a build upstream.
        const result = rec(
          await rpc.request("session.resume", {
            session_id: stored,
            profile: bot,
            lazy: true,
            omit_messages: true,
          }),
        );
        if (!result)
          throw chatError(
            CHAT_ERROR_CODES.PROTOCOL,
            `${box.instance}: resume did not report whether the session is running`,
          );
        /**
         * A live session with no `state.db` row yet — every Bot Chat until its
         * first flush — is answered by upstream's `_resume_live_unpersisted`
         * (`methods_session.py`). Matched on the shape it positively sets, not
         * on a key it happens to omit: `session_id`, `stored_session_id`,
         * `message_count`, `messages` and `info.lazy: True`. `stored_session_id`
         * is what separates it from a child watch, whose payload comes from
         * `_resume_response` and carries `session_key` instead; without the
         * distinction a fresh Bot Chat could not be stopped from a second
         * process and reported a protocol error for a shape upstream documents.
         * It is running by construction — the gateway found it in its own live
         * session table — so there is no `running` flag to read.
         */
        const unpersisted =
          rec(result.info)?.lazy === true && typeof result.stored_session_id === "string";
        if (!unpersisted) {
          if (typeof result.running !== "boolean")
            throw chatError(
              CHAT_ERROR_CODES.PROTOCOL,
              `${box.instance}: resume did not report whether the session is running`,
            );
          if (!result.running) return false;
          if (rec(result.info)?.lazy === true)
            throw new HermeticError(
              "VALIDATION",
              "This is a child watch session; stop its owning turn instead.",
            );
        }
        runtime = str(result.session_id) ?? undefined;
        if (!runtime)
          throw chatError(
            CHAT_ERROR_CODES.PROTOCOL,
            `${box.instance}: resume named no runtime session`,
          );
      }
      await rpc.request("session.interrupt", { session_id: runtime, profile: bot });
      return true;
    } finally {
      rpc.close();
    }
  }

  function status(message: string, state: ChatStatusState): ChatFrame {
    const payload = { state, warm_slots: WARM_SLOTS_PER_GATEWAY };
    // `connecting` and `queued` keep coming from the shared event vocabulary;
    // the three busy-mode states are minted here because they are not a thing
    // the box ever *emits* — they arrive as a reply, not as an event.
    const block: ChatBlock = hermesActivity("chat.status", payload) ?? {
      kind: "activity",
      category: "queue",
      key: "queue",
      title: SUBMIT_TITLES[state],
      state: "running",
      detail: null,
      role: "status",
      payload,
    };
    return {
      type: "block",
      // Adapter-minted frames carry `seq: 0`: upstream's sequence is per session
      // and starts above zero, so zero is unambiguously "this came from here".
      seq: 0,
      message,
      block,
    };
  }

  function errorFrame(e: unknown): ChatFrame {
    const code = e instanceof HermeticError ? String(e.code) : CHAT_ERROR_CODES.PROTOCOL;
    return { type: "error", code, message: describe(e) };
  }
  return { send, abort };
}
