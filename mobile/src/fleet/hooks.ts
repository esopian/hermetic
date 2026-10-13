/** Screen-facing hooks over the client layer's stores (`useSyncExternalStore`). */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ConversationTarget, ConversationView } from "../client/conversation-store.ts";
import type { RosterLayout, RosterState } from "../client/roster-store.ts";
import type { InboxState } from "../inbox/store.ts";
import { useFleetContext } from "./FleetProvider.tsx";
import type { FleetAgent, FleetState } from "./store.ts";

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
  const { client } = useFleetContext();
  const key = target ? JSON.stringify([target.instance, target.bot, target.session]) : null;
  // Keyed on the target's identity, not its object, so a fresh literal each render is stable.
  const stable = useMemo(() => target, [key]);
  // One render per frame however many deltas the frame brought (`oncePerFrame`).
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!client || !key) return noop();
      const wake = oncePerFrame(fn);
      const off = client.chat.subscribe((k) => {
        if (k === key || k === "*") wake.notify();
      });
      return () => {
        off();
        wake.dispose();
      };
    },
    [client, key],
  );
  const get = useCallback(() => (client && stable ? client.chat.view(stable) : null), [client, stable]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useRoster(): { state: RosterState | null; layout: RosterLayout | null } {
  const { client } = useFleetContext();
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
  const { client } = useFleetContext();
  const subscribe = useCallback(
    (fn: () => void) => (client ? client.inbox.subscribe(fn) : noop()),
    [client],
  );
  const get = useCallback(() => client?.inbox.getState() ?? null, [client]);
  return useSyncExternalStore(subscribe, get, get);
}

/** The paired fleet's state: link, view, listening, refresh status. */
export function useFleetState(): FleetState {
  const { fleet } = useFleetContext();
  const subscribe = useCallback((fn: () => void) => fleet.subscribe(fn), [fleet]);
  const get = useCallback(() => fleet.getState(), [fleet]);
  return useSyncExternalStore(subscribe, get, get);
}

/** Every agent of the paired fleet (the link's, merged with `/fleet`), name-sorted. */
export function useFleetAgents(): FleetAgent[] {
  const { fleet } = useFleetContext();
  const state = useFleetState();
  return useMemo(() => fleet.agents(), [fleet, state]);
}

/** The fleet's display label: its alias, else its id. */
export function useFleetLabel(): string {
  const state = useFleetState();
  return state.link?.label ?? "";
}
