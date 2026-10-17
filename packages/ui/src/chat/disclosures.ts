/**
 * What the reader opened or closed in a transcript, kept beyond the row.
 *
 * A tool group or a step the reader opened is a `<details>` whose `open` is
 * their choice. Held in the component's own state, that choice died with the
 * component, and a virtualized transcript (`virtual/VirtualLog.tsx`) unmounts
 * a row once it is scrolled well out of view: scrolling back found the group
 * shut again. So the choice is also written here, in a store `Thread` provides
 * for the conversation it shows, and a remounted group starts from it.
 *
 * Only the component that toggled re-renders: the store is read once, when a
 * group mounts, and written on every toggle beside its own state. Two mounted
 * components never share a key — every key is scoped by its row
 * (`DisclosureRowContext`, provided by `TranscriptRow`) — so nothing else has
 * to hear about a change.
 *
 * A key must not move while its turn streams, or the choice written under the
 * old one is not found on the next mount. Blocks only append during a turn, so
 * a block's position in its row (`useRowPosition`) is such a key.
 *
 * Bounded twice: `Thread` makes a new store for each conversation it opens,
 * and one store forgets its oldest choices past `DISCLOSURE_LIMIT`.
 */
import { createContext, useContext, useState } from "react";

/** The most choices one conversation's store keeps. */
export const DISCLOSURE_LIMIT = 1000;

export interface Disclosures {
  get(key: string): boolean | undefined;
  set(key: string, open: boolean): void;
}

export function createDisclosures(limit = DISCLOSURE_LIMIT): Disclosures {
  const choices = new Map<string, boolean>();
  return {
    get: (key) => choices.get(key),
    set: (key, open) => {
      // Re-inserted so the newest choice is the last one forgotten.
      choices.delete(key);
      choices.set(key, open);
      if (choices.size > limit) {
        const oldest = choices.keys().next();
        if (!oldest.done) choices.delete(oldest.value);
      }
    },
  };
}

/** The store of the conversation being drawn; null outside a `Thread`. */
export const DisclosureContext = createContext<Disclosures | null>(null);

/** The transcript row being drawn: its key, and the blocks its message holds. */
export interface DisclosureRow {
  key: string;
  blocks: readonly unknown[];
}

/** The row being drawn (`TranscriptRow`); null outside one. */
export const DisclosureRowContext = createContext<DisclosureRow | null>(null);

/**
 * Where `block` sits among its row's blocks, or -1 outside a row or when it is
 * not one of them. Stable while the turn streams: its blocks only append.
 */
export function useRowPosition(block: unknown): number {
  const row = useContext(DisclosureRowContext);
  return row === null || block === undefined ? -1 : row.blocks.indexOf(block);
}

/**
 * The reader's choice for the disclosure `id` within the current row — null
 * while they made none — and the setter that records a new one. Outside a
 * store or a row, or with no `id`, it is plain component state, as before.
 */
export function useDisclosure(id: string | null): [boolean | null, (open: boolean) => void] {
  const store = useContext(DisclosureContext);
  const row = useContext(DisclosureRowContext);
  const key = store !== null && row !== null && id !== null ? `${row.key}:${id}` : null;
  const [choice, setChoice] = useState<boolean | null>(() =>
    key === null ? null : (store?.get(key) ?? null),
  );
  const set = (open: boolean) => {
    if (key !== null) store?.set(key, open);
    setChoice(open);
  };
  return [choice, set];
}
