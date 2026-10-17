/** A dock pane reads one conversation without moving the full view's selection. */
import { createContext, useCallback, useContext, useEffect } from "react";
import type { ReactNode } from "react";
import { ChatContext } from "./chat-state.tsx";
import { ChatStoreProvider } from "./chat-select.tsx";
import type { Chat, ChatSelection } from "./chat-state.tsx";

export interface TargetScope {
  chat: (target: ChatSelection, onSelect?: (target: ChatSelection) => void) => Chat;
  ensure: (target: ChatSelection) => void;
  showThread: (target: ChatSelection) => () => void;
}

export const TargetScopeContext = createContext<TargetScope | null>(null);

export function ChatTargetScope({
  target,
  onSelect,
  children,
}: {
  target: ChatSelection;
  onSelect?: (target: ChatSelection) => void;
  children: ReactNode;
}) {
  const scope = useContext(TargetScopeContext);
  if (!scope) throw new Error("ChatTargetScope must be used inside <ChatProvider>");
  useEffect(() => scope.ensure(target), [scope.ensure, target.instance, target.bot, target.session]);
  const showScopedThread = useCallback(
    () => scope.showThread(target),
    [scope.showThread, target.instance, target.bot, target.session],
  );
  const chat = { ...scope.chat(target, onSelect), showThread: showScopedThread };
  return (
    <ChatContext.Provider value={chat}>
      <ChatStoreProvider value={chat}>{children}</ChatStoreProvider>
    </ChatContext.Provider>
  );
}
