/**
 * The long-press menu of a home bot (hero or row): Make primary · Pin/Unpin ·
 * Open agent browser · Mark read · Cancel. An iOS action sheet, an alert
 * elsewhere. `botMenuItems` decides what the menu holds; `showBotMenu` draws it.
 */
import type { Bot } from "@hermetic/core/chat-client";
import { ActionSheetIOS, Alert, Platform } from "react-native";
import { haptic } from "../ui/haptics.ts";

export interface BotMenuActions {
  makePrimary(): void;
  togglePin(): void;
  openBrowser(): void;
  markRead(): void;
}

export interface BotMenuItem {
  label: string;
  run: keyof BotMenuActions;
}

/** The menu's items, in order. The primary bot offers no "Make primary" (it already is). */
export function botMenuItems(state: {
  primary: boolean;
  pinned: boolean;
  unread: boolean;
}): BotMenuItem[] {
  const items: BotMenuItem[] = [];
  if (!state.primary) items.push({ label: "Make primary", run: "makePrimary" });
  // The hero is never also a pinned row, so pinning it would change nothing on screen.
  if (!state.primary) items.push({ label: state.pinned ? "Unpin" : "Pin", run: "togglePin" });
  items.push({ label: "Open agent browser", run: "openBrowser" });
  if (state.unread) items.push({ label: "Mark read", run: "markRead" });
  return items;
}

export function showBotMenu(
  bot: Bot,
  state: { primary: boolean; pinned: boolean; unread: boolean },
  actions: BotMenuActions,
): void {
  haptic.medium();
  const items = botMenuItems(state);
  const title = `${bot.title || bot.name} · ${bot.instance}`;
  const run = (item: BotMenuItem | undefined) => {
    if (item) actions[item.run]();
  };
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: [...items.map((i) => i.label), "Cancel"], cancelButtonIndex: items.length },
      (index) => run(items[index]),
    );
    return;
  }
  Alert.alert(title, undefined, [
    ...items.map((item) => ({ text: item.label, onPress: () => run(item) })),
    { text: "Cancel", style: "cancel" as const },
  ]);
}
