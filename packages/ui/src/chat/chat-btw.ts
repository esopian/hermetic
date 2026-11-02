/**
 * `/btw` side questions (§9.2 A side question): one temporary card per
 * conversation, held for the page session and never written anywhere.
 *
 * A side question is asked at once, beside any running turn and without
 * touching it: no turn, no queue, no `sending`. Its card is not a transcript
 * row, so nothing here touches the conversation record beyond reading it. A
 * dismissed card waits `BTW_UNDO_MS` in an undo strip and is then gone; a new
 * `/btw` replaces the open card, which goes to the strip. An answer always
 * lands on the card it was asked for (by id), wherever that card is by then,
 * and a card that was closed outright ignores its late answer.
 *
 * The provider owns one store (`useBtw`) and hands each conversation its
 * controls (`BtwControls`) on `Chat.btw`. The card is `BtwSpotlight.tsx`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatBranchResult, ChatMessageView } from "../api/index.ts";
import type { Conversation } from "./chat-conversation-record.ts";
import type { QueuedMessage } from "./chat-queue.ts";
import { STEER_PREFIX } from "./chat-recovery.ts";
import type { ChatApi, ChatSelection, ChatTiming } from "./chat-types.ts";

/** What `/btw` with nothing after it shows, sending nothing (upstream's own line). */
export const BTW_USAGE =
  "Usage: /btw <question> — answered from a snapshot of this conversation without interrupting it.";

/** How long a dismissed card can be brought back. */
export const BTW_UNDO_MS = 8_000;

export interface BtwCard {
  /** Local and monotonic: which ask an answer belongs to. A retry takes a new one. */
  id: number;
  /** The question; empty for a bare `/btw`, whose card is the usage line. */
  question: string;
  state: "usage" | "pending" | "done" | "error";
  /** The answer, or the error, once there is one. */
  answer: string;
  /**
   * The stamp of the last finished bot reply when it was asked: upstream trims
   * the snapshot to the last completed assistant message. `null` when none.
   * The footer's only: it is this laptop's reading, not a place to cut.
   */
  until: string | null;
  /**
   * That reply's id, for a branch's cut (`until_message`), idle or mid-turn,
   * when the row is already one the box read back (`isBoxRow`). `null`
   * otherwise, and a branch then cuts nothing.
   */
  untilMessage: string | null;
  /** A turn was running when it was asked, so the answer cannot see it. */
  midTurn: boolean;
  /**
   * The queued row it was asked from, for Back to queue, with the ids queued
   * ahead of and behind it when it left.
   */
  from: { row: QueuedMessage; ahead: string[]; behind: string[] } | null;
  /** The composer's draft when the card opened: Esc there discards it while unchanged. */
  draft: string;
  /** The stored session it was asked in, for the ask and a branch. */
  session: string | null;
}

/** One conversation's side question, as the composer and the card read it. */
export interface BtwControls {
  card: BtwCard | null;
  /** A dismissed card, and the whole seconds left to bring it back. */
  undo: { card: BtwCard; left: number } | null;
  /** This tree has `chat.branch`. */
  canBranch: boolean;
  /** This tree has `chat.btw`: without it `/btw` is an ordinary line. */
  canAsk: boolean;
  /** Open a card for `question` (empty: the usage line). `false` when this tree has no `chat.btw`. */
  ask: (question: string, opts?: { draft?: string; from?: BtwCard["from"] }) => boolean;
  retry: () => void;
  /** Dismiss the open card into the undo strip. */
  discard: () => void;
  /** Undo: the dismissed card back, a pending one still waiting. `draft` is the composer's now. */
  restore: (draft: string) => void;
  /**
   * Close the open card for good, with no undo (it was kept, or sent back to
   * the queue). With `id`, only if the open card is still that one.
   */
  close: (id?: number) => void;
  /** `chat.branch` from the open, answered card. */
  branch: () => Promise<ChatBranchResult>;
}

interface Undo {
  card: BtwCard;
  expires: number;
  stop: () => void;
}

interface Slot {
  card: BtwCard | null;
  undo: Undo | null;
}

/** The store's key: the same three fields the conversation and queue stores key on. */
const keyOf = (target: ChatSelection): string =>
  JSON.stringify([target.instance, target.bot, target.session]);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A prompt the operator started a turn with: not a steer into one, not another bot's delivery. */
const isPrompt = (m: ChatMessageView): boolean =>
  m.role === "user" && !m.from_bot && m.steered !== true && !m.id.startsWith(STEER_PREFIX);

/**
 * The last finished bot reply a side question asked now would see. With a turn
 * running, the snapshot ends before that turn's prompt; a steer is not one, and
 * a part of the reply a steer closed off (`segments`) is not a finished reply.
 */
export function snapshotReply(
  messages: readonly ChatMessageView[],
  working: boolean,
  segments: readonly string[] = [],
): ChatMessageView | null {
  let end = messages.length;
  if (working) {
    const prompt = messages.findLastIndex(isPrompt);
    if (prompt >= 0) end = prompt;
  }
  for (let i = end - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role !== "bot" || m.incomplete || m.error || m.failure || segments.includes(m.id)) continue;
    if (m.blocks.some((b) => b.kind === "text" && b.markdown.trim().length > 0)) return m;
  }
  return null;
}

/**
 * A row read back from the box's history, by the id core's `mapHistory` gives
 * a stored row: `<session>:<row>`. Decided by that form, not by excluding the
 * ids this browser mints: a kept live reply carries the adapter's
 * `<instance>:<clock>` id, which the box's history never has.
 */
export const isBoxRow = (m: ChatMessageView): boolean =>
  m.session !== "" && m.id.startsWith(`${m.session}:`);

/** Where the snapshot ends, read off the record at the moment of asking. */
export function snapshotOf(record: Conversation): Pick<BtwCard, "until" | "untilMessage" | "midTurn"> {
  const midTurn = record.sending || record.remoteBusy === true;
  const reply = snapshotReply(record.messages, midTurn, record.segments);
  return {
    midTurn,
    until: reply?.at ?? null,
    untilMessage: reply !== null && isBoxRow(reply) ? reply.id : null,
  };
}

/** The answer quoted into a draft: `> **btw:** <q>`, the answer quoted, a blank line, the draft. */
export function quoteBtw(card: BtwCard, draft: string): string {
  const answer = card.answer
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  const quote = `> **btw:** ${card.question}\n>\n${answer}`;
  return draft.trim() ? `${quote}\n\n${draft}` : `${quote}\n\n`;
}

export function useBtw({
  api,
  view,
  timing,
}: {
  /** The provider's injected calls, read at call time. */
  api: { readonly current: ChatApi };
  view: (target: ChatSelection) => Conversation;
  timing: Pick<ChatTiming, "now" | "setInterval">;
}) {
  const slots = useRef(new Map<string, Slot>());
  const seq = useRef(0);
  const alive = useRef(true);
  const clock = useRef(timing);
  clock.current = timing;
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => {
    if (alive.current) setVersion((n) => n + 1);
  }, []);
  useEffect(() => {
    alive.current = true;
    const all = slots.current;
    return () => {
      alive.current = false;
      for (const slot of all.values()) slot.undo?.stop();
    };
  }, []);

  const slotOf = (key: string): Slot => {
    let slot = slots.current.get(key);
    if (!slot) {
      slot = { card: null, undo: null };
      slots.current.set(key, slot);
    }
    return slot;
  };

  /** Into the undo strip, replacing whatever was there; it ticks each second until it expires. */
  const toUndo = (slot: Slot, card: BtwCard) => {
    slot.undo?.stop();
    const undo: Undo = { card, expires: clock.current.now() + BTW_UNDO_MS, stop: () => {} };
    undo.stop = clock.current.setInterval(() => {
      if (clock.current.now() >= undo.expires) {
        undo.stop();
        if (slot.undo === undo) slot.undo = null;
      }
      bump();
    }, 1_000);
    slot.undo = undo;
  };

  /** An answer onto the card it was asked for, open or in the strip; a closed card ignores it. */
  const land = (key: string, id: number, state: BtwCard["state"], answer: string) => {
    const slot = slots.current.get(key);
    if (!slot) return;
    if (slot.card?.id === id) slot.card = { ...slot.card, state, answer };
    else if (slot.undo?.card.id === id) slot.undo.card = { ...slot.undo.card, state, answer };
    else return;
    bump();
  };

  const run = (target: ChatSelection, card: BtwCard) => {
    const key = keyOf(target);
    // Through `then`, so an ask that throws rather than rejects (no transport,
    // no fleet target) lands as an error too.
    void Promise.resolve()
      .then(() => api.current.askBtw!(target.instance, target.bot, card.question, card.session))
      .then(
        (result) => land(key, card.id, result.error ? "error" : "done", result.answer || "(no answer)"),
        (error: unknown) => land(key, card.id, "error", messageOf(error)),
      );
  };

  const ask = (
    target: ChatSelection,
    question: string,
    opts: Parameters<BtwControls["ask"]>[1] = {},
  ) => {
    if (!api.current.askBtw) return false;
    const record = view(target);
    const slot = slotOf(keyOf(target));
    const card: BtwCard = {
      id: ++seq.current,
      question,
      state: question ? "pending" : "usage",
      answer: question ? "" : BTW_USAGE,
      ...snapshotOf(record),
      from: opts.from ?? null,
      draft: opts.draft ?? "",
      session: record.resolvedSession ?? record.target.session ?? null,
    };
    if (slot.card) toUndo(slot, slot.card);
    slot.card = card;
    bump();
    if (question) run(target, card);
    return true;
  };

  const forTarget = useCallback(
    (target: ChatSelection): BtwControls => {
      const key = keyOf(target);
      const slot = slots.current.get(key);
      const undo = slot?.undo ?? null;
      return {
        card: slot?.card ?? null,
        undo: undo
          ? {
              card: undo.card,
              left: Math.max(0, Math.ceil((undo.expires - clock.current.now()) / 1_000)),
            }
          : null,
        canAsk: api.current.askBtw !== undefined,
        canBranch: api.current.branchChat !== undefined,
        ask: (question, opts) => ask(target, question, opts),
        retry: () => {
          const s = slots.current.get(key);
          if (!s?.card?.question || !api.current.askBtw) return;
          // A retry is a new ask: its snapshot ends where the chat is now.
          s.card = {
            ...s.card,
            ...snapshotOf(view(target)),
            id: ++seq.current,
            state: "pending",
            answer: "",
          };
          bump();
          run(target, s.card);
        },
        discard: () => {
          const s = slots.current.get(key);
          if (!s?.card) return;
          toUndo(s, s.card);
          s.card = null;
          bump();
        },
        restore: (draft) => {
          const s = slots.current.get(key);
          if (!s?.undo) return;
          const back = s.undo.card;
          s.undo.stop();
          s.undo = null;
          if (s.card) toUndo(s, s.card);
          s.card = { ...back, draft };
          bump();
        },
        close: (id) => {
          const s = slots.current.get(key);
          if (!s?.card || (id !== undefined && s.card.id !== id)) return;
          s.card = null;
          bump();
        },
        branch: async () => {
          const card = slots.current.get(key)?.card;
          const branch = api.current.branchChat;
          if (!branch) throw new Error("This window cannot branch a conversation.");
          if (card?.state !== "done") throw new Error("There is no answer to branch from.");
          return await branch(target.instance, target.bot, {
            session: card.session,
            ...(card.untilMessage ? { until_message: card.untilMessage } : {}),
            question: card.question,
            answer: card.answer,
          });
        },
      };
    },
    // `version` is what makes a fresh set of controls after the slots changed.
    [version],
  );

  return { forTarget };
}
