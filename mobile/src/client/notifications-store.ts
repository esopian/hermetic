/**
 * The phone's inbox, its badge counts, and the one decision that matters on a
 * phone: whether an event interrupts, and how — in-app banner, local system
 * notification, or nothing — without ever alerting twice for one event.
 *
 * Two paths deliver the same event. The bridge pushes (Expo) to a device whose
 * socket is not live, and sends a frame to a socket that is; a phone that was
 * backgrounded with its socket still open gets the frame and raises a *local*
 * notification itself. Both carry the contract's `dedupe` key
 * (`notif:<id>`, `turn:<id>:done`, `turn:<id>:error`, `req:<request_id>`), and
 * `claim` lets exactly one of them through.
 *
 * `isWatchingThread` and `chatThreadOf` mirror
 * `packages/ui/src/logic/notification-logic.ts`. Pure TypeScript.
 */
import type { Notification, NotificationCounts, NotificationsListResult } from "../protocol/types.ts";

/* ── rules (desktop mirrors) ────────────────────────────────────────────── */

export interface WatchedThread {
  instance: string;
  bot: string;
  /** The app is in the foreground and this conversation is the visible screen. */
  focused: boolean;
}

/** Which thread a row is about (`ref` = `<instance>/<bot>`), or `null`. */
export function chatThreadOf(n: {
  kind: string;
  ref?: string | null;
}): { instance: string; bot: string } | null {
  if (!n.kind.startsWith("chat.")) return null;
  const ref = n.ref ?? "";
  const cut = ref.indexOf("/");
  if (cut <= 0 || cut === ref.length - 1) return null;
  return { instance: ref.slice(0, cut), bot: ref.slice(cut + 1) };
}

/** A reply in the thread that is open *and* focused does not interrupt; everything else does. */
export function isWatchingThread(
  n: { kind: string; ref?: string | null },
  watched: WatchedThread | null | undefined,
): boolean {
  if (!watched?.focused) return false;
  const thread = chatThreadOf(n);
  if (thread === null) return false;
  return thread.instance === watched.instance && thread.bot === watched.bot;
}

export const isResolved = (n: { resolved_at?: string | null }): boolean => !!n.resolved_at;

/**
 * Whether a row counts as unread: not acknowledged and still holding. This is
 * core's `counts` rule (`read_at IS NULL AND resolved_at IS NULL` over the
 * inbox view, `packages/core/src/local/db/notifications.ts`), which is the
 * number the bridge sends as `unread`. The inbox header, the tab badge and the
 * row markers all read it, so the count and the marked rows always agree.
 */
export const isUnreadRow = (n: { read_at?: string | null; resolved_at?: string | null }): boolean =>
  !n.read_at && !isResolved(n);

/** Unread, unresolved, unmuted `chat.*` rows per `<instance>/<bot>`. */
export function unreadChatByConversation(list: readonly Notification[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of list) {
    if (n.read_at || isResolved(n) || n.muted || n.cleared_at) continue;
    const thread = chatThreadOf(n);
    if (thread === null) continue;
    const key = `${thread.instance}/${thread.bot}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/* ── dedupe keys ────────────────────────────────────────────────────────── */

export const dedupeKey = {
  notification: (id: string) => `notif:${id}`,
  turnDone: (turn_id: string) => `turn:${turn_id}:done`,
  turnError: (turn_id: string) => `turn:${turn_id}:error`,
  request: (request_id: string) => `req:${request_id}`,
} as const;

/** A bounded first-seen set: `claim` is true exactly once per key (until it ages out). */
export class DedupeSet {
  private readonly seen = new Map<string, number>();

  constructor(private readonly limit = 1_000) {}

  claim(key: string, at = 0): boolean {
    if (this.seen.has(key)) return false;
    this.seen.set(key, at);
    while (this.seen.size > this.limit) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  get size(): number {
    return this.seen.size;
  }
}

/* ── the alert decision ─────────────────────────────────────────────────── */

export type AppPhase = "active" | "inactive" | "background";

export type AlertDecision =
  /** Draw an in-app banner (foreground). */
  | "banner"
  /** Schedule a local system notification (backgrounded, socket still live). */
  | "local"
  /** Nothing: already alerted, watching it, muted or resolved. */
  | "none";

export interface AlertInput {
  dedupe: string;
  /** For the watching rule; `null` for alerts not about a chat row. */
  row?: { kind: string; ref?: string | null; muted?: boolean; resolved_at?: string | null } | null;
  /** For a turn/request alert: the conversation it is about. */
  thread?: { instance: string; bot: string } | null;
  phase: AppPhase;
  watched: WatchedThread | null;
}

export function alertFor(input: AlertInput, dedupe: DedupeSet): AlertDecision {
  const row = input.row;
  if (row && (row.muted || isResolved(row))) return "none";
  const focused = input.phase === "active" && !!input.watched?.focused;
  const watching =
    (row && isWatchingThread(row, focused ? input.watched : null)) ||
    (!!input.thread &&
      focused &&
      input.thread.instance === input.watched?.instance &&
      input.thread.bot === input.watched?.bot);
  if (watching) {
    // Seen on screen: claim it so a late push for the same event stays silent.
    dedupe.claim(input.dedupe);
    return "none";
  }
  if (!dedupe.claim(input.dedupe)) return "none";
  return input.phase === "active" ? "banner" : "local";
}

/* ── the store ──────────────────────────────────────────────────────────── */

export interface InboxSource {
  list(input: {
    limit?: number;
    since?: string;
    view?: "inbox" | "snoozed" | "history" | "all";
  }): Promise<NotificationsListResult>;
  ack(input: { ids: string[] } | { all: true }): Promise<{ acked: number }>;
}

export interface InboxState {
  rows: readonly Notification[];
  counts: NotificationCounts;
  loading: boolean;
  error: string | null;
}

export class NotificationsStore {
  private state: InboxState = {
    rows: [],
    counts: { unread: 0, needs_action: 0 },
    loading: false,
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private gen = 0;
  private unreadIndex: Map<string, number> | null = null;
  /**
   * Rows this phone acknowledged whose ack the bridge has not answered yet,
   * each with whether it counted as a need. See `ingest`.
   */
  private readonly inflight = new Map<string, { needs: boolean }>();
  readonly dedupe: DedupeSet;

  constructor(
    private readonly source: InboxSource,
    dedupe?: DedupeSet,
  ) {
    this.dedupe = dedupe ?? new DedupeSet();
  }

  getState(): InboxState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The app icon badge: everything unread (needs-you rows are unread too). */
  badgeCount(): number {
    return Math.max(0, this.state.counts.unread);
  }

  /** The inbox's unread `chat.*` rows for one bot, for `railUnread`. */
  unreadFor = (instance: string, bot: string): number => {
    if (!this.unreadIndex) this.unreadIndex = unreadChatByConversation(this.state.rows);
    return this.unreadIndex.get(`${instance}/${bot}`) ?? 0;
  };

  async refresh(): Promise<boolean> {
    const gen = ++this.gen;
    this.set({ loading: true });
    try {
      const result = await this.source.list({ view: "inbox", limit: 200 });
      if (gen !== this.gen) return false;
      for (const row of result.notifications) this.dedupe.claim(dedupeKey.notification(row.id));
      this.set({
        rows: sortRows(result.notifications),
        counts: { unread: result.unread, needs_action: result.needs_action },
        loading: false,
        error: null,
      });
      return true;
    } catch (error) {
      if (gen !== this.gen) return false;
      this.set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * A `notification` frame: upsert the row and take the bridge's counts.
   * Returns whether this row is new to the phone.
   *
   * The frame's counts were computed when the bridge raised it. A frame that
   * lands while one of our acks is still unanswered was very likely counted
   * before that ack was applied (the ack and its answer share the socket with
   * the frames, in order), so the rows it acknowledged are taken off again;
   * otherwise one stale frame puts back a badge the operator just cleared. Once
   * the ack is answered the frames are taken as sent. If the bridge did apply
   * the ack before counting, the badge reads low by those rows until the next
   * frame or `refresh`, which is the error worth having.
   */
  ingest(row: Notification, counts: NotificationCounts): boolean {
    const at = this.state.rows.findIndex((r) => r.id === row.id);
    const rows =
      at === -1
        ? sortRows([row, ...this.state.rows])
        : this.state.rows.map((r, i) => (i === at ? row : r));
    let { unread, needs_action } = counts;
    for (const [id, acked] of this.inflight) {
      if (id === row.id) continue;
      unread -= 1;
      if (acked.needs) needs_action -= 1;
    }
    this.set({
      rows,
      counts: { unread: Math.max(0, unread), needs_action: Math.max(0, needs_action) },
    });
    return at === -1;
  }

  /** Mark rows read, optimistically; the next `refresh` is authoritative. */
  async ack(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const wanted = new Set(ids);
    // Only rows the bridge counted come off the counts: a resolved row is
    // unacknowledged but was never in `unread`.
    let cleared = 0;
    let needs = 0;
    const counted: string[] = [];
    const rows = this.state.rows.map((r) => {
      if (!wanted.has(r.id) || r.read_at) return r;
      if (isUnreadRow(r)) {
        cleared += 1;
        counted.push(r.id);
        this.inflight.set(r.id, { needs: r.class === "needs_action" });
        if (r.class === "needs_action") needs += 1;
      }
      return { ...r, read_at: now };
    });
    this.set({
      rows,
      counts: {
        unread: Math.max(0, this.state.counts.unread - cleared),
        needs_action: Math.max(0, this.state.counts.needs_action - needs),
      },
    });
    try {
      await this.source.ack({ ids: [...ids] });
    } catch {
      void this.refresh();
    } finally {
      for (const id of counted) this.inflight.delete(id);
    }
  }

  /** Ack every unread `chat.*` row about one conversation (it was opened). */
  async ackThread(instance: string, bot: string): Promise<void> {
    const ids = this.state.rows
      .filter(
        (r) => !r.read_at && chatThreadOf(r)?.instance === instance && chatThreadOf(r)?.bot === bot,
      )
      .map((r) => r.id);
    await this.ack(ids);
  }

  reset(): void {
    this.gen += 1;
    this.inflight.clear();
    this.set({ rows: [], counts: { unread: 0, needs_action: 0 }, loading: false, error: null });
  }

  private set(patch: Partial<InboxState>): void {
    this.state = { ...this.state, ...patch };
    this.unreadIndex = null;
    for (const l of [...this.listeners]) l();
  }
}

function sortRows(rows: readonly Notification[]): Notification[] {
  return [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
