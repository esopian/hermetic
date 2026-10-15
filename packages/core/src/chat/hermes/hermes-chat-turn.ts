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
import { isHermesInternalEvent } from "../../shared/hermes-internal-events.ts";
import {
  CHAT_ERROR_CODES,
  chatError,
  WARM_SLOTS_PER_GATEWAY,
  type BoxAddress,
  type ChatSteerStatus,
  type SendOptions,
} from "./hermes-chat-types.ts";
import { createConnectionGate, hermesActivity, hermesRequest } from "./hermes-chat-activity.ts";
import { chatFailure, contextUsageBlock, mapUsage, toolBlock } from "./hermes-chat-blocks.ts";
import { createTurnResume, reconnectBlock, type TurnPump } from "./hermes-chat-resume.ts";
import { advertiseServerRequests, type Rpc } from "./hermes-chat-rpc.ts";
import { attachToTurn, detachQueued } from "./hermes-chat-attach.ts";
import {
  turnFileRequests,
  type FileRequestLookupDeps,
  type TurnFileRequests,
} from "./hermes-chat-file-requests.ts";
import {
  createMediaHold,
  outboxOnce,
  shareChip,
  type ListOutbox,
  type MediaPiece,
} from "./hermes-chat-media.ts";
import type { SessionLease, SessionSockets } from "./hermes-chat-session-socket.ts";
import { isSubagentEvent } from "./hermes-chat-subagent.ts";
import {
  createSubagentLedgers,
  subagentTurn,
  type SubagentLedgers,
} from "./hermes-chat-subagent-ledgers.ts";
import { HERMETIC_SESSION_SOURCE, describe, num, rec, scaleSeconds, str } from "./hermes-chat-wire.ts";
import type { createCanonicalSessions } from "../../render/hermes-canonical.ts";
import type { ChatBlock, ChatFrame, ChatStatusState, FileEntry } from "../../schema/index.ts";

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

/** Upstream's "agent does not support active-turn redirect" (`methods_session.py`). */
const REDIRECT_UNSUPPORTED = 4010;

/** An error frame, with `failure` always filled (and its surface when upstream sent one). */
function fail(code: string, message: string, surface?: unknown): ChatFrame {
  return { type: "error", code, message, failure: chatFailure(code, message, surface) };
}

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
  /**
   * The client's per-session subagent ledgers, shared with the observation
   * and child control so a delegation outlives the turn that started it.
   * Absent gives this turn factory a private set.
   */
  subagents?: SubagentLedgers | undefined;
  /**
   * The box's files request slots, read to give a running `request_file` /
   * `request_secret` card the slot it opened. Absent, such a card waits for
   * the result to name its slot.
   */
  fileRequests?: FileRequestLookupDeps | undefined;
  /**
   * The box's outbox listing, read at most once per turn to describe the
   * chip a `MEDIA:` outbox line becomes (`hermes-chat-media.ts`). Absent, the
   * chip carries `bytes: 0` and no digest.
   */
  listOutbox?: ListOutbox | undefined;
  /**
   * The client's held session sockets (`hermes-chat-session-socket.ts`): a
   * conversation keeps one socket across turns, so the gateway never reaps the
   * session — and the background processes it owns — between them.
   */
  sockets: SessionSockets;
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
  // A reconnect's socket is a shared one too, so a turn that ends on it can
  // hand it to the conversation's hold — and, like a lease's, it is dialled
  // detached from the turn's signal, which the app aborts once the turn ends.
  const continuation = createTurnResume({
    connect: deps.sockets.connect,
    now: deps.now,
    ...deps.resumeTuning,
  });
  const subagents = deps.subagents ?? createSubagentLedgers({ now: deps.now });

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

  async function resume(
    rpc: Rpc,
    box: BoxAddress,
    bot: string,
    stored: string,
    signal: AbortSignal | undefined,
  ): Promise<{ runtime: string; info: Record<string, unknown> | null }> {
    const result = rec(
      await rpc.request(
        "session.resume",
        {
          session_id: stored,
          profile: bot,
          source: HERMETIC_SESSION_SOURCE,
          defer_history: true,
          omit_messages: true,
        },
        undefined,
        { signal },
      ),
    );
    const runtime = str(result?.session_id);
    if (!runtime)
      throw chatError(
        CHAT_ERROR_CODES.PROTOCOL,
        `${box.instance}: session.resume named no runtime session`,
      );
    return { runtime, info: rec(result?.info) };
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

    // The conversation's held socket when it has one, else a fresh dial that
    // the session's ids below turn into the hold. Never closed here: the
    // `finally` hands it back, and the socket stays attached to the session.
    // Neither kind closes when `opts.signal` aborts, so every request below
    // carries the signal itself.
    let lease: SessionLease;
    try {
      lease = await deps.sockets.lease(box, bot, opts.session ?? null, opts.signal);
    } catch (e) {
      yield errorFrame(e);
      return;
    }
    const rpc: Rpc = lease.rpc;

    let active: { runtime: string; stored: string | null } | null = null;
    /** Images this turn queued on the session; taken back unless the prompt was accepted. */
    const queued = new Set<string>();
    let accepted = false;
    let pump: TurnPump | null = null;
    let delegation: ReturnType<typeof subagentTurn> | null = null;
    let requests: TurnFileRequests | null = null;
    // Whether the box may be running this turn, and whether a frame has said
    // it is over: between the two, a turn that stops being read owes the box a
    // `session.interrupt` (see `stopBox`).
    let prompted = false;
    let ended = false;
    const key = turnKey(box, bot);
    /**
     * Tell the box to stop a turn this scope is leaving unfinished.
     *
     * The stream's own abort and timeout paths interrupt before they end; this
     * covers the ones that never reach it — an abort while `prompt.submit`
     * awaits its reply, which surfaces as a thrown `ABORTED`, and a consumer
     * that stops iterating mid-stream. On a held socket nothing else stops the
     * turn: the socket stays attached, so the gateway's orphan reap that used
     * to end an abandoned turn never comes.
     */
    async function stopBox(): Promise<void> {
      if (!prompted || ended) return;
      ended = true;
      await pump?.interrupt().catch(() => null);
    }
    try {
      // Before the session exists, so the gateway already counts this socket
      // as one that answers prompts when the turn's first approval arrives.
      // Sent on a held socket too: it is idempotent, and cheap.
      await advertiseServerRequests(rpc, opts.signal);
      let session: string;
      let stored = opts.session ?? null;
      let info: Record<string, unknown> | null;
      if (opts.session) {
        // On a held socket as well as a fresh one: this is the re-attach, and
        // its `info` is what `contextUsageBlock` reads below.
        ({ runtime: session, info } = await resume(rpc, box, bot, opts.session, opts.signal));
        lease.keep(opts.session, session);
      } else {
        // Stamped so `session.list` can tell this session from the box's own TUI
        // (`HERMETIC_SESSION_SOURCE`); `portal` still comes only from the local record.
        const created = rec(
          await rpc.request(
            "session.create",
            { profile: bot, source: HERMETIC_SESSION_SOURCE },
            undefined,
            { signal: opts.signal },
          ),
        );
        const runtime = str(created?.session_id);
        if (!runtime)
          throw chatError(
            CHAT_ERROR_CODES.PROTOCOL,
            `${box.instance}: session.create named no runtime session`,
          );
        session = runtime;
        stored = str(created?.stored_session_id);
        info = rec(created?.info);
        // A create that names no durable id leaves nothing to hold the socket
        // under, and the turn closes it on the way out as it always did.
        if (stored) lease.keep(stored, runtime);
      }
      // The window the gateway already holds for this session, said before the
      // prompt goes in. A session still live on the box answers its resume with
      // the figure its last turn left (`contextUsageBlock`), so the composer's
      // meter is right from the turn's first frame instead of from its first
      // tick. Adapter-minted, so `seq: 0`, like the status frames.
      const known = contextUsageBlock(info);
      if (known) yield { type: "block", seq: 0, message, block: known };
      active = { runtime: session, stored };
      // Registered now, before the prompt: a background delegation's children
      // may first report after this turn has ended, on the observation stream,
      // which can only attribute them to a session somebody registered.
      delegation = subagentTurn(subagents, { box, bot, runtime: session, stored });
      const entries = activeTurns.get(key) ?? new Set();
      entries.add(active);
      activeTurns.set(key, entries);
      // Before the prompt, because the cursor this turn continues from is the
      // session's sequence *as it was when the turn started*: a baseline taken
      // after the first events had arrived would skip them on a reconnect, and
      // one taken at zero would replay the previous turn as this one.
      // Committed, framed and queued before the cursor is taken: nothing here
      // writes an event to the session, and everything here can fail.
      const prompt = opts.attachments?.ids.length
        ? await attachToTurn({
            rpc,
            instance: box.instance,
            session,
            commitSession: stored ?? session,
            attachments: opts.attachments,
            message: text,
            signal: opts.signal,
            queued,
          })
        : text;
      pump = continuation.pump({ rpc, box, bot, session });
      const baseline = await pump.probe(opts.signal);
      // Checked here rather than left to the request: on a gateway that cannot
      // replay, `probe` sends nothing and never looks at the signal, so an
      // abort that landed while the consumer paused above would surface as a
      // rejected `prompt.submit` that was never sent — and `stopBox` would then
      // interrupt a session this prompt never reached, which may be running
      // the gateway's own reply to a finished background process.
      checkAbort(opts.signal, "prompt.submit");
      prompted = true;
      const submitted = rec(
        await rpc.request(
          "prompt.submit",
          { session_id: session, profile: bot, text: prompt },
          undefined,
          {
            signal: opts.signal,
          },
        ),
      );
      accepted = true;
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
      requests = turnFileRequests(deps.fileRequests, {
        box,
        sessions: [session, stored],
        signal: opts.signal,
      });
      for await (const frame of stream(
        rpc,
        pump,
        session,
        message,
        opts.signal,
        waitMs,
        arrivedAtSubmit,
        baseline,
        delegation,
        requests,
        outboxOnce(deps.listOutbox, box.instance, opts.signal),
      )) {
        if (frame.type === "done" || frame.type === "error") ended = true;
        yield frame;
      }
    } catch (e) {
      // Once the prompt is in, every failure but the gateway's own refusal
      // leaves the box running a turn nobody reads: an abort, a reply that
      // timed out, a socket that died. The held socket no longer closes, so
      // the orphan reap that used to end such a turn never comes — the box has
      // to be told. A refusal (a JSON-RPC error reply, `details.code`) is the
      // one case where nothing started, and an interrupt would stop whatever
      // else the session is doing.
      if (!refused(e)) await stopBox();
      ended = true;
      yield errorFrame(e);
    } finally {
      // A consumer that stopped reading before the turn's last frame.
      await stopBox();
      // Before the socket is released: upstream keeps a session's image queue
      // across an interrupt, so an image left there rides along with the next
      // prompt. The held socket outlives a stop, but it may have died with the
      // turn, so the detach may need a connection of its own (`detachQueued`).
      if (!accepted && active && queued.size > 0) {
        await detachQueued({
          rpc,
          live: true,
          reconnect: (signal) => deps.connect(box, signal),
          session: active.runtime,
          paths: [...queued],
        });
      }
      delegation?.close();
      requests?.close();
      if (active) {
        const entries = activeTurns.get(key);
        entries?.delete(active);
        if (entries?.size === 0) activeTurns.delete(key);
      }
      // Released, not closed: the socket stays attached so the gateway never
      // reaps the session between turns. The pump's socket rather than `rpc`,
      // because a turn that reconnected ends on a socket this scope never
      // opened, and that is the one the hold must keep.
      lease.release(pump ? pump.detach() : rpc);
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
    delegation: ReturnType<typeof subagentTurn>,
    requests: TurnFileRequests,
    outbox: (refresh?: boolean) => Promise<readonly FileEntry[] | null>,
  ): AsyncIterable<ChatFrame> {
    let reasoning = "";
    let reasoningTokens: number | null = null;
    let reasoningMs: number | null = null;
    let textOpen = false;
    let delivered = "";
    // The paragraph being streamed, with its `MEDIA:` lines held back until it
    // ends (`hermes-chat-media.ts`).
    const media = createMediaHold();
    // Whether the outbox listing was read for an earlier settle, and so may
    // predate a share the plugin made since (`emitPieces`).
    let listedEarlier = false;
    let seenContent = false;
    // The session's sequence when the prompt was submitted, not zero: the
    // dedupe below is also the filter that keeps a replay of *this* turn from
    // dragging the previous one back onto the screen.
    let lastSeq = baseline;
    // Connection-request notices replace by key, so an update older than the
    // one shown (a replay, the resume snapshot) must not reach a head.
    const connections = createConnectionGate();

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

    /**
     * The buffered reasoning, as one block. That block closes the open
     * paragraph, so the paragraph first lets go of what it held: otherwise
     * the held tail would land below the reasoning that followed it.
     */
    async function* flushReasoning(seq: number): AsyncGenerator<ChatFrame> {
      if (!reasoning) return;
      yield* flushMedia(seq, "cut");
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
     * Held text and outbox shares, in order: text appended as deltas, each
     * share as an `attachment` block described from the turn's outbox read
     * (`shareChip`: none for a share the listing answered without). A listing
     * read for an earlier settle may predate this one's shares, so a miss
     * against it reads the outbox once more before the chip is dropped.
     */
    async function* emitPieces(seq: number, pieces: readonly MediaPiece[]): AsyncGenerator<ChatFrame> {
      let stale = listedEarlier;
      for (const piece of pieces) {
        if (piece.kind === "text") {
          if (!piece.text) continue;
          yield* openText(seq);
          yield { type: "delta", seq, message, text: piece.text };
          continue;
        }
        // A stopped turn does not wait on the box to describe a chip.
        if (signal?.aborted) {
          const chip = shareChip(piece, null);
          if (chip) yield* emit(seq, chip);
          continue;
        }
        let listed = await outbox();
        listedEarlier = true;
        if (stale && listed && !listed.some((e) => e.id === piece.share_id)) {
          listed = await outbox(true);
          stale = false;
        }
        const chip = shareChip(piece, listed);
        if (chip) yield* emit(seq, chip);
      }
    }

    /**
     * A paragraph that ended without a final lets go of what it held, read the
     * same way a transcript is. Called before anything that closes the
     * paragraph. `end` (the default) when the message is over — a tool call, a
     * request, an interim message or the turn's end came next; `cut` when a
     * block inside the same message closed it (reasoning, a subagent's event,
     * an unknown event), so the message's final still settles against every
     * word it already showed and never repeats one.
     */
    async function* flushMedia(seq: number, how: "end" | "cut" = "end"): AsyncGenerator<ChatFrame> {
      const pieces = how === "cut" ? media.cut() : media.end();
      if (pieces.length > 0) yield* emitPieces(seq, pieces);
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

    let next: ReturnType<TurnPump["next"]> | null = null;
    for (;;) {
      // The deadline only guards the wait for the *first* content frame. After
      // that a silence is a tool thinking, and thirty seconds is nothing.
      next ??= pump.next(signal, seenContent ? null : deadlineMs);
      // A request card's slot, found on the box while its tool still runs, is
      // the same card again with its id — sent as it is found, not when the
      // next event happens to arrive. Not through `emit`: it updates a card
      // already drawn, so it must not close the open paragraph.
      const raced = await requests.race(next);
      if ("block" in raced) {
        yield { type: "block", seq: lastSeq, message, block: raced.block };
        continue;
      }
      next = null;
      const step = raced.step;

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
        // Likewise the words a `MEDIA:` line held back.
        yield* flushMedia(lastSeq);
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
        yield fail(
          silent ? CHAT_ERROR_CODES.NO_SLOT : CHAT_ERROR_CODES.TURN_FAILED,
          silent
            ? `no warm backend slot: the gateway sent nothing at all in ${seconds}s, ` +
                "so the box is running its limit of concurrent bots"
            : `the box accepted the prompt but sent no content in ${seconds}s`,
        );
        return;
      }

      if (step.kind === "end") {
        // The pump gave up: either this gateway cannot replay from a cursor, or
        // the reconnect spent its budget, or what came back was not this turn.
        // A lost socket by itself no longer reaches here. Everything already
        // yielded stands; the turn is incomplete, not failed.
        yield* flushReasoning(lastSeq);
        yield* flushMedia(lastSeq);
        yield { type: "done", seq: lastSeq, message, usage: null, incomplete: true };
        return;
      }

      const ev = step.value;
      const type = str(ev.type);
      if (!type) continue;
      const sourceSeq = num(ev.seq) ?? 0;
      const payload = rec(ev.payload) ?? {};
      const evSession = typeof ev.session_id === "string" ? ev.session_id : null;
      // `session.info` is chatter except for its usage's context window, which
      // is the one figure the meter can have before the turn's first tick.
      // Only this session's: a subagent's window is not the conversation's.
      const infoUsage =
        type === "session.info" && (evSession === null || evSession === session)
          ? contextUsageBlock(payload)
          : null;
      // The gateway's internal signals (`shared/hermes-internal-events.ts`) are
      // dropped here, before seq bookkeeping and before `seenContent`, so they
      // never become `unknown` blocks and never satisfy the first-frame
      // deadline. The list is what Hermes Desktop consumes without drawing
      // anything, cited from Desktop's source — not upstream's declared method
      // names: an earlier drop list built from declared names held
      // `tool.started` and `status.update`, and a dropped spelling that
      // upstream really emits makes every tool call vanish silently. Anything
      // unlisted is mapped by hermes-chat-activity.ts or survives as `unknown`.
      // It also runs before the child-session `subagent` wrap below, so a
      // listed event from a child session is dropped too, by intent.
      if (isHermesInternalEvent(type) && !infoUsage) continue;

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
        // The block closes the open paragraph, so its held tail goes first.
        yield* flushMedia(lastSeq, "cut");
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
      // A resume snapshot the pump turned back into an event (`pending_connection`)
      // is marked the same way: it is state, not a step in the session's log.
      const unsequenced =
        type === "hermetic.server_request" || evSession === "" || ev.unsequenced === true;
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
        yield* flushMedia(seq);
        for (const block of hermesRequest(
          str(payload.method) ?? "request",
          str(payload.id) ?? "unknown",
          rec(payload.params) ?? {},
        ))
          yield* emit(seq, block);
        continue;
      }
      if (infoUsage) {
        // A status snapshot, not content: the session describing itself says
        // nothing about whether the model has started, so the first-frame
        // deadline keeps running.
        yield { type: "block", seq, message, block: infoUsage };
        continue;
      }
      if (isSubagentEvent(type)) {
        // A delegated child, on the parent session: through the session's
        // ledger and out as the child's whole block, so a head's
        // replace-by-key merge is the whole reducer. A progress snapshot, like
        // an activity: it neither divides a streamed sentence nor flushes
        // reasoning. An event for a child the ledger never saw start, or one
        // already finished, changes nothing and emits nothing.
        seenContent = true;
        const child = delegation.event(type, payload, unsequenced ? 0 : seq);
        if (child) yield { type: "block", seq, message, block: child };
        continue;
      }
      if (connections.stale(type, payload)) continue;
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
          const t = str(payload.text) ?? "";
          if (!t) {
            yield* openText(seq);
            break;
          }
          delivered += t;
          // A `MEDIA:` line, and the rest of its paragraph, wait for the final.
          const shown = media.push(t);
          if (!shown) break;
          yield* openText(seq);
          yield { type: "delta", seq, message, text: shown };
          break;
        }
        case "message.interim": {
          seenContent = true;
          yield* flushReasoning(seq);
          yield* flushMedia(seq);
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
          // Reasoning still buffered here arrived after this paragraph began
          // streaming, when there is one, so it follows the paragraph's settled
          // tail; otherwise it leads the answer, as it always does.
          const streamed = media.raw() !== "";
          if (!streamed) yield* flushReasoning(seq);
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
          const extension =
            final.length > delivered.length && final.startsWith(delivered)
              ? final.slice(delivered.length)
              : "";
          const statusText = str(payload.status);
          const failure = str(payload.error);
          // A plugin's `transform_llm_output` hook may rewrite the reply after
          // it streamed — the files plugin turns `MEDIA:/abs/path` into an
          // outbox line — and upstream then marks this text the authoritative
          // replacement for the message (`prompt_turn.py`). It settles against
          // everything the message already showed, so only the held tail and
          // anything new is emitted: its outbox lines as chips, the rest as text.
          const transformed =
            payload.response_transformed === true && statusText !== "error" && !failure;
          yield* emitPieces(seq, media.settle(transformed ? final : media.raw() + extension));
          if (streamed) yield* flushReasoning(seq);
          if (statusText === "error" || failure) {
            // Upstream's classified surface rides beside the error text
            // (`prompt_turn.py`), so a head can offer the recovery that fits.
            yield fail(
              CHAT_ERROR_CODES.TURN_FAILED,
              failure ?? "the turn failed on the box",
              payload.error_surface,
            );
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
        case "tool.start":
        case "tool.complete": {
          seenContent = true;
          yield* flushReasoning(seq);
          yield* flushMedia(seq);
          const mapped = toolBlock(payload, type === "tool.start" ? "running" : null);
          const tool = mapped.kind === "tool" ? requests.tool(mapped) : mapped;
          // A `delegate_task` call is what its children are matched against.
          delegation.tool(tool);
          yield* emit(seq, tool);
          break;
        }
        case "turn.error": {
          yield* flushReasoning(seq);
          yield* flushMedia(seq);
          yield fail(
            str(payload.code) ?? CHAT_ERROR_CODES.TURN_FAILED,
            str(payload.message) ?? str(payload.error) ?? "the turn failed on the box",
            payload.error_surface,
          );
          return;
        }
        default: {
          // §9.2's contract, and the reason a `hermes_ref` bump cannot blank a
          // transcript: an event this build has never heard of is content until
          // proven otherwise, so it survives with its name and its whole payload
          // rather than being dropped on the floor.
          seenContent = true;
          yield* flushReasoning(seq);
          yield* flushMedia(seq, "cut");
          yield* emit(seq, { kind: "unknown", name: type, payload });
          break;
        }
      }
    }
  }

  /* ── abort ──────────────────────────────────────────────────────────────── */

  /**
   * The runtime session of the turn in flight on `bot`, on a socket the caller
   * then owns, or null when nothing is running there.
   *
   * Shared by `abort` and `steer`, because both must find the same turn the
   * same way: this process's own turn map first, and only then a lazy
   * profile-scoped resume of the durable session — a separate CLI process has
   * no turn map, and a lazy resume attaches without warming a backend.
   *
   * A conversation this process holds a socket for is reached on that socket,
   * which is already attached; `release` leaves it open. Anything else is a
   * socket dialled for the call, which `release` closes.
   */
  async function runningTurn(
    box: BoxAddress,
    bot: string,
    method: string,
    opts: SendOptions,
  ): Promise<{ rpc: Rpc; runtime: string; release(): void } | null> {
    const entries = [...(activeTurns.get(turnKey(box, bot)) ?? [])];
    const matches = opts.session ? entries.filter((entry) => entry.stored === opts.session) : entries;
    if (matches.length > 1)
      throw new HermeticError("VALIDATION", `${method} needs an unambiguous session`);
    const stored = matches[0]?.runtime
      ? undefined
      : (opts.session ?? (await deps.conversation(box, bot, opts))?.session);
    if (!matches[0]?.runtime && !stored) return null;
    const holdKey = matches[0]?.stored ?? stored;
    const held = holdKey ? deps.sockets.peek(box, bot, holdKey) : null;
    // A local turn's runtime is only reached on the hold when the hold is
    // attached to that same runtime.
    const shared = held && (!matches[0]?.runtime || held.runtime === matches[0].runtime) ? held : null;
    const rpc: Rpc = shared ? shared.rpc : await deps.connect(box, opts.signal);
    const release = (): void => {
      if (!shared) rpc.close();
    };
    try {
      let runtime = matches[0]?.runtime;
      if (!runtime) {
        if (!stored) {
          release();
          return null;
        }
        // A separate CLI process has no local turn map. Lazy profile-scoped
        // resume can attach to its durable session without warming a backend.
        // Only an explicitly running, non-watch runtime may then be stopped:
        // interrupting an idle/lazy watch record itself starts a build upstream.
        const result = rec(
          await rpc.request("session.resume", {
            session_id: stored,
            profile: bot,
            source: HERMETIC_SESSION_SOURCE,
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
          if (!result.running) {
            release();
            return null;
          }
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
      return { rpc, runtime, release };
    } catch (e) {
      release();
      throw e;
    }
  }

  async function abort(box: BoxAddress, bot: string, opts: SendOptions = {}): Promise<boolean> {
    checkAbort(opts.signal, "chat.abort");
    const found = await runningTurn(box, bot, "chat.abort", opts);
    if (!found) return false;
    try {
      await found.rpc.request("session.interrupt", { session_id: found.runtime, profile: bot });
      return true;
    } finally {
      found.release();
    }
  }

  /* ── steer ──────────────────────────────────────────────────────────────── */

  /**
   * Put `text` into the turn in flight without stopping it: upstream's
   * `session.redirect` (`methods_session.py`), which cancels the current model
   * request and rebuilds the turn with the correction, keeping the work done,
   * or waits for the running tool. A turn still being built is answered
   * `queued` — the gateway holds the text for the next turn.
   *
   * A bot with no running turn is `idle` and nothing is sent: a redirect into
   * an idle session would start one. 4010 (this agent cannot redirect an active
   * turn) is `rejected` rather than a throw, because to the operator it is the
   * same outcome as the gateway declining — the text was not applied — and the
   * head offers the same next step for both.
   */
  async function steer(
    box: BoxAddress,
    bot: string,
    text: string,
    opts: SendOptions = {},
  ): Promise<ChatSteerStatus> {
    checkAbort(opts.signal, "chat.steer");
    const found = await runningTurn(box, bot, "chat.steer", opts);
    if (!found) return "idle";
    try {
      const reply = rec(
        await found.rpc.request("session.redirect", {
          session_id: found.runtime,
          profile: bot,
          text,
        }),
      );
      const status = str(reply?.status);
      return status === "redirected" || status === "queued" ? status : "rejected";
    } catch (e) {
      if (e instanceof HermeticError && e.details?.code === REDIRECT_UNSUPPORTED) return "rejected";
      throw e;
    } finally {
      found.release();
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

  /** A JSON-RPC error reply: the gateway answered, and the answer was no. */
  function refused(e: unknown): boolean {
    return e instanceof HermeticError && typeof e.details?.code === "number";
  }

  function errorFrame(e: unknown): ChatFrame {
    const code = e instanceof HermeticError ? String(e.code) : CHAT_ERROR_CODES.PROTOCOL;
    return fail(code, describe(e));
  }
  return { send, abort, steer };
}
