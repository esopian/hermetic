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
import { DELIVERY_SKEW_MS, findExchange } from "../src/chat/bot-dm.ts";
import { DM_FAILURE_REASONS } from "../src/chat/bot-dm-reasons.ts";
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

function renderThread(
  bot_: string,
  messages: ChatMessageView[],
  opts: { onSend?: (text: string) => void; state?: "ready" | "stopped" } = {},
) {
  return render(threadOf(bot_, messages, opts));
}

function threadOf(
  bot_: string,
  messages: ChatMessageView[],
  opts: { onSend?: (text: string) => void; state?: "ready" | "stopped" } = {},
) {
  return (
    <Thread
      fleetId="fxtr0001"
      instance="atlas"
      bot={bot_}
      botTitle={TEAM.find((b) => b.name === bot_)?.title ?? null}
      agent={null}
      session={null}
      destination={{ state: "known", origin: "portal", detail: null }}
      state={opts.state ?? "ready"}
      messages={messages}
      live={null}
      sending={false}
      historyError={null}
      now={NOW}
      onSend={opts.onSend ?? (() => {})}
      onAbort={() => {}}
      teammates={TEAM}
    />
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

  test("a refused call is a warn line that expands to the reason, upstream's sentence and the teammates", () => {
    const { container } = renderMessage(
      bot("m1", [
        dmCall(
          {
            error: "No teammate named 'nickqa' on this install.",
            reason: "unknown",
            teammates: ["auditor", "hermes"],
            peers: [],
          },
          "bad",
        ),
      ]),
    );
    const mark = container.querySelector<HTMLElement>(".ch-dm-mark.failed");
    expect(mark?.querySelector("summary")?.textContent).toBe("Couldn't message NickQABot · failed");
    const body = mark?.querySelector("details")?.textContent ?? "";
    expect(body).toContain(DM_FAILURE_REASONS["unknown"]!.guidance);
    expect(body).toContain("No teammate named 'nickqa' on this install.");
    expect(body).toContain("Teammates: @auditor, @hermes");
    // An empty list is no line at all.
    expect(body).not.toContain("Peers");
    // No retry for a reason a second send cannot fix, nor where nothing can send.
    expect(within(mark!).queryByRole("button", { name: "Retry" })?.outerHTML).toBeUndefined();
  });

  test("every reason code reads as its label; an unknown or absent one as 'failed'", () => {
    const cases: [unknown, string][] = [
      ...Object.entries(DM_FAILURE_REASONS).map(([code, r]) => [code, r.label] as [unknown, string]),
      ["flux_capacitor", "failed"],
      [undefined, "failed"],
    ];
    for (const [reason, label] of cases) {
      const { container } = renderMessage(
        bot("m1", [dmCall({ error: "Delivery failed.", ...(reason ? { reason } : {}) }, "bad")]),
      );
      expect(container.querySelector(".ch-dm-mark.failed summary")?.textContent).toBe(
        `Couldn't message NickQABot · ${label}`,
      );
      cleanup();
    }
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

  test("the same body sent three times opens the delivery its own call made, one missing", async () => {
    // E1's delivery was never written; E2's and E3's were. Each call claims
    // newest first, so the gap drops E1 alone instead of shifting E2 onto E3's.
    server = fakeServer({
      "chat.history": {
        instance: "atlas",
        bot: "auditor",
        session: "sx-auditor",
        messages: [
          delivery("d0", { name: "Marshall", handle: "scribe" }, atPlus(-3_600_000)),
          bot("r0", [{ kind: "text", markdown: "An older answer." }], "auditor"),
          delivery("d2", { name: "Marshall", handle: "scribe" }, atPlus(300_200)),
          bot("r2", [{ kind: "text", markdown: REPLY }], "auditor"),
          delivery("d3", { name: "Marshall", handle: "scribe" }, atPlus(600_200)),
          bot("r3", [{ kind: "text", markdown: "A later answer." }], "auditor"),
        ],
      },
    });
    const send = (id: string, ms: number) => ({
      ...bot(`m-${id}`, [
        {
          ...dmCall(JSON.stringify({ status: "queued", to: "@auditor", process_id: `proc_${id}` })),
          tool_id: id,
        } as ChatBlockView,
      ]),
      at: atPlus(ms),
    });
    renderThread("scribe", [send("e1", 0), send("e2", 300_000), send("e3", 600_000)]);
    const open = async (index: number) => {
      fireEvent.click(screen.getAllByRole("button", { name: /Messaged/ })[index]!);
      const dialog = screen.getByRole("dialog", { name: "Marshall ⇄ NickQABot" });
      await waitFor(() => expect(dialog.textContent).not.toContain("Reading "));
      const text = dialog.textContent ?? "";
      act(() => {
        fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
      });
      return text;
    };
    const e2 = await open(1);
    expect(e2).toContain(REPLY);
    expect(e2).not.toContain("A later answer.");
    expect(await open(2)).toContain("A later answer.");
    const e1 = await open(0);
    expect(e1).toContain("Not in NickQABot's Bot Chat yet.");
    for (const answer of ["An older answer.", REPLY, "A later answer."])
      expect(e1).not.toContain(answer);
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
    expect(findExchange(transcript, "scribe", long, AT, [AT])?.delivery.id).toBe("d0");
    expect(findExchange(transcript, "scribe", long, AT)?.delivery.id).toBe("d1");
    expect(findExchange(transcript, "scribe", long, atPlus(1_500))?.delivery.id).toBe("d1");
    expect(findExchange(transcript, "scribe", long, atPlus(5_000))).toBeNull();
  });

  test("a short body is never a prefix match", () => {
    const transcript = rows(["d0", "ok, merged and deployed it all"]);
    expect(findExchange(transcript, "scribe", "ok", AT)).toBeNull();
    expect(findExchange(rows(["d0", "ok"]), "scribe", "ok, merged and deployed", AT)).toBeNull();
  });
});

describe("retrying a refused DM", () => {
  const BUSY = {
    error:
      "Delivery failed: @auditor's Bot Chat is open on another surface right now, so your message was NOT delivered. Try again later.",
    reason: "target_busy",
  };
  const refused = (result: unknown) =>
    bot("m1", [
      { ...dmCall(result, "bad"), args: { target: "@auditor", message: ASK } } as ChatBlockView,
    ]);

  test("asks the sender bot once, through the thread's send path, then disables", () => {
    server = fakeServer({});
    const sent: string[] = [];
    renderThread("scribe", [refused(BUSY)], { onSend: (text) => sent.push(text) });
    const mark = document.querySelector<HTMLElement>(".ch-dm-mark.failed")!;
    expect(mark.querySelector("summary")?.textContent).toBe(
      "Couldn't message NickQABot · busy in another window",
    );
    const retry = within(mark).getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(sent).toEqual([
      "Please retry your message_agent delivery to @auditor — it failed with target_busy.",
    ]);
    expect(retry.disabled).toBe(true);
    expect(mark.textContent).toContain("Asked Marshall to retry");
  });

  test("is offered only for a reason a second send can fix", () => {
    server = fakeServer({});
    for (const [code, reason] of Object.entries(DM_FAILURE_REASONS)) {
      renderThread("scribe", [refused({ error: "Delivery failed.", reason: code })]);
      const button = screen.queryByRole("button", { name: "Retry" });
      expect([code, Boolean(button)]).toEqual([code, reason.retry]);
      cleanup();
    }
    renderThread("scribe", [refused({ error: "Delivery failed.", reason: "flux_capacitor" })]);
    expect(screen.queryByRole("button", { name: "Retry" })?.outerHTML).toBeUndefined();
  });

  test("is not offered for a resolution error, whatever reason upstream's text classified it as", () => {
    server = fakeServer({});
    // `_err` classifies by text: a target named 'rate-limiter' reads as a rate limit.
    renderThread("scribe", [
      refused({
        error:
          "No teammate named 'rate-limiter' on this install, on a connected machine, or on a registered peer.",
        reason: "provider_rate_limit",
        teammates: ["auditor"],
        peers: [],
      }),
    ]);
    expect(document.querySelector(".ch-dm-mark.failed")?.textContent).toContain("Teammates: @auditor");
    expect(screen.queryByRole("button", { name: "Retry" })?.outerHTML).toBeUndefined();
    cleanup();
    // One that carries no roster is known by upstream's sentence.
    renderThread("scribe", [
      refused({
        error: "You can't message yourself. Pick a teammate from the roster.",
        reason: "target_busy",
      }),
    ]);
    expect(document.querySelector(".ch-dm-mark.failed")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })?.outerHTML).toBeUndefined();
  });

  test("is not offered once a later call sent the same message to the same bot", () => {
    server = fakeServer({});
    const call = (id: string, result: unknown, args: { target: string; message: string }) =>
      ({ ...dmCall(result, "ok"), tool_id: id, args }) as ChatBlockView;
    const sent = JSON.stringify({ status: "queued", to: "@auditor", process_id: "proc_2" });
    const first = call("c1", BUSY, { target: "@auditor", message: ASK });
    // The bot sent it again on its own, to the same bot under its title's handle.
    renderThread("scribe", [
      bot("m1", [first]),
      bot("m2", [call("c2", sent, { target: "@nickqabot", message: `${ASK}\n` })]),
    ]);
    expect(document.querySelector(".ch-dm-mark.failed")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })?.outerHTML).toBeUndefined();
    cleanup();
    // A different message, a different bot, or a send before the refusal leaves it on.
    for (const thread of [
      [
        bot("m1", [first]),
        bot("m2", [call("c2", sent, { target: "@auditor", message: "Something else." })]),
      ],
      [
        bot("m1", [first]),
        bot("m2", [
          call("c2", JSON.stringify({ status: "queued", to: "@scribe" }), {
            target: "@scribe",
            message: ASK,
          }),
        ]),
      ],
      [bot("m0", [call("c0", sent, { target: "@auditor", message: ASK })]), bot("m1", [first])],
    ]) {
      renderThread("scribe", thread);
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      cleanup();
    }
  });

  test("a marker that remounts still says the ask was made", () => {
    server = fakeServer({});
    const sent: string[] = [];
    const opts = { onSend: (text: string) => sent.push(text) };
    const view = render(threadOf("scribe", [refused(BUSY)], opts));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(sent).toHaveLength(1);
    // The row leaves the thread and comes back — a history re-read — and its marker is a new one.
    view.rerender(threadOf("scribe", [], opts));
    expect(document.querySelector(".ch-dm-mark.failed")).toBeNull();
    view.rerender(threadOf("scribe", [refused(BUSY)], opts));
    const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(document.querySelector(".ch-dm-mark.failed")?.textContent).toContain(
      "Asked Marshall to retry",
    );
    fireEvent.click(retry);
    expect(sent).toHaveLength(1);
  });

  test("is not offered where the thread cannot send", () => {
    server = fakeServer({});
    const sent: string[] = [];
    renderThread("scribe", [refused(BUSY)], { state: "stopped", onSend: (text) => sent.push(text) });
    expect(document.querySelector(".ch-dm-mark.failed")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })?.outerHTML).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

describe("a DM to another machine", () => {
  test("an acknowledgement naming a connection is never a local bot, whatever its handle", async () => {
    server = fakeServer({});
    const relayed = JSON.stringify({
      status: "queued",
      to: "@auditor on laptop",
      process_id: "proc_r1",
    });
    // `auditor` is NickQABot here; the ack says this one is on `laptop`.
    renderThread("scribe", [
      bot("m1", [{ ...dmCall(relayed), args: { target: "auditor", message: ASK } } as ChatBlockView]),
    ]);
    const marker = screen.getByRole("button", { name: /Messaged/ });
    expect(marker.textContent).toBe("Messagedauditor on laptop");
    expect(marker.querySelector(".ch-ava")).toBeNull();
    fireEvent.click(marker);
    const dialog = screen.getByRole("dialog", { name: "Marshall ⇄ auditor on laptop" });
    expect(dialog.textContent).toContain(
      "auditor on laptop is on another machine, so its side of the exchange can't be shown here.",
    );
    expect(dialog.textContent).not.toContain("NickQABot");
    expect(
      within(dialog).queryByRole("button", { name: /Open .*Bot Chat/ })?.outerHTML,
    ).toBeUndefined();
    // No local Bot Chat was read for it.
    expect(server.calls).toEqual([]);
  });

  test("a peer acknowledgement, and a target in either remote form, name the other machine", () => {
    const peer = { status: "queued", to: "@auditor on peer 'spark'" };
    const { container } = renderMessage(
      bot("m1", [
        { ...dmCall(peer), args: { target: "spark/auditor", message: ASK } } as ChatBlockView,
      ]),
    );
    expect(container.querySelector(".ch-dm-mark")?.textContent).toBe("Messagedauditor on peer spark");
    cleanup();
    for (const [target, name] of [
      ["auditor@laptop", "auditor on laptop"],
      ["spark/auditor", "auditor on peer spark"],
    ]) {
      const { container: c } = renderMessage(
        bot("m1", [{ ...dmCall(null, "running"), args: { target, message: ASK } } as ChatBlockView]),
      );
      expect(c.querySelector(".ch-dm-mark")?.textContent).toBe(`Messaging${name}…`);
      cleanup();
    }
  });

  test("a bare target stands in only when the acknowledgement names no destination", () => {
    // A local ack wins over a target that would resolve elsewhere.
    const { container } = renderMessage(
      bot("m1", [
        {
          ...dmCall({ status: "queued", to: "@auditor" }),
          args: { target: "Marshall", message: ASK },
        } as ChatBlockView,
      ]),
    );
    expect(container.querySelector(".ch-dm-mark")?.textContent).toBe("MessagedNickQABot");
    cleanup();
    // Running: no ack yet, so the bare target is the best guess there is.
    const { container: running } = renderMessage(
      bot("m1", [
        { ...dmCall(null, "running"), args: { target: "auditor", message: ASK } } as ChatBlockView,
      ]),
    );
    expect(running.querySelector(".ch-dm-mark")?.textContent).toBe("MessagingNickQABot…");
  });
});

describe("pairing a call with its delivery", () => {
  const rowsAt = (...bodies: [string, number][]) =>
    bodies.map(([id, ms]) => delivery(id, { name: "Marshall", handle: "scribe" }, atPlus(ms)));

  test("a delivery stamped a moment before its call is still the call's", () => {
    const transcript = rowsAt(["d0", -300]);
    expect(findExchange(transcript, "scribe", ASK, AT)?.delivery.id).toBe("d0");
    // Past the allowance it belongs to something earlier.
    expect(findExchange(rowsAt(["d0", -DELIVERY_SKEW_MS - 1]), "scribe", ASK, AT)).toBeNull();
  });

  test("two identical calls in one turn each get their own delivery, in order", () => {
    const transcript = rowsAt(["d0", 400], ["d1", 900]);
    expect(findExchange(transcript, "scribe", ASK, AT, [AT])?.delivery.id).toBe("d0");
    expect(findExchange(transcript, "scribe", ASK, AT)?.delivery.id).toBe("d1");
    // The first of three: the two after it claim both, and its own is not written yet.
    expect(findExchange(transcript, "scribe", ASK, AT, [AT, AT])).toBeNull();
  });

  test("an earlier call of the same body in another turn keeps its own delivery", () => {
    const transcript = rowsAt(["d0", 300], ["d1", 60_300]);
    expect(findExchange(transcript, "scribe", ASK, AT, [atPlus(60_000)])?.delivery.id).toBe("d0");
    expect(findExchange(transcript, "scribe", ASK, atPlus(60_000))?.delivery.id).toBe("d1");
    // Its delivery rolled out of the transcript: it finds none, and the later call keeps its own.
    const rolled = rowsAt(["d1", 60_300]);
    expect(findExchange(rolled, "scribe", ASK, AT, [atPlus(60_000)])).toBeNull();
    expect(findExchange(rolled, "scribe", ASK, atPlus(60_000))?.delivery.id).toBe("d1");
  });

  test("a delivery that was never written drops only its own call", () => {
    // Three sends of one body five minutes apart; the first's delivery is missing.
    const transcript = rowsAt(["d2", 300_200], ["d3", 600_200]);
    const [e1, e2, e3] = [AT, atPlus(300_000), atPlus(600_000)];
    expect(findExchange(transcript, "scribe", ASK, e2, [e3])?.delivery.id).toBe("d2");
    expect(findExchange(transcript, "scribe", ASK, e3)?.delivery.id).toBe("d3");
    expect(findExchange(transcript, "scribe", ASK, e1, [e2, e3])).toBeNull();
  });

  test("the exchange opened from the second of two identical calls shows the second reply", async () => {
    server = fakeServer({
      "chat.history": {
        instance: "atlas",
        bot: "auditor",
        session: "sx-auditor",
        messages: [
          delivery("d0", { name: "Marshall", handle: "scribe" }, atPlus(200)),
          bot("r0", [{ kind: "text", markdown: "First answer." }], "auditor"),
          delivery("d1", { name: "Marshall", handle: "scribe" }, atPlus(700)),
          bot("r1", [{ kind: "text", markdown: "Second answer." }], "auditor"),
        ],
      },
    });
    const call = (id: string, proc: string) =>
      ({
        ...dmCall(JSON.stringify({ status: "queued", to: "@auditor", process_id: proc })),
        tool_id: id,
      }) as ChatBlockView;
    renderThread("scribe", [bot("m1", [call("c1", "proc_1"), call("c2", "proc_2")])]);
    const markers = screen.getAllByRole("button", { name: /Messaged/ });
    fireEvent.click(markers[1]!);
    const dialog = screen.getByRole("dialog", { name: "Marshall ⇄ NickQABot" });
    await waitFor(() => expect(dialog.textContent).toContain("Second answer."));
    expect(dialog.textContent).not.toContain("First answer.");
  });
});
