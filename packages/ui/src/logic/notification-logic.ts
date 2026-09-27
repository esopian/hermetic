import { chatRefHash } from "../chat/chat-routing.ts";
/**
 * The notification rules, pure and DOM-free (§4.9).
 *
 * Everything the portal decides *about* a notification lives here rather than
 * in the components that draw it: which badge colour outranks which, which
 * preference group a row belongs to, whether a row is allowed to interrupt, and
 * how long the toast that does it stays. Those are the four rules the
 * notification design states in prose ("gold outranks orange", "events toast,
 * conditions do not", "approvals ignore quiet hours", "preferences are
 * local"), and prose is not testable — this is.
 *
 * Nothing here imports `api.ts`: a notification is described structurally, by
 * the three fields a rule reads. That keeps the rules testable without a
 * client, and keeps them compiling against `kind` values (`chat.approval`,
 * `chat.cron`) that core will only start emitting in a later phase.
 */
import { settingsHash } from "../nav/settings-nav.ts";

/* ── the record, as the rules see it ─────────────────────────────────────── */

/** `NotificationClass` in `core/src/schema/notification.ts`, structurally. */
export type NotificationClassName = "ok" | "info" | "warn" | "bad" | "needs_action";

/**
 * The fields a rule reads. Deliberately wider than today's `NotificationKind`
 * and `NotificationSource` enums: the chat kinds are already named by the
 * notification design and by §7's phases, and a rule that cannot be written
 * until the enum grows is a rule that gets written somewhere worse.
 */
export interface NotificationLike {
  kind: string;
  source: string;
  class: NotificationClassName;
  muted?: boolean | null;
  /**
   * What the row is about. For a `chat.*` row this is `<instance>/<bot>`
   * (`chatActionRef` in core's `schema/notification.ts`), which is what the
   * watching rule below takes apart. Optional for the same reason `muted` is:
   * a rule must be callable with a literal that predates the field.
   */
  ref?: string | null;
  /**
   * When the condition this row reports stopped holding, or `null`/absent for a
   * row that is still live. Optional so a rule can be called with a literal
   * that predates the field, but every rule below reads it.
   */
  resolved_at?: string | null;
}

/** `NotificationActionTarget`, structurally, for `actionHash`. */
export interface NotificationActionLike {
  target: string;
  ref?: string | null;
}

/* ── badges (the gold-outranks-orange rule) ──────────────────────────────── */

/**
 * Two colours, never mixed: orange is unread, gold is blocked on you. Gold
 * outranks orange at every level, so a quiet bell genuinely means nothing is
 * waiting — which is the only thing that makes a quiet bell worth looking at.
 */
export type BadgeTone = "quiet" | "unread" | "needs_action";

export function badgeTone(unread: number, needsAction: number): BadgeTone {
  if (needsAction > 0) return "needs_action";
  if (unread > 0) return "unread";
  return "quiet";
}

/* ── delivery preferences (§4.9: local, never in `_fleet.settings`) ── */

export type Delivery = "off" | "inbox" | "toast";

export const DELIVERIES: readonly Delivery[] = ["off", "inbox", "toast"];

/**
 * The six rules the settings section edits. Grouped by what an operator would
 * silence as one thing, not by `source` — "approvals" and "messages" share a
 * source and are wanted at completely different volumes.
 */
export type PrefGroup = "approvals" | "messages" | "operations" | "health" | "scheduled" | "advisories";

export interface PrefGroupSpec {
  id: PrefGroup;
  label: string;
  what: string;
}

/** In the order the notification settings panel lists them. */
export const PREF_GROUPS: readonly PrefGroupSpec[] = [
  {
    id: "approvals",
    label: "Approvals and questions",
    what: "An agent has stopped and is waiting on you.",
  },
  {
    id: "messages",
    label: "Agent messages",
    what: "A reply in a thread you are not looking at.",
  },
  {
    id: "operations",
    label: "Operations",
    what: "Create, recreate, destroy, foundation update — done or failed.",
  },
  {
    id: "health",
    label: "Health changes",
    what: "An agent went degraded, unreachable or recovered.",
  },
  { id: "scheduled", label: "Scheduled runs", what: "Output from a gateway cron job." },
  {
    id: "advisories",
    label: "Fleet advisories",
    what: "Foundation update available, loose volumes, stale grants.",
  },
];

/**
 * Which rule a row obeys. `operations` is the fallback rather than a seventh
 * "other" group: a kind nobody has taught this build about is still something
 * that happened to the fleet, and dropping it on the floor is worse than
 * putting it in the busiest bucket.
 */
export function groupOf(n: { kind: string }): PrefGroup {
  if (n.kind.startsWith("operation.")) return "operations";
  if (n.kind === "agent.health") return "health";
  if (n.kind === "fleet.advisory") return "advisories";
  if (n.kind === "chat.approval" || n.kind === "chat.question") return "approvals";
  if (n.kind === "chat.message") return "messages";
  if (n.kind === "chat.cron") return "scheduled";
  return "operations";
}

/** `HH:MM`, 24-hour, as the two `<input type="time">` controls produce them. */
export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

export interface NotificationPrefs {
  delivery: Record<PrefGroup, Delivery>;
  /** A desktop notification only ever accompanies a toast; see `desktopAllowed`. */
  desktop: Record<PrefGroup, boolean>;
  quiet: QuietHours;
}

/**
 * Advisories are *conditions* (the events-toast rule, §4.9), so they land in
 * the inbox and never toast by default: a toast that leaves takes the
 * condition off screen with it. Everything else here is an event.
 */
export function defaultPrefs(): NotificationPrefs {
  return {
    delivery: {
      approvals: "toast",
      messages: "toast",
      operations: "toast",
      health: "toast",
      scheduled: "inbox",
      advisories: "inbox",
    },
    desktop: {
      approvals: true,
      messages: false,
      operations: true,
      health: false,
      scheduled: false,
      advisories: false,
    },
    quiet: { enabled: false, start: "22:00", end: "08:00" },
  };
}

/**
 * A desktop notification is an escalation of a toast, not an alternative to
 * one: a group that does not interrupt in the page has no business interrupting
 * the whole machine. The checkbox is disabled rather than hidden so the reason
 * is visible.
 */
export function desktopAllowed(delivery: Delivery): boolean {
  return delivery === "toast";
}

/* ── quiet hours (the approvals-ignore-quiet-hours rule) ─────────────────── */

/** Minutes past midnight, or `null` for anything that is not `HH:MM`. */
function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Whether `now` falls inside the window. The interval is half-open — start
 * inclusive, end exclusive — and wraps midnight, because the window an operator
 * actually wants (22:00 → 08:00) is the wrapping one and a naive `start <= m <
 * end` is silent exactly when it is needed.
 *
 * A window whose ends are equal is treated as *off* rather than as all day: two
 * identical times is what a half-filled form looks like, not a request to be
 * silenced for 24 hours.
 */
export function inQuietHours(now: Date, q: QuietHours): boolean {
  if (!q.enabled) return false;
  const start = minutesOf(q.start);
  const end = minutesOf(q.end);
  if (start === null || end === null || start === end) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/* ── the watching rule (§4.9) ─────────────────────────────────────────────── */

/**
 * The thread this browser is showing, when it is showing one.
 *
 * `focused` is the whole reason this is three fields and not two. A chat view
 * left open on a second monitor behind an editor is not somebody watching a
 * conversation, and treating it as one would silently drop exactly the
 * notifications the operator went to another window in order to be told about.
 */
export interface WatchedThread {
  instance: string;
  bot: string;
  /** The document has focus and the chat view is the visible one. */
  focused: boolean;
}

/**
 * Which thread a row is about, or `null` for a row that is about no thread.
 *
 * The separator is the first `/`, because an instance is an agent name and
 * `AGENT_NAME_RE` admits neither `/` nor `:` — core says the same thing beside
 * `chatActionRef`, and this is the forced copy of it on the browser's side.
 */
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

/**
 * Whether this row is about the conversation the operator is already reading.
 *
 * **The rule, and the argument for it.** A reply that lands in the thread that
 * is open *and* focused does not interrupt; everything else does. That covers
 * the case the "Agent messages" group exists for — a reply in a thread you
 * are not looking at — and, more importantly, it leaves the
 * agent-initiated turns alone. §9.2's `routine`, `channel`, `peer` and `room`
 * origins arrive without the operator having asked for anything, and those are
 * the notifications this whole surface is for; suppressing them because some
 * *other* thread happens to be open would be the one failure mode worth
 * avoiding.
 *
 * Two things this rule deliberately does **not** do.
 *
 * It does not suppress the inbox row, only the interruption. The record that a
 * cron job spoke at 03:00 is worth keeping whether or not somebody saw it live,
 * and `read_at` — the operator's own acknowledgement — is the field that says
 * they did.
 *
 * It does not live in core. Which thread a browser is showing, and whether that
 * browser has focus, are facts no process on the other side of the HTTP
 * boundary can know; core's half of the same question is coarser and structural
 * (a turn hermetic streamed to a caller raises no row at all), and the two
 * halves are deliberately in the two places that can answer them.
 */
export function isWatchingThread(
  n: { kind: string; ref?: string | null },
  watched: WatchedThread | null | undefined,
): boolean {
  if (!watched?.focused) return false;
  const thread = chatThreadOf(n);
  if (thread === null) return false;
  return thread.instance === watched.instance && thread.bot === watched.bot;
}

/* ── toasts ──────────────────────────────────────────────────────────────── */

/** How long a dismissable toast stays, and the length of its life bar. */
export const TOAST_DWELL_MS = 4000;

/** At most four at once; the oldest dismissable one is evicted to make room. */
export const TOAST_STACK_MAX = 4;

/**
 * Whether this row may interrupt. Five gates, in order: a row whose condition
 * has already cleared never does, because interrupting somebody about a problem
 * that no longer exists is the worst thing this stack can do with their
 * attention; a muted row never does (that is what muting is); a row about the
 * conversation already on screen and in focus never does (`isWatchingThread`);
 * a group set to `off` or `inbox` never does; quiet hours hold everything
 * *except* an approval, because a paused agent is holding an EC2 instance and a
 * model context open either way (the approvals-ignore-quiet-hours rule).
 *
 * The watching gate sits above the delivery gate rather than below it because
 * it is about *this* row rather than about a preference, and reading it second
 * would make "why did that not toast" depend on which of two unrelated answers
 * happened to be checked first.
 */
export function shouldToast(
  n: NotificationLike,
  prefs: NotificationPrefs,
  quiet: QuietHours = prefs.quiet,
  now: Date = new Date(),
  watched: WatchedThread | null = null,
): boolean {
  if (isResolved(n)) return false;
  if (n.muted) return false;
  if (isWatchingThread(n, watched)) return false;
  if (prefs.delivery[groupOf(n)] !== "toast") return false;
  if (n.class !== "needs_action" && inQuietHours(now, quiet)) return false;
  return true;
}

/** A desktop notification rides on a toast, and on the group's own opt-in. */
export function shouldDesktop(
  n: NotificationLike,
  prefs: NotificationPrefs,
  quiet: QuietHours = prefs.quiet,
  now: Date = new Date(),
  watched: WatchedThread | null = null,
): boolean {
  return shouldToast(n, prefs, quiet, now, watched) && prefs.desktop[groupOf(n)];
}

/**
 * How long the toast stays, or `null` for a sticky one. Anything that needs an
 * answer, and anything that failed, stays until it is dismissed: those are the
 * two cases where leaving the screen loses the only copy the operator saw.
 */
export function toastDwellMs(n: NotificationLike): number | null {
  return n.class === "needs_action" || n.class === "bad" ? null : TOAST_DWELL_MS;
}

/* ── the centre's tabs ───────────────────────────────────────────────────── */

/**
 * `all | needs_you | fleet`. A fourth tab, Mentions, is not here: it filters
 * on a chat concept (being named in a thread) that no `Notification` carries
 * yet, so it would be a tab that is always empty until Phase 6.
 */
export type NotificationTab = "all" | "needs_you" | "fleet";

export const NOTIFICATION_TABS: readonly { id: NotificationTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs_you", label: "Needs you" },
  { id: "fleet", label: "Fleet" },
];

/** The sources that are about the fleet rather than about a conversation. */
const FLEET_SOURCES = new Set(["fleet", "operation", "agent"]);

/**
 * Which rows a tab holds.
 *
 * A resolved row is dropped from `needs you` and kept everywhere else, and that
 * split is deliberate:
 *
 * - `needs you` is the demand list. A condition that has cleared makes no
 *   demand, so keeping it there would make the tab — and the gold badge that
 *   counts it — say "three things are blocked on you" about a fleet where
 *   nothing is. It is also what keeps this count equal to core's
 *   `needs_action`, which excludes resolved rows: two surfaces reading the same
 *   inbox must not disagree about how much of it is outstanding.
 * - `all` keeps it, because the row is the *record* that the condition happened
 *   and cleared, and that record is worth exactly one place to read it. The
 *   row renders as history there rather than as a demand.
 * - `fleet` keeps it, because that tab is a cut by *source* (the fleet's own
 *   sources, as against a conversation), parallel to the Mentions tab Phase 6
 *   adds. Turning one of the two source tabs into a state filter would make
 *   `all` and `fleet` exclude the same row for two unrelated reasons.
 */
export function filterTab<T extends NotificationLike>(list: readonly T[], tab: NotificationTab): T[] {
  if (tab === "all") return [...list];
  if (tab === "needs_you") return list.filter((n) => n.class === "needs_action" && !isResolved(n));
  return list.filter((n) => FLEET_SOURCES.has(n.source));
}

export function tabCounts(list: readonly NotificationLike[]): Record<NotificationTab, number> {
  return {
    all: list.length,
    needs_you: filterTab(list, "needs_you").length,
    fleet: filterTab(list, "fleet").length,
  };
}

/* ── where an action goes ────────────────────────────────────────────────── */

/**
 * The hash an action button navigates to, or `null` when the destination is not
 * hash-addressed and the caller has to open it some other way.
 *
 * `agent` is the `null` case today: the agent drawer is `App.tsx` state raised
 * by `select(name)`, with no URL of its own, so `NotificationRow` takes an
 * `onOpenAgent` callback instead. `op` resolves to the run log rather than to
 * nothing: an op id is findable there, and a button that goes to the right page
 * beats a button that is not drawn.
 */
export function actionHash(action: NotificationActionLike): string | null {
  switch (action.target) {
    case "agent":
      return null;
    case "op":
    case "run":
      return settingsHash("runs");
    case "foundation":
      return settingsHash("foundation");
    case "volumes":
      return "#fleet/volumes";
    case "settings":
      return settingsHash("notifications");
    // Chat refs address a bot and may also name a session and message.
    case "chat":
      return chatRefHash(action.ref);
    default:
      return null;
  }
}

/* ── row chrome ──────────────────────────────────────────────────────────── */

/** The `.nt-item` modifier for a class. `info` and `warn` share the quiet rule. */
export function rowTone(cls: NotificationClassName): string {
  if (cls === "needs_action") return "needs-action";
  if (cls === "bad") return "bad";
  if (cls === "ok") return "ok";
  return "info";
}

/** The glyph in the `.nt-icon` square. */
export function classGlyph(cls: NotificationClassName): string {
  switch (cls) {
    case "needs_action":
      return "⚑";
    case "bad":
      return "✕";
    case "ok":
      return "✓";
    case "warn":
      return "▲";
    default:
      return "·";
  }
}

/** The CSS colour the tone dot and the icon border take. */
export function classColor(cls: NotificationClassName): string {
  switch (cls) {
    case "needs_action":
    case "warn":
      return "var(--warn)";
    case "bad":
      return "var(--bad)";
    case "ok":
      return "var(--ok)";
    default:
      return "var(--line2)";
  }
}

/**
 * The `<agent> · <source> · <kind suffix>` line under a row. The suffix rather
 * than the whole kind, because the source is already the half before the dot.
 */
export function sourceLine(n: {
  kind: string;
  source: string;
  agent?: string | null;
  fleet_id?: string | null;
}): string {
  const suffix = n.kind.includes(".") ? n.kind.slice(n.kind.indexOf(".") + 1) : n.kind;
  const who = n.agent ?? (n.fleet_id ? `fleet ${n.fleet_id}` : null);
  return [who, n.source, suffix].filter((p): p is string => !!p).join(" · ");
}

/**
 * The right-hand timestamp: an age while the row is young enough for one to
 * mean something, then a date. Rendered from `now` rather than from a live
 * clock — the centre re-renders on every stream frame, which is often enough.
 */
export function inboxTime(at: string, now: number = Date.now()): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "—";
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  try {
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return `${Math.floor(hours / 24)}d`;
  }
}

/* ── resolved conditions (the events-toast rule, §4.9) ────────────────────── */

/**
 * Whether the condition this row reports has since stopped holding: the
 * foundation was updated, the loose volume deleted, the grant reconciled.
 *
 * This is the world's fact, and it is not `read_at`, which is the operator's
 * (§4.9). A resolved row is not thereby read — nobody has looked at it —
 * and a read row is not thereby resolved. The two are separate fields because
 * they answer separate questions, and every rule below reads exactly one of
 * them.
 */
export function isResolved(n: { resolved_at?: string | null }): boolean {
  return !!n.resolved_at;
}

/**
 * What one streamed row adds to the badge counts.
 *
 * The stream and the inbox fetch both carry rows, and they overlap: a row the
 * last fetch already returned — and which the server's count already included
 * — can arrive again over the stream. The authoritative `notifications` count
 * frame is only emitted when the counts change, so an unconditional optimistic
 * bump for such a row leaves the badge one too high until some unrelated change
 * happens to correct it. A row already held is therefore worth nothing, and so
 * is a read one, and one whose condition has already cleared, because core's
 * own `counts` skips those too.
 */
export function streamCountDelta(
  held: readonly { id: string }[],
  n: { id: string; read_at?: string | null; class: string; resolved_at?: string | null },
): { unread: number; needs_action: number } {
  if (isResolved(n) || held.some((row) => row.id === n.id)) return { unread: 0, needs_action: 0 };
  return { unread: n.read_at ? 0 : 1, needs_action: n.class === "needs_action" ? 1 : 0 };
}

/**
 * When it cleared, in the row's own voice: "cleared just now", "cleared 3h
 * ago", "cleared Sep 12". Built on `inboxTime` so the two timestamps on a
 * row age at the same rate and in the same vocabulary — a row that says "4h"
 * on the right and "cleared 20m ago" underneath is telling one story.
 */
export function resolvedLabel(at: string, now: number = Date.now()): string {
  const t = inboxTime(at, now);
  if (t === "—") return "cleared";
  if (t === "now") return "cleared just now";
  // An age ("20m", "3h", "2d") takes "ago"; a date ("Sep 12") does not.
  return /^\d+[mhd]$/.test(t) ? `cleared ${t} ago` : `cleared ${t}`;
}

/* ── persistence (`localStorage`, beside `hermetic.theme`) ───────────────── */

export const NOTIFICATION_PREFS_KEY = "hermetic.notifications";

function isDelivery(v: unknown): v is Delivery {
  return v === "off" || v === "inbox" || v === "toast";
}

/**
 * Tolerant on purpose: this is a preference, not a record. A key that is
 * missing, a value that is not one of the three, a whole document that is not
 * JSON — each falls back to the default for that one field rather than throwing
 * away the operator's other five choices or taking the page down.
 */
export function normalizePrefs(raw: unknown): NotificationPrefs {
  const base = defaultPrefs();
  if (typeof raw !== "object" || raw === null) return base;
  const o = raw as Record<string, unknown>;
  const delivery = (
    typeof o["delivery"] === "object" && o["delivery"] !== null ? o["delivery"] : {}
  ) as Record<string, unknown>;
  const desktop = (
    typeof o["desktop"] === "object" && o["desktop"] !== null ? o["desktop"] : {}
  ) as Record<string, unknown>;
  for (const group of PREF_GROUPS) {
    const d = delivery[group.id];
    if (isDelivery(d)) base.delivery[group.id] = d;
    const k = desktop[group.id];
    if (typeof k === "boolean") base.desktop[group.id] = k;
  }
  const quiet = (typeof o["quiet"] === "object" && o["quiet"] !== null ? o["quiet"] : {}) as Record<
    string,
    unknown
  >;
  if (typeof quiet["enabled"] === "boolean") base.quiet.enabled = quiet["enabled"];
  if (typeof quiet["start"] === "string" && minutesOf(quiet["start"]) !== null)
    base.quiet.start = quiet["start"];
  if (typeof quiet["end"] === "string" && minutesOf(quiet["end"]) !== null)
    base.quiet.end = quiet["end"];
  return base;
}

export function loadNotificationPrefs(): NotificationPrefs {
  try {
    const stored = localStorage.getItem(NOTIFICATION_PREFS_KEY);
    if (stored === null) return defaultPrefs();
    return normalizePrefs(JSON.parse(stored));
  } catch {
    // No storage, or a document that is not JSON at all.
    return defaultPrefs();
  }
}

export function saveNotificationPrefs(prefs: NotificationPrefs): void {
  try {
    localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode: the choice just does not persist */
  }
}

/* ── coalescing one conversation's run of rows ───────────────────────────── */

/**
 * The conversation a row belongs to, as a grouping key, or `null` for a row
 * that is about no conversation.
 *
 * `kind` is part of the key on purpose: a `chat.message` and a `chat.error`
 * about the same bot are two different things to be told, and folding them into
 * one card would hide the failure under the traffic.
 */
export function conversationKeyOf(n: { kind: string; ref?: string | null }): string | null {
  const thread = chatThreadOf(n);
  return thread === null ? null : `${n.kind}:${thread.instance}/${thread.bot}`;
}

/** One card in the centre: a single row, or a run of rows about one conversation. */
export interface NotificationGroup<T> {
  /** Stable across renders: the conversation key, or the lone row's id. */
  key: string;
  /** Every row the card stands for, newest first. */
  rows: T[];
  /** The row the card draws: the most recent one in the run. */
  latest: T;
  count: number;
}

/**
 * Fold *consecutive* rows about one conversation into one card.
 *
 * §4.9 keys a `chat.message` row on its timestamp deliberately — two heads
 * reading one roster write one row, and a row per message is what makes the
 * unread count mean anything. That is a storage rule, not a drawing rule: forty
 * rows saying "veronica has a new message" is forty correct records and one
 * unreadable inbox. So the coalescing is here, in presentation, and nothing
 * about the rows themselves changes.
 *
 * Consecutive rather than global, because the list is ordered by time and a
 * card that swallowed rows from either side of an unrelated failure would put
 * that failure out of order to do it. A different conversation breaks the run.
 */
export function groupNotifications<T extends NotificationLike & { id: string; at: string }>(
  list: readonly T[],
): NotificationGroup<T>[] {
  const groups: NotificationGroup<T>[] = [];
  let runKey: string | null = null;
  for (const row of list) {
    const key = conversationKeyOf(row);
    const last = groups[groups.length - 1];
    if (key !== null && key === runKey && last) {
      last.rows.push(row);
      last.count += 1;
      if (Date.parse(row.at) > Date.parse(last.latest.at)) last.latest = row;
      continue;
    }
    runKey = key;
    groups.push({ key: key ?? row.id, rows: [row], latest: row, count: 1 });
  }
  return groups;
}

/**
 * The row a coalesced card draws: the latest one, unread if *any* member is.
 *
 * A card that says "40 messages" while wearing the read state of the newest one
 * would claim the whole run had been seen on the strength of one row.
 */
export function groupRow<T extends { read_at?: string | null }>(group: NotificationGroup<T>): T {
  if (group.count === 1) return group.latest;
  if (!group.latest.read_at) return group.latest;
  return group.rows.some((r) => !r.read_at) ? { ...group.latest, read_at: null } : group.latest;
}

/**
 * The centre's tab counts, with the server's totals winning where it has one.
 *
 * **One source, named.** The header badge counts `unread`/`needs_action` as the
 * server computed them over the *whole* inbox; the drawer holds at most the
 * last hundred rows. Counting the two independently made them disagree at the
 * same instant for no reason an operator could see. `needs you` is therefore
 * the server's number — it is the one the bell shows, and the two surfaces must
 * not argue about how much is outstanding (§4.9: "two surfaces reading the same
 * inbox must not disagree").
 *
 * `all` and `fleet` have no server-side total at all, so they stay counts of
 * what is held; the centre says "showing latest N" when that is a truncation
 * rather than the whole inbox.
 */
export function centerCounts(
  list: readonly NotificationLike[],
  totals?: { needsAction?: number | null } | null,
): Record<NotificationTab, number> {
  const counts = tabCounts(list);
  const needs = totals?.needsAction;
  if (typeof needs === "number") counts.needs_you = needs;
  return counts;
}

/* ── what the chat rail may read off the inbox ───────────────────────────── */

/**
 * Unread, unresolved `chat.*` rows per `<instance>/<bot>`.
 *
 * The rail's own `bot.unread` comes from the roster read, which is a box's view
 * of its own transcripts; the inbox's rows are this laptop's view of what it
 * has not been shown. Those go out of step — a box that has since been read by
 * another client still leaves rows here — and a rail whose Unread filter
 * emptied while the bell said otherwise is the shape that takes.
 */
export function unreadChatByConversation(
  list: readonly (NotificationLike & { read_at?: string | null })[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of list) {
    if (n.read_at || isResolved(n) || n.muted) continue;
    const thread = chatThreadOf(n);
    if (thread === null) continue;
    const key = `${thread.instance}/${thread.bot}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
