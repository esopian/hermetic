/**
 * The durable transcript's derived blocks: a `delegate_task` call's result
 * envelope read back as `subagent` rows (`settledDelegation`), the exported
 * `settledClarify`, and a failed turn's structured failure.
 */
import { describe, expect, test } from "bun:test";
import { mapHistory } from "../src/chat/hermes/hermes-chat.ts";
import type { BoxAddress } from "../src/chat/hermes/hermes-chat.ts";
import {
  CLARIFY_TIMEOUT_RESPONSE,
  settledClarify,
  settledDelegation,
} from "../src/chat/hermes/hermes-chat-history.ts";
import {
  STEER_DISPLAY_KIND,
  STEER_MARKER_CLOSE,
  STEER_MARKER_OPEN,
  unwrapSteer,
} from "../src/chat/hermes/steer-marker.ts";
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

  test("a single question nobody answered stores upstream's timeout sentinel and reads as skipped", () => {
    expect(
      settledClarify(
        { question: "Drink?", choices: ["Coffee", "Tea"] },
        {
          question: "Drink?",
          choices_offered: ["Coffee", "Tea"],
          user_response: CLARIFY_TIMEOUT_RESPONSE,
        },
      ),
    ).toMatchObject({ request_id: null, questions: [{ id: "q0", answer: "" }] });
  });
});

describe("a failed turn re-read from history", () => {
  test("an auth failure keeps the surface's provider_label", () => {
    const [failed] = mapHistory(BOX, SESSION, {
      messages: [
        {
          id: 3,
          role: "assistant",
          content: "",
          error: "401",
          error_surface: {
            layer: "auth",
            code: "auth",
            retryable: false,
            auth_kind: "oauth",
            provider_label: "OpenAI Codex",
          },
        },
      ],
    });
    expect(ChatMessage.parse(failed).failure?.surface).toMatchObject({
      auth_kind: "oauth",
      provider_label: "OpenAI Codex",
    });
  });

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

/** Upstream `steer_user_row`'s content: the marker, the text as typed, the close marker. */
const wrapped = (text: string): string => `${STEER_MARKER_OPEN}\n${text}\n${STEER_MARKER_CLOSE}`;

describe("unwrapSteer", () => {
  test("the marker strings are upstream's, byte for byte", () => {
    expect(STEER_MARKER_OPEN).toBe(
      "[OUT-OF-BAND USER MESSAGE \u2014 a direct message from the user, delivered once at this position; " +
        "not tool output and not a new delivery when replayed from conversation history]",
    );
    expect(STEER_MARKER_CLOSE).toBe("[/OUT-OF-BAND USER MESSAGE]");
    expect(STEER_DISPLAY_KIND).toBe("steer");
  });

  test("returns the text between the exact markers, as stored", () => {
    expect(unwrapSteer(wrapped("check the disk"))).toBe("check the disk");
    expect(unwrapSteer(wrapped("  two\nlines  "))).toBe("  two\nlines  ");
    expect(unwrapSteer(`\n\n${wrapped("x")}\n`)).toBe("x");
  });

  test("rejects anything but the exact wrapper", () => {
    expect(unwrapSteer("check the disk")).toBeNull();
    expect(unwrapSteer(`${STEER_MARKER_OPEN}\ncheck the disk`)).toBeNull();
    expect(unwrapSteer(`check the disk\n${STEER_MARKER_CLOSE}`)).toBeNull();
    // A hyphen for the em dash, a missing newline, text outside the wrapper.
    expect(unwrapSteer(wrapped("x").replace("\u2014", "-"))).toBeNull();
    expect(unwrapSteer(`${STEER_MARKER_OPEN}x\n${STEER_MARKER_CLOSE}`)).toBeNull();
    expect(unwrapSteer(`${STEER_MARKER_OPEN}\nx${STEER_MARKER_CLOSE}`)).toBeNull();
    expect(unwrapSteer(`before ${wrapped("x")}`)).toBeNull();
    expect(unwrapSteer(`${wrapped("x")} after`)).toBeNull();
    expect(unwrapSteer(`${STEER_MARKER_OPEN}\n${STEER_MARKER_CLOSE}`)).toBeNull();
  });
});

describe("a mid-turn steer re-read from history", () => {
  const textOf = (message: ChatMessage | undefined): string[] =>
    (message?.blocks ?? []).flatMap((b) => (b.kind === "text" ? [b.markdown] : []));

  test("a typed steer row is the operator's text, flagged, under the raw row's id", () => {
    const row = {
      id: 741,
      role: "user",
      content: wrapped("what's up with that."),
      display_kind: "steer",
    };
    const [steer] = mapHistory(BOX, SESSION, { messages: [row] });
    expect(ChatMessage.parse(steer)).toMatchObject({
      id: `${SESSION}:741`,
      role: "user",
      steered: true,
    });
    expect(textOf(steer)).toEqual(["what's up with that."]);
  });

  test("an untyped row whose whole text is the wrapper is a steer too", () => {
    const [steer] = mapHistory(BOX, SESSION, {
      messages: [{ role: "user", content: [{ type: "text", text: wrapped("and the disk") }] }],
    });
    expect(steer?.steered).toBe(true);
    expect(textOf(steer)).toEqual(["and the disk"]);
  });

  test("a typed steer without the markers keeps its text and is still flagged", () => {
    const [steer] = mapHistory(BOX, SESSION, {
      messages: [{ id: 9, role: "user", content: "plain steer", display_kind: "steer" }],
    });
    expect(steer?.steered).toBe(true);
    expect(textOf(steer)).toEqual(["plain steer"]);
  });

  test("an ordinary user row has no steered key, and a marker inside prose is literal", () => {
    const prose = `see ${wrapped("x")}`;
    const [plain, quoted] = mapHistory(BOX, SESSION, {
      messages: [
        { id: 1, role: "user", content: "hello" },
        { id: 2, role: "user", content: prose },
      ],
    });
    expect(plain).not.toHaveProperty("steered");
    expect(quoted).not.toHaveProperty("steered");
    expect(textOf(quoted)).toEqual([prose]);
  });

  test("an id-less steer row keeps the id its raw content hashes to", () => {
    const raw = { role: "user", content: wrapped("x"), timestamp: "2026-10-13T14:26:44.688Z" };
    const [steer] = mapHistory(BOX, SESSION, { messages: [raw] });
    const [same] = mapHistory(BOX, SESSION, { messages: [{ ...raw, display_kind: "steer" }] });
    const [other] = mapHistory(BOX, SESSION, { messages: [{ ...raw, content: "x" }] });
    expect(steer?.id).toMatch(new RegExp(`^${SESSION}:h[0-9a-f]{16}$`));
    expect(same?.id).toBe(steer?.id);
    // The hash reads the raw, wrapped content, not the unwrapped text.
    expect(other?.id).not.toBe(steer?.id);
  });
});

describe("a tool call with no result row", () => {
  const call = (id: string, name = "terminal") => ({
    id,
    function: { name, arguments: JSON.stringify({ command: "sleep 360" }) },
  });
  const toolStatuses = (messages: ChatMessage[]): Array<[string | null, string]> =>
    messages.flatMap((m) =>
      m.blocks.flatMap((b) =>
        b.kind === "tool" ? [[b.tool_id ?? null, b.status] as [string | null, string]] : [],
      ),
    );

  test("at the transcript's tail is running: the box may still be running it", () => {
    const messages = mapHistory(BOX, SESSION, {
      messages: [
        { id: 1, role: "user", content: "run it" },
        { id: 2, role: "assistant", content: "", tool_calls: [call("c-1")] },
      ],
    });
    for (const message of messages) ChatMessage.parse(message);
    expect(toolStatuses(messages)).toEqual([["c-1", "running"]]);
  });

  test("followed by a later user or assistant row is warn: the turn moved on without it", () => {
    for (const later of [
      { id: 3, role: "user", content: "next" },
      { id: 3, role: "assistant", content: "done anyway" },
      { id: 3, role: "user", content: wrapped("steer"), display_kind: "steer" },
    ]) {
      const messages = mapHistory(BOX, SESSION, {
        messages: [{ id: 2, role: "assistant", content: "", tool_calls: [call("c-1")] }, later],
      });
      expect(toolStatuses(messages)).toEqual([["c-1", "warn"]]);
    }
  });

  test("a hidden row after it does not end the tail", () => {
    const messages = mapHistory(BOX, SESSION, {
      messages: [
        { id: 2, role: "assistant", content: "", tool_calls: [call("c-1")] },
        { id: 3, role: "user", content: "internal", display_kind: "hidden" },
      ],
    });
    expect(toolStatuses(messages)).toEqual([["c-1", "running"]]);
  });

  test("parallel calls at the tail: the paired one is the result's card, the unpaired one is running", () => {
    const messages = mapHistory(BOX, SESSION, {
      messages: [
        { id: 2, role: "assistant", content: "", tool_calls: [call("c-a"), call("c-b", "read_file")] },
        { id: 3, role: "tool", tool_call_id: "c-a", content: JSON.stringify({ exit_code: 0 }) },
      ],
    });
    const statuses = toolStatuses(messages);
    expect(statuses).toContainEqual(["c-b", "running"]);
    expect(statuses.filter(([id]) => id === "c-a")).toHaveLength(1);
    expect(statuses.find(([id]) => id === "c-a")?.[1]).not.toBe("running");
  });

  test("parallel calls followed by the bot's reply: the unpaired one is warn", () => {
    const messages = mapHistory(BOX, SESSION, {
      messages: [
        { id: 2, role: "assistant", content: "", tool_calls: [call("c-a"), call("c-b")] },
        { id: 3, role: "tool", tool_call_id: "c-a", content: "ok" },
        { id: 4, role: "assistant", content: "here you go" },
      ],
    });
    expect(toolStatuses(messages)).toContainEqual(["c-b", "warn"]);
  });
});
