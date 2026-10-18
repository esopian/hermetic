/**
 * Read one slice of the chat store, and re-render only when that slice moves.
 *
 * `useChatIfAvailable()` hands over the whole `Chat` value, and that value is
 * rebuilt on everything — the 30 s clock, a roster read, every streaming delta.
 * A block that reads it from inside a settled message (an attachment chip, a
 * share card, a failure's recovery buttons) was re-rendered by all of that,
 * although the one thing it wanted — which box is selected, say — had not
 * changed. So the provider also publishes the value through a store, and a
 * block subscribes to the part it reads with `useChatSelect`. Actions are not
 * subscribed to at all: `useChatGetter` reads the store at call time.
 *
 * Every provider of `ChatContext` in the app provides a store beside it
 * (`ChatProvider`, `ChatTargetScope`), so the slice comes from the same chat
 * value `useChatIfAvailable` would have answered with. A tree that provides a
 * chat value by hand and no store — a test's fake — is read from the context
 * itself, which costs it the isolation and nothing else.
 */
import {
  createContext,
  use,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import type { Chat } from "./chat-types.ts";

class ChatStore {
  private readonly listeners = new Set<() => void>();
  constructor(public current: Chat | null) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * The chat store's value, for `useChat`/`useChatIfAvailable`. Defined here
 * rather than in `chat-state.tsx`, which re-exports it, so the fallback below
 * can read it without the two modules importing each other.
 */
export const ChatContext = createContext<Chat | null>(null);

const ChatStoreContext = createContext<ChatStore | null>(null);

/**
 * Publish `value` to the selectors below. The store is one object for the
 * life of the provider, so its context never changes; the value is written as
 * the provider renders — before anything under it does — and subscribers are
 * told after each commit, each re-rendering only if its own slice moved.
 */
export function ChatStoreProvider({ value, children }: { value: Chat | null; children: ReactNode }) {
  const [store] = useState(() => new ChatStore(value));
  store.current = value;
  useLayoutEffect(() => store.notify());
  return <ChatStoreContext.Provider value={store}>{children}</ChatStoreContext.Provider>;
}

const NO_SUBSCRIPTION = (): (() => void) => () => {};

/**
 * `select(chat)`, re-evaluated whenever the chat value changes and handed back
 * as the previous answer while `equal` says it is the same. `chat` is `null`
 * where there is no provider, exactly as `useChatIfAvailable` answers there.
 */
export function useChatSelect<T>(
  select: (chat: Chat | null) => T,
  equal: (held: T, next: T) => boolean = Object.is,
): T {
  const store = useContext(ChatStoreContext);
  const direct = store === null ? use(ChatContext) : null;
  const cache = useRef<{ chat: Chat | null; select: unknown; value: T } | null>(null);
  const snapshot = (): T => {
    const chat = store ? store.current : direct;
    const held = cache.current;
    if (held && held.chat === chat && held.select === select) return held.value;
    const next = select(chat);
    const value = held && equal(held.value, next) ? held.value : next;
    cache.current = { chat, select, value };
    return value;
  };
  return useSyncExternalStore(store ? store.subscribe : NO_SUBSCRIPTION, snapshot, snapshot);
}

/** The current chat value, read when called: for event handlers, which subscribe to nothing. */
export function useChatGetter(): () => Chat | null {
  const store = useContext(ChatStoreContext);
  const direct = useRef<Chat | null>(null);
  direct.current = store === null ? use(ChatContext) : null;
  return useCallback(() => (store ? store.current : direct.current), [store]);
}
