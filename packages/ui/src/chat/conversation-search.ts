/**
 * Conversation search over what the page already holds: the sidebar's filter
 * and quick jump's chat-mode search both read through here.
 *
 * Nothing in this module makes a request. A conversation is a candidate only
 * if the page already has it — the selected bot's `chat.sessions` read, or a
 * bot's newest conversation as the roster names it (`last_message_session`) —
 * so no box is asked for its session list to answer a keystroke.
 */
import type { BotView, SessionView, SwarmView } from "../api/index.ts";
import type { ChatSelection } from "./chat-state.tsx";
import { botLabel } from "./chat-presentation.ts";
import { SILENT_LABEL, isSilentPreview } from "./chat-silence.ts";

/**
 * Case-insensitive substring match of `query` against the fields joined by a
 * space. An empty or blank query matches everything; absent fields are skipped.
 */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields
    .filter((field): field is string => field != null)
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/** One conversation quick jump can open. */
export interface ConversationCandidate {
  /** The conversation itself; `session` is always set. */
  target: ChatSelection & { session: string };
  /** The bot's display name (`botLabel`). */
  label: string;
  /** The conversation's own title, when the page has read one. */
  title: string | null;
  /** The newest message's opening words, as shown in the rail. */
  preview: string | null;
  last_message_at: string | null;
}

const PREVIEW_CHARS = 120;

function shortPreview(text: string | null | undefined, role?: BotView["preview_role"]) {
  if (!text) return null;
  if (isSilentPreview(text, role)) return SILENT_LABEL;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : flat;
}

/** Newest first; a conversation with no usable timestamp sorts after every dated one. */
function newestFirst(a: ConversationCandidate, b: ConversationCandidate): number {
  const at = a.last_message_at ? Date.parse(a.last_message_at) : Number.NaN;
  const bt = b.last_message_at ? Date.parse(b.last_message_at) : Number.NaN;
  if (Number.isNaN(at) || Number.isNaN(bt)) return Number(Number.isNaN(at)) - Number(Number.isNaN(bt));
  return bt - at;
}

/**
 * The conversations matching `query`, newest first.
 *
 * Candidates are the selected bot's loaded sessions plus, for every bot on the
 * roster, the conversation it last spoke in. A session both sources name is listed
 * once, from the session read, which carries a title. A match is on the box,
 * the bot's name or title, the conversation's title, or its preview.
 */
export function conversationCandidates({
  swarms,
  sessions,
  selection,
  query,
}: {
  swarms: readonly SwarmView[];
  sessions: readonly SessionView[];
  selection: ChatSelection | null;
  query: string;
}): ConversationCandidate[] {
  const bots = new Map(
    swarms.flatMap((swarm) => swarm.bots.map((bot) => [`${bot.instance}/${bot.name}`, bot] as const)),
  );
  const seen = new Set<string>();
  const matched: ConversationCandidate[] = [];
  // Matched on the full preview, not the shortened one a row shows.
  const consider = (candidate: ConversationCandidate, rawPreview: string | null | undefined) => {
    const key = `${candidate.target.instance}/${candidate.target.bot}/${candidate.target.session}`;
    if (seen.has(key)) return;
    seen.add(key);
    const bot = bots.get(`${candidate.target.instance}/${candidate.target.bot}`);
    if (
      matchesQuery(
        query,
        candidate.target.instance,
        candidate.target.bot,
        bot?.title,
        candidate.title,
        rawPreview,
      )
    )
      matched.push(candidate);
  };
  // `chat.sessions` answers for the selected bot. A read still in flight for
  // the previous bot is not this bot's list, so it is skipped, not relabelled.
  for (const session of sessions) {
    if (!selection || session.instance !== selection.instance || session.bot !== selection.bot)
      continue;
    const bot = bots.get(`${session.instance}/${session.bot}`);
    consider(
      {
        target: { instance: session.instance, bot: session.bot, session: session.id },
        label: botLabel(session.instance, session.bot, bot?.title),
        title: session.title,
        preview: shortPreview(session.preview),
        last_message_at: session.last_message_at ?? null,
      },
      session.preview,
    );
  }
  for (const bot of bots.values()) {
    if (!bot.last_message_session) continue;
    consider(
      {
        target: { instance: bot.instance, bot: bot.name, session: bot.last_message_session },
        label: botLabel(bot.instance, bot.name, bot.title),
        title: null,
        preview: shortPreview(bot.preview, bot.preview_role),
        last_message_at: bot.last_message_at ?? null,
      },
      bot.preview,
    );
  }
  // `sort` is stable, so equal or absent timestamps keep the order above.
  return matched.sort(newestFirst);
}
