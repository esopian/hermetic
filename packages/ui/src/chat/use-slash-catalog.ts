/**
 * The bot's slash-command catalog, for the composer's picker.
 *
 * Read lazily — on the first `/` typed into a conversation, not on every
 * conversation opened — and then reused for the life of the window
 * (`fetchCommands`). A failed read leaves the list empty: the picker shows
 * nothing and the composer works as it does without one. Nothing is retried
 * while the picker stays open; the next time it opens, the read is tried again.
 */
import { useEffect, useState } from "react";
import { fetchCommands } from "../api/chat.ts";
import type { ChatCommandView } from "../api/types.ts";

export interface SlashCatalogTarget {
  fleet: string;
  instance: string;
  bot: string;
  session?: string | null;
}

const NONE: readonly ChatCommandView[] = [];

export function useSlashCatalog(
  where: SlashCatalogTarget | null,
  wanted: boolean,
): readonly ChatCommandView[] {
  const key = where ? `${where.fleet} ${where.instance}/${where.bot} ${where.session ?? ""}` : null;
  const [held, setHeld] = useState<{ key: string; commands: readonly ChatCommandView[] } | null>(null);
  const loaded = held !== null && held.key === key;
  useEffect(() => {
    if (!wanted || !where || key === null || loaded) return;
    let live = true;
    fetchCommands(where).then(
      (result) => {
        if (live) setHeld({ key, commands: result.commands });
      },
      () => {
        // Nothing to show, and nothing to say: the composer is still a composer.
      },
    );
    return () => {
      live = false;
    };
    // `where` is read through `key`, which names every field of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, key, loaded]);
  return loaded ? held.commands : NONE;
}
