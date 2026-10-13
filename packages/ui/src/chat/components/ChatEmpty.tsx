/**
 * What the Chat view shows when there is nobody to talk to.
 *
 * Chat is the page the app opens on, so a fleet with nothing to chat with is
 * the first thing a new operator sees. Two causes, each with its own fix, and
 * both fixes are on the Fleet page: a fleet with no agents (create one), and a
 * fleet whose agents are all unwatched (turn on listening for one — chat only
 * reads the rosters of listened instances, §9.2). The panel says which, and
 * offers the way there.
 *
 * Nothing here claims an empty fleet before the fleet has been read, and
 * nothing claims "none listening" before the listening set has been read: a
 * cold start draws the Chat view's own loading states instead of flashing a
 * panel that the next read takes back.
 */
import type { AgentView } from "../../api/index.ts";
import type { Listening } from "../../state/listening-state.tsx";

export type ChatEmptyKind = "no-agents" | "none-listening";

/**
 * Which empty state, if any, the Chat view owes.
 *
 * `agents` is the fleet without its destroyed rows. "None listening" is the
 * listening preference being off for every one of them; a listened agent that
 * is stopped or unreachable is not this state, since Chat has its own
 * explanation for a box that does not answer.
 */
export function chatEmptyKind({
  fleetRead,
  agents,
  listening,
}: {
  /** The fleet has been scanned at least once (`fleetPhase` is `ready`). */
  fleetRead: boolean;
  agents: readonly AgentView[];
  /** `null` where this tree has no listening provider: then nothing is known. */
  listening: Listening | null;
}): ChatEmptyKind | null {
  if (!fleetRead) return null;
  if (agents.length === 0) return "no-agents";
  if (listening === null || listening.loading) return null;
  // A failed read with nothing confirmed is an unknown set, not an empty one;
  // the fleet's listening notice reports the failure.
  if (listening.error !== null && listening.instances.length === 0) return null;
  return agents.some((agent) => listening.instances.includes(agent.name)) ? null : "none-listening";
}

const COPY: Record<ChatEmptyKind, string> = {
  "no-agents": "Chat talks to the agents in this fleet, and there are none yet. Create one in Fleet.",
  "none-listening": "No agent is listening for chat. Turn on listening for an agent in Fleet.",
};

export function ChatEmpty({ kind, onGoToFleet }: { kind: ChatEmptyKind; onGoToFleet: () => void }) {
  return (
    <section className="empty chat-empty" aria-label="Chat" data-empty={kind}>
      <p>{COPY[kind]}</p>
      <button type="button" className="btn btn-primary empty-first-agent" onClick={onGoToFleet}>
        Go to Fleet →
      </button>
    </section>
  );
}
