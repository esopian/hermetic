/**
 * Renaming a bot from its thread header.
 *
 * The pencil edits the friendly title only: Enter sends `bots.update { title }`
 * and the header shows the roster's new answer, Escape leaves everything as it
 * was, a refusal stays on screen beside the field, and focus comes back to the
 * pencil either way. The workspace is mounted over a fake roster whose title is
 * whatever the last `bots.update` wrote, so "shows the new title" is the
 * roster refresh being observed, not the field echoing its own draft.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "./dom.ts";
import type { ChatSwarmsResult, SwarmView } from "../src/api/index.ts";
import { FormData as HappyFormData } from "happy-dom";
import { type ReactNode, useMemo } from "react";
import { ChatContext, ChatProvider, useChat } from "../src/chat/chat-state.tsx";
import type { ChatApi } from "../src/chat/chat-state.tsx";
import { BotWorkspace } from "../src/chat/components/BotWorkspace.tsx";
import { resetBotCapabilityMemo } from "../src/chat/bot-capabilities.ts";
import { errorBody, fakeServer } from "./fake-transport.ts";
import type { FakeServer, TransportCall } from "./fake-transport.ts";

afterEach(cleanup);
afterEach(resetBotCapabilityMemo);

const AT = "2026-09-18T12:00:00Z";
const INSTANCE = "atlas";
const BOT = "scribe";

function swarmOf(title: string | null): SwarmView {
  return {
    instance: INSTANCE,
    reachable: true,
    unreachable_reason: null,
    bots: [
      {
        instance: INSTANCE,
        name: BOT,
        title: title ?? BOT,
        description: "writes the digest",
        is_default: false,
        model: null,
        section: null,
        avatar_seed: `${INSTANCE}/${BOT}`,
        last_message_at: AT,
        unread: 0,
        needs_action: false,
        muted: false,
        warm: true,
      },
    ],
    rooms: [],
    warm_slots: { used: 1, total: 3 },
    sections: [],
  } as unknown as SwarmView;
}

let server: FakeServer | null = null;
afterEach(() => {
  server?.restore();
  server = null;
});

/**
 * The provider's own chat, except that a forced `refreshSwarms` — the read a
 * rename makes once its update is saved — rejects. The real one never does: it
 * catches its own failure and reports it as `swarmsError`, so a roster outage
 * at the fetch alone cannot tell whether the rename swallows a refresh that
 * throws.
 */
function RefreshRejects({ children }: { children: ReactNode }) {
  const chat = useChat();
  const value = useMemo(
    () => ({
      ...chat,
      refreshSwarms: (options?: { force?: boolean }) =>
        options?.force ? Promise.reject(new Error("roster read failed")) : chat.refreshSwarms(options),
    }),
    [chat],
  );
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

/**
 * Mounts the workspace; `refuse` makes every `bots.update` fail with that
 * message, `refreshRejects` the roster refresh after a saved rename.
 */
async function mount(refuse?: string, refreshRejects = false) {
  let title: string | null = "Marshall";
  server = fakeServer({
    "bots.update": (call: TransportCall) => {
      if (refuse) return errorBody("CONFLICT", refuse);
      title = (call.params as { title: string | null }).title;
      return { instance: INSTANCE, bot: BOT };
    },
  });
  const api: ChatApi = {
    fetchSwarms: () => Promise.resolve({ swarms: [swarmOf(title)] } as ChatSwarmsResult),
    fetchSessions: (instance: string, bot: string) =>
      Promise.resolve({ instance, bot, sessions: [] } as never),
    fetchHistory: (instance: string, bot: string) =>
      Promise.resolve({ instance, bot, session: null, messages: [] } as never),
    sendTurn: () => () => {},
    abortTurn: () => Promise.resolve({} as never),
  };
  const workspace = <BotWorkspace withContext={false} />;
  render(
    <ChatProvider api={api}>
      {refreshRejects ? <RefreshRejects>{workspace}</RefreshRejects> : workspace}
    </ChatProvider>,
  );
  await screen.findByText(/Canonical Bot Chat/);
  return server;
}

const header = () => {
  const found = document.querySelector<HTMLElement>(".ch-thead-name");
  if (!found) throw new Error("the thread header did not render");
  return found;
};
const pencil = () => screen.getByRole("button", { name: /^Rename / });
const field = () => screen.getByLabelText("Bot name") as HTMLInputElement;

describe("renaming a bot from its thread header", () => {
  test("Enter saves the title through bots.update and the header shows the roster's answer", async () => {
    const s = await mount();
    await waitFor(() => expect(header().textContent).toContain("Marshall"));
    fireEvent.click(pencil());
    expect(field().value).toBe("Marshall");
    fireEvent.change(field(), { target: { value: "  Archivist " } });
    fireEvent.submit(field().form as HTMLFormElement);
    await waitFor(() => expect(header().textContent).toContain("Archivist"));
    expect(s.to("bots.update").map((c) => c.params)).toEqual([
      expect.objectContaining({ instance: INSTANCE, bot: BOT, title: "Archivist" }),
    ]);
    expect(document.activeElement).toBe(pencil());
  });

  test("an empty field resets the title, and the header falls back to the profile name", async () => {
    const s = await mount();
    await waitFor(() => expect(header().textContent).toContain("Marshall"));
    fireEvent.click(pencil());
    fireEvent.change(field(), { target: { value: "   " } });
    fireEvent.submit(field().form as HTMLFormElement);
    await waitFor(() => expect(header().textContent).not.toContain("Marshall"));
    expect(header().textContent).toContain(BOT);
    expect(s.to("bots.update").map((c) => (c.params as { title: unknown }).title)).toEqual([null]);
  });

  test("Escape cancels without a request and gives focus back to the pencil", async () => {
    const s = await mount();
    await waitFor(() => expect(header().textContent).toContain("Marshall"));
    fireEvent.click(pencil());
    fireEvent.change(field(), { target: { value: "Something else" } });
    fireEvent.keyDown(field(), { key: "Escape", code: "Escape" });
    expect(screen.queryByLabelText("Bot name")).toBeNull();
    expect(header().textContent).toContain("Marshall");
    expect(document.activeElement).toBe(pencil());
    expect(s.to("bots.update")).toEqual([]);
  });

  test("a refused save keeps the field open with the reason beside it", async () => {
    await mount("scribe: its Bot Mode settings changed elsewhere since they were read");
    await waitFor(() => expect(header().textContent).toContain("Marshall"));
    fireEvent.click(pencil());
    fireEvent.change(field(), { target: { value: "Archivist" } });
    fireEvent.submit(field().form as HTMLFormElement);
    const alert = await screen.findByText(/changed elsewhere/);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(field().value).toBe("Archivist");
    expect(field().disabled).toBe(false);
  });

  test("a refused save hands focus back to the field it disabled", async () => {
    await mount("scribe: its Bot Mode settings changed elsewhere since they were read");
    await waitFor(() => expect(header().textContent).toContain("Marshall"));
    fireEvent.click(pencil());
    fireEvent.change(field(), { target: { value: "Archivist" } });
    // A browser drops focus from a field it disables; happy-dom keeps it, so
    // the drop is made here, before the submit that disables it.
    field().blur();
    expect(document.activeElement === field()).toBe(false);
    fireEvent.submit(field().form as HTMLFormElement);
    await screen.findByText(/changed elsewhere/);
    await waitFor(() => expect(field().disabled).toBe(false));
    expect(document.activeElement === field()).toBe(true);
  });

  test("a saved title whose roster refresh rejects is not a failed rename", async () => {
    const s = await mount(undefined, true);
    await waitFor(() => expect(header().textContent).toContain("Marshall"));
    fireEvent.click(pencil());
    fireEvent.change(field(), { target: { value: "Archivist" } });
    fireEvent.submit(field().form as HTMLFormElement);
    await waitFor(() => expect(screen.queryByLabelText("Bot name")?.outerHTML).toBeUndefined());
    expect(document.querySelector(".ch-title-error")?.textContent).toBeUndefined();
    expect(s.to("bots.update")).toHaveLength(1);
    expect(document.activeElement === pencil()).toBe(true);
  });
});

/** A capability sweep where every probe answered and every flag is on. */
const CAPABLE = {
  instance: INSTANCE,
  profiles: true,
  routines: true,
  hosted_rooms: true,
  room_driver: true,
  room_methods: [],
  protocol_version: 2,
  room_features: [],
  membership_edit: false,
  cross_instance_rooms: false,
  cross_instance_relay: false,
  reason: null,
  detail: { profiles: null, routines: null, hosted_rooms: null, room_driver: null },
  status: {
    profiles: "supported",
    routines: "supported",
    hosted_rooms: "supported",
    room_driver: "supported",
  },
};

/** Creates `librarian` through the dialog, typing `typed` as its friendly name; returns what `bots.create` was sent. */
async function createWithTitle(typed: string): Promise<Record<string, unknown>> {
  server?.restore();
  server = fakeServer({
    "bots.capabilities": CAPABLE,
    "bots.create": { instance: INSTANCE, bot: "librarian" },
    "chat.open": { instance: INSTANCE, bot: "librarian", session: "s1" },
  });
  const api: ChatApi = {
    fetchSwarms: () => Promise.resolve({ swarms: [swarmOf(null)] } as ChatSwarmsResult),
    fetchSessions: (instance: string, bot: string) =>
      Promise.resolve({ instance, bot, sessions: [] } as never),
    fetchHistory: (instance: string, bot: string) =>
      Promise.resolve({ instance, bot, session: null, messages: [] } as never),
    sendTurn: () => () => {},
    abortTurn: () => Promise.resolve({} as never),
  };
  render(
    <ChatProvider api={api}>
      <BotWorkspace withContext={false} />
    </ChatProvider>,
  );
  await screen.findByText(/Canonical Bot Chat/);
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  const title = (await screen.findByLabelText("Friendly name (optional)")) as HTMLInputElement;
  expect(title.maxLength).toBe(64);
  const form = title.form as HTMLFormElement;
  fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "librarian" } });
  fireEvent.change(title, { target: { value: typed } });
  const submit = () => within(form).getByRole("button", { name: /^Create bot$/ }) as HTMLButtonElement;
  await waitFor(() => expect(submit().disabled).toBe(false));
  fireEvent.submit(form);
  await waitFor(() => expect(server?.to("bots.create")).toHaveLength(1));
  const params = server?.to("bots.create")[0]?.params as Record<string, unknown>;
  cleanup();
  return params;
}

describe("naming a bot as it is created", () => {
  /**
   * Desktop's create dialog asks for a title beside the profile name; this one
   * does too, and sends it trimmed — or not at all when the field is blank.
   */
  test("the friendly name goes to bots.create beside the profile name", async () => {
    // `setup.ts` keeps bun's own `FormData`, which reads nothing from a
    // happy-dom form; the dialog's submit reads its fields through happy-dom's.
    const native = globalThis.FormData;
    globalThis.FormData = HappyFormData as unknown as typeof FormData;
    try {
      const named = await createWithTitle("  Head Librarian ");
      expect(named).toMatchObject({ name: "librarian", title: "Head Librarian" });
      const blank = await createWithTitle("   ");
      expect(blank.name).toBe("librarian");
      expect(blank).not.toHaveProperty("title");
    } finally {
      globalThis.FormData = native;
    }
  });
});
