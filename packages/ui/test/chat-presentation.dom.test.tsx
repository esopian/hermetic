import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "./dom.ts";
import type { ChatBlockView, ChatMessageView } from "../src/api/index.ts";
import { Thread } from "../src/chat/components/Thread.tsx";
import { Message } from "../src/chat/components/Message.tsx";
import { Rail } from "../src/chat/components/Rail.tsx";
import { Block } from "../src/chat/components/blocks/index.tsx";
import { botLabel } from "../src/chat/chat-presentation.ts";
import { applyFrame } from "../src/chat/chat-state.tsx";

afterEach(cleanup);
const NOW = Date.parse("2026-09-17T12:00:00Z");
const activity = (state: "running" | "done", title: string): ChatBlockView => ({
  kind: "activity",
  category: "history",
  key: "history",
  state,
  title,
  payload: { test: "[redacted]" },
});
const tool = (status: "running" | "ok" | "bad" = "ok"): ChatBlockView => ({
  kind: "tool",
  name: "terminal",
  tool_id: "call-1",
  status,
  args: { command: "printf [redacted]" },
  result: "[redacted]",
  render: "terminal",
});
function message(
  blocks: ChatBlockView[],
  streaming = false,
  phase?: "idle" | "thinking" | "streaming",
) {
  const row = {
    message: {
      id: "message-1",
      session: "session-1",
      role: "bot",
      at: new Date(NOW).toISOString(),
      blocks,
    } as ChatMessageView,
    continuation: false,
    divider: null,
  };
  return render(
    <Message
      row={row}
      fleetId="fleet"
      instance="silent-crane"
      bot="default"
      status="ready"
      now={NOW}
      streaming={streaming}
      activity={phase}
    />,
  );
}

describe("compact conversation presentation", () => {
  test("custom default profile title labels both header and message author", () => {
    const { container } = render(
      <Thread
        fleetId="fleet"
        instance="silent-crane"
        bot="default"
        botTitle="Crane assistant"
        agent={null}
        session={null}
        destination={{ state: "known", origin: "portal", detail: null }}
        state="ready"
        messages={[
          {
            id: "custom-message",
            session: "s",
            role: "bot",
            at: new Date(NOW).toISOString(),
            author: { instance: "silent-crane", bot: "default" },
            blocks: [{ kind: "text", markdown: "Hello" }],
          } as ChatMessageView,
        ]}
        live={null}
        sending={false}
        historyError={null}
        now={NOW}
        onSend={() => {}}
        onAbort={() => {}}
      />,
    );
    expect(container.querySelector(".ch-thead-name")?.textContent).toBe("Crane assistant");
    expect(container.querySelector(".ch-msg-who")?.textContent).toBe("Crane assistant");
    expect(container.querySelector("textarea")?.placeholder).toBe("Message Crane assistant…");
  });

  test("transport snapshots coalesce and the finished tool run reads as a summary", () => {
    const { container } = message([
      activity("running", "Loading conversation"),
      activity("done", "Conversation ready"),
      tool("running"),
      tool("ok"),
    ]);
    const summary = container.querySelector<HTMLDetailsElement>(".ch-activity")!;
    // The run is what the turn did; it stays on screen as a collapsed group
    // whose summary line names the outcome, and the operator opens it on
    // demand (`chat-turn-grouping.dom.test.tsx` pins the default).
    expect(summary.open).toBe(false);
    // The transport snapshot is not a step: the run's steps are the work it
    // did, which is the one tool call, and the snapshot it coalesced into is
    // not in the list at all once the turn is over.
    expect(summary.querySelectorAll(".ch-activity-list > li").length).toBe(1);
    expect(summary.querySelector(".ch-activity-list")?.textContent).not.toContain("Conversation");
    expect(summary.querySelector("summary")?.textContent).toContain("Tools complete");
    expect(container.querySelector(".ch-msg-who")?.textContent).toBe("silent-crane");
    fireEvent.click(summary.querySelector("summary")!);
    expect(summary.open).toBe(true);

    // Coalescing is what "transport snapshots" means: two snapshots on one key
    // are one thing whose text was replaced, so the live run shows the later
    // words once — never both, and never in the step list.
    cleanup();
    const live = message(
      [
        activity("running", "Loading conversation"),
        activity("running", "Replaying conversation"),
        tool("running"),
      ],
      true,
      "thinking",
    );
    const lines = live.container.querySelectorAll(".ch-activity-status");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toContain("Replaying conversation");
    expect(live.container.querySelector(".ch-activity-list")?.textContent).not.toContain(
      "conversation",
    );
  });
  test("activity does not relocate across intervening prose", () => {
    const { container } = message([
      activity("done", "Ready"),
      { kind: "text", markdown: "First explanation" },
      tool(),
      { kind: "text", markdown: "Final answer" },
    ]);
    expect(
      Array.from(container.querySelector(".ch-msg-body")!.children).map((el) => el.tagName),
    ).toEqual(["DETAILS", "P", "DETAILS", "P"]);
  });
  test("old connection state settles when prose follows, and completed tool supersedes generation status", () => {
    const { container } = message(
      [activity("running", "Waiting for agent"), { kind: "text", markdown: "Answer underway" }],
      true,
    );
    expect(container.querySelector(".ch-activity > summary")?.textContent).toContain(
      "Activity complete",
    );
    cleanup();
    const second = message([activity("running", "Preparing terminal"), tool("ok")], true);
    expect(second.container.querySelector(".ch-activity > summary")?.textContent).toContain(
      "Tools complete",
    );
  });
  test("failure is visible without expanding individual tool details", () => {
    const { container } = message([tool("bad")]);
    expect(container.querySelector(".ch-activity > summary")?.textContent).toContain("Tool failed");
    expect(container.querySelector<HTMLDetailsElement>(".ch-activity")?.open).toBe(true);
    // A failed step opens itself; the reason is the thing being looked for.
    expect(container.querySelector<HTMLDetailsElement>(".ch-activity-step")?.open).toBe(true);
  });
  test("questions stay visible, explain where to respond, and suppress misleading thinking status", () => {
    const { container } = message(
      [
        activity("running", "Preparing response"),
        { kind: "question", request_id: "q1", prompt: "Choose a destination", choices: ["One", "Two"] },
      ],
      true,
    );
    expect(screen.getByText("Choose a destination")).toBeTruthy();
    expect(screen.getByText("Respond in Hermes. Choices are shown here for reference.")).toBeTruthy();
    expect(container.querySelector(".ch-activity > summary")?.textContent).toContain(
      "Waiting for your response",
    );
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>(".ch-prompts button")).every(
        (el) => el.disabled,
      ),
    ).toBe(true);
  });
  test("withdrawn requests no longer claim the turn is paused", () => {
    message([
      { kind: "question", request_id: "q1", prompt: "Withdrawn prompt", choices: [] },
      {
        kind: "activity",
        category: "notice",
        state: "done",
        key: "request:q1",
        request_id: "q1",
        title: "Request withdrawn",
      },
    ]);
    expect(screen.queryByText("Withdrawn prompt")).toBeNull();
    expect(screen.queryByText("turn paused")).toBeNull();
  });
  test("live assembly replaces activity by stable key without altering usage totals", () => {
    let live: ChatMessageView | null = null;
    for (let i = 0; i < 20; i++)
      live = applyFrame(
        live,
        {
          type: "block",
          seq: i,
          message: "m",
          block: activity(i === 19 ? "done" : "running", String(i)),
        },
        { session: "s", at: new Date(NOW).toISOString() },
      );
    expect(live?.blocks.length).toBe(1);
    expect(live?.blocks[0]).toMatchObject({ title: "19", state: "done" });
    expect(live?.usage).toBeNull();
  });
  test("redacted plaintext is preserved and labelled in prose, code, payloads, attachments and sources", () => {
    const blocks: ChatBlockView[] = [
      { kind: "text", markdown: "Before [redacted] and `[redacted]`\n\n```txt\n[redacted]\n```" },
      { kind: "unknown", name: "future.event", payload: { value: "[redacted]" } },
      { kind: "attachment", name: "[redacted].txt", mime: "text/plain", bytes: 1, href: "/file" },
      {
        kind: "sources",
        items: [{ title: "[redacted]", href: "https://example.com/[redacted]", snippet: "[redacted]" }],
      },
    ];
    const { container } = render(blocks.map((block, i) => <Block key={i} block={block} now={NOW} />));
    fireEvent.click(screen.getByRole("button", { name: /Sources/ }));
    expect(container.querySelectorAll(".ch-redacted").length).toBe(8);
    expect(
      Array.from(container.querySelectorAll(".ch-redacted")).every(
        (el) => el.textContent === "[redacted]",
      ),
    ).toBe(true);
    expect(container.querySelector<HTMLDetailsElement>(".ch-event")?.open).toBe(false);
  });
  test("instance name labels default bot and saved sessions start collapsed", () => {
    expect(botLabel("silent-crane", "default", "default")).toBe("silent-crane");
    expect(botLabel("silent-crane", "research", "Research")).toBe("Research");
    expect(botLabel("silent-crane", "default", "Custom profile")).toBe("Custom profile");
    const bot = {
      instance: "silent-crane",
      name: "default",
      title: "default",
      is_default: true,
      unread: 0,
      needs_action: false,
      warm: true,
      muted: false,
    };
    const { container } = render(
      <Rail
        swarms={[
          {
            instance: "silent-crane",
            reachable: true,
            bots: [bot],
            rooms: [],
            sections: [],
            warm_slots: { used: 1, total: 3 },
          } as never,
        ]}
        fleetId="fleet"
        statusOf={() => "ready"}
        sessions={[
          { id: "s1", title: "Earlier conversation", origin: "cli", unread: 0, turn_count: 2 } as never,
        ]}
        scope={{ kind: "all" }}
        onScope={() => {}}
        filter="all"
        onFilter={() => {}}
        query=""
        onQuery={() => {}}
        selection={{ instance: "silent-crane", bot: "default", session: null }}
        onSelect={() => {}}
        now={NOW}
      />,
    );
    expect(container.querySelector(".ch-conv-name b")?.textContent).toBe("silent-crane");
    expect(container.querySelector<HTMLDetailsElement>(".ch-additional-chats")?.open).toBe(false);
    expect(screen.getByText("Earlier conversation")).toBeTruthy();
    cleanup();
    bot.title = "Crane assistant";
    const named = render(
      <Rail
        swarms={[
          {
            instance: "silent-crane",
            reachable: true,
            bots: [bot],
            rooms: [],
            sections: [],
            warm_slots: { used: 1, total: 3 },
          } as never,
        ]}
        fleetId="fleet"
        statusOf={() => "ready"}
        sessions={[]}
        scope={{ kind: "all" }}
        onScope={() => {}}
        filter="all"
        onFilter={() => {}}
        query=""
        onQuery={() => {}}
        selection={{ instance: "silent-crane", bot: "default", session: null }}
        onSelect={() => {}}
        now={NOW}
      />,
    );
    expect(named.container.querySelector(".ch-conv-name b")?.textContent).toBe("Crane assistant");
  });
});

test("only the current activity group thinks, including empty text placeholders", () => {
  const { container } = message(
    [
      tool(),
      { kind: "text", markdown: "Earlier explanation" },
      { ...tool(), tool_id: "call-2" } as ChatBlockView,
      { kind: "text", markdown: " \n " },
      { kind: "activity", category: "usage", key: "usage", state: "done", title: "Usage" },
    ],
    true,
    "thinking",
  );
  const summaries = container.querySelectorAll(".ch-activity > summary");
  expect(summaries).toHaveLength(2);
  expect(summaries[0]?.textContent).toContain("Tools complete");
  expect(summaries[0]?.querySelector(".busy")).toBeNull();
  expect(summaries[1]?.textContent).toContain("Thinking…");
  expect(summaries[1]?.querySelector(".busy")).not.toBeNull();
  expect(container.querySelector(".ch-msg-meta")?.textContent).toContain("thinking");
  expect(container.querySelector("[data-avatar-activity]")?.getAttribute("data-avatar-activity")).toBe(
    "thinking",
  );
});

test("usage snapshots and stale preparation never label observed output as thinking", () => {
  const usage: ChatBlockView = {
    kind: "activity",
    category: "usage",
    key: "usage",
    state: "done",
    title: "Usage",
  };
  for (const trailing of [[usage], [activity("running", "Preparing response"), usage]]) {
    const { container, unmount } = message(
      [{ kind: "text", markdown: "Answer underway" }, ...trailing],
      true,
      "streaming",
    );
    expect(container.querySelector(".ch-activity > summary")?.textContent).toContain("Responding…");
    expect(container.querySelector(".ch-activity > summary")?.textContent).not.toContain("Thinking");
    expect(container.querySelector(".ch-activity > summary")?.textContent).not.toContain("Preparing");
    expect(container.querySelector(".ch-msg-meta")?.textContent).toContain("streaming");
    unmount();
  }
});
