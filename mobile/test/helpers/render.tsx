import { render } from "@testing-library/react-native";
import type { ReactElement } from "react";
import { ChatScope, type ChatScopeValue } from "../../src/chat/ChatScope.tsx";
import { ThemeProvider } from "../../src/theme/theme.tsx";

export const NOW = Date.parse("2026-10-13T12:00:00.000Z");

export function scope(over: Partial<ChatScopeValue> = {}): ChatScopeValue {
  return {
    fleetId: "fxtr0001",
    instance: "atlas",
    bot: "scribe",
    now: NOW,
    sending: false,
    released: [],
    ...over,
  };
}

/** Render inside the theme, and inside a conversation scope when one is given. */
export function renderUi(ui: ReactElement, chat?: ChatScopeValue | null) {
  return render(
    <ThemeProvider>
      {chat ? <ChatScope.Provider value={chat}>{ui}</ChatScope.Provider> : ui}
    </ThemeProvider>,
  );
}
