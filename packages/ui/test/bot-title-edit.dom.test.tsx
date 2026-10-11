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
import { cleanup, fireEvent, render, screen, waitFor } from "./dom.ts";
import type { ChatSwarmsResult, SwarmView } from "../src/api/index.ts";
import { ChatProvider } from "../src/chat/chat-state.tsx";
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

/** Mounts the workspace; `refuse` makes every `bots.update` fail with that message. */
async function mount(refuse?: string) {
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
  render(
    <ChatProvider api={api}>
      <BotWorkspace withContext={false} />
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
});
