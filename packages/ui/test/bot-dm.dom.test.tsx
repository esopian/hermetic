/**
 * Bot-to-bot DMs in the thread (`bot-dm.ts`, `BotDm.tsx`, `BotExchange.tsx`):
 * the sender's `message_agent` call is a "Messaged <bot>" line rather than a
 * tool step, the receiver's delivery row is the sending bot speaking, and
 * either end opens one exchange showing both halves.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "./dom.ts";
import { fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";
import type { ChatBlockView, ChatMessageView } from "../src/api/index.ts";
import { Message } from "../src/chat/components/Message.tsx";
import { Thread } from "../src/chat/components/Thread.tsx";
import { BotDmContext } from "../src/chat/components/BotDm.tsx";

let server: FakeServer | null = null;
afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
});

const NOW = Date.parse("2026-09-17T12:00:00Z");
const AT = new Date(NOW - 60_000).toISOString();

const TEAM = [
  { instance: "atlas", name: "default", title: "atlas", is_default: true },
  { instance: "atlas", name: "scribe", title: "Marshall" },
  { instance: "atlas", name: "auditor", title: "NickQABot" },
];

const ASK = "Please re-QA #4124 at e4cf2ec.";
const REPLY = "Re-QA of #4124: pass.";

function dmCall(result: unknown, status: "ok" | "running" | "bad" = "ok"): ChatBlockView {
  return {
    kind: "tool",
    name: "message_agent",
    tool_id: "call-dm",
    status,
    args: { target: "@nickqabot", message: ASK },
    result,
    render: "message_agent",
  };
}

const QUEUED = JSON.stringify({
  status: "queued",
  to: "@auditor",
  process_id: "proc_a41c",
  reply_delivery: "notification",
});

function bot(id: string, blocks: ChatBlockView[], author = "scribe"): ChatMessageView {
  return {
    id,
    session: "s",
    role: "bot",
    author: { instance: "atlas", bot: author },
    at: AT,
    blocks,
  } as ChatMessageView;
}

function delivery(id: string, from: { name: string; handle: string | null }): ChatMessageView {
  return {
    id,
    session: "s",
    role: "user",
    at: AT,
    blocks: [{ kind: "text", markdown: ASK }],
    from_bot: from,
  } as ChatMessageView;
}

function renderMessage(message: ChatMessageView, bot_ = "scribe") {
  return render(
    <BotDmContext.Provider value={{ teammates: TEAM, open: () => {} }}>
      <Message
        row={{ message, continuation: false, divider: null }}
        fleetId="fxtr0001"
        instance="atlas"
        bot={bot_}
        botTitle={TEAM.find((b) => b.name === bot_)?.title ?? null}
        status="ready"
        now={NOW}
      />
    </BotDmContext.Provider>,
  );
}

function renderThread(bot_: string, messages: ChatMessageView[]) {
  return render(
    <Thread
      fleetId="fxtr0001"
      instance="atlas"
      bot={bot_}
      botTitle={TEAM.find((b) => b.name === bot_)?.title ?? null}
      agent={null}
      session={null}
      destination={{ state: "known", origin: "portal", detail: null }}
      state="ready"
      messages={messages}
      live={null}
      sending={false}
      historyError={null}
      now={NOW}
      onSend={() => {}}
      onAbort={() => {}}
      teammates={TEAM}
    />,
  );
}

describe("the sender's message_agent call", () => {
  test("is a Messaged line between the prose, not a tool step", () => {
    const { container } = renderMessage(
      bot("m1", [
        { kind: "text", markdown: "I'll check CI first." },
        dmCall(QUEUED),
        { kind: "text", markdown: "I've started the re-QA." },
      ]),
    );
    const mark = container.querySelector<HTMLElement>(".ch-dm-mark");
    expect(mark?.textContent).toBe("MessagedNickQABot");
    expect(within(mark!).getByRole("button")).toBeTruthy();
    // No tool group, no step naming the tool.
    expect(container.querySelector(".ch-activity")).toBeNull();
    expect(container.textContent).not.toContain("message_agent");
    // In turn order: after the first paragraph and before the second.
    const body = container.querySelector(".ch-msg-body")?.textContent ?? "";
    expect(body.indexOf("check CI")).toBeLessThan(body.indexOf("Messaged"));
    expect(body.indexOf("Messaged")).toBeLessThan(body.indexOf("started the re-QA"));
    // The delivery's process is its anchor, so the DM-reply event can link back.
    expect(mark?.id).toBe("ch-start-proc_a41c");
  });

  test("says Messaging… while the call runs", () => {
    const { container } = renderMessage(bot("m1", [dmCall(null, "running")]));
    expect(container.querySelector(".ch-dm-mark")?.textContent).toBe("MessagingNickQABot…");
  });

  test("a refused call is a warn line that expands to upstream's sentence", () => {
    const { container } = renderMessage(
      bot("m1", [
        dmCall({ error: "NickQABot is busy with another turn.", reason: "target_busy" }, "bad"),
      ]),
    );
    const mark = container.querySelector<HTMLDetailsElement>("details.ch-dm-mark.failed");
    expect(mark?.querySelector("summary")?.textContent).toBe(
      "Couldn't message NickQABot · target_busy",
    );
    expect(mark?.textContent).toContain("NickQABot is busy with another turn.");
    expect(mark?.querySelector("button")).toBeNull();
  });

  test("a result that is not upstream's JSON falls back to the tool row", () => {
    const { container } = renderMessage(bot("m1", [dmCall("delivery spawn crashed")]));
    expect(container.querySelector(".ch-dm-mark")).toBeNull();
    expect(container.querySelector(".ch-activity")).not.toBeNull();
  });

  test("an unknown target shows the raw text, with no face", () => {
    const { container } = renderMessage(
      bot("m1", [
        { ...dmCall(QUEUED), args: { target: "@ghost", message: ASK }, result: "{}" } as ChatBlockView,
      ]),
    );
    const mark = container.querySelector(".ch-dm-mark");
    expect(mark?.textContent).toBe("Messagedghost");
    expect(mark?.querySelector(".ch-ava")).toBeNull();
  });
});

describe("the receiver's delivery row", () => {
  test("is the sending bot speaking, not You", () => {
    const { container } = renderMessage(
      delivery("d1", { name: "Marshall", handle: "scribe" }),
      "auditor",
    );
    const article = container.querySelector("article.ch-msg");
    expect(article?.classList.contains("me")).toBe(false);
    expect(container.querySelector(".ch-msg-who")?.textContent).toBe("Marshall");
    expect(container.textContent).not.toContain("You");
    expect(container.querySelector(".ch-avatar.me")).toBeNull();
    expect(container.querySelector(".ch-dm-mark.from")?.textContent).toBe("Message from Marshall ⇄");
    expect(container.querySelector(".ch-msg-body")?.textContent).toContain(ASK);
  });
});

describe("the exchange", () => {
  test("opens from the sender's marker with the reply read from the target's Bot Chat; Esc closes it", async () => {
    server = fakeServer({
      "chat.history": (call: { params: Record<string, unknown> }) => ({
        instance: "atlas",
        bot: call.params["bot"],
        session: "sx-auditor",
        messages: [
          delivery("d0", { name: "Marshall", handle: "scribe" }),
          bot("r0", [{ kind: "text", markdown: "An older answer." }], "auditor"),
          delivery("d1", { name: "Marshall", handle: "scribe" }),
          bot("r1", [{ kind: "text", markdown: REPLY }], "auditor"),
          { ...delivery("u1", { name: "x", handle: null }), from_bot: null },
        ],
      }),
    });
    renderThread("scribe", [bot("m1", [dmCall(QUEUED)])]);
    const marker = screen.getByRole("button", { name: /Messaged/ });
    marker.focus();
    fireEvent.click(marker);
    const dialog = screen.getByRole("dialog", { name: "Marshall ⇄ NickQABot" });
    await waitFor(() => expect(dialog.textContent).toContain(REPLY));
    expect(server.to("chat.history")[0]?.params).toMatchObject({ instance: "atlas", bot: "auditor" });
    // The sender's half, attributed to the sender; the reply to the target.
    const whos = Array.from(dialog.querySelectorAll(".ch-msg-who")).map((n) => n.textContent);
    expect(whos).toEqual(["Marshall", "NickQABot"]);
    expect(dialog.textContent).toContain(ASK);
    // The latest delivery of the same body is the one shown, not an older one.
    expect(dialog.textContent).not.toContain("An older answer.");
    expect(within(dialog).getByRole("button", { name: "Open NickQABot's Bot Chat" })).toBeTruthy();
    // Focus moved in; Escape closes and hands it back to the marker.
    expect(dialog.contains(document.activeElement)).toBe(true);
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Messaged/ }));
  });

  test("a delivery not in the target's Bot Chat yet falls back to the reply notice", async () => {
    server = fakeServer({
      "chat.history": { instance: "atlas", bot: "auditor", session: null, messages: [] },
    });
    const notice = {
      id: "e1",
      session: "s",
      role: "system",
      at: AT,
      blocks: [
        {
          kind: "process_event",
          event: "completion",
          outcome: "ok",
          process_id: "proc_a41c",
          dm: { to_profile: "auditor", reply: "Pass, from the notice.", warnings: [] },
          raw: "[IMPORTANT: …]",
        },
      ],
    } as ChatMessageView;
    renderThread("scribe", [bot("m1", [dmCall(QUEUED)]), notice]);
    fireEvent.click(screen.getByRole("button", { name: /Messaged/ }));
    const dialog = screen.getByRole("dialog", { name: "Marshall ⇄ NickQABot" });
    await waitFor(() => expect(dialog.textContent).toContain("Not in NickQABot's Bot Chat yet."));
    expect(dialog.textContent).toContain("Pass, from the notice.");
  });

  test("opens from the receiver's marker with the reply already in the thread", () => {
    server = fakeServer({});
    renderThread("auditor", [
      delivery("d1", { name: "Marshall", handle: "scribe" }),
      bot("r1", [{ kind: "text", markdown: REPLY }], "auditor"),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Message from Marshall/ }));
    const dialog = screen.getByRole("dialog", { name: "Marshall ⇄ NickQABot" });
    expect(dialog.textContent).toContain(ASK);
    expect(dialog.textContent).toContain(REPLY);
    expect(within(dialog).getByRole("button", { name: "Open Marshall's Bot Chat" })).toBeTruthy();
    // Nothing was read: both halves were already here.
    expect(server.calls).toEqual([]);
  });
});
