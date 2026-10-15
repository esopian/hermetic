/**
 * The send queue (§9.2 "one active turn", "sending waits"), and the two ways
 * past it: steering a message into the running turn, and forcing one through
 * by stopping that turn.
 *
 * Enter while the agent works holds the message here, which stays the default.
 * "Send now" — ⌘Enter in the composer, or the button on a queued row — is the
 * operator saying the message should not wait. It is steered into the turn in
 * flight first (`chat.steer`), which changes the reply's course without
 * throwing away the work it has done. A box that will not take a steer gets
 * the blunter answer: the message goes to the head of the queue, the turn is
 * stopped without parking the queue, and the drain sends it the moment the
 * conversation is idle. Either way the message goes now, which is what was
 * asked; only how much of the running turn survives differs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatSelection } from "./chat-state.tsx";
import type { SteerOutcome } from "./chat-conversations.ts";
import { isWorking } from "./chat-remote-busy.ts";
import type { SentAttachment } from "./chat-attachments.ts";

/**
 * One message typed while the agent was busy, waiting its turn.
 *
 * §9.2 gives a conversation one active turn and says sending waits, so the
 * composer keeps taking text while a turn runs and the portal holds it here.
 * The queue is this browser's, not the box's: nothing is sent, nothing is
 * persisted, and a reload loses it — which is the honest shape, because the box
 * has never heard of these and cannot be asked to remember them.
 */
export interface QueuedMessage {
  /** Local, monotonic, and only ever used to remove a row. */
  id: string;
  text: string;
  at: string;
  /**
   * Files already staged on the box, sent with the message. A message with
   * any is never steered into a running turn (`force`): Hermes takes files
   * with a prompt, not mid-turn.
   */
  attachments?: readonly SentAttachment[];
}

const NO_FILES: readonly SentAttachment[] = [];

/** One stable empty queue, so an idle conversation does not re-render on identity. */
const NO_QUEUE: QueuedMessage[] = [];

/** The queue's key. Same three fields the conversation store keys its records on. */
const queueKeyOf = (target: ChatSelection): string =>
  JSON.stringify([target.instance, target.bot, target.session]);

export interface SendQueueDeps {
  selection: ChatSelection | null;
  sending: boolean;
  /**
   * The box's word on a turn running in the conversation, whoever started it
   * (`chat-remote-busy.ts`). `true` holds the queue like `sending` does, and
   * makes "send now" steer a turn this tab did not start.
   */
  remoteBusy: boolean | null;
  turnError: unknown;
  reconnecting: boolean;
  /**
   * The conversation store's own send, abort and steer, for the selected
   * conversation. `send` answers whether it started a turn.
   */
  send: (text: string, attachments?: readonly SentAttachment[]) => boolean;
  abort: () => Promise<void>;
  steer: (text: string) => Promise<SteerOutcome>;
  /** The persistent provider supplies these for independently visible dock panes. */
  stateFor?: (target: ChatSelection) => {
    sending: boolean;
    remoteBusy: boolean | null;
    turnError: unknown;
    reconnecting: boolean;
  };
  sendTo?: (text: string, target: ChatSelection, attachments?: readonly SentAttachment[]) => boolean;
  abortTo?: (target: ChatSelection) => Promise<void>;
  steerTo?: (text: string, target: ChatSelection) => Promise<SteerOutcome>;
}

export function useSendQueue({
  selection,
  sending,
  remoteBusy,
  turnError,
  reconnecting,
  send,
  abort,
  steer,
  stateFor,
  sendTo,
  abortTo,
  steerTo,
}: SendQueueDeps) {
  /**
   * Queued sends, per conversation, and every reason one does not go out.
   *
   * The queue is here rather than in the conversation record because a queued
   * message is not part of a turn: it has not been sent, the box has never
   * heard of it, and a turn that drops and reconnects must not resurrect one.
   * The store below owns turns; this owns the operator's backlog.
   *
   * `parked` is the other half of the rule, and four different things park a
   * queue: stopping a turn, a turn that failed, a turn that *dropped* and is
   * being re-read, and leaving the conversation. They are one judgement —
   * nothing goes out except into a conversation the operator is looking at,
   * which just finished a turn cleanly. Everything else keeps the rows and
   * waits to be told, and a deliberate send is what tells it.
   *
   * Nothing is removed before it has gone out. The store's `send` can refuse
   * the text it is handed — a conversation that is mid-abort, a box this tab is
   * no longer allowed to talk to — so a queue that dropped its head first would
   * destroy the message with no row and no error. `send` says whether it
   * started a turn, and the row leaves only when it did.
   */
  const [queues, setQueues] = useState<ReadonlyMap<string, QueuedMessage[]>>(() => new Map());
  const [watched, setWatched] = useState<ReadonlyMap<string, ChatSelection>>(() => new Map());
  const watchCounts = useRef(new Map<string, number>());
  const parked = useRef<Set<string>>(new Set());
  /**
   * A counter, because `parked` is a ref and the composer has to say so.
   *
   * The set itself stays a ref: the drain reads it in the same tick it was
   * written in — stopping a turn parks it and the turn ending must already see
   * that — and a state read one render behind would drain the queue it was
   * meant to hold. This is what tells React the answer changed.
   */
  const [parkedAt, setParkedAt] = useState(0);
  const queueSeq = useRef(0);
  const park = useCallback((key: string) => {
    if (parked.current.has(key)) return;
    parked.current.add(key);
    setParkedAt((tick) => tick + 1);
  }, []);
  const unpark = useCallback((key: string) => {
    if (parked.current.delete(key)) setParkedAt((tick) => tick + 1);
  }, []);

  /**
   * A head the store started a turn for, until a render shows that turn
   * running. Until then `sending` below is the value from before it started,
   * and without this the next head would go out on that stale answer.
   */
  const dispatched = useRef(new Set<string>());
  /** `sending` as of the last render, for `force`, which reads it after an await. */
  const state = useCallback(
    (target: ChatSelection) => stateFor?.(target) ?? { sending, remoteBusy, turnError, reconnecting },
    [stateFor, sending, remoteBusy, turnError, reconnecting],
  );
  const sendFor = useCallback(
    (text: string, target: ChatSelection, files: readonly SentAttachment[] = NO_FILES) =>
      sendTo?.(text, target, files) ?? send(text, files),
    [sendTo, send],
  );
  const abortFor = useCallback(
    (target: ChatSelection) => abortTo?.(target) ?? abort(),
    [abortTo, abort],
  );
  const steerFor = useCallback(
    (text: string, target: ChatSelection) => steerTo?.(text, target) ?? steer(text),
    [steerTo, steer],
  );
  const queued = selection ? (queues.get(queueKeyOf(selection)) ?? NO_QUEUE) : NO_QUEUE;
  /**
   * The queue is held rather than waiting its turn, and the composer says so.
   *
   * Only meaningful with rows to hold: a parked conversation with nothing in
   * it is a park that will be dropped the next time anything touches it, and
   * announcing that would be announcing bookkeeping.
   */
  const queueParked = useMemo(
    // `parkedAt` is the dependency that matters: `parked` is a ref, so the
    // counter is the only thing that says its answer moved.
    () => queued.length > 0 && selection !== null && parked.current.has(queueKeyOf(selection)),
    [queued, selection, parkedAt],
  );

  /** Drop one row, and forget a conversation the moment it has no backlog left. */
  const dropQueued = useCallback((key: string, id: string) => {
    setQueues((previous) => {
      const held = previous.get(key);
      if (!held) return previous;
      const rest = held.filter((row) => row.id !== id);
      if (rest.length === held.length) return previous;
      const next = new Map(previous);
      if (rest.length === 0) {
        next.delete(key);
        parked.current.delete(key);
      } else next.set(key, rest);
      return next;
    });
  }, []);

  const queueMessage = useCallback(
    (text: string, target = selection, files: readonly SentAttachment[] = NO_FILES) => {
      const body = text.trim();
      if ((!body && files.length === 0) || !target) return;
      const id = `q${++queueSeq.current}`;
      const at = new Date().toISOString();
      const key = queueKeyOf(target);
      const row: QueuedMessage =
        files.length > 0 ? { id, text: body, at, attachments: files } : { id, text: body, at };
      setQueues((previous) => {
        const next = new Map(previous);
        next.set(key, [...(previous.get(key) ?? []), row]);
        return next;
      });
    },
    [selection],
  );

  const unqueue = useCallback(
    (id: string, target = selection) => {
      if (!target) return;
      dropQueued(queueKeyOf(target), id);
    },
    [selection, dropQueued],
  );

  /**
   * One queued message goes out each time the conversation falls idle.
   *
   * One at a time and in order, because the box runs one turn per conversation
   * and a second `prompt.submit` mid-turn is a busy-mode interruption rather
   * than a second message.
   *
   * `reconnecting` is in the gate for a case that looks idle and is not: a turn
   * whose socket died ends with no error at all (`end(false, null)`), so
   * `sending` goes false, `turnError` stays null, and the transcript is being
   * re-read behind a band. Firing the backlog into that is how a queued message
   * lands in a conversation whose last turn nobody has read back yet.
   *
   * A turn the box reports from another client holds the drain the same way:
   * the head goes out once the box says the conversation is idle.
   */
  useEffect(() => {
    const targets = new Map(watched);
    if (selection) targets.set(queueKeyOf(selection), selection);
    for (const [key, target] of targets) {
      const current = state(target);
      if (isWorking(current.sending, current.remoteBusy)) continue;
      if (current.turnError || current.reconnecting) {
        dispatched.current.delete(key);
        if (queues.get(key)?.length) park(key);
        continue;
      }
      if (dispatched.current.has(key) || parked.current.has(key)) continue;
      const head = queues.get(key)?.[0];
      if (!head) continue;
      if (!sendFor(head.text, target, head.attachments)) {
        park(key);
        continue;
      }
      dispatched.current.add(key);
      dropQueued(key, head.id);
    }
  }, [selection, watched, queues, state, sendFor, park, dropQueued]);

  /** The turn the last head started is on screen; the next waits for it to end. */
  useEffect(() => {
    const targets = new Map(watched);
    if (selection) targets.set(queueKeyOf(selection), selection);
    for (const [key, target] of targets) if (state(target).sending) dispatched.current.delete(key);
  }, [sending, watched, selection, state]);

  /**
   * Leaving a conversation parks its queue.
   *
   * The drain only ever runs for the conversation on screen — the store's
   * `send` addresses the selected one and nothing else — so a backlog left
   * behind is frozen either way. What this stops is the surprise on the way
   * back: rows queued twenty minutes ago firing by themselves because the
   * operator re-opened the thread to read it. They are still there, still
   * removable, and the next deliberate send releases them.
   */
  useEffect(() => {
    if (!selection) return;
    const key = queueKeyOf(selection);
    return () => {
      if (watchCounts.current.has(key)) return;
      park(key);
      dispatched.current.delete(key);
    };
  }, [selection, park]);

  /**
   * A send the operator asked for un-parks the queue behind it. Answers whether
   * a turn started, as the store's own `send` does.
   */
  const sendMessage = useCallback(
    (text: string, target?: ChatSelection, files: readonly SentAttachment[] = NO_FILES): boolean => {
      if (target) {
        const key = queueKeyOf(target);
        unpark(key);
        dispatched.current.delete(key);
        return sendFor(text, target, files);
      }
      // The full view can select and send in the same callback (failure-card
      // recovery). Its store selection ref has moved, while this hook's render
      // value has not. Let the store address that current ref.
      if (selection) {
        const key = queueKeyOf(selection);
        unpark(key);
        dispatched.current.delete(key);
      }
      return send(text, files);
    },
    [selection, send, sendFor, unpark],
  );

  /** Stopping keeps the queue and parks it; nothing is dropped. */
  const stopTarget = useCallback(
    async (target: ChatSelection | null) => {
      if (target) {
        park(queueKeyOf(target));
        await abortFor(target);
      } else await abort();
    },
    [abort, abortFor, park],
  );
  // React may pass a click event to `onAbort`; the public callback takes none.
  const stopTurn = useCallback(() => stopTarget(selection), [stopTarget, selection]);

  /**
   * Put a message at the head of the queue — the row it already is, or a new
   * one — so it is the next thing the drain sends.
   */
  const promote = useCallback(
    (key: string, text: string, id: string | null, files: readonly SentAttachment[] = NO_FILES) => {
      setQueues((previous) => {
        const held = previous.get(key) ?? [];
        const row: QueuedMessage = (id ? held.find((r) => r.id === id) : undefined) ?? {
          id: `q${++queueSeq.current}`,
          text,
          at: new Date().toISOString(),
          ...(files.length > 0 ? { attachments: files } : {}),
        };
        const next = new Map(previous);
        next.set(key, [row, ...held.filter((r) => r.id !== row.id)]);
        return next;
      });
    },
    [],
  );

  /**
   * Send `text` now. `id` is the queued row it came from, or `null` for the
   * composer's own text. Read `sendingNow` rather than `sending`: the steer is
   * awaited, and the turn may have ended while the box was answering.
   *
   * Answers whether the message was taken — sent, steered, or held at the head
   * of the queue. `false` means nothing holds it: a queued row is still in the
   * queue (it leaves only once a send is accepted), and the composer's own
   * text and files go back to the composer.
   */
  const force = useCallback(
    async (
      text: string,
      id: string | null,
      target = selection,
      files: readonly SentAttachment[] = NO_FILES,
    ): Promise<boolean> => {
      const body = text.trim();
      if (!target || (!body && files.length === 0)) return false;
      const key = queueKeyOf(target);
      // Whether the turn to get past is this tab's own. One another client
      // started is steered too, but never stopped from here.
      const now = state(target);
      const own = now.sending;
      if (!own && now.remoteBusy !== true) {
        // Nothing to get past: this is an ordinary send, and like every
        // deliberate send it releases a parked queue behind it.
        if (!sendMessage(body, target, files)) return false;
        if (id) dropQueued(key, id);
        return true;
      }
      if (files.length > 0) {
        // Files go with a prompt, never into a running turn: the message waits
        // at the head of the queue, released, and goes the moment the turn ends.
        promote(key, body, id, files);
        unpark(key);
        return true;
      }
      const outcome = await steerFor(body, target);
      if (outcome === "redirected" || outcome === "queued") {
        if (id) dropQueued(key, id);
        return true;
      }
      if (outcome === "refused") return false;
      // The box would not take it into the running turn. Head of the queue,
      // queue released, turn stopped: the drain sends it once the stop lands.
      // A turn this tab did not start is left running, and the message waits.
      promote(key, body, id);
      unpark(key);
      if (own && state(target).sending) await abortFor(target);
      return true;
    },
    [selection, state, steerFor, abortFor, dropQueued, promote, unpark, sendMessage],
  );

  /**
   * Send what is in the composer now, past the queue and into the running
   * turn. `false` when nothing took it: the caller gives the text back.
   */
  const sendNow = useCallback(
    (text: string, target = selection, files: readonly SentAttachment[] = NO_FILES) =>
      force(text, null, target, files),
    [force, selection],
  );

  /** Send one queued row now rather than when the turn ends. A refused row stays queued. */
  const sendQueuedNow = useCallback(
    (id: string, target = selection): Promise<boolean> => {
      if (!target) return Promise.resolve(false);
      const row = queues.get(queueKeyOf(target))?.find((r) => r.id === id);
      return row ? force(row.text, id, target, row.attachments ?? NO_FILES) : Promise.resolve(false);
    },
    [selection, queues, force],
  );

  /** A mounted pane may drain its own queue; leaving parks it for the next visit. */
  const watch = useCallback(
    (target: ChatSelection) => {
      const key = queueKeyOf(target);
      watchCounts.current.set(key, (watchCounts.current.get(key) ?? 0) + 1);
      setWatched((previous) => new Map(previous).set(key, target));
      return () => {
        const remaining = (watchCounts.current.get(key) ?? 1) - 1;
        if (remaining > 0) {
          watchCounts.current.set(key, remaining);
          return;
        }
        watchCounts.current.delete(key);
        park(key);
        dispatched.current.delete(key);
        setWatched((previous) => {
          const next = new Map(previous);
          next.delete(key);
          return next;
        });
      };
    },
    [park],
  );

  const forTarget = useCallback(
    (target: ChatSelection) => {
      const key = queueKeyOf(target);
      const rows = queues.get(key) ?? NO_QUEUE;
      return {
        queued: rows,
        queueParked: rows.length > 0 && parked.current.has(key),
        queueMessage: (text: string, files?: readonly SentAttachment[]) =>
          queueMessage(text, target, files),
        unqueue: (id: string) => unqueue(id, target),
        sendMessage: (text: string, files?: readonly SentAttachment[]) =>
          sendMessage(text, target, files),
        stopTurn: () => stopTarget(target),
        sendNow: (text: string, files?: readonly SentAttachment[]) => sendNow(text, target, files),
        sendQueuedNow: (id: string) => sendQueuedNow(id, target),
      };
    },
    [queues, parkedAt, queueMessage, unqueue, sendMessage, stopTarget, sendNow, sendQueuedNow],
  );

  return {
    queued,
    queueMessage,
    unqueue,
    queueParked,
    sendMessage,
    stopTurn,
    sendNow,
    sendQueuedNow,
    forTarget,
    watch,
  };
}
