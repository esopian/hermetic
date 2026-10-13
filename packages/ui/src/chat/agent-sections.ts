/**
 * The thread header's `Desktop` and `Terminal` links (§9.2).
 *
 * Chat cannot reach the agent drawer by itself: the drawer is the app shell's,
 * opened through `nav/`, and nothing under `chat/` imports the navigation
 * state. The surface that mounts a thread provides the opener instead — `App`
 * for the full Chat view (the drawer rises over the conversation, which stays
 * mounted underneath with its draft and turn), and the agent drawer for its own
 * Chat section (the link just moves the drawer to that section). A thread with
 * no provider, such as the floating dock, draws no links.
 */
import { createContext, useContext } from "react";

export type AgentSection = "desktop" | "terminal";

export type OpenAgentSection = (instance: string, section: AgentSection) => void;

export const AgentSectionContext = createContext<OpenAgentSection | null>(null);

export function useOpenAgentSection(): OpenAgentSection | null {
  return useContext(AgentSectionContext);
}
