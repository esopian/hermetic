/**
 * One conversation's view of the chat store, for a dock pane or any frame that
 * reads a thread other than the full view's selection (`TargetScopeContext`).
 *
 * The store-wide fields of `Chat` are the provider's own; everything about the
 * conversation — its transcript, turn, queue, draft and observation — is read
 * from `target`'s record, and every action is bound to `target`. Built per
 * call, as it was inline in `ChatProvider`.
 */
import type { useConversations } from "./chat-conversations.ts";
import type { useSendQueue } from "./chat-queue.ts";
import { targetDestination } from "./chat-target-destination.ts";
import type { Chat, ChatSelection } from "./chat-types.ts";

export function chatForTarget(
  value: Chat,
  conversations: ReturnType<typeof useConversations>,
  queueFor: ReturnType<typeof useSendQueue>["forTarget"],
  target: ChatSelection,
  onSelect?: (target: ChatSelection) => void,
): Chat {
  const record = conversations.view(target);
  const { session, destination } = targetDestination(record, target);
  const queue = queueFor(target);
  return {
    ...value,
    selection: target,
    selectionError: null,
    select: (instance, bot, nextSession = null) => {
      const next = { instance, bot, session: nextSession };
      if (onSelect) {
        onSelect(next);
        return true;
      }
      return value.select(instance, bot, nextSession);
    },
    draft: record.draft,
    setDraft: (text) => conversations.stageDraft(target, text),
    sessions: record.sessions,
    session,
    destination,
    messages: record.messages,
    context: record.context,
    historyLoading: record.historyLoading,
    historyError: record.historyError,
    historyRead: record.historyRead,
    reloadHistory: () => conversations.reloadHistory(target),
    reloadTranscript: () => conversations.reloadTranscript(target),
    live: record.live,
    sending: record.sending,
    activity: record.activity,
    turnError: record.turnError,
    released: record.released,
    turnPrompts: record.turnPrompts,
    reconnecting: record.reconnecting,
    reconnectAttempt: record.reconnectAttempt,
    observation: {
      state: record.observe,
      attempt: record.observeAttempt,
      error: record.observeError,
    },
    resumeObservation: () => conversations.resumeObservation(target),
    send: queue.sendMessage,
    abort: queue.stopTurn,
    stopTarget: value.stopTarget,
    settleRequest: (id, outcome, requested) =>
      conversations.settleRequest(id, outcome, requested ?? target),
    releaseRequest: (id, requested) => conversations.releaseRequest(id, requested ?? target),
    openRequest: () => conversations.openRequest(target),
    queued: queue.queued,
    queueMessage: queue.queueMessage,
    unqueue: queue.unqueue,
    sendNow: queue.sendNow,
    sendQueuedNow: queue.sendQueuedNow,
    queueParked: queue.queueParked,
    subagents: conversations.subagents.forTarget(target),
    attachments: conversations.attachments.forTarget(target),
  };
}
