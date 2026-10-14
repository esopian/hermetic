/**
 * The conversation store: one record per conversation this browser holds,
 * which outlives the frame displaying it but never its fleet provider. Owns the
 * records, the selection, the transcript and session-list reads, drafts and
 * reloads, and composes the two sub-hooks that act on records — observation
 * (`chat-observation.ts`, per-event rules in `chat-observe-apply.ts`) and turns
 * (`chat-turn-actions.ts`).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatApi, ChatSelection } from "./chat-state.tsx";
import type { SessionView } from "../api/index.ts";
import { isProcessEventMessage } from "./process-events.ts";
import type { ConversationActivity } from "./chat-activity.ts";
import { absorbEarly, fresh, key, noteContext, noteRows } from "./chat-conversation-record.ts";
import type { Assemble, Conversation, Failure, ObserveState } from "./chat-conversation-record.ts";
import { usageContext } from "./context-usage.ts";
import { reapplySubagents } from "./chat-subagents.ts";
import { useSubagentControls } from "./chat-subagent-control.ts";
import { useObservation } from "./chat-observation.ts";
import { useTurnActions } from "./chat-turn-actions.ts";
import type { ChatArrival } from "./chat-observe-apply.ts";

export type { ObserveState } from "./chat-conversation-record.ts";
export { OBSERVE_QUIET_MS } from "./chat-observe-apply.ts";
export type { ChatArrival } from "./chat-observe-apply.ts";
export { reconnectDelayMs } from "./chat-turn-actions.ts";
export type { SteerOutcome } from "./chat-turn-actions.ts";

export interface Observation {
  state: ObserveState;
  /** Which upstream retry is in flight, as the server counted it. 0 when none. */
  attempt: number;
  error: Failure | null;
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
            // A new conversation (an archive's replacement) starts with no
            // figure; the old one keeps its own on `previous`.
            record.context = null;
          }
          session = opened.session;
        }
        // The first read of a conversation with no figure also asks the box for
        // the window its live session holds: the stored rows carry none, so a
        // reopened conversation would otherwise show no meter until its next
        // turn. Once only — a poll does not pay for it. Stamped with when it was
        // asked, so a turn frame that lands while it is in flight stays newer.
        const askUsage = !record.historyRead && record.context === null;
        const asked = new Date().toISOString();
        const result = await apiRef.current.fetchHistory(
          target.instance,
          target.bot,
          {
            ...(session ? { session } : {}),
            limit: 200,
            ...(askUsage ? { usage: true } : {}),
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
            noteContext(winner, loser.context);
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
          // This record's own entry only: the list is shared with the bot's
          // other records once read, so it is replaced, never pushed into.
          record.sessions = [
            ...record.sessions,
            {
              id: c.session,
              instance: c.instance,
              bot: c.bot,
              kind: c.kind,
              origin: "desktop",
              title: c.kind === "canonical" ? "Bot Chat" : "Chat",
              unread: 0,
              turn_count: 0,
            },
          ];
        }
        record.messages = absorbEarly(record, result.messages);
        noteRows(record, record.messages);
        noteContext(record, usageContext(result.usage, asked));
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
        // After the live message is retired, never before: a child placed on a
        // live message the read then drops would be lost with it.
        reapplySubagents(record);
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

  /**
   * Every record of the same bot as `record`, itself excluded. A bot's Bot Chat
   * and each of its additional sessions are separate records, but the list of
   * the bot's sessions is one fact about the bot, so a read made through any of
   * them is the answer for all of them.
   */
  const siblingsOf = useCallback((record: Conversation): Conversation[] => {
    const out: Conversation[] = [];
    for (const other of new Set(records.current.values())) {
      if (other === record) continue;
      if (other.target.instance !== record.target.instance) continue;
      if (other.target.bot !== record.target.bot) continue;
      out.push(other);
    }
    return out;
  }, []);
  /** The bot's session list, as every record of the bot now holds it. */
  const setSessions = useCallback(
    (record: Conversation, sessions: SessionView[]) => {
      for (const each of [record, ...siblingsOf(record)]) {
        each.sessions = sessions;
        each.sessionsState = "ready";
        each.sessionsError = null;
      }
    },
    [siblingsOf],
  );

  const readSessions = useCallback(
    async (record: Conversation) => {
      if (!alive.current || !permits(record.target.instance)) return;
      // A read for any record of this bot answers for all of them, so one in
      // flight through a sibling is superseded here rather than left to land
      // later with a list that may predate a session this one will name.
      for (const each of [record, ...siblingsOf(record)]) {
        each.sessionsController?.abort();
        each.sessionsController = null;
        each.sessionsGen += 1;
      }
      const controller = new AbortController();
      record.sessionsController = controller;
      const gen = record.sessionsGen;
      record.sessionsState = "pending";
      changed();
      try {
        const result = await apiRef.current.fetchSessions(
          record.target.instance,
          record.target.bot,
          controller.signal,
        );
        if (!alive.current || gen !== record.sessionsGen) return;
        setSessions(record, result.sessions);
      } catch (error) {
        if (!alive.current || gen !== record.sessionsGen) return;
        const message = error instanceof Error ? error.message : String(error);
        record.sessionsState = "failed";
        record.sessionsError = message;
        // A sibling still waiting on this read has no list of its own to fall
        // back on; one that already holds a list keeps it.
        for (const each of siblingsOf(record)) {
          if (each.sessionsState !== "pending") continue;
          each.sessionsState = "failed";
          each.sessionsError = message;
        }
      }
      changed();
    },
    [changed, permits, setSessions, siblingsOf],
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
  const subagents = useSubagentControls({
    current,
    selected,
    get,
    find: (target) => records.current.get(key(target)),
    changed,
    permits,
    api: apiRef,
  });
  useEffect(() => {
    if (!selection) return;
    const record = get(selection);
    if (!record.historyLoading && !record.sending && !record.aborting) void readHistory(record);
    if (record.sessionsState === "pending") void readSessions(record);
  }, [selection, get, readHistory, readSessions]);
  const { observe, observeDropped, observeTransport, resumeObservation } = useObservation({
    records,
    alive,
    selected,
    arrived,
    api: apiRef,
    permits,
    get,
    changed,
    readHistory,
    readSessions,
  });
  const { send, steer, settleRequest, releaseRequest, openRequest, abort } = useTurnActions({
    alive,
    selected,
    arrived,
    api: apiRef,
    permits,
    get,
    changed,
    clearReconnect,
    readHistory,
    readSessions,
    refreshSwarms,
    assemble,
  });

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
    steer,
    settleRequest,
    releaseRequest,
    openRequest,
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
    subagents,
  };
}
