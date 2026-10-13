/** Screen-facing hooks over the client layer's stores (`useSyncExternalStore`). */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ConversationTarget, ConversationView } from "../client/conversation-store.ts";
import type { InboxState } from "../client/notifications-store.ts";
import type { RosterLayout, RosterState } from "../client/roster-store.ts";
import { useBridge } from "./BridgeProvider.tsx";

const noop = () => () => {};

export function useConversation(target: ConversationTarget | null): ConversationView | null {
  const { client } = useBridge();
  const key = target ? JSON.stringify([target.instance, target.bot, target.session]) : null;
  // Keyed on the target's identity, not its object, so a fresh literal each render is stable.
  const stable = useMemo(() => target, [key]);
  const subscribe = useCallback(
    (fn: () => void) =>
      client && key ? client.conversations.subscribe((k) => (k === key || k === "*") && fn()) : noop(),
    [client, key],
  );
  const get = useCallback(
    () => (client && stable ? client.conversations.view(stable) : null),
    [client, stable],
  );
  return useSyncExternalStore(subscribe, get, get);
}

export function useRoster(): { state: RosterState | null; layout: RosterLayout | null } {
  const { client } = useBridge();
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!client) return noop();
      const a = client.roster.subscribe(fn);
      const b = client.inbox.subscribe(fn);
      return () => {
        a();
        b();
      };
    },
    [client],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => client?.roster.getState() ?? null,
    () => client?.roster.getState() ?? null,
  );
  const inbox = useSyncExternalStore(
    subscribe,
    () => client?.inbox.getState() ?? null,
    () => client?.inbox.getState() ?? null,
  );
  const layout = useMemo(
    () => (client && state ? client.roster.layout(client.inbox.unreadFor) : null),
    [client, state, inbox],
  );
  return { state, layout };
}

export function useInbox(): InboxState | null {
  const { client } = useBridge();
  const subscribe = useCallback(
    (fn: () => void) => (client ? client.inbox.subscribe(fn) : noop()),
    [client],
  );
  const get = useCallback(() => client?.inbox.getState() ?? null, [client]);
  return useSyncExternalStore(subscribe, get, get);
}
