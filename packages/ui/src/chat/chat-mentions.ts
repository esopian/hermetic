/**
 * Mentions are editor assistance. The selected bot and upstream protocol own delivery.
 *
 * The rules are Hermes Desktop's (v2026.9.24, `composer/text-utils.ts` and the
 * `hermes-bots` plugin's completion provider): `@` opens the list at a token
 * boundary, the typed prefix narrows it case-insensitively on the tag, the
 * handle or the friendly name, roster order is kept, and at most eight rows
 * show. What a bot is tagged as comes from `@hermetic/core/shared`, which the
 * box-side resolver reads too.
 */
import { botHandle, botMentionTag } from "@hermetic/core/shared";

export interface MentionBot {
  instance: string;
  name: string;
  title: string;
  is_default?: boolean;
}
export interface MentionMatch {
  start: number;
  end: number;
  query: string;
}
/** One row the picker can offer, whatever it addresses: a teammate bot or a room member. */
export interface MentionCandidate {
  key: string;
  /** Inserted as `@tag`. */
  tag: string;
  /** The friendly name the row leads with. */
  display: string;
  /** Other spellings a prefix may match, beside the tag and the display name. */
  forms: readonly string[];
  /** Whose face the row shows. */
  instance: string;
  bot: string;
}

/** Upstream's cap on completion rows. */
export const MENTION_LIMIT = 8;

/**
 * `@` after the start of the text or whitespace, then the token up to the
 * caret. U+FFFC is upstream's chip placeholder and is kept for parity; a
 * mid-word `@` (`a@b.c`) never opens the list.
 */
const AT_TRIGGER_RE = /(?:^|[\s￼])(@)([^\s@￼]*)$/;

export function mentionAt(text: string, cursor: number): MentionMatch | null {
  const match = AT_TRIGGER_RE.exec(text.slice(0, cursor));
  if (!match) return null;
  return { start: cursor - match[2]!.length - 1, end: cursor, query: match[2]!.toLowerCase() };
}

/** A teammate bot as a picker row: tagged by its friendly slug, else its handle. */
export function botCandidate(bot: MentionBot): MentionCandidate {
  return {
    key: `${bot.instance}/${bot.name}`,
    tag: botMentionTag(bot),
    display: bot.title,
    forms: [botHandle(bot.name)],
    instance: bot.instance,
    bot: bot.name,
  };
}

/** Rows whose tag, other forms or display name start with `query`; an empty query lists all. */
export function filterMentions(
  candidates: readonly MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const q = query.toLowerCase();
  return candidates
    .filter(
      (row) =>
        !q || [row.tag, row.display, ...row.forms].some((form) => form.toLowerCase().startsWith(q)),
    )
    .slice(0, MENTION_LIMIT);
}

/**
 * Replaces the typed token with `@tag` and a trailing space — unless whitespace
 * already follows the caret, where a second space would land in the prose.
 */
export function insertMention(
  text: string,
  match: MentionMatch,
  tag: string,
): { text: string; cursor: number } {
  const rest = text.slice(match.end);
  const prefix = `${text.slice(0, match.start)}@${tag}${/^\s/.test(rest) ? "" : " "}`;
  return { text: prefix + rest, cursor: prefix.length };
}
