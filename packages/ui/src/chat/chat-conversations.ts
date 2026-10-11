/** Conversation records outlive the frame displaying them, but never their fleet provider. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatApi, ChatSelection } from "./chat-state.tsx";
import type { BotView, ChatConversationView, ChatMessageView, ChatObserveView } from "../api/index.ts";
import { nextTurnActivity } from "./chat-activity.ts";
import { previewOf } from "./chat-logic.ts";
import { isProcessEventMessage, previewText } from "./process-events.ts";
import type { ConversationActivity } from "./chat-activity.ts";
import {
  EARLY_OBSERVE_LIMIT,
  TURN_HOLD_LIMIT,
  absorbEarly,
  accountsFor,
  appendMissing,
  coveredByTurn,
  fresh,
  isLocal,
  key,
  releaseHeld,
  sessionOf,
  stillPending,
  takeHeld,
} from "./chat-conversation-record.ts";
import type { Assemble, Conversation, Failure, ObserveState } from "./chat-conversation-record.ts";

export type { ObserveState } from "./chat-conversation-record.ts";

/** The first transcript recovery is immediate; later attempts back off to eight seconds. */
export function reconnectDelayMs(attempt: number): number {
  const delays = [0, 1000, 2000, 4000, 8000];
  return delays[Math.max(0, Math.min(attempt - 1, delays.length - 1))] as number;
}

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

export interface Observation {
  state: ObserveState;
  /** Which upstream retry is in flight, as the server counted it. 0 when none. */
  attempt: number;
  error: Failure | null;
}

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

/**
 * The rail's own copy of a reply this browser just drove to completion.
 *
 * The roster read owns `preview` and `last_message_at`, and it runs on a
 * two-minute tick — so without this the thread shows the new reply and the rail
 * row beside it keeps quoting the previous one for up to two minutes. Written
 * from the transcript the turn's own history read just landed, never from the
 * assembled stream: the box stamps a message and this laptop's clock is not the
 * box's, so `Date.now()` here would sort the rail by the wrong clock.
 *
 * Canonical only. The rail row describes Bot Chat (§9.2), so a turn sent into a
 * named session must not rewrite what it quotes — that session has its own row
 * in the session list, and the canonical preview is still true.
 */
function replyArrival(record: Conversation, live: ChatMessageView | null): ChatArrival | null {
  if (record.target.session !== null) return null;
  // A background event that landed after the reply is not the reply this turn drove.
  const recorded = [...record.messages]
    .reverse()
    .find((m) => m.role !== "user" && !isLocal(m) && !isProcessEventMessage(m));
  const source = recorded ?? live;
  if (!source) return null;
  const preview = previewOf(previewText(source));
  if (!preview) return null;
  return {
    instance: record.target.instance,
    bot: record.target.bot,
    // The assembled fallback carries this browser's clock rather than the
    // box's, so it moves the words and leaves the time to the roster.
    at: recorded ? recorded.at : null,
    // A reply into the thread this turn was typed in is being read as it lands.
    unread: false,
    // The row is in hand, so the rail knows whose words these are.
    preview: { preview, preview_role: source.role },
  };
}

export function useConversations(
  api: ChatApi,
  refreshSwarms: () => Promise<void>,
  assemble: Assemble,
  instances?: readonly string[],
  onArrival?: (arrival: ChatArrival) => void,
) {
  const arrived = useRef(onArrival);
  arrived.current = onArrival;
  /**
   * The injected calls, reached through a ref rather than closed over.
   *
   * Every reader below would otherwise be memoised on `api`, and the effect
   * that opens the selected conversation depends on two of them — so a parent
   * that hands this store a rebuilt `api` object turns each of its own renders
   * into a transcript read against the box. Holding the calls in a ref keeps
   * the readers identity-stable while still using whatever `api` the latest
   * render supplied.
   */
  const apiRef = useRef(api);
  apiRef.current = api;
  const allowed = useRef(instances);
  allowed.current = instances;
  const permits = useCallback(
    (instance: string) => allowed.current === undefined || allowed.current.includes(instance),
    [],
  );
  const records = useRef(new Map<string, Conversation>());
  const alive = useRef(true);
  const [, render] = useState(0);
  const [selection, setSelection] = useState<ChatSelection | null>(null);
  const selected = useRef<ChatSelection | null>(null);
  const empty = useRef(fresh({ instance: "", bot: "", session: null }));
  const changed = useCallback(() => {
    if (alive.current) render((n) => n + 1);
  }, []);
  const get = useCallback((target: ChatSelection) => {
    const id = key(target);
    let record = records.current.get(id);
    if (!record) {
      record = fresh(target);
      records.current.set(id, record);
    }
    return record;
  }, []);
  const clearReconnect = useCallback((record: Conversation) => {
    if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
    record.reconnectTimer = null;
    record.historyGen += 1;
    record.historyController?.abort();
    record.historyController = null;
    record.historyLoading = false;
    record.reconnecting = false;
    record.reconnectAttempt = 0;
  }, []);
  /** A watch that has just proved it works: no decay pending, nothing to say. */
  const observeLive = useCallback((record: Conversation) => {
    if (record.observeQuietTimer) clearTimeout(record.observeQuietTimer);
    record.observeQuietTimer = null;
    record.observe = "live";
    record.observeAttempt = 0;
    record.observeError = null;
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const record of new Set(records.current.values())) {
        record.turn += 1;
        record.sessionsGen += 1;
        record.sessionsController?.abort();
        clearReconnect(record);
        if (record.observeQuietTimer) clearTimeout(record.observeQuietTimer);
        record.observeQuietTimer = null;
        record.cancel?.();
        record.cancel = null;
      }
    };
  }, [clearReconnect]);

  useLayoutEffect(() => {
    let removed = false;
    for (const [id, record] of records.current) {
      if (permits(record.target.instance)) continue;
      record.turn += 1;
      record.sessionsGen += 1;
      record.sessionsController?.abort();
      clearReconnect(record);
      if (record.observeQuietTimer) clearTimeout(record.observeQuietTimer);
      record.observeQuietTimer = null;
      record.cancel?.();
      record.cancel = null;
      records.current.delete(id);
      removed = true;
    }
    if (selected.current && !permits(selected.current.instance)) {
      selected.current = null;
      setSelection(null);
    }
    if (removed) changed();
  }, [instances, permits, clearReconnect, changed]);

  const readHistory = useCallback(
    async (record: Conversation): Promise<boolean> => {
      if (record.sending || record.aborting || !alive.current || !permits(record.target.instance))
        return false;
      record.historyController?.abort();
      const controller = new AbortController();
      record.historyController = controller;
      const gen = ++record.historyGen;
      const stale = () => !alive.current || gen !== record.historyGen;
      record.historyLoading = true;
      changed();
      try {
        const target = record.target;
        let session = record.resolvedSession ?? target.session;
        if (!target.session && apiRef.current.openConversation) {
          const opened = await apiRef.current.openConversation(
            { instance: target.instance, bot: target.bot },
            controller.signal,
          );
          if (stale()) return false;
          if (record.resolvedSession && record.resolvedSession !== opened.session) {
            const previous = { ...record, target: { ...target, session: record.resolvedSession } };
            for (const [alias, value] of records.current)
              if (value === record && alias !== key(target)) records.current.set(alias, previous);
          }
          session = opened.session;
        }
        const result = await apiRef.current.fetchHistory(
          target.instance,
          target.bot,
          {
            ...(session ? { session } : {}),
            limit: 200,
          },
          controller.signal,
        );
        if (stale()) return false;
        // Once resolved, a canonical entry is pinned to this durable conversation.
        // Its explicit link and the canonical shortcut must address the same pipe.
        if (result.session) {
          const explicit = key({ ...target, session: result.session });
          const existing = records.current.get(explicit);
          if (existing && existing !== record) {
            // A prepared draft can create an explicit entry before the canonical
            // read resolves. Prefer a record already doing work; otherwise retain
            // this read and move the prepared draft into its newly proven identity.
            const winner =
              existing.historyRead || existing.historyLoading || existing.sending ? existing : record;
            const loser = winner === record ? existing : record;
            for (const [alias, candidate] of records.current) {
              if (candidate === loser) records.current.set(alias, winner);
            }
            if (!winner.draft) winner.draft = loser.draft;
            if (winner !== record) {
              changed();
              return true;
            }
          }
          records.current.set(explicit, record);
        }
        if (
          result.conversation &&
          !record.sessions.some((s) => s.id === result.conversation!.session)
        ) {
          const c = result.conversation;
          record.sessions.push({
            id: c.session,
            instance: c.instance,
            bot: c.bot,
            kind: c.kind,
            origin: "desktop",
            title: c.kind === "canonical" ? "Bot Chat" : "Chat",
            unread: 0,
            turn_count: 0,
          });
        }
        record.messages = absorbEarly(record, result.messages);
        record.resolvedSession = result.session ?? record.resolvedSession;
        record.historyRead = true;
        record.historyError = null;
        if (record.live) {
          const since = Date.parse(record.live.at);
          const recorded = result.messages.some(
            // A background event is not the bot's reply, so it cannot be what recorded it.
            (m) =>
              m.id === record.live?.id ||
              (m.role !== "user" && !isProcessEventMessage(m) && Date.parse(m.at) >= since),
          );
          if (!record.dropped || recorded) {
            record.live = null;
            record.dropped = false;
          } else record.live = { ...record.live, incomplete: true };
        }
        return true;
      } catch (error) {
        if (!stale()) record.historyError = error instanceof Error ? error.message : String(error);
        return false;
      } finally {
        if (!stale()) {
          record.historyLoading = false;
          changed();
        }
      }
    },
    [changed, permits],
  );

  const readSessions = useCallback(
    async (record: Conversation) => {
      if (!alive.current || !permits(record.target.instance)) return;
      record.sessionsController?.abort();
      const controller = new AbortController();
      record.sessionsController = controller;
      const gen = ++record.sessionsGen;
      record.sessionsState = "pending";
      changed();
      try {
        const result = await apiRef.current.fetchSessions(
          record.target.instance,
          record.target.bot,
          controller.signal,
        );
        if (!alive.current || gen !== record.sessionsGen) return;
        record.sessions = result.sessions;
        record.sessionsState = "ready";
        record.sessionsError = null;
      } catch (error) {
        if (!alive.current || gen !== record.sessionsGen) return;
        record.sessionsState = "failed";
        record.sessionsError = error instanceof Error ? error.message : String(error);
      }
      changed();
    },
    [changed, permits],
  );

  const select = useCallback(
    (instance: string, bot: string, session: string | null = null) => {
      if (!permits(instance)) return false;
      const target = { instance, bot, session };
      if (selected.current && key(selected.current) === key(target)) return true;
      selected.current = target;
      get(target);
      setSelection(target);
      return true;
    },
    [get, permits],
  );
  const current = selection ? get(selection) : empty.current;
  useEffect(() => {
    if (!selection) return;
    const record = get(selection);
    if (!record.historyLoading && !record.sending && !record.aborting) void readHistory(record);
    if (record.sessionsState === "pending") void readSessions(record);
  }, [selection, get, readHistory, readSessions]);

  /**
   * The turn's response to this browser died: re-read the transcript until the
   * box answers, backing off, five attempts.
   *
   * The only drop this handles. A box socket that drops mid-turn is core's, and
   * core continues that turn from its cursor (design.md §9.2) — nothing reaches
   * this function for it, because the turn has not ended. What does reach here
   * is the hop the portal keeps no buffer for, plus the fallbacks core gives up
   * on, which arrive as an ordinary `done incomplete` and settle through `end`.
   */
  const reconnect = useCallback(
    (record: Conversation, attempt: number) => {
      const turn = record.turn;
      record.reconnecting = true;
      record.reconnectAttempt = attempt;
      changed();
      record.reconnectTimer = setTimeout(() => {
        record.reconnectTimer = null;
        void readHistory(record).then((ok) => {
          if (!alive.current || turn !== record.turn || !record.reconnecting) return;
          if (ok || attempt >= 5) {
            record.reconnecting = false;
            record.reconnectAttempt = 0;
            changed();
            if (!ok) void refreshSwarms();
          } else reconnect(record, attempt + 1);
        });
      }, reconnectDelayMs(attempt));
    },
    [changed, readHistory, refreshSwarms],
  );

  /**
   * One frame of the fan-in (`GET /api/chat/stream`), routed to its conversation.
   *
   * This is what makes a message sent from Hermes Desktop, from the CLI or by a
   * routine appear here without anyone refreshing anything. The server holds the
   * subscriptions (`packages/app/src/chat-owner.ts`) and hands every owned
   * conversation's events to every connected tab, so this has to be idempotent:
   * two tabs are two copies of the same frames, and a message that arrives while
   * this tab is sending is that tab's own prompt coming back.
   *
   * `snapshot` replaces, `message` appends, and neither is merged into the other
   * (§9.2 — the box is authoritative). The only thing that survives a
   * replace is an optimistic local message the box has not recorded yet.
   */
  const observe = useCallback(
    (conversation: ChatConversationView, event: ChatObserveView) => {
      if (!permits(conversation.instance)) return;
      const record = get({
        instance: conversation.instance,
        bot: conversation.bot,
        session: conversation.session,
      });
      switch (event.type) {
        case "snapshot": {
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
                });
              }
            }
            record.resolvedSession = event.session;
            // A record's own `target` can name a session too — `readHistory`'s
            // winner/loser merge leaves the canonical alias on an explicitly
            // targeted record — and every address in this file is written
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
            if (record.target.session !== null)
              record.target = { ...record.target, session: event.session };
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
            // already behind a read that refreshes the list itself.
            if (retiredSession) void readSessions(record);
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
          record.historyRead = true;
          record.historyError = null;
          if (record.live && messages.some((m) => m.id === record.live?.id)) {
            record.live = null;
            record.dropped = false;
          }
          break;
        }
        case "message": {
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
            const open =
              selected.current?.instance === conversation.instance &&
              selected.current?.bot === conversation.bot;
            arrived.current?.({
              instance: conversation.instance,
              bot: conversation.bot,
              at: message.at,
              // The operator's own prompt is not unread, and neither is a reply
              // landing in the thread they are looking at. Another bot's
              // `message_agent` delivery rides the user role but is not the
              // operator speaking, so it counts like a reply. Only with a
              // handle: a legacy `Message from HR: …` signature carries none
              // and may be the operator typing one (`core/chat/chat-activity.ts`).
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
            break;
          }
          // The service is at-most-once within a subscription, but two
          // transports are not one subscription and a reconnect replays. One
          // dedupe, on the message's own id, and no second one on anything else.
          if (record.messages.some((m) => m.id === message.id)) break;
          if (record.observedDuringTurn.some((held) => held.message.id === message.id)) break;
          note();
          // The box records a turn as it runs, so while this browser is
          // streaming one the rows for that same reply arrive here. They are
          // held rather than appended: the live message is already drawing
          // them, and appending would put the answer on screen twice, as a
          // second group of the same turn with every tool call repeated.
          // Bounded like the early queue, and released by `releaseHeld` the
          // instant the turn stops streaming, however it stopped.
          if (coveredByTurn(record, message)) {
            record.observedDuringTurn = [
              ...record.observedDuringTurn,
              { session: sessionOf(record), message },
            ];
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
            break;
          }
          const placeholder = record.messages.findIndex((m) => isLocal(m) && accountsFor(message, m));
          if (placeholder === -1) record.messages = [...record.messages, message];
          else {
            const next = [...record.messages];
            next[placeholder] = message;
            record.messages = next;
          }
          if (record.live?.id === message.id) {
            record.live = null;
            record.dropped = false;
          }
          break;
        }
        case "reconnect": {
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
          break;
        }
        case "error": {
          // Terminal by contract: the subscription is gone and the server will
          // not re-create it on its own. Said out loud, with a way to ask for it
          // back — never a retry loop the operator cannot see.
          if (record.observeQuietTimer) clearTimeout(record.observeQuietTimer);
          record.observeQuietTimer = null;
          record.observe = "failed";
          record.observeAttempt = 0;
          record.observeError = { code: event.code, message: event.message };
          break;
        }
      }
      changed();
    },
    [changed, get, observeLive, permits, readSessions],
  );

  /**
   * The re-read queue: every owed history read, two boxes at a time.
   *
   * One `dropped` frame makes every transcript this browser holds suspect, and
   * a browser watching a dozen conversations firing a dozen history reads at
   * once spends its whole connection budget on the recovery — against boxes
   * that each answer one read at a time anyway. So the reads are queued and
   * drained at a small fixed width, and a record already waiting coalesces
   * rather than queueing twice.
   */
  const REREAD_WIDTH = 2;
  const rereads = useRef<{ waiting: Conversation[]; queued: Set<Conversation>; running: number }>({
    waiting: [],
    queued: new Set(),
    running: 0,
  });

  const pumpRereads = useCallback(() => {
    const q = rereads.current;
    const step = () => {
      while (q.running < REREAD_WIDTH) {
        const record = q.waiting.shift();
        if (!record) return;
        q.queued.delete(record);
        // A turn started while this record sat in the queue. `readHistory`
        // refuses one anyway, and the turn's own settle point (`end`, `abort`)
        // re-reads the transcript unconditionally — so the debt is already
        // owned by something, and queueing it a second time would read twice.
        if (record.sending || record.aborting) continue;
        q.running += 1;
        void readHistory(record).finally(() => {
          q.running -= 1;
          step();
        });
      }
    };
    step();
  }, [readHistory]);

  const enqueueReread = useCallback(
    (record: Conversation) => {
      const q = rereads.current;
      if (q.queued.has(record)) return;
      q.queued.add(record);
      q.waiting.push(record);
      pumpRereads();
    },
    [pumpRereads],
  );

  /**
   * The server's queue overflowed: events were lost, and the frame does not say
   * whose. Every transcript this browser holds is therefore suspect, so each one
   * is read again from the box — which is the answer to a gap in every other
   * part of this file too.
   *
   * A record with a turn in flight is left alone: `readHistory` refuses one,
   * the half-built reply is the part that would be lost, and its settle point
   * (`end`, `abort`) re-reads the transcript in any case — so the gap is closed
   * there, once, rather than here twice.
   */
  const observeDropped = useCallback(() => {
    for (const record of new Set(records.current.values())) {
      if (!record.historyRead) continue;
      if (record.sending || record.aborting) continue;
      enqueueReread(record);
    }
  }, [enqueueReread]);

  /**
   * The fan-in socket itself, which is not any one conversation's state.
   *
   * A portal that has lost the stream is a portal whose transcripts stop moving,
   * and saying nothing about that is the failure mode this phase exists to end.
   * It reads as reconnecting rather than as an error because the consumer really
   * is re-opening it; a conversation already terminal keeps the worse state.
   */
  const observeTransport = useCallback(
    (connected: boolean) => {
      for (const record of new Set(records.current.values())) {
        if (record.observe === "failed") continue;
        // The socket's own state is reported both ways, so nothing here decays:
        // a pending decay from an upstream advisory would otherwise clear a band
        // that this handler is the one responsible for lifting.
        if (record.observeQuietTimer) clearTimeout(record.observeQuietTimer);
        record.observeQuietTimer = null;
        record.observe = connected ? "live" : "reconnecting";
        if (connected) record.observeAttempt = 0;
      }
      changed();
    },
    [changed],
  );

  /**
   * Ask for a terminated observation back, because the operator said so.
   *
   * Exactly one conversation: `POST /api/chat/:instance/:bot/observe`, with the
   * resolved session in the query string when this thread has one. It used to
   * write the listen preference instead (`PUT /api/chat/listening` →
   * `chatOwner.sync()`), which reconciles the whole fleet — so one click on one
   * bot re-opened every dropped observation on the box, and fixture QA saw nine
   * new observations come back from one "Watch again". The server's answer
   * names the conversation it acted on, and nothing else moves.
   *
   * Then the transcript is read, because whatever arrived while nothing was
   * watching is missing from the copy on screen.
   */
  const resumeObservation = useCallback(async () => {
    if (!selected.current || !permits(selected.current.instance)) return;
    const record = get(selected.current);
    if (record.observeQuietTimer) clearTimeout(record.observeQuietTimer);
    record.observeQuietTimer = null;
    record.observe = "reconnecting";
    record.observeError = null;
    record.observeAttempt = 0;
    changed();
    const fail = (code: string, message: string): void => {
      record.observe = "failed";
      record.observeError = { code, message };
      changed();
    };
    const ask = apiRef.current.resumeObservation;
    if (!ask) {
      // Optional for the same reason `chatStream` is: a tree mounted without a
      // fan-in has no observation to ask back. Nothing falls through to the
      // fleet-wide listen write — that is the call this route replaced.
      fail("OBSERVE_RESUME_FAILED", "This view does not hold an observation to resume.");
      return;
    }
    let answer: Awaited<ReturnType<NonNullable<ChatApi["resumeObservation"]>>>;
    try {
      /**
       * The record's *identity*, not the session it happens to be reading.
       *
       * Every other address in this file is `resolvedSession ?? target.session`
       * because those calls read a conversation, and reading wants the
       * concrete session. A resume names a *subscription*, and the server keys
       * a canonical one on `session: null` (`chat-owner.ts` `keyOf`). A
       * canonical record has `resolvedSession` filled in by the history read
       * and moved by every rollover, so sending it here asked the server for a
       * conversation it does not hold: it started a second pinned observation
       * of one conversation, left the canonical key's remembered failure in
       * place, and lost the new subscription again at the next reconcile.
       * `target.session` is the identity, and the rollover block above keeps it
       * current for a record that names a session at all.
       */
      answer = await ask(record.target.instance, record.target.bot, record.target.session);
    } catch (error) {
      fail("OBSERVE_RESUME_FAILED", error instanceof Error ? error.message : String(error));
      return;
    }
    if (!alive.current || !permits(record.target.instance)) return;
    /**
     * The one answer a resume cannot fix by itself. Observations exist only for
     * boxes this operator has chosen to monitor, so a box that is not listened
     * to has nothing to resume — and turning listening on from here would be
     * this store writing a preference that `listening-state.tsx` owns, silently,
     * off a button that says "Watch again". It is said instead, naming the
     * screen where the choice lives. (`observing: false` with `listening: true`
     * is not a state the route can return.)
     */
    if (!answer.listening) {
      fail(
        "OBSERVE_NOT_LISTENING",
        `The portal is not listening to ${record.target.instance}. Turn it on for that box on the fleet screen, then watch again.`,
      );
      return;
    }
    if (!answer.observing) {
      fail("OBSERVE_RESUME_FAILED", "The server did not re-open this conversation's observation.");
      return;
    }
    await readHistory(record);
    if (record.observe === "reconnecting") {
      record.observe = "live";
      changed();
    }
  }, [changed, get, permits, readHistory]);

  const send = useCallback(
    (text: string) => {
      if (!selected.current || !permits(selected.current.instance)) return;
      const record = get(selected.current);
      const body = text.trim();
      if (!body || record.sending || record.aborting) return;
      clearReconnect(record);
      const turn = ++record.turn;
      record.dropped = false;
      record.live = null;
      record.turnError = null;
      // Whatever the previous turn held belongs to the transcript before this
      // one arms the hold again; nothing the box wrote down is carried across
      // a turn boundary in a buffer only the previous turn could empty.
      releaseHeld(record);
      record.sending = true;
      record.activity = "thinking";
      const target = record.target;
      const session = record.resolvedSession ?? target.session;
      const at = new Date().toISOString();
      const seed = { session: session ?? "", at };
      record.turnSeed = seed;
      record.messages = [
        ...record.messages,
        {
          id: `local:${at}`,
          session: session ?? "",
          role: "user",
          author: null,
          at,
          blocks: [{ kind: "text", markdown: body }],
          usage: null,
          error: null,
          incomplete: null,
        } as ChatMessageView,
      ];
      changed();
      let seq = -1;
      let lastDelta: string | null = null;
      let idle: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      let terminal = false;
      const valid = () => alive.current && record.turn === turn;
      const finish = () => {
        if (idle) clearTimeout(idle);
        idle = null;
      };
      const end = (ok: boolean, error: Failure | null) => {
        if (settled || !valid()) return;
        settled = true;
        finish();
        record.cancel = null;
        record.activity = "idle";
        if (!record.aborting) record.sending = false;
        // The live message stops speaking for the held rows here — including on
        // the paths that never re-read the transcript, which is the whole point
        // of releasing on the settle rather than on the re-read. Only a settle
        // gets this far: a reconnect core drove on the box socket (§9.2) is a
        // status block on a turn still in flight, and the hold outlives it.
        if (!record.sending) releaseHeld(record);
        if (error) record.turnError = error;
        record.dropped = !ok;
        if (!ok && record.live) record.live = { ...record.live, incomplete: true };
        changed();
        if (record.aborting) return;
        // A first send can create the durable session that the history response
        // now names. Refresh its origin evidence alongside the transcript.
        void readSessions(record);
        if (!ok && !error) reconnect(record, 1);
        else {
          // The rail is told after the read, not before it: the box's own stamp
          // and its own words for this reply arrive with the transcript.
          const assembled = record.live;
          void readHistory(record).then(() => {
            if (!ok || !valid()) return;
            const arrival = replyArrival(record, assembled);
            if (arrival) arrived.current?.(arrival);
          });
        }
      };
      const tick = () => {
        finish();
        idle = setTimeout(() => {
          record.cancel?.();
          end(false, null);
        }, 10 * 60_000);
      };
      const cancel = apiRef.current.sendTurn(
        target.instance,
        target.bot,
        body,
        {
          onFrame: (frame) => {
            if (!valid() || settled || terminal) return;
            tick();
            if (frame.type === "error") {
              terminal = true;
              record.activity = "idle";
              changed();
              return;
            }
            if (frame.seq < seq) return;
            if (frame.type === "delta") {
              const fingerprint = `${frame.seq}:${frame.text}`;
              if (fingerprint === lastDelta) return;
              lastDelta = fingerprint;
            }
            seq = frame.seq;
            terminal = frame.type === "done";
            record.activity = nextTurnActivity(record.activity, frame);
            record.live = assemble(record.live, frame, seed);
            changed();
          },
          onEnd: end,
        },
        session ? { session } : {},
      );
      if (!settled) {
        record.cancel = () => {
          finish();
          cancel();
        };
        tick();
      }
    },
    [assemble, changed, clearReconnect, get, readHistory, readSessions, reconnect, permits],
  );

  const abort = useCallback(async () => {
    if (!selected.current || !permits(selected.current.instance)) return;
    const record = get(selected.current);
    if (record.aborting) return;
    record.aborting = true;
    const turn = record.turn;
    const cancel = record.cancel;
    clearReconnect(record);
    record.dropped = false;
    changed();
    try {
      await apiRef.current.abortTurn(
        record.target.instance,
        record.target.bot,
        record.resolvedSession ?? record.target.session,
      );
    } catch (error) {
      if (alive.current && record.turn === turn)
        record.turnError = {
          code: "ABORT_FAILED",
          message: error instanceof Error ? error.message : String(error),
        };
    } finally {
      if (alive.current && record.turn === turn) {
        // Invalidate the old stream before cancelling, since cancellation can
        // synchronously report an end and must not schedule reconnect retries.
        record.turn += 1;
        cancel?.();
        record.cancel = null;
        record.sending = false;
        releaseHeld(record);
        record.activity = "idle";
        record.aborting = false;
        changed();
        await Promise.all([readHistory(record), readSessions(record)]);
      }
    }
  }, [changed, clearReconnect, get, readHistory, readSessions, permits]);

  /**
   * The transcript alone, for a caller that runs on a tick.
   *
   * `reloadHistory` reads the session *list* alongside the transcript because
   * an operator asking for a reload after a mutation is asking about both. A
   * timer is not that caller: the list of a bot's conversations changes when
   * somebody opens or archives one, never because five seconds went by, and
   * pairing the two put a second gateway read on the tailnet for every tick of
   * a poll that exists to catch new *messages*.
   */
  const reloadTranscript = useCallback(async () => {
    if (!selected.current || !permits(selected.current.instance)) return;
    const record = get(selected.current);
    clearReconnect(record);
    changed();
    await readHistory(record);
  }, [changed, clearReconnect, get, readHistory, permits]);

  const reloadHistory = useCallback(async () => {
    if (!selected.current || !permits(selected.current.instance)) return;
    const record = get(selected.current);
    clearReconnect(record);
    changed();
    await Promise.all([readHistory(record), readSessions(record)]);
  }, [changed, clearReconnect, get, readHistory, readSessions, permits]);
  const stageDraft = useCallback(
    (target: ChatSelection, text: string) => {
      if (!permits(target.instance)) return;
      get(target).draft = text;
      changed();
    },
    [changed, get, permits],
  );
  const setDraft = useCallback(
    (text: string) => {
      if (selected.current) stageDraft(selected.current, text);
    },
    [stageDraft],
  );
  const turnActivities: ConversationActivity[] = [...new Set(records.current.values())]
    .filter((record) => record.activity !== "idle")
    .map((record) => ({
      ...record.target,
      session: record.resolvedSession ?? record.target.session,
      activity: record.activity,
    }));
  // Stable while the watch is: the provider's context value is memoised on it,
  // and a fresh object every render would make every consumer re-render.
  const observation = useMemo<Observation>(
    () => ({ state: current.observe, attempt: current.observeAttempt, error: current.observeError }),
    [current.observe, current.observeAttempt, current.observeError],
  );
  return {
    ...current,
    turnActivities,
    selection,
    select,
    send,
    abort,
    reloadHistory,
    reloadTranscript,
    stageDraft,
    setDraft,
    observation,
    observe,
    observeDropped,
    observeTransport,
    resumeObservation,
  };
}
