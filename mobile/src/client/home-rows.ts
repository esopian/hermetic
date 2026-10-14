/**
 * The home screen as data: the hero (every bot pinned on this phone, else the
 * default bot of each listened instance), then one quiet section per listened
 * instance holding the rest of its bots, and what each row says (badge,
 * failed mark, time, preview). Pure: the screen renders, this decides what
 * there is to render.
 */
import type { Bot, Swarm } from "@hermetic/core/chat-client";
import type { InboxEntry } from "../inbox/store.ts";
import { previewLine } from "./roster-rows.ts";
import { botKey, compareBuckets, railUnread, unreadBadge } from "./roster-store.ts";

/* ── time ───────────────────────────────────────────────────────────────── */

const DAY_MS = 86_400_000;

/** Midnight of `d`'s calendar day, local time. */
const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * Some ICU builds put a narrow no-break space before "PM"; a row reads the
 * same either way, so the stamp always carries a plain space.
 */
const plain = (s: string): string => s.replace(/[  ]/g, " ");

/**
 * The stamp on a home row, the way the reference's list reads: the clock time
 * today ("2:24 PM"), the weekday within the last six days ("Monday"), else the
 * date ("Sep 30", with the year when it is not this year's). Empty for no or an
 * unparseable stamp. Explicit locale and options (root `AGENTS.md`).
 */
export function homeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const today = new Date(now);
  // Calendar days, rounded so a daylight-saving day of 23 or 25 hours still counts as one.
  const days = Math.round((startOfDay(today) - startOfDay(then)) / DAY_MS);
  if (days === 0)
    return plain(then.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
  if (days >= 1 && days <= 6) return then.toLocaleDateString("en-US", { weekday: "long" });
  return plain(
    then.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      ...(then.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
    }),
  );
}

/* ── preview ────────────────────────────────────────────────────────────── */

/**
 * The row's second line. `sent` when the quote is the operator's own last word:
 * the row draws the outgoing glyph before it instead of `previewLine`'s "You: ".
 */
export function homePreview(bot: Bot): { text: string; sent: boolean } {
  const quote = (bot.preview ?? "").replace(/\s+/g, " ").trim();
  if (quote && bot.preview_role === "user") return { text: quote, sent: true };
  return { text: previewLine(bot), sent: false };
}

/* ── failed turns ───────────────────────────────────────────────────────── */

/**
 * Bots whose latest unread turn outcome in the phone's inbox is a failure.
 * The roster itself carries no failure flag; the inbox files `turn.error` and
 * `turn.done` as they arrive (push or this phone's own turn), so a newer
 * success clears an older failure, and reading the thread clears both.
 */
export function failedBots(entries: readonly InboxEntry[]): Set<string> {
  const seen = new Set<string>();
  const failed = new Set<string>();
  // Entries are newest first: the first outcome per bot is its latest.
  for (const e of entries) {
    if (e.read_at || (e.kind !== "turn.error" && e.kind !== "turn.done")) continue;
    const key = botKey(e.instance, e.bot);
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.kind === "turn.error") failed.add(key);
  }
  return failed;
}

/**
 * Bots with an unread `needs_action` entry in the phone's inbox. A real box's
 * roster always says `needs_action: false` (the gateway's session list carries
 * no such flag), so the push the box's watcher raised for a clarify or an
 * approval is the only way home learns a bot is waiting. Reading the thread
 * (opening it, or Mark read) clears it.
 */
export function needsBots(entries: readonly InboxEntry[]): Set<string> {
  const needs = new Set<string>();
  for (const e of entries) {
    if (!e.read_at && e.kind === "needs_action") needs.add(botKey(e.instance, e.bot));
  }
  return needs;
}

/* ── the rows ───────────────────────────────────────────────────────────── */

export interface HomeRow {
  key: string;
  bot: Bot;
  /** `!` needs you, a count when unread, else null (`unreadBadge`, inbox needs included). */
  badge: string | null;
  /**
   * The bot's own name, said quietly after its title only when another bot of
   * the same instance shows the same title; otherwise null.
   */
  suffix: string | null;
  reachable: boolean;
  failed: boolean;
  pinned: boolean;
  /** Something Mark read can clear: roster or inbox unread (inbox needs included), or a failed mark. */
  clearable: boolean;
}

export interface HomeSection {
  instance: string;
  reachable: boolean;
  /** Why the box did not answer, when it did not. */
  reason: string | null;
  /** Folded by the operator (never when unreachable: there is nothing to unfold to). */
  folded: boolean;
  /** Every bot of the instance not already in the hero, needs-you → unread → recent → name. */
  rows: HomeRow[];
  needs: boolean;
  unread: number;
}

export interface HomeInput {
  swarms: readonly Swarm[];
  listening: readonly string[];
  /** Pinned bot keys, in pin order. */
  pinned: readonly string[];
  /** Folded instances (`RosterPrefs.folded`). */
  folded?: readonly string[];
  /** Inbox unread rows for one bot (`InboxStore.unreadFor`). */
  unreadOf?: (instance: string, bot: string) => number;
  /** Keys from `failedBots`. */
  failed?: ReadonlySet<string>;
  /** Keys from `needsBots`. */
  needs?: ReadonlySet<string>;
}

export interface HomeLayout {
  /**
   * The big avatars at the top: the pinned bots in pin order, else the default
   * bot of each listened instance that answered, in listening order.
   */
  hero: HomeRow[];
  /** Whether the hero is the operator's pins (starred) or the instances' defaults. */
  heroPinned: boolean;
  /**
   * One per listened instance the roster read, ordered like the desktop rail
   * (`compareBuckets`). A reachable section the hero emptied is left out; an
   * unreachable one stays, as the header that says so.
   */
  sections: HomeSection[];
}

/** A pinned bot the roster could not list because its box is down: enough to draw it. */
function absentBot(instance: string, name: string): Bot {
  return {
    instance,
    name,
    title: name,
    is_default: false,
    avatar_seed: `${instance}/${name}`,
    unread: 0,
    needs_action: false,
    muted: false,
    warm: false,
  };
}

const stamp = (iso: string | null | undefined): number => {
  const at = iso ? Date.parse(iso) : 0;
  return Number.isNaN(at) ? 0 : at;
};

const displayName = (bot: Bot): string => (bot.title || bot.name).trim().toLowerCase();

/** Needs-you, then unread, then most recent message, then name. */
export function compareHomeRows(a: HomeRow, b: HomeRow): number {
  const an = a.badge === "!";
  const bn = b.badge === "!";
  if (an !== bn) return an ? -1 : 1;
  const au = a.badge !== null;
  const bu = b.badge !== null;
  if (au !== bu) return au ? -1 : 1;
  const at = stamp(b.bot.last_message_at) - stamp(a.bot.last_message_at);
  if (at !== 0) return at;
  return displayName(a.bot).localeCompare(displayName(b.bot), "en-US");
}

export function homeRows(input: HomeInput): HomeLayout {
  const listened = new Set(input.listening);
  // Listening order, not the order the reads came back in.
  const order = (instance: string) => input.listening.indexOf(instance);
  const swarms = input.swarms
    .filter((s) => listened.has(s.instance))
    .sort((a, b) => order(a.instance) - order(b.instance));
  const unreadOf = input.unreadOf ?? (() => 0);
  const failed = input.failed ?? new Set<string>();
  const needs = input.needs ?? new Set<string>();
  const pinned = new Set(input.pinned);
  const folded = new Set(input.folded ?? []);
  const byInstance = new Map(swarms.map((s) => [s.instance, s]));

  const row = (bot: Bot, reachable: boolean, suffix: string | null = null): HomeRow => {
    const key = botKey(bot.instance, bot.name);
    const extra = unreadOf(bot.instance, bot.name);
    const isFailed = failed.has(key);
    return {
      key,
      bot,
      badge: unreadBadge({ ...bot, needs_action: bot.needs_action || needs.has(key) }, extra),
      suffix,
      reachable,
      failed: isFailed,
      pinned: pinned.has(key),
      clearable: railUnread(bot, extra) > 0 || needs.has(key) || isFailed,
    };
  };

  // The hero: the pins still listened to. A pin on a down box is kept and dimmed
  // (an unreachable swarm lists no bots, so absence proves nothing); a pin its
  // answering box no longer lists is gone.
  const pinnedHero: HomeRow[] = [];
  for (const key of input.pinned) {
    const at = key.indexOf("/");
    if (at <= 0) continue;
    const swarm = byInstance.get(key.slice(0, at));
    if (!swarm) continue;
    const name = key.slice(at + 1);
    const bot = swarm.bots.find((b) => b.name === name);
    if (bot) pinnedHero.push(row(bot, swarm.reachable));
    else if (!swarm.reachable) pinnedHero.push(row(absentBot(swarm.instance, name), false));
  }
  const heroPinned = pinnedHero.length > 0;
  const hero = heroPinned
    ? pinnedHero
    : swarms.flatMap((s) => {
        const bot = s.bots.find((b) => b.is_default) ?? s.bots[0];
        return bot ? [row(bot, s.reachable)] : [];
      });
  const inHero = new Set(hero.map((r) => r.key));

  const sections: HomeSection[] = [];
  for (const swarm of swarms) {
    const titles = new Map<string, number>();
    for (const b of swarm.bots) titles.set(displayName(b), (titles.get(displayName(b)) ?? 0) + 1);
    const rows = swarm.bots
      .filter((b) => !inHero.has(botKey(b.instance, b.name)))
      .map((b) => row(b, swarm.reachable, (titles.get(displayName(b)) ?? 0) > 1 ? b.name : null))
      .sort(compareHomeRows);
    if (swarm.reachable && rows.length === 0) continue;
    sections.push({
      instance: swarm.instance,
      reachable: swarm.reachable,
      reason: swarm.reachable ? null : (swarm.unreachable_reason ?? null),
      folded: swarm.reachable && folded.has(swarm.instance),
      rows,
      needs: rows.some((r) => r.badge === "!"),
      unread: rows.reduce((n, r) => n + railUnread(r.bot, unreadOf(r.bot.instance, r.bot.name)), 0),
    });
  }
  const lastAt = (s: HomeSection): string | null => {
    let best: string | null = null;
    for (const r of s.rows) {
      if (stamp(r.bot.last_message_at) > stamp(best)) best = r.bot.last_message_at ?? null;
    }
    return best;
  };
  sections.sort((a, b) =>
    compareBuckets(
      { ...a, needsAction: a.needs, lastAt: lastAt(a) },
      { ...b, needsAction: b.needs, lastAt: lastAt(b) },
    ),
  );

  return { hero, heroPinned, sections };
}

/** One entry of home's flat list: a section header, or a bot row under it. */
export type HomeItem =
  | { type: "section"; key: string; section: HomeSection }
  | { type: "row"; key: string; row: HomeRow };

/** The sections as one flat list for a virtualised list; a folded section's rows are left out. */
export function homeItems(sections: readonly HomeSection[]): HomeItem[] {
  const items: HomeItem[] = [];
  for (const section of sections) {
    items.push({ type: "section", key: `section:${section.instance}`, section });
    if (section.folded) continue;
    for (const row of section.rows) items.push({ type: "row", key: row.key, row });
  }
  return items;
}

/**
 * Every listened bot the roster listed, as a home row keyed by `botKey`, for
 * screens that draw bots by home's rules outside home's layout (search).
 */
export function homeRowsByKey(input: Omit<HomeInput, "pinned" | "folded">): Map<string, HomeRow> {
  // No pins, so the hero is the defaults; with them every listed bot is either there or in a section.
  const layout = homeRows({ ...input, pinned: [] });
  const rows = [...layout.hero, ...layout.sections.flatMap((s) => s.rows)];
  return new Map(rows.map((r) => [r.key, r]));
}

/**
 * What a section header says about its instance: nothing while it answers;
 * else the fleet view's word when it is a telling one ("stopped",
 * "bootstrapping"), or "unreachable". `status` is the key for the header's
 * dot (`statusColor`).
 */
export function sectionState(
  reachable: boolean,
  agentStatus: string | null | undefined,
): { word: string | null; status: string } {
  // It answered, so it is up whatever an older fleet view says; only "degraded" adds anything.
  if (reachable) return { word: null, status: agentStatus === "degraded" ? "degraded" : "ready" };
  const telling =
    agentStatus &&
    agentStatus !== "ready" &&
    agentStatus !== "degraded" &&
    agentStatus !== "unreachable";
  return telling
    ? { word: agentStatus, status: agentStatus }
    : { word: "unreachable", status: "unreachable" };
}
