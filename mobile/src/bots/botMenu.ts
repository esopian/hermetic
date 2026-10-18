/**
 * The long-press menu of a home bot (hero or row): Pin/Unpin · Open agent
 * browser · Mark read · Cancel. An iOS action sheet, an alert elsewhere.
 * `botMenuItems` decides what the menu holds; `showBotMenu` draws it.
 */
import type { Bot } from "@hermetic/core/chat-client";
import { ActionSheetIOS, Alert, Platform } from "react-native";
import { haptic } from "../ui/haptics.ts";

export interface BotMenuActions {
  togglePin(): void;
  openBrowser(): void;
  markRead(): void;
}

export interface BotMenuItem {
  label: string;
  run: keyof BotMenuActions;
}

export interface BotMenuState {
  pinned: boolean;
  /** Mark read would clear something: unread, an inbox needs-you, or a failed mark (`HomeRow.clearable`). */
  clearable: boolean;
}

/** The menu's items, in order. Mark read only when there is something for it to clear. */
export function botMenuItems(state: BotMenuState): BotMenuItem[] {
  const items: BotMenuItem[] = [
    { label: state.pinned ? "Unpin" : "Pin", run: "togglePin" },
    { label: "Open agent browser", run: "openBrowser" },
  ];
  if (state.clearable) items.push({ label: "Mark read", run: "markRead" });
  return items;
}

/** `tint` colours the sheet's buttons (the app's own ink, not the system blue). */
export function showBotMenu(
  bot: Bot,
  state: BotMenuState,
  actions: BotMenuActions,
  tint: string,
): void {
  haptic.medium();
  const items = botMenuItems(state);
  const title = `${bot.title || bot.name} · ${bot.instance}`;
  const run = (item: BotMenuItem | undefined) => {
    if (item) actions[item.run]();
  };
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...items.map((i) => i.label), "Cancel"],
        cancelButtonIndex: items.length,
        tintColor: tint,
      },
      (index) => run(items[index]),
    );
    return;
  }
  Alert.alert(title, undefined, [
    ...items.map((item) => ({ text: item.label, onPress: () => run(item) })),
    { text: "Cancel", style: "cancel" as const },
  ]);
}
