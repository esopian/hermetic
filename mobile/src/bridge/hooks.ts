/** Screen-facing hooks over the client layer's stores (`useSyncExternalStore`). */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ConversationTarget, ConversationView } from "../client/conversation-store.ts";
import type { InboxState } from "../client/notifications-store.ts";
import type { RosterLayout, RosterState } from "../client/roster-store.ts";
import { useBridge } from "./BridgeProvider.tsx";

const noop = () => () => {};

/**
 * `notify` wakes `fn` at most once per display frame; `dispose` drops a wake-up
 * still pending.
 *
 * A streamed reply moves the conversation store on every delta, one WebSocket
 * frame each, and they come in bursts. `useSyncExternalStore` renders the
 * screen synchronously on every wake-up, so a burst kept the JS thread busy
 * from the first delta to the last: React Native ran no timers and delivered
 * no layout events in between, the transcript never heard its content grow
 * (`onContentSizeChange`), and the operator's message and the whole reply
 * appeared in one jump when the turn ended.
 */
export function oncePerFrame(
  fn: () => void,
  schedule: (cb: () => void) => number = requestAnimationFrame,
  cancel: (handle: number) => void = cancelAnimationFrame,
): { notify: () => void; dispose: () => void } {
  let pending: number | null = null;
  return {
    notify: () => {
      if (pending !== null) return;
      pending = schedule(() => {
        pending = null;
        fn();
      });
    },
    dispose: () => {
      if (pending !== null) cancel(pending);
      pending = null;
    },
  };
}

export function useConversation(target: ConversationTarget | null): ConversationView | null {
  const { client } = useBridge();
  const key = target ? JSON.stringify([target.instance, target.bot, target.session]) : null;
  // Keyed on the target's identity, not its object, so a fresh literal each render is stable.
  const stable = useMemo(() => target, [key]);
  // One render per frame however many deltas the frame brought (`oncePerFrame`).
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!client || !key) return noop();
      const wake = oncePerFrame(fn);
      const off = client.conversations.subscribe((k) => {
        if (k === key || k === "*") wake.notify();
      });
      return () => {
        off();
        wake.dispose();
      };
    },
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
