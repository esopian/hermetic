/** Persistent entry chrome shares one store across full view, drawer, and floating dock. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChatTargetScope, useChat } from "../chat-state.tsx";
import type { ChatSelection } from "../chat-state.tsx";
import { ChatEntryContext } from "../chat-entry-state.tsx";
import { chatHash, isChatHash, parseChatHash } from "../chat-routing.ts";
import { FLEET_HASH } from "../../nav/fleet-nav.ts";
import { useListeningIfAvailable } from "../../state/listening-state.tsx";
import { useFleetIfAvailable } from "../../state/state.tsx";
import { useNotifyIfAvailable, useUnreadChatByConversation } from "../../state/notify-state.tsx";
import { composerState, threadState } from "../chat-logic.ts";
import { railUnread } from "../chat-logic.ts";
import { botLabel } from "../chat-presentation.ts";
import { activityFor } from "../chat-activity.ts";
import type { TurnActivity } from "../chat-activity.ts";
import {
  closeChatTab,
  closeDockPanel,
  openChatInNewPanel,
  openChatInPanel,
  sameChat,
} from "../chat-dock-layout.ts";
import type { DockPanel } from "../chat-dock-layout.ts";
import { hasOpenOverlay, keyboardOwned, ownsEscape } from "../../lib/focus.ts";
import { ChatView } from "./ChatView.tsx";
import { ChatDock } from "./ChatDock.tsx";
import type { DockPicker } from "./ChatDock.tsx";
import { Face } from "./Face.tsx";
import { QuickJump } from "./QuickJump.tsx";
import { InspectorShortcut } from "./inspector/InspectEntry.tsx";

export function ChatShell({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const chat = useChat();
  const instances = useListeningIfAvailable()?.instances;
  const fleet = useFleetIfAvailable();
  const notify = useNotifyIfAvailable();
  const inbox = useUnreadChatByConversation();
  const [navigation, setNavigation] = useState(0);
  const [quick, setQuick] = useState(false);
  const [dock, setDock] = useState(false);
  const [panels, setPanels] = useState<DockPanel[]>([]);
  const [picker, setPicker] = useState<DockPicker | null>(null);
  const nextPanelId = useRef(1);
  const activePanelId = useRef<number | null>(null);
  const [dismissedRailKey, setDismissedRailKey] = useState("");
  const [drawerTarget, setDrawerTarget] = useState<ChatSelection | null>(null);
  // A cold start on no hash reads `#chat` here only because `NavProvider` is a
  // child: its landing redirect (`redirectLandingHash`) runs before this
  // shell's effects read the hash. Keep that order if the tree moves.
  const [hash, setHash] = useState(() => window.location.hash);
  const pendingSend = useRef<{ target: ChatSelection; text: string } | null>(null);
  const focusedMessageHash = useRef<string | null>(null);
  const currentSelection = useRef(chat.selection);
  currentSelection.current = chat.selection;
  const hovered = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (instances === undefined) return;
    setPanels((previous) =>
      previous
        .map((panel) => {
          const tabs = panel.tabs.filter((target) => instances.includes(target.instance));
          return {
            ...panel,
            tabs,
            selected: tabs.some((tab) => sameChat(tab, panel.selected))
              ? panel.selected
              : (tabs[0] ?? panel.selected),
          };
        })
        .filter((panel) => panel.tabs.length > 0),
    );
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
      setPanels((prev) => {
        if (prev.length === 0) {
          const id = nextPanelId.current++;
          activePanelId.current = id;
          return [{ id, tabs: [target], selected: target }];
        }
        const owner = prev.find((panel) => panel.tabs.some((tab) => sameChat(tab, target)));
        activePanelId.current = owner?.id ?? prev[0]!.id;
        return openChatInPanel(prev, activePanelId.current, target);
      });
      if (frame === "drawer") {
        setDrawerTarget(target);
      } else {
        setDrawerTarget(null);
        setDock(true);
        if (frame === "full") window.location.hash = chatHash(target, message);
        else if (isChatHash(window.location.hash)) window.location.hash = FLEET_HASH;
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
      // The terminal's screen owns the keyboard while focused: Ctrl-K is
      // readline's kill-line there, not quick jump (`keyboardOwned`).
      if (keyboardOwned()) return;
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
            setPanels((prev) =>
              prev.length
                ? prev
                : [{ id: nextPanelId.current++, tabs: [chat.selection!], selected: chat.selection! }],
            );
            // location changes before the queued hashchange updates React state.
            // Capture it now so an immediate full-to-dock shortcut expands reliably.
            const fromFull = isChatHash(window.location.hash);
            setDock((v) => (dock && !fromFull ? !v : true));
            if (fromFull) window.location.hash = FLEET_HASH;
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
        const onChat = isChatHash(hash) || dock;
        // An element that handles Escape itself keeps it (`ownsEscape`).
        if (!onChat || ownsEscape(e.target)) return;
        // A visible conversation owns Escape. `preventDefault` is what stops
        // `App`'s own handler, which closes the topmost *view* and so took the
        // operator out of chat and back to Fleet on a key the composer tells
        // them means "stop".
        e.preventDefault();
        const paneId = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>(
          "[data-chat-panel-id]",
        )?.dataset.chatPanelId;
        const pane = panels.find((panel) => panel.id === Number(paneId));
        if (pane) {
          activePanelId.current = pane.id;
          void chat.stopTarget(pane.selected);
        } else if (chat.sending) void chat.abort();
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
  }, [chat, dock, panels, hash, open, quickJump, quick, enabled]);

  const activityItems = new Map<
    string,
    { target: ChatSelection; unread: number; activity: TurnActivity }
  >();
  const itemFor = (instance: string, bot: string) => {
    const key = `${instance}/${bot}`;
    let item = activityItems.get(key);
    if (!item) {
      item = { target: { instance, bot, session: null }, unread: 0, activity: "idle" };
      activityItems.set(key, item);
    }
    return item;
  };
  for (const swarm of chat.swarms) {
    for (const bot of swarm.bots) {
      const item = itemFor(swarm.instance, bot.name);
      item.unread = railUnread(bot, inbox.get(`${swarm.instance}/${bot.name}`) ?? 0);
    }
  }
  for (const [key, count] of inbox) {
    const slash = key.indexOf("/");
    if (slash < 0) continue;
    const item = itemFor(key.slice(0, slash), key.slice(slash + 1));
    item.unread = Math.max(item.unread, count);
  }
  for (const activity of chat.turnActivities) {
    const item = itemFor(activity.instance, activity.bot);
    item.activity = activityFor(chat.turnActivities, activity.instance, activity.bot);
    if (activity.activity !== "idle")
      item.target = {
        instance: activity.instance,
        bot: activity.bot,
        session: activity.session,
      };
  }
  const attention = [...activityItems.values()].filter(
    (item) => item.unread > 0 || item.activity !== "idle",
  );
  const unread = attention.reduce((sum, item) => sum + item.unread, 0);
  const active = attention.filter((item) => item.activity !== "idle").length;
  const notificationIds =
    notify?.items
      .filter((item) => item.kind.startsWith("chat.") && !item.read_at && !item.cleared_at)
      .map((item) => item.id)
      .join(",") ?? "";
  const railKey =
    attention.length > 0
      ? attention
          .map((item) => `${item.target.instance}/${item.target.bot}:${item.unread}:${item.activity}`)
          .join("|") + notificationIds
      : "";
  const railVisible =
    attention.length > 0 && railKey !== dismissedRailKey && !dock && !isChatHash(hash);
  const toggleDock = () => {
    if (dock && !isChatHash(hash)) {
      setDock(false);
      return;
    }
    if (isChatHash(hash)) {
      window.location.hash = FLEET_HASH;
      setDock(true);
      return;
    }
    if (panels.length === 0) {
      if (chat.selection) open(chat.selection, "dock");
      else quickJump();
    } else setDock(true);
  };
  const labelOf = (target: ChatSelection) =>
    botLabel(
      target.instance,
      target.bot,
      chat.swarms
        .find((swarm) => swarm.instance === target.instance)
        ?.bots.find((bot) => bot.name === target.bot)?.title,
    );
  const selectTab = (panelId: number, target: ChatSelection) => {
    if (!chat.select(target.instance, target.bot, target.session)) return;
    activePanelId.current = panelId;
    setPanels((previous) => openChatInPanel(previous, panelId, target));
    setNavigation((n) => n + 1);
  };
  const pick = (target: ChatSelection) => {
    if (!picker || !chat.select(target.instance, target.bot, target.session)) return;
    if (picker.mode === "panel") {
      const id = nextPanelId.current++;
      activePanelId.current = id;
      setPanels((previous) => openChatInNewPanel(previous, id, target));
    } else if (picker.panelId !== null) {
      activePanelId.current = picker.panelId;
      setPanels((previous) => openChatInPanel(previous, picker.panelId!, target));
    }
    setNavigation((n) => n + 1);
    setPicker(null);
  };
  const closeTab = (panelId: number, target: ChatSelection) => {
    const next = closeChatTab(panels, panelId, target);
    setPanels(next);
    if (next.length === 0) setDock(false);
    if (!next.some((panel) => panel.id === activePanelId.current))
      activePanelId.current = next[0]?.id ?? null;
    const selection = next.find((panel) => panel.id === panelId)?.selected ?? next[0]?.selected;
    if (selection && chat.selection && sameChat(chat.selection, target))
      chat.select(selection.instance, selection.bot, selection.session);
  };
  const closePanel = (panelId: number) => {
    const next = closeDockPanel(panels, panelId);
    setPanels(next);
    if (next.length === 0) setDock(false);
    if (activePanelId.current === panelId) activePanelId.current = next[0]?.id ?? null;
    else if (
      chat.selection &&
      panels.some(
        (panel) => panel.id === panelId && panel.tabs.some((tab) => sameChat(tab, chat.selection!)),
      )
    )
      chat.select(next[0]!.selected.instance, next[0]!.selected.bot, next[0]!.selected.session);
  };
  const changePaneSession = (panelId: number, oldTarget: ChatSelection, target: ChatSelection) => {
    if (!chat.select(target.instance, target.bot, target.session)) return;
    setPanels((previous) =>
      previous.map((panel) => {
        if (panel.id !== panelId) return panel;
        const tabs = panel.tabs.filter((tab) => !sameChat(tab, oldTarget) && !sameChat(tab, target));
        return { ...panel, tabs: [...tabs, target], selected: target };
      }),
    );
  };

  return (
    <ChatEntryContext.Provider
      value={{
        navigation,
        drawerTarget,
        closeDrawer,
        open,
        quickJump,
        dock: { open: dock && !isChatHash(hash), unread, active, toggle: toggleDock },
      }}
    >
      {children}
      {dock && !isChatHash(hash) && !drawerTarget ? (
        <ChatDock
          panels={panels}
          picker={picker}
          full={false}
          activePanelId={() => activePanelId.current}
          onActivatePanel={(id) => {
            activePanelId.current = id;
          }}
          onAddPanel={() => {
            chat.activate();
            setPicker({ mode: "panel", panelId: null });
          }}
          onAddTab={(panelId) => {
            chat.activate();
            setPicker({ mode: "tab", panelId });
          }}
          onSelectTab={selectTab}
          onCloseTab={closeTab}
          onClosePanel={closePanel}
          onPick={pick}
          onClosePicker={() => setPicker(null)}
          onExpand={(target) => open(target, "full")}
          onMinimize={() => {
            setPicker(null);
            setDock(false);
          }}
          renderThread={(target, panelId) => (
            <ChatTargetScope
              target={target}
              onSelect={(next) => changePaneSession(panelId, target, next)}
            >
              <ChatView withContext={false} withRail={false} />
            </ChatTargetScope>
          )}
        />
      ) : null}
      {railVisible ? (
        <aside className="ch-activity-rail" aria-label="Chat activity">
          <div className="ch-activity-label">Chat activity</div>
          <div className="ch-activity-items">
            {attention.map((item) => {
              const status = fleet?.byName.get(item.target.instance)?.display_status;
              return (
                <button
                  type="button"
                  className="ch-activity-item"
                  key={`${item.target.instance}/${item.target.bot}`}
                  onClick={() => open(item.target, "dock")}
                  aria-label={`${labelOf(item.target)}, ${item.unread > 0 ? `${item.unread} unread` : item.activity}`}
                >
                  <Face
                    fleetId={fleet?.meta?.config?.fleet_id ?? ""}
                    instance={item.target.instance}
                    bot={item.target.bot}
                    size={22}
                    square={false}
                    status={
                      status === "ready" ||
                      status === "degraded" ||
                      status === "error" ||
                      status === "stopped" ||
                      status === "destroyed"
                        ? status
                        : "pending"
                    }
                  />
                  <span className="copy">
                    <b>{labelOf(item.target)}</b>
                    <em>
                      {item.activity === "idle"
                        ? "New activity"
                        : item.activity === "thinking"
                          ? "Thinking"
                          : "Replying"}
                    </em>
                  </span>
                  {item.unread > 0 ? <span className="ch-unread">{item.unread}</span> : null}
                  {item.activity !== "idle" ? (
                    <i className="ch-footer-running" aria-hidden="true" />
                  ) : null}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="ch-activity-hide"
            aria-label="Hide activity rail"
            onClick={() => setDismissedRailKey(railKey)}
          >
            ×
          </button>
        </aside>
      ) : null}
      {chat.selectionError && !quick ? (
        <div className="ch-entry-error" role="alert">
          {chat.selectionError}
        </div>
      ) : null}
      {quick ? <QuickJump chatMode={isChatHash(hash)} onClose={() => setQuick(false)} /> : null}
      {enabled ? <InspectorShortcut /> : null}
    </ChatEntryContext.Provider>
  );
}
