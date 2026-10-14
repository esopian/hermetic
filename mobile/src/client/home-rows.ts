/**
 * The home screen as data: which bot is the hero (the operator's primary), the
 * flat list of every other listened bot in the order the screen draws it, and
 * what each row says (badge, quiet suffix, failed mark, time, preview).
 * Pure: the screen renders, this decides what there is to render.
 */
import type { Bot, Swarm } from "@hermetic/core/chat-client";
import type { InboxEntry } from "../inbox/store.ts";
import { previewLine } from "./roster-rows.ts";
import { botKey, unreadBadge } from "./roster-store.ts";

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

/* ── the primary bot ────────────────────────────────────────────────────── */

/**
 * The hero's bot key. The stored choice while its instance is still listened
 * and the bot is still there (or its box is down, so absence proves nothing);
 * else the default bot of the first listened instance that answered; else the
 * first bot of any; else none. Never writes: a fallback is not a choice, so the
 * stored one comes back when its bot does.
 */
export function resolvePrimary(
  swarms: readonly Swarm[],
  listening: readonly string[],
  stored: string | null,
): string | null {
  const listened = new Set(listening);
  const live = swarms.filter((s) => listened.has(s.instance));
  if (stored) {
    const at = stored.indexOf("/");
    const instance = at > 0 ? stored.slice(0, at) : "";
    const name = at > 0 ? stored.slice(at + 1) : "";
    const swarm = live.find((s) => s.instance === instance);
    if (swarm && (!swarm.reachable || swarm.bots.some((b) => b.name === name))) return stored;
  }
  // Listening order, not the order the reads came back in.
  const ordered = [...live].sort(
    (a, b) => listening.indexOf(a.instance) - listening.indexOf(b.instance),
  );
  for (const swarm of ordered) {
    const bot = swarm.bots.find((b) => b.is_default) ?? swarm.bots[0];
    if (bot) return botKey(bot.instance, bot.name);
  }
  return null;
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

/* ── the rows ───────────────────────────────────────────────────────────── */

export interface HomeRow {
  key: string;
  bot: Bot;
  /** `!` needs you, a count when unread, else null (`unreadBadge`). */
  badge: string | null;
  /** The instance, said quietly after the name when it is needed to tell bots apart. */
  suffix: string | null;
  reachable: boolean;
  failed: boolean;
  pinned: boolean;
}

export interface HomeInput {
  swarms: readonly Swarm[];
  listening: readonly string[];
  /** Pinned bot keys, in pin order. */
  pinned: readonly string[];
  /** The stored primary (`RosterPrefs.primary`); resolved here with `resolvePrimary`. */
  primary: string | null;
  /** Inbox unread rows for one bot (`InboxStore.unreadFor`). */
  unreadOf?: (instance: string, bot: string) => number;
  /** Keys from `failedBots`. */
  failed?: ReadonlySet<string>;
}

export interface HomeLayout {
  hero: HomeRow | null;
  /** Pinned first (pin order), then needs-you, unread, most recent, name. */
  rows: HomeRow[];
  /** Listened instances whose box did not answer, so their bots are missing from `rows`. */
  down: { instance: string; reason: string | null }[];
}

/** A bot the roster could not list because its box is down: enough to draw the hero. */
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

export function homeRows(input: HomeInput): HomeLayout {
  const listened = new Set(input.listening);
  const swarms = input.swarms.filter((s) => listened.has(s.instance));
  const unreadOf = input.unreadOf ?? (() => 0);
  const failed = input.failed ?? new Set<string>();
  const reachable = new Map(swarms.map((s) => [s.instance, s.reachable]));
  const bots = swarms.flatMap((s) => s.bots);

  const names = new Map<string, number>();
  for (const bot of bots) names.set(displayName(bot), (names.get(displayName(bot)) ?? 0) + 1);
  const many = swarms.length > 1;
  const pinned = new Set(input.pinned);

  const row = (bot: Bot): HomeRow => {
    const key = botKey(bot.instance, bot.name);
    return {
      key,
      bot,
      badge: unreadBadge(bot, unreadOf(bot.instance, bot.name)),
      suffix: many || (names.get(displayName(bot)) ?? 0) > 1 ? bot.instance : null,
      reachable: reachable.get(bot.instance) ?? true,
      failed: failed.has(key),
      pinned: pinned.has(key),
    };
  };

  const heroKey = resolvePrimary(swarms, input.listening, input.primary);
  let hero: HomeRow | null = null;
  if (heroKey) {
    const found = bots.find((b) => botKey(b.instance, b.name) === heroKey);
    if (found) hero = row(found);
    else {
      const at = heroKey.indexOf("/");
      hero = { ...row(absentBot(heroKey.slice(0, at), heroKey.slice(at + 1))), reachable: false };
    }
  }

  const byKey = new Map(bots.map((b) => [botKey(b.instance, b.name), b] as const));
  const pinnedRows = input.pinned
    .filter((k) => k !== heroKey)
    .map((k) => byKey.get(k))
    .filter((b): b is Bot => b !== undefined)
    .map(row);

  // The badge carries the inbox's unread too, so a push that beat the roster
  // read still lifts its bot.
  const rest = bots
    .filter((b) => {
      const k = botKey(b.instance, b.name);
      return k !== heroKey && !pinned.has(k);
    })
    .map(row)
    .sort((a, b) => {
      const an = a.badge === "!";
      const bn = b.badge === "!";
      if (an !== bn) return an ? -1 : 1;
      const au = a.badge !== null;
      const bu = b.badge !== null;
      if (au !== bu) return au ? -1 : 1;
      const at = stamp(b.bot.last_message_at) - stamp(a.bot.last_message_at);
      if (at !== 0) return at;
      return displayName(a.bot).localeCompare(displayName(b.bot), "en-US");
    });

  return {
    hero,
    rows: [...pinnedRows, ...rest],
    down: swarms
      .filter((s) => !s.reachable)
      .map((s) => ({ instance: s.instance, reason: s.unreachable_reason ?? null })),
  };
}
