/**
 * What the notification centre and the full inbox drawer share: the snooze and
 * mute menus, the keyboard, the sectioned list, and the undo bar. Two surfaces
 * over one inbox, so the verbs, the keys and the words are the same in both.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { NotificationSourceView, NotificationView } from "../../api/index.ts";
import { isTopmostOverlay } from "../../lib/focus.ts";
import {
  inboxKeyAction,
  isOpenCondition,
  sectionRows,
  snoozePresets,
} from "../../logic/inbox-logic.ts";
import type { InboxCard, InboxKeyAction, InboxSection } from "../../logic/inbox-logic.ts";
import { groupRow } from "../../logic/notification-logic.ts";
import { useNotify } from "../../state/notify-state.tsx";
import { InboxMenu } from "./InboxMenu.tsx";
import type { MenuEntry } from "./InboxMenu.tsx";
import { NotificationRow } from "./NotificationRow.tsx";
import type { NotificationRowProps } from "./NotificationRow.tsx";

/** The source a mute names, in the operator's words. */
const SOURCE_WORD: Record<string, string> = {
  operation: "operations",
  agent: "health",
  chat: "chat",
  fleet: "advisories",
  budget: "budget",
};

interface OpenMenu {
  anchor: HTMLElement;
  title?: string;
  label?: string;
  items: readonly MenuEntry[];
}

/**
 * The snooze and mute menus, and any other the surface opens (`⋯`, the bulk
 * bar's snooze). One at a time; `node` is what the surface renders.
 */
export function useInboxMenus({ onOpenRules }: { onOpenRules: () => void }) {
  const notify = useNotify();
  const [menu, setMenu] = useState<OpenMenu | null>(null);

  const openSnooze = (anchor: HTMLElement, rows: readonly NotificationView[]) => {
    const now = Date.now();
    const one = rows.length === 1 ? rows[0] : undefined;
    const items: MenuEntry[] = snoozePresets(now).map((p) => ({
      label: p.label,
      hint: p.hint,
      run: () => void notify.act({ verb: "snooze", until: p.until }, rows),
    }));
    // "Until it changes" is a clear: a re-raise after the condition resolves is
    // already a new row (§4.9), so hiding this one gives exactly that.
    if (one && isOpenCondition(one))
      items.push("-", {
        label: "Until it changes",
        hint: "resolves or recurs",
        run: () => void notify.act({ verb: "clear" }, rows),
      });
    setMenu({ anchor, title: rows.length > 1 ? `Snooze ${rows.length}` : "Snooze until", items });
  };

  const openMute = (anchor: HTMLElement, row: NotificationView) => {
    const source = row.source as NotificationSourceView;
    const items: MenuEntry[] = [];
    if (row.agent) {
      const agent = row.agent;
      items.push({
        label: (
          <>
            Mute agent <b className="mono">{agent}</b>
          </>
        ),
        hint: "all sources",
        run: () => void notify.mute({ agent }, { undoable: true }),
      });
    }
    items.push(
      {
        label: `Mute all ${SOURCE_WORD[source] ?? source}`,
        hint: `source:${source}`,
        run: () => void notify.mute({ source }, { undoable: true }),
      },
      "-",
      { label: "Notification rules…", hint: "Settings", run: onOpenRules },
    );
    setMenu({ anchor, title: "Mute", items });
  };

  const node = menu ? (
    <InboxMenu
      anchor={menu.anchor}
      title={menu.title}
      label={menu.label}
      items={menu.items}
      onClose={() => setMenu(null)}
    />
  ) : null;

  return { openSnooze, openMute, openMenu: setMenu, node };
}

/** Is this keystroke landing in something the operator is typing into? */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el?.isContentEditable === true ||
    !!el?.closest?.('[contenteditable]:not([contenteditable="false"])')
  );
}

/**
 * The inbox keys, live only while `root` is the topmost overlay and never
 * inside a field. Captured at the window and stopped there, so a key the
 * inbox answers never also reaches the page's own shortcuts (`n`, `,`, the
 * chat roster's `j`/`k`) under it.
 */
export function useInboxKeys(
  root: RefObject<HTMLElement | null>,
  surface: "center" | "drawer",
  handle: (action: InboxKeyAction) => boolean,
): void {
  const handler = useRef(handle);
  handler.current = handle;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const el = root.current;
      // The trap is the dialog; `root` may be a child of it.
      const dialog = el?.closest<HTMLElement>('[role="dialog"]') ?? el;
      if (!dialog || !isTopmostOverlay(dialog)) return;
      if (isTyping(e.target)) return;
      const action = inboxKeyAction(e, surface);
      if (action === null) return;
      // `↵` on a real button is that button's own click, not "open the row".
      if (action === "open" && (e.target as HTMLElement | null)?.closest?.("button, a")) return;
      if (!handler.current(action)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [root, surface]);
}

/** Per-card wiring the surface supplies; the list supplies the rest. */
export type CardProps = (card: InboxCard<NotificationView>) => Partial<NotificationRowProps>;

/**
 * The list as sections, each header carrying its own `mark read · clear`
 * scoped to exactly that section's rows.
 */
export function InboxSections({
  sections,
  now,
  focus,
  cardProps,
}: {
  sections: readonly InboxSection<NotificationView>[];
  now: number;
  focus: string | null;
  cardProps: CardProps;
}) {
  const notify = useNotify();
  return (
    <>
      {sections.map((s) => {
        const rows = sectionRows(s);
        return (
          <div key={s.id} className="nt-sec-group">
            <div className={`nt-sec${s.pin ? " pin" : ""}`}>
              {s.label} <span className="c">{rows.length}</span>
              <span className="sa">
                <button type="button" onClick={() => void notify.act({ verb: "read" }, rows)}>
                  mark read
                </button>
                <button type="button" onClick={() => void notify.act({ verb: "clear" }, rows)}>
                  clear
                </button>
              </span>
            </div>
            {s.cards.map((card) => (
              <NotificationRow
                key={card.key}
                cardKey={card.key}
                n={groupRow(card)}
                count={card.count}
                kids={card.count > 1 ? card.rows : undefined}
                kind={card.kind}
                now={now}
                focused={focus === card.key}
                {...cardProps(card)}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

/**
 * The 6-second undo bar. `popover` sits inside the centre; `page` is fixed
 * bottom-centre, over whatever else is open.
 */
export function UndoBarView({ placement }: { placement: "popover" | "page" }) {
  const notify = useNotify();
  const bar = notify.undo;
  if (!bar) return null;
  return (
    <div className={`nt-undo${placement === "page" ? " page" : ""}`} role="status" key={bar.key}>
      <span className="m">
        {bar.label}
        {bar.sub ? <small>{bar.sub}</small> : null}
      </span>
      <button type="button" onClick={() => void notify.undoLast()}>
        Undo <kbd>z</kbd>
      </button>
      <div className="life">
        <i />
      </div>
    </div>
  );
}

/** A kicker-sized empty state: the square, the words, and an optional way on. */
export function InboxZero({ big, children }: { big: string; children?: ReactNode }) {
  return (
    <div className="nt-zero">
      <div className="big">
        <i />
        {big}
      </div>
      {children}
    </div>
  );
}

/** The drawn card for `key`, matched on the attribute rather than through a selector it would have to escape. */
export function cardElement(root: HTMLElement | null, key: string): HTMLElement | null {
  if (!root) return null;
  for (const el of root.querySelectorAll<HTMLElement>("[data-card]"))
    if (el.dataset.card === key) return el;
  return null;
}

/** Opens Settings → Notifications from inside either surface. */
export function openRulesVia(
  onOpenSettings: ((section: "notifications") => void) | undefined,
  close: () => void,
  hash: string,
): () => void {
  return () => {
    close();
    if (onOpenSettings) onOpenSettings("notifications");
    else window.location.hash = hash;
  };
}
