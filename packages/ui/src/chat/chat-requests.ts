/**
 * Server requests in the transcript — an approval or a clarify the box parks a
 * turn on — and what closed them.
 *
 * Three things say a request is no longer waiting on the operator, and every
 * reader here takes all three into account: a finished `notice` carrying its id
 * (the box withdrew it, it timed out, or the composer skipped it), the
 * conversation's `released` set (answered from its own card, which the gateway
 * never closes in the stream), and `expires_at` passing. `Message.tsx` derives
 * "waiting" and the open-approval count from `openRequests`; the store keeps
 * its no-frame timer and the composer's skip in step through the record
 * helpers below (`chat-conversations.ts` owns the hooks around them).
 */
import type { ChatActivityView, ChatBlockView, ChatFrameView, ChatMessageView } from "../api/index.ts";
import type { Assemble, Conversation } from "./chat-conversation-record.ts";

/** How a request's card ended, as far as the transcript says. */
export type ClosedKind = "skipped" | "answered" | "timeout" | "cancelled";
export interface ClosedRequest {
  kind: ClosedKind;
  title: string;
}

/** The title the composer's own skip lands as (`settleIn`), and how it is told from a box close. */
export const SKIPPED_TITLE = "Question skipped";

/**
 * A closing notice, read by its `reason` (`RequestCloseReason`, core) rather
 * than its words. A notice with no reason is a local settle — the composer's
 * skip by its title — or one minted before the field existed, which reads as
 * answered, as every close did then.
 */
function closedKind(block: ChatActivityView): ClosedKind {
  switch (block.reason) {
    case "timeout":
      return "timeout";
    case "resolved":
      return "answered";
    case "interrupted":
    case "shutdown":
    case "session_closed":
    case "other":
      return "cancelled";
    default:
      return block.title === SKIPPED_TITLE ? "skipped" : "answered";
  }
}

/**
 * The request ids a message has already closed, with how: the box says a
 * request is over with a finished `notice` carrying its id, and a card for it
 * must not be answered. Whether it still draws is `keepsCard`.
 */
export function closedRequests(blocks: readonly ChatBlockView[]): Map<string, ClosedRequest> {
  const closed = new Map<string, ClosedRequest>();
  for (const block of blocks)
    if (
      block.kind === "activity" &&
      block.category === "notice" &&
      block.state === "done" &&
      block.request_id
    )
      closed.set(block.request_id, { kind: closedKind(block), title: block.title });
  return closed;
}

/**
 * Whether a closed request's card stays on screen as its settled summary. A
 * question the operator lost the chance to answer (skipped, timed out,
 * cancelled) keeps what it asked; an approval that timed out or was cancelled
 * keeps the command it never ran. One answered — here or elsewhere — goes.
 */
export function keepsCard(block: ChatBlockView, closed: ClosedRequest | undefined): boolean {
  if (!closed) return true;
  if (block.kind === "question") return closed.kind !== "answered";
  if (block.kind === "approval") return closed.kind === "timeout" || closed.kind === "cancelled";
  return true;
}

type RequestBlock = Extract<ChatBlockView, { kind: "approval" | "question" }>;

/**
 * The requests in `blocks` still waiting on the operator: carrying an id, not
 * closed by a notice, not answered from their card (`released`), not expired
 * at `now`. "waiting", the open-approval count and the expiry timer all read
 * this one list.
 */
export function openRequests(
  blocks: readonly ChatBlockView[],
  closed: ReadonlyMap<string, ClosedRequest>,
  released: ReadonlySet<string> | null | undefined,
  now: number,
): RequestBlock[] {
  return blocks.filter(
    (block): block is RequestBlock =>
      (block.kind === "approval" || block.kind === "question") &&
      !!block.request_id &&
      !closed.has(block.request_id) &&
      !released?.has(block.request_id) &&
      !(block.expires_at && Date.parse(block.expires_at) <= now),
  );
}

/** The earliest `expires_at` among `open` still ahead of `now`, in epoch ms, or `null`. */
export function nextExpiry(open: readonly RequestBlock[], now: number): number | null {
  let next: number | null = null;
  for (const block of open) {
    const at = block.expires_at ? Date.parse(block.expires_at) : Number.NaN;
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

/** When the request `request_id` expires, in epoch ms, or `null` when it does not say. */
export function expiryOf(messages: readonly ChatMessageView[], request_id: string): number | null {
  for (const message of messages)
    for (const block of message.blocks)
      if ((block.kind === "question" || block.kind === "approval") && block.request_id === request_id)
        return block.expires_at ? Date.parse(block.expires_at) : null;
  return null;
}

/**
 * The newest clarify in `scope` still waiting on the operator, by request id,
 * or `null`. The composer's steer declines it before sending (`Composer.tsx`),
 * because a steer queues behind the blocked tool and would otherwise never land.
 *
 * `scope` is one message or the parts of one reply in order — the live message
 * and the parts a steer closed off (`openRequestIn`). A close lands where it is
 * assembled, which for a box-sent notice is the live part even when the card
 * sits in an earlier one, so the closed set is read across the whole scope.
 */
export function openQuestion(
  scope: ChatMessageView | readonly ChatMessageView[] | null | undefined,
  now = Date.now(),
): string | null {
  const parts: readonly ChatMessageView[] = !scope ? [] : "blocks" in scope ? [scope] : scope;
  const closed = new Set(parts.flatMap((message) => [...closedRequests(message.blocks).keys()]));
  for (let p = parts.length - 1; p >= 0; p -= 1) {
    const blocks = parts[p]!.blocks;
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i]!;
      if (block.kind !== "question" || !block.request_id || closed.has(block.request_id)) continue;
      if (block.expires_at && Date.parse(block.expires_at) < now) continue;
      return block.request_id;
    }
  }
  return null;
}

/* ── the record's side: the store's hooks call these ─────────────────────── */

/**
 * Keep `record.openRequests` in step with one frame: an approval or a clarify
 * the box can be answered on opens its request, and a finished `notice`
 * carrying that id (the close `closedRequests` reads) ends it. Until every
 * open request ends the turn is silent by design, so the no-frame timer must
 * not read the silence as a dead pipe. `true` when the set changed. A request
 * the operator already answered from its card (`released`) stays closed even
 * if the box sends its block again.
 */
export function trackRequest(record: Conversation, frame: ChatFrameView): boolean {
  if (frame.type !== "block") return false;
  const block = frame.block;
  if (block.kind === "approval" || block.kind === "question") {
    const id = block.request_id;
    if (!id || record.openRequests.has(id) || record.released.has(id)) return false;
    record.openRequests.add(id);
    return true;
  }
  if (block.kind === "activity" && block.category === "notice" && block.state === "done")
    return !!block.request_id && record.openRequests.delete(block.request_id);
  return false;
}

/** The blocks a part of the reply that a steer closed off can still receive. */
const LANDS = new Set(["tool", "approval", "question"]);

/**
 * A `block` frame that updates a block in a part of the reply a steer closed
 * off — a tool that was running when the operator's words went in, finishing
 * after them — lands on that part rather than starting a copy below.
 *
 * Whether it does is read off `assemble` itself: a block it *replaced* leaves
 * the part's block count where it was, and one it would only have appended is
 * new work, which belongs to the live message.
 */
export function landOnSegment(
  record: Conversation,
  frame: ChatFrameView,
  seed: { session: string; at: string },
  assemble: Assemble,
): boolean {
  if (frame.type !== "block" || record.segments.length === 0) return false;
  // Only blocks with an identity of their own. A status snapshot also replaces
  // by key, but it describes the turn as it is now, which is the live part.
  if (!LANDS.has(frame.block.kind)) return false;
  for (const id of [...record.segments].reverse()) {
    const index = record.messages.findIndex((m) => m.id === id);
    const part = index === -1 ? null : record.messages[index]!;
    if (!part) continue;
    const merged = assemble(part, frame, seed);
    if (!merged || merged.blocks.length !== part.blocks.length) continue;
    const next = [...record.messages];
    next[index] = merged;
    record.messages = next;
    return true;
  }
  return false;
}

/**
 * Count `request_id` as answered from its card: no longer one the turn is
 * parked on, and no longer "waiting" on screen. A fresh set, so a reader
 * memoised on the record's fields sees the change. `true` when the turn was
 * still parked on it, and its no-frame timer may run again.
 */
export function releaseIn(record: Conversation, request_id: string): boolean {
  if (!record.released.has(request_id))
    record.released = new Set([...record.released, request_id].slice(-RELEASED_MAX));
  return record.openRequests.delete(request_id);
}

/**
 * How many answered requests and failed-turn prompts a conversation keeps.
 * Both only ever matter for the turns still on screen, so the oldest go first;
 * the bounds are far past any one turn's requests or a session's failures.
 */
const RELEASED_MAX = 256;
const TURN_PROMPTS_MAX = 32;

/** Remember the prompt that started a turn this browser saw fail, by the failed message's id. */
export function rememberTurnPrompt(record: Conversation, id: string, prompt: string): void {
  const next = new Map(record.turnPrompts);
  next.delete(id);
  next.set(id, prompt);
  for (const key of next.keys()) {
    if (next.size <= TURN_PROMPTS_MAX) break;
    next.delete(key);
  }
  record.turnPrompts = next;
}

/**
 * Fold the close of `request_id` into whichever part of the reply holds its
 * card — the live message, or a part a steer closed off — as the same finished
 * `notice` a gateway `request.cancel` lands as. The frame that did it, or
 * `null` when no part holds the card.
 */
export function settleIn(
  record: Conversation,
  request_id: string,
  outcome: "skipped" | "answered",
  assemble: Assemble,
): ChatFrameView | null {
  const holds = (message: ChatMessageView | null) =>
    !!message?.blocks.some(
      (block) =>
        (block.kind === "question" || block.kind === "approval") && block.request_id === request_id,
    );
  const frame = (message: ChatMessageView): ChatFrameView => ({
    type: "block",
    seq: 0,
    message: message.id,
    block: {
      kind: "activity",
      category: "notice",
      key: `request:${request_id}`,
      title: outcome === "skipped" ? SKIPPED_TITLE : "Answered",
      state: "done",
      request_id,
      role: "work",
    },
  });
  const seedOf = (message: ChatMessageView) => ({ session: message.session, at: message.at });
  if (record.live && holds(record.live)) {
    const settled = frame(record.live);
    record.live = assemble(record.live, settled, seedOf(record.live));
    return settled;
  }
  const index = record.messages.findIndex((m) => record.segments.includes(m.id) && holds(m));
  const part = index === -1 ? null : record.messages[index]!;
  if (!part) return null;
  const settled = frame(part);
  const merged = assemble(part, settled, seedOf(part));
  if (!merged) return null;
  const next = [...record.messages];
  next[index] = merged;
  record.messages = next;
  return settled;
}

/**
 * The clarify `record` is waiting on, if any — across the live message and the
 * parts a steer closed off, the scope `settleIn` closes in. A question
 * answered from its card (`releaseIn`) is not waiting on anyone.
 */
export function openRequestIn(record: Conversation): string | null {
  const done = record.released;
  const scope = (message: ChatMessageView): ChatMessageView =>
    done.size
      ? {
          ...message,
          blocks: message.blocks.filter(
            (block) => !(block.kind === "question" && block.request_id && done.has(block.request_id)),
          ),
        }
      : message;
  const parts = record.messages.filter((m) => record.segments.includes(m.id));
  return openQuestion((record.live ? [...parts, record.live] : parts).map(scope));
}
