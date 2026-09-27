/** Listening owns both visible bots and the lifetime of background conversations. */
import { act, cleanup, render, waitFor } from "./dom.ts";
import { afterEach, expect, test } from "bun:test";
import { ListeningProvider, useListeningIfAvailable } from "../src/state/listening-state.tsx";
import type { Listening, ListeningApi } from "../src/state/listening-state.tsx";
import { ChatProvider, useChat } from "../src/chat/chat-state.tsx";
import type { Chat, ChatApi } from "../src/chat/chat-state.tsx";
import type { ChatHistoryResult, ChatSwarmsResult, ChatTurnHandlers } from "../src/api/index.ts";
import { NotifyProvider, useNotify } from "../src/state/notify-state.tsx";
import type { Notify, NotifyApi } from "../src/state/notify-state.tsx";

afterEach(cleanup);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(initial: string[] = []) {
  let listening!: Listening;
  let chat!: Chat;
  let watched = [...initial];
  let rosterReads = 0;
  let writeHold: ReturnType<typeof deferred<void>> | null = null;
  let rosterHold: ReturnType<typeof deferred<ChatSwarmsResult>> | null = null;
  const historyHolds = new Map<string, ReturnType<typeof deferred<ChatHistoryResult>>>();
  const reads: { instance: string; kind: string; signal?: AbortSignal }[] = [];
  const turns: { instance: string; cancelled: boolean; handlers: ChatTurnHandlers }[] = [];
  const listeningApi: ListeningApi = {
    fetchListening: async () => ({ instances: [...watched] }),
    setInstanceListening: async (instance, enabled) => {
      if (writeHold) await writeHold.promise;
      watched = enabled ? [...new Set([...watched, instance])] : watched.filter((i) => i !== instance);
      return { instances: [...watched] };
    },
  };
  const api: ChatApi = {
    fetchSwarms: async () => {
      rosterReads += 1;
      return rosterHold ? rosterHold.promise : { swarms: [] };
    },
    fetchSessions: async (instance, _bot, signal) => {
      reads.push({ instance, kind: "sessions", signal });
      return { instance, bot: "default", sessions: [] };
    },
    fetchHistory: async (instance, _bot, _input, signal) => {
      reads.push({ instance, kind: "history", signal });
      return (
        historyHolds.get(instance)?.promise ?? { instance, bot: "default", session: null, messages: [] }
      );
    },
    sendTurn: (instance, _bot, _text, handlers) => {
      const turn = { instance, handlers, cancelled: false };
      turns.push(turn);
      return () => {
        turn.cancelled = true;
      };
    },
    abortTurn: async () => {
      throw new Error("Unlisten must detach without issuing a chat abort");
    },
  };
  function Probe() {
    listening = useListeningIfAvailable()!;
    chat = useChat();
    return null;
  }
  const root = render(
    <ListeningProvider api={listeningApi}>
      <ChatProvider api={api}>
        <Probe />
      </ChatProvider>
    </ListeningProvider>,
  );
  return {
    get listening() {
      return listening;
    },
    get chat() {
      return chat;
    },
    get rosterReads() {
      return rosterReads;
    },
    root,
    reads,
    turns,
    historyHolds,
    holdWrite() {
      writeHold = deferred<void>();
      return writeHold;
    },
    holdRoster() {
      rosterHold = deferred<ChatSwarmsResult>();
      return rosterHold;
    },
    externalWatch(instances: string[]) {
      watched = instances;
    },
    async watch(instance: string, enabled: boolean) {
      await act(async () => listening.setListening(instance, enabled));
    },
    async select(instance: string) {
      await act(async () => {
        chat.select(instance, "default");
      });
    },
  };
}

test("fresh operator never asks for rosters, sessions, history, or sends until explicitly listening", async () => {
  const host = setup();
  await waitFor(() => expect(host.listening.loading).toBe(false));
  await act(async () => {
    expect(host.chat.select("atlas", "default")).toBe(false);
    host.chat.send("hello");
    await host.chat.reloadHistory();
    await host.chat.refreshSwarms();
  });
  expect(host.rosterReads).toBe(0);
  expect(host.reads).toEqual([]);
  expect(host.turns).toEqual([]);
  expect(host.chat.selectionError).toContain("Listen to atlas");
  await host.watch("atlas", true);
  await host.select("atlas");
  await waitFor(() => expect(host.chat.historyRead).toBe(true));
  expect(host.reads.map((r) => r.instance)).toEqual(["atlas", "atlas"]);
  expect(host.rosterReads).toBeGreaterThan(0);
});

test("unlisten cancels background turns, drops their records, and preserves watched conversations", async () => {
  const host = setup(["atlas", "corvid"]);
  await waitFor(() => expect(host.listening.loading).toBe(false));
  await host.select("atlas");
  await act(async () => host.chat.send("atlas work"));
  await host.select("corvid");
  await act(async () => host.chat.send("corvid work"));
  expect(host.turns).toHaveLength(2);
  await host.watch("atlas", false);
  expect(host.turns[0]!.cancelled).toBe(true);
  expect(host.turns[1]!.cancelled).toBe(false);
  expect(host.chat.selection?.instance).toBe("corvid");
  expect(host.chat.turnActivities.map((t) => t.instance)).toEqual(["corvid"]);
  const count = host.reads.length;
  await act(async () => {
    host.turns[0]!.handlers.onEnd(false, null);
    host.turns[0]!.handlers.onFrame({ type: "delta", message: "late", seq: 1, text: "old" });
  });
  expect(host.reads).toHaveLength(count);
  await host.watch("corvid", false);
  expect(host.turns[1]!.cancelled).toBe(true);
  expect(host.chat.selection).toBeNull();
  expect(host.chat.turnActivities).toEqual([]);
  await host.watch("atlas", true);
  await host.select("atlas");
  expect(host.chat.messages).toEqual([]);
  expect(host.chat.live).toBeNull();
});

test("unlisten aborts pending reads and rejects their stale answers, including after relisten", async () => {
  const host = setup(["atlas"]);
  await waitFor(() => expect(host.listening.loading).toBe(false));
  const history = deferred<ChatHistoryResult>();
  host.historyHolds.set("atlas", history);
  await host.select("atlas");
  const reading = host.reads.find((r) => r.kind === "history")!;
  const roster = host.holdRoster();
  let refresh!: Promise<void>;
  await act(async () => {
    refresh = host.chat.refreshSwarms();
  });
  await host.watch("atlas", false);
  expect(reading.signal?.aborted).toBe(true);
  expect(host.chat.selection).toBeNull();
  await act(async () => {
    history.resolve({ instance: "atlas", bot: "default", session: "old", messages: [] });
    roster.resolve({
      swarms: [
        {
          instance: "atlas",
          reachable: true,
          bots: [],
          rooms: [],
          warm_slots: { used: 0, total: 3 },
          sections: [],
        },
      ],
    });
    await refresh;
  });
  expect(host.chat.swarms).toEqual([]);
  expect(host.chat.selection).toBeNull();
  expect(host.chat.historyRead).toBe(false);
  host.historyHolds.delete("atlas");
  await host.watch("atlas", true);
  await host.select("atlas");
  expect(host.chat.session).toBeNull();
});

test("external listening refresh disconnects the selected chat", async () => {
  const host = setup(["atlas"]);
  await waitFor(() => expect(host.listening.loading).toBe(false));
  await host.select("atlas");
  await act(async () => host.chat.send("work"));
  host.externalWatch([]);
  await act(async () => host.listening.refresh());
  expect(host.turns[0]!.cancelled).toBe(true);
  expect(host.chat.selection).toBeNull();
});

test("unlisten removes agent alerts and counts while retaining fleet alerts", async () => {
  let listening!: Listening;
  let notify!: Notify;
  let watched = ["atlas"];
  const rows = ["atlas", null].map((agent, index) => ({
    id: String(index),
    agent,
    at: "2026-09-18T12:00:00.000Z",
    source: agent ? "chat" : "fleet",
    kind: agent ? "chat.message" : "fleet.advisory",
    class: "info",
    title: "Notice",
    detail: null,
    fleet: "main",
    ref: null,
    key: null,
    actions: [],
    read_at: null,
    resolved_at: null,
    muted: false,
  }));
  const api: NotifyApi = {
    fetchNotifications: async () =>
      ({
        notifications: rows.filter((n) => !n.agent || watched.includes(n.agent)),
        unread: watched.length ? 2 : 1,
        needs_action: 0,
        mutes: [],
      }) as never,
    ackNotification: async () => ({}) as never,
    muteNotification: async () => ({ mutes: [] }) as never,
  };
  function Probe() {
    listening = useListeningIfAvailable()!;
    notify = useNotify();
    return null;
  }
  render(
    <ListeningProvider
      api={{
        fetchListening: async () => ({ instances: [...watched] }),
        setInstanceListening: async () => {
          watched = [];
          return { instances: [] };
        },
      }}
    >
      <NotifyProvider api={api}>
        <Probe />
      </NotifyProvider>
    </ListeningProvider>,
  );
  await waitFor(() => expect(notify.items).toHaveLength(2));
  await act(async () => listening.setListening("atlas", false));
  await waitFor(() => expect(notify.unread).toBe(1));
  expect(notify.items.map((n) => n.agent)).toEqual([null]);
});

/**
 * B10: the page re-filters by listening too, and must apply the same rule as
 * core — an op this laptop ran stays in the inbox even when it names an agent
 * nobody listens to, including one that op destroyed.
 */
test("operation rows naming an unlistened agent survive the page's listening filter", async () => {
  let notify!: Notify;
  const row = (id: string, agent: string, source: string, kind: string) => ({
    id,
    agent,
    at: "2026-09-18T12:00:00.000Z",
    source,
    kind,
    class: "ok",
    title: `${agent} ${kind}`,
    detail: null,
    fleet: "main",
    ref: null,
    key: null,
    actions: [],
    read_at: null,
    resolved_at: null,
    muted: false,
  });
  const api: NotifyApi = {
    fetchNotifications: async () =>
      ({
        notifications: [
          row("0", "brown-wolf", "operation", "operation.done"),
          row("1", "ember", "chat", "chat.message"),
        ],
        unread: 1,
        needs_action: 0,
        mutes: [],
      }) as never,
    ackNotification: async () => ({}) as never,
    muteNotification: async () => ({ mutes: [] }) as never,
  };
  function Probe() {
    notify = useNotify();
    return null;
  }
  render(
    <ListeningProvider
      api={{
        fetchListening: async () => ({ instances: [] }),
        setInstanceListening: async () => ({ instances: [] }),
      }}
    >
      <NotifyProvider api={api}>
        <Probe />
      </NotifyProvider>
    </ListeningProvider>,
  );
  await waitFor(() => expect(notify.items.map((n) => n.agent)).toEqual(["brown-wolf"]));
});

test("pending unlisten cannot trigger a new roster fan-out against the old server preference", async () => {
  const host = setup(["atlas", "corvid"]);
  await waitFor(() => expect(host.listening.loading).toBe(false));
  const hold = host.holdWrite();
  const count = host.rosterReads;
  let write!: Promise<boolean>;
  await act(async () => {
    write = host.listening.setListening("atlas", false);
  });
  await act(async () => host.chat.refreshSwarms());
  expect(host.chat.swarms).toEqual([]);
  expect(host.rosterReads).toBe(count);
  await act(async () => {
    hold.resolve();
    await write;
  });
  expect(host.listening.instances).toEqual(["corvid"]);
  expect(host.rosterReads).toBeGreaterThan(count);
});
