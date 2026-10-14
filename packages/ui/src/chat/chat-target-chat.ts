/**
 * The `Chat` a dock pane sees: the provider's value, re-addressed to one
 * conversation so the pane reads and acts on it without moving the full view's
 * selection (`chat-target-scope.tsx`).
 */
import type { Chat, ChatSelection } from "./chat-state.tsx";
import type { useConversations } from "./chat-conversations.ts";
import type { useSendQueue } from "./chat-queue.ts";
import { targetDestination } from "./chat-target-destination.ts";

export interface TargetChatDeps {
  value: Chat;
  conversations: ReturnType<typeof useConversations>;
  queueForTarget: ReturnType<typeof useSendQueue>["forTarget"];
}

export function chatForTarget(
  { value, conversations, queueForTarget }: TargetChatDeps,
  target: ChatSelection,
  onSelect?: (target: ChatSelection) => void,
): Chat {
  const record = conversations.view(target);
  const { session, destination } = targetDestination(record, target);
  const queue = queueForTarget(target);
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
    remoteBusy: record.remoteBusy,
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
  };
}
