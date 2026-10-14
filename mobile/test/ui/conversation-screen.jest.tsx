/**
 * The conversation route around its own effects, over a real client (its
 * `setWatched`, roster and inbox; the box faked at the adapter): a `?fresh=1`
 * open that lands after the operator left replaces nothing, and what focusing
 * a conversation marks read (the Bot Chat clears the bot but its listed
 * separate sessions' entries; a separate session only its own inbox entries).
 */
import type { ChatConversation, HermesChatClient, Session } from "@hermetic/core/chat-client";
import { encodeMobileLink } from "@hermetic/core/shared";
import { act, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Conversation from "../../app/chat/[instance]/[bot].tsx";
import { createHermeticClient } from "../../src/client/client.ts";
import { FleetContext, type FleetContextValue } from "../../src/fleet/FleetProvider.tsx";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import { FleetStore, memoryFile, memoryKv } from "../../src/fleet/store.ts";
import { InboxStore } from "../../src/inbox/store.ts";
import { fakeFetch, flush, json } from "../helpers/fakes.ts";
import { bot, inboxEntry, swarm } from "../helpers/fixtures.ts";
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

const NOW = "2026-10-13T12:00:00.000Z";

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

const session = (id: string, kind: Session["kind"]): Session => ({
  id,
  instance: "atlas",
  bot: "scribe",
  kind,
  origin: "portal",
  title: id,
  unread: 0,
  turn_count: 1,
});

/** Separate sessions made on the box after the test started. */
let madeSince: Session[] = [];

/** A box with one bot whose Bot Chat is `s-1`, beside a separate session `s-2`. */
function adapter(): HermesChatClient {
  return {
    token: async () => "FIXTURE",
    swarm: async (box) => swarm(box.instance, [bot({ unread: 2 })]),
    sessions: async () => [session("s-1", "canonical"), session("s-2", "thread"), ...madeSince],
    history: async () => [],
    conversation: async (box, b, o) =>
      ({
        instance: box.instance,
        bot: b,
        root_session: "s-1",
        session: o?.session ?? "s-1",
        kind: o?.session && o.session !== "s-1" ? "thread" : "canonical",
        created: false,
      }) as ChatConversation,
    send: () => (async function* () {})(),
    abort: async () => true,
    observe: (_box, _bot, o) =>
      (async function* () {
        await new Promise<void>((resolve) => o?.signal?.addEventListener("abort", () => resolve()));
      })(),
  };
}

async function setup(params: Record<string, string>) {
  mockParams = params;
  const read = readPairingLink(
    encodeMobileLink({
      fleet_id: "fxtr0001",
      alias: "main",
      account_id: "123456789012",
      region: "us-west-2",
      tailnet: "hermetic.ts.net",
      agents: [{ name: "atlas" }],
    }),
  );
  if (!read.ok) throw new Error("fixture link refused");
  const f = fakeFetch(() => json({}));
  const fleet = new FleetStore({
    secure: memoryKv(),
    viewCache: memoryFile(),
    fetch: f.fetch,
    now: () => NOW,
  });
  await fleet.pair(read.link);
  const inbox = new InboxStore(memoryFile(), () => NOW);
  for (const [s, n] of [
    ["s-1", 1],
    ["s-2", 2],
  ] as const) {
    const {
      id: _id,
      read_at: _read,
      ...arrival
    } = inboxEntry({
      session: s,
      dedupe: `atlas:${s}:${n}:turn.done`,
    });
    inbox.ingest(arrival);
  }
  const client = createHermeticClient({
    fleet,
    inbox,
    fetch: f.fetch,
    openSocket: () => {
      throw new Error("no socket in this test");
    },
    now: () => NOW,
    chat: adapter(),
  });
  await client.roster.refresh();
  const opened = deferred<{ instance: string; bot: string; session: string }>();
  const open = jest.spyOn(client.gateway, "open").mockImplementation(() => opened.promise as never);
  const chatOpen = jest.spyOn(client.chat, "open");
  const setWatched = jest.spyOn(client, "setWatched");
  const ctx = { client, focusConversation: jest.fn(), fleet } as unknown as FleetContextValue;
  const mount = async () => {
    const mounted = await renderUi(
      <SafeAreaProvider initialMetrics={METRICS}>
        <FleetContext.Provider value={ctx}>
          <Conversation />
        </FleetContext.Provider>
      </SafeAreaProvider>,
    );
    for (let i = 0; i < 5; i++) await act(flush);
    return mounted;
  };
  const view = await mount();
  return { client, inbox, open, chatOpen, setWatched, opened, view, mount };
}

const rosterUnread = (client: ReturnType<typeof createHermeticClient>) =>
  client.roster.getState().swarms[0]?.bots[0]?.unread;

beforeEach(() => {
  madeSince = [];
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
    const { client, open, chatOpen, setWatched, opened, inbox } = await setup({
      instance: "atlas",
      bot: "scribe",
      fresh: "1",
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ instance: "atlas", bot: "scribe", new_session: true });
    expect(chatOpen).not.toHaveBeenCalled();
    expect(setWatched).not.toHaveBeenCalled();
    expect(rosterUnread(client)).toBe(2);
    expect(unread(inbox)).toEqual(["s-1", "s-2"]);
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

describe("conversation: what focus marks read (the client's own setWatched)", () => {
  test("the Bot Chat clears the bot: roster unread and its own entries, not a separate session's", async () => {
    const { client, inbox, setWatched } = await setup({ instance: "atlas", bot: "scribe" });
    expect(setWatched).toHaveBeenLastCalledWith({
      instance: "atlas",
      bot: "scribe",
      session: null,
      resolved: "s-1",
      separate: ["s-2"],
      listedAt: expect.any(String),
      focused: true,
    });
    expect(rosterUnread(client)).toBe(0);
    expect(unread(inbox)).toEqual(["s-2"]);
  });

  test("reopened, the Bot Chat leaves a separate session made since it last listed them", async () => {
    const { inbox, view, mount } = await setup({ instance: "atlas", bot: "scribe" });
    expect(unread(inbox)).toEqual(["s-2"]);
    await view.unmount();
    // Off screen: a new separate session s-3 is made on the box, and its reply filed.
    madeSince = [session("s-3", "thread")];
    const {
      id: _id,
      read_at: _read,
      ...arrival
    } = inboxEntry({ session: "s-3", at: new Date().toISOString(), dedupe: "atlas:s-3:1:turn.done" });
    inbox.ingest(arrival);
    const again = await mount();
    expect(unread(inbox)).toEqual(["s-2", "s-3"]);
    await again.unmount();
  });

  test("a separate session clears only its own entries and leaves the Bot Chat's unread", async () => {
    const { client, inbox, view } = await setup({ instance: "atlas", bot: "scribe", session: "s-2" });
    expect(rosterUnread(client)).toBe(2);
    expect(unread(inbox)).toEqual(["s-1"]);
    // Leaving and coming back to the foreground on it reads nothing more.
    client.setPhase("inactive");
    client.setPhase("active");
    expect(rosterUnread(client)).toBe(2);
    expect(unread(inbox)).toEqual(["s-1"]);
    await view.unmount();
  });

  test("a ?session= that is the canonical one (a notification tap) counts as the Bot Chat", async () => {
    const { client, inbox } = await setup({ instance: "atlas", bot: "scribe", session: "s-1" });
    expect(rosterUnread(client)).toBe(0);
    expect(unread(inbox)).toEqual(["s-2"]);
  });
});
