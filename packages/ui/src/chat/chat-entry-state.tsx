/** Frame state is separate from the conversation store: moving a frame never moves a turn. */
import { createContext, useContext } from "react";
import type { ChatSelection } from "./chat-state.tsx";

export interface ChatEntry {
  navigation: number;
  drawerTarget: ChatSelection | null;
  closeDrawer: () => void;
  open: (
    target: ChatSelection,
    frame: "dock" | "full" | "drawer",
    draft?: string,
    message?: string | null,
  ) => boolean;
  quickJump: () => void;
}
export const ChatEntryContext = createContext<ChatEntry | null>(null);
export function useChatEntry(): ChatEntry | null {
  return useContext(ChatEntryContext);
}
