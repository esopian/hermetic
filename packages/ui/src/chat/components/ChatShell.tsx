/** Persistent entry chrome shares one store across full view, drawer, and floating dock. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useChat } from "../chat-state.tsx";
import type { ChatSelection } from "../chat-state.tsx";
import { ChatEntryContext } from "../chat-entry-state.tsx";
import { chatHash, isChatHash, parseChatHash } from "../chat-routing.ts";
import { useListeningIfAvailable } from "../../state/listening-state.tsx";
import { useFleetIfAvailable } from "../../state/state.tsx";
import { composerState, threadState } from "../chat-logic.ts";
import { botLabel } from "../chat-presentation.ts";
import { hasOpenOverlay } from "../../lib/focus.ts";
import { ChatView } from "./ChatView.tsx";
import { QuickJump } from "./QuickJump.tsx";

export function ChatShell({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const chat = useChat();
  const instances = useListeningIfAvailable()?.instances;
  const fleet = useFleetIfAvailable();
  const [navigation, setNavigation] = useState(0);
  const [quick, setQuick] = useState(false);
  const [dock, setDock] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [tabs, setTabs] = useState<ChatSelection[]>([]);
  const [drawerTarget, setDrawerTarget] = useState<ChatSelection | null>(null);
  const [hash, setHash] = useState(() => window.location.hash);
  const pendingSend = useRef<{ target: ChatSelection; text: string } | null>(null);
  const focusedMessageHash = useRef<string | null>(null);
  const currentSelection = useRef(chat.selection);
  currentSelection.current = chat.selection;
  const hovered = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (instances === undefined) return;
    setTabs((previous) => previous.filter((target) => instances.includes(target.instance)));
    setDrawerTarget((target) => (target && !instances.includes(target.instance) ? null : target));
    if (pendingSend.current && !instances.includes(pendingSend.current.target.instance))
      pendingSend.current = null;
  }, [instances]);
  const closeDrawer = useCallback(() => setDrawerTarget(null), []);
  const quickJump = useCallback(() => {
    chat.activate();
    setQuick(true);
  }, [chat.activate]);
  const open = useCallback(
    (
      target: ChatSelection,
      frame: "dock" | "full" | "drawer",
      draft?: string,
      message?: string | null,
    ) => {
      if (!chat.select(target.instance, target.bot, target.session)) return false;
      setNavigation((n) => n + 1);
      pendingSend.current = draft === undefined ? null : { target, text: draft };
      if (draft !== undefined) chat.stageDraft(target, draft);
      setTabs((prev) =>
        prev.some((t) => chatHash(t) === chatHash(target)) ? prev : [...prev, target],
      );
      if (frame === "drawer") {
        setDrawerTarget(target);
      } else {
        setDrawerTarget(null);
        setDock(true);
        setCollapsed(false);
        if (frame === "full") window.location.hash = chatHash(target, message);
        else if (isChatHash(window.location.hash)) window.location.hash = "";
      }
      return true;
    },
    [chat.select, chat.stageDraft],
  );

  useEffect(() => {
    const route = () => {
      if (!enabled) return;
      const next = window.location.hash;
      setHash(next);
      if (isChatHash(next)) chat.activate();
      const target = parseChatHash(next);
      if (target && !chat.select(target.instance, target.bot, target.session)) {
        // An unwatched deep link cannot attach. Keep the existing conversation
        // visible until the operator explicitly listens on the fleet screen.
        if (currentSelection.current) window.location.hash = chatHash(currentSelection.current);
      }
    };
    route();
    window.addEventListener("hashchange", route);
    return () => window.removeEventListener("hashchange", route);
  }, [chat.activate, chat.select, enabled]);

  useEffect(() => {
    const pending = pendingSend.current;
    if (!pending || !chat.selection) return;
    if (chatHash(pending.target) !== chatHash(chat.selection)) {
      pendingSend.current = null;
      return;
    }
    if (chat.destination.state === "pending" || chat.historyLoading) return;
    pendingSend.current = null;
    const swarm = chat.swarms.find((s) => s.instance === pending.target.instance);
    const state = threadState({
      status: fleet?.byName.get(pending.target.instance)?.display_status ?? null,
      reachable: swarm?.reachable ?? true,
      reconnecting: chat.reconnecting,
      empty: chat.messages.length === 0,
      fleetUnreachable: chat.offTailnet,
    });
    if (!composerState(state, chat.destination).enabled) return;
    // Only affirmative local-origin evidence permits quick send. Every foreign
    // or unresolved destination keeps the draft beside the undismissible band.
    if (
      chat.destination.state === "known" &&
      chat.destination.origin === "portal" &&
      !chat.sending &&
      !chat.historyError
    ) {
      chat.setDraft("");
      chat.send(pending.text);
    }
  }, [chat, fleet, navigation]);

  useEffect(() => {
    const target = parseChatHash(hash);
    if (!target?.message) {
      focusedMessageHash.current = null;
      return;
    }
    if (focusedMessageHash.current === hash || chat.historyLoading) return;
    // A turn is one article built from several source rows (`chat-turns.ts`),
    // and a link names whichever row the box wrote. The article answers to its
    // own id and to every id folded into it.
    const wanted = target.message;
    const node = Array.from(document.querySelectorAll<HTMLElement>("[data-chat-message]")).find(
      (el) =>
        el.dataset.chatMessage === wanted || (el.dataset.chatIds ?? "").split(" ").includes(wanted),
    );
    if (node) {
      // A message link moves focus once, after its transcript arrives. New
      // messages and history refreshes must not interrupt composer typing.
      focusedMessageHash.current = hash;
      node.scrollIntoView?.({ block: "center" });
      node.focus({ preventScroll: true });
    }
  }, [hash, chat.messages, chat.historyLoading]);

  useEffect(() => {
    const pointer = (e: PointerEvent) => {
      hovered.current =
        (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>("[data-chat-agent]")
          ?.dataset.chatAgent ?? null;
    };
    const key = (e: KeyboardEvent) => {
      if (!enabled || e.defaultPrevented || e.isComposing || e.repeat || e.altKey) return;
      const typing = (e.target instanceof Element ? e.target : null)?.closest(
        "input, textarea, select, [contenteditable=true]",
      );
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (quick || (e.shiftKey && hasOpenOverlay())) return;
        e.preventDefault();
        if (e.shiftKey) {
          chat.activate();
          if (chat.selection) {
            setTabs((prev) =>
              prev.some((t) => chatHash(t) === chatHash(chat.selection!))
                ? prev
                : [...prev, chat.selection!],
            );
            // location changes before the queued hashchange updates React state.
            // Capture it now so an immediate full-to-dock shortcut expands reliably.
            const fromFull = isChatHash(window.location.hash);
            setDock(true);
            setCollapsed((v) => (dock && !fromFull ? !v : false));
            if (fromFull) window.location.hash = "";
          } else quickJump();
        } else quickJump();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.shiftKey || hasOpenOverlay()) return;
      // Escape stops a running turn and does nothing else.
      //
      // It used to collapse the dock when no turn was running, which is how
      // Escape came to close the conversation the operator was reading — the
      // composer advertises `Esc stop`, and a key that stops a turn when there
      // is one and hides the pane when there is not is two keys wearing one
      // label. Overlays are already handled above (`hasOpenOverlay`) and by
      // `focus.ts`'s own document listener, so with no turn and no overlay this
      // is deliberately a no-op; the dock's own — button collapses it.
      if (e.key === "Escape") {
        const onChat = isChatHash(hash) || (dock && !collapsed);
        if (!onChat) return;
        // A visible conversation owns Escape. `preventDefault` is what stops
        // `App`'s own handler, which closes the topmost *view* and so took the
        // operator out of chat and back to Fleet on a key the composer tells
        // them means "stop".
        e.preventDefault();
        if (chat.sending) void chat.abort();
        return;
      }
      if (typing) return;
      if (e.key === "t") {
        const instance =
          (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-chat-agent]")
            ?.dataset.chatAgent ?? hovered.current;
        if (instance) {
          e.preventDefault();
          open({ instance, bot: "default", session: null }, "drawer");
        }
      }
      if (isChatHash(hash) && e.key === "c") {
        e.preventDefault();
        quickJump();
      }
      if (isChatHash(hash) && (e.key === "j" || e.key === "k")) {
        const rows = Array.from(document.querySelectorAll<HTMLButtonElement>(".ch-rail .ch-conv"));
        const index = rows.findIndex((row) => row.getAttribute("aria-current") === "true");
        const next = rows[(index + (e.key === "j" ? 1 : -1) + rows.length) % rows.length];
        if (next) {
          e.preventDefault();
          next.click();
          next.focus();
        }
      }
    };
    // Capture lets Escape stop a visible turn before the shell's view fallback.
    // Overlay ownership is checked first; drawers and quick jump own their keys.
    window.addEventListener("keydown", key, true);
    document.addEventListener("pointerover", pointer);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerover", pointer);
    };
  }, [chat, dock, collapsed, hash, open, quickJump, quick, enabled]);

  return (
    <ChatEntryContext.Provider value={{ navigation, drawerTarget, closeDrawer, open, quickJump }}>
      {children}
      {dock && !isChatHash(hash) && !drawerTarget ? (
        <aside className={`ch-dock${collapsed ? " collapsed" : ""}`} aria-label="Chat dock">
          <div className="ch-dock-tabs" role="tablist" aria-label="Dock conversations">
            {tabs.map((target) => (
              <button
                type="button"
                role="tab"
                className="ch-dock-tab"
                key={chatHash(target)}
                aria-selected={chat.selection !== null && chatHash(chat.selection) === chatHash(target)}
                onClick={() => open(target, "dock")}
              >
                {botLabel(
                  target.instance,
                  target.bot,
                  chat.swarms
                    .find((swarm) => swarm.instance === target.instance)
                    ?.bots.find((bot) => bot.name === target.bot)?.title,
                )}
              </button>
            ))}
            <button
              type="button"
              className="ch-dock-tab"
              onClick={quickJump}
              aria-label="Add conversation"
            >
              +
            </button>
            <button
              type="button"
              className="ch-dock-tab"
              onClick={() => chat.selection && open(chat.selection, "full")}
              aria-label="Expand chat"
            >
              ⤢
            </button>
            <button
              type="button"
              className="ch-dock-tab"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? "Open chat dock" : "Collapse chat dock"}
            >
              {collapsed ? "↑" : "—"}
            </button>
          </div>
          {!collapsed ? <ChatView withContext={false} withRail={false} /> : null}
        </aside>
      ) : null}
      {chat.selectionError && !quick ? (
        <div className="ch-entry-error" role="alert">
          {chat.selectionError}
        </div>
      ) : null}
      {quick ? <QuickJump onClose={() => setQuick(false)} /> : null}
    </ChatEntryContext.Provider>
  );
}
