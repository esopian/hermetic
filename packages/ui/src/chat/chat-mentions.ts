/** Mentions are editor assistance. The selected bot and upstream protocol own delivery. */
export interface MentionBot {
  instance: string;
  name: string;
  title: string;
}
export interface MentionMatch {
  start: number;
  end: number;
  query: string;
}
export function mentionAt(text: string, cursor: number): MentionMatch | null {
  const before = text.slice(0, cursor);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: cursor - match[1]!.length - 1, end: cursor, query: match[1]!.toLowerCase() };
}
export function mentionOptions(bots: readonly MentionBot[], query: string): MentionBot[] {
  return bots
    .filter((bot) => `${bot.name} ${bot.title} ${bot.instance}`.toLowerCase().includes(query))
    .slice(0, 8);
}
export function mentionHandle(bot: MentionBot, bots: readonly MentionBot[]): string {
  return bots.filter((candidate) => candidate.name === bot.name).length > 1
    ? `@${bot.name}@${bot.instance}`
    : `@${bot.name}`;
}
export function insertMention(
  text: string,
  match: MentionMatch,
  handle: string,
): { text: string; cursor: number } {
  const prefix = `${text.slice(0, match.start)}${handle} `;
  return { text: prefix + text.slice(match.end), cursor: prefix.length };
}
