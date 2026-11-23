/**
 * The Bot Chats a v0.23.1 gateway moved aside: to deliver into a Bot Chat it
 * cannot own, it renames the row holding the title `Bot Chat (<source> <id>)`,
 * unhides it, and mints its own `local-` Bot Chat (`_displace_bot_chat`,
 * `gateway/session_bot.py:327-380`). Each such row is the canonical
 * conversation's earlier history (`render/hermes-canonical.ts`).
 *
 * Found by walking the dashboard's session list to its end
 * (`GET /api/sessions`, `hermes_cli/web_routers/sessions.py:182-240`, paged by
 * `offset`), so no number of newer sessions hides one. `session.list` cannot:
 * its window is the 200 most recently active rows, and every routine run opens
 * a session of its own (`cron/scheduler.py:2581`), which is also why routines
 * are left out of the walk. Each title found is then read exactly, which
 * upstream answers with no window (`tui_gateway/methods_session.py:509-533`);
 * that read drops a row archived or deleted since and names its compression tip.
 *
 * The walk is remembered per process under the current Bot Chat's id: the
 * gateway moves aside only the row holding the title, so while that id stands
 * no new row can appear, and a new Bot Chat is a new id, which walks again. A
 * row archived or deleted since simply stops answering its title.
 */
import {
  CHAT_ERROR_CODES,
  chatError,
  type BoxAddress,
  type HermesChatOptions,
} from "./hermes-chat-types.ts";
import { num, rec, records, str } from "./hermes-chat-wire.ts";

/** One moved-aside Bot Chat, as its exact-title lookup returned it. */
export interface MovedBotChat {
  root: string;
  /** Its compression tip: what a turn or a resume addresses. */
  tip: string;
  /** The `session.list` summary row, the shape the session list maps. */
  row: Record<string, unknown>;
}

export interface MovedBotChatsDeps {
  /** A dashboard GET (`peer.botModeRest`). */
  get(box: BoxAddress, path: string, opts: HermesChatOptions): Promise<unknown>;
}

export type MovedBotChats = ReturnType<typeof createMovedBotChats>;

/** The dashboard's own cap on `limit` (`le=100`). */
const PAGE = 100;
/**
 * Pages the walk reads before it refuses: 20,000 conversations, far past any
 * box, so reaching it means the list never ends rather than a big box.
 */
const WALK_PAGES = 200;
/** How long a failed walk is answered from memory, so a poll does not re-walk a failing box every tick. */
const RETRY_MS = 60_000;
/** Sessions no human opened, which outnumber everything else on a box running routines. */
const NOT_CONVERSATIONS = "cron,kanban,tool,oneshot";

/**
 * The root id of a Bot Chat upstream moved aside, or null. The id inside the
 * title must be the row's own (or its lineage root's), so a user thread merely
 * titled `Bot Chat (…)` stays a thread.
 */
export function displacedRoot(row: Record<string, unknown>): string | null {
  const id = /^Bot Chat \(\S+ (\S+)\)$/.exec(str(row.root_title) ?? str(row.title) ?? "")?.[1];
  if (!id) return null;
  const own = [row._lineage_root_id, row.id, row.stored_session_id, row.session_id].map(str);
  return own.includes(id) ? id : null;
}

export function createMovedBotChats(deps: MovedBotChatsDeps) {
  /**
   * Per box and bot: the moved-aside titles found under the current Bot Chat's
   * id ("" for none), or the walk's failure and when it may be tried again.
   */
  const walked = new Map<
    string,
    { current: string; titles: readonly string[]; failed?: { error: unknown; until: number } }
  >();

  /**
   * The Bot Chats moved aside before `current`, oldest first. `request` is one
   * `session.list` on the caller's socket. A `current` of "" (the session list,
   * which may not see the holder) reuses whatever walk is remembered. A failed
   * walk throws again, without re-walking, for `RETRY_MS`.
   */
  async function moved(
    request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    box: BoxAddress,
    bot: string,
    current: string,
    opts: HermesChatOptions = {},
  ): Promise<MovedBotChat[]> {
    const key = JSON.stringify([box.baseUrl, bot]);
    let known = walked.get(key);
    if (
      !known ||
      (current !== "" && known.current !== current) ||
      (known.failed && known.failed.until <= Date.now())
    ) {
      try {
        known = { current, titles: await walk(box, bot, opts) };
      } catch (error) {
        // An abort says nothing about the box, so it is not remembered.
        if (!opts.signal?.aborted)
          walked.set(key, { current, titles: [], failed: { error, until: Date.now() + RETRY_MS } });
        throw error;
      }
      walked.set(key, known);
    }
    if (known.failed) throw known.failed.error;
    const found: MovedBotChat[] = [];
    for (const title of known.titles) {
      const listed = rec(
        await request("session.list", { profile: bot, title, include_hidden: true, limit: 100 }),
      );
      for (const row of records(listed?.sessions)) {
        const root = str(row.title) === title ? displacedRoot(row) : null;
        if (root) found.push({ root, tip: str(row.resolved_id) ?? root, row });
      }
    }
    return found.sort(
      (a, b) =>
        (num(a.row.started_at) ?? 0) - (num(b.row.started_at) ?? 0) ||
        (a.root < b.root ? -1 : a.root > b.root ? 1 : 0),
    );
  }

  async function walk(box: BoxAddress, bot: string, opts: HermesChatOptions): Promise<string[]> {
    const titles = new Set<string>();
    const seen = new Set<string>();
    for (let offset = 0; ; offset += PAGE) {
      // Every page so far added a session nobody had seen, so only a box that never runs out stops here.
      if (offset === PAGE * WALK_PAGES)
        throw chatError(
          CHAT_ERROR_CODES.PROTOCOL,
          `${box.instance}: session list ran past ${PAGE * WALK_PAGES} sessions looking for moved-aside Bot Chats`,
        );
      const query = new URLSearchParams({
        profile: bot,
        limit: String(PAGE),
        offset: String(offset),
        exclude_sources: NOT_CONVERSATIONS,
      });
      const rows = records(rec(await deps.get(box, `/api/sessions?${query}`, opts))?.sessions);
      const before = seen.size;
      for (const row of rows) {
        seen.add(str(row.id) ?? "");
        const title = str(row.title);
        if (title && displacedRoot(row)) titles.add(title);
      }
      // A short page is the last; a page with nothing new means the box ignored the offset.
      if (rows.length < PAGE || seen.size === before) return [...titles];
    }
  }

  return { moved };
}
