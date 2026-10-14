/**
 * The turn side of the conversation store: starting a turn (`send`) and
 * recovering its dropped response (`reconnect`), steering and stopping it, and
 * the request cards it parks on — releasing, settling and reading the open one.
 *
 * A sub-hook of `useConversations` (`chat-conversations.ts`), which owns the
 * records and the history and session reads a turn's settle point asks for;
 * every handle arrives in `deps` and is as stable as it was there.
 */
import { useCallback } from "react";
import type { RefObject } from "react";
import type { ChatMessageView } from "../api/index.ts";
import type { ChatApi, ChatSelection } from "./chat-state.tsx";
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
import { isProcessEventMessage, previewText } from "./process-events.ts";
import { isLocal, localPrompt, noteContext, releaseHeld } from "./chat-conversation-record.ts";
import type { Assemble, Conversation, Failure } from "./chat-conversation-record.ts";
import { frameContext } from "./context-usage.ts";
import { noteSubagentFrame } from "./chat-subagents.ts";
import type { ChatArrival } from "./chat-observe-apply.ts";

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

/**
 * The ref handles here must be the caller's `useRef` objects: the callbacks
 * read `.current` at call time and leave the refs out of their deps arrays, so
 * a fresh `{ current }` literal would be captured once and go stale.
 */
export interface TurnActionDeps {
  alive: RefObject<boolean>;
  selected: RefObject<ChatSelection | null>;
  arrived: RefObject<((arrival: ChatArrival) => void) | undefined>;
  api: RefObject<ChatApi>;
  permits: (instance: string) => boolean;
  get: (target: ChatSelection) => Conversation;
  changed: () => void;
  clearReconnect: (record: Conversation) => void;
  readHistory: (record: Conversation) => Promise<boolean>;
  readSessions: (record: Conversation) => Promise<void>;
  refreshSwarms: () => Promise<void>;
  assemble: Assemble;
}

export function useTurnActions(deps: TurnActionDeps) {
  const {
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
  } = deps;
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

  /** Start a turn. `false` when this store refused to, and nothing was sent. */
  const send = useCallback(
    (text: string): boolean => {
      if (!selected.current || !permits(selected.current.instance)) return false;
      const record = get(selected.current);
      const body = text.trim();
      if (!body || record.sending || record.aborting) return false;
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
      record.messages = [...record.messages, localPrompt(body, at, session)];
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
        record.rearm = null;
        record.activity = "idle";
        record.segments = [];
        record.openRequests.clear();
        if (!record.aborting) record.sending = false;
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
            if (frame.type === "error") {
              terminal = true;
              record.openRequests.clear();
              tick();
              record.activity = "idle";
              // The failure is drawn on the turn itself, minted if it came first.
              record.live = assemble(record.live, frame, { ...seed, at: record.segmentAt ?? seed.at });
              if (record.live) rememberTurnPrompt(record, record.live.id, body);
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
            if ((frame.type !== "block" || block) && !landOnSegment(record, merged, seed, assemble))
              record.live = assemble(record.live, merged, { ...seed, at: record.segmentAt ?? seed.at });
            noteContext(record, frameContext(frame, new Date().toISOString()));
            changed();
          },
          onEnd: end,
        },
        // Never an implicit steer: a busy session queues this behind its turn.
        { ...(session ? { session } : {}), queued: true },
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
    [assemble, changed, clearReconnect, get, readHistory, readSessions, reconnect, permits],
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
    async (text: string): Promise<SteerOutcome> => {
      if (!selected.current || !permits(selected.current.instance)) return "refused";
      const record = get(selected.current);
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
        localPrompt(body, at, session, true, status === "redirected"),
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
  const openRequest = useCallback((): string | null => {
    if (!selected.current || !permits(selected.current.instance)) return null;
    return openRequestIn(get(selected.current));
  }, [get, permits]);

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
  }, [changed, clearReconnect, get, readHistory, readSessions, permits]);

  return { send, steer, settleRequest, releaseRequest, openRequest, abort };
}
