/**
 * Per-conversation state for the phone: transcript, live reply, turn flags,
 * open requests, the local send queue, and observation.
 *
 * Mirrors the desktop's conversation record and turn loop
 * (`packages/ui/src/chat/chat-conversation-record.ts`, `chat-conversations.ts`,
 * `chat-queue.ts`) without React: the store holds mutable records, rebuilds an
 * immutable view of a record whenever it changes, and notifies subscribers —
 * the shape `useSyncExternalStore` wants. Every effect (the gateway, timers, the
 * clock) is injected, so jest and bun can both drive it.
 *
 * The box owns turns: the phone drives one straight at the agent's Hermes
 * gateway through core's adapter (`src/gateway/transport.ts`), and the adapter
 * reconnects a dropped turn itself (`session.events.since`). A turn whose
 * stream ends without saying how — the reconnect budget spent while the phone
 * slept — is `onTurnGone`, and the transcript is re-read with backoff. So the
 * store's job is the head's half: fold frames, show the prompt at once, never
 * draw it twice, queue what is said while a reply is running, and re-read
 * history whenever the stream cannot be trusted to have said everything.
 */
import type {
  ApprovalBlock,
  ChatFrame,
  ChatMessage,
  ChatObserveEvent,
  ChatRole,
  QuestionBlock,
  Session,
  SubagentBlock,
} from "@hermetic/core/chat-client";
import type { FilesStageResult } from "@hermetic/core/schema";
import { type RemoteTurnView, remoteTurnView } from "./chat-logic.ts";
import {
  accountsFor,
  answered,
  insertByStamp,
  isLocal,
  LOCAL_PREFIX,
  isProcessEventMessage,
  localPrompt,
  quoteOf,
  stillPending,
} from "./chat-pending.ts";
import { attachmentChips } from "./attachments.ts";
import type {
  AbortResult,
  HistoryResult,
  RemoteStatus,
  RespondResult,
  SendAttachments,
  SessionsResult,
  SteerResult,
  SteerStatus,
  TurnRequest,
  TurnStartResult,
  TurnState,
} from "./chat-types.ts";
import { errorCode, HermeticError } from "./errors.ts";
import { realTimers, type TimerHandle, type Timers } from "./timers.ts";
import {
  blockKey,
  foldFrame,
  freshFold,
  mergeBlock,
  type TurnActivity,
  type TurnFold,
} from "./turn-reducer.ts";

/* ── constants mirrored from the desktop ────────────────────────────────── */

/** Observed rows this far behind a turn's start are held until the turn settles. */
export const HOLD_BEHIND_MS = 60_000;
export const TURN_HOLD_LIMIT = 200;
export const EARLY_OBSERVE_LIMIT = 200;
/** A `reconnecting` observation advisory decays back to `live` after this much quiet. */
export const OBSERVE_QUIET_MS = 10_000;
/** History re-read attempts after a dropped stream. */
export const RECONNECT_ATTEMPTS = 5;

export const STEER_PREFIX = "local:steer:";

export {
  accountsFor,
  answered,
  insertByStamp,
  isLocal,
  LOCAL_PREFIX,
  localPrompt,
  MATCH_AHEAD_MS,
  MATCH_BEHIND_MS,
  stillPending,
} from "./chat-pending.ts";
/** 0, 1, 2, 4, 8 s — the desktop's transcript-recovery ladder (`reconnectDelayMs`). */
export function reconnectDelayMs(attempt: number): number {
  const delays = [0, 1000, 2000, 4000, 8000];
  return delays[Math.max(0, Math.min(attempt - 1, delays.length - 1))] as number;
}

/* ── public types ───────────────────────────────────────────────────────── */

export interface ConversationTarget {
  instance: string;
  bot: string;
  /** `null` is the bot's canonical session — "Bot Chat". */
  session: string | null;
}

export const conversationKey = (t: ConversationTarget): string =>
  JSON.stringify([t.instance, t.bot, t.session]);

export interface Failure {
  code: string;
  message: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  at: string;
}

export type ObserveState = "off" | "live" | "reconnecting" | "failed";
export type HistoryState = "idle" | "loading" | "ready" | "failed";
export type SteerOutcome = SteerStatus | "refused";

export interface RespondInput {
  request_id: string;
  kind: "approval" | "question";
  choice?: "once" | "session" | "always" | "deny";
  answer?: string;
  question_id?: string;
  answers?: Record<string, string>;
  skip?: true;
}

/** What a screen reads. Replaced, never mutated, so identity says "changed". */
export interface ConversationView {
  readonly key: string;
  readonly target: ConversationTarget;
  /** The session the bot is actually on (a canonical session can roll over). */
  readonly resolvedSession: string | null;
  readonly messages: readonly ChatMessage[];
  readonly live: ChatMessage | null;
  readonly history: HistoryState;
  readonly historyError: string | null;
  /** The error code of a failed read (`NOT_FOUND`: no such bot or session; `CHAT_UNREACHABLE`). */
  readonly historyCode: string | null;
  readonly sessions: readonly Session[];
  /** When `sessions` was last asked for (ISO-8601, the read's start); `null` until a read landed. */
  readonly sessionsAt: string | null;
  readonly sending: boolean;
  readonly aborting: boolean;
  readonly activity: TurnActivity;
  readonly turnId: string | null;
  readonly turnError: Failure | null;
  /** Re-reading history after a stream that ended without saying how. */
  readonly reconnecting: boolean;
  readonly reconnectAttempt: number;
  /** The last turn ended without `done`: what is shown may be incomplete. */
  readonly dropped: boolean;
  /**
   * The turn this phone stopped following while it was away is still running
   * on the box (`onTurnRemote`): its band's copy. `sending` stays `true`, so
   * the composer offers Steer and Stop and a plain send is queued.
   */
  readonly remote: RemoteTurnView | null;
  /** Requests open in the turn this phone follows; none while it runs on its box unfollowed. */
  readonly openRequests: readonly string[];
  /** Requests the operator answered from this phone (the box never closes those in the stream). */
  readonly released: readonly string[];
  readonly queue: readonly QueuedMessage[];
  readonly queueParked: boolean;
  readonly observe: ObserveState;
  readonly observeError: Failure | null;
  /** Set when an observed snapshot moved the conversation to a new session. */
  readonly rolledOverFrom: string | null;
}

export interface ConversationTransport {
  history(input: {
    instance: string;
    bot: string;
    session?: string;
    limit?: number;
  }): Promise<HistoryResult>;
  sessions(input: { instance: string; bot: string }): Promise<SessionsResult>;
  /**
   * Start a turn. Answers at once with a phone-minted id; the frames arrive on
   * `onTurnFrame`, and how it ended on `onTurnEnd` / `onTurnGone`.
   */
  startTurn(turn: TurnRequest): Promise<TurnStartResult>;
  /**
   * Stop a turn this phone started (the gateway's interrupt for its session).
   * Answers `false` when the transport holds no pump for it any more; the
   * store then stops it by session (`abort`).
   */
  abortTurn(turn_id: string): Promise<unknown>;
  /** Stop whatever runs in a conversation (no turn of this phone's to name). */
  abort(input: { instance: string; bot: string; session?: string }): Promise<AbortResult | unknown>;
  steer(input: {
    instance: string;
    bot: string;
    session?: string | null;
    text: string;
  }): Promise<SteerResult>;
  respond(
    input: RespondInput & { instance: string; bot: string; session: string },
  ): Promise<RespondResult>;
  /** Stop following a turn's frames (the turn itself keeps running on the box). */
  forgetTurn?(turn_id: string): void;
  /**
   * Observe a conversation; returns the closer. `end` is called once when the
   * observation stops by itself (a terminal error), never after the closer.
   */
  observe?(
    target: ConversationTarget,
    handlers: { event: (event: ChatObserveEvent) => void; end: (error: Failure | null) => void },
  ): () => void;
}

export interface ConversationStoreOptions {
  transport: ConversationTransport;
  timers?: Timers;
  /** A turn this phone followed settled, so alerts and the rail can react. */
  onTurnSettled?: (target: ConversationTarget, outcome: TurnOutcome) => void;
  /** A followed turn is now waiting on the operator (approval or question). */
  onRequestOpened?: (
    target: ConversationTarget,
    request: { block: ApprovalBlock | QuestionBlock; turnId: string | null },
  ) => void;
  /** A reply or message landed: the home row moves now rather than at the next poll. */
  onArrival?: (target: ConversationTarget, arrival: ConversationArrival) => void;
  /**
   * A conversation whose turn is still running on its box came on screen
   * (`on`) or left it: the client polls the box only while it is shown.
   */
  onRemoteShown?: (turn_id: string, on: boolean) => void;
}

/** Where a turn this store still follows lives (`turnTarget`). */
export interface TurnWhere {
  target: ConversationTarget;
  /** The session it was sent into, once known. */
  session: string | null;
  /** The conversation is on screen. */
  opened: boolean;
  /** Set while the box reports it still running (`onTurnRemote`). */
  remote: RemoteStatus | null;
  /**
   * The turn's live (runtime) session id on the box, once an answer named it
   * (`onTurnRemote`). Upstream rotates the stored id on a mid-turn compaction;
   * the live id stays, so a later ask matches on it too.
   */
  runtime: string | null;
}

/**
 * Something landed in a conversation this phone is showing, for the home row
 * to show before the next roster read does (desktop `ChatArrival`). `unread` is
 * always `false` here: the phone only observes, and only drives turns in, the
 * conversation on screen.
 */
export interface ConversationArrival {
  /** The box's stamp; `null` when only the assembled stream (this phone's clock) has one. */
  at: string | null;
  unread: boolean;
  /** Canonical conversation only: a named session's words are not what the bot's row quotes. */
  preview: { preview: string; preview_role: ChatRole } | null;
}

export interface TurnOutcome {
  ok: boolean;
  error: Failure | null;
  turnId: string | null;
  /** The reply as assembled, for a notification preview. */
  reply: ChatMessage | null;
}

/* ── internals ──────────────────────────────────────────────────────────── */

interface TurnRun {
  gen: number;
  turnId: string | null;
  fold: TurnFold;
  seed: { session: string; at: string };
  segmentAt: string;
  settled: boolean;
  body: string;
  /** Stopped before the start answered, with no session to stop it by: stop it by its id then. */
  abortOnStart?: boolean;
}

interface HeldRow {
  session: string | null;
  message: ChatMessage;
}

interface Rec {
  key: string;
  target: ConversationTarget;
  resolvedSession: string | null;
  messages: ChatMessage[];
  live: ChatMessage | null;
  history: HistoryState;
  historyError: string | null;
  historyCode: string | null;
  historyGen: number;
  historyRead: boolean;
  sessions: Session[];
  sessionsAt: string | null;
  sending: boolean;
  aborting: boolean;
  activity: TurnActivity;
  turnError: Failure | null;
  reconnecting: boolean;
  reconnectAttempt: number;
  reconnectTimer: TimerHandle | null;
  dropped: boolean;
  remote: RemoteStatus | null;
  /** Set by `suspend` on a turn in flight: its pump was let go, so Stop goes by session. */
  detached: boolean;
  runtime: string | null;
  /**
   * The stored key the box's live row carries now (`onTurnRemote`). A
   * compaction rotates it mid-turn, and the key the turn was sent into then
   * resolves to the idle parent: Stop and Steer go by this one once known.
   */
  liveKey: string | null;
  gen: number;
  run: TurnRun | null;
  segments: string[];
  released: Set<string>;
  observedEarly: ChatMessage[];
  observedDuringTurn: HeldRow[];
  queue: QueuedMessage[];
  parked: boolean;
  observe: ObserveState;
  observeError: Failure | null;
  observeQuiet: TimerHandle | null;
  closeObserve: (() => void) | null;
  /** On screen: `open` was called and `leave` has not been since. What `resume` re-opens. */
  opened: boolean;
  rolledOverFrom: string | null;
  view: ConversationView | null;
}

type Listener = (key: string) => void;

const ORPHAN_LIMIT = 2_000;

/** How long past its expiry a sent file is still remembered (`sentFile`). */
export const SENT_FILE_GRACE_MS = 24 * 60 * 60_000;

export class ConversationStore {
  private readonly transport: ConversationTransport;
  private readonly timers: Timers;
  private readonly onTurnSettled: ConversationStoreOptions["onTurnSettled"];
  private readonly onRequestOpened: ConversationStoreOptions["onRequestOpened"];
  private readonly onArrival: ConversationStoreOptions["onArrival"];
  private readonly onRemoteShown: ConversationStoreOptions["onRemoteShown"];
  private readonly records = new Map<string, Rec>();
  private readonly owners = new Map<string, string>();
  /** Every file this phone sent, by its staged id: what a Retry checks for expiry. */
  private readonly sentFiles = new Map<string, FilesStageResult>();
  /** Frames that arrived for a turn before `turn.start` answered with its id. */
  private readonly orphans = new Map<
    string,
    ({ n: number; frame: ChatFrame } | { end: TurnState })[]
  >();
  private readonly listeners = new Set<Listener>();
  private localSeq = 0;
  private queueSeq = 0;

  constructor(options: ConversationStoreOptions) {
    this.transport = options.transport;
    this.timers = options.timers ?? realTimers;
    this.onTurnSettled = options.onTurnSettled;
    this.onRequestOpened = options.onRequestOpened;
    this.onArrival = options.onArrival;
    this.onRemoteShown = options.onRemoteShown;
  }

  /* ── reading ────────────────────────────────────────────────────────── */

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  view(target: ConversationTarget): ConversationView {
    const record = this.record(target);
    if (!record.view) record.view = this.buildView(record);
    return record.view;
  }

  /** Every conversation this store holds, for home's task tags. */
  views(): ConversationView[] {
    return [...this.records.values()].map((r) => this.view(r.target));
  }

  /** Every conversation with a turn running, for the rail's activity dots. */
  active(): ConversationView[] {
    return [...this.records.values()].filter((r) => r.sending).map((r) => this.view(r.target));
  }

  /**
   * Every conversation whose followed turn waits on the operator: a request
   * open and unanswered, whether or not the conversation is on screen. A turn
   * running on its box unfollowed counts only while the box says `waiting`.
   */
  waiting(): ConversationTarget[] {
    return [...this.records.values()]
      .filter((r) => !!r.run && !r.run.settled && r.run.fold.openRequests.length > 0)
      .filter((r) => r.remote === null || r.remote === "waiting")
      .map((r) => r.target);
  }

  /* ── opening and leaving ────────────────────────────────────────────── */

  /**
   * The conversation is on screen: read what is missing and start observing.
   * Idempotent while an observation runs; one that ended (terminally, by
   * `suspend`, or by `endObservations`) is started again.
   */
  open(target: ConversationTarget): void {
    const record = this.record(target);
    record.opened = true;
    if (record.history === "idle" || record.history === "failed") {
      if (!record.sending && !record.aborting) void this.readHistory(record);
    }
    // A fresh open asks again: a separate session made since must not read as the Bot Chat's.
    if (record.sessions.length === 0 || !record.closeObserve) void this.readSessions(record);
    if (!record.closeObserve && this.transport.observe) {
      record.observe = "live";
      record.observeError = null;
      record.closeObserve = this.transport.observe(target, {
        event: (event) => this.onObserveEvent(record.key, event),
        end: (error) => this.onObserveEnd(record.key, error),
      });
      this.changed(record);
    }
    if (record.remote && record.run?.turnId) this.onRemoteShown?.(record.run.turnId, true);
  }

  /** The conversation left the screen: stop observing and park its queue. */
  leave(target: ConversationTarget): void {
    const record = this.records.get(conversationKey(target));
    if (!record) return;
    record.opened = false;
    record.closeObserve?.();
    record.closeObserve = null;
    record.observe = "off";
    if (record.observeQuiet !== null) this.timers.clearTimeout(record.observeQuiet);
    record.observeQuiet = null;
    if (record.queue.length > 0) record.parked = true;
    this.changed(record);
    if (record.remote && record.run?.turnId) this.onRemoteShown?.(record.run.turnId, false);
  }

  /**
   * Start the conversation's observation afresh, whatever state the last one
   * is in (live, failed, ended): what a screen calls when it comes back to the
   * foreground focused on this conversation. The queue is left as it is.
   */
  reopen(target: ConversationTarget): void {
    const record = this.record(target);
    this.stopObserve(record, "off", null);
    this.open(target);
  }

  /**
   * Close every observation (the hint socket with it) and keep the record of
   * which conversations are on screen, for `resume`. The app went to the
   * background: a suspended phone holds no socket open. Every turn in flight
   * is marked detached (the client let its pump go), so a Stop before the box
   * has answered for it goes by session rather than by a pump that is gone.
   */
  suspend(): void {
    for (const record of this.records.values()) {
      if (record.run && !record.run.settled) record.detached = true;
      if (record.closeObserve) this.stopObserve(record, "off", null);
    }
  }

  /**
   * Re-open (`open` semantics) every conversation still on screen whose
   * observation is not running, optionally only those `filter` accepts. The
   * app came back to the foreground, or an agent became listened again.
   */
  resume(filter: (target: ConversationTarget) => boolean = () => true): void {
    for (const record of [...this.records.values()])
      if (record.opened && !record.closeObserve && filter(record.target)) this.open(record.target);
  }

  /**
   * End the observation of every conversation `match` accepts, without calling
   * it a failure: `observe` goes to `off` (the band shows nothing) and
   * `observeError` carries `reason`, so a screen can say why. Used when the
   * operator stops listening to an agent, or it leaves the fleet.
   */
  endObservations(match: (target: ConversationTarget) => boolean, reason: Failure): void {
    for (const record of this.records.values())
      if (record.closeObserve && match(record.target)) this.stopObserve(record, "off", reason);
  }

  async reload(target: ConversationTarget): Promise<boolean> {
    const record = this.record(target);
    this.clearReconnect(record);
    const [ok] = await Promise.all([this.readHistory(record), this.readSessions(record)]);
    return ok;
  }

  /* ── sending ────────────────────────────────────────────────────────── */

  /**
   * Start a turn. `false` when there is nothing to send or a turn is already
   * running. A turn of files alone (no words) still sends: the adapter frames them.
   */
  send(target: ConversationTarget, text: string, attachments?: SendAttachments | null): boolean {
    const record = this.record(target);
    const body = text.trim();
    const files = attachments && attachments.ids.length > 0 ? attachments : null;
    if ((!body && !files) || record.sending || record.aborting) return false;
    this.clearReconnect(record);
    const gen = ++record.gen;
    record.dropped = false;
    record.detached = false;
    record.runtime = null;
    record.liveKey = null;
    record.turnError = null;
    this.releaseHeld(record);
    if (record.live && !answered(record.messages, record.live))
      record.messages = [...record.messages, record.live];
    record.live = null;
    record.sending = true;
    record.activity = "thinking";
    const session = record.resolvedSession ?? target.session;
    const at = new Date(this.timers.now()).toISOString();
    const seed = { session: session ?? "", at };
    record.segments = [];
    record.released = new Set();
    const localId = this.localId(LOCAL_PREFIX, at);
    this.rememberSent(files?.staged ?? []);
    const chips = files?.chips ?? attachmentChips(files?.staged ?? []);
    const prompt = localPrompt(localId, body, at, session, chips);
    record.messages = [...record.messages, prompt];
    // The row quotes the operator's words now; this phone's clock moves no time.
    if (target.session === null)
      this.onArrival?.(target, { at: null, unread: false, preview: quoteOf(prompt) });
    const run: TurnRun = {
      gen,
      turnId: null,
      fold: freshFold(),
      seed,
      segmentAt: at,
      settled: false,
      body,
    };
    record.run = run;
    this.changed(record);

    const turn: TurnRequest = {
      instance: target.instance,
      bot: target.bot,
      message: body,
      client_ref: localId,
      ...(session ? { session } : {}),
      ...(files ? { attachments: files } : {}),
    };
    this.transport.startTurn(turn).then(
      (result) => {
        if (record.run !== run || run.settled) {
          // Stopped or superseded before the start answered: stop following it,
          // and drop anything buffered.
          this.orphans.delete(result.turn_id);
          if (run.abortOnStart) void this.transport.abortTurn(result.turn_id).catch(() => undefined);
          else this.transport.forgetTurn?.(result.turn_id);
          return;
        }
        run.turnId = result.turn_id;
        this.owners.set(result.turn_id, record.key);
        this.changed(record);
        const early = this.orphans.get(result.turn_id);
        this.orphans.delete(result.turn_id);
        for (const item of early ?? []) {
          if ("end" in item) this.onTurnEnd(result.turn_id, item.end);
          else this.onTurnFrame(result.turn_id, item.n, item.frame);
        }
      },
      (error: unknown) => {
        // The gateway transport answers a start at once and reports what went
        // wrong as an error frame; a refusal here is the transport's own (an
        // instance this phone does not know). Nothing reached the box.
        if (record.run !== run || run.settled) return;
        this.end(record, run, false, {
          code: errorCode(error) ?? "SEND_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return true;
  }

  /** Steer words into the running turn (`chat.steer`). */
  async steer(target: ConversationTarget, text: string): Promise<SteerOutcome> {
    const record = this.record(target);
    const body = text.trim();
    if (!body) return "refused";
    if (!record.sending || record.aborting) return "idle";
    const run = record.run;
    const session = record.liveKey ?? record.resolvedSession ?? target.session;
    let status: SteerStatus;
    try {
      status = (
        await this.transport.steer({ instance: target.instance, bot: target.bot, session, text: body })
      ).status;
    } catch {
      return "rejected";
    }
    if (status !== "redirected" && status !== "queued") return status;
    const at = new Date(this.timers.now()).toISOString();
    if (
      run &&
      record.run === run &&
      record.sending &&
      run.fold.live &&
      run.fold.live.blocks.length > 0
    ) {
      // The reply so far is closed off where the steer went in, and the
      // operator's words sit under it; what follows starts a new segment.
      const id = `${run.fold.live.id}~${record.segments.length + 1}`;
      record.messages = [...record.messages, { ...run.fold.live, id }];
      record.segments = [...record.segments, id];
      run.fold = { ...run.fold, live: null };
      record.live = null;
    }
    if (run) run.segmentAt = at;
    record.messages = [
      ...record.messages,
      localPrompt(this.localId(STEER_PREFIX, at), body, at, session),
    ];
    this.changed(record);
    if (!record.sending) void this.readHistory(record);
    return status;
  }

  /** Stop the running turn. The queue is parked, never dropped. */
  async stop(target: ConversationTarget): Promise<void> {
    const record = this.record(target);
    if (record.queue.length > 0) record.parked = true;
    await this.abort(record);
  }

  /* ── the queue ──────────────────────────────────────────────────────── */

  enqueue(target: ConversationTarget, text: string): QueuedMessage | null {
    const body = text.trim();
    if (!body) return null;
    const record = this.record(target);
    const row = {
      id: `q${++this.queueSeq}`,
      text: body,
      at: new Date(this.timers.now()).toISOString(),
    };
    record.queue = [...record.queue, row];
    this.changed(record);
    this.drain(record);
    return row;
  }

  unqueue(target: ConversationTarget, id: string): void {
    const record = this.record(target);
    const rest = record.queue.filter((row) => row.id !== id);
    if (rest.length === record.queue.length) return;
    record.queue = rest;
    if (rest.length === 0) record.parked = false;
    this.changed(record);
  }

  /** A file this phone sent in a turn, as the box staged it (`undefined` when not this phone's). */
  sentFile(id: string): FilesStageResult | undefined {
    return this.sentFiles.get(id);
  }

  /**
   * Remember `staged`, and forget files a day past their expiry: by then their
   * echo has long been replaced by the box's row, whose Retry needs no record.
   */
  private rememberSent(staged: readonly FilesStageResult[]): void {
    const horizon = this.timers.now() - SENT_FILE_GRACE_MS;
    for (const [id, file] of this.sentFiles)
      if (Date.parse(file.expires_at) < horizon) this.sentFiles.delete(id);
    for (const file of staged) this.sentFiles.set(file.id, file);
  }

  /**
   * A deliberate send: unparks the queue, then sends. `attachments` are files
   * already staged on the box (`outgoingAttachments`); the queue carries text
   * only, so a composer holding files keeps them when this answers `false`.
   */
  sendMessage(target: ConversationTarget, text: string, attachments?: SendAttachments | null): boolean {
    const record = this.record(target);
    record.parked = false;
    const sent = this.send(target, text, attachments);
    this.changed(record);
    return sent;
  }

  /**
   * "Send now": idle → send; running → steer; a steer the box refuses falls
   * back to putting the message at the head of the queue, unparking it, and
   * aborting the turn, so the drain sends it next.
   */
  async sendNow(
    target: ConversationTarget,
    text: string,
    queuedId: string | null = null,
  ): Promise<SteerOutcome | "sent"> {
    const body = text.trim();
    const record = this.record(target);
    if (!body) return "refused";
    if (!record.sending) {
      if (queuedId) this.unqueue(target, queuedId);
      this.sendMessage(target, body);
      return "sent";
    }
    const outcome = await this.steer(target, body);
    if (outcome === "redirected" || outcome === "queued") {
      if (queuedId) this.unqueue(target, queuedId);
      return outcome;
    }
    if (outcome === "refused") return outcome;
    const existing = queuedId ? record.queue.find((r) => r.id === queuedId) : undefined;
    const row = existing ?? {
      id: `q${++this.queueSeq}`,
      text: body,
      at: new Date(this.timers.now()).toISOString(),
    };
    record.queue = [row, ...record.queue.filter((r) => r.id !== row.id)];
    record.parked = false;
    this.changed(record);
    if (record.sending) await this.abort(record);
    else this.drain(record);
    return outcome;
  }

  /* ── requests ───────────────────────────────────────────────────────── */

  /**
   * Answer a request in this conversation's session. Refused here, before
   * anything is sent, when the conversation has no session yet: an answer with
   * no session would be routed by the gateway to whatever it guessed.
   */
  async respond(target: ConversationTarget, input: RespondInput): Promise<RespondResult> {
    const record = this.record(target);
    const session = record.resolvedSession || target.session || record.run?.seed.session || "";
    if (!session)
      throw new HermeticError(
        "VALIDATION",
        "This conversation has no session yet, so the request cannot be answered from here.",
      );
    const result = await this.transport.respond({
      ...input,
      instance: target.instance,
      bot: target.bot,
      session,
    });
    this.release(target, input.request_id);
    return result;
  }

  /** The operator has answered (or skipped) a request: it is no longer open. */
  release(target: ConversationTarget, request_id: string): void {
    const record = this.record(target);
    record.released.add(request_id);
    const run = record.run;
    if (run)
      run.fold = { ...run.fold, openRequests: run.fold.openRequests.filter((id) => id !== request_id) };
    this.changed(record);
  }

  /* ── turn events (from the gateway transport) ──────────────────────── */

  onTurnFrame(turn_id: string, _n: number, frame: ChatFrame): void {
    const key = this.owners.get(turn_id);
    if (!key) {
      this.holdOrphan(turn_id, { n: _n, frame });
      return;
    }
    const record = this.records.get(key);
    const run = record?.run;
    if (!record || !run || run.turnId !== turn_id || run.settled) return;
    const next = foldFrame(run.fold, frame, { ...run.seed, at: run.segmentAt }, record.released);
    if (next === run.fold) return;
    // A block updating a card in a segment a steer closed off lands there,
    // rather than drawing a second copy in the new segment.
    if (frame.type === "block" && record.segments.length > 0) {
      const k = blockKey(frame.block);
      const inLive = k !== null && (run.fold.live?.blocks.some((b) => blockKey(b) === k) ?? false);
      if (!inLive && this.landOnSegment(record, frame)) {
        run.fold = { ...next, live: run.fold.live };
        this.changed(record);
        return;
      }
    }
    const before = run.fold.openRequests;
    run.fold = next;
    record.live = next.live;
    record.activity = next.activity;
    this.changed(record);
    if (frame.type === "block" && this.onRequestOpened) {
      const block = frame.block;
      if (
        (block.kind === "approval" || block.kind === "question") &&
        block.request_id &&
        !before.includes(block.request_id) &&
        next.openRequests.includes(block.request_id)
      )
        this.onRequestOpened(record.target, { block, turnId: run.turnId });
    }
  }

  /**
   * The session a turn was sent into, once the transport resolved it: a first
   * message to a bot with no Bot Chat yet creates one, and until the next
   * history read this is the only place the conversation learns its id.
   */
  onTurnSession(turn_id: string, session: string): void {
    const key = this.owners.get(turn_id);
    const record = key ? this.records.get(key) : undefined;
    const run = record?.run;
    if (!record || !run || run.turnId !== turn_id || run.settled) return;
    if (!run.seed.session) run.seed = { ...run.seed, session };
    if (record.resolvedSession === null) {
      record.resolvedSession = session;
      this.changed(record);
    }
  }

  onTurnEnd(turn_id: string, state: TurnState): void {
    const key = this.owners.get(turn_id);
    if (!key) {
      this.holdOrphan(turn_id, { end: state });
      return;
    }
    const record = this.records.get(key);
    const run = record?.run;
    if (!record || !run || run.turnId !== turn_id || run.settled) return;
    if (state === "done") this.end(record, run, true, null);
    else if (state === "error")
      this.end(
        record,
        run,
        false,
        run.fold.live?.failure ?? { code: "TURN_ERROR", message: "The turn failed." },
      );
    else if (state === "aborted") {
      if (record.aborting) return;
      this.end(record, run, true, null);
    }
  }

  /**
   * The turn's stream ended without saying how (no `done`, no error): the
   * adapter spent its reconnect budget, or the phone slept through it. The
   * transcript on the box is the record, so it is re-read with backoff.
   */
  onTurnGone(turn_id: string): void {
    const key = this.owners.get(turn_id);
    if (!key) return;
    const record = this.records.get(key);
    const run = record?.run;
    if (!record || !run || run.turnId !== turn_id || run.settled) return;
    this.end(record, run, false, null);
  }

  /** Where a turn this store still follows lives; `null` once it settled (or was never seen). */
  turnTarget(turn_id: string): TurnWhere | null {
    const record = this.owned(turn_id);
    if (!record) return null;
    const session = record.run?.seed.session || record.resolvedSession || record.target.session;
    return {
      target: record.target,
      session,
      opened: record.opened,
      remote: record.remote,
      runtime: record.runtime,
    };
  }

  /**
   * A turn this phone stopped following while it was away is still running
   * on its box (`session.active_list` says `working`, `starting` or
   * `waiting`). It stays in flight — no frames arrive, but Steer and Stop
   * reach it by its session, and what is sent now is queued — until the box
   * says it is idle (`onRemoteDone`). `runtime` is the live session id the
   * box's row carried (`turnTarget` hands it back for the next ask), and
   * `key` the stored key it carries now (what Stop and Steer then go by).
   * Answers whether the turn was still followed here.
   */
  onTurnRemote(
    turn_id: string,
    status: RemoteStatus,
    runtime: string | null = null,
    key: string | null = null,
  ): boolean {
    const record = this.owned(turn_id);
    if (!record) return false;
    if (runtime) record.runtime = runtime;
    if (key) record.liveKey = key;
    if (record.remote === status) return true;
    record.remote = status;
    record.activity = "thinking";
    this.changed(record);
    return true;
  }

  /**
   * The box gave a definite answer that a turn this phone stopped following
   * is over (its session is idle, or gone from the list), whether or not it
   * was seen running first. The transcript is re-read as for a turn gone
   * (`onTurnGone`), but the turn ran to its end, so nothing is marked dropped
   * and the queue drains once the read lands. No answer at all is
   * `onTurnGone`.
   */
  onRemoteDone(turn_id: string): void {
    const record = this.owned(turn_id);
    if (record?.run) this.end(record, record.run, false, null, true);
  }

  private owned(turn_id: string): Rec | null {
    const key = this.owners.get(turn_id);
    const record = key ? this.records.get(key) : undefined;
    const run = record?.run;
    return record && run && run.turnId === turn_id && !run.settled ? record : null;
  }

  /* ── observation events ─────────────────────────────────────────────── */

  onObserveEvent(key: string, event: ChatObserveEvent): void {
    const record = this.records.get(key);
    if (!record) return;
    switch (event.type) {
      case "snapshot": {
        this.observeLive(record);
        const rolledOver =
          record.historyRead && event.session !== null && event.session !== record.resolvedSession;
        if (rolledOver) {
          this.appendMissing(record, this.takeHeld(record, true));
          record.rolledOverFrom = record.resolvedSession;
        }
        if (event.session !== null) record.resolvedSession = event.session;
        const messages = this.absorbEarly(record, event.messages);
        record.messages = [...messages, ...stillPending(record.messages, messages)];
        record.historyRead = true;
        record.history = "ready";
        record.historyError = null;
        record.historyCode = null;
        if (record.live && messages.some((m) => m.id === record.live?.id) && !record.sending) {
          record.live = null;
          record.dropped = false;
        }
        break;
      }
      case "message": {
        this.observeLive(record);
        const message = event.message;
        if (!record.historyRead) {
          if (!record.observedEarly.some((m) => m.id === message.id)) {
            record.observedEarly = [...record.observedEarly, message].slice(-EARLY_OBSERVE_LIMIT);
            this.noteMessage(record, message);
          }
          break;
        }
        if (record.messages.some((m) => m.id === message.id)) return;
        if (record.observedDuringTurn.some((held) => held.message.id === message.id)) return;
        this.noteMessage(record, message);
        if (this.coveredByTurn(record, message)) {
          record.observedDuringTurn = [
            ...record.observedDuringTurn,
            { session: record.resolvedSession ?? record.target.session, message },
          ];
          if (record.observedDuringTurn.length > TURN_HOLD_LIMIT) {
            const spill = record.observedDuringTurn.slice(0, -TURN_HOLD_LIMIT);
            record.observedDuringTurn = record.observedDuringTurn.slice(-TURN_HOLD_LIMIT);
            this.appendMissing(
              record,
              spill.map((h) => h.message),
            );
          }
          break;
        }
        const placeholder = record.messages.findIndex((m) => isLocal(m) && accountsFor(message, m));
        if (placeholder === -1) record.messages = insertByStamp(record.messages, [message]);
        else {
          const next = [...record.messages];
          next[placeholder] = message;
          record.messages = next;
        }
        if (record.live?.id === message.id && !record.sending) {
          record.live = null;
          record.dropped = false;
        }
        break;
      }
      case "subagent":
        this.observeLive(record);
        this.applySubagent(record, event.block);
        break;
      case "reconnect":
        record.observe = "reconnecting";
        if (record.observeQuiet !== null) this.timers.clearTimeout(record.observeQuiet);
        record.observeQuiet = this.timers.setTimeout(() => {
          record.observeQuiet = null;
          if (record.observe === "reconnecting") {
            record.observe = "live";
            this.changed(record);
          }
        }, OBSERVE_QUIET_MS);
        break;
      case "error":
        record.observe = "failed";
        record.observeError = { code: event.code, message: event.message };
        break;
    }
    this.changed(record);
  }

  /**
   * The observation stopped by itself. Core's observation service already
   * spent its own reconnect budget before giving up, so this is terminal until
   * the conversation is opened again (`open` starts a new one).
   */
  onObserveEnd(key: string, error: Failure | null): void {
    const record = this.records.get(key);
    if (!record?.closeObserve) return;
    record.closeObserve = null;
    if (record.observeQuiet !== null) this.timers.clearTimeout(record.observeQuiet);
    record.observeQuiet = null;
    record.observe = error ? "failed" : "off";
    record.observeError = error;
    this.changed(record);
  }

  private stopObserve(record: Rec, state: ObserveState, reason: Failure | null): void {
    record.closeObserve?.();
    record.closeObserve = null;
    if (record.observeQuiet !== null) this.timers.clearTimeout(record.observeQuiet);
    record.observeQuiet = null;
    record.observe = state;
    record.observeError = reason;
    this.changed(record);
  }

  /** Forget everything (sign out / re-pair). */
  reset(): void {
    for (const record of this.records.values()) {
      record.closeObserve?.();
      this.clearReconnect(record);
      if (record.observeQuiet !== null) this.timers.clearTimeout(record.observeQuiet);
    }
    this.records.clear();
    this.owners.clear();
    this.orphans.clear();
    for (const l of [...this.listeners]) l("*");
  }

  /* ── internals: records ─────────────────────────────────────────────── */

  private record(target: ConversationTarget): Rec {
    const key = conversationKey(target);
    let record = this.records.get(key);
    if (!record) {
      record = {
        key,
        target: { ...target },
        resolvedSession: target.session,
        messages: [],
        live: null,
        history: "idle",
        historyError: null,
        historyCode: null,
        historyGen: 0,
        historyRead: false,
        sessions: [],
        sessionsAt: null,
        sending: false,
        aborting: false,
        activity: "idle",
        turnError: null,
        reconnecting: false,
        reconnectAttempt: 0,
        reconnectTimer: null,
        dropped: false,
        remote: null,
        detached: false,
        runtime: null,
        liveKey: null,
        gen: 0,
        run: null,
        segments: [],
        released: new Set(),
        observedEarly: [],
        observedDuringTurn: [],
        queue: [],
        parked: false,
        observe: "off",
        observeError: null,
        observeQuiet: null,
        closeObserve: null,
        opened: false,
        rolledOverFrom: null,
        view: null,
      };
      this.records.set(key, record);
    }
    return record;
  }

  private buildView(r: Rec): ConversationView {
    return {
      key: r.key,
      target: r.target,
      resolvedSession: r.resolvedSession,
      messages: r.messages,
      live: r.live,
      history: r.history,
      historyError: r.historyError,
      historyCode: r.historyCode,
      sessions: r.sessions,
      sessionsAt: r.sessionsAt,
      sending: r.sending,
      aborting: r.aborting,
      activity: r.activity,
      turnId: r.run?.turnId ?? null,
      turnError: r.turnError,
      reconnecting: r.reconnecting,
      reconnectAttempt: r.reconnectAttempt,
      dropped: r.dropped,
      remote: r.remote ? remoteTurnView(r.remote) : null,
      // Running on its box unfollowed: nothing can be answered from here.
      openRequests: r.remote ? [] : (r.run?.fold.openRequests ?? []),
      released: [...r.released],
      queue: r.queue,
      queueParked: r.parked && r.queue.length > 0,
      observe: r.observe,
      observeError: r.observeError,
      rolledOverFrom: r.rolledOverFrom,
    };
  }

  private changed(record: Rec): void {
    record.view = null;
    for (const l of [...this.listeners]) {
      try {
        l(record.key);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  private localId(prefix: string, at: string): string {
    this.localSeq += 1;
    return `${prefix}${at}#${this.localSeq}`;
  }

  private holdOrphan(
    turn_id: string,
    item: { n: number; frame: ChatFrame } | { end: TurnState },
  ): void {
    let list = this.orphans.get(turn_id);
    if (!list) {
      // Only turns this phone is waiting to learn the id of are worth holding.
      const waiting = [...this.records.values()].some(
        (r) => r.run && !r.run.settled && r.run.turnId === null,
      );
      if (!waiting) return;
      list = [];
      this.orphans.set(turn_id, list);
    }
    if (list.length < ORPHAN_LIMIT) list.push(item);
  }

  /* ── internals: the turn ────────────────────────────────────────────── */

  /** `ranOut`: a turn that ran to its end on the box unfollowed (`onRemoteDone`), not a dropped one. */
  private end(record: Rec, run: TurnRun, ok: boolean, error: Failure | null, ranOut = false): void {
    if (run.settled || record.run !== run) return;
    run.settled = true;
    if (run.turnId) this.owners.delete(run.turnId);
    record.remote = null;
    record.detached = false;
    record.activity = "idle";
    record.segments = [];
    run.fold = { ...run.fold, openRequests: [] };
    if (!record.aborting) record.sending = false;
    if (!record.sending) this.releaseHeld(record);
    // A Stop the box refused is moot once the turn has ended anyway.
    if (record.turnError?.code === "ABORT_FAILED") record.turnError = null;
    if (error) record.turnError = error;
    record.dropped = !ok && !ranOut;
    if (!ok && !ranOut && record.live) record.live = { ...record.live, incomplete: true };
    // Nothing drains into a failed or dropped turn (desktop `chat-queue.ts`).
    if (!ok && !ranOut && record.queue.length > 0) record.parked = true;
    this.changed(record);
    this.onTurnSettled?.(record.target, { ok, error, turnId: run.turnId, reply: record.live });
    if (record.aborting) return;
    void this.readSessions(record);
    if (!ok && !error) this.reconnect(record, 1, ranOut);
    else {
      // The row is told after the read: the box's own stamp and words for this
      // reply arrive with the transcript (desktop `replyArrival`).
      const assembled = record.live;
      void this.readHistory(record).then(() => {
        if (ok) this.noteReply(record, assembled);
        this.drain(record);
      });
    }
  }

  /** A message the observation delivered, reported once per id. */
  private noteMessage(record: Rec, message: ChatMessage): void {
    this.onArrival?.(record.target, {
      at: message.at,
      unread: false,
      preview: record.target.session === null ? quoteOf(message) : null,
    });
  }

  /** The reply this phone just drove to completion, from the transcript if it has it. */
  private noteReply(record: Rec, live: ChatMessage | null): void {
    if (!this.onArrival || record.target.session !== null) return;
    const recorded = [...record.messages]
      .reverse()
      .find((m) => m.role !== "user" && !isLocal(m) && !isProcessEventMessage(m));
    const source = recorded ?? live;
    const preview = source ? quoteOf(source) : null;
    if (!preview) return;
    this.onArrival(record.target, {
      // The assembled fallback carries this phone's clock, so it moves the words only.
      at: recorded ? recorded.at : null,
      unread: false,
      preview,
    });
  }

  private async abort(record: Rec): Promise<void> {
    if (record.aborting) return;
    if (!record.sending) return;
    record.aborting = true;
    const gen = record.gen;
    const run = record.run;
    this.clearReconnect(record);
    record.dropped = false;
    if (record.turnError?.code === "ABORT_FAILED") record.turnError = null;
    this.changed(record);
    // A turn unfollowed (detached on the way to the background, or known to
    // run on its box) has no pump to stop: it is interrupted by its session,
    // like one this phone never started — by the key its live row carries,
    // once known (`liveKey`). So is one whose pump the transport no longer
    // holds (`abortTurn` answers `false`). With no session at all the abort
    // is refused: an unscoped one may interrupt another conversation's turn.
    // A start not answered yet is stopped by the id it answers with instead.
    const session =
      record.liveKey ?? record.resolvedSession ?? record.target.session ?? (run?.seed.session || null);
    const unfollowed = record.detached || record.remote !== null;
    // An unfollowed turn the box did not interrupt is still running there.
    let failed = false;
    const bySession = async () => {
      if (!session)
        throw new HermeticError(
          "VALIDATION",
          "This conversation has no session yet, so the turn cannot be stopped from here.",
        );
      const result = await this.transport.abort({
        instance: record.target.instance,
        bot: record.target.bot,
        session,
      });
      if (unfollowed && (result as { aborted?: unknown } | null)?.aborted === false)
        throw new Error("Could not stop the turn — try again.");
    };
    try {
      const pumped = unfollowed ? null : run?.turnId;
      if (!pumped || (await this.transport.abortTurn(pumped)) === false) {
        if (!session && !unfollowed && run && !run.turnId) run.abortOnStart = true;
        else await bySession();
      }
    } catch (error) {
      if (unfollowed) failed = true;
      if (record.gen === gen)
        record.turnError = {
          code: "ABORT_FAILED",
          message: error instanceof Error ? error.message : String(error),
        };
    } finally {
      if (record.gen === gen && failed && run && record.run === run && !run.settled) {
        // Not stopped: the turn stays in flight as it was, and the queue stays parked.
        record.aborting = false;
        this.changed(record);
      } else if (record.gen === gen) {
        record.gen += 1;
        if (run) {
          run.settled = true;
          if (run.turnId) {
            this.owners.delete(run.turnId);
            this.transport.forgetTurn?.(run.turnId);
          }
          run.fold = { ...run.fold, openRequests: [] };
        }
        record.sending = false;
        record.remote = null;
        record.detached = false;
        record.segments = [];
        this.releaseHeld(record);
        record.activity = "idle";
        record.aborting = false;
        this.changed(record);
        await Promise.all([this.readHistory(record), this.readSessions(record)]);
        this.drain(record);
      }
    }
  }

  /** `release`: drain the queue once a read lands (park it if none does). */
  private reconnect(record: Rec, attempt: number, release = false): void {
    const gen = record.gen;
    record.reconnecting = true;
    record.reconnectAttempt = attempt;
    this.changed(record);
    record.reconnectTimer = this.timers.setTimeout(() => {
      record.reconnectTimer = null;
      void this.readHistory(record).then((ok) => {
        if (gen !== record.gen || !record.reconnecting) return;
        if (ok || attempt >= RECONNECT_ATTEMPTS) {
          record.reconnecting = false;
          record.reconnectAttempt = 0;
          if (release && !ok && record.queue.length > 0) record.parked = true;
          this.changed(record);
          if (release && ok) this.drain(record);
        } else this.reconnect(record, attempt + 1, release);
      });
    }, reconnectDelayMs(attempt));
  }

  private clearReconnect(record: Rec): void {
    if (record.reconnectTimer !== null) this.timers.clearTimeout(record.reconnectTimer);
    record.reconnectTimer = null;
    if (record.reconnecting) {
      record.reconnecting = false;
      record.reconnectAttempt = 0;
    }
  }

  /** Mirror of the desktop queue's drain effect. */
  private drain(record: Rec): void {
    if (record.sending || record.aborting || record.queue.length === 0) return;
    if (record.turnError || record.reconnecting) {
      record.parked = true;
      this.changed(record);
      return;
    }
    if (record.parked) return;
    const head = record.queue[0]!;
    if (!this.send(record.target, head.text)) {
      record.parked = true;
      this.changed(record);
      return;
    }
    record.queue = record.queue.filter((r) => r.id !== head.id);
    this.changed(record);
  }

  private landOnSegment(record: Rec, frame: Extract<ChatFrame, { type: "block" }>): boolean {
    const kind = frame.block.kind;
    if (kind !== "tool" && kind !== "approval" && kind !== "question" && kind !== "subagent")
      return false;
    for (let i = record.segments.length - 1; i >= 0; i--) {
      const id = record.segments[i]!;
      const at = record.messages.findIndex((m) => m.id === id);
      if (at === -1) continue;
      const segment = record.messages[at]!;
      const merged = mergeBlock(segment.blocks, frame.block);
      if (merged.length === segment.blocks.length) {
        const next = [...record.messages];
        next[at] = { ...segment, blocks: merged };
        record.messages = next;
        return true;
      }
    }
    return false;
  }

  private applySubagent(record: Rec, block: SubagentBlock): void {
    const key = `subagent:${block.subagent_id}`;
    const has = (m: ChatMessage) =>
      m.blocks.some((b) => b.kind === "subagent" && `subagent:${b.subagent_id}` === key);
    if (record.live && has(record.live)) {
      record.live = { ...record.live, blocks: mergeBlock(record.live.blocks, block) };
      if (record.run) record.run.fold = { ...record.run.fold, live: record.live };
      return;
    }
    for (let i = record.messages.length - 1; i >= 0; i--) {
      const m = record.messages[i]!;
      if (!has(m)) continue;
      const next = [...record.messages];
      next[i] = { ...m, blocks: mergeBlock(m.blocks, block) };
      record.messages = next;
      return;
    }
    if (record.live) {
      record.live = { ...record.live, blocks: mergeBlock(record.live.blocks, block) };
      if (record.run) record.run.fold = { ...record.run.fold, live: record.live };
    }
  }

  /* ── internals: history ─────────────────────────────────────────────── */

  private async readHistory(record: Rec): Promise<boolean> {
    const gen = ++record.historyGen;
    record.history = "loading";
    this.changed(record);
    const session = record.target.session;
    let result: HistoryResult;
    try {
      result = await this.transport.history({
        instance: record.target.instance,
        bot: record.target.bot,
        ...(session ? { session } : {}),
      });
    } catch (error) {
      if (gen !== record.historyGen) return false;
      record.history = "failed";
      record.historyError = error instanceof Error ? error.message : String(error);
      record.historyCode = errorCode(error);
      this.changed(record);
      return false;
    }
    if (gen !== record.historyGen) return false;
    const recorded = this.absorbEarly(record, result.messages);
    record.messages = [...recorded, ...stillPending(record.messages, recorded)];
    if (result.session) record.resolvedSession = result.session;
    record.historyRead = true;
    record.history = "ready";
    record.historyError = null;
    record.historyCode = null;
    if (!record.sending && record.live && answered(recorded, record.live)) {
      record.live = null;
      record.dropped = false;
    }
    this.changed(record);
    return true;
  }

  private async readSessions(record: Rec): Promise<void> {
    const at = new Date(this.timers.now()).toISOString();
    try {
      const result = await this.transport.sessions({
        instance: record.target.instance,
        bot: record.target.bot,
      });
      record.sessions = result.sessions;
      record.sessionsAt = at;
      this.changed(record);
    } catch {
      // The switcher keeps what it had; a failed read is not worth a band.
    }
  }

  private absorbEarly(record: Rec, recorded: readonly ChatMessage[]): ChatMessage[] {
    if (record.observedEarly.length === 0) return [...recorded];
    const known = new Set(recorded.map((row) => row.id));
    const extra = record.observedEarly.filter((row) => !known.has(row.id));
    record.observedEarly = [];
    return insertByStamp(recorded, extra);
  }

  private coveredByTurn(record: Rec, message: ChatMessage): boolean {
    const run = record.run;
    if (!record.sending || !run || run.settled) return false;
    if (message.role === "user") return false;
    const session = record.resolvedSession ?? record.target.session ?? (run.seed.session || null);
    if (session && message.session && message.session !== session) return false;
    const at = Date.parse(message.at);
    const since = Date.parse(run.seed.at);
    if (Number.isNaN(at) || Number.isNaN(since)) return false;
    return at >= since - HOLD_BEHIND_MS;
  }

  private takeHeld(record: Rec, all = false): ChatMessage[] {
    const now = record.resolvedSession ?? record.target.session;
    const rows = record.observedDuringTurn.filter(
      (held) => all || !held.session || !now || held.session === now,
    );
    record.observedDuringTurn = [];
    return rows.map((held) => held.message);
  }

  private appendMissing(record: Rec, rows: readonly ChatMessage[]): void {
    if (rows.length === 0) return;
    const known = new Set(record.messages.map((row) => row.id));
    const extra = rows.filter((row) => !known.has(row.id));
    if (extra.length > 0) record.messages = insertByStamp(record.messages, extra);
  }

  private releaseHeld(record: Rec): void {
    this.appendMissing(record, this.takeHeld(record));
  }

  private observeLive(record: Rec): void {
    if (record.observe === "off") return;
    record.observe = "live";
    record.observeError = null;
    if (record.observeQuiet !== null) this.timers.clearTimeout(record.observeQuiet);
    record.observeQuiet = null;
  }
}
