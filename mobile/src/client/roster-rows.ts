/**
 * The Bots list as flat rows for a virtualised list: the pinned block, then a
 * header per instance bucket with its bots under it unless folded, then the
 * footer. Pure: the screen renders, this decides what there is to render.
 */
import type { Bot } from "@hermetic/core/chat-client";
import { railTime } from "./chat-logic.ts";
import { botKey, type RosterLayout, rosterFooter, unreadBadge } from "./roster-store.ts";

export type RosterRow =
  | {
      kind: "head";
      key: string;
      instance: string | null;
      label: string;
      reachable: boolean;
      reason: string | null;
      folded: boolean;
      /** What a folded header still says: `!` when any bot needs you, else the unread sum. */
      badge: string | null;
      count: number;
    }
  | { kind: "bot"; key: string; bot: Bot; pinned: boolean; badge: string | null; reachable: boolean }
  | { kind: "unreachable"; key: string; instance: string; reason: string | null }
  | { kind: "footer"; key: string; roster: string; attention: string; needs: number };

export function rosterRows(
  layout: RosterLayout,
  unreadOf: (instance: string, bot: string) => number = () => 0,
  reachableOf: (instance: string) => boolean = () => true,
): RosterRow[] {
  const rows: RosterRow[] = [];
  const badge = (bot: Bot) => unreadBadge(bot, unreadOf(bot.instance, bot.name));
  if (layout.pinned.length > 0) {
    rows.push({
      kind: "head",
      key: "h:pinned",
      instance: null,
      label: "★ Pinned",
      reachable: true,
      reason: null,
      folded: false,
      badge: null,
      count: layout.pinned.length,
    });
    for (const bot of layout.pinned)
      rows.push({
        kind: "bot",
        key: `p:${botKey(bot.instance, bot.name)}`,
        bot,
        pinned: true,
        badge: badge(bot),
        reachable: reachableOf(bot.instance),
      });
  }
  for (const bucket of layout.buckets) {
    rows.push({
      kind: "head",
      key: `h:${bucket.instance}`,
      instance: bucket.instance,
      label: bucket.instance,
      reachable: bucket.reachable,
      reason: bucket.reason,
      folded: bucket.folded,
      badge: bucket.needsAction ? "!" : bucket.unread > 0 ? String(bucket.unread) : null,
      count: bucket.botCount,
    });
    if (bucket.folded) continue;
    if (!bucket.reachable && bucket.bots.length === 0) {
      rows.push({
        kind: "unreachable",
        key: `u:${bucket.instance}`,
        instance: bucket.instance,
        reason: bucket.reason,
      });
      continue;
    }
    for (const bot of bucket.bots)
      rows.push({
        kind: "bot",
        key: `b:${botKey(bot.instance, bot.name)}`,
        bot,
        pinned: false,
        badge: badge(bot),
        reachable: bucket.reachable,
      });
  }
  if (layout.instanceCount > 0) {
    const footer = rosterFooter(layout);
    rows.push({ kind: "footer", key: "footer", ...footer, needs: layout.needsYou });
  }
  return rows;
}

/**
 * A bot's preview line: `You: …` for the operator's own last word.
 *
 * With nothing to quote it falls back the way the desktop's bot rail does
 * (`BotRail.tsx`: `preview || description || name`). A roster read can carry a
 * `last_message_at` with no preview — an older Hermes, or a session whose
 * preview the box did not send — so "No messages yet" is said only when there
 * is no last message at all, the one case it is true.
 *
 * Phone-only: the name fallback is dropped (empty string) when the row already
 * shows that name — as its title (in any case), or as the `default` tag of a bot named
 * `default` — because the desktop rail's rule there reads "ember default /
 * default" on a phone row. The row then draws no second line.
 */
export function previewLine(bot: Bot): string {
  const text = (bot.preview ?? "").replace(/\s+/g, " ").trim();
  if (text) return bot.preview_role === "user" ? `You: ${text}` : text;
  const description = bot.description?.trim();
  if (description) return description;
  if (!bot.last_message_at) return "No messages yet";
  // Case-insensitive: a title that differs from the name only in case ("Magpie"
  // over "magpie") already shows the name.
  const nameShown =
    (bot.title || bot.name).toLowerCase() === bot.name.toLowerCase() ||
    (bot.is_default && bot.name === "default");
  return nameShown ? "" : bot.name;
}

/**
 * The time on a bot's row: `railTime` of its last message, and nothing when it
 * has none. The desktop draws `—` there; on a phone row a dash beside "No
 * messages yet" says the same thing twice, so the slot stays empty.
 */
export function rowTime(bot: Pick<Bot, "last_message_at">, now: number): string {
  return bot.last_message_at ? railTime(bot.last_message_at, now) : "";
}

/**
 * Socket states that last, and that a screen states in its own band. While one
 * holds, a list that could not be read says nothing more: the band already
 * names the cause ("connecting" flickers by on every resume, so it is not one).
 */
export const BANDED_SOCKET_STATES: ReadonlySet<string> = new Set([
  "unavailable",
  "unauthorized",
  "mismatch",
  "wrong_fleet",
]);

export type BotsEmpty = "loading" | "covered" | "error" | "nomatch" | "empty";

/** What the Bots list shows when it has no rows: one message, never the band's twice. */
export function botsEmpty(input: {
  loading: boolean;
  error: string | null;
  banded: boolean;
  searching: boolean;
}): BotsEmpty {
  if (input.banded && (input.loading || input.error !== null)) return "covered";
  if (input.loading) return "loading";
  if (input.error !== null) return "error";
  return input.searching ? "nomatch" : "empty";
}
