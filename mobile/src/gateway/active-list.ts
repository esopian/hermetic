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

/** One live session's row, narrowed to what the phone reads. */
export interface LiveRow {
  status: LiveStatus;
  /** The row's live (runtime) `id`; `null` when the row carried none. */
  id: string | null;
  /**
   * The row's stored `session_key` now; `null` when the row carried none. A
   * mid-turn compaction rotates it, so after one it is the key the gateway
   * resolves to the running session, where the key the turn was sent into
   * resolves to the idle parent.
   */
  session_key: string | null;
}

/**
 * The row of `session` in an `active_list` answer: `null` when the list does
 * not carry it (the session is not live, as far as this answer can tell), and
 * `undefined` when the answer is not a session list at all.
 *
 * A row matches on its live `id` equal to `runtime` first — upstream's
 * `session_key` is the agent's stored id, which a mid-turn compaction rotates,
 * while the live id stays — and otherwise on `session_key` or `id` equal to
 * `session`. A row with an unknown status counts as not running.
 */
export function liveRowOf(
  answer: unknown,
  session: string,
  runtime: string | null = null,
): LiveRow | null | undefined {
  const sessions = (answer as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) return undefined;
  const rows = sessions.filter(
    (raw): raw is Record<string, unknown> => typeof raw === "object" && raw !== null,
  );
  const row =
    (runtime ? rows.find((r) => r["id"] === runtime) : undefined) ??
    rows.find((r) => r["session_key"] === session || r["id"] === session);
  if (!row) return null;
  const status = row["status"];
  const id = row["id"];
  const key = row["session_key"];
  return {
    status: typeof status === "string" && STATUSES.includes(status) ? (status as LiveStatus) : "idle",
    id: typeof id === "string" && id !== "" ? id : null,
    session_key: typeof key === "string" && key !== "" ? key : null,
  };
}

/** `liveRowOf`'s status alone. */
export function liveStatusOf(
  answer: unknown,
  session: string,
  runtime: string | null = null,
): LiveStatus | null | undefined {
  const row = liveRowOf(answer, session, runtime);
  return row ? row.status : row;
}
