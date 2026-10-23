/** Conversation records outlive the frame displaying them, but never their fleet provider. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatApi, ChatSelection } from "./chat-types.ts";
import type { ChatMessageView, SessionView } from "../api/index.ts";
import { nextTurnActivity } from "./chat-activity.ts";
import { previewOf } from "./chat-logic.ts";
import {
  landOnSegment,
  openRequestIn,
  releaseIn,
  rememberTurnPrompt,
  settleIn,
  trackRequest,
} from "./chat-requests.ts";
import { STEER_PREFIX } from "./chat-recovery.ts";
import { isProcessEventMessage, previewText } from "./process-events.ts";
import type { ConversationActivity } from "./chat-activity.ts";
import {
  absorbEarly,
  fresh,
  isLocal,
  keepCommandRows,
  key,
  noteContext,
  noteRows,
  releaseHeld,
  withCommandRows,
} from "./chat-conversation-record.ts";
import type { Assemble, Conversation, Failure } from "./chat-conversation-record.ts";
import { frameContext, usageContext } from "./context-usage.ts";
import { noteSubagentFrame, reapplySubagents } from "./chat-subagents.ts";
import { reuseMessages } from "./chat-message-identity.ts";
import { useSubagentControls } from "./chat-subagent-control.ts";
import { useObservation } from "./chat-observation.ts";
import { devtap } from "./devtap.ts";
import { isNewSessionCommand } from "@hermetic/core/shared";
import { chatHash, isChatHash } from "./chat-routing.ts";
import {
  localAttachmentBlock,
  markDelivery,
  mergeAttachments,
  useDraftAttachments,
} from "./chat-attachments.ts";
import type { SentAttachment } from "./chat-attachments.ts";
import type { ChatArrival, Observation } from "./chat-observation.ts";
import { conversationTasks, taskListCache } from "./task-list.ts";
import type { TodoFound } from "@hermetic/core/shared";

export { OBSERVE_QUIET_MS } from "./chat-observation.ts";
export type { ChatArrival, Observation } from "./chat-observation.ts";
export type { ObserveState } from "./chat-conversation-record.ts";

/** The first transcript recovery is immediate; later attempts back off to eight seconds. */
export function reconnectDelayMs(attempt: number): number {
  const delays = [0, 1000, 2000, 4000, 8000];
  return delays[Math.max(0, Math.min(attempt - 1, delays.length - 1))] as number;
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

/**
 * What steering a running turn came to. The box's four answers (`chat.steer`),
 * plus `refused` for a steer this store would not make at all — no selection,
 * a box this tab may no longer talk to, nothing to say.
 */
export type SteerOutcome = "redirected" | "queued" | "rejected" | "idle" | "refused";

/**
 * The optimistic copy of the operator's prompt, until the box echoes it back.
 * A steer's is marked (`STEER_PREFIX`), so a failed turn's Retry binds to the
 * prompt that started the turn rather than to words steered into it. `steered`
 * is set only on one the box took into the running turn (`redirected`).
 */
function localPrompt(
  body: string,
  at: string,
  session: string | null,
  {
    steer = false,
    steered = false,
    attachments = [],
  }: { steer?: boolean; steered?: boolean; attachments?: readonly SentAttachment[] } = {},
): ChatMessageView {
  return {
    id: `${steer ? STEER_PREFIX : "local:"}${at}`,
    session: session ?? "",
    role: "user",
    author: null,
    at,
    blocks: [
      ...(body ? [{ kind: "text", markdown: body }] : []),
      ...attachments.map((a) => localAttachmentBlock(a, "sending")),
    ],
    usage: null,
    error: null,
    incomplete: null,
    // Drawn as the box's steer row will be, so the echo replaces it unchanged.
    ...(steered ? { steered: true } : {}),
  } as ChatMessageView;
}

/**
 * Whether the transcript already carries the reply `live` assembled: the same
 * id, or a row the box wrote for it — not the operator's, not a background
 * event, and stamped no earlier than the reply began. The test `readHistory`
 * applies when it decides a read has caught up with the live message.
 */
function answered(messages: readonly ChatMessageView[], live: ChatMessageView): boolean {
  const since = Date.parse(live.at);
  return messages.some(
    (m) =>
      m.id === live.id || (m.role !== "user" && !isProcessEventMessage(m) && Date.parse(m.at) >= since),
  );
}

export function useConversations(
  api: ChatApi,
  refreshSwarms: () => Promise<void>,
  assemble: Assemble,
  instances?: readonly string[],
  onArrival?: (arrival: ChatArrival) => void,
  isThreadShown?: (instance: string, bot: string) => boolean,
) {
  const arrived = useRef(onArrival);
  arrived.current = onArrival;
  const shown = useRef(isThreadShown);
  shown.current = isThreadShown;
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
  /**
   * The attachment pipeline's `cancelAll`, read through a ref because the
   * pipeline is built further down and these effects close over it.
   */
  const cancelUploads = useRef<(instance?: string) => void>(() => undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // An upload outlives no store: free what the main process holds for it.
      cancelUploads.current();
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
    const lost = new Set<string>();
    for (const [id, record] of records.current) {
      if (permits(record.target.instance)) continue;
      lost.add(record.target.instance);
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
    // The records' chips go with them; their uploads must not be left behind.
    for (const instance of lost) cancelUploads.current(instance);
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
            winner.attachments = mergeAttachments(winner.attachments, loser.attachments);
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
        // Kept as the objects already held wherever a row is unchanged
        // (`reuseMessages`, once the children are placed back below): a re-read
        // that says what the transcript already said re-renders none of it.
        const held = record.messages;
        record.messages = withCommandRows(record, absorbEarly(record, result.messages));
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
            // T3: the inspector shows the live message giving way to the box's copy.
            if (devtap.on) devtap.history(record.target, record.live.id);
            record.live = null;
            record.dropped = false;
          } else record.live = { ...record.live, incomplete: true };
        }
        // After the live message is retired, never before: a child placed on a
        // live message the read then drops would be lost with it.
        reapplySubagents(record);
        record.messages = reuseMessages(held, record.messages);
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

  const refusedTasks = useRef(new Map<string, TodoFound>());
  const taskCache = useRef(taskListCache());
  const { observe, observeDropped, observeTransport, resumeObservation } = useObservation({
    records,
    refusedTasks,
    alive,
    apiRef,
    arrived,
    shown,
    selected,
    permits,
    get,
    changed,
    observeLive,
    readHistory,
    readSessions,
  });

  /** The composer's pending files, per conversation (`chat-attachments.ts`). */
  const attachments = useDraftAttachments({ get, changed, permits, api: api.files });
  cancelUploads.current = attachments.cancelAll;

  /** Start a turn. `false` when this store refused to, and nothing was sent. */
  const send = useCallback(
    (text: string, requested?: ChatSelection, files: readonly SentAttachment[] = []): boolean => {
      const where = requested ?? selected.current;
      if (!where || !permits(where.instance)) return false;
      const record = get(where);
      const body = text.trim();
      if ((!body && files.length === 0) || record.sending || record.aborting) return false;
      // `/new` in an additional session opens a fresh one, as Desktop's local
      // `/new` does; the gateway would only reset its slash worker. Bot Chat
      // (or a session not yet listed) goes to core, which compacts (§9.2).
      const kind = record.sessions.find((s) => s.id === where.session)?.kind;
      const open = apiRef.current.openConversation;
      if (open && kind && kind !== "canonical" && files.length === 0 && isNewSessionCommand(body)) {
        const { instance, bot } = where;
        open({ instance, bot, new_session: true }).then(
          (opened) => {
            if (!alive.current || !select(opened.instance, opened.bot, opened.session)) return;
            if (isChatHash(window.location.hash)) window.location.hash = chatHash(opened);
          },
          (error: unknown) => {
            if (!alive.current) return;
            record.turnError = {
              code: (error as { code?: string }).code ?? "UNCLASSIFIED",
              message: error instanceof Error ? error.message : String(error),
            };
            changed();
          },
        );
        return true;
      }
      clearReconnect(record);
      const turn = ++record.turn;
      record.dropped = false;
      record.turnError = null;
      // Whatever the previous turn held belongs to the transcript before this
      // one arms the hold again; nothing the box wrote down is carried across
      // a turn boundary in a buffer only the previous turn could empty.
      releaseHeld(record);
      // The previous reply stays on screen, above this prompt, until a read
      // replaces it with the box's copy. The read the previous turn's end asked
      // for is cancelled just above, so a message sent before it landed —
      // every message the queue sends — used to blank the answer for the
      // length of the new turn.
      if (record.live && !answered(record.messages, record.live))
        record.messages = [...record.messages, record.live];
      record.live = null;
      record.sending = true;
      record.activity = "thinking";
      const target = record.target;
      const session = record.resolvedSession ?? target.session;
      const at = new Date().toISOString();
      const seed = { session: session ?? "", at };
      record.turnSeed = seed;
      record.segments = [];
      record.segmentAt = at;
      record.openRequests.clear();
      const echo = localPrompt(body, at, session, { attachments: files });
      record.messages = [...record.messages, echo];
      // Retry and Edit on a failure card find the files by the prompt they
      // went with, whichever way the failure arrives (`failedTurnPrompt`).
      if (files.length > 0) rememberTurnPrompt(record, echo.id, { text: body, attachments: files });
      // The echo's chips read "sending" until the turn's first frame says the
      // box took it, and "not delivered" if it ended without one.
      let accepted = files.length === 0;
      const deliver = (state: "delivered" | "failed") => {
        if (accepted) return;
        accepted = true;
        markDelivery(record, echo.id, state);
      };
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
        deliver(error ? "failed" : "delivered");
        record.cancel = null;
        record.rearm = null;
        record.activity = "idle";
        record.segments = [];
        record.openRequests.clear();
        if (!record.aborting) record.sending = false;
        // Before the re-read below retires the live message: the box keeps no
        // copy of a slash command's answer.
        keepCommandRows(record, echo);
        // The box's next probe says `true` again if it is still working.
        record.remoteBusy = false;
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
      // Arms only while nothing is open: a turn parked on an approval or a
      // clarify is waiting on the operator, not silent, and cancelling it for
      // that would take the turn away from someone still reading the question.
      // There is deliberately no upper bound on how long it may stay parked.
      const tick = () => {
        finish();
        if (record.openRequests.size > 0) return;
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
            // Any frame is a sign of life, but only restarts the timer while no
            // request is open — a reconnect status or a notice arriving while a
            // question waits must not start the clock on the operator.
            tick();
            if (frame.type !== "error") deliver("delivered");
            if (frame.type === "error") {
              terminal = true;
              record.openRequests.clear();
              tick();
              record.activity = "idle";
              // The failure is drawn on the turn itself, minted if it came first.
              record.live = assemble(record.live, frame, { ...seed, at: record.segmentAt ?? seed.at });
              if (devtap.on) devtap.applied(record.target, frame, record.live?.id ?? null);
              if (record.live)
                rememberTurnPrompt(record, record.live.id, { text: body, attachments: files });
              changed();
              return;
            }
            if (frame.seq < seq) {
              // T3 (`devtap.ts`): one boolean read while the tools are off.
              if (devtap.on)
                devtap.dropped(record.target, frame, "seq_lt_last", record.live?.id ?? null);
              return;
            }
            if (frame.type === "delta") {
              const fingerprint = `${frame.seq}:${frame.text}`;
              if (fingerprint === lastDelta) {
                if (devtap.on) devtap.dropped(record.target, frame, "dup", record.live?.id ?? null);
                return;
              }
              lastDelta = fingerprint;
            }
            seq = frame.seq;
            terminal = frame.type === "done";
            if (terminal) {
              record.openRequests.clear();
              tick();
            }
            // Opening a request stops the clock; closing the last one restarts it.
            else if (trackRequest(record, frame)) tick();
            record.activity = nextTurnActivity(record.activity, frame);
            // A child's frame is reconciled against every copy already drawn
            // and the observed one (`noteSubagentFrame`); `null` merges nothing.
            const block =
              frame.type === "block" ? noteSubagentFrame(record, frame.block, Date.now()) : null;
            const merged = frame.type === "block" && block ? { ...frame, block } : frame;
            const reduces = frame.type !== "block" || Boolean(block);
            const landed = reduces ? landOnSegment(record, merged, seed, assemble) : null;
            if (reduces && landed === null)
              record.live = assemble(record.live, merged, { ...seed, at: record.segmentAt ?? seed.at });
            // T3: filed under the part of the reply the block landed on, when a
            // steer had closed it off, else under the live message.
            if (devtap.on && reduces)
              devtap.applied(record.target, merged, landed ?? record.live?.id ?? frame.message);
            noteContext(record, frameContext(frame, new Date().toISOString()));
            changed();
          },
          onEnd: end,
        },
        // Never an implicit steer: a busy session queues this behind its turn.
        {
          ...(session ? { session } : {}),
          queued: true,
          ...(files.length > 0 ? { attachments: files } : {}),
        },
      );
      if (!settled) {
        record.cancel = () => {
          finish();
          cancel();
        };
        record.rearm = () => {
          if (valid() && !settled && !terminal) tick();
        };
        tick();
      }
      return true;
    },
    [assemble, changed, clearReconnect, get, readHistory, readSessions, reconnect, permits, select],
  );

  /**
   * Say something to the turn that is running, without stopping it (§9.2).
   *
   * The box takes the text into the turn in flight (`chat.steer`, upstream's
   * `session.redirect`), so the reply that is streaming changes course rather
   * than ending. On screen that is three things, in this order: the reply so
   * far is closed off where it stands, the operator's words go under it, and
   * what the turn says next starts below them. Without the split the prompt
   * would be drawn above the whole live reply — including the part written
   * before it was sent — or, worse, below the part written after it.
   *
   * Nothing is drawn until the box has said yes. A `rejected` or an `idle`
   * comes back to the caller untouched, and the caller decides what forcing the
   * message through means (`useSendQueue`).
   */
  const steer = useCallback(
    async (text: string, target?: ChatSelection): Promise<SteerOutcome> => {
      const where = target ?? selected.current;
      if (!where || !permits(where.instance)) return "refused";
      const record = get(where);
      const body = text.trim();
      if (!body) return "refused";
      // A turn this tab did not start is steered the same way (`chat.steer`
      // finds the running turn on the box), when the box says one is running.
      const own = record.sending;
      if (record.aborting || (!own && record.remoteBusy !== true)) return "idle";
      const ask = apiRef.current.steerTurn;
      if (!ask) return "rejected";
      const turn = record.turn;
      const session = record.resolvedSession ?? record.target.session;
      let status: SteerOutcome;
      try {
        status = (await ask(record.target.instance, record.target.bot, body, session)).status;
      } catch {
        return "rejected";
      }
      if (!alive.current || !permits(record.target.instance)) return "refused";
      if (status === "idle" && !record.sending && record.remoteBusy) {
        record.remoteBusy = false;
        changed();
      }
      if (status !== "redirected" && status !== "queued") return status;
      const at = new Date().toISOString();
      if (record.turn === turn && record.sending && record.live && record.live.blocks.length > 0) {
        const id = `${record.live.id}~${record.segments.length + 1}`;
        // T3: the inspector's notes follow the blocks to the part's new id.
        if (devtap.on) devtap.segment(record.target, record.live.id, id);
        record.messages = [...record.messages, { ...record.live, id }];
        record.segments = [...record.segments, id];
        record.live = null;
      }
      record.segmentAt = at;
      // Only `redirected` went into the turn; `queued` runs as a prompt of its own.
      // Upstream records a redirect made while tools run as a marked steer row
      // (`steered`), but one made during a model request as a plain user row
      // (`_apply_active_turn_redirect`), so there the tag drops at the echo.
      record.messages = [
        ...record.messages,
        localPrompt(body, at, session, { steer: true, steered: status === "redirected" }),
      ];
      changed();
      // The turn ended while the box was answering: its re-read has already
      // been asked for and may predate this prompt, so ask again. Not for a
      // turn another client runs: the box records the steer at its next tool
      // result, and a read now would drop the prompt until then.
      if (own && !record.sending) void readHistory(record);
      return status;
    },
    [changed, get, permits, readHistory],
  );

  /**
   * Stop counting `request_id` as one the turn is parked on, without closing
   * its card: the operator answered it from the card itself, and the gateway
   * sends no close after an ordinary answer. The no-frame timer may run again,
   * `openRequest` no longer names it and the message stops reading "waiting",
   * but no notice is added, so the card stays on screen as its settled summary.
   * `target` names the conversation when the caller captured it before an
   * await; the current selection otherwise.
   */
  const releaseRequest = useCallback(
    (request_id: string, target?: ChatSelection) => {
      const where = target ?? selected.current;
      if (!where || !permits(where.instance)) return;
      const record = get(where);
      if (releaseIn(record, request_id)) record.rearm?.();
      changed();
    },
    [changed, get, permits],
  );

  /**
   * Close a request card the box has let go of, without waiting for it to say
   * so in the stream. The composer's steer declines an open clarify before
   * sending and calls this once the box has acknowledged the skip, never
   * before: a skip that failed leaves the card answerable. The close is the
   * same finished `notice` a `request.cancel` lands as (`settleIn`), so the
   * card settles to its summary (`closedRequests`) and the turn reads as
   * thinking again (`nextTurnActivity`). `target` as for `releaseRequest`.
   */
  const settleRequest = useCallback(
    (request_id: string, outcome: "skipped" | "answered", target?: ChatSelection) => {
      const where = target ?? selected.current;
      if (!where || !permits(where.instance)) return;
      const record = get(where);
      releaseRequest(request_id, where);
      const settled = settleIn(record, request_id, outcome, assemble);
      if (!settled) return;
      record.activity = nextTurnActivity(record.activity, settled);
      changed();
    },
    [assemble, changed, get, permits, releaseRequest],
  );

  /**
   * The clarify the selected conversation is waiting on, if any (`openRequestIn`).
   * Read at call time, so a caller acting on a keypress sees the record as it
   * is rather than as the last render left it.
   */
  const openRequest = useCallback(
    (target?: ChatSelection): string | null => {
      const where = target ?? selected.current;
      if (!where || !permits(where.instance)) return null;
      return openRequestIn(get(where));
    },
    [get, permits],
  );

  const abort = useCallback(
    async (target?: ChatSelection) => {
      const where = target ?? selected.current;
      if (!where || !permits(where.instance)) return;
      const record = get(where);
      if (record.aborting) return;
      record.aborting = true;
      // A stop that fails says so; an earlier failure must not outlive this attempt.
      if (record.turnError?.code === "ABORT_FAILED") record.turnError = null;
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
          record.remoteBusy = false;
          record.segments = [];
          record.openRequests.clear();
          record.rearm = null;
          releaseHeld(record);
          record.activity = "idle";
          record.aborting = false;
          changed();
          await Promise.all([readHistory(record), readSessions(record)]);
        }
      }
    },
    [changed, clearReconnect, get, readHistory, readSessions, permits],
  );

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
  const reloadTranscript = useCallback(
    async (target?: ChatSelection) => {
      const where = target ?? selected.current;
      if (!where || !permits(where.instance)) return;
      const record = get(where);
      clearReconnect(record);
      changed();
      await readHistory(record);
    },
    [changed, clearReconnect, get, readHistory, permits],
  );

  const reloadHistory = useCallback(
    async (target?: ChatSelection) => {
      const where = target ?? selected.current;
      if (!where || !permits(where.instance)) return;
      const record = get(where);
      clearReconnect(record);
      changed();
      await Promise.all([readHistory(record), readSessions(record)]);
    },
    [changed, clearReconnect, get, readHistory, readSessions, permits],
  );
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
  const taskLists = conversationTasks(
    records.current,
    refusedTasks.current,
    permits,
    taskCache.current,
  );
  // Stable while the watch is: the provider's context value is memoised on it,
  // and a fresh object every render would make every consumer re-render.
  const observation = useMemo<Observation>(
    () => ({ state: current.observe, attempt: current.observeAttempt, error: current.observeError }),
    [current.observe, current.observeAttempt, current.observeError],
  );
  const view = useCallback((target: ChatSelection) => get(target), [get]);
  const ensure = useCallback(
    (target: ChatSelection) => {
      if (!permits(target.instance)) return;
      const record = get(target);
      if (!record.historyLoading && !record.historyRead && !record.sending && !record.aborting)
        void readHistory(record);
      if (record.sessionsState === "pending") void readSessions(record);
    },
    [get, permits, readHistory, readSessions],
  );
  return {
    ...current,
    turnActivities,
    taskLists,
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
    /** A pane reads a record without changing the full view's selection. */
    view,
    attachments,
    /** Opening a pane performs the same first reads as selecting a full-view thread. */
    ensure,
  };
}
