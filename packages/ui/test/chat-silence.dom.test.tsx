/**
 * A bot that answered with an intentional-silence marker (`chat-silence.ts`).
 *
 * The token stays in the transcript — Hermes suppresses delivery, not the row —
 * so the thread has to draw it as a marker rather than a bubble saying
 * "NO_REPLY", hold back a streamed prefix of one, and still show the words of a
 * failed turn whatever they happen to be.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "./dom.ts";
import type { ChatBlockView, ChatMessageView } from "../src/api/index.ts";
import type { SwarmView } from "../src/api/index.ts";
import { Message } from "../src/chat/components/Message.tsx";
import { BotRail } from "../src/chat/components/BotRail.tsx";
import { Rail } from "../src/chat/components/Rail.tsx";
import { isSilentPreview } from "../src/chat/chat-silence.ts";

afterEach(cleanup);
const NOW = Date.parse("2026-09-17T12:00:00Z");

const tool: ChatBlockView = {
  kind: "tool",
  name: "terminal",
  tool_id: "call-1",
  status: "ok",
  args: { command: "uptime" },
  result: "up 3 days",
  render: "terminal",
};

function message(
  blocks: ChatBlockView[],
  { streaming = false, error = null }: { streaming?: boolean; error?: string | null } = {},
) {
  const row = {
    message: {
      id: "message-1",
      session: "session-1",
      role: "bot",
      at: new Date(NOW).toISOString(),
      blocks,
      error,
      incomplete: error ? true : null,
      usage: { input_tokens: 2100, output_tokens: 4 },
    } as ChatMessageView,
    continuation: false,
    divider: null,
  };
  return render(
    <Message
      row={row}
      fleetId="fleet"
      instance="kestrel"
      bot="default"
      botTitle="Kestrel"
      status="ready"
      now={NOW}
      streaming={streaming}
      activity={streaming ? "streaming" : "idle"}
    />,
  );
}

describe("intentional silence in the thread", () => {
  test("a settled silent turn is one muted line naming the bot, and the token is only in the tooltip", () => {
    const { container } = message([{ kind: "text", markdown: " *NO_REPLY* " }]);
    const marker = container.querySelector<HTMLElement>(".ch-silent");
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain("Kestrel stayed silent");
    expect(marker?.getAttribute("title")).toBe("replied *NO_REPLY* — Hermes suppresses delivery");
    expect(marker?.getAttribute("data-chat-message")).toBe("message-1");
    // No bubble, no prose, no meter.
    expect(container.querySelector(".ch-msg")).toBeNull();
    expect(container.textContent).not.toContain("NO_REPLY");
  });

  test("a turn that worked before going silent keeps its tool run, and the final text becomes the marker", () => {
    const { container } = message([tool, { kind: "text", markdown: "[静默]" }]);
    expect(container.querySelector(".ch-msg")).not.toBeNull();
    expect(container.querySelector(".ch-activity")).not.toBeNull();
    const note = container.querySelector<HTMLElement>(".ch-silent-note");
    expect(note?.textContent).toBe("stayed silent");
    expect(note?.getAttribute("title")).toContain("[静默]");
    expect(container.querySelector(".ch-msg-body")?.textContent).not.toContain("静默");
  });

  test("prose that only mentions a marker is drawn as prose", () => {
    const { container } = message([
      { kind: "text", markdown: "Use NO_REPLY when no answer is needed." },
    ]);
    expect(container.querySelector(".ch-silent")).toBeNull();
    expect(container.textContent).toContain("Use NO_REPLY when no answer is needed.");
  });

  test("a streamed prefix of a marker shows the caret, not the prefix", () => {
    const { container } = message([{ kind: "text", markdown: "NO_" }], { streaming: true });
    expect(container.querySelector(".ch-msg-body")?.textContent).not.toContain("NO");
    expect(container.querySelector(".ch-msg-body .caret")).not.toBeNull();
    // Still streaming, so not yet a marker either.
    expect(container.querySelector(".ch-silent")).toBeNull();
  });

  test("a stream that diverged from every marker shows all of it", () => {
    const { container } = message([{ kind: "text", markdown: "NO way, here is the answer." }], {
      streaming: true,
    });
    expect(container.querySelector(".ch-msg-body")?.textContent).toContain(
      "NO way, here is the answer.",
    );
  });

  test("a failed turn that ended on a marker shows the marker's words and the failure", () => {
    const { container } = message([{ kind: "text", markdown: "NO_REPLY" }], {
      error: "TURN_FAILED: provider failed",
    });
    expect(container.querySelector(".ch-silent")).toBeNull();
    expect(container.querySelector(".ch-silent-note")).toBeNull();
    expect(container.querySelector(".ch-msg-body")?.textContent).toContain("NO_REPLY");
    expect(container.querySelector(".ch-card")).not.toBeNull();
  });
});

describe("intentional silence on the rail", () => {
  test("only a bare marker reads as silence", () => {
    expect(isSilentPreview("NO_REPLY")).toBe(true);
    expect(isSilentPreview("[SILENT]")).toBe(true);
    expect(isSilentPreview("Use NO_REPLY when no answer is needed.")).toBe(false);
    expect(isSilentPreview(null)).toBe(false);
    expect(isSilentPreview("")).toBe(false);
  });

  test("a marker is silence only when the bot wrote it", () => {
    expect(isSilentPreview("NO_REPLY", "bot")).toBe(true);
    expect(isSilentPreview("No reply", "user")).toBe(false);
    expect(isSilentPreview("NO_REPLY", "system")).toBe(false);
    // Upstream's preview names no role, so an unknown one keeps the marker
    // rule rather than drawing every silent bot's raw token.
    expect(isSilentPreview("NO_REPLY", null)).toBe(true);
    expect(isSilentPreview("NO_REPLY", undefined)).toBe(true);
  });

  const bot = (name: string, preview: string, preview_role: string | null) => ({
    instance: "veronica",
    name,
    title: name,
    description: null,
    preview,
    preview_role,
    is_default: name === "quiet",
    section: null,
    avatar_seed: name,
    last_message_at: "2026-09-19T10:00:00.000Z",
    unread: 0,
    needs_action: false,
    muted: false,
    warm: true,
  });
  const swarms = [
    {
      instance: "veronica",
      reachable: true,
      unreachable_reason: null,
      bots: [
        bot("quiet", "NO_REPLY", "bot"),
        bot("asked", "No reply", "user"),
        bot("unknown", "NO_REPLY", null),
      ],
      rooms: [],
      warm_slots: { used: 1, total: 3 },
      sections: [],
    },
  ] as unknown as SwarmView[];
  const now = Date.parse("2026-09-19T10:05:00.000Z");
  /** What each rail row quotes, by bot name. */
  const quoted = () =>
    Object.fromEntries(
      [...document.querySelectorAll(".ch-conv")].map((row) => [
        ["quiet", "asked", "unknown"].find((n) => row.textContent?.includes(n)),
        row.querySelector(".ch-conv-prev")?.textContent,
      ]),
    );
  const expected = { quiet: "stayed silent", asked: "No reply", unknown: "stayed silent" };

  test("the bot rail labels a bot's marker and quotes the operator's words", () => {
    render(
      <BotRail
        swarms={swarms}
        sessions={[]}
        selection={null}
        room={null}
        fleetId="fxtr0001"
        now={now}
        query=""
        onQuery={() => {}}
        onSelect={() => {}}
        onRoom={() => {}}
        onCreateBot={() => {}}
        onCreateRoom={() => {}}
        onNewSession={() => {}}
        statusOf={() => "ready"}
        activities={[]}
      />,
    );
    expect(quoted()).toEqual(expected);
  });

  test("the classic rail does the same", () => {
    render(
      <Rail
        swarms={swarms}
        fleetId="fxtr0001"
        statusOf={() => "ready"}
        sessions={[]}
        scope={{ kind: "all" }}
        onScope={() => {}}
        filter="all"
        onFilter={() => {}}
        query=""
        onQuery={() => {}}
        selection={null}
        onSelect={() => {}}
        now={now}
      />,
    );
    expect(quoted()).toEqual(expected);
  });
});
