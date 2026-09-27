/** Viewer appearance belongs to this browser, independently of the selected fleet. */
import { useSyncExternalStore } from "react";
import { AVATAR_STYLES, DEFAULT_AVATAR_STYLE } from "./components/avatar/avatar-seed.ts";
import type { AvatarStyle } from "./components/avatar/avatar-seed.ts";

export const CHAT_AVATAR_STYLE_KEY = "hermetic.chat.avatar-style";
const CHANGED = "hermetic:chat-appearance";
/** A denied write must not undo a choice that can still apply to this open page. */
let volatileStyle: AvatarStyle | null = null;

function readStyle(): AvatarStyle {
  if (volatileStyle) return volatileStyle;
  try {
    const value = window.localStorage.getItem(CHAT_AVATAR_STYLE_KEY);
    return AVATAR_STYLES.find((style) => style === value) ?? DEFAULT_AVATAR_STYLE;
  } catch {
    return DEFAULT_AVATAR_STYLE;
  }
}

function subscribe(changed: () => void): () => void {
  const stored = (event: StorageEvent) => {
    if (event.key !== null && event.key !== CHAT_AVATAR_STYLE_KEY) return;
    volatileStyle = null;
    changed();
  };
  window.addEventListener(CHANGED, changed);
  window.addEventListener("storage", stored);
  return () => {
    window.removeEventListener(CHANGED, changed);
    window.removeEventListener("storage", stored);
  };
}

export function setChatAvatarStyle(style: AvatarStyle): void {
  try {
    window.localStorage.setItem(CHAT_AVATAR_STYLE_KEY, style);
    volatileStyle = null;
  } catch {
    volatileStyle = style;
  }
  window.dispatchEvent(new Event(CHANGED));
}

export function useChatAvatarStyle(): AvatarStyle {
  return useSyncExternalStore(subscribe, readStyle, () => DEFAULT_AVATAR_STYLE);
}
