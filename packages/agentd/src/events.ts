/**
 * hermeticd speaks the same `OpEvent` stream core's long operations do (§3.2
 * rule 2), so a stage's progress renders exactly like a local operation's. The
 * bootstrap runner turns `::progress` lines into these (§4.2), and the RPC
 * listener serialises them as NDJSON (§6.4).
 */
import type { OpEvent } from "@hermetic/core/schema";
import { redactValue } from "./redact.ts";

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

/**
 * The phase of a Hermes swap's milestones (hold, backup, gate, seal, rollback):
 * the converge loop also writes these to the event log, so `agent history`
 * carries the timeline and the backup path, not just the outcome.
 */
export const HERMES_UPGRADE_PHASE = "hermes-upgrade";

/**
 * `emit`, plus every `HERMES_UPGRADE_PHASE` event recorded as an `upgrade`
 * history event, redacted, in emit order, never failing the apply.
 */
export function withUpgradeHistory(
  emit: Emit,
  record: (action: string, detail: string) => Promise<void>,
): Emit & { readonly flush: () => Promise<void> } {
  let queue = Promise.resolve();
  const wrapped = (event: OpEvent): void => {
    emit(event);
    if (event.phase !== HERMES_UPGRADE_PHASE) return;
    const detail = redactValue(event.message);
    queue = queue.then(() => record("upgrade", detail)).catch(() => undefined);
  };
  // A process about to exit (a stage's `hermeticd apply`) waits for what it queued.
  return Object.assign(wrapped, { flush: () => queue });
}
