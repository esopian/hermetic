/**
 * hermeticd speaks the same `OpEvent` stream core's long operations do (§3.2
 * rule 2), so a stage's progress renders exactly like a local operation's. The
 * bootstrap runner turns `::progress` lines into these (§4.2), and the RPC
 * listener serialises them as NDJSON (§6.4).
 */
import type { OpEvent } from "@hermetic/core/schema";

export type Emit = (event: OpEvent) => void;

export function opEvent(
  phase: string,
  progress: number,
  message: string,
  at: Date,
  level?: OpEvent["level"],
): OpEvent {
  return {
    phase,
    progress: Math.min(1, Math.max(0, progress)),
    message,
    ...(level ? { level } : {}),
    at: at.toISOString(),
  };
}

/** Collect a stream into an array — how `apply --dry-run` and tests consume it. */
export function collector(): { emit: Emit; events: OpEvent[] } {
  const events: OpEvent[] = [];
  return { emit: (e) => void events.push(e), events };
}
