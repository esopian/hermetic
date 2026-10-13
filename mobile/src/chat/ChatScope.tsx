/**
 * What a block in the transcript can reach: the conversation it is in, and
 * the actions it may take there (answer a request, open a subagent, put text
 * in the composer, recover a failed turn). The conversation screen provides
 * it; a block rendered without one (a test, a preview) draws read-only, the
 * way the desktop draws a card with no responder — "Respond in Hermes".
 */
import { createContext, useContext } from "react";
import type { RespondInput } from "../client/conversation-store.ts";
import type { RespondResult } from "../protocol/types.ts";

export interface ChatScopeValue {
  fleetId: string;
  instance: string;
  bot: string;
  /** The transcript's clock (ticks every 30 s), so every block agrees about "now". */
  now: number;
  /** A turn is running in this conversation. */
  sending: boolean;
  /** Requests answered from this phone. */
  released: readonly string[];
  /** Answer an approval or a clarify (`chat.respond`); `session` is the message's own. */
  respond?: (input: RespondInput, session: string | null) => Promise<RespondResult>;
  openSubagent?: (subagentId: string) => void;
  /** Put text in the composer (a late answer, "Edit message"). */
  draft?: (text: string) => void;
  /** Send a prompt again (a failed turn's Retry). */
  retry?: (prompt: string) => boolean;
  compact?: () => Promise<void>;
  /** Open a new session and send `prompt` into it. */
  newSession?: (prompt: string) => Promise<void>;
  /** Every message in the conversation, for a failure card to find its prompt. */
  messages?: readonly import("../protocol/types.ts").ChatMessage[];
}

export const ChatScope = createContext<ChatScopeValue | null>(null);

export function useChatScope(): ChatScopeValue | null {
  return useContext(ChatScope);
}
