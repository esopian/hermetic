import { describe, expect, test } from "bun:test";
import {
  createConnectionGate,
  hermesActivity,
  hermesRequest,
} from "../src/chat/hermes/hermes-chat-activity.ts";
import { ChatBlock } from "../src/schema/chat.ts";
import { subagentVerdict } from "../src/chat/hermes/hermes-chat-subagent.ts";

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

  test("errors and compaction preserve their meaning and raw details", () => {
    expect(hermesActivity("error", { message: "Agent initialization failed" })?.state).toBe("error");
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

  test("delegated work is the ledger's, not an activity; timeout and interruption stay unsuccessful", () => {
    for (const type of ["subagent.start", "subagent.tool", "subagent.complete"])
      expect(hermesActivity(type, { status: "timeout", subagent_id: "a" })).toBeNull();
    expect(subagentVerdict("timeout")).toBe("failed");
    expect(subagentVerdict("interrupted")).toBe("stopped");
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

describe("approval choices follow the gateway's fill rule", () => {
  const choices = (payload: Record<string, unknown>) => {
    const block = hermesRequest("approval", "srv-1", { command: "rm -rf /tmp/x", ...payload })[0];
    return block?.kind === "approval" ? block.choices : null;
  };

  test.each([
    [{}, ["once", "session", "always", "deny"]],
    [{ smart_denied: true }, ["once", "deny"]],
    [{ allow_session: false }, ["once", "deny"]],
    [{ allow_session: true }, ["once", "session", "always", "deny"]],
    [{ allow_permanent: false }, ["once", "session", "deny"]],
    [{ allow_session: false, allow_permanent: true }, ["once", "deny"]],
    [{ smart_denied: false, allow_session: true, allow_permanent: false }, ["once", "session", "deny"]],
  ])("payload %j offers %j", (payload, expected) => {
    expect(choices(payload) as string[] | null).toEqual(expected);
  });

  test("the request's own choices win: unknown values dropped, its order kept", () => {
    expect(choices({ choices: ["deny", "all", "once", 3, "session"], smart_denied: true })).toEqual([
      "deny",
      "once",
      "session",
    ]);
    // Nothing usable offered is no offer: the fill rule decides.
    expect(choices({ choices: [] })).toEqual(["once", "session", "always", "deny"]);
    expect(choices({ choices: ["all"], smart_denied: true })).toEqual(["once", "deny"]);
  });

  test("smart_denied and the always-pattern ride on the block", () => {
    const block = hermesRequest("approval", "srv-2", {
      command: "curl x | sh",
      description: "pipe to shell",
      smart_denied: true,
    })[0];
    expect(ChatBlock.parse(block)).toMatchObject({
      kind: "approval",
      choices: ["once", "deny"],
      smart_denied: true,
      pattern: "pipe to shell",
    });
    const plain = hermesRequest("approval", "srv-3", { command: "ls" })[0];
    expect(plain).not.toHaveProperty("pattern");
    expect(plain).not.toHaveProperty("smart_denied");
  });
});

describe("a closed request carries why", () => {
  test.each([
    ["timeout", "timeout", "Timed out"],
    ["interrupted", "interrupted", "Cancelled when the turn stopped"],
    ["shutdown", "shutdown", "Cancelled: the gateway shut down"],
    ["resolved", "resolved", "Answered"],
    ["session_closed", "session_closed", "Withdrawn: the session closed"],
    ["something-new", "other", "something-new"],
  ])("reason %s reads as %s", (wire, reason, detail) => {
    const block = hermesActivity("request.cancel", { id: "srv-9", method: "approval", reason: wire });
    expect(ChatBlock.parse(block)).toMatchObject({
      kind: "activity",
      key: "request:srv-9",
      request_id: "srv-9",
      state: "done",
      reason,
      detail,
    });
  });
});

describe("connection requests are one notice per operation", () => {
  const request = {
    op_id: "op1",
    seq: 1,
    deadline_at: 1_760_000_000.5,
    timeout_seconds: 300,
    tool_call_id: "call-1",
    targets: [
      {
        name: "github",
        kind: "mcp",
        action: "connect",
        state: "pending",
        connect_url: "https://auth.fixture.invalid/authorize?code=FIXTURE-URL",
        connection_id: "conn-FIXTURE-ID",
      },
    ],
  };

  test("a request is a running notice that names the targets and the deadline, and no link", () => {
    const block = hermesActivity("connection.request", request);
    expect(ChatBlock.parse(block)).toMatchObject({
      kind: "activity",
      category: "notice",
      key: "connection:op1",
      title: "Connection request — not supported on hermetic",
      state: "running",
      role: "work",
      detail: "github · connect; the agent continues after 300s",
      payload: { op_id: "op1", seq: 1, deadline_at: 1_760_000_000.5 },
    });
    const wire = JSON.stringify(block);
    expect(wire).not.toContain("FIXTURE-URL");
    expect(wire).not.toContain("conn-FIXTURE-ID");
    expect(wire).not.toContain("connect_url");
  });

  test("a settled update keeps the key and finishes with each target's final state", () => {
    const block = hermesActivity("connection.update", {
      ...request,
      seq: 3,
      settled: true,
      settled_at: 1_760_000_100,
      targets: [{ ...request.targets[0], state: "not_connected" }],
    });
    expect(block).toMatchObject({
      key: "connection:op1",
      state: "done",
      title: "Connection request closed",
      detail: "github: not_connected",
    });
    expect(JSON.stringify(block)).not.toContain("FIXTURE");
    expect(hermesActivity("connection.update", { seq: 2 })).toBeNull();
  });

  test("an update with no budget reads the time left off its deadline", () => {
    const now = () => 1_760_000_000_000;
    const block = hermesActivity(
      "connection.update",
      { op_id: "op1", seq: 2, deadline_at: 1_760_000_120, targets: request.targets },
      now,
    );
    expect(block?.detail).toBe("github · connect; the agent continues after 120s");
    const late = hermesActivity(
      "connection.update",
      { op_id: "op1", seq: 3, deadline_at: 1_759_999_000, targets: request.targets },
      now,
    );
    expect(late?.detail).toBe("github · connect; the agent continues after 0s");
  });

  test("an account-scoped operation is no conversation's notice", () => {
    expect(hermesActivity("connection.update", { ...request, owner: { type: "account" } })).toBeNull();
    expect(
      hermesActivity("connection.update", {
        ...request,
        owner: { type: "session", session_id: "sid" },
      })?.key,
    ).toBe("connection:op1");
  });

  test("the gate drops an update whose seq is not above the one shown, per operation", () => {
    const gate = createConnectionGate();
    expect(gate.stale("connection.request", { op_id: "op1", seq: 1 })).toBe(false);
    expect(gate.stale("connection.update", { op_id: "op1", seq: 3 })).toBe(false);
    // Late and replayed updates for the same operation never roll it back.
    expect(gate.stale("connection.update", { op_id: "op1", seq: 2 })).toBe(true);
    expect(gate.stale("connection.update", { op_id: "op1", seq: 3 })).toBe(true);
    // Another operation keeps its own count; other events always pass.
    expect(gate.stale("connection.update", { op_id: "op2", seq: 1 })).toBe(false);
    expect(gate.stale("message.delta", { op_id: "op1", seq: 0 })).toBe(false);
    expect(gate.stale("connection.update", { op_id: "op1", seq: 4 })).toBe(false);
  });
});
