/**
 * The keyboard shortcuts, and the one rule that decides whether a keystroke may
 * fire — pure, so both the handler and the sheet that documents it read from the
 * same place and can be tested without a DOM.
 *
 * The rule exists because `/` did not have one. It focused the fleet's filter
 * input *behind* an open `aria-modal` drawer: the focus trap then had focus
 * outside the dialog it claimed to have covered, and the operator was left
 * typing into a box they could not see, with Tab wrapping them back into a
 * drawer they had not chosen to be in.
 */

export interface Shortcut {
  keys: string;
  what: string;
}

/** In the order they are worth learning, not in key order. */
export const SHORTCUTS: readonly Shortcut[] = [
  { keys: "⌘/Ctrl K", what: "Quick jump" },
  { keys: "⌘/Ctrl ⇧ K", what: "Toggle chat dock" },
  { keys: "t", what: "Chat with the focused or hovered agent" },
  { keys: "c", what: "Choose a conversation in Chat" },
  { keys: "j / k", what: "Next / previous conversation in Chat" },
  { keys: "n", what: "New agent" },
  // §4.9: `n` is already the create drawer, so the bell gets `i` for inbox
  // instead, and the collision is recorded rather than silently resolved.
  { keys: "i", what: "Notifications" },
  // The full inbox drawer; inside the centre and the drawer, `j k ↵ e r s m z`
  // work on the rows and `?`'s sheet is the only global key left.
  { keys: "⇧ I", what: "Full inbox" },
  { keys: "/", what: "Filter the fleet" },
  { keys: ",", what: "Settings" },
  { keys: "?", what: "This list" },
  { keys: "Esc", what: "Close the topmost drawer, popover or view" },
];

/**
 * Everything the app shell can draw over the fleet. `settingsOpen` is a
 * full-page *view* rather than an overlay — it replaces the fleet instead of
 * covering it, nothing traps focus, and Escape falls through to it last — so it
 * is carried here but does not count as one. The fleet's volumes lens is not
 * here at all: it is the fleet page itself, and every shortcut works on it.
 */
export interface OverlayState {
  shortcutsOpen: boolean;
  /** The notification centre — a popover off the header bell, like the sheet. */
  notifyOpen: boolean;
  /** The full inbox drawer (`⇧I`). Optional so older callers read as closed. */
  inboxOpen?: boolean;
  popoverOpen: boolean;
  teardownOpen: boolean;
  createOpen: boolean;
  selected: string | null;
  settingsOpen: boolean;
  foundationTeardownOpen: boolean;
  foundationUpdateOpen: boolean;
}

/** Is something modal on screen — something that owns focus and covers the page? */
export function overlayIsOpen(o: OverlayState): boolean {
  return (
    o.shortcutsOpen ||
    o.notifyOpen ||
    o.inboxOpen === true ||
    o.popoverOpen ||
    o.createOpen ||
    o.selected !== null ||
    o.teardownOpen ||
    o.foundationTeardownOpen ||
    o.foundationUpdateOpen
  );
}

/**
 * Whether a non-Escape shortcut may fire. Escape is not routed through here: it
 * is the one key whose entire job is to close whatever is open, and `App.tsx`
 * handles views only after the shared focus stack has consumed overlay Escape.
 *
 * `?` is the exception that proves the rule. It is deliberately allowed while an
 * overlay is up, because it is exactly what an operator reaches for *when* they
 * are stuck in one — and it opens a popover, which is itself a focus trap, so it
 * never strands focus behind anything.
 */
export function shortcutAllowed(key: string, o: OverlayState): boolean {
  if (key === "?") return true;
  if (overlayIsOpen(o)) return false;
  // Settings is a view with no fleet under it, so there is nothing to create
  // onto; `,` is idempotent there and stays allowed.
  if (key === "n") return !o.settingsOpen;
  return true;
}
