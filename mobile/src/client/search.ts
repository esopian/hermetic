/**
 * The Search screen's matcher: which listened bots a query finds, best first.
 *
 * Matching ignores case and whitespace, so "nick qa" finds "NickQABot". A query
 * of several words also matches when every word lands somewhere on the bot
 * ("clio corvid" finds Clio on corvid). Ranking, best first:
 *
 *   0. the name or title starts with the query
 *   1. the name or title contains it
 *   2. the description, section or instance contains it
 *   3. only the last message's preview contains it
 *
 * A multi-word match ranks by its weakest word. Ties go to the most recent
 * message, then the title. Pure: the screen renders, this decides.
 */
import type { Bot } from "@hermetic/core/chat-client";

/** Lower case, every run of whitespace removed. */
export function searchKey(text: string | null | undefined): string {
  return (text ?? "").toLowerCase().replace(/\s+/g, "");
}

const NO_MATCH = 4;

function tierOf(bot: Bot, needle: string): number {
  const names = [searchKey(bot.name), searchKey(bot.title)];
  if (names.some((n) => n.startsWith(needle))) return 0;
  if (names.some((n) => n.includes(needle))) return 1;
  const about = [searchKey(bot.description), searchKey(bot.section), searchKey(bot.instance)];
  if (about.some((n) => n.includes(needle))) return 2;
  if (searchKey(bot.preview).includes(needle)) return 3;
  return NO_MATCH;
}

/** How well `bot` matches `query`: 0 best, 3 worst, `null` for no match. */
export function searchRank(bot: Bot, query: string): number | null {
  const whole = searchKey(query);
  if (!whole) return null;
  let best = tierOf(bot, whole);
  const words = query.trim().split(/\s+/).map(searchKey).filter(Boolean);
  if (words.length > 1) {
    const weakest = Math.max(...words.map((w) => tierOf(bot, w)));
    best = Math.min(best, weakest);
  }
  return best === NO_MATCH ? null : best;
}

const at = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

/** The bots `query` finds, best first. An empty query finds nothing. */
export function searchBots(bots: readonly Bot[], query: string): Bot[] {
  if (!searchKey(query)) return [];
  const hits: { bot: Bot; rank: number }[] = [];
  for (const bot of bots) {
    const rank = searchRank(bot, query);
    if (rank !== null) hits.push({ bot, rank });
  }
  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      at(b.bot.last_message_at) - at(a.bot.last_message_at) ||
      (a.bot.title || a.bot.name).localeCompare(b.bot.title || b.bot.name, "en") ||
      a.bot.instance.localeCompare(b.bot.instance, "en"),
  );
  return hits.map((h) => h.bot);
}
