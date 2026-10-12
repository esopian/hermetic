/**
 * The inbox's rules, pure and DOM-free (§4.9, Inbox v2).
 *
 * `notification-logic.ts` decides what a notification *is* to this laptop —
 * its tone, whether it may interrupt, how long its toast stays. This file
 * decides what the operator can *do* with the inbox: which rows each tab and
 * each drawer view holds, how they fall into sections, which ids a scoped
 * "Mark 6 read" or "Clear 4 read" really names, what a snooze preset means at
 * a given moment, and — the one with the most ways to go wrong — what writes
 * put a set of rows back exactly as they were when the operator presses undo.
 *
 * Everything takes `now` from the caller rather than reading a clock, so a
 * section boundary or a snooze preset is a fact a test can pin.
 */
import { conversationKeyOf, groupNotifications, isResolved } from "./notification-logic.ts";
import type { NotificationGroup, NotificationLike } from "./notification-logic.ts";

/* ── the row, as these rules see it ──────────────────────────────────────── */

/**
 * The fields the inbox rules read, structurally. `cleared_at` and
 * `snoozed_until` are optional so the rules compile against a row that
 * predates them (a head older than the fields reads as "never cleared, never
 * snoozed", which is exactly what such a row is).
 */
export interface InboxRow extends NotificationLike {
  id: string;
  at: string;
  title?: string;
  agent?: string | null;
  detail?: string | null;
  key?: string | null;
  read_at?: string | null;
  resolved_at?: string | null;
  cleared_at?: string | null;
  snoozed_until?: string | null;
}

/** The row left the inbox; it is in History until retention deletes it. */
export function isCleared(n: { cleared_at?: string | null }): boolean {
  return !!n.cleared_at;
}

/** Hidden from the inbox until `snoozed_until`, and back on its own after it. */
export function isSnoozed(n: { snoozed_until?: string | null }, now: number): boolean {
  if (!n.snoozed_until) return false;
  const t = Date.parse(n.snoozed_until);
  return !Number.isNaN(t) && t > now;
}

/** Core's `inbox` view: not cleared, and not snoozed into the future. */
export function inInbox(n: InboxRow, now: number): boolean {
  return !isCleared(n) && !isSnoozed(n, now);
}

/**
 * A condition that still holds: a keyed row (§4.9 — the key is what makes a
 * condition notify once while it holds) whose condition has not cleared.
 * Drawn with the `open` tag; clearing one means "hidden until it changes".
 */
export function isOpenCondition(n: InboxRow): boolean {
  return !!n.key && !isResolved(n);
}

/** Pinned under `Waiting on you`: a needs-you row whose demand still stands. */
export function isWaiting(n: InboxRow): boolean {
  return n.class === "needs_action" && !isResolved(n);
}

export function isUnread(n: { read_at?: string | null }): boolean {
  return !n.read_at;
}

/* ── the centre's tabs ───────────────────────────────────────────────────── */

export type CenterTab = "needs_you" | "unread" | "all";

/** In key order: `1`, `2`, `3`. */
export const CENTER_TABS: readonly { id: CenterTab; label: string }[] = [
  { id: "needs_you", label: "Needs you" },
  { id: "unread", label: "Unread" },
  { id: "all", label: "All" },
];

/**
 * The rows one tab holds, out of the inbox view. `unread` skips a resolved row
 * for the reason core's count does: a cleared condition nobody has opened is
 * history, not work.
 */
export function filterCenter<T extends InboxRow>(list: readonly T[], tab: CenterTab, now: number): T[] {
  const inbox = list.filter((n) => inInbox(n, now));
  if (tab === "needs_you") return inbox.filter(isWaiting);
  if (tab === "unread") return inbox.filter((n) => isUnread(n) && !isResolved(n));
  return inbox;
}

/**
 * The tab counts. `unread` is the server's total when it has sent them — the
 * bell shows it, and the two must not argue. `needs you` is what the tab
 * lists, always: the server's `needs_action` counts unread rows only, while the
 * tab (`isWaiting`) keeps a read demand that still stands, so the server's
 * number would read "Needs you 0" over a pinned row. `all` is what is held,
 * because nothing else counts it.
 */
export function centerTabCounts(
  list: readonly InboxRow[],
  now: number,
  totals: { unread?: number | null } = {},
): Record<CenterTab, number> {
  return {
    needs_you: filterCenter(list, "needs_you", now).length,
    unread:
      typeof totals.unread === "number" ? totals.unread : filterCenter(list, "unread", now).length,
    all: filterCenter(list, "all", now).length,
  };
}

/* ── the bell ────────────────────────────────────────────────────────────── */

/**
 * What the bell draws: the gold needs-you count with a dim `+N` for the other
 * unread rows, or the orange unread count alone. Gold still outranks orange —
 * the `+N` is not a second colour, it is the same count said quieter.
 */
export function bellParts(
  unread: number,
  needsAction: number,
): { tone: "quiet" | "unread" | "needs_action"; main: number; more: number } {
  if (needsAction > 0)
    return { tone: "needs_action", main: needsAction, more: Math.max(0, unread - needsAction) };
  if (unread > 0) return { tone: "unread", main: unread, more: 0 };
  return { tone: "quiet", main: 0, more: 0 };
}

/* ── sections ────────────────────────────────────────────────────────────── */

export type SectionId = "waiting" | "today" | "yesterday" | "week" | "older";

export const SECTION_LABEL: Record<SectionId, string> = {
  waiting: "Waiting on you",
  today: "Today",
  yesterday: "Yesterday",
  week: "Earlier this week",
  older: "Older",
};

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Which time section a row falls in, by the local calendar rather than by age. */
export function timeBucket(at: string, now: number): Exclude<SectionId, "waiting"> {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "older";
  const today = startOfDay(now);
  if (t >= today) return "today";
  const yesterday = startOfDay(today - DAY_MS / 2);
  if (t >= yesterday) return "yesterday";
  if (t >= today - 6 * DAY_MS) return "week";
  return "older";
}

/** The kind of card a coalesced run draws as. */
export type CardKind = "single" | "conversation" | "operations";

export interface InboxCard<T> extends NotificationGroup<T> {
  kind: CardKind;
}

/**
 * The coalescing key: one conversation's run (the existing grouping), or a run
 * of finished operations, which say nothing individually that the run log
 * does not say better.
 */
export function coalesceKeyOf(n: { kind: string; ref?: string | null }): string | null {
  const conversation = conversationKeyOf(n);
  if (conversation !== null) return conversation;
  return n.kind === "operation.done" ? "operation.done" : null;
}

export function coalesce<T extends InboxRow>(list: readonly T[]): InboxCard<T>[] {
  return groupNotifications(list, coalesceKeyOf).map((g) => ({
    ...g,
    kind: g.count === 1 ? "single" : g.latest.kind === "operation.done" ? "operations" : "conversation",
  }));
}

export interface InboxSection<T> {
  id: SectionId;
  label: string;
  /** Drawn gold: the demand list, or every section of the Needs-you tab. */
  pin: boolean;
  cards: InboxCard<T>[];
}

function byNewest<T extends { at: string }>(a: T, b: T): number {
  return Date.parse(b.at) - Date.parse(a.at);
}

/**
 * The list as sections: `Waiting on you` pinned first (when `pinWaiting`), then
 * Today / Yesterday / Earlier this week / Older, each coalesced on its own so
 * no card straddles a section boundary.
 */
export function buildSections<T extends InboxRow>(
  list: readonly T[],
  now: number,
  { pinWaiting = true, allPin = false }: { pinWaiting?: boolean; allPin?: boolean } = {},
): InboxSection<T>[] {
  const out: InboxSection<T>[] = [];
  const pinned = pinWaiting ? list.filter(isWaiting).sort(byNewest) : [];
  if (pinned.length)
    out.push({ id: "waiting", label: SECTION_LABEL.waiting, pin: true, cards: coalesce(pinned) });
  const rest = pinWaiting ? list.filter((n) => !isWaiting(n)) : [...list];
  for (const id of ["today", "yesterday", "week", "older"] as const) {
    const rows = rest.filter((n) => timeBucket(n.at, now) === id).sort(byNewest);
    if (rows.length) out.push({ id, label: SECTION_LABEL[id], pin: allPin, cards: coalesce(rows) });
  }
  return out;
}

/** Every row id a section stands for, across its coalesced cards. */
export function sectionRows<T extends InboxRow>(section: InboxSection<T>): T[] {
  return section.cards.flatMap((c) => c.rows);
}

/** The cards in drawing order — what `j`/`k` walk. */
export function flatCards<T>(sections: readonly InboxSection<T>[]): InboxCard<T>[] {
  return sections.flatMap((s) => s.cards);
}

/* ── scoped bulk verbs ───────────────────────────────────────────────────── */

/**
 * "Mark N read": the unread rows of exactly the list in view, leaving out
 * resolved ones. The header's "N unread" is core's count, which skips a
 * resolved row, so the button counting one would disagree with it. A resolved
 * row is still marked read individually.
 */
export function markReadRows<T extends InboxRow>(list: readonly T[]): T[] {
  return list.filter((n) => isUnread(n) && !isResolved(n));
}

export function unreadIds(list: readonly InboxRow[]): string[] {
  return markReadRows(list).map((n) => n.id);
}

/** "Clear N read": the read rows of exactly the list in view. */
export function readIds(list: readonly InboxRow[]): string[] {
  return list.filter((n) => !isUnread(n)).map((n) => n.id);
}

/** A write takes at most this many ids (`ids: string[] (1..500)`). */
export const BATCH_MAX = 500;

export function chunkIds(ids: readonly string[], size = BATCH_MAX): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/* ── snooze ──────────────────────────────────────────────────────────────── */

export interface SnoozePreset {
  id: "hour" | "evening" | "morning" | "week";
  label: string;
  /** The moment, as the menu's right-hand hint says it. */
  hint: string;
  until: string;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * When a snooze ends, said the way the row says it: a clock time today, a
 * weekday within the week, a date beyond it.
 */
export function snoozeLabel(until: string, now: number): string {
  const t = Date.parse(until);
  if (Number.isNaN(t)) return "later";
  const d = new Date(t);
  const today = startOfDay(now);
  if (t < today + DAY_MS) return hhmm(d);
  if (t < today + 7 * DAY_MS) return `${WEEKDAY[d.getDay()]} ${hhmm(d)}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hhmm(d)}`;
}

/**
 * The snooze menu, at `now`: an hour from now, this evening at 18:00 (while it
 * is still ahead), tomorrow at 09:00, and next Monday at 09:00. Local time,
 * because "this evening" means the operator's evening.
 */
export function snoozePresets(now: number): SnoozePreset[] {
  const at = (d: Date) => ({ until: d.toISOString(), hint: snoozeLabel(d.toISOString(), now) });
  const out: SnoozePreset[] = [];
  out.push({ id: "hour", label: "1 hour", ...at(new Date(now + 3_600_000)) });
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  if (evening.getTime() > now) out.push({ id: "evening", label: "This evening", ...at(evening) });
  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(9, 0, 0, 0);
  out.push({ id: "morning", label: "Tomorrow morning", ...at(morning) });
  const monday = new Date(now);
  const ahead = (8 - monday.getDay()) % 7 || 7;
  monday.setDate(monday.getDate() + ahead);
  monday.setHours(9, 0, 0, 0);
  out.push({ id: "week", label: "Next week", ...at(monday) });
  return out;
}

/* ── verbs, their local effect, and their undo ───────────────────────────── */

export type InboxVerb =
  | { verb: "read" }
  | { verb: "unread" }
  | { verb: "clear" }
  | { verb: "restore" }
  | { verb: "snooze"; until: string }
  | { verb: "unsnooze" };

/** One request a verb or its undo sends, named by the method it calls. */
export type InboxWrite =
  | { method: "notifications.ack"; input: { ids: string[]; unread?: true } }
  | { method: "notifications.clear"; input: { ids: string[]; restore?: true } }
  | { method: "notifications.snooze"; input: { ids: string[]; until: string } }
  | { method: "notifications.snooze"; input: { ids: string[]; clear: true } };

/** The rows a verb would actually change — the ones worth a write and a count. */
export function affectedRows<T extends InboxRow>(
  verb: InboxVerb,
  rows: readonly T[],
  now: number,
): T[] {
  switch (verb.verb) {
    case "read":
      return rows.filter(isUnread);
    case "unread":
      return rows.filter((n) => !isUnread(n));
    case "clear":
      return rows.filter((n) => !isCleared(n));
    case "restore":
      return rows.filter((n) => isCleared(n) || isSnoozed(n, now));
    case "snooze":
      return rows.filter((n) => !isCleared(n));
    case "unsnooze":
      return rows.filter((n) => isSnoozed(n, now));
  }
}

/**
 * What a verb does to one row, as core does it — applied optimistically before
 * the write answers. Clearing also reads (the contract: "clearing also sets
 * `read_at` if null"); restoring also lifts a snooze.
 */
export function applyVerb<T extends InboxRow>(row: T, verb: InboxVerb, at: string): T {
  switch (verb.verb) {
    case "read":
      return row.read_at ? row : { ...row, read_at: at };
    case "unread":
      return row.read_at ? { ...row, read_at: null } : row;
    case "clear":
      return row.cleared_at ? row : { ...row, cleared_at: at, read_at: row.read_at ?? at };
    case "restore":
      return { ...row, cleared_at: null, snoozed_until: null };
    case "snooze":
      return { ...row, snoozed_until: verb.until };
    case "unsnooze":
      return { ...row, snoozed_until: null };
  }
}

/** The forward writes for a verb over rows already narrowed by `affectedRows`. */
export function verbWrites(verb: InboxVerb, rows: readonly InboxRow[]): InboxWrite[] {
  const ids = rows.map((n) => n.id);
  if (ids.length === 0) return [];
  const out: InboxWrite[] = [];
  for (const batch of chunkIds(ids)) {
    switch (verb.verb) {
      case "read":
        out.push({ method: "notifications.ack", input: { ids: batch } });
        break;
      case "unread":
        out.push({ method: "notifications.ack", input: { ids: batch, unread: true } });
        break;
      case "clear":
        out.push({ method: "notifications.clear", input: { ids: batch } });
        break;
      case "restore":
        out.push({ method: "notifications.clear", input: { ids: batch, restore: true } });
        break;
      case "snooze":
        out.push({ method: "notifications.snooze", input: { ids: batch, until: verb.until } });
        break;
      case "unsnooze":
        out.push({ method: "notifications.snooze", input: { ids: batch, clear: true } });
        break;
    }
  }
  return out;
}

/**
 * The writes that put `current` back to `prior`, row by row — the undo of any
 * verb, built from the rows' state *before* it rather than from the verb.
 *
 * That is the whole point of taking snapshots: clearing four rows of which two
 * were unread is undone by restoring all four *and* marking those two unread
 * again, and a snooze over rows that were already snoozed is undone by putting
 * each back to its own earlier `until`, not by lifting all of them.
 *
 * The order is load-bearing, because each write has side effects core applies
 * at once:
 *
 * 1. Mark unread first. Core's `clear_resolved_on_read` sweep clears any row
 *    that is both resolved and read, so restoring a resolved row while it is
 *    still read would see it swept straight back into History.
 * 2. Un-clear (`restore`, which also lifts any snooze): every row the held
 *    copy shows cleared, and also every row step 1 marked unread. Reading an
 *    unread resolved row lets the sweep clear it on the server while the held
 *    copy still shows it in the inbox, so the only safe undo of a read is to
 *    restore it as well. Core's restore touches only a cleared or snoozed row,
 *    so this costs nothing when the sweep did not fire.
 * 3. Re-clear what was cleared before (`clear`, which also reads).
 * 4. Snoozes, each back to its own earlier `until` while still ahead.
 * 5. Whatever read state the steps above left wrong.
 */
export function restoreWrites(
  prior: readonly InboxRow[],
  current: readonly InboxRow[],
  now: number,
): InboxWrite[] {
  const byId = new Map(current.map((n) => [n.id, n]));
  let sim = prior
    .map((p) => ({ p, c: byId.get(p.id) }))
    .filter((x): x is { p: InboxRow; c: InboxRow } => x.c !== undefined);
  const out: InboxWrite[] = [];
  const push = (write: (ids: string[]) => InboxWrite, ids: string[]) => {
    for (const batch of chunkIds(ids)) if (batch.length) out.push(write(batch));
  };
  const update = (ids: readonly string[], patch: (x: { p: InboxRow; c: InboxRow }) => InboxRow) => {
    const set = new Set(ids);
    sim = sim.map((x) => (set.has(x.p.id) ? { p: x.p, c: patch(x) } : x));
  };

  // 1. Unread before anything is restored. A row that was cleared before is
  // left for step 5: re-clearing it in step 3 reads it again.
  const early = sim
    .filter((x) => isUnread(x.p) && !isUnread(x.c) && !isCleared(x.p))
    .map((x) => x.p.id);
  push((ids) => ({ method: "notifications.ack", input: { ids, unread: true } }), early);
  update(early, (x) => ({ ...x.c, read_at: null }));

  // 2. Un-clear what was not cleared before (this also lifts any snooze),
  // including what step 1 marked unread: the read may have swept it.
  const reread = new Set(early);
  const unclear = sim
    .filter((x) => !isCleared(x.p) && (isCleared(x.c) || reread.has(x.p.id)))
    .map((x) => x.p.id);
  push((ids) => ({ method: "notifications.clear", input: { ids, restore: true } }), unclear);
  update(unclear, (x) => ({ ...x.c, cleared_at: null, snoozed_until: null }));

  // 3. Clear what was cleared before (this also reads).
  const reclear = sim.filter((x) => isCleared(x.p) && !isCleared(x.c)).map((x) => x.p.id);
  push((ids) => ({ method: "notifications.clear", input: { ids } }), reclear);
  update(reclear, (x) => ({
    ...x.c,
    cleared_at: x.p.cleared_at,
    read_at: x.c.read_at ?? x.p.cleared_at,
  }));

  // 4. Snoozes: back to each row's own earlier `until` while it is still ahead,
  // or lifted where there was none. History is not snoozed.
  const live = sim.filter((x) => !isCleared(x.p));
  const lift = live.filter((x) => !isSnoozed(x.p, now) && isSnoozed(x.c, now)).map((x) => x.p.id);
  push((ids) => ({ method: "notifications.snooze", input: { ids, clear: true } }), lift);
  const resnooze = new Map<string, string[]>();
  for (const x of live) {
    if (!isSnoozed(x.p, now) || x.p.snoozed_until === x.c.snoozed_until) continue;
    const until = x.p.snoozed_until as string;
    resnooze.set(until, [...(resnooze.get(until) ?? []), x.p.id]);
  }
  for (const [until, ids] of resnooze)
    push((batch) => ({ method: "notifications.snooze", input: { ids: batch, until } }), ids);

  // 5. Read state, against what the steps above left behind.
  const markUnread = sim.filter((x) => isUnread(x.p) && !isUnread(x.c)).map((x) => x.p.id);
  push((ids) => ({ method: "notifications.ack", input: { ids, unread: true } }), markUnread);
  const markRead = sim.filter((x) => !isUnread(x.p) && isUnread(x.c)).map((x) => x.p.id);
  push((ids) => ({ method: "notifications.ack", input: { ids } }), markRead);
  return out;
}

/**
 * What one row adds to the server's two counts, so an optimistic write can
 * move the badge by the difference. Mirrors core: neither counts a resolved,
 * cleared or actively snoozed row; `needs_action` does not care about read.
 */
export function countWeight(n: InboxRow, now: number): { unread: number; needs: number } {
  if (!inInbox(n, now) || isResolved(n)) return { unread: 0, needs: 0 };
  return { unread: isUnread(n) ? 1 : 0, needs: n.class === "needs_action" ? 1 : 0 };
}

export function countDelta(
  before: readonly InboxRow[],
  after: readonly InboxRow[],
  now: number,
): { unread: number; needs: number } {
  let unread = 0;
  let needs = 0;
  for (const n of after) {
    const w = countWeight(n, now);
    unread += w.unread;
    needs += w.needs;
  }
  for (const n of before) {
    const w = countWeight(n, now);
    unread -= w.unread;
    needs -= w.needs;
  }
  return { unread, needs };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The undo bar's line for a verb: `Cleared 4 notifications · kept in History for 30 days`. */
export function verbLabel(
  verb: InboxVerb,
  rows: readonly InboxRow[],
  now: number,
): { label: string; sub: string } {
  const n = rows.length;
  switch (verb.verb) {
    case "read":
      return { label: `Marked ${plural(n, "notification")} read`, sub: "" };
    case "unread":
      return { label: `Marked ${plural(n, "notification")} unread`, sub: "" };
    case "clear": {
      const open = rows.filter(isOpenCondition).length;
      return {
        label: `Cleared ${plural(n, "notification")}`,
        sub: open ? `${open} still open · hidden until it changes` : "kept in History for 30 days",
      };
    }
    case "restore":
      return { label: `Moved ${n} back to the inbox`, sub: "" };
    case "snooze":
      return {
        label: `Snoozed ${plural(n, "notification")}`,
        sub: `until ${snoozeLabel(verb.until, now)}`,
      };
    case "unsnooze":
      return { label: `Unsnoozed ${n}`, sub: "" };
  }
}

/* ── the drawer ──────────────────────────────────────────────────────────── */

export type DrawerView = "inbox" | "needs_you" | "unread" | "snoozed" | "history";

export const DRAWER_VIEWS: readonly { id: DrawerView; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "needs_you", label: "Needs you" },
  { id: "unread", label: "Unread" },
  { id: "snoozed", label: "Snoozed" },
  { id: "history", label: "History" },
];

/** The rail's sources, in the operator's words rather than the enum's. */
export const DRAWER_SOURCES: readonly { id: string; label: string }[] = [
  { id: "operation", label: "Operations" },
  { id: "agent", label: "Health" },
  { id: "chat", label: "Chat" },
  { id: "fleet", label: "Advisories" },
];

export interface DrawerFilter {
  view: DrawerView;
  source: string | null;
  agent: string | null;
  q: string;
}

/** The drawer view a centre tab hands off to on `Full inbox →`. */
export function drawerViewForTab(tab: CenterTab): DrawerView {
  return tab === "all" ? "inbox" : tab;
}

/**
 * The rows the drawer lists. The inbox-derived views read the held inbox; the
 * snoozed and history views read their own fetch (`notifications.list({view})`),
 * because the inbox read does not carry them.
 */
export function drawerRows<T extends InboxRow>(
  inbox: readonly T[],
  views: { snoozed?: readonly T[] | null; history?: readonly T[] | null },
  filter: DrawerFilter,
  now: number,
): T[] {
  let list: T[];
  if (filter.view === "snoozed") list = [...(views.snoozed ?? [])];
  else if (filter.view === "history") list = [...(views.history ?? [])];
  else list = filterCenter(inbox, filter.view === "inbox" ? "all" : filter.view, now);
  if (filter.source) list = list.filter((n) => n.source === filter.source);
  if (filter.agent) list = list.filter((n) => n.agent === filter.agent);
  const q = filter.q.trim().toLowerCase();
  if (q)
    list = list.filter((n) =>
      [n.title ?? "", n.detail ?? "", n.agent ?? "", n.kind].join(" ").toLowerCase().includes(q),
    );
  return list.sort(byNewest);
}

/* ── the keyboard ────────────────────────────────────────────────────────── */

export type InboxKeyAction =
  | "down"
  | "up"
  | "open"
  | "clear"
  | "toggle_read"
  | "snooze"
  | "mute"
  | "undo"
  | "read_view"
  | "clear_read_view"
  | "tab_1"
  | "tab_2"
  | "tab_3"
  | "select"
  | "select_all"
  | "close"
  | "open_drawer";

/**
 * What a keystroke means inside the centre or the drawer, or `null` for one
 * they leave alone. Escape is not here — the shared focus stack owns it — and
 * neither is anything with ⌘, Ctrl or Alt, which belongs to the app.
 */
export function inboxKeyAction(
  e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  surface: "center" | "drawer",
): InboxKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case "j":
    case "ArrowDown":
      return "down";
    case "k":
    case "ArrowUp":
      return "up";
    case "Enter":
      return "open";
    case "e":
    case "Backspace":
      return "clear";
    case "r":
      return "toggle_read";
    case "s":
      return "snooze";
    case "m":
      return "mute";
    case "z":
      return "undo";
    case "R":
      return "read_view";
    case "E":
      return "clear_read_view";
    case "1":
      return surface === "center" ? "tab_1" : null;
    case "2":
      return surface === "center" ? "tab_2" : null;
    case "3":
      return surface === "center" ? "tab_3" : null;
    case "x":
      return surface === "drawer" ? "select" : null;
    case "A":
      return surface === "drawer" ? "select_all" : null;
    case "i":
      return surface === "center" ? "close" : null;
    case "I":
      return surface === "center" ? "open_drawer" : null;
    default:
      return null;
  }
}

/** `j`/`k`: the next key in `keys` from `current`, clamped at the ends. */
export function moveFocus(
  keys: readonly string[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (keys.length === 0) return null;
  const i = current === null ? -1 : keys.indexOf(current);
  if (i === -1) return delta === 1 ? (keys[0] ?? null) : (keys[keys.length - 1] ?? null);
  return keys[Math.max(0, Math.min(keys.length - 1, i + delta))] ?? null;
}

/**
 * Where focus goes after the focused card leaves the list (cleared, snoozed):
 * the one below it, else the one above, else nowhere.
 */
export function focusAfterRemoval(keys: readonly string[], current: string | null): string | null {
  if (current === null) return null;
  const i = keys.indexOf(current);
  if (i === -1) return null;
  return keys[i + 1] ?? keys[i - 1] ?? null;
}

/** Shift-click: every key between the last one ticked and this one, inclusive. */
export function rangeKeys(keys: readonly string[], anchor: string | null, target: string): string[] {
  const b = keys.indexOf(target);
  const a = anchor === null ? -1 : keys.indexOf(anchor);
  if (a === -1 || b === -1) return [target];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return keys.slice(lo, hi + 1);
}

/** `HH:MM`, for the children of a coalesced card. */
export function clockTime(at: string): string {
  const t = Date.parse(at);
  return Number.isNaN(t) ? "—" : hhmm(new Date(t));
}
