import type { ChatSelection } from "./chat-state.tsx";
import { chatHash } from "./chat-routing.ts";

export interface DockPanel {
  id: number;
  tabs: ChatSelection[];
  selected: ChatSelection;
}

export function sameChat(a: ChatSelection, b: ChatSelection): boolean {
  return chatHash(a) === chatHash(b);
}

export function hasChat(panel: DockPanel, target: ChatSelection): boolean {
  return panel.tabs.some((tab) => sameChat(tab, target));
}

/** Selecting an existing tab never creates a second copy of its conversation. */
export function openChatInPanel(
  panels: readonly DockPanel[],
  panelId: number,
  target: ChatSelection,
): DockPanel[] {
  const destination = panels.find((panel) => panel.id === panelId);
  if (!destination) return [...panels];
  return panels
    .map((panel) => {
      if (panel.id === panelId) {
        return {
          ...panel,
          tabs: hasChat(panel, target) ? panel.tabs : [...panel.tabs, target],
          selected: target,
        };
      }
      if (!hasChat(panel, target)) return panel;
      const tabs = panel.tabs.filter((tab) => !sameChat(tab, target));
      return {
        ...panel,
        tabs,
        selected: sameChat(panel.selected, target) ? (tabs[0] ?? panel.selected) : panel.selected,
      };
    })
    .filter((panel) => panel.tabs.length > 0);
}

/** A second panel contains one conversation; a tab already open elsewhere moves into it. */
export function openChatInNewPanel(
  panels: readonly DockPanel[],
  id: number,
  target: ChatSelection,
): DockPanel[] {
  if (panels.length >= 2 || panels.some((panel) => sameChat(panel.selected, target)))
    return [...panels];
  const existing = panels.find((panel) => hasChat(panel, target));
  const without = existing
    ? panels.map((panel) => ({
        ...panel,
        tabs: panel.tabs.filter((tab) => !sameChat(tab, target)),
      }))
    : [...panels];
  return [
    ...without.filter((panel) => panel.tabs.length > 0),
    { id, tabs: [target], selected: target },
  ];
}

export function closeChatTab(
  panels: readonly DockPanel[],
  panelId: number,
  target: ChatSelection,
): DockPanel[] {
  return panels
    .map((panel) => {
      if (panel.id !== panelId) return panel;
      const index = panel.tabs.findIndex((tab) => sameChat(tab, target));
      if (index < 0) return panel;
      const tabs = panel.tabs.filter((tab) => !sameChat(tab, target));
      return {
        ...panel,
        tabs,
        selected: sameChat(panel.selected, target)
          ? (tabs[Math.max(0, index - 1)] ?? tabs[0] ?? panel.selected)
          : panel.selected,
      };
    })
    .filter((panel) => panel.tabs.length > 0);
}

export function closeDockPanel(panels: readonly DockPanel[], panelId: number): DockPanel[] {
  return panels.filter((panel) => panel.id !== panelId);
}
