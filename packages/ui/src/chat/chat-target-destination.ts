/** A pane may select an explicit session while another pane keeps its own. */
import type { SessionView } from "../api/index.ts";
import type { Conversation } from "./chat-conversation-record.ts";
import type { Destination } from "./chat-logic.ts";
import type { ChatSelection } from "./chat-state.tsx";

export function targetDestination(
  record: Conversation,
  target: ChatSelection,
): { session: SessionView | null; destination: Destination } {
  const activeSessionId = target.session ?? record.resolvedSession;
  const session = activeSessionId
    ? (record.sessions.find((item) => item.id === activeSessionId) ?? null)
    : null;
  let destination: Destination;
  if (record.sessionsState === "failed")
    destination = {
      state: "unknown",
      reason: record.sessionsError ?? "The session list could not be read.",
    };
  else if (record.sessionsState === "pending" || !record.historyRead)
    destination = { state: "pending" };
  else if (record.sessions.length === 0 && !activeSessionId)
    destination = { state: "known", origin: "portal", detail: null };
  else if (!activeSessionId) destination = { state: "unchosen", count: record.sessions.length };
  else if (!session)
    destination = { state: "unknown", reason: "The box named a session it then did not list." };
  else destination = { state: "known", origin: session.origin, detail: session.origin_detail ?? null };
  return { session, destination };
}
