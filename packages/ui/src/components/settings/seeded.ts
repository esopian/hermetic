/**
 * A form seeded from what the fleet says, re-seeded only when *that* changes.
 *
 * The shell holds one settings document and every section's save replaces it,
 * so a `key` on `settings.version` would remount every form on the page each
 * time any one of them saved — throwing away half-typed edits in the rows
 * nobody asked to write. Keying on the section's own loaded values instead
 * means a save (or somebody else's, arriving on a Reload) re-seeds exactly the
 * fields it actually moved, and leaves the rest of the page alone.
 *
 * The comparison is the serialized loaded record because these forms are flat
 * records of primitives — the values, not their identity, are what "changed"
 * means here.
 *
 * The draft may live outside the form (`holder`): Fleet defaults keeps its
 * draft in the shell, so leaving the section for another and coming back finds
 * the staged edits still there — and the rail can mark the section as holding
 * unsaved changes while it is not the one on screen.
 */
import { useState } from "react";

/** A draft, stamped with the loaded values it was typed over. */
export interface SeededDraft<T> {
  seed: string;
  form: T;
}

/** Somewhere a draft can be kept that outlives the form: a `useState` pair. */
export type DraftHolder<T> = readonly [SeededDraft<T> | null, (next: SeededDraft<T> | null) => void];

export interface SeededForm<T> {
  form: T;
  set: (next: T) => void;
  /** Back to the fleet's values — the save bar's Discard. */
  reset: () => void;
}

/** The draft still describing `loaded`, or `null` when the fleet moved under it. */
export function liveDraft<T>(loaded: T, draft: SeededDraft<T> | null): T | null {
  return draft !== null && draft.seed === JSON.stringify(loaded) ? draft.form : null;
}

export function useSeededForm<T extends object>(loaded: T, holder?: DraftHolder<T>): SeededForm<T> {
  const own = useState<SeededDraft<T> | null>(null);
  const [draft, setDraft] = holder ?? own;
  const seed = JSON.stringify(loaded);
  // Derived rather than re-seeded into state: a draft stamped with other loaded
  // values is simply not the form any more. Nothing is written while rendering,
  // which matters once the draft is a parent component's state.
  return {
    form: liveDraft(loaded, draft) ?? loaded,
    set: (next: T) => setDraft({ seed, form: next }),
    reset: () => setDraft(null),
  };
}
