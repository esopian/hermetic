/**
 * The New chat sheet's pure parts: which bots it offers, in what order, and
 * where a pick goes. A pick opens the conversation with `fresh=1`, which the
 * conversation screen turns into one `new_session` open (`isFresh`).
 */
import type { Bot } from "@hermetic/core/chat-client";

/** Listened bots in listening order, each instance's default bot first, then by title. */
export function newChatBots(
  swarms: readonly { instance: string; bots: readonly Bot[] }[],
  listening: readonly string[],
): Bot[] {
  const order = new Map(listening.map((instance, i) => [instance, i]));
  return swarms
    .filter((s) => order.has(s.instance))
    .sort((a, b) => (order.get(a.instance) ?? 0) - (order.get(b.instance) ?? 0))
    .flatMap((s) =>
      [...s.bots].sort(
        (a, b) =>
          Number(b.is_default) - Number(a.is_default) ||
          (a.title || a.name).localeCompare(b.title || b.name, "en"),
      ),
    );
}

/** The conversation route for a new, separate session with `bot`. */
export const freshChatPath = (bot: Pick<Bot, "instance" | "name">): string =>
  `/chat/${encodeURIComponent(bot.instance)}/${encodeURIComponent(bot.name)}?fresh=1`;

/** Whether the conversation route was asked to start a new session. */
export const isFresh = (param: string | string[] | undefined): boolean =>
  (Array.isArray(param) ? param[0] : param) === "1";
