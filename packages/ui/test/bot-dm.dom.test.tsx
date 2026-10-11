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
import { findExchange } from "../src/chat/bot-dm.ts";
import { ProcessEventBlock } from "../src/chat/components/blocks/ProcessEvent.tsx";
import { eventOf } from "./process-event-fixtures.ts";

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

function dmCall(result: unknown, status: "ok" | "running" | "warn" | "bad" = "ok"): ChatBlockView {
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

/** Shifts `AT` by `ms`: the same instant, earlier or later. */
const atPlus = (ms: number) => new Date(Date.parse(AT) + ms).toISOString();

function delivery(
  id: string,
  from: { name: string; handle: string | null; connection?: string | null },
  at = AT,
  markdown = ASK,
): ChatMessageView {
  return {
    id,
    session: "s",
    role: "user",
    at,
    blocks: [{ kind: "text", markdown }],
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
        {
          ...dmCall(QUEUED),
          args: { target: "@ghost", message: ASK },
          result: { status: "queued" },
        } as ChatBlockView,
      ]),
    );
    const mark = container.querySelector(".ch-dm-mark");
    expect(mark?.textContent).toBe("Messagedghost");
    expect(mark?.querySelector(".ch-ava")).toBeNull();
  });

  test("a call history could not pair with its result is the tool row, not Messaging… forever", () => {
    // `hermes-chat-history.ts`: an unpaired call is `status: "warn", result: null`.
    const { container } = renderMessage(bot("m1", [dmCall(null, "warn")]));
    // The markup, not the node: a failed match on a node prints its whole fiber.
    expect(container.querySelector(".ch-dm-mark")?.outerHTML).toBeUndefined();
    expect(container.querySelector(".ch-activity")).not.toBeNull();
  });

  test("an ambiguous acknowledgement may not have been delivered, and expands to upstream's sentence", () => {
    const sentence = "Live admission outcome unknown: timed out. Do not resend.";
    const { container } = renderMessage(
      bot("m1", [dmCall({ status: "ambiguous", delivery_id: "dm-1", error: sentence }, "bad")]),
    );
    const mark = container.querySelector<HTMLDetailsElement>("details.ch-dm-mark.unsure");
    expect(mark?.querySelector("summary")?.textContent).toBe(
      "Message to NickQABot may not have been delivered",
    );
    expect(mark?.textContent).toContain(sentence);
    expect(container.textContent).not.toContain("Couldn't message");
    // Nothing to open: there may be no exchange at all.
    expect(mark?.querySelector("button")?.outerHTML).toBeUndefined();
  });

  test("every hand-off status is Messaged", () => {
    for (const status of ["queued", "claimed", "settled"]) {
      const { container } = renderMessage(bot("m1", [dmCall({ status, to: "@auditor" })]));
      expect(container.querySelector(".ch-dm-mark")?.textContent).toBe("MessagedNickQABot");
      cleanup();
    }
  });

  test("an acknowledgement shape this build does not know is the tool row", () => {
    for (const result of [{}, { status: "failed", delivery_id: "dm-1" }, { to: "@auditor" }]) {
      const { container } = renderMessage(bot("m1", [dmCall(result)]));
      expect(container.querySelector(".ch-dm-mark")?.outerHTML).toBeUndefined();
      expect(container.querySelector(".ch-activity")).not.toBeNull();
      cleanup();
    }
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

  test("a delivery relayed from another machine keeps its stamped name, not a local bot's", () => {
    // Handle `scribe` is a bot here too, but this one came over a connection.
    const { container } = renderMessage(
      delivery("d1", { name: "Remy", handle: "scribe", connection: "laptop" }),
      "auditor",
    );
    expect(container.querySelector(".ch-msg-who")?.textContent).toBe("Remy");
    expect(container.textContent).not.toContain("Marshall");
    expect(container.querySelector(".ch-dm-mark.from")?.textContent).toBe("Message from Remy ⇄");
  });
});

describe("the DM reply card", () => {
  const reply = (to_profile: string) => eventOf({ dm: { to_profile, reply: REPLY, warnings: [] } });
  const renderReply = (to_profile: string) =>
    render(
      <BotDmContext.Provider value={{ teammates: TEAM, open: () => {} }}>
        <ProcessEventBlock block={reply(to_profile)} />
      </BotDmContext.Provider>,
    );

  test("names the replier by its roster title, not its profile id", () => {
    const { container } = renderReply("auditor");
    expect(container.querySelector(".ch-ev-dm-head")?.textContent).toContain("NickQABot → ");
    expect(container.querySelector(".ch-ev-dm-head")?.textContent).not.toContain("auditor");
    expect(container.querySelector(".ch-ev-dm-who .ch-msg-who")?.textContent).toBe("NickQABot");
  });

  test("falls back to the profile id for a bot not on the roster", () => {
    const { container } = renderReply("stranger");
    expect(container.querySelector(".ch-ev-dm-head")?.textContent).toContain("stranger → ");
    expect(container.querySelector(".ch-ev-dm-who .ch-msg-who")?.textContent).toBe("stranger");
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
          // The same body sent by an earlier call, before this one was made.
          delivery("d0", { name: "Marshall", handle: "scribe" }, atPlus(-3_600_000)),
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
    // The delivery this call made is the one shown, not an older one of the same body.
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

  test("the same body sent twice opens the delivery its own call made", async () => {
    server = fakeServer({
      "chat.history": {
        instance: "atlas",
        bot: "auditor",
        session: "sx-auditor",
        messages: [
          delivery("d0", { name: "Marshall", handle: "scribe" }, atPlus(-3_600_000)),
          bot("r0", [{ kind: "text", markdown: "An older answer." }], "auditor"),
          delivery("d1", { name: "Marshall", handle: "scribe" }, atPlus(1_000)),
          bot("r1", [{ kind: "text", markdown: REPLY }], "auditor"),
          delivery("d2", { name: "Marshall", handle: "scribe" }, atPlus(600_000)),
          bot("r2", [{ kind: "text", markdown: "A later answer." }], "auditor"),
        ],
      },
    });
    renderThread("scribe", [bot("m1", [dmCall(QUEUED)])]);
    fireEvent.click(screen.getByRole("button", { name: /Messaged/ }));
    const dialog = screen.getByRole("dialog", { name: "Marshall ⇄ NickQABot" });
    await waitFor(() => expect(dialog.textContent).toContain(REPLY));
    expect(dialog.textContent).not.toContain("An older answer.");
    expect(dialog.textContent).not.toContain("A later answer.");
  });

  test("a target that is not a bot here says so instead of 'not in its Bot Chat yet'", () => {
    server = fakeServer({});
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
          dm: { to_profile: "ghost", reply: "Pass, from the notice.", warnings: [] },
          raw: "[IMPORTANT: …]",
        },
      ],
    } as ChatMessageView;
    const call = {
      ...dmCall({ status: "queued", process_id: "proc_a41c" }),
      args: { target: "@ghost", message: ASK },
    } as ChatBlockView;
    renderThread("scribe", [bot("m1", [call]), notice]);
    fireEvent.click(screen.getByRole("button", { name: /Messaged/ }));
    const dialog = screen.getByRole("dialog", { name: "Marshall ⇄ ghost" });
    expect(dialog.textContent).toContain(
      "ghost isn't a bot on this instance, so its side of the exchange can't be shown here.",
    );
    expect(dialog.textContent).not.toContain("Not in ghost's Bot Chat yet.");
    // The DM-reply notice still stands in for the reply.
    expect(dialog.textContent).toContain("Pass, from the notice.");
    expect(server.calls).toEqual([]);
  });

  test("a relayed sender opens an exchange with no link to a local Bot Chat", () => {
    server = fakeServer({});
    renderThread("auditor", [
      delivery("d1", { name: "Remy", handle: "scribe", connection: "laptop" }),
      bot("r1", [{ kind: "text", markdown: REPLY }], "auditor"),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Message from Remy/ }));
    const dialog = screen.getByRole("dialog", { name: "Remy ⇄ NickQABot" });
    expect(
      within(dialog).queryByRole("button", { name: /Open .*Bot Chat/ })?.textContent,
    ).toBeUndefined();
  });
});

describe("matching a delivery to its call", () => {
  const rows = (...bodies: [string, string][]) =>
    bodies.map(([id, body], i) =>
      delivery(id, { name: "Marshall", handle: "scribe" }, atPlus(i * 1_000), body),
    );

  test("a capped body still matches by prefix, from the call's time on", () => {
    const long = `${"x".repeat(40)} and then the rest of a long message`;
    const capped = long.slice(0, 30);
    const transcript = rows(["d0", capped], ["d1", capped]);
    expect(findExchange(transcript, "scribe", long, AT)?.delivery.id).toBe("d0");
    expect(findExchange(transcript, "scribe", long, atPlus(500))?.delivery.id).toBe("d1");
    expect(findExchange(transcript, "scribe", long, atPlus(5_000))).toBeNull();
  });

  test("a short body is never a prefix match", () => {
    const transcript = rows(["d0", "ok, merged and deployed it all"]);
    expect(findExchange(transcript, "scribe", "ok", AT)).toBeNull();
    expect(findExchange(rows(["d0", "ok"]), "scribe", "ok, merged and deployed", AT)).toBeNull();
  });
});
