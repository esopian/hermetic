/**
 * The conversation route around its own effects, with the stores faked at the
 * client seam: a `?fresh=1` open that lands after the operator left replaces
 * nothing, and what focusing a conversation marks read (the Bot Chat clears
 * the bot; a separate session only its own inbox entries).
 */
import { act, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Conversation from "../../app/chat/[instance]/[bot].tsx";
import { RosterStore } from "../../src/client/roster-store.ts";
import { FleetContext, type FleetContextValue } from "../../src/fleet/FleetProvider.tsx";
import { memoryFile } from "../../src/fleet/store.ts";
import { InboxStore } from "../../src/inbox/store.ts";
import { flush } from "../helpers/fakes.ts";
import { inboxEntry } from "../helpers/fixtures.ts";
import { renderUi } from "../helpers/render.tsx";

jest.mock("react-native-keyboard-controller", () => require("react-native-keyboard-controller/jest"));

let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => {
  const { useEffect } = require("react");
  return {
    router: {
      replace: jest.fn(),
      back: jest.fn(),
      push: jest.fn(),
      setParams: jest.fn(),
      canGoBack: () => true,
    },
    Stack: { Screen: () => null },
    useLocalSearchParams: () => mockParams,
    useFocusEffect: (fn: () => undefined | (() => void)) => useEffect(fn, [fn]),
  };
});

const mockRouter: Record<"replace" | "back" | "push" | "setParams", jest.Mock> =
  require("expo-router").router;

const FLEET_STATE = { link: null };

const METRICS = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function setup(params: Record<string, string>) {
  mockParams = params;
  const roster = new RosterStore({
    swarms: async () => ({ swarms: [] }),
    listening: async () => ({ instances: ["atlas"] }),
    listen: async () => ({ instances: ["atlas"] }),
  });
  const markSeen = jest.spyOn(roster, "markSeen");
  const inbox = new InboxStore(memoryFile(), () => "2026-10-13T12:00:00.000Z");
  for (const [session, n] of [
    ["s-1", 1],
    ["s-2", 2],
  ] as const) {
    const {
      id: _id,
      read_at: _read,
      ...arrival
    } = inboxEntry({
      session,
      dedupe: `atlas:${session}:${n}:turn.done`,
    });
    inbox.ingest(arrival);
  }
  const opened = deferred<{ instance: string; bot: string; session: string }>();
  const chat = {
    open: jest.fn(),
    leave: jest.fn(),
    view: () => null,
    subscribe: () => () => {},
    reload: jest.fn(async () => {}),
    sendMessage: jest.fn(() => true),
  };
  const client = {
    roster,
    inbox,
    chat,
    gateway: { open: jest.fn(() => opened.promise) },
    setWatched: jest.fn(),
  };
  const ctx = {
    client,
    focusConversation: jest.fn(),
    fleet: { subscribe: () => () => {}, getState: () => FLEET_STATE, agents: () => [] },
  } as unknown as FleetContextValue;
  const view = await renderUi(
    <SafeAreaProvider initialMetrics={METRICS}>
      <FleetContext.Provider value={ctx}>
        <Conversation />
      </FleetContext.Provider>
    </SafeAreaProvider>,
  );
  await act(flush);
  return { client, chat, inbox, markSeen, opened, view };
}

beforeEach(() => {
  for (const fn of [mockRouter.replace, mockRouter.back, mockRouter.push, mockRouter.setParams])
    fn.mockClear();
});

const unread = (inbox: InboxStore) =>
  inbox
    .getState()
    .entries.filter((e) => !e.read_at)
    .map((e) => e.session)
    .sort();

describe("conversation: fresh=1", () => {
  test("opens one new session, never the Bot Chat, and replaces itself with it", async () => {
    const { client, chat, opened, markSeen } = await setup({
      instance: "atlas",
      bot: "scribe",
      fresh: "1",
    });
    expect(client.gateway.open).toHaveBeenCalledTimes(1);
    expect(client.gateway.open).toHaveBeenCalledWith({
      instance: "atlas",
      bot: "scribe",
      new_session: true,
    });
    expect(chat.open).not.toHaveBeenCalled();
    expect(client.setWatched).not.toHaveBeenCalled();
    expect(markSeen).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message").props.placeholder).toBe("Opening a new session…");
    await act(async () => {
      opened.resolve({ instance: "atlas", bot: "scribe", session: "new-1" });
      await flush();
    });
    expect(mockRouter.replace).toHaveBeenCalledWith("/chat/atlas/scribe?session=new-1");
  });

  test("a new session that lands after the operator left replaces nothing", async () => {
    const { opened, view } = await setup({ instance: "atlas", bot: "scribe", fresh: "1" });
    await view.unmount();
    await act(async () => {
      opened.resolve({ instance: "atlas", bot: "scribe", session: "new-1" });
      await flush();
    });
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});

describe("conversation: what focus marks read", () => {
  test("the Bot Chat clears the bot: roster unread and every inbox entry", async () => {
    const { markSeen, inbox, client } = await setup({ instance: "atlas", bot: "scribe" });
    expect(client.setWatched).toHaveBeenCalledWith({ instance: "atlas", bot: "scribe", focused: true });
    expect(markSeen).toHaveBeenCalledWith("atlas", "scribe");
    expect(unread(inbox)).toEqual([]);
  });

  test("a separate session clears only its own entries and leaves the Bot Chat's unread", async () => {
    const { markSeen, inbox } = await setup({ instance: "atlas", bot: "scribe", session: "s-2" });
    expect(markSeen).not.toHaveBeenCalled();
    expect(unread(inbox)).toEqual(["s-1"]);
  });
});
