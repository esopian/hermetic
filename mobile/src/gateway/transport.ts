/**
 * The stores' transport, over core's Hermes adapter: what the conversation
 * store (`ConversationTransport`) and the roster (`RosterSource`) ask for,
 * answered by talking to each box's gateway directly.
 *
 * The composition mirrors the desktop's `packages/core/src/chat/chat.ts`
 * (`history`, `sessions`, `steer`, `abort`, the Bot Mode lifecycle) and
 * `chat-send.ts` (resolve the conversation first, then send into its session;
 * `/new`, `/reset` and `/compact` in Bot Chat compact instead), without the
 * laptop's own parts: no local claim on sessions, no fence, no inbox. The
 * transcript mask is `transcriptMask(DEFAULT_CHAT_SETTINGS.redact)`, the
 * desktop's default — content as the box wrote it, failure text always masked
 * — applied where the desktop applies it: every frame, every history row,
 * every roster and session list.
 *
 * Observation is core's `createChatObservation`, wired the way
 * `chat-observe-wiring.ts` wires it: `history` for the authoritative snapshot,
 * the adapter's `observe` for hints, and a per-box record of hint channels
 * shown not to deliver so a gateway that never broadcasts is polled instead.
 *
 * No React, no React Native, no Expo: the root e2e test runs this under bun.
 */
import {
  type BoxAddress,
  type ChatConversation,
  type ChatFrame,
  type ChatObserveEvent,
  type ChatObserveHint,
  type ChatObserveOptions,
  type ChatObserveTarget,
  createChatObservation,
  DEFAULT_CHAT_SETTINGS,
  HermeticError,
  type HermesChatClient,
  OBSERVE_RECONNECT_ATTEMPTS,
  OBSERVE_WINDOW,
  redactText,
  type SubagentBlock,
  type Swarm,
  type TranscriptMask,
  transcriptMask,
} from "@hermetic/core/chat-client";
import type {
  AbortResult,
  HistoryResult,
  RespondResult,
  SessionsResult,
  SteerResult,
  TurnRequest,
  TurnStartResult,
  TurnState,
} from "../client/chat-types.ts";
import type {
  ConversationTarget,
  ConversationTransport,
  Failure,
} from "../client/conversation-store.ts";
import { reasonOf } from "../client/errors.ts";
import { type LiveRow, liveRowOf } from "./active-list.ts";
import type { RosterSource } from "../client/roster-store.ts";

/** Where the turn pump delivers: the conversation store's turn events. */
export interface TurnSink {
  frame(turn_id: string, n: number, frame: ChatFrame): void;
  end(turn_id: string, state: TurnState): void;
  /** Ended without `done` or an error: the store re-reads the transcript. */
  gone(turn_id: string): void;
  /** The session the turn was sent into, once resolved (a first message creates Bot Chat). */
  session?(turn_id: string, session: string): void;
}

export interface GatewayTransportDeps {
  client: HermesChatClient;
  /** The box for an instance; throws (`VALIDATION`) for one this phone does not know. */
  address(instance: string): BoxAddress;
  /** The instances this phone listens to (phone-local). */
  listening(): readonly string[];
  /** Change one instance's listening; answers the new list. */
  setListening(instance: string, listening: boolean): Promise<readonly string[]> | readonly string[];
  /** The conversation store's turn events, read late so the store can be built after this. */
  turns: () => TurnSink;
  /** ISO-8601 now. */
  now: () => string;
  /** A fresh turn id (defaults to a counter plus the clock). */
  mintTurnId?: () => string;
  /** Defaults to the desktop's default mask. */
  mask?: TranscriptMask;
  /** Observation tuning, for tests. */
  observeTuning?: {
    pollMs?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    reconnect?: { attempts?: number; baseMs?: number; maxMs?: number };
  };
}

/** Bot Mode lifecycle and subagent control the screens call beside the store. */
export interface GatewayOps {
  /** `chat.open`: the canonical conversation, or a new thread with `new_session`. */
  open(input: {
    instance: string;
    bot: string;
    session?: string;
    new_session?: boolean;
  }): Promise<ChatConversation>;
  compact(input: { instance: string; bot: string; session?: string }): Promise<unknown>;
  archive(input: { instance: string; bot: string; session: string }): Promise<unknown>;
  /** `chat.steer` with `subagent_id`: steer one delegated child. */
  steerSubagent(input: {
    instance: string;
    bot: string;
    session?: string | null;
    subagent_id: string;
    text: string;
  }): Promise<SteerResult>;
  /** `chat.abort` with `subagent_id`: stop one delegated child. */
  abortSubagent(input: {
    instance: string;
    bot: string;
    session?: string | null;
    subagent_id: string;
  }): Promise<AbortResult>;
}

export interface GatewayTransport extends ConversationTransport, RosterSource, GatewayOps {
  /**
   * `session.active_list` on `instance`'s box, read for `session` (or its live
   * id `runtime`, once known; `liveRowOf`): its status there now and its live
   * id, or `null` when the box lists no such live session. Throws when the
   * gateway cannot say (no Bot Mode RPC, an unreadable answer, no answer).
   */
  liveStatus(input: {
    instance: string;
    session: string;
    runtime?: string | null;
    signal?: AbortSignal;
  }): Promise<LiveRow | null>;
  /**
   * Stop following every running turn (`forgetTurn` on each) and answer their
   * ids. The turns keep running on their boxes: nothing is interrupted. The
   * caller tells the store each one is gone (`onTurnGone`) when it wants the
   * transcript re-read — the client does on its return to the foreground.
   */
  detachTurns(): string[];
  /**
   * `detachTurns`, with each turn's start (`since`, ISO-8601, this phone's
   * clock): a turn followed afterwards with no live id to match on is
   * confirmed over only by a transcript row written after it started.
   */
  detachTurnsSince(): DetachedTurn[];
  /**
   * Stop every turn pump and observation this transport started. Turns are
   * detached, never interrupted: a running turn keeps running on its box.
   */
  dispose(): void;
}

/** A turn let go by `detachTurnsSince`, with when it was started. */
export interface DetachedTurn {
  turn_id: string;
  since: string;
}

/** A turn the pump is following. */
interface TurnRun {
  box: BoxAddress;
  bot: string;
  session: string | null;
  /** When `startTurn` was asked (ISO-8601). */
  since: string;
  controller: AbortController;
  /** `abortTurn` was asked: the end is `aborted`, whatever the stream says. */
  stopping: boolean;
  /**
   * `forgetTurn` was asked: nothing more is delivered, and the pump leaves the
   * adapter's stream at its next frame (`return()`, which closes the socket)
   * rather than aborting it — an aborted stream owes the box a
   * `session.interrupt`, and forgetting a turn is not stopping it.
   */
  forgotten: boolean;
}

const BOT_CHAT_RESET = /^\/(new|reset|compact)\s*$/;

/** What `/compact` (or a reset in Bot Chat) says in the transcript (desktop `compactNotice`). */
function compactNotice(message: string, result: { compressed?: boolean; status?: string }): string {
  const outcome = result.compressed ? null : `Compaction: ${result.status ?? "not compressed"}`;
  if (/^\/compact\s*$/.test(message.trim())) return outcome ?? "✓ Context compression complete";
  const notice =
    "This chat never resets. Bot chats are one continuous conversation — compacting instead. " +
    "For a throwaway session with this bot, start a separate session.";
  return outcome ? `${notice}\n\n${outcome}` : notice;
}

/** A box that did not answer a roster read (desktop `unreachableSwarm`). */
export function unreachableSwarm(instance: string, reason: string): Swarm {
  return {
    instance,
    reachable: false,
    unreachable_reason: redactText(reason),
    bots: [],
    rooms: [],
    warm_slots: { used: 0, total: null },
    sections: [],
  };
}

const HINTS_BROKEN_MS = 5 * 60_000;

export function createGatewayTransport(deps: GatewayTransportDeps): GatewayTransport {
  const { client } = deps;
  const mask = deps.mask ?? transcriptMask(DEFAULT_CHAT_SETTINGS.redact);
  let turnSeq = 0;
  const mint =
    deps.mintTurnId ??
    (() => `turn-${Date.parse(deps.now()).toString(36)}-${(++turnSeq).toString(36)}`);
  const runs = new Map<string, TurnRun>();
  const observers = new Set<AbortController>();

  /* ── reads ─────────────────────────────────────────────────────────────── */

  async function history(
    input: { instance: string; bot: string; session?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<HistoryResult> {
    const box = deps.address(input.instance);
    const conversation = client.conversation
      ? await client.conversation(box, input.bot, {
          signal,
          ...(input.session ? { session: input.session } : {}),
        })
      : undefined;
    const selected = conversation?.session ?? input.session;
    const messages =
      conversation === null && !selected
        ? []
        : await client.history(box, input.bot, {
            signal,
            ...(selected !== undefined ? { session: selected } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          });
    return {
      instance: input.instance,
      bot: input.bot,
      session: selected ?? messages[0]?.session ?? null,
      ...(conversation !== undefined ? { conversation } : {}),
      messages: messages.map((message) => mask.message(message)),
    };
  }

  async function sessions(input: { instance: string; bot: string }): Promise<SessionsResult> {
    const box = deps.address(input.instance);
    const found = await client.sessions(box, input.bot);
    return { instance: input.instance, bot: input.bot, sessions: mask.deep(found) };
  }

  async function swarms(): Promise<{ swarms: Swarm[] }> {
    const instances = [...deps.listening()];
    const settled = await Promise.allSettled(
      instances.map(async (instance) => mask.deep(await client.swarm(deps.address(instance)))),
    );
    return {
      swarms: settled.map((result, i) => {
        if (result.status === "fulfilled") return result.value;
        const { code, message } = reasonOf(result.reason);
        return unreachableSwarm(instances[i] ?? "", `${code}: ${message}`);
      }),
    };
  }

  /* ── turns ─────────────────────────────────────────────────────────────── */

  async function pump(turn_id: string, run: TurnRun, turn: TurnRequest): Promise<void> {
    const signal = run.controller.signal;
    let n = 0;
    let verdict: "done" | "incomplete" | "error" | null = null;
    const deliver = (frame: ChatFrame): void => {
      if (run.forgotten) return;
      if (frame.type === "done") verdict = frame.incomplete ? "incomplete" : "done";
      else if (frame.type === "error") verdict = "error";
      deps.turns().frame(turn_id, n++, frame);
    };
    try {
      const conversation = client.conversation
        ? await client.conversation(run.box, run.bot, {
            signal,
            create: true,
            ...(turn.session ? { session: turn.session } : {}),
            ...(turn.new_session ? { new_session: true } : {}),
          })
        : null;
      const session = conversation?.session ?? turn.session;
      run.session = session ?? null;
      if (session && !run.forgotten) deps.turns().session?.(turn_id, session);
      if (conversation?.kind === "canonical" && BOT_CHAT_RESET.test(turn.message.trim())) {
        if (!client.compact)
          throw new HermeticError("CHAT_PROTOCOL", "Compaction is unavailable on this gateway");
        const result = await client.compact(run.box, run.bot, {
          signal,
          session: conversation.session,
        });
        deliver({
          type: "block",
          seq: 0,
          message: "compact",
          block: { kind: "text", markdown: compactNotice(turn.message, result) },
        });
        deliver({ type: "done", seq: 1, message: "compact" });
      } else {
        for await (const frame of client.send(run.box, run.bot, turn.message, {
          signal,
          ...(session !== undefined ? { session } : {}),
        })) {
          if (signal.aborted || run.forgotten) break;
          deliver(mask.frame(frame));
        }
      }
    } catch (error) {
      if (!signal.aborted && !run.forgotten) {
        const { code, message } = reasonOf(error);
        deliver({ type: "error", code, message });
      }
    } finally {
      runs.delete(turn_id);
    }
    if (run.forgotten) return;
    const sink = deps.turns();
    if (run.stopping) sink.end(turn_id, "aborted");
    else if (verdict === "done") sink.end(turn_id, "done");
    else if (verdict === "error") sink.end(turn_id, "error");
    // `incomplete` is the adapter giving up on a dropped turn (its reconnect
    // budget spent, typically while the phone slept); no verdict is a stream
    // that simply stopped. Either way the box's transcript is the record.
    else sink.gone(turn_id);
  }

  function startTurn(turn: TurnRequest): Promise<TurnStartResult> {
    let box: BoxAddress;
    try {
      box = deps.address(turn.instance);
    } catch (error) {
      return Promise.reject(error);
    }
    const turn_id = mint();
    const run: TurnRun = {
      box,
      bot: turn.bot,
      session: turn.session ?? null,
      since: deps.now(),
      controller: new AbortController(),
      stopping: false,
      forgotten: false,
    };
    runs.set(turn_id, run);
    // After the id is handed back: the store holds frames for a turn it is
    // still waiting to learn the id of, but there is no reason to make it.
    queueMicrotask(() => void pump(turn_id, run, turn));
    return Promise.resolve({ turn_id });
  }

  /** `false` when no pump of that turn is held here (detached, ended): the store then aborts by session. */
  async function abortTurn(turn_id: string): Promise<unknown> {
    const run = runs.get(turn_id);
    if (!run) return false;
    run.stopping = true;
    if (run.session) return client.abort(run.box, run.bot, { session: run.session });
    // The pump has not learned its session yet. Aborting the run's own signal
    // makes the adapter interrupt exactly the turn it is driving; an abort
    // scoped only to the bot could interrupt another conversation's turn.
    run.controller.abort();
    return true;
  }

  /**
   * Stop following a turn; the turn itself keeps running on the box (the
   * `ConversationTransport.forgetTurn` contract). Only the pump is let go: it
   * stops delivering at once and leaves the adapter's stream at the next frame
   * the box sends. The run's controller is **not** aborted — the adapter
   * answers an aborted signal with `session.interrupt`, which would stop a turn
   * the operator only looked away from (a backgrounded phone, a left screen, a
   * quiet tool run). `abortTurn` is the only path that stops a turn.
   */
  function forgetTurn(turn_id: string): void {
    const run = runs.get(turn_id);
    if (!run) return;
    run.forgotten = true;
    runs.delete(turn_id);
  }

  function detachTurnsSince(): DetachedTurn[] {
    const detached = [...runs].map(([turn_id, run]) => ({ turn_id, since: run.since }));
    for (const { turn_id } of detached) forgetTurn(turn_id);
    return detached;
  }

  function detachTurns(): string[] {
    return detachTurnsSince().map((t) => t.turn_id);
  }

  async function liveStatus(input: {
    instance: string;
    session: string;
    runtime?: string | null;
    signal?: AbortSignal;
  }): Promise<LiveRow | null> {
    if (!client.botModeRpc)
      throw new HermeticError("CHAT_PROTOCOL", "This gateway does not list its live sessions");
    const answer = await client.botModeRpc(
      deps.address(input.instance),
      "session.active_list",
      {},
      input.signal ? { signal: input.signal } : {},
    );
    const row = liveRowOf(answer, input.session, input.runtime ?? null);
    if (row === undefined)
      throw new HermeticError("CHAT_PROTOCOL", "session.active_list answered without a session list");
    return row;
  }

  async function abort(input: {
    instance: string;
    bot: string;
    session?: string;
  }): Promise<AbortResult> {
    const aborted = await client.abort(
      deps.address(input.instance),
      input.bot,
      input.session ? { session: input.session } : {},
    );
    return { instance: input.instance, bot: input.bot, aborted: aborted ?? true };
  }

  async function steer(input: {
    instance: string;
    bot: string;
    session?: string | null;
    text: string;
  }): Promise<SteerResult> {
    if (!client.steer)
      throw new HermeticError("CHAT_PROTOCOL", "This gateway does not support steering a turn");
    const status = await client.steer(
      deps.address(input.instance),
      input.bot,
      input.text,
      input.session ? { session: input.session } : {},
    );
    return { instance: input.instance, bot: input.bot, status };
  }

  async function respond(
    input: Parameters<ConversationTransport["respond"]>[0],
  ): Promise<RespondResult> {
    if (!client.respond) throw new HermeticError("CHAT_PROTOCOL", "Request responses unavailable");
    // A response names the session its request lives in; an empty one would
    // be routed by the gateway to whatever it guesses.
    if (!input.session)
      throw new HermeticError("VALIDATION", "This request has no session to answer it in");
    const result = await client.respond(deps.address(input.instance), input);
    return mask.deep(result);
  }

  /* ── observation ───────────────────────────────────────────────────────── */

  /** Gateways whose hint channel has been shown not to deliver (`chat-observe-wiring.ts`). */
  const hintsBroken = new Map<string, { strikes: number; at: number }>();
  const strikeLimit = deps.observeTuning?.reconnect?.attempts ?? OBSERVE_RECONNECT_ATTEMPTS;
  const nowMs = (): number => Date.parse(deps.now());

  function strikeHints(instance: string): void {
    const prior = hintsBroken.get(instance);
    hintsBroken.set(instance, { strikes: (prior?.strikes ?? 0) + 1, at: nowMs() });
  }

  function hintsUsable(target: ChatObserveTarget): boolean {
    const record = hintsBroken.get(target.instance);
    if (record === undefined || record.strikes < strikeLimit) return true;
    if (nowMs() - record.at < HINTS_BROKEN_MS) return false;
    hintsBroken.delete(target.instance);
    return true;
  }

  function maskSubagent(block: SubagentBlock): SubagentBlock | undefined {
    const framed = mask.frame({ type: "block", seq: 0, message: "", block });
    return framed.type === "block" && framed.block.kind === "subagent" ? framed.block : undefined;
  }

  async function* hints(
    target: ChatObserveTarget,
    request: ChatObserveOptions,
  ): AsyncIterable<ChatObserveHint> {
    const open = client.observe;
    if (!open) return;
    const box = deps.address(target.instance);
    let heard = false;
    try {
      for await (const hint of open.call(client, box, target.bot, {
        signal: request.signal,
        ...(target.session !== undefined ? { session: target.session } : {}),
        ...(request.sessions !== undefined ? { sessions: request.sessions } : {}),
      })) {
        heard = true;
        hintsBroken.delete(target.instance);
        yield hint.subagent ? { ...hint, subagent: maskSubagent(hint.subagent) } : hint;
      }
    } catch (error) {
      if (!heard) strikeHints(target.instance);
      throw error;
    }
    if (!heard && request.signal?.aborted !== true) strikeHints(target.instance);
  }

  const observation = createChatObservation({
    snapshot: async (target, request) => {
      const result = await history(
        {
          instance: target.instance,
          bot: target.bot,
          ...(target.session !== undefined ? { session: target.session } : {}),
          limit: OBSERVE_WINDOW,
        },
        request.signal,
      );
      return { session: result.session, messages: result.messages };
    },
    ...(client.observe ? { hints, hintsUsable } : {}),
    now: deps.now,
    ...(deps.observeTuning?.pollMs !== undefined ? { pollMs: deps.observeTuning.pollMs } : {}),
    ...(deps.observeTuning?.sleep ? { sleep: deps.observeTuning.sleep } : {}),
    ...(deps.observeTuning?.reconnect ? { reconnect: deps.observeTuning.reconnect } : {}),
  });

  function observe(
    target: ConversationTarget,
    handlers: { event: (event: ChatObserveEvent) => void; end: (error: Failure | null) => void },
  ): () => void {
    const controller = new AbortController();
    observers.add(controller);
    void (async () => {
      let failure: Failure | null = null;
      try {
        for await (const event of observation.observe(
          {
            instance: target.instance,
            bot: target.bot,
            ...(target.session !== null ? { session: target.session } : {}),
          },
          { signal: controller.signal },
        )) {
          if (controller.signal.aborted) return;
          handlers.event(event);
          if (event.type === "error") failure = { code: event.code, message: event.message };
        }
      } catch (error) {
        failure = reasonOf(error);
      } finally {
        observers.delete(controller);
      }
      if (!controller.signal.aborted) handlers.end(failure);
    })();
    return () => controller.abort();
  }

  /* ── Bot Mode lifecycle and subagents ──────────────────────────────────── */

  async function open(input: {
    instance: string;
    bot: string;
    session?: string;
    new_session?: boolean;
  }): Promise<ChatConversation> {
    if (!client.conversation)
      throw new HermeticError("CHAT_PROTOCOL", "This gateway does not support Bot Mode");
    const result = await client.conversation(deps.address(input.instance), input.bot, {
      create: true,
      ...(input.session ? { session: input.session } : {}),
      ...(input.new_session ? { new_session: true } : {}),
    });
    if (!result) throw new HermeticError("CHAT_PROTOCOL", "Gateway returned no conversation");
    return mask.deep(result);
  }

  async function compact(input: { instance: string; bot: string; session?: string }): Promise<unknown> {
    if (!client.compact) throw new HermeticError("CHAT_PROTOCOL", "Compaction unavailable");
    return mask.deep(
      await client.compact(deps.address(input.instance), input.bot, {
        ...(input.session ? { session: input.session } : {}),
      }),
    );
  }

  async function archive(input: { instance: string; bot: string; session: string }): Promise<unknown> {
    if (!client.archive) throw new HermeticError("CHAT_PROTOCOL", "Archival unavailable");
    return mask.deep(await client.archive(deps.address(input.instance), input.bot, input.session));
  }

  async function steerSubagent(input: {
    instance: string;
    bot: string;
    session?: string | null;
    subagent_id: string;
    text: string;
  }): Promise<SteerResult> {
    if (!client.subagentSteer)
      throw new HermeticError("CHAT_PROTOCOL", "This gateway does not support steering a subagent");
    const status = await client.subagentSteer(
      deps.address(input.instance),
      input.bot,
      input.subagent_id,
      input.text,
      input.session ? { session: input.session } : {},
    );
    return { instance: input.instance, bot: input.bot, status };
  }

  async function abortSubagent(input: {
    instance: string;
    bot: string;
    session?: string | null;
    subagent_id: string;
  }): Promise<AbortResult> {
    if (!client.subagentInterrupt)
      throw new HermeticError("CHAT_PROTOCOL", "This gateway does not support stopping a subagent");
    const aborted = await client.subagentInterrupt(
      deps.address(input.instance),
      input.bot,
      input.subagent_id,
      input.session ? { session: input.session } : {},
    );
    return { instance: input.instance, bot: input.bot, aborted };
  }

  return {
    history: (input) => history(input),
    sessions,
    startTurn,
    abortTurn,
    abort,
    steer,
    respond,
    forgetTurn,
    observe,
    swarms,
    listening: async () => ({ instances: [...deps.listening()] }),
    listen: async (instance, listening) => ({
      instances: [...(await deps.setListening(instance, listening))],
    }),
    open,
    compact,
    archive,
    steerSubagent,
    abortSubagent,
    detachTurns,
    detachTurnsSince,
    liveStatus,
    dispose: () => {
      detachTurns();
      for (const controller of [...observers]) controller.abort();
      observers.clear();
    },
  };
}
