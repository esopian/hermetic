import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useUnreadChatByConversation } from "../../state/notify-state.tsx";
import { useFleetIfAvailable } from "../../state/state.tsx";
import { activityFor } from "../chat-activity.ts";
import { hasChat, sameChat } from "../chat-dock-layout.ts";
import type { DockPanel } from "../chat-dock-layout.ts";
import { railUnread } from "../chat-logic.ts";
import { botLabel } from "../chat-presentation.ts";
import { useChat } from "../chat-state.tsx";
import type { ChatSelection } from "../chat-state.tsx";
import { Face } from "./Face.tsx";

export interface DockPicker {
  mode: "panel" | "tab";
  panelId: number | null;
}

interface Props {
  panels: readonly DockPanel[];
  picker: DockPicker | null;
  full: boolean;
  activePanelId: () => number | null;
  onActivatePanel: (panelId: number) => void;
  onAddPanel: () => void;
  onAddTab: (panelId: number) => void;
  onSelectTab: (panelId: number, target: ChatSelection) => void;
  onCloseTab: (panelId: number, target: ChatSelection) => void;
  onClosePanel: (panelId: number) => void;
  onPick: (target: ChatSelection) => void;
  onClosePicker: () => void;
  onExpand: (target: ChatSelection) => void;
  onMinimize: () => void;
  renderThread: (target: ChatSelection, panelId: number) => ReactNode;
}

export function ChatDock({
  panels,
  picker,
  full,
  activePanelId,
  onActivatePanel,
  onAddPanel,
  onAddTab,
  onSelectTab,
  onCloseTab,
  onClosePanel,
  onPick,
  onClosePicker,
  onExpand,
  onMinimize,
  renderThread,
}: Props) {
  const chat = useChat();
  const fleet = useFleetIfAvailable();
  const inbox = useUnreadChatByConversation();
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!picker) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClosePicker();
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) onClosePicker();
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [picker, onClosePicker]);

  const unreadOf = (target: ChatSelection) => {
    const bot = chat.swarms
      .find((swarm) => swarm.instance === target.instance)
      ?.bots.find((item) => item.name === target.bot);
    return Math.max(
      bot ? railUnread(bot, inbox.get(`${target.instance}/${target.bot}`) ?? 0) : 0,
      inbox.get(`${target.instance}/${target.bot}`) ?? 0,
    );
  };
  const labelOf = (target: ChatSelection) => {
    const title = chat.swarms
      .find((swarm) => swarm.instance === target.instance)
      ?.bots.find((bot) => bot.name === target.bot)?.title;
    return botLabel(target.instance, target.bot, title);
  };
  const pickerChoices: ChatSelection[] = [];
  for (const swarm of chat.swarms)
    for (const bot of swarm.bots)
      pickerChoices.push({ instance: swarm.instance, bot: bot.name, session: null });
  for (const panel of panels)
    for (const target of panel.tabs)
      if (!pickerChoices.some((choice) => sameChat(choice, target))) pickerChoices.push(target);

  const pickerIndex = panels.findIndex((panel) => panel.id === picker?.panelId);
  return (
    <aside
      className={`ch-dock${panels.length > 1 ? " split" : ""}${full ? " full" : ""}`}
      aria-label="Chat dock"
      data-testid="chat-dock"
    >
      <div className="ch-dock-chrome">
        <div className="ch-dock-title">
          Chat dock{" "}
          <span>
            {panels.length} {panels.length === 1 ? "panel" : "panels"}
          </span>
        </div>
        <div className="ch-dock-controls" role="group" aria-label="Dock view controls">
          <button
            type="button"
            className="ch-dock-add-panel"
            disabled={panels.length >= 2}
            title={panels.length >= 2 ? "Two panels max in the dock" : "Open a chat in a new panel"}
            onClick={onAddPanel}
          >
            + Panel
          </button>
          <button
            type="button"
            aria-label="Expand chat"
            title="Open full chat view"
            onClick={() => {
              const panel = panels.find((item) => item.id === activePanelId()) ?? panels[0];
              if (panel) onExpand(panel.selected);
            }}
          >
            ⤢
          </button>
          <button
            type="button"
            aria-label="Minimize chat dock"
            title="Minimize to footer"
            onClick={onMinimize}
          >
            −
          </button>
        </div>
      </div>
      <div className="ch-dock-panes">
        {panels.map((panel, index) => (
          <section
            className="ch-dock-pane"
            aria-label={`Panel ${index + 1}: ${labelOf(panel.selected)}`}
            data-testid="chat-dock-panel"
            data-chat-panel-id={panel.id}
            onPointerDownCapture={() => onActivatePanel(panel.id)}
            onFocusCapture={() => onActivatePanel(panel.id)}
            key={panel.id}
          >
            <div className="ch-dock-pane-tabs">
              <span className="ch-dock-pane-label">Panel {index + 1}</span>
              <div
                className="ch-dock-tab-list"
                role="tablist"
                aria-label={`Panel ${index + 1} conversations`}
              >
                {panel.tabs.map((target) => {
                  const selected = sameChat(panel.selected, target);
                  const unread = unreadOf(target);
                  const activity = activityFor(chat.turnActivities, target.instance, target.bot);
                  return (
                    <span
                      className={`ch-dock-tab${selected ? " selected" : ""}`}
                      key={`${target.instance}/${target.bot}/${target.session ?? ""}`}
                    >
                      <button
                        type="button"
                        className="ch-dock-tab-select"
                        role="tab"
                        aria-selected={selected}
                        onClick={() => onSelectTab(panel.id, target)}
                      >
                        <span className="ch-dock-tab-label">{labelOf(target)}</span>
                        {unread > 0 ? <span className="ch-unread">{unread}</span> : null}
                        {activity !== "idle" ? (
                          <i className="ch-footer-running" role="img" aria-label="Turn in progress" />
                        ) : null}
                      </button>
                      <button
                        type="button"
                        className="ch-dock-tab-close"
                        aria-label={`Close ${labelOf(target)} tab`}
                        title="Close tab"
                        onClick={() => onCloseTab(panel.id, target)}
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
              <button type="button" className="ch-dock-add-tab" onClick={() => onAddTab(panel.id)}>
                + Tab
              </button>
              <button
                type="button"
                className="ch-dock-close-pane"
                aria-label={`Close panel ${index + 1}`}
                title="Close panel without stopping turns"
                onClick={() => onClosePanel(panel.id)}
              >
                × Panel
              </button>
            </div>
            {renderThread(panel.selected, panel.id)}
          </section>
        ))}
      </div>
      {picker ? (
        <div
          className="ch-dock-picker"
          role="dialog"
          aria-label={
            picker.mode === "panel" ? "Open in new panel" : `Add tab to panel ${pickerIndex + 1}`
          }
          ref={pickerRef}
          style={
            picker.mode === "tab"
              ? {
                  top: 82,
                  left: pickerIndex === 0 ? 12 : undefined,
                  right: pickerIndex === 0 ? undefined : 12,
                }
              : undefined
          }
        >
          <h4>
            {picker.mode === "panel" ? "Open in new panel" : `Add tab to panel ${pickerIndex + 1}`}
          </h4>
          {pickerChoices.map((target) => {
            const ownerIndex = panels.findIndex((panel) => hasChat(panel, target));
            const owner = panels[ownerIndex];
            const disabled = picker.mode === "panel" && owner && sameChat(owner.selected, target);
            const status = fleet?.byName.get(target.instance)?.display_status ?? "pending";
            return (
              <button
                type="button"
                key={`${target.instance}/${target.bot}/${target.session ?? ""}`}
                disabled={Boolean(disabled)}
                onClick={() => onPick(target)}
              >
                <Face
                  fleetId={fleet?.meta?.config?.fleet_id ?? ""}
                  instance={target.instance}
                  bot={target.bot}
                  size={21}
                  status={
                    status === "ready" ||
                    status === "degraded" ||
                    status === "error" ||
                    status === "stopped" ||
                    status === "destroyed"
                      ? status
                      : "pending"
                  }
                  square={false}
                />
                {labelOf(target)}
                <small>{disabled ? "visible" : owner ? `in panel ${ownerIndex + 1}` : ""}</small>
              </button>
            );
          })}
          {pickerChoices.length === 0 ? (
            <p>No conversations yet. Listen to an agent to start chatting.</p>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
