/**
 * The conversation route around its own effects, over a real client (its
 * `setWatched`, roster and inbox; the box faked at the adapter): a `?fresh=1`
 * open that lands after the operator left replaces nothing, and what focusing
 * a conversation marks read (the Bot Chat clears the bot but its listed
 * separate sessions' entries; a separate session only its own inbox entries),
 * and the fixture's demo prompts (the overflow entry and `?demo=`, both absent
 * without the fixture), and its attachment links (`?attach=`, `&send=`,
 * `?attachSheet=1`, absent without it too).
 */
import {
  type ChatConversation,
  HermeticError,
  type HermesChatClient,
  type Session,
} from "@hermetic/core/chat-client";
import type { FilesStageResult } from "@hermetic/core/schema";
import { encodeMobileLink } from "@hermetic/core/shared";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { ActionSheetIOS } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Conversation from "../../app/chat/[instance]/[bot].tsx";
import { createHermeticClient } from "../../src/client/client.ts";
import { FleetContext, type FleetContextValue } from "../../src/fleet/FleetProvider.tsx";
import type { PhoneFiles } from "../../src/gateway/files.ts";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import { FleetStore, memoryFile, memoryKv } from "../../src/fleet/store.ts";
import { InboxStore } from "../../src/inbox/store.ts";
import { fakeFetch, flush, json } from "../helpers/fakes.ts";
import { bot, inboxEntry, swarm } from "../helpers/fixtures.ts";
import { renderUi } from "../helpers/render.tsx";

jest.mock("react-native-keyboard-controller", () => require("react-native-keyboard-controller/jest"));
// A picked file's bytes (`readBytes`, `src/client/pick-attachment.ts`).
jest.mock("expo-file-system", () => ({
  File: class {
    async bytes() {
      return new Uint8Array([1, 2, 3]);
    }
  },
}));

/** The composer's latest props: its handlers, to call the way a double tap would. */
let mockComposer: { onSend(text: string): void } | null = null;
jest.mock("../../src/chat/Composer.tsx", () => {
  const actual = jest.requireActual("../../src/chat/Composer.tsx");
  const { createElement } = require("react");
  return {
    ...actual,
    Composer: (props: { onSend(text: string): void }) => {
      mockComposer = props;
      return createElement(actual.Composer, props);
    },
  };
});

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
/** Every prompt the box was sent, in order. */
let sentTexts: string[] = [];
/** What each prompt carried as attachments (`null` for none), in the same order. */
let sentAttachments: unknown[] = [];
/** Hold every turn open until it is stopped, so the conversation stays busy. */
let holdTurns = false;

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
    send: (_box, _bot, text, opts) => {
      sentTexts.push(text);
      sentAttachments.push(opts?.attachments ?? null);
      const hold = holdTurns;
      return (async function* () {
        if (hold)
          await new Promise<void>((resolve) =>
            opts?.signal?.addEventListener("abort", () => resolve()),
          );
      })();
    },
    abort: async () => true,
    observe: (_box, _bot, o) =>
      (async function* () {
        await new Promise<void>((resolve) => o?.signal?.addEventListener("abort", () => resolve()));
      })(),
  };
}

async function setup(params: Record<string, string>, extra: Partial<FleetContextValue> = {}) {
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
  await fleet.setPrimary("atlas");
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
  const ctx = { client, focusConversation: jest.fn(), fleet, ...extra } as unknown as FleetContextValue;
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
  sentTexts = [];
  sentAttachments = [];
  holdTurns = false;
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

/** A box's files service: staged ids in order, and the fixture's too-large name refused. */
function phoneFiles() {
  const stage: jest.Mock<
    Promise<FilesStageResult>,
    [{ name: string; bytes: Uint8Array; session_id?: string }]
  > = jest.fn(async (input) => {
    if (input.name.includes("E2E_FILE_TOO_LARGE"))
      throw new HermeticError("FILE_TOO_LARGE", "the file is larger than the box takes");
    return {
      id: `f-${stage.mock.calls.length}`,
      name: input.name,
      bytes: input.bytes.byteLength,
      mime: "application/pdf",
      sha256: "0".repeat(64),
      class: "document",
      expires_at: NOW,
    } as unknown as FilesStageResult;
  });
  const files: PhoneFiles = {
    capability: async () => true,
    stage,
    commit: jest.fn(async () => {
      throw new Error("not committed in this test");
    }) as unknown as PhoneFiles["commit"],
    requests: jest.fn(),
    request: jest.fn(),
    fulfil: jest.fn(),
    secret: jest.fn(),
    decline: jest.fn(),
    content: jest.fn(),
  };
  return { files, stage };
}

describe("conversation: attachments", () => {
  const documentPicker: { getDocumentAsync: jest.Mock } = require("expo-document-picker");

  async function pickFile(name: string) {
    documentPicker.getDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ name, uri: `file:///tmp/${name}`, mimeType: "application/pdf", size: 3 }],
    });
    const sheet = jest
      .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
      .mockImplementation((_options, pick) => pick(2));
    await fireEvent.press(screen.getByLabelText("Attach"));
    for (let i = 0; i < 3; i++) await act(flush);
    sheet.mockRestore();
  }

  test("a picked file is staged on the box and sent with the message", async () => {
    const { files, stage } = phoneFiles();
    const { client } = await setup({ instance: "atlas", bot: "scribe" }, { files: () => files });
    const send = jest.spyOn(client.chat, "sendMessage");
    await pickFile("report.pdf");
    expect(screen.getByText("report.pdf")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Send"));
    for (let i = 0; i < 5; i++) await act(flush);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage.mock.calls[0]?.[0]).toMatchObject({ name: "report.pdf", session_id: "s-1" });
    expect(send).toHaveBeenCalledTimes(1);
    const [target, text, attachments] = send.mock.calls[0] ?? [];
    expect(target).toMatchObject({ instance: "atlas", bot: "scribe" });
    expect(text).toBe("");
    expect(attachments?.ids).toEqual(["f-1"]);
    expect(attachments?.staged?.map((f) => f.name)).toEqual(["report.pdf"]);
    // Sent: the tray is empty again.
    expect(screen.queryByTestId("attach-tray")).toBeNull();
  });

  test("while a file uploads the tray is locked, and what is sent is what the tray holds", async () => {
    const { files, stage } = phoneFiles();
    const second = deferred<void>();
    const real = stage.getMockImplementation()!;
    stage.mockImplementation(async (input) => {
      if (input.name === "b.pdf") await second.promise;
      return real(input);
    });
    const { client } = await setup({ instance: "atlas", bot: "scribe" }, { files: () => files });
    const send = jest.spyOn(client.chat, "sendMessage");
    await pickFile("a.pdf");
    await pickFile("b.pdf");
    await fireEvent.press(screen.getByLabelText("Send"));
    for (let i = 0; i < 5; i++) await act(flush);
    // a.pdf is on the box, b.pdf still uploading: neither can leave, none can join.
    expect(screen.getByLabelText("Remove a.pdf").props.accessibilityState.disabled).toBe(true);
    expect(screen.getByLabelText("Attach").props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByLabelText("Remove a.pdf"));
    await act(async () => second.resolve());
    for (let i = 0; i < 5; i++) await act(flush);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[2]?.ids).toEqual(["f-1", "f-2"]);
    expect(screen.queryByTestId("attach-tray")).toBeNull();
  });

  test("a double tap within one frame stages and sends once", async () => {
    const { files, stage } = phoneFiles();
    const { client } = await setup({ instance: "atlas", bot: "scribe" }, { files: () => files });
    const send = jest.spyOn(client.chat, "sendMessage");
    await pickFile("a.pdf");
    // Both taps reach the same handler before React draws the first one's Uploading….
    const onSend = mockComposer!.onSend;
    await act(async () => {
      onSend("");
      onSend("");
    });
    for (let i = 0; i < 5; i++) await act(flush);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("leaving mid-upload stops it, and nothing is sent after the screen is gone", async () => {
    const { files, stage } = phoneFiles();
    const held = deferred<void>();
    const real = stage.getMockImplementation()!;
    let signal: AbortSignal | undefined;
    stage.mockImplementation(async (input) => {
      signal = (input as { signal?: AbortSignal }).signal;
      await held.promise;
      return real(input);
    });
    const { client, view } = await setup({ instance: "atlas", bot: "scribe" }, { files: () => files });
    const send = jest.spyOn(client.chat, "sendMessage");
    await pickFile("a.pdf");
    await fireEvent.press(screen.getByLabelText("Send"));
    for (let i = 0; i < 3; i++) await act(flush);
    expect(signal?.aborted).toBe(false);
    await view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => held.resolve());
    for (let i = 0; i < 5; i++) await act(flush);
    expect(send).not.toHaveBeenCalled();
  });

  test("a file whose upload expired while it waited fails with Retry, and Retry stages it again", async () => {
    const { files, stage } = phoneFiles();
    const { client } = await setup({ instance: "atlas", bot: "scribe" }, { files: () => files });
    // A turn started while the file uploaded: the file stays in the tray, staged.
    const send = jest.spyOn(client.chat, "sendMessage").mockReturnValueOnce(false);
    await pickFile("a.pdf");
    await fireEvent.press(screen.getByLabelText("Send"));
    for (let i = 0; i < 5; i++) await act(flush);
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByText("a.pdf")).toBeTruthy();
    // The phone's files expire at the test's NOW, long gone by the real clock.
    await fireEvent.press(screen.getByLabelText("Send"));
    for (let i = 0; i < 3; i++) await act(flush);
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByText("The attachment expired on the box.")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Retry a.pdf"));
    await fireEvent.press(screen.getByLabelText("Send"));
    for (let i = 0; i < 5; i++) await act(flush);
    expect(stage).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[2]?.ids).toEqual(["f-2"]);
  });

  test("with a turn running, a message with files is not queued: words and files wait", async () => {
    const { files } = phoneFiles();
    const { client } = await setup({ instance: "atlas", bot: "scribe" }, { files: () => files });
    holdTurns = true;
    await act(async () => {
      client.chat.sendMessage({ instance: "atlas", bot: "scribe", session: null }, "first");
    });
    for (let i = 0; i < 5; i++) await act(flush);
    const enqueue = jest.spyOn(client.chat, "enqueue");
    await pickFile("report.pdf");
    await fireEvent.changeText(screen.getByLabelText("Message"), "and this");
    expect(screen.getByText(/Files wait for the running turn to finish/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Queue"));
    for (let i = 0; i < 3; i++) await act(flush);
    expect(enqueue).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message").props.value).toBe("and this");
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(sentTexts).toEqual(["first"]);
  });

  test("a file the box refuses as too large stays in the tray with its copy; nothing is sent", async () => {
    const { files } = phoneFiles();
    const { client } = await setup({ instance: "atlas", bot: "scribe" }, { files: () => files });
    const send = jest.spyOn(client.chat, "sendMessage");
    await pickFile("E2E_FILE_TOO_LARGE.bin");
    await fireEvent.changeText(screen.getByLabelText("Message"), "see attached");
    await fireEvent.press(screen.getByLabelText("Send"));
    for (let i = 0; i < 5; i++) await act(flush);
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByText("That file is too large to attach.")).toBeTruthy();
    expect(screen.getByLabelText("Send").props.accessibilityState.disabled).toBe(true);
    // The words come back into the composer.
    expect(screen.getByLabelText("Message").props.value).toBe("see attached");
  });
});

describe("conversation: demo prompts (fixture builds only)", () => {
  const fixture = {
    link: "hermetic://fleet?v=2",
    tailscale: { get: () => "ok" as const, set: jest.fn() },
    setTailscale: jest.fn(),
    demoPrompts: [{ group: "Text", label: "Plain", prompt: "say something" }],
  };

  function menuOptions(): string[] {
    let seen: string[] = [];
    const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation((o) => {
      seen = o.options;
    });
    fireEvent.press(screen.getByLabelText("More"));
    sheet.mockRestore();
    return seen;
  }

  test("?demo= sends the prompt once the transcript is read, then drops the parameter", async () => {
    await setup({ instance: "atlas", bot: "scribe", demo: "say something" }, {
      fixture,
    } as unknown as Partial<FleetContextValue>);
    for (let i = 0; i < 5; i++) await act(flush);
    expect(sentTexts).toEqual(["say something"]);
    expect(mockRouter.setParams).toHaveBeenCalledWith({ demo: undefined });
  });

  test("a build without the fixture ignores ?demo=", async () => {
    await setup({ instance: "atlas", bot: "scribe", demo: "say something" }, { fixture: null });
    for (let i = 0; i < 5; i++) await act(flush);
    expect(sentTexts).toEqual([]);
    expect(mockRouter.setParams).not.toHaveBeenCalledWith({ demo: undefined });
  });

  test("the overflow menu offers Demo prompts… with the fixture's list, and not without", async () => {
    await setup({ instance: "atlas", bot: "scribe" }, {
      fixture,
    } as unknown as Partial<FleetContextValue>);
    expect(menuOptions()).toContain("Demo prompts…");
    await setup({ instance: "atlas", bot: "scribe" }, { fixture: null });
    expect(menuOptions()).not.toContain("Demo prompts…");
  });
});

describe("conversation: attachment links (fixture builds only)", () => {
  const SAMPLES = [
    {
      name: "fixture-sample.png",
      uri: "file:///cache/fixture-sample.png",
      mime: "image/png",
      size: 3,
      kind: "image",
    },
    {
      name: "fixture-notes.txt",
      uri: "file:///cache/fixture-notes.txt",
      mime: "text/plain",
      size: 3,
      kind: "file",
    },
  ] as const;
  const fixture = {
    link: "hermetic://fleet?v=2",
    tailscale: { get: () => "ok" as const, set: jest.fn() },
    setTailscale: jest.fn(),
    demoPrompts: [{ group: "Text", label: "Plain", prompt: "say something" }],
    sampleFiles: async () => SAMPLES.map((f) => ({ ...f })),
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await act(flush);
  };

  test("?attach=image,file puts the canned files in the tray, once", async () => {
    const { files } = phoneFiles();
    await setup({ instance: "atlas", bot: "scribe", attach: "image,file" }, {
      fixture,
      files: () => files,
    } as unknown as Partial<FleetContextValue>);
    await settle();
    expect(screen.getByTestId("attach-tray")).toBeTruthy();
    expect(screen.getByLabelText("Remove fixture-sample.png")).toBeTruthy();
    expect(screen.getByLabelText("Remove fixture-notes.txt")).toBeTruthy();
    expect(mockRouter.setParams).toHaveBeenCalledWith({ attach: undefined });
    expect(sentTexts).toEqual([]);
  });

  test("&send= sends them through the Send path, staged first", async () => {
    const { files, stage } = phoneFiles();
    await setup({ instance: "atlas", bot: "scribe", attach: "image,file", send: "look at these" }, {
      fixture,
      files: () => files,
    } as unknown as Partial<FleetContextValue>);
    await settle();
    expect(stage.mock.calls.map((c) => c[0].name)).toEqual(["fixture-sample.png", "fixture-notes.txt"]);
    // One turn, with the text and both staged ids.
    expect(sentTexts).toEqual(["look at these"]);
    expect(sentAttachments).toEqual([expect.objectContaining({ ids: ["f-1", "f-2"] })]);
    expect(mockRouter.setParams).toHaveBeenCalledWith({ send: undefined });
    expect(screen.queryByTestId("attach-tray")).toBeNull();
  });

  test("?attachSheet=1 opens the attach sheet once", async () => {
    const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation(() => {});
    await setup({ instance: "atlas", bot: "scribe", attachSheet: "1" }, {
      fixture,
    } as unknown as Partial<FleetContextValue>);
    await settle();
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(sheet.mock.calls[0]?.[0]).toMatchObject({ title: "Attach" });
    expect(mockRouter.setParams).toHaveBeenCalledWith({ attachSheet: undefined });
    sheet.mockRestore();
  });

  test("a build without the fixture ignores all three", async () => {
    const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation(() => {});
    const { files, stage } = phoneFiles();
    await setup(
      { instance: "atlas", bot: "scribe", attach: "image,file", send: "look", attachSheet: "1" },
      { fixture: null, files: () => files },
    );
    await settle();
    expect(screen.queryByTestId("attach-tray")).toBeNull();
    expect(stage).not.toHaveBeenCalled();
    expect(sentTexts).toEqual([]);
    expect(sheet).not.toHaveBeenCalled();
    expect(mockRouter.setParams).not.toHaveBeenCalled();
    sheet.mockRestore();
  });
});
