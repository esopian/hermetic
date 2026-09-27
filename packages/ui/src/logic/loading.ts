/**
 * What the dashboard is allowed to say while it is still finding out.
 *
 * Every screen here reads a remote thing on a tick: the fleet over SSE (a
 * DynamoDB scan the server repeats every minute), the volume inventory over two
 * `DescribeVolumes` plus a `DescribeSnapshots`. Both start empty, and an empty
 * list is ambiguous — "nothing there" and "nothing read yet" render identically
 * unless something tracks the difference. These are the pure functions that
 * decide which of the two a screen is in, kept DOM-free so they can be tested
 * without a browser.
 */

/** The main process's own scan cadence (`POLL_INTERVAL_MS` in `packages/app/src/poller.ts`). */
export const POLL_INTERVAL_MS = 60_000;

/**
 * How far behind the last poll may fall before the footer stops claiming the
 * stream is live. Three ticks: one missed scan is a slow `Scan`, three is a
 * server that has stopped answering while the socket is still open.
 */
export const LAG_MS = POLL_INTERVAL_MS * 3;

/* ── the fleet's first paint ─────────────────────────────────────────────── */

/**
 * Only ever governs the *first* paint. Once a scan has landed the fleet is
 * `ready` for good: a stream that drops later leaves the last known fleet on
 * screen and says so in the footer, rather than replacing a working board with
 * a loading screen.
 */
export type FleetPhase = "connecting" | "scanning" | "reconnecting" | "failed" | "ready";

export interface FleetLoadInput {
  /** The SSE socket is open right now. */
  connected: boolean;
  /** It has been open at least once, so a drop is a reconnect, not a first try. */
  everConnected: boolean;
  /** The server has read the fleet at least once (snapshot `scanned`, or a poll). */
  scanned: boolean;
  /**
   * The last scan the server reported failing, if nothing has succeeded since.
   * The one-shot `agents.list` fallback reports through the same two fields:
   * success sets `scanned`, failure sets this.
   */
  scanError: string | null;
}

export function fleetPhase(input: FleetLoadInput): FleetPhase {
  if (input.scanned) return "ready";
  if (input.scanError !== null) return "failed";
  if (input.connected) return "scanning";
  return input.everConnected ? "reconnecting" : "connecting";
}

/**
 * The two lines the skeleton carries. The detail names the actual call, because
 * "loading…" over a fleet that is slow to answer tells an operator nothing they
 * can act on, and the name of the scan tells them where to look.
 */
export function fleetPhaseNote(
  phase: FleetPhase,
  scanError: string | null = null,
): { title: string; detail: string } {
  switch (phase) {
    case "connecting":
      return { title: "Connecting", detail: "opening the fleet stream · /api/fleet/stream" };
    case "scanning":
      return { title: "Scanning for instances", detail: "DynamoDB scan · EC2 describe · first read" };
    case "reconnecting":
      return { title: "Reconnecting", detail: "the fleet stream dropped before the first scan" };
    case "failed":
      return { title: "Scan failed", detail: scanError ?? "the fleet scan did not come back" };
    case "ready":
      return { title: "Ready", detail: "" };
  }
}

/**
 * How many placeholder rows to draw. Remembering the last count means a resync
 * redraws the shape the operator was already looking at instead of guessing a
 * fleet size and reflowing the moment the real one lands.
 */
export function skeletonCount(remembered: number | null): number {
  if (remembered === null || remembered <= 0) return 4;
  return Math.min(remembered, 8);
}

/* ── the footer's stream health ──────────────────────────────────────────── */

export type StreamHealth = "connecting" | "live" | "lagging" | "reconnecting";

export function streamHealth(input: {
  connected: boolean;
  everConnected: boolean;
  lastPollAt: string | null;
  now: number;
}): StreamHealth {
  if (!input.connected) return input.everConnected ? "reconnecting" : "connecting";
  if (input.lastPollAt === null) return "connecting";
  const age = input.now - Date.parse(input.lastPollAt);
  return Number.isNaN(age) || age > LAG_MS ? "lagging" : "live";
}

/**
 * The footer's two status squares carry a colour and a word ("fleet",
 * "volumes") and nothing else; the detail is in the tooltip. Four states:
 * `ok` — reading on cadence; `warn` — stale, or the connection dropped and is
 * retrying; `bad` — the last read itself failed; `pending` — nothing read yet.
 */
export type Tick = "ok" | "warn" | "bad" | "pending";

export function tickColor(tick: Tick): string {
  switch (tick) {
    case "ok":
      return "var(--ok)";
    case "warn":
      return "var(--warn)";
    case "bad":
      return "var(--bad)";
    case "pending":
      return "var(--fg3)";
  }
}

/**
 * The fleet square. A scan the server reported failing is `bad` whatever the
 * socket is doing; a dropped socket is only `warn`, because the board keeps
 * the last good fleet on screen and the stream retries on its own.
 */
export function fleetTick(health: StreamHealth, scanError: string | null): Tick {
  if (scanError !== null) return "bad";
  switch (health) {
    case "live":
      return "ok";
    case "connecting":
      return "pending";
    case "lagging":
    case "reconnecting":
      return "warn";
  }
}

/**
 * The volumes square. `staleAfterMs` is the caller's, derived from the
 * inventory's own poll interval (`VOLUME_POLL_MS`), so the two cannot drift.
 */
export function volumeTick(input: {
  readAt: string | null;
  error: string | null;
  now: number;
  staleAfterMs: number;
}): Tick {
  if (input.error !== null) return "bad";
  if (input.readAt === null) return "pending";
  const age = input.now - Date.parse(input.readAt);
  return Number.isNaN(age) || age > input.staleAfterMs ? "warn" : "ok";
}

/**
 * How far behind a lagging stream has to be before the footer stops calling it
 * a slow scan and starts calling it a stall. Ten poll intervals: `LAG_MS` (three)
 * is already past the point where "live" would be a lie, but a `Scan` over a
 * large table on a throttled account genuinely takes tens of seconds, and
 * telling an operator something is wrong that early trains them to ignore it.
 */
export const STALLED_MS = POLL_INTERVAL_MS * 10;

export function streamLabel(
  health: StreamHealth,
  retryInMs: number | null,
  /** How long since the last poll landed, when the stream is lagging. */
  lagMs: number | null = null,
): string {
  switch (health) {
    case "live":
      return "live";
    case "lagging": {
      // "no scan in a while" was a shrug: it gave no number to compare against
      // the poll cadence and no hint whether to act. The socket is open in this
      // state, so the honest reading is "the server is slow", right up until it
      // has been slow long enough that it is probably stuck.
      if (lagMs === null || !Number.isFinite(lagMs) || lagMs < 0) return "no scan for a while";
      const s = Math.round(lagMs / 1000);
      return lagMs >= STALLED_MS
        ? `no scan for ${s}s · the poller may be stuck`
        : `no scan for ${s}s · slow scan`;
    }
    case "connecting":
      return "connecting…";
    case "reconnecting":
      return retryInMs === null || retryInMs <= 0
        ? "reconnecting…"
        : `reconnecting in ${Math.ceil(retryInMs / 1000)}s`;
  }
}

/* ── the volume inventory ────────────────────────────────────────────────── */

export interface VolumeScan {
  /** Nothing has been read yet: draw the inventory's shape, not an empty page. */
  skeleton: boolean;
  /** A read is in flight over data already on screen. */
  busy: boolean;
  /** The genuinely-empty case, only reachable after a read that came back. */
  empty: boolean;
  /** What the toolbar's count reads while a read is the only thing happening. */
  note: string;
}

export function volumeScan(input: {
  loading: boolean;
  /** A read has completed at least once this session. */
  hasRead: boolean;
  error: string | null;
  count: number;
}): VolumeScan {
  const skeleton = !input.hasRead && input.error === null;
  return {
    skeleton,
    busy: input.loading && !skeleton,
    empty: input.hasRead && input.count === 0,
    note: skeleton ? "scanning EC2 for volumes…" : input.loading ? "re-reading…" : "",
  };
}

/**
 * The toolbar's `N VOLUMES` lens half before the first read. `—` reads as an answer; this
 * reads as a question still being asked.
 */
export const VOLUME_BADGE_PENDING = "scanning…";
