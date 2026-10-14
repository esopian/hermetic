/**
 * What opening (or "Mark read" on) a conversation clears. The client applies
 * it to the focused conversation (`setWatched`, and the return to the
 * foreground); the conversation screen's "Mark read" calls it directly.
 *
 * The Bot Chat clears the bot: its roster unread and every unread inbox entry
 * about it. A separate session (`?session=`) clears only the inbox entries
 * that name that session: the roster counts unread per bot, not per session,
 * so clearing it there would wipe the Bot Chat's unread unseen.
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
    markThreadRead(instance: string, bot: string): void;
  };
}

export function markConversationRead(
  stores: ReadStores,
  target: { instance: string; bot: string; session: string | null },
): void {
  if (target.session === null) {
    stores.roster.markSeen(target.instance, target.bot);
    stores.inbox.markThreadRead(target.instance, target.bot);
    return;
  }
  stores.inbox.markRead(
    stores.inbox
      .getState()
      .entries.filter(
        (e) =>
          !e.read_at &&
          e.instance === target.instance &&
          e.bot === target.bot &&
          e.session === target.session,
      )
      .map((e) => e.id),
  );
}
