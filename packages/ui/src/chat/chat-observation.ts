/**
 * The observation side of the conversation store: routing fan-in frames to
 * their records (`observe`, whose per-event rules are `chat-observe-apply.ts`),
 * the re-read queue a `dropped` frame fills, the fan-in socket's own state, and
 * asking a terminated observation back.
 *
 * A sub-hook of `useConversations` (`chat-conversations.ts`), which owns the
 * records and the history and session reads this calls; every handle arrives
 * in `deps` and is as stable as it was there.
 */
import { useCallback, useRef } from "react";
import type { RefObject } from "react";
import type { ChatConversationView, ChatObserveView } from "../api/index.ts";
import type { ChatApi, ChatSelection } from "./chat-state.tsx";
import type { Conversation } from "./chat-conversation-record.ts";
import { noteBusy } from "./chat-remote-busy.ts";
import {
  applyError,
  applyMessage,
  applyReconnect,
  applySnapshot,
  applySubagent,
} from "./chat-observe-apply.ts";
import type { ChatArrival } from "./chat-observe-apply.ts";

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

/**
 * The ref handles here must be the caller's `useRef` objects: the callbacks
 * read `.current` at call time and leave the refs out of their deps arrays, so
 * a fresh `{ current }` literal would be captured once and go stale.
 */
export interface ObservationDeps {
  records: RefObject<Map<string, Conversation>>;
  alive: RefObject<boolean>;
  selected: RefObject<ChatSelection | null>;
  arrived: RefObject<((arrival: ChatArrival) => void) | undefined>;
  shown: RefObject<((instance: string, bot: string) => boolean) | undefined>;
  api: RefObject<ChatApi>;
  permits: (instance: string) => boolean;
  get: (target: ChatSelection) => Conversation;
  changed: () => void;
  readHistory: (record: Conversation) => Promise<boolean>;
  readSessions: (record: Conversation) => Promise<void>;
}

export function useObservation(deps: ObservationDeps) {
  const {
    records,
    alive,
    selected,
    arrived,
    shown,
    api: apiRef,
    permits,
    get,
    changed,
    readHistory,
    readSessions,
  } = deps;
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
        case "snapshot":
          applySnapshot(record, event, { records, readSessions });
          break;
        case "message":
          applyMessage(record, conversation, event, { selected, arrived, shown });
          break;
        case "subagent":
          applySubagent(record, event, records);
          break;
        case "busy": {
          // The box's word on a turn running here, whoever started it.
          if (!noteBusy(record, event)) return;
          break;
        }
        case "reconnect":
          applyReconnect(record, event, { alive, changed });
          break;
        case "error":
          applyError(record, event);
          break;
      }
      changed();
    },
    [changed, get, permits, readSessions],
  );

  /** The re-read queue's state; see `REREAD_WIDTH`. */
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
   * part of the store too.
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
        // Unknown while the feed is down; the replayed snapshot and probes say again.
        else record.remoteBusy = null;
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
  const resumeObservation = useCallback(
    async (target?: ChatSelection) => {
      const where = target ?? selected.current;
      if (!where || !permits(where.instance)) return;
      const record = get(where);
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
         * Every other address in the store is `resolvedSession ?? target.session`
         * because those calls read a conversation, and reading wants the
         * concrete session. A resume names a *subscription*, and the server keys
         * a canonical one on `session: null` (`chat-owner.ts` `keyOf`). A
         * canonical record has `resolvedSession` filled in by the history read
         * and moved by every rollover, so sending it here asked the server for a
         * conversation it does not hold: it started a second pinned observation
         * of one conversation, left the canonical key's remembered failure in
         * place, and lost the new subscription again at the next reconcile.
         * `target.session` is the identity, and the rollover block (`applySnapshot`) keeps it
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
    },
    [changed, get, permits, readHistory],
  );

  return { observe, observeDropped, observeTransport, resumeObservation };
}
