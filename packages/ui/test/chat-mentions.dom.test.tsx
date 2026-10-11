/**
 * The `@`-mention list, driven through the real composers.
 *
 * The bot composer is mounted on its own for the keys, and inside the real
 * workspace once, so "the bot you are talking to is never offered" is the
 * workspace's own candidate list being observed. The room composer is mounted
 * over a fake gateway, because what it inserts is the member handle the
 * gateway's `resolve_mentions` matches. Bot lists are built here rather than
 * read from the fixture roster, whose titles move.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, userEvent, waitFor, within } from "./dom.ts";
import type { ChatSwarmsResult, SwarmView } from "../src/api/index.ts";
import { ChatProvider } from "../src/chat/chat-state.tsx";
import type { ChatApi } from "../src/chat/chat-state.tsx";
import type { MentionBot } from "../src/chat/chat-mentions.ts";
import { BotWorkspace } from "../src/chat/components/BotWorkspace.tsx";
import { Composer } from "../src/chat/components/Composer.tsx";
import { RoomConversation } from "../src/chat/components/RoomConversation.tsx";
import { botOf, PORTAL } from "./chat-fixtures.tsx";
import { fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";

afterEach(cleanup);
let server: FakeServer | null = null;
afterEach(() => {
  server?.restore();
  server = null;
});

const INSTANCE = "atlas";
const AT = "2026-09-18T12:00:00Z";
const mention = (name: string, title: string): MentionBot => ({ instance: INSTANCE, name, title });
const TEAM = [
  mention("mabel", "Mabel"),
  mention("scribe", "Marshall"),
  mention("auditor", "NickQABot"),
];

function composer(over: { sending?: boolean; onAbort?: () => void } = {}) {
  render(
    <Composer
      destination={PORTAL}
      placeholder="Message…"
      enabled
      sending={over.sending ?? false}
      onSend={() => {}}
      onAbort={over.onAbort ?? (() => {})}
      mentions={TEAM}
    />,
  );
  return screen.getByLabelText("Message…") as HTMLTextAreaElement;
}

const list = () => screen.queryByRole("listbox", { name: "Mention a bot" });
const rows = () => within(list()!).getAllByRole("option");
const highlighted = () => rows().find((row) => row.getAttribute("aria-selected") === "true");

describe("the bot composer's mention list", () => {
  test("@ma lists the matching teammates; ArrowDown then Enter inserts @marshall", async () => {
    const input = composer();
    await userEvent.type(input, "ask @ma");
    expect(rows().map((row) => row.textContent)).toEqual(["Mabel@mabel", "Marshall@marshall"]);
    expect(highlighted()?.textContent).toContain("Mabel");
    await userEvent.keyboard("{ArrowDown}");
    expect(highlighted()?.textContent).toContain("Marshall");
    await userEvent.keyboard("{Enter}");
    expect(input.value).toBe("ask @marshall ");
    expect(list()).toBeNull();
  });

  test("the highlight wraps, Tab accepts, and Space does not", async () => {
    const input = composer();
    await userEvent.type(input, "@");
    expect(rows()).toHaveLength(3);
    await userEvent.keyboard("{ArrowUp}");
    expect(highlighted()?.textContent).toContain("NickQABot");
    await userEvent.keyboard("{ArrowDown}");
    expect(highlighted()?.textContent).toContain("Mabel");
    await userEvent.keyboard("{Tab}");
    expect(input.value).toBe("@mabel ");

    await userEvent.clear(input);
    await userEvent.type(input, "@ma ");
    expect(input.value).toBe("@ma ");
    expect(list()).toBeNull();
  });

  test("a new set of rows puts the highlight back on the first", async () => {
    const input = composer();
    await userEvent.type(input, "@");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(highlighted()?.textContent).toContain("NickQABot");
    await userEvent.type(input, "m");
    expect(rows()).toHaveLength(2);
    expect(highlighted()?.textContent).toContain("Mabel");
  });

  test("Escape closes the list and does not stop the turn; typing reopens it", async () => {
    let aborted = 0;
    const input = composer({ sending: true, onAbort: () => aborted++ });
    await userEvent.type(input, "@ni");
    expect(rows()).toHaveLength(1);
    await userEvent.keyboard("{Escape}");
    expect(list()).toBeNull();
    expect(aborted).toBe(0);
    expect(input.value).toBe("@ni");
    await userEvent.type(input, "c");
    expect(rows().map((row) => row.textContent)).toEqual(["NickQABot@nickqabot"]);
  });

  test("an email address never opens it", async () => {
    const input = composer();
    await userEvent.type(input, "mail a@ma");
    expect(list()).toBeNull();
  });

  test("a click inserts the tag", async () => {
    const input = composer();
    await userEvent.type(input, "@n");
    fireEvent.click(rows()[0]!);
    expect(input.value).toBe("@nickqabot ");
  });

  test("leaving the textarea closes the list; typing again reopens it", async () => {
    const input = composer();
    await userEvent.type(input, "@ni");
    expect(rows()).toHaveLength(1);
    fireEvent.blur(input);
    expect(list()?.outerHTML).toBeUndefined();
    expect(input.value).toBe("@ni");
    await userEvent.type(input, "c");
    expect(rows().map((row) => row.textContent)).toEqual(["NickQABot@nickqabot"]);
  });

  test("a real mouse click on a row still picks it: the press keeps focus in the textarea", async () => {
    const input = composer();
    await userEvent.type(input, "@n");
    await userEvent.click(rows()[0]!);
    expect(input.value).toBe("@nickqabot ");
    expect(document.activeElement).toBe(input);
  });
});

describe("in the workspace", () => {
  test("the bot whose thread this is is never offered", async () => {
    server = fakeServer({});
    const swarm = {
      instance: INSTANCE,
      reachable: true,
      unreachable_reason: null,
      bots: [
        // Selected by default, so it is the bot the composer talks to.
        botOf(INSTANCE, "default", { title: "Lucy", is_default: true }),
        botOf(INSTANCE, "scribe", { title: "Marshall" }),
        botOf(INSTANCE, "auditor", { title: "NickQABot" }),
      ],
      rooms: [],
      warm_slots: { used: 1, total: 3 },
      sections: [],
    } as unknown as SwarmView;
    const api: ChatApi = {
      fetchSwarms: () => Promise.resolve({ swarms: [swarm] } as ChatSwarmsResult),
      fetchSessions: (instance: string, bot: string) =>
        Promise.resolve({ instance, bot, sessions: [] } as never),
      fetchHistory: (instance: string, bot: string) =>
        Promise.resolve({ instance, bot, session: null, messages: [] } as never),
      sendTurn: () => () => {},
      abortTurn: () => Promise.resolve({} as never),
    };
    const { container } = render(
      <ChatProvider api={api}>
        <BotWorkspace withContext={false} />
      </ChatProvider>,
    );
    const input = await waitFor(() => {
      const found = container.querySelector<HTMLTextAreaElement>(".ch-input");
      expect(found?.placeholder).toContain("Lucy");
      expect(found?.disabled).toBe(false);
      return found!;
    });
    await userEvent.type(input, "@");
    expect(rows().map((row) => row.textContent)).toEqual(["Marshall@marshall", "NickQABot@nickqabot"]);
  });
});

describe("the room composer", () => {
  test("offers the room's members and inserts the handle the gateway matches", async () => {
    server = fakeServer({
      "rooms.get": {
        instance: INSTANCE,
        id: "r1",
        name: "Standup",
        members: [
          { member_id: "m1", profile: "scribe", handle: "scribe", display_name: "Marshall" },
          { member_id: "m2", profile: "auditor", handle: "auditor", display_name: "NickQABot" },
        ],
        revision: 1,
        latest_seq: 0,
        created_at: AT,
        updated_at: AT,
        disbanded_at: null,
        working: false,
        blocked: false,
        pending_actions: [],
      },
      "rooms.history": { events: [], cursor: 0, has_more: false },
    });
    let draft = "";
    render(
      <RoomConversation
        instance={INSTANCE}
        id="r1"
        fleetId="fxtr0001"
        onDraft={(text) => (draft = text)}
        onPending={() => {}}
        onClosed={() => {}}
        onChanged={() => {}}
      />,
    );
    const input = screen.getByLabelText("Message the room") as HTMLTextAreaElement;
    await screen.findByText("Hosted on atlas. Discussion continues with this browser closed.");
    await waitFor(() => expect(screen.getAllByText("Marshall").length).toBeGreaterThan(0));
    await userEvent.type(input, "@");
    const members = () =>
      within(screen.getByRole("listbox", { name: "Mention a room member" })).getAllByRole("option");
    expect(members().map((row) => row.textContent)).toEqual(["Marshall@scribe", "NickQABot@auditor"]);
    await userEvent.type(input, "ma");
    expect(members()).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(input.value).toBe("@scribe ");
    expect(draft).toBe("@scribe ");
  });
});
