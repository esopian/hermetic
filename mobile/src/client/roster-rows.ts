/**
 * A bot's quoted last message as one line, shared by home's rows and search.
 */
import type { Bot } from "@hermetic/core/chat-client";

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
