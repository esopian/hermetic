import { act, renderHook } from "@testing-library/react-native";
import type { ConversationTarget, ConversationView } from "../../src/client/conversation-store.ts";

type Listener = (key: string) => void;

/** A conversation store reduced to what `useConversation` reads. */
const mockStore = {
  listeners: new Set<Listener>(),
  view: { seq: 0 } as unknown as ConversationView,
};

jest.mock("../../src/bridge/BridgeProvider.tsx", () => ({
  useBridge: () => ({
    client: {
      conversations: {
        subscribe: (listener: Listener) => {
          mockStore.listeners.add(listener);
          return () => mockStore.listeners.delete(listener);
        },
        view: () => mockStore.view,
      },
    },
  }),
}));

import { oncePerFrame, useConversation } from "../../src/bridge/hooks.ts";

const target: ConversationTarget = { instance: "atlas", bot: "scribe", session: null };
const key = JSON.stringify([target.instance, target.bot, target.session]);

/** One streamed delta: a new snapshot, and the store's change notice. */
function delta(seq: number): void {
  mockStore.view = { seq } as unknown as ConversationView;
  for (const listener of mockStore.listeners) listener(key);
}

describe("oncePerFrame", () => {
  test("many notices in one frame wake the listener once", () => {
    const fn = jest.fn();
    const frames: (() => void)[] = [];
    const wake = oncePerFrame(fn, (cb) => frames.push(cb), jest.fn());
    wake.notify();
    wake.notify();
    wake.notify();
    expect(frames).toHaveLength(1);
    expect(fn).not.toHaveBeenCalled();
    frames[0]?.();
    expect(fn).toHaveBeenCalledTimes(1);
    wake.notify();
    expect(frames).toHaveLength(2);
  });

  test("dispose cancels a pending wake-up", () => {
    const fn = jest.fn();
    const cancel = jest.fn();
    const wake = oncePerFrame(fn, () => 7, cancel);
    wake.notify();
    wake.dispose();
    expect(cancel).toHaveBeenCalledWith(7);
    wake.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("useConversation", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockStore.listeners.clear();
    mockStore.view = { seq: 0 } as unknown as ConversationView;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  // A burst of deltas rendered one by one kept the JS thread busy for the
  // whole reply, so the transcript heard no layout events until it ended.
  test("a burst of deltas renders the screen once, with the last snapshot", async () => {
    let renders = 0;
    const { result } = await renderHook(() => {
      renders += 1;
      return useConversation(target);
    });
    const before = renders;
    await act(async () => {
      for (let seq = 1; seq <= 80; seq++) delta(seq);
    });
    expect(renders).toBe(before);
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    expect(renders).toBe(before + 1);
    expect((result.current as unknown as { seq: number }).seq).toBe(80);
  });

  test("a notice for another conversation does not wake it, and unmounting drops a pending one", async () => {
    let renders = 0;
    const { unmount } = await renderHook(() => {
      renders += 1;
      return useConversation(target);
    });
    const before = renders;
    await act(async () => {
      for (const listener of mockStore.listeners) listener(JSON.stringify(["atlas", "other", null]));
      jest.advanceTimersByTime(50);
    });
    expect(renders).toBe(before);
    await act(async () => delta(1));
    await unmount();
    expect(mockStore.listeners.size).toBe(0);
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    expect(renders).toBe(before);
  });
});
