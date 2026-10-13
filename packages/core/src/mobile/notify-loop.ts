/**
 * The bridge's inbox poll: new notification rows become `notification` frames
 * and pushes.
 *
 * The same read the desktop poller makes (`notifications.list({since})` with a
 * watermark), on its own clock, because the bridge may run with no desktop
 * process at all. The watermark starts at the moment the loop is built, so a
 * bridge that starts does not replay the whole inbox at every phone.
 *
 * Core's `since` is strictly newer, at millisecond resolution, so two rows
 * raised in the same millisecond on either side of a read would lose the
 * second. The loop therefore asks from one millisecond before its watermark
 * and remembers the ids it already sent at the watermark's millisecond.
 *
 * A headless bridge also ticks `chat.swarms` — the roster read is what makes
 * core raise `chat.message` rows (§4.9), and without the desktop poller nobody
 * else would. The desktop host leaves it off.
 */
import type { Notification, NotificationsListResult } from "../schema/index.ts";
import { MOBILE_PROTOCOL } from "./protocol.ts";

export interface NotifyCounts {
  unread: number;
  needs_action: number;
}

export interface NotifyLoopDeps {
  list: (since: string) => Promise<NotificationsListResult>;
  /** Absent: no roster tick. */
  swarms?: (() => Promise<unknown>) | undefined;
  onRow: (row: Notification, counts: NotifyCounts) => void;
  clock?: () => number;
  pollMs?: number;
  swarmsMs?: number;
}

export interface NotifyLoop {
  start(): void;
  stop(): void;
  /** One inbox read now; serialised with the timer's. Never throws. */
  poll(): Promise<void>;
  /** One roster read now. Never throws. */
  tickSwarms(): Promise<void>;
}

export function createNotifyLoop(deps: NotifyLoopDeps): NotifyLoop {
  const clock = deps.clock ?? (() => Date.now());
  const pollMs = deps.pollMs ?? MOBILE_PROTOCOL.NOTIFY_POLL_MS;
  const swarmsMs = deps.swarmsMs ?? MOBILE_PROTOCOL.SWARMS_TICK_MS;
  let watermark = new Date(clock()).toISOString();
  /** Ids already delivered whose `at` is exactly `watermark`. */
  let atWatermark = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let swarmsTimer: ReturnType<typeof setInterval> | null = null;

  async function read(): Promise<void> {
    try {
      const since = new Date(Date.parse(watermark) - 1).toISOString();
      const result = await deps.list(since);
      if (stopped) return;
      const counts = { unread: result.unread, needs_action: result.needs_action };
      // Oldest first, so a burst arrives in the order it was raised.
      for (const row of [...result.notifications].reverse()) {
        if (row.at < watermark) continue;
        if (row.at === watermark) {
          if (atWatermark.has(row.id)) continue;
          atWatermark.add(row.id);
        } else {
          // The watermark only moves forward.
          watermark = row.at;
          atWatermark = new Set([row.id]);
        }
        if (row.muted) continue;
        deps.onRow(row, counts);
      }
    } catch {
      /* an unreadable inbox costs the frame, never the bridge */
    }
  }

  function poll(): Promise<void> {
    const run = chain.then(read);
    chain = run;
    return run;
  }

  async function tickSwarms(): Promise<void> {
    if (deps.swarms === undefined || stopped) return;
    try {
      await deps.swarms();
    } catch {
      /* a roster the tailnet would not answer costs the row, not the loop */
    }
    // The rows the read raised reach the phones now rather than a poll later.
    await poll();
  }

  return {
    start() {
      if (pollTimer !== null || stopped) return;
      pollTimer = setInterval(() => void poll(), pollMs);
      if (deps.swarms !== undefined) swarmsTimer = setInterval(() => void tickSwarms(), swarmsMs);
    },
    stop() {
      stopped = true;
      if (pollTimer !== null) clearInterval(pollTimer);
      if (swarmsTimer !== null) clearInterval(swarmsTimer);
      pollTimer = null;
      swarmsTimer = null;
    },
    poll,
    tickSwarms,
  };
}
