/**
 * One turn is one grouping.
 *
 * A durable read hands the UI an assistant row per tool call plus a
 * `role: "system"` row per tool result (`hermes-chat-history.ts`), so the shape
 * under test here is the shape a real history read produces — not a single
 * message with every block already on it. The live message is that single
 * message, and the point of the last case is that both draw the same thing.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, waitFor } from "./dom.ts";
import type {
  ChatBlockView,
  ChatFrameView,
  ChatMessageView,
  ChatStreamHandlers,
  ChatTurnHandlers,
} from "../src/api/index.ts";
import { ChatProvider, useChat } from "../src/chat/chat-state.tsx";
// A package `test` tree may read both sides of a seam; the boundaries rule is
// scoped to each package's `src` (AGENTS.md, and `tests/naming-mirror.test.ts`).
import { defaultRole } from "../../core/src/chat/hermes/hermes-chat-activity.ts";
import type { Chat, ChatApi } from "../src/chat/chat-state.tsx";
import { Thread } from "../src/chat/components/Thread.tsx";
import { turnRows } from "../src/chat/chat-turns.ts";
import { applyFrame } from "../src/chat/chat-state.tsx";
import type { TurnActivity } from "../src/chat/chat-activity.ts";

afterEach(cleanup);
const NOW = Date.parse("2026-09-17T12:00:00Z");
const AT = new Date(NOW).toISOString();

const toolBlock = (n: number, status: "ok" | "running" = "ok"): ChatBlockView => ({
  kind: "tool",
  name: "terminal",
  tool_id: `call-${n}`,
  status,
  args: { command: `printf step-${n}` },
  result: "[redacted]",
  render: "terminal",
  duration_ms: 1200 + n,
});

/** The `role: "tool"` row a history read writes, after `messageRole()` maps it. */
const toolRow = (n: number): ChatMessageView =>
  ({
    id: `stored:${n}`,
    session: "s",
    role: "system",
    at: AT,
    blocks: [toolBlock(n)],
  }) as ChatMessageView;

const botRow = (id: string, blocks: ChatBlockView[]): ChatMessageView =>
  ({
    id,
    session: "s",
    role: "bot",
    at: AT,
    author: { instance: "silent-crane", bot: "default" },
    blocks,
  }) as ChatMessageView;

const prose = (markdown: string): ChatBlockView => ({ kind: "text", markdown });

function thread(
  messages: ChatMessageView[],
  live: ChatMessageView | null = null,
  activity?: TurnActivity,
) {
  return render(threadEl(messages, NOW, live, activity));
}

function threadEl(
  messages: ChatMessageView[],
  now: number,
  live: ChatMessageView | null = null,
  activity: TurnActivity = live ? "streaming" : "idle",
) {
  return (
    <Thread
      fleetId="fleet"
      instance="silent-crane"
      bot="default"
      agent={null}
      session={null}
      destination={{ state: "known", origin: "portal", detail: null }}
      state="ready"
      messages={messages}
      live={live}
      sending={live !== null && activity !== "idle"}
      activity={activity}
      historyError={null}
      now={now}
      onSend={() => {}}
      onAbort={() => {}}
    />
  );
}

const counts = (container: HTMLElement) => ({
  articles: container.querySelectorAll("article.ch-msg").length,
  groups: container.querySelectorAll(".ch-activity").length,
  steps: container.querySelectorAll(".ch-activity-step").length,
  faces: container.querySelectorAll("article.ch-msg [data-avatar-activity]").length,
});

/**
 * The tag of every child of the turn's body, in order. The streaming caret is
 * left out: it is the one thing a live turn is *supposed* to draw and a durable
 * one is not.
 */
const body = (container: HTMLElement) =>
  Array.from(container.querySelector(".ch-msg-body")!.children)
    .filter((el) => !el.classList.contains("caret"))
    .map((el) => el.tagName);

describe("turn grouping", () => {
  test("a run of durable tool rows and its prose are one message with one closed group", () => {
    const messages = [1, 2, 3, 4, 5].map(toolRow);
    messages.push(botRow("stored:6", [prose("Final answer")]));
    const { container } = thread(messages);
    expect(counts(container)).toEqual({ articles: 1, groups: 1, steps: 5, faces: 1 });

    const group = container.querySelector<HTMLDetailsElement>(".ch-activity")!;
    expect(group.open).toBe(false);
    expect(group.querySelector("summary")?.textContent).toContain("5 tools");

    // The prose follows the run rather than sitting in its own message.
    expect(body(container)).toEqual(["DETAILS", "P"]);
    expect(container.textContent).toContain("Final answer");
  });

  test("the merged row is addressed by its last source id, so links and acks still land", () => {
    const rows = turnRows([toolRow(1), toolRow(2), botRow("stored:9", [prose("Done")])], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message.id).toBe("stored:9");
    expect(rows[0]!.ids).toEqual(["stored:1", "stored:2", "stored:9"]);
    const { container } = thread([toolRow(1), toolRow(2), botRow("stored:9", [prose("Done")])]);
    expect(container.querySelector('[data-chat-message="stored:9"]')).not.toBeNull();
  });

  test("a question breaks the run and keeps its place between two groups", () => {
    const { container } = thread([
      toolRow(1),
      botRow("stored:2", [
        { kind: "question", request_id: "q1", prompt: "Which box?", choices: ["one", "two"] },
      ]),
      toolRow(3),
      botRow("stored:4", [prose("Final answer")]),
    ]);
    expect(container.querySelectorAll("article.ch-msg")).toHaveLength(1);
    const kinds = Array.from(container.querySelector(".ch-msg-body")!.children).map((el) =>
      el.classList.contains("ch-activity") ? "group" : "other",
    );
    expect(kinds[0]).toBe("group");
    expect(container.querySelectorAll(".ch-activity")).toHaveLength(2);
    expect(container.textContent).toContain("Which box?");
    // The question sits between the two runs, not after both of them.
    const children = Array.from(container.querySelector(".ch-msg-body")!.children);
    const first = children.findIndex((el) => el.classList.contains("ch-activity"));
    const last = children.findLastIndex((el) => el.classList.contains("ch-activity"));
    const question = children.findIndex((el) => el.querySelector(".ch-prompts") !== null);
    expect(question).toBeGreaterThan(first);
    expect(question).toBeLessThan(last);
  });

  test("a broken row ends the run and stays its own message", () => {
    const { container } = thread([
      toolRow(1),
      toolRow(2),
      {
        ...botRow("stored:3", [prose("Half an answer")]),
        error: "RATE_LIMITED",
        incomplete: true,
      } as ChatMessageView,
    ]);
    expect(container.querySelectorAll("article.ch-msg")).toHaveLength(2);
    expect(container.querySelector(".ch-card")).not.toBeNull();
  });

  test("a live turn draws what the same turn draws once it is durable", () => {
    const history = thread([
      ...[1, 2, 3, 4, 5].map(toolRow),
      botRow("stored:6", [prose("Final answer")]),
    ]);
    const durable = counts(history.container);
    const durableBody = body(history.container);
    cleanup();
    const live = botRow("live-1", [...[1, 2, 3, 4, 5].map((n) => toolBlock(n)), prose("Final answer")]);
    const streamed = thread([], live);
    expect(counts(streamed.container)).toEqual(durable);
    // Same counts is not the same drawing: the body must be the same sequence
    // of elements in the same order, run first and prose after it.
    expect(body(streamed.container)).toEqual(durableBody);
    expect(durableBody).toEqual(["DETAILS", "P"]);
    expect(streamed.container.querySelector<HTMLDetailsElement>(".ch-activity")!.open).toBe(false);
  });

  test("a live group is closed and its summary names the running step", () => {
    const live = botRow("live-1", [
      toolBlock(1),
      { ...toolBlock(2, "running"), result: null } as ChatBlockView,
    ]);
    const { container } = thread([], live, "thinking");
    const group = container.querySelector<HTMLDetailsElement>(".ch-activity")!;
    expect(group.open).toBe(false);
    const summary = group.querySelector("summary")!.textContent ?? "";
    expect(summary).toContain("terminal printf step-2");
    expect(summary).toContain("2 tools");
    expect(summary).not.toContain("Working…");
  });

  test("a live group between steps shows the latest status snapshot", () => {
    const live = botRow("live-1", [
      toolBlock(1),
      {
        kind: "activity",
        category: "generation",
        key: "generation",
        title: "Preparing terminal",
        state: "running",
        detail: null,
      } as ChatBlockView,
    ]);
    const { container } = thread([], live, "thinking");
    const group = container.querySelector<HTMLDetailsElement>(".ch-activity")!;
    expect(group.open).toBe(false);
    expect(group.querySelector("summary")?.textContent).toContain("Preparing terminal");
    // Opened, the summary goes back to the phase word and the status line is drawn below the steps.
    fireEvent.click(group.querySelector("summary")!);
    expect(group.open).toBe(true);
    expect(group.querySelector("summary")?.textContent).toContain("Thinking…");
    expect(group.querySelector(".ch-activity-status")?.textContent).toContain("Preparing terminal");
  });

  test("a finished group is closed and reads Tools complete", () => {
    const { container } = thread([toolRow(1), toolRow(2), botRow("stored:3", [prose("Done")])]);
    const group = container.querySelector<HTMLDetailsElement>(".ch-activity")!;
    expect(group.open).toBe(false);
    const summary = group.querySelector("summary")!.textContent ?? "";
    expect(summary).toContain("Tools complete");
    expect(summary).toContain("2 tools");
  });

  test("opening the group survives the turn taking another row", () => {
    const { container, rerender } = thread([toolRow(1)]);
    const group = container.querySelector<HTMLDetailsElement>(".ch-activity")!;
    fireEvent.click(group.querySelector("summary")!);
    expect(group.open).toBe(true);
    rerender(threadEl([toolRow(1), toolRow(2)], NOW + 1000));
    const after = container.querySelector<HTMLDetailsElement>(".ch-activity")!;
    expect(after.open).toBe(true);
    expect(after.querySelector("summary")?.textContent).toContain("2 tools");
  });

  test("a failed step opens the group", () => {
    const { container } = thread([
      toolRow(1),
      {
        ...toolRow(2),
        blocks: [{ ...toolBlock(2), status: "bad" } as ChatBlockView],
      } as ChatMessageView,
    ]);
    const group = container.querySelector<HTMLDetailsElement>(".ch-activity")!;
    expect(group.open).toBe(true);
    expect(group.querySelector("summary")?.textContent).toContain("Tool failed");
  });

  test("a step names its tool and target, times it, and a failure opens itself", () => {
    const { container } = thread([
      toolRow(1),
      {
        ...toolRow(2),
        blocks: [{ ...toolBlock(2), status: "bad" } as ChatBlockView],
      } as ChatMessageView,
    ]);
    const steps = container.querySelectorAll<HTMLDetailsElement>(".ch-activity-step");
    expect(steps[0]!.open).toBe(false);
    expect(steps[1]!.open).toBe(true);
    expect(steps[0]!.querySelector("summary")?.textContent).toContain("terminal");
    expect(steps[0]!.querySelector(".ch-activity-target")?.textContent).toBe("printf step-1");
    expect(steps[0]!.querySelector("summary")?.textContent).toContain("1.2s");
    expect(steps[1]!.querySelector("summary")?.textContent).toContain("Failed");
  });

  test("two plain assistant messages stay two bubbles", () => {
    // Only rows a *single* turn was split into merge. Two answers that merely
    // follow one another are two answers, exactly as `messageRows()` drew them
    // — and the durable copy of a turn must never swallow the live one.
    const { container } = thread([
      botRow("m2", [prose("First answer")]),
      botRow("m3", [prose("Second answer")]),
    ]);
    expect(container.querySelectorAll("article.ch-msg")).toHaveLength(2);
    expect(turnRows([botRow("m2", [prose("a")]), botRow("m3", [prose("b")])], NOW)).toHaveLength(2);
  });

  test("the live message never folds into the durable turn above it", () => {
    const durable = [toolRow(1), botRow("m2", [prose("Turn one")])];
    const live = botRow("m3", [prose("Turn two")]);
    const { container } = thread(durable, live);
    const bubbles = [...container.querySelectorAll(".ch-msg")].map((n) => n.textContent ?? "");
    expect(bubbles).toHaveLength(2);
    expect(bubbles.find((t) => t.includes("Turn two"))).not.toContain("Turn one");
  });

  test("closing the group survives the turn taking another row", () => {
    // The merged row is named by its *last* source id, so a turn that accretes
    // is a row whose id moves. If the article were keyed on that, this rerender
    // would remount it and hand the reader back a group they had closed.
    const { container, rerender } = thread([toolRow(1)]);
    const group = container.querySelector<HTMLDetailsElement>(".ch-activity")!;
    fireEvent.click(group.querySelector("summary")!);
    expect(group.open).toBe(true);
    fireEvent.click(group.querySelector("summary")!);
    expect(group.open).toBe(false);
    rerender(threadEl([toolRow(1), toolRow(2)], NOW + 1000));
    const after = container.querySelector<HTMLDetailsElement>(".ch-activity")!;
    expect(after.open).toBe(false);
    expect(after.querySelector("summary")?.textContent).toContain("2 tools");
  });

  test("prose closes the run, so the next tool call is a new turn", () => {
    const messages = [
      toolRow(1),
      botRow("stored:2", [prose("First answer")]),
      toolRow(3),
      botRow("stored:4", [prose("Second answer")]),
    ];
    expect(turnRows(messages, NOW)).toHaveLength(2);
    const { container } = thread(messages);
    expect(container.querySelectorAll("article.ch-msg")).toHaveLength(2);
  });

  test("a question does not close the run, so the turn stays one row", () => {
    const rows = turnRows(
      [
        toolRow(1),
        botRow("stored:2", [
          { kind: "question", request_id: "q1", prompt: "Which box?", choices: ["one", "two"] },
        ]),
        toolRow(3),
        botRow("stored:4", [prose("Final answer")]),
      ],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ids).toEqual(["stored:1", "stored:2", "stored:3", "stored:4"]);
  });

  test("prose that arrived beside a tool call narrates it and does not close the run", () => {
    // `hermes-chat-history.ts` puts the assistant's own text and the tool call
    // it opened on one row. That prose is not the answer.
    const rows = turnRows(
      [
        botRow("stored:1", [prose("Let me check."), toolBlock(1)]),
        toolRow(2),
        botRow("stored:3", [prose("Final answer")]),
      ],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ids).toEqual(["stored:1", "stored:2", "stored:3"]);
  });

  test("two bots' tool rows never merge under one avatar", () => {
    const owned = (id: string, bot: string, block: ChatBlockView): ChatMessageView =>
      ({
        id,
        session: "s",
        role: "bot",
        at: AT,
        author: { instance: "silent-crane", bot },
        blocks: [block],
      }) as ChatMessageView;
    const rows = turnRows(
      [owned("a1", "scout", toolBlock(1)), owned("b1", "quartermaster", toolBlock(2))],
      NOW,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.message.author?.bot)).toEqual(["scout", "quartermaster"]);
  });

  test("a system row that says something of its own is a hard break", () => {
    const notice = {
      id: "sys:2",
      session: "s",
      role: "system",
      at: AT,
      blocks: [prose("The watch was restarted.")],
    } as ChatMessageView;
    const rows = turnRows([toolRow(1), notice, toolRow(3)], NOW);
    expect(rows.map((r) => r.ids)).toEqual([["stored:1"], ["sys:2"], ["stored:3"]]);
    expect(rows[1]!.message.author ?? null).toBeNull();
  });

  test("a link to a row in the middle of a turn still finds the article", () => {
    const { container } = thread([toolRow(1), toolRow(2), botRow("stored:9", [prose("Done")])]);
    const article = container.querySelector<HTMLElement>("article.ch-msg")!;
    expect(article.dataset.chatIds).toBe("stored:1 stored:2 stored:9");
    // The lookup `ChatShell` performs for `#…message=stored:1`.
    const found = Array.from(container.querySelectorAll<HTMLElement>("[data-chat-message]")).find(
      (el) =>
        el.dataset.chatMessage === "stored:1" ||
        (el.dataset.chatIds ?? "").split(" ").includes("stored:1"),
    );
    expect(found).toBe(article);
  });

  test("a step that fails while it is on screen opens itself, unless it was closed", () => {
    const running = (status: "running" | "bad") =>
      ({
        ...toolRow(1),
        blocks: [{ ...toolBlock(1), status } as ChatBlockView],
      }) as ChatMessageView;
    const { container, rerender } = thread([running("running")]);
    const step = () => container.querySelector<HTMLDetailsElement>(".ch-activity-step")!;
    expect(step().open).toBe(false);
    rerender(threadEl([running("bad")], NOW));
    expect(step().open).toBe(true);

    cleanup();
    const closed = thread([running("bad")]);
    const one = closed.container.querySelector<HTMLDetailsElement>(".ch-activity-step")!;
    expect(one.open).toBe(true);
    fireEvent.click(one.querySelector("summary")!);
    expect(one.open).toBe(false);
    closed.rerender(threadEl([running("bad")], NOW + 1000));
    expect(closed.container.querySelector<HTMLDetailsElement>(".ch-activity-step")!.open).toBe(false);
  });

  test("an unrecognised tool never puts its arguments in the always-visible header", () => {
    const { container } = thread([
      {
        ...toolRow(1),
        blocks: [
          {
            kind: "tool",
            name: "provision_gateway",
            tool_id: "call-secret",
            status: "ok",
            args: { token: "FIXTURE_SECRET" },
            result: "ok",
          } as ChatBlockView,
        ],
      } as ChatMessageView,
    ]);
    const summary = container.querySelector(".ch-activity-step summary")!;
    expect(summary.textContent).toContain("provision_gateway");
    expect(summary.querySelector(".ch-activity-target")).toBeNull();
    expect(summary.textContent).not.toContain("FIXTURE_SECRET");
  });
});

/* ── the live turn has the shape the finished turn has ───────────────────── */

/**
 * Status is not a step.
 *
 * A turn arrives interleaved with transport and progress snapshots — the socket
 * being dialled, the conversation being replayed, a call being prepared, the
 * running token count. They are replaceable snapshots of what is happening now,
 * and none of them survives into the durable transcript, so a step list that
 * accretes them draws a turn nothing will ever draw again. The live view shows
 * the current one as a single status line; the steps are the work.
 */
describe("a live turn draws status as status", () => {
  const LIVE = "live-1";
  const statusFrame = (
    seq: number,
    category: "connection" | "queue" | "history" | "generation" | "usage" | "notice",
    key: string,
    title: string,
    detail: string | null = null,
  ): ChatFrameView =>
    ({
      type: "block",
      seq,
      message: LIVE,
      block: { kind: "activity", category, key, title, state: "running", detail },
    }) as ChatFrameView;
  const toolFrame = (seq: number, n: number, status: "running" | "ok"): ChatFrameView =>
    ({
      type: "block",
      seq,
      message: LIVE,
      block:
        status === "running"
          ? ({ ...toolBlock(n, "running"), result: null } as ChatBlockView)
          : toolBlock(n),
    }) as ChatFrameView;
  const USAGE = { input_tokens: 54867, output_tokens: 62, cost_usd: null, model: null };
  /** The status titles observed accreting as "In progress" rows in one turn. */
  const TRANSPORT = [
    "Connecting to Hermes",
    "Agent is working",
    "Conversation loaded",
    "Thinking…",
    "Current usage",
    "Preparing terminal",
  ];

  /** The turn as it is spoken: status, work, status, usage, work, prose, end. */
  const FRAMES: ChatFrameView[] = [
    statusFrame(1, "connection", "connection", "Connecting to Hermes"),
    statusFrame(2, "notice", "status:working", "Agent is working"),
    statusFrame(3, "history", "history:replay", "Conversation loaded"),
    toolFrame(4, 1, "running"),
    toolFrame(5, 1, "ok"),
    statusFrame(6, "notice", "status:thinking", "Thinking…"),
    statusFrame(7, "usage", "usage", "Current usage", "54,867 input tokens · 62 output tokens"),
    statusFrame(8, "generation", "generation", "Preparing terminal"),
    toolFrame(9, 2, "running"),
    toolFrame(10, 2, "ok"),
    { type: "delta", seq: 11, message: LIVE, text: "Final answer" } as ChatFrameView,
    { type: "done", seq: 12, message: LIVE, usage: USAGE } as ChatFrameView,
  ];
  /** Tool calls started by the time each frame has been folded in. */
  const STEPS = [0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2];

  const stepText = (container: HTMLElement) =>
    Array.from(container.querySelectorAll(".ch-activity-step"))
      .map((el) => el.textContent ?? "")
      .join(" | ");

  test("status never becomes a step, and the turn never splits into two groups", () => {
    let live: ChatMessageView | null = null;
    FRAMES.forEach((frame, index) => {
      live = applyFrame(live, frame, { session: "s", at: AT });
      const done = frame.type === "done";
      const phase: TurnActivity = done ? "idle" : frame.type === "delta" ? "streaming" : "thinking";
      const { container, unmount } = thread([], live, phase);
      const where = `frame ${index + 1} (${frame.type})`;
      // One turn, one avatar, one group — never "Tools complete" above "Thinking".
      expect([where, counts(container).articles]).toEqual([where, 1]);
      expect([where, counts(container).faces]).toEqual([where, 1]);
      expect([where, counts(container).groups]).toEqual([where, 1]);
      // The steps are the tool calls and nothing else.
      expect([where, counts(container).steps]).toEqual([where, STEPS[index]!]);
      for (const title of TRANSPORT) expect([where, stepText(container)]).not.toContain(title);
      // While the group is the live one, exactly one status line — never a
      // second. Once prose is arriving, or the turn is over, the run is done
      // and says nothing about the transport.
      expect([where, container.querySelectorAll(".ch-activity-status").length]).toEqual([
        where,
        phase === "thinking" ? 1 : 0,
      ]);
      unmount();
    });
  });

  test("the live turn, once it is over, is what the durable turn draws", () => {
    const durable = thread([
      toolRow(1),
      toolRow(2),
      { ...botRow("stored:3", [prose("Final answer")]), usage: USAGE } as ChatMessageView,
    ]);
    const durableCounts = counts(durable.container);
    const durableBody = body(durable.container);
    expect(durableBody).toEqual(["DETAILS", "P", "DIV"]);
    cleanup();

    let live: ChatMessageView | null = null;
    for (const frame of FRAMES) live = applyFrame(live, frame, { session: "s", at: AT });
    const streamed = thread([], live, "idle");
    expect(counts(streamed.container)).toEqual(durableCounts);
    expect(body(streamed.container)).toEqual(durableBody);
    // The usage snapshot reached the turn meter, not the step list.
    expect(streamed.container.querySelector(".ch-meter")?.textContent).toContain("54,867");
  });
  test("a notice about the run does not tell a running turn it stopped", () => {
    // The notice rejoins nothing: it is drawn below the group, and the group is
    // therefore no longer the last section. Reading the last section as the
    // live one labelled a turn with two calls in flight "Activity stopped".
    const live = botRow("live-2", [
      toolBlock(1, "running"),
      {
        kind: "activity",
        category: "notice",
        key: "risk:call-1",
        title: "Tool output needs review",
        state: "warning",
        detail: null,
      } as ChatBlockView,
      toolBlock(2, "running"),
    ]);
    const { container } = thread([], live, "streaming");
    expect(counts(container)).toEqual({ articles: 1, groups: 1, steps: 2, faces: 1 });
    const summary = container.querySelector(".ch-activity > summary")!;
    expect(summary.textContent).not.toContain("Activity stopped");
    expect(summary.textContent).toContain("Responding…");
    expect(summary.querySelector(".busy")).not.toBeNull();
    expect(container.querySelector(".ch-activity-notice")).not.toBeNull();
    // The steps of a live run say Running, which is what "stopped" denied.
    expect(container.querySelector(".ch-activity-step summary")?.textContent).toContain("Running");
  });

  test("delegated work is a step, not a transport snapshot", () => {
    // `generation` carries `tool.generating` *and* every `subagent.*`/`moa.*`
    // frame. Only the first is a snapshot; a finished subagent is work, and a
    // status line would never show it, because it only shows what is running.
    const live = botRow("live-3", [
      toolBlock(1),
      {
        kind: "activity",
        category: "generation",
        key: "generation",
        title: "Preparing terminal",
        state: "running",
        detail: null,
      } as ChatBlockView,
      {
        kind: "activity",
        category: "generation",
        key: "subagent:child-1",
        title: "Delegated work finished",
        state: "done",
        detail: "Read the fleet manifest",
      } as ChatBlockView,
    ]);
    const { container } = thread([], live, "thinking");
    expect(counts(container).steps).toBe(2);
    const steps = Array.from(container.querySelectorAll(".ch-activity-step")).map(
      (el) => el.textContent ?? "",
    );
    expect(steps[1]).toContain("Delegated work finished");
    expect(steps.join(" | ")).not.toContain("Preparing terminal");
    // The one snapshot among them is the status line, and it is the only one.
    const line = container.querySelectorAll(".ch-activity-status");
    expect(line).toHaveLength(1);
    expect(line[0]?.textContent).toContain("Preparing terminal");
  });
});

/**
 * The same turn, off a real box.
 *
 * Everything above builds its rows by hand, which is the right shape for a rule
 * but says nothing about the frames a box actually sends. These two fixtures
 * were captured together on `silent-crane`: `recorded-turn.ndjson` is the 25
 * live frames of one turn, `recorded-durable.ndjson` is the six rows the box
 * wrote down for that same turn *while it was still streaming* and handed to
 * the portal's observation — the arrival that used to draw the answer twice.
 * They are replayed through the real store, interleaved by their own stamps.
 */
const fixtureLines = <T,>(name: string): T[] =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);

/**
 * Every `generation` snapshot `hermes-chat-turn.ts` mints inline, read out of
 * that file rather than restated here.
 *
 * Those two "Thinking…"/"Thinking complete" blocks are the one place core does
 * not go through `defaultRole`, and they are the reason a hand-written mirror
 * of the rule is wrong: `defaultRole` calls `generation`/`reasoning` work, the
 * turn calls it status, and a test that copies either answer can agree with the
 * wrong half for ever. Parsed instead, so a future change to those literals
 * changes what this case replays.
 */
function inlineTurnRoles(): Map<string, "status" | "work"> {
  const source = readFileSync(
    join(import.meta.dir, "../../core/src/chat/hermes/hermes-chat-turn.ts"),
    "utf8",
  );
  const found = new Map<string, "status" | "work">();
  const pattern =
    /category:\s*"([a-z]+)",\s*\n\s*key:\s*"([^"]+)",[\s\S]{0,200}?role:\s*"(status|work)"/g;
  for (const [, category, key, role] of source.matchAll(pattern))
    found.set(`${category}/${key}`, role as "status" | "work");
  return found;
}

const TURN_ROLES = inlineTurnRoles();

/**
 * The `role` core mints on every activity block it makes: `defaultRole` for
 * everything routed through `hermesActivity`, and the parsed literals above for
 * the two the turn mints itself. The capture predates the field, so it is
 * stamped back on rather than left to `isStatusBlock`'s role-less fallback —
 * the point of this case is what a box sends *now*. Nothing about the rule is
 * restated here, so this cannot drift away from core.
 */
function mintedRole(block: { category: string; key: string }): "status" | "work" {
  return (
    TURN_ROLES.get(`${block.category}/${block.key}`) ??
    defaultRole(block.category as Parameters<typeof defaultRole>[0], block.key)
  );
}

const stamped = (frame: ChatFrameView): ChatFrameView => {
  const block = (frame as { block?: { kind: string; category: string; key: string } }).block;
  if (block?.kind !== "activity") return frame;
  return { ...frame, block: { ...block, role: mintedRole(block) } } as ChatFrameView;
};

/**
 * What the thread drew, with the avatar's own art taken out: the face is drawn
 * from a seeded generator and React's `useId`, so two mounts of the same
 * transcript differ in the gradient ids and the blob's path and in nothing else.
 */
const drawn = (container: HTMLElement) =>
  (container.querySelector(".ch-thread") ?? container).innerHTML
    .replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>")
    .replace(/hav_r_\d+/g, "hav");

/** Every step the group is drawing, by the name on its summary. */
const stepNames = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".ch-activity-step .ch-activity-name")).map(
    (el) => el.textContent ?? "",
  );

/** Titles that are status snapshots: none of them is ever a step. */
const STATUS_TITLES = [
  "Connecting to Hermes",
  "Agent is working",
  "Loading conversation",
  "Conversation loaded",
  "Thinking…",
  "Thinking complete",
  "Current usage",
  "Preparing terminal",
];

describe("a recorded turn", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("the roles it replays come from core, not from a copy of core's rule", () => {
    // The parse is the load-bearing part: an empty map would silently fall back
    // to `defaultRole`, which calls a reasoning snapshot work, and every status
    // assertion below would then be passing for the wrong reason.
    expect(TURN_ROLES.get("generation/reasoning")).toBe("status");
    expect(defaultRole("generation", "reasoning")).toBe("work");
    expect(mintedRole({ category: "generation", key: "reasoning" })).toBe("status");
    // Everything else is core's own answer, unedited.
    for (const [category, key] of [
      ["connection", "connection"],
      ["queue", "queue"],
      ["history", "history:history"],
      ["usage", "usage"],
      ["generation", "generation"],
      ["notice", "status:foo"],
      ["notice", "error"],
    ] as Array<[Parameters<typeof defaultRole>[0], string]>)
      expect(mintedRole({ category, key })).toBe(defaultRole(category, key));
  });

  test("its durable rows arriving mid-stream draw one turn, not two", async () => {
    const frames = fixtureLines<ChatFrameView>("recorded-turn.ndjson").map(stamped);
    const arrivals = fixtureLines<{ session: string; message: ChatMessageView }>(
      "recorded-durable.ndjson",
    );
    const durableRows = arrivals.map((a) => a.message);
    const session = arrivals[0]!.session;
    const prompt = (durableRows[0]!.blocks[0] as { markdown: string }).markdown;
    // The box's clock, so the recorded stamps and the turn this test opens
    // describe the same minute rather than today's wall clock.
    setSystemTime(new Date("2026-09-19T17:28:59.481Z"));
    const now = Date.parse("2026-09-19T17:29:20Z");

    let transcript: ChatMessageView[] = [];
    const turns: ChatTurnHandlers[] = [];
    const streams: ChatStreamHandlers[] = [];
    const api: ChatApi = {
      fetchSwarms: async () => ({ swarms: [] }) as never,
      fetchSessions: async () => ({ sessions: [] }) as never,
      fetchHistory: async () => ({ session, messages: transcript }) as never,
      sendTurn: (_instance, _bot, _text, handlers) => {
        turns.push(handlers);
        return () => {};
      },
      abortTurn: async () => ({ aborted: true }) as never,
      chatStream: (handlers: ChatStreamHandlers) => {
        streams.push(handlers);
        return () => {};
      },
    };

    let store!: Chat;
    function Probe() {
      store = useChat();
      return threadEl(store.messages, now, store.live, store.activity);
    }
    const { container } = render(
      <ChatProvider api={api} eager={false}>
        <Probe />
      </ChatProvider>,
    );
    await act(async () => {
      store.select("silent-crane", "default");
    });
    await waitFor(() => expect(store.historyRead).toBe(true));
    await act(async () => {
      store.send(prompt);
    });

    /** One live frame, the way the turn's own stream delivers it. */
    const frame = async (index: number) => {
      await act(async () => turns[0]!.onFrame(frames[index]!));
    };
    /** One durable row, the way the observation delivers it. */
    const deliver = async (index: number) => {
      await act(async () => {
        streams[0]?.onFrame({ instance: "silent-crane", bot: "default", session }, {
          type: "message",
          message: durableRows[index]!,
        } as never);
      });
    };
    /** What must hold at every point of the turn, whatever has arrived. */
    const oneTurn = (steps: number) => {
      expect(container.querySelectorAll("article.ch-msg:not(.me)")).toHaveLength(1);
      expect(container.querySelectorAll(".ch-activity")).toHaveLength(1);
      const names = stepNames(container);
      // One step per distinct tool call id and no more: the defect drew the
      // box's copy of a call beside the live one. `Reasoning` steps are the
      // model's own work, not transport, and belong in the list.
      expect(names.filter((name) => name === "terminal")).toHaveLength(steps);
      for (const name of names) expect(STATUS_TITLES).not.toContain(name);
    };

    // The box's copy of the prompt, before the model has said anything.
    for (const index of [0, 1]) await frame(index);
    await deliver(0);
    expect(container.querySelectorAll("article.ch-msg.me")).toHaveLength(1);

    // First tool call, and the two rows the box wrote down for it.
    for (let index = 2; index <= 10; index += 1) await frame(index);
    oneTurn(1);
    await deliver(1);
    oneTurn(1);
    await deliver(2);
    oneTurn(1);

    // Second tool call, same again. A duplicated `terminal` step would show here.
    for (let index = 11; index <= 17; index += 1) await frame(index);
    oneTurn(2);
    await deliver(3);
    oneTurn(2);
    await deliver(4);
    oneTurn(2);

    // Prose, then the row carrying it.
    for (let index = 18; index <= 23; index += 1) await frame(index);
    oneTurn(2);
    await deliver(5);
    oneTurn(2);
    expect(container.textContent).toContain("verified");

    // The turn ends, the end-of-turn read lands, and what is drawn is what the
    // durable rows alone draw: the live record leaves nothing of itself behind.
    transcript = durableRows;
    await act(async () => turns[0]!.onFrame(frames[24]!));
    await act(async () => turns[0]!.onEnd(true, null));
    await waitFor(() => expect(store.live).toBeNull());
    await waitFor(() => expect(store.messages.map((m) => m.id)).toEqual(durableRows.map((m) => m.id)));
    const settled = drawn(container);
    cleanup();
    const durableOnly = render(threadEl(durableRows, now));
    expect(settled).toBe(drawn(durableOnly.container));
  });
});
