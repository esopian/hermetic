/**
 * The keyboard shortcuts, listed.
 *
 * The dashboard has had five of them since the first build and no way at all to
 * find out: an operator who never pressed `n` by accident never learned it
 * existed. `?` opens this, and the footer says so — the two conventions almost
 * every keyboard-driven app shares, so neither has to be taught.
 *
 * The table itself lives in `src/shortcuts.ts` beside `shortcutAllowed`, the
 * rule `App.tsx`'s handler gates on, so the sheet and the handler read from one
 * place. `test/shortcuts.test.ts` pins both against the handler's own key
 * literals, so a shortcut added to one and not the other is a failing test
 * rather than a stale sheet.
 */
import type { RefObject } from "react";
import { SHORTCUTS } from "../nav/shortcuts.ts";
import { Popover } from "./Popover.tsx";

export { SHORTCUTS } from "../nav/shortcuts.ts";
export type { Shortcut } from "../nav/shortcuts.ts";

export function ShortcutsPopover({
  anchor,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      maxWidth={380}
      label="Keyboard shortcuts"
      style={{ zIndex: 220 }}
    >
      <div className="popover-head">Keyboard</div>
      <div className="shortcut-list">
        {SHORTCUTS.map((s) => (
          <div className="shortcut-row" key={s.keys}>
            <kbd className="shortcut-key">{s.keys}</kbd>
            <span className="shortcut-what">{s.what}</span>
          </div>
        ))}
      </div>
      <div className="popover-foot">
        <span className="hint">
          Nothing here fires while you are typing in a field — except Esc, which always closes the
          topmost thing.
        </span>
      </div>
    </Popover>
  );
}
