/**
 * The durable transcript's derived blocks: a `delegate_task` call's result
 * envelope read back as `subagent` rows (`settledDelegation`), the exported
 * `settledClarify`, and a failed turn's structured failure.
 */
import { describe, expect, test } from "bun:test";
import { mapHistory } from "../src/chat/hermes/hermes-chat.ts";
import type { BoxAddress } from "../src/chat/hermes/hermes-chat.ts";
import { settledClarify, settledDelegation } from "../src/chat/hermes/hermes-chat-history.ts";
import { ChatBlock, ChatMessage } from "../src/schema/index.ts";

const BOX: BoxAddress = {
  instance: "atlas",
  baseUrl: "https://fxtr0001-atlas.tail0000.ts.net/",
  fleet_id: "fxtr0001",
};
const SESSION = "s-bot-chat";

/** Upstream's synchronous envelope (`delegate_tool_dispatch.py`), one entry per task. */
const SYNC_RESULT = {
  results: [
    {
      task_index: 0,
      status: "completed",
      summary: "Found three stale volumes.",
      api_calls: 4,
      duration_seconds: 12.5,
      model: "claude-sonnet-5",
      exit_reason: "completed",
      truncated: false,
      tokens: { input: 1200, output: 340 },
      tool_trace: [
        { tool: "terminal", args_bytes: 40, input_summary: "aws ec2 describe-volumes", status: "ok" },
        { tool: "read_file", args_bytes: 12, input_summary: "/tmp/v.json", status: "error" },
        { tool: "web_search", input: "ebs gp3 pricing", ok: false },
      ],
      cost_usd: 0.0123,
      cost_status: "estimated",
    },
    {
      task_index: 1,
      status: "failed",
      summary: "",
      api_calls: 1,
      duration_seconds: 3,
      model: "claude-sonnet-5",
      exit_reason: "max_iterations",
      truncated: true,
      tokens: { input: 300, output: 10 },
      tool_trace: [],
      cost_usd: 0,
      error: "Subagent did not produce a response.",
      failure_reason: "rate_limit",
    },
    { task_index: 2, status: "exploded" },
  ],
  total_duration_seconds: 15.6,
};

const ARGS = {
  tasks: [{ goal: "Audit volumes" }, { goal: "Price gp3" }, { goal: "Third" }],
};

describe("settledDelegation", () => {
  test("a synchronous envelope is one history row per task, with every field it carries", () => {
    const rows = settledDelegation("call-7", ARGS, SYNC_RESULT);
    for (const row of rows) ChatBlock.parse(row);
    expect(rows.map((r) => r.subagent_id)).toEqual(["hist:call-7:0", "hist:call-7:1", "hist:call-7:2"]);
    expect(rows[0]).toEqual({
      kind: "subagent",
      subagent_id: "hist:call-7:0",
      depth: 0,
      task_index: 0,
      task_count: 3,
      goal: "Audit volumes",
      tools: [
        { name: "terminal", preview: "aws ec2 describe-volumes" },
        { name: "read_file", preview: "/tmp/v.json", is_error: true },
        { name: "web_search", preview: "ebs gp3 pricing", is_error: true },
      ],
      tool_count: 3,
      origin: "history",
      tool_id: "call-7",
      status: "completed",
      verdict: "done",
      model: "claude-sonnet-5",
      summary: "Found three stale volumes.",
      duration_ms: 12_500,
      usage: { input_tokens: 1200, output_tokens: 340, api_calls: 4 },
      result: { cost_usd: 0.0123, exit_reason: "completed", truncated: false },
    });
    expect(rows[1]).toMatchObject({
      goal: "Price gp3",
      status: "failed",
      verdict: "failed",
      result: {
        cost_usd: 0,
        exit_reason: "max_iterations",
        truncated: true,
        error: "Subagent did not produce a response.",
        failure_reason: "rate_limit",
      },
    });
    expect(rows[1]).not.toHaveProperty("summary");
    // A status this build does not know is never read as success.
    expect(rows[2]).toMatchObject({ status: "unobserved", verdict: "unknown", goal: "Third" });
  });

  test("a single-task call takes its goal from `goal`, and an envelope id wins over the synthetic one", () => {
    const rows = settledDelegation(
      "call-1",
      { goal: "Only task" },
      { results: [{ task_index: 0, status: "timeout", subagent_id: "sa-real" }] },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subagent_id: "sa-real",
      goal: "Only task",
      task_count: 1,
      status: "timeout",
      verdict: "failed",
    });
  });

  test("a background handle is a dispatched row per goal, under its delegation", () => {
    const rows = settledDelegation("call-2", ARGS, {
      status: "dispatched",
      mode: "background",
      count: 2,
      delegation_id: "deleg-1",
      goals: ["Audit volumes", "Price gp3"],
      subagent_ids: ["sa-a", null],
    });
    expect(rows.map((r) => [r.subagent_id, r.goal, r.status, r.verdict, r.delegation_id])).toEqual([
      ["sa-a", "Audit volumes", "dispatched", "running", "deleg-1"],
      ["hist:call-2:1", "Price gp3", "dispatched", "running", "deleg-1"],
    ]);
    expect(rows.every((r) => r.origin === "history" && r.task_count === 2)).toBe(true);
  });

  test("a multi-unit handle gives each task its own unit's delegation id", () => {
    const rows = settledDelegation("call-3", ARGS, {
      status: "dispatched",
      delegation_id: "deleg-top",
      goals: ["a", "b", "c"],
      units: [
        { delegation_id: "unit-x", group: "g1", task_indexes: [0, 2] },
        { delegation_id: "unit-y", group: null, task_indexes: [1] },
      ],
    });
    expect(rows.map((r) => r.delegation_id)).toEqual(["unit-x", "unit-y", "unit-x"]);
  });

  test("an unknown shape, an error, or plain text yields no rows", () => {
    expect(settledDelegation("c", ARGS, { error: "delegation disabled" })).toEqual([]);
    expect(settledDelegation("c", ARGS, "Delegated.")).toEqual([]);
    expect(settledDelegation("c", ARGS, { status: "queued" })).toEqual([]);
    expect(settledDelegation("c", ARGS, null)).toEqual([]);
  });

  test("history places the rows right after the delegate_task tool block", () => {
    const messages = mapHistory(BOX, SESSION, {
      messages: [
        {
          id: 1,
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-7",
              function: { name: "delegate_task", arguments: JSON.stringify(ARGS) },
            },
          ],
        },
        { id: 2, role: "tool", tool_call_id: "call-7", content: JSON.stringify(SYNC_RESULT) },
      ],
    });
    const blocks = messages.flatMap((m) => m.blocks);
    expect(blocks.map((b) => b.kind)).toEqual(["tool", "subagent", "subagent", "subagent"]);
    for (const message of messages) ChatMessage.parse(message);
  });
});

describe("settledClarify is exported for the fixture's history", () => {
  test("a single answered question", () => {
    expect(
      settledClarify(
        { question: "Drink?", choices: ["Coffee", "Tea"] },
        { question: "Drink?", choices_offered: ["Coffee", "Tea"], user_response: "Tea" },
      ),
    ).toMatchObject({ kind: "question", request_id: null, questions: [{ id: "q0", answer: "Tea" }] });
  });
});

describe("a failed turn re-read from history", () => {
  test("carries its structured failure beside the error string", () => {
    const [failed, fine] = mapHistory(BOX, SESSION, {
      messages: [
        {
          id: 3,
          role: "assistant",
          content: "partial",
          error: "429 Too Many Requests",
          error_surface: {
            layer: "provider",
            code: "rate_limited",
            retryable: true,
            resets_at: 1_760_000_000,
          },
        },
        { id: 4, role: "assistant", content: "ok" },
      ],
    });
    expect(ChatMessage.parse(failed)).toMatchObject({
      error: "429 Too Many Requests",
      failure: {
        code: "CHAT_TURN_FAILED",
        message: "429 Too Many Requests",
        surface: { layer: "provider", code: "rate_limited", retryable: true, resets_at: 1_760_000_000 },
      },
    });
    expect(fine).not.toHaveProperty("failure");
  });

  test("an error with no surface still has a failure", () => {
    const [failed] = mapHistory(BOX, SESSION, {
      messages: [{ id: 5, role: "assistant", content: "", error: "boom" }],
    });
    expect(failed?.failure).toEqual({ code: "CHAT_TURN_FAILED", message: "boom" });
  });
});
