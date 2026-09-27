/** Chat URLs encode each identity segment separately, so bot names cannot alter routing. */
import type { ChatSelection } from "./chat-state.tsx";

export interface ChatRoute extends ChatSelection {
  message: string | null;
}

export function isChatHash(hash: string): boolean {
  return hash === "#chat" || hash.startsWith("#chat/");
}

export function chatHash(target: ChatSelection, message?: string | null): string {
  const query = new URLSearchParams();
  if (target.session) query.set("session", target.session);
  if (message) query.set("message", message);
  return `#chat/${encodeURIComponent(target.instance)}/${encodeURIComponent(target.bot)}${query.size ? `?${query}` : ""}`;
}

export function parseChatHash(hash: string): ChatRoute | null {
  if (!hash.startsWith("#chat/")) return null;
  const [path, query = ""] = hash.slice(6).split("?");
  const parts = path?.split("/") ?? [];
  if (parts.length < 1 || parts.length > 2) return null;
  try {
    const instance = decodeURIComponent(parts[0] ?? "");
    const bot = parts.length === 1 ? "default" : decodeURIComponent(parts[1] ?? "");
    if (!instance || !bot || Array.from(instance + bot).some((char) => char.charCodeAt(0) < 32))
      return null;
    // URLSearchParams tolerates malformed escapes. Reject them before it can
    // turn a mistyped identity into a different, apparently valid destination.
    decodeURIComponent(query.replace(/\+/g, " "));
    const params = new URLSearchParams(query);
    return {
      instance,
      bot,
      session: params.get("session") || null,
      message: params.get("message") || null,
    };
  } catch {
    return null;
  }
}

/** Raw notification refs split at the first slash; the entire remainder is a bot name. */
export function chatRefHash(ref?: string | null): string {
  if (!ref) return "#chat";
  if (ref.startsWith("#chat/")) {
    const route = parseChatHash(ref);
    return route ? chatHash(route, route.message) : "#chat";
  }
  const slash = ref.indexOf("/");
  const instance = slash < 0 ? ref : ref.slice(0, slash);
  const bot = slash < 0 ? "default" : ref.slice(slash + 1);
  return instance && bot ? chatHash({ instance, bot, session: null }) : "#chat";
}
