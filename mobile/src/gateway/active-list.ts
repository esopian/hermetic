/**
 * `session.active_list`, read for one session: what a box's gateway says a
 * session is doing right now. Upstream answers
 * `{ sessions: [{ id, session_key, status: waiting|starting|working|idle, message_count, … }] }`
 * (the same answer hermeticd's push watcher reads, `packages/agentd/src/push/watch.ts`).
 *
 * The phone asks it on its return to the foreground, for every turn it
 * detached on the way out: a turn still running on the box must not be shown
 * as over, because the next `prompt.submit` would land on a busy session and
 * upstream's default `display.busy_input_mode = interrupt` would kill it.
 *
 * Pure: no React, no React Native, no Expo.
 */

/** A session's status as `session.active_list` reports it. */
export type LiveStatus = "waiting" | "starting" | "working" | "idle";

const STATUSES: readonly string[] = ["waiting", "starting", "working", "idle"];

/** Whether the session is still busy with a turn (anything but `idle`). */
export const isRunning = (status: LiveStatus | null): status is Exclude<LiveStatus, "idle"> =>
  status !== null && status !== "idle";

/**
 * The status of `session` in an `active_list` answer: `null` when the list
 * does not carry it (the session is not live), and `undefined` when the
 * answer is not a session list at all. A row matches on `session_key` or on
 * its live `id`; a row with an unknown status counts as not running.
 */
export function liveStatusOf(answer: unknown, session: string): LiveStatus | null | undefined {
  const sessions = (answer as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) return undefined;
  for (const raw of sessions) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    if (row["session_key"] !== session && row["id"] !== session) continue;
    const status = row["status"];
    return typeof status === "string" && STATUSES.includes(status) ? (status as LiveStatus) : "idle";
  }
  return null;
}
