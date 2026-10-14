/**
 * What one observation event does to the conversation it was routed to.
 *
 * The fan-in (`GET /api/chat/stream`) hands every owned conversation's events
 * to every connected tab; `observe` in `chat-observation.ts` routes a frame to
 * its record and calls one of the functions below, then re-renders. Each takes
 * the record and the event and mutates the record in place, with the few store
 * handles it needs passed in explicitly — never the store itself — so the rules
 * for a snapshot, a message, a child, an advisory and a terminal error read on
 * their own. The `busy` event is `noteBusy` (`chat-remote-busy.ts`).
 */
import type { RefObject } from "react";
import type { BotView, ChatConversationView, ChatMessageView, ChatObserveView } from "../api/index.ts";
import type { ChatSelection } from "./chat-state.tsx";
import {
  EARLY_OBSERVE_LIMIT,
  TURN_HOLD_LIMIT,
  absorbEarly,
  accountsFor,
  appendMissing,
  coveredByTurn,
  fresh,
  insertByStamp,
  isLocal,
  key,
  noteContext,
  noteRows,
  sessionOf,
  stillPending,
  takeHeld,
} from "./chat-conversation-record.ts";
import type { Conversation } from "./chat-conversation-record.ts";
import { observeSubagent, reapplySubagents, takeSubagents } from "./chat-subagents.ts";

/**
 * How long a `reconnecting` advisory stands before it decays back to `live`.
 *
 * The server tells this browser when its upstream read is being retried, but
 * there is no frame for "and it worked" — the only evidence of recovery is the
 * next `snapshot` or `message`, and a healthy conversation can be quiet for
 * hours. That was survivable while a retry was a transient; it stopped being
 * survivable once an upstream hint stream that ends immediately degrades to
 * polling instead of failing, because "polling, quiet, and completely fine" is
 * now a steady state an operator sits in front of — reading "Reconnecting…"
 * the whole time.
 *
 * Twice the server's five-second poll floor: long enough that a genuinely
 * unhealthy watch has had two chances to say so again and re-arm this, short
 * enough that the band does not outlive the condition it describes. A retry
 * that is really failing keeps emitting `reconnect` frames, and each one
 * restarts the clock.
 */
export const OBSERVE_QUIET_MS = 10_000;

/**
 * One stream-delivered message, reported upwards so the rail can move now
 * rather than at the roster's next tick.
 *
 * `unread` is the store's judgement rather than the caller's: a message in the
 * conversation on screen is being read as it lands and must not raise a badge
 * against the thread the operator is already looking at. `at` is the message's
 * own timestamp, for the rail's "last activity".
 */
export interface ChatArrival {
  instance: string;
  bot: string;
  /** The message's own stamp, from the box; `null` when this browser has none. */
  at: string | null;
  unread: boolean;
  /**
   * What the rail should quote under this bot's name, and who wrote it, when
   * this arrival is a reply the rail's own preview is now stale about. Absent
   * leaves whatever the roster last said; see `replyArrival`.
   */
  preview?: Pick<BotView, "preview" | "preview_role"> | null;
}

/** The one member of the observation union named `T`. */
type ObserveEvent<T extends ChatObserveView["type"]> = Extract<ChatObserveView, { type: T }>;

/** A watch that has just proved it works: no decay pending, nothing to say. */
export function observeLive(record: Conversation): void {
  if (record.observeQuietTimer) clearTimeout(record.observeQuietTimer);
  record.observeQuietTimer = null;
  record.observe = "live";
  record.observeAttempt = 0;
  record.observeError = null;
}

/**
 * `snapshot`: the box's whole transcript for the conversation, replacing what
 * was held — and, when its session differs from the held one, a rollover.
 */
export function applySnapshot(
  record: Conversation,
  event: ObserveEvent<"snapshot">,
  deps: {
    records: RefObject<Map<string, Conversation>>;
    readSessions: (record: Conversation) => Promise<void>;
  },
): void {
  const { records, readSessions } = deps;
  observeLive(record);
  // A snapshot is emitted on the first read and again on every read
  // whose session differs from the held one — a rollover: the
  // conversation archived, and either `chat.open` establishing a new
  // one or `chat.archive` retiring the root without a replacement
  // (design.md §9.2), which reads as a rollover to *no* session. The
  // schema is explicit that what was held for the previous session is
  // discarded rather than merged, and the identity has to be discarded
  // with the transcript: everything downstream addresses
  // `resolvedSession`, so leaving it naming the retired session sends
  // every later turn and read into an archived conversation. Both
  // directions count, which is why this compares rather than testing
  // `event.session` for a value — a rollover to `null` is the flavour
  // that would otherwise silently keep the archived id.
  const rolledOver = event.session !== record.resolvedSession;
  // Read before the transcript below is replaced, so the entry the
  // retired session keeps still holds what this browser had for it.
  const retiredSession = rolledOver ? record.resolvedSession : null;
  // Placeholders inherited from a record this frame merges away; see
  // the collision below.
  let adopted: readonly ChatMessageView[] = [];
  if (rolledOver) {
    // What the hold is carrying was recorded in the conversation this
    // frame retires, so it belongs to the copy taken below rather than
    // to the transcript that replaces it. Flushed before that copy is
    // made; the seed stays, because the turn itself is still streaming
    // and the rows it produces from here on belong to the new session.
    appendMissing(record, takeHeld(record, true));
    record.remoteBusy = null;
    // The children belong to the conversation that recorded them.
    const children = takeSubagents(record);
    if (retiredSession) {
      // Same shape as the `openConversation` re-key in `readHistory`:
      // the retired session's explicit alias is moved off this record
      // onto a detached copy of what it held, rather than deleted, so a
      // selection still pointing at the archived conversation resolves
      // to the archived conversation.
      //
      // Exactly one alias moves, the retired session's own, and only if
      // it is this record that answers to it. Sweeping "every alias but
      // the record's own key" is not the same thing: `readHistory`'s
      // winner/loser merge can leave the canonical alias on a record
      // whose `target.session` is explicit, and the sweep would then
      // move the canonical alias onto a frozen copy and the live
      // conversation would stop receiving fan-in frames for good.
      const retiredKey = key({ ...record.target, session: retiredSession });
      if (records.current.get(retiredKey) === record) {
        // Built from `fresh`'s defaults up, never as a spread of the
        // live record down. A shallow copy inherits every controller,
        // timer, generation counter, in-flight marker and advisory band
        // describing work the *live* record is still doing, and each one
        // is a way for the archived copy to cancel, clear or mis-report
        // it. Copying across only what is transcript — the rows, that
        // they were read, and this browser's session list — makes the
        // rest correct because it was never taken, rather than correct
        // because someone kept a list of exceptions complete.
        records.current.set(retiredKey, {
          ...fresh({ ...record.target, session: retiredSession }),
          messages: record.messages,
          historyRead: record.historyRead,
          sessions: [...record.sessions],
          sessionsState: record.sessionsState,
          sessionsError: record.sessionsError,
          context: record.context,
          ...children,
        });
      }
      // The figure stays with the conversation it described. The new
      // session starts with none: a rollover follows a compaction or an
      // archive, so the old figure no longer describes the window, and
      // the turn's next tick or `done` says what does.
      record.context = null;
    }
    record.resolvedSession = event.session;
    // A record's own `target` can name a session too — `readHistory`'s
    // winner/loser merge leaves the canonical alias on an explicitly
    // targeted record — and every address in the store is written
    // `resolvedSession ?? target.session`. Clearing `resolvedSession`
    // for a rollover to *no* session while leaving `target` alone
    // therefore resurrects the archived id one line later, `null ??
    // "s1"` being `"s1"`, which is the exact thing this block exists to
    // stop. So the target moves with the identity. Only if it named a
    // session at all: a target that was already canonical stays that
    // way, because its `null` is what makes `readHistory` open a
    // conversation rather than a stale value to be corrected. Read
    // after the retired alias and its copy, both of which want the
    // target this record is leaving.
    if (record.target.session !== null) record.target = { ...record.target, session: event.session };
    if (event.session) {
      // A canonical entry that now knows its durable session answers to
      // both keys, exactly as a history read leaves it — including the
      // collision `readHistory` handles at the same point, a prepared
      // draft or an explicit selection having created an entry under
      // the new session's key. This frame is the box's own word about
      // that session, so the transcript in hand wins the identity.
      //
      // The other record's turn is cancelled rather than carried: its
      // `sendTurn` closures capture *that* object, so migrating
      // `cancel`/`sending`/`live` would leave every later frame of the
      // turn writing into a record nothing can reach, and the Stop
      // button would address a turn whose output never appears. The
      // reply itself is not lost — the fan-in delivers it here, on this
      // session. What would be lost is the operator's own prompt while
      // the box has yet to record it, so its placeholders are adopted
      // (`stillPending` below, and the "a send is never lost" invariant
      // it is documented for), along with anything typed and unsent.
      const explicit = key({ ...record.target, session: event.session });
      const existing = records.current.get(explicit);
      if (existing && existing !== record) {
        if (!record.draft) record.draft = existing.draft;
        // Its turn is cancelled a few lines down, and every alias is
        // repointed off it, so whatever its own hold is carrying has
        // nowhere left to be released to. Handed to the early queue,
        // which `absorbEarly` folds into this snapshot below — deduped
        // against it, so a row the box already sent here is not doubled.
        record.observedEarly = [...record.observedEarly, ...takeHeld(existing, true)];
        adopted = existing.messages;
        noteContext(record, existing.context);
        existing.historyGen += 1;
        existing.sessionsGen += 1;
        existing.historyController?.abort();
        existing.sessionsController?.abort();
        existing.cancel?.();
        existing.cancel = null;
        for (const [alias, candidate] of records.current)
          if (candidate === existing) records.current.set(alias, record);
      }
      records.current.set(explicit, record);
    }
    // The roster's session list still names the conversation that was
    // archived and not the one that replaced it, and nothing in this
    // frame can correct it. Same refresh, for the same reason, as the
    // one a send does when its history response names a new session.
    // Only on a rollover away from a session: a first snapshot is
    // already behind a read that refreshes the list itself — unless
    // that read was the collided record's, cancelled just above while
    // this record's own had already been superseded by it (a sibling's
    // read answers for every record of the bot). Nothing else would
    // read for it then, and `pending` would hold the composer closed.
    if (retiredSession || (record.sessionsState === "pending" && record.sessionsController === null))
      void readSessions(record);
  }
  // Anything observed before this transcript existed is folded into it
  // first, so the reconciliation below sees every message this browser
  // has been told about rather than only the ones the read caught.
  const messages = absorbEarly(record, event.messages as unknown as ChatMessageView[]);
  // A local placeholder survives a replacement because the box has not
  // recorded it *yet*, which is a statement about one session. Across a
  // rollover the read that would account for it is never coming — it
  // was typed into the conversation that was archived, `accountsFor`
  // can never match it against the new session's rows, and it would sit
  // at the head of this transcript for the life of the record. It is
  // not lost: the copy the retired session keeps holds it. Anything
  // adopted from a merged-away record was typed into *this* session and
  // is still pending in it.
  record.messages = [
    ...messages,
    ...stillPending(retiredSession ? adopted : [...record.messages, ...adopted], messages),
  ];
  noteRows(record, messages);
  record.historyRead = true;
  record.historyError = null;
  if (record.live && messages.some((m) => m.id === record.live?.id)) {
    record.live = null;
    record.dropped = false;
  }
  reapplySubagents(record);
}

/** `message`: one row the box recorded, appended once however often it is delivered. */
export function applyMessage(
  record: Conversation,
  conversation: ChatConversationView,
  event: ObserveEvent<"message">,
  deps: {
    selected: RefObject<ChatSelection | null>;
    arrived: RefObject<((arrival: ChatArrival) => void) | undefined>;
    /** Whether a pane or the full view shows the thread; the selection when absent. */
    shown: RefObject<((instance: string, bot: string) => boolean) | undefined>;
  },
): void {
  const { selected, arrived, shown } = deps;
  observeLive(record);
  const message = event.message as unknown as ChatMessageView;
  /**
   * The rail's own copy of this arrival (Bug C).
   *
   * The roster read is what fills `bot.unread`, and it runs on a
   * two-minute tick, so without this the thread moves at once and the
   * badge an operator actually scans moves up to two minutes later —
   * the wait this phase exists to remove, reintroduced in the most
   * visible surface there is. Reported once per message this browser
   * has not already been told about, on exactly the paths below that
   * accept one, so a replayed frame moves nothing.
   *
   * Not a notification. `notify-state.tsx` has one producer
   * (`fleet.subscribeNotifications`) and this is not a second: it moves
   * a count the roster already owns, and the roster read reconciles it.
   */
  const note = (): void => {
    const open = shown.current
      ? shown.current(conversation.instance, conversation.bot)
      : selected.current?.instance === conversation.instance &&
        selected.current?.bot === conversation.bot;
    arrived.current?.({
      instance: conversation.instance,
      bot: conversation.bot,
      at: message.at,
      // The operator's own prompt is not unread, and neither is a reply
      // landing in the thread they are looking at. Another bot's
      // `message_agent` delivery rides the user role but is not the
      // operator speaking, so it counts like a reply. Only with a
      // handle: the legacy `[Message from agent '…']` form carries none
      // and is counted as the operator (`core/chat/chat-activity.ts`).
      unread: (message.role !== "user" || Boolean(message.from_bot?.handle)) && !open,
    });
  };
  // Nothing is appended to a transcript this browser has never read:
  // one message over an empty log reads as the whole conversation. The
  // snapshot every fan-in reader is sent on connect is what fills it.
  //
  // It is *held* rather than dropped. Core sends the snapshot first, so
  // this is normally a frame that cannot happen — but "normally" is not
  // a guarantee across a reconnect or a re-subscribe, and a snapshot
  // read before this message would leave it lost for good. `absorbEarly`
  // reconciles it against the transcript by id when one lands.
  if (!record.historyRead) {
    if (!record.observedEarly.some((m) => m.id === message.id)) {
      record.observedEarly = [...record.observedEarly, message].slice(-EARLY_OBSERVE_LIMIT);
      note();
    }
    return;
  }
  // The service is at-most-once within a subscription, but two
  // transports are not one subscription and a reconnect replays. One
  // dedupe, on the message's own id, and no second one on anything else.
  if (record.messages.some((m) => m.id === message.id)) return;
  if (record.observedDuringTurn.some((held) => held.message.id === message.id)) return;
  note();
  noteRows(record, [message]);
  // The box records a turn as it runs, so while this browser is
  // streaming one the rows for that same reply arrive here. They are
  // held rather than appended: the live message is already drawing
  // them, and appending would put the answer on screen twice, as a
  // second group of the same turn with every tool call repeated.
  // Bounded like the early queue, and released by `releaseHeld` the
  // instant the turn stops streaming, however it stopped.
  if (coveredByTurn(record, message)) {
    record.observedDuringTurn = [...record.observedDuringTurn, { session: sessionOf(record), message }];
    // Over the bound, the oldest are handed to the transcript rather
    // than dropped; see `TURN_HOLD_LIMIT`.
    if (record.observedDuringTurn.length > TURN_HOLD_LIMIT) {
      const spill = record.observedDuringTurn.slice(0, -TURN_HOLD_LIMIT);
      record.observedDuringTurn = record.observedDuringTurn.slice(-TURN_HOLD_LIMIT);
      appendMissing(
        record,
        spill.map((held) => held.message),
      );
    }
    return;
  }
  const placeholder = record.messages.findIndex((m) => isLocal(m) && accountsFor(message, m));
  if (placeholder === -1) record.messages = insertByStamp(record.messages, [message]);
  else {
    const next = [...record.messages];
    next[placeholder] = message;
    record.messages = next;
  }
  if (record.live?.id === message.id) {
    record.live = null;
    record.dropped = false;
  }
}

/** `subagent`: a delegated child, whole, for the record holding its session. */
export function applySubagent(
  record: Conversation,
  event: ObserveEvent<"subagent">,
  records: RefObject<Map<string, Conversation>>,
): void {
  // The one observation that is not a durable read (§9.2): a delegated
  // child, whole, landing on its row wherever the transcript holds it.
  // Routed by the event's own durable session, not the subscription's:
  // a late child of a retired session goes to that session's record,
  // if this browser keeps one, and never into the conversation that
  // replaced it.
  observeLive(record);
  const owner =
    sessionOf(record) === event.session
      ? record
      : event.session === null
        ? undefined
        : records.current.get(key({ ...record.target, session: event.session }));
  if (owner && sessionOf(owner) === event.session) observeSubagent(owner, event.block, Date.now());
}

/** `reconnect`: the server is retrying its upstream read. */
export function applyReconnect(
  record: Conversation,
  event: ObserveEvent<"reconnect">,
  deps: { alive: RefObject<boolean>; changed: () => void },
): void {
  const { alive, changed } = deps;
  // Advisory. The server is retrying its own upstream read; the
  // transcript on screen is still the last thing the box said.
  if (record.observe !== "failed") {
    record.observe = "reconnecting";
    record.observeAttempt = event.attempt;
    // And it decays. There is no "recovered" frame — a watch that
    // degrades to polling and then has nothing to deliver is healthy
    // and silent, and it must not read as broken for the hours that
    // lasts. Each further advisory re-arms this, so a watch that really
    // is retrying keeps saying so.
    if (record.observeQuietTimer) clearTimeout(record.observeQuietTimer);
    record.observeQuietTimer = setTimeout(() => {
      record.observeQuietTimer = null;
      if (!alive.current || record.observe !== "reconnecting") return;
      record.observe = "live";
      record.observeAttempt = 0;
      changed();
    }, OBSERVE_QUIET_MS);
  }
}

/** `error`: the subscription is gone. */
export function applyError(record: Conversation, event: ObserveEvent<"error">): void {
  // Terminal by contract: the subscription is gone and the server will
  // not re-create it on its own. Said out loud, with a way to ask for it
  // back — never a retry loop the operator cannot see.
  if (record.observeQuietTimer) clearTimeout(record.observeQuietTimer);
  record.observeQuietTimer = null;
  record.observe = "failed";
  record.observeAttempt = 0;
  record.observeError = { code: event.code, message: event.message };
  // No more probes will come, so the last one says nothing now.
  record.remoteBusy = null;
}
