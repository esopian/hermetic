import { describe, expect, test } from "bun:test";
import { hermesActivity, hermesRequest } from "../src/chat/hermes/hermes-chat-activity.ts";
import { ChatBlock } from "../src/schema/chat.ts";

describe("pinned Hermes activity", () => {
  test("observed progress has stable replacement keys and failures stay visible", () => {
    const loading = hermesActivity("session.resume_progress", { phase: "history", status: "loading" });
    const complete = hermesActivity("session.resume_progress", {
      phase: "history",
      status: "complete",
      message_count: 3,
    });
    const failed = hermesActivity("session.resume_progress", {
      phase: "history",
      status: "failed",
      message: "missing transcript",
    });
    expect(loading?.key).toBe(complete?.key);
    expect(loading?.state).toBe("running");
    expect(complete?.state).toBe("done");
    expect(failed).toMatchObject({ state: "error", detail: "missing transcript" });
    expect(hermesActivity("tool.generating", { name: "clarify" })?.title).toBe("Preparing clarify");
  });

  test("usage snapshots retain source data without becoming additive message usage", () => {
    const payload = { usage: { input: 1234, output: 20, cost_usd: 0.125, context_max: 200000 } };
    const block = ChatBlock.parse(hermesActivity("session.usage", payload));
    expect(block).toMatchObject({ kind: "activity", category: "usage", key: "usage", payload });
    expect(block).not.toHaveProperty("usage");
    expect(block.kind === "activity" && block.detail).toBe(
      "1,234 input tokens · 20 output tokens · $0.1250",
    );
  });

  test("role marks transport status apart from work the turn did", () => {
    expect(hermesActivity("tool.generating", { name: "clarify" })?.role).toBe("status");
    expect(hermesActivity("error", { message: "Agent initialization failed" })?.role).toBe("work");
    expect(hermesActivity("notice", { message: "restarted" })?.role).toBe("work");
  });

  test("errors, redaction findings and compaction preserve their meaning and raw details", () => {
    expect(hermesActivity("error", { message: "Agent initialization failed" })?.state).toBe("error");
    expect(
      hermesActivity("tool.output_risk", {
        tool_id: "call1",
        redacted: true,
        findings: ["credential"],
      }),
    ).toMatchObject({ key: "risk:call1", state: "warning", detail: "credential" });
    expect(
      hermesActivity("status.update", { kind: "compacting", text: "Compacting context" }),
    ).toMatchObject({ key: "status:compacting", title: "Compacting context" });
    expect(hermesActivity("notification.clear", { key: "slow-build" })?.key).toBe(
      hermesActivity("notification.show", { key: "slow-build", text: "Starting", level: "warn" })?.key,
    );
  });

  test("unfamiliar or malformed activity keeps the unknown fallback", () => {
    expect(hermesActivity("message.error", { message: "not in the pinned contract" })).toBeNull();
    expect(
      hermesActivity("session.resume_progress", { phase: "history", status: "future" }),
    ).toBeNull();
    expect(hermesActivity("tool.generating", { other: "field" })).toBeNull();
  });

  test("delegated timeout and interruption remain unsuccessful outcomes", () => {
    expect(hermesActivity("subagent.complete", { status: "timeout", subagent_id: "a" })).toMatchObject({
      state: "error",
      title: "Delegated work timed out",
    });
    expect(
      hermesActivity("subagent.complete", { status: "interrupted", subagent_id: "b" }),
    ).toMatchObject({ state: "warning", title: "Delegated work was interrupted" });
  });

  test("real request IDs, choices, batches and unknown request details survive", () => {
    const approval = hermesRequest("approval", "srv-1", {
      tool_name: "terminal",
      command: "run",
      description: "Needs approval",
      choices: ["once", "deny"],
    });
    expect(ChatBlock.parse(approval[0])).toMatchObject({
      kind: "approval",
      request_id: "srv-1",
      tool: "terminal",
      summary: "run",
    });
    const params = {
      session_id: "runtime",
      questions: [
        {
          qid: "a",
          question: "Which region?",
          choices: ["west (Recommended)", "east", "two\nlines", "x".repeat(201), "  "],
          multi_select: true,
        },
        { question: "No qid, so it cannot be answered" },
        { qid: "c", question: "   " },
        { qid: "b", question: " Why? ", choices: ["\n"], multi_select: true },
      ],
      answers: { b: "Latency", a: 7 },
    };
    const batch = hermesRequest("clarify", "srv-2", params);
    // One request is one block: the gateway keeps it open until every
    // question is locked, so a card per question would each claim "sent".
    expect(batch).toHaveLength(1);
    expect(ChatBlock.parse(batch[0])).toEqual({
      kind: "question",
      request_id: "srv-2",
      prompt: "Which region?",
      choices: ["west (Recommended)", "east"],
      multi_select: true,
      questions: [
        {
          id: "a",
          prompt: "Which region?",
          choices: ["west (Recommended)", "east"],
          multi_select: true,
          answer: null,
        },
        { id: "b", prompt: "Why?", choices: [], multi_select: false, answer: "Latency" },
      ],
      expires_at: null,
      payload: params,
    });
    // A 200-character choice survives once its " (Recommended)" label is discounted.
    const long = `${"y".repeat(200)} (Recommended)`;
    expect(
      hermesRequest("clarify", "srv-4", { question: "Pick", choices: [long, "", "ok"] })[0],
    ).toMatchObject({ kind: "question", prompt: "Pick", choices: [long, "ok"] });
    expect(hermesRequest("clarify", "srv-4", { question: "Pick" })[0]).not.toHaveProperty("questions");
    // A batch with nothing answerable is not a question card at all.
    expect(hermesRequest("clarify", "srv-5", { questions: [{ question: "no qid" }] })[0]).toMatchObject(
      { kind: "activity", title: "Hermes needs your attention" },
    );
    expect(hermesRequest("vault.unlock_prompt", "srv-3", { backend: "vault" })[0]).toMatchObject({
      kind: "activity",
      state: "warning",
      payload: { method: "vault.unlock_prompt", request_id: "srv-3", backend: "vault" },
    });
  });
});
