/**
 * What opening (or "Mark read" on) a conversation clears. The client applies
 * it to the focused conversation (`setWatched`, and the return to the
 * foreground); the conversation screen's "Mark read" calls it directly.
 *
 * The Bot Chat clears the bot's roster unread (the roster counts the Bot
 * Chat's unread) and every unread inbox entry about the bot except those that
 * name one of its separate sessions (`separate`): those are the other
 * conversation's, read by opening it, as `onScreen` files an event of one
 * conversation unread while the other is on screen. An entry naming a session
 * the screen does not know as separate (the Bot Chat's own, an id it carried
 * before a compaction rotated it, or none) is the Bot Chat's. Until the bot's
 * session list is known (`separate` absent) the Bot Chat clears only entries
 * naming no session or its `resolved` id; the screen reads again once the
 * list lands. `onScreen` stays the narrower rule on purpose: it decides
 * whether an event alerts, and a false "on screen" swallows an alert, where
 * here the worse failure is an entry nothing ever clears. A separate
 * session (`?session=`) clears only the inbox entries that name it, by the id
 * it was opened with or the one it resolves to now (a compaction rotates it).
 *
 * So home's count for a bot — the larger of the roster's Bot Chat unread and
 * the inbox's unread entries about the bot, any session — stays up after the
 * Bot Chat is read while a separate session still has unread entries, and
 * clears when that session is read too (or by the home row's Mark read, which
 * clears the whole bot).
 *
 * Neither clears a needs-you mark that comes from a request still open in a
 * turn this phone follows (`RosterStore.setWaiting`): that is state, cleared by
 * answering the request, not by reading.
 */
import type { InboxEntry } from "../inbox/store.ts";

export interface ReadStores {
  roster: { markSeen(instance: string, bot: string): void };
  inbox: {
    getState(): { entries: readonly InboxEntry[] };
    markRead(ids: readonly string[]): void;
  };
}

export interface ReadTarget {
  instance: string;
  bot: string;
  /** The separate session on screen, by the id it was opened with; `null` for the Bot Chat. */
  session: string | null;
  /** The session id the screen resolves to now, once known. */
  resolved?: string | null;
  /** Bot Chat only: the ids of the bot's separate (non-canonical) sessions; absent until listed. */
  separate?: readonly string[];
}

export function markConversationRead(stores: ReadStores, target: ReadTarget): void {
  const ofBot = (e: InboxEntry) => !e.read_at && e.instance === target.instance && e.bot === target.bot;
  let mine: (e: InboxEntry) => boolean;
  if (target.session === null) {
    stores.roster.markSeen(target.instance, target.bot);
    const resolved = target.resolved ?? null;
    if (target.separate) {
      const separate = new Set(target.separate);
      if (resolved) separate.delete(resolved);
      mine = (e) => !separate.has(e.session);
    } else mine = (e) => !e.session || e.session === resolved;
  } else {
    const ids = new Set([target.session, target.resolved].filter((s): s is string => !!s));
    mine = (e) => ids.has(e.session);
  }
  stores.inbox.markRead(
    stores.inbox
      .getState()
      .entries.filter((e) => ofBot(e) && mine(e))
      .map((e) => e.id),
  );
}
