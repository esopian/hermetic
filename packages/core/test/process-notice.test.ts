/**
 * `parseProcessNotice` against one verbatim string per branch of upstream's
 * formatters (`tools/process_registry.py` `format_process_notification` and
 * `_format_async_delegation`, the watch-disabled message, the MCP reload
 * notice), plus the text that must never be mistaken for one.
 */
import { describe, expect, test } from "bun:test";
import { parseProcessNotice, processNoticePreview } from "../src/chat/hermes/process-notice.ts";
import { ChatBlock } from "../src/schema/index.ts";

/** A real DM delivery notice, captured from a box (profile and hash are real, nothing secret). */
export const DM_NOTICE =
  '[IMPORTANT: Background process proc_f9a9a12fefed completed normally (exit code 0).\nCommand: /usr/local/lib/hermes-agent/venv/bin/python /usr/local/lib/hermes-agent/tools/bot_mode_dm.py --run-delivery --author \'{"id":"bot:default","name":"hermes","is_bot":true}\' query-file /tmp/hermes-dm-999/dm-dw5rf82j.txt --profile-home /data/hermes/.hermes/profiles/lead-qa hermes -p lead-qa chat --in \'~\' -c \'Bot Chat\' --create-if-missing -Q\nOutput:\n ⚠ tirith security scanner enabled but not available — command scanning will use pattern matching only\nChecked its "byte-identical" claim since it was new evidence. Holds where it matters: the `chrome` binary hashes match exactly (839efe5f...), so the store build is the /opt/hermetic build.]';

const completion = (status: string, exit: string, output = "done\n") =>
  `[IMPORTANT: Background process proc_abc123 ${status} (exit code ${exit}).\nCommand: bun run build\nOutput:\n${output}]`;

const batchHead = (n: number) =>
  `[ASYNC DELEGATION BATCH COMPLETE — deleg_b1]\nA background fan-out of ${n} subagent(s) you dispatched earlier has finished. All ran in parallel and waited on each other; their consolidated results are below. You may have moved on since dispatching — act on these or re-dispatch if things have changed.\n\nDispatched: 2026-09-29 00:20:00 (4m ago)\nToolsets: terminal, file\nRole: leaf   Model: claude   Total duration: 241.5s`;

const singleHead = (status: string) =>
  `[ASYNC DELEGATION COMPLETE — deleg_s1]\nA background subagent you dispatched earlier has finished. You may have moved on since dispatching it; the full task source is below so you can act on the result or re-dispatch if things have changed.\n\nDispatched: 2026-09-29 00:20:00 (2m ago)\nOriginal goal: Find every user-role renderer\nand list them\nContext you provided: packages/ui only\nRole: leaf   Model: claude\nStatus: ${status}   API calls: 7   Duration: 93.2s\n--- RESULT ---\n`;

type Case = [name: string, text: string, expected: Record<string, unknown>];

const CASES: Case[] = [
  [
    "completed normally",
    completion("completed normally", "0", "line 1\nline 2\n"),
    {
      event: "completion",
      outcome: "ok",
      process_id: "proc_abc123",
      status: "completed normally",
      exit_code: 0,
      signal: null,
      command: "bun run build",
      output_tail: "line 1\nline 2",
      output_lines: 2,
    },
  ],
  [
    "exited",
    completion("exited", "1"),
    { event: "completion", outcome: "failed", status: "exited", exit_code: 1 },
  ],
  [
    "terminated by a named source",
    completion("terminated by user", "-9"),
    { outcome: "terminated", status: "terminated by user", exit_code: -9, signal: null },
  ],
  [
    "terminated with SIGTERM",
    "[IMPORTANT: Background process proc_abc123 terminated by Hermes (exit code -15, SIGTERM).\nCommand: python -m http.server 8080\nOutput:\n]",
    {
      outcome: "terminated",
      status: "terminated by Hermes",
      exit_code: -15,
      signal: "SIGTERM",
      output_tail: "",
      output_lines: 0,
    },
  ],
  [
    "exited 143 with SIGTERM",
    completion("exited", "143, SIGTERM"),
    { outcome: "terminated", status: "exited", exit_code: 143, signal: "SIGTERM" },
  ],
  [
    "failed to start",
    completion("failed to start", "?"),
    { outcome: "failed", status: "failed to start", exit_code: null },
  ],
  [
    "marked lost",
    completion("marked lost because the process backend disappeared", "?"),
    {
      outcome: "failed",
      status: "marked lost because the process backend disappeared",
      exit_code: null,
    },
  ],
  ["exit code ?", completion("exited", "?"), { outcome: "failed", exit_code: null }],
  [
    "output containing brackets",
    completion("completed normally", "0", "[1/2] ok]\n[2/2] ok\n"),
    { outcome: "ok", output_tail: "[1/2] ok]\n[2/2] ok", output_lines: 2 },
  ],
  [
    "watch match",
    '[IMPORTANT: Background process proc_w1 matched watch pattern "ERROR".\nCommand: tail -F /var/log/app.log\nMatched output:\nERROR one\nERROR two]',
    {
      event: "watch_match",
      outcome: "info",
      process_id: "proc_w1",
      command: "tail -F /var/log/app.log",
      output_tail: "ERROR one\nERROR two",
      output_lines: 2,
      watch: { pattern: "ERROR", suppressed: 0 },
    },
  ],
  [
    "watch match with suppressed",
    '[IMPORTANT: Background process proc_w1 matched watch pattern "ERROR".\nCommand: tail -F /var/log/app.log\nMatched output:\nERROR one\n(2 earlier matches were suppressed by rate limit)]',
    {
      event: "watch_match",
      output_tail: "ERROR one",
      output_lines: 1,
      watch: { pattern: "ERROR", suppressed: 2 },
    },
  ],
  [
    "watch disabled",
    "[IMPORTANT: Watch patterns disabled for process proc_w1 — 3 consecutive rate-limit windows triggered (min spacing 15s). Falling back to notify_on_complete semantics; you'll get exactly one notification when the process exits.]",
    {
      event: "watch_disabled",
      outcome: "info",
      process_id: "proc_w1",
      message:
        "Watch patterns disabled for process proc_w1 — 3 consecutive rate-limit windows triggered (min spacing 15s). Falling back to notify_on_complete semantics; you'll get exactly one notification when the process exits.",
    },
  ],
  [
    "MCP reload",
    "[IMPORTANT: MCP servers have been reloaded. Added servers: github. 12 MCP tool(s) now available. The tool list for this conversation has been updated accordingly.]",
    {
      event: "mcp_reload",
      outcome: "info",
      message:
        "MCP servers have been reloaded. Added servers: github. 12 MCP tool(s) now available. The tool list for this conversation has been updated accordingly.",
    },
  ],
  [
    "other IMPORTANT",
    "[IMPORTANT: The session was compacted.]",
    { event: "other_important", outcome: "info", message: "The session was compacted." },
  ],
  [
    "single delegation completed",
    `${singleHead("completed")}Found three renderers.`,
    {
      event: "delegation",
      outcome: "ok",
      duration_s: 93.2,
      delegation: {
        id: "deleg_s1",
        batch: false,
        status: "completed",
        total: 1,
        succeeded: 1,
        api_calls: 7,
        error: null,
        tasks: [
          {
            index: 1,
            goal: "Find every user-role renderer\nand list them",
            status: "completed",
            ok: true,
            summary: "Found three renderers.",
            duration_s: 93.2,
            api_calls: 7,
          },
        ],
      },
    },
  ],
  [
    "single delegation failed",
    `${singleHead("failed")}The subagent did not complete successfully (status=failed).\nrate limited\nPartial output:\nhalf a list`,
    { outcome: "failed", delegation: { status: "failed", succeeded: 0, error: "rate limited" } },
  ],
  [
    "single delegation interrupted",
    `${singleHead("interrupted")}The subagent was interrupted before completing: user stop`,
    { outcome: "failed", delegation: { status: "interrupted", error: "user stop" } },
  ],
  [
    "batch with mixed results",
    `${batchHead(2)}\n\n--- ✓ TASK 1/2: Audit css  (status=completed, api_calls=4, 12.5s) ---\nNo leaks.\n\n--- ✗ TASK 2/2: Draft cases  (status=failed, 3.0s) ---\n(failed: boom)\nPartial output:\ntwo cases`,
    {
      event: "delegation",
      outcome: "failed",
      duration_s: 241.5,
      delegation: {
        id: "deleg_b1",
        batch: true,
        status: null,
        total: 2,
        succeeded: 1,
        api_calls: 4,
        error: null,
        tasks: [
          {
            index: 1,
            goal: "Audit css",
            status: "completed",
            ok: true,
            summary: "No leaks.",
            duration_s: 12.5,
            api_calls: 4,
          },
          {
            index: 2,
            goal: "Draft cases",
            status: "failed",
            ok: false,
            summary: "(failed: boom)\nPartial output:\ntwo cases",
            duration_s: 3,
            api_calls: null,
          },
        ],
      },
    },
  ],
  [
    "batch error branch",
    `${batchHead(3)}\n--- ERROR ---\nThe batch did not complete successfully: worker pool exhausted`,
    {
      outcome: "failed",
      delegation: { batch: true, total: 3, succeeded: 0, tasks: [], error: "worker pool exhausted" },
    },
  ],
];

describe("parseProcessNotice", () => {
  test.each(CASES)("%s", (_name, text, expected) => {
    const block = parseProcessNotice(text);
    expect(block).toMatchObject({ kind: "process_event", raw: text, ...expected });
    // Every block the parser builds must pass the schema the wire validates.
    expect(ChatBlock.safeParse(block).success).toBe(true);
  });

  test.each([
    ["plain prose", "lead-qa said the build is byte-identical."],
    ["an unclosed IMPORTANT", "[IMPORTANT: Background process proc_x completed normally"],
    [
      "a user quoting a notice mid-message",
      "Why did I get this? [IMPORTANT: Background process proc_x completed normally (exit code 0).\nCommand: ls\nOutput:\n]",
    ],
    ["an empty string", ""],
    [
      "a skill invocation the operator typed",
      '[IMPORTANT: The user has invoked the "review" skill, indicating they want you to follow its instructions.]\n\nreview the diff [Runtime note: cwd is /repo]',
    ],
    [
      "a one-line skill hint",
      '[IMPORTANT: The user has invoked the "review" skill, indicating they want you to follow its instructions.]',
    ],
    [
      "a cron job's first row",
      "[IMPORTANT: You are running as a scheduled cron job. There is no user present.]\n\nSummarise [today]",
    ],
    ["a multi-line bracket", "[IMPORTANT: first line\nsecond line]"],
    ["an inner bracket", "[IMPORTANT: see [this] first]"],
    ["an MCP lookalike across lines", "[IMPORTANT: MCP servers have been reloaded.]\nand then [more]"],
  ])("%s is not a notice", (_name, text) => {
    expect(parseProcessNotice(text)).toBeNull();
  });

  test("CRLF line endings parse the same, raw kept verbatim", () => {
    const text = completion("completed normally", "0").replace(/\n/g, "\r\n");
    expect(parseProcessNotice(text)).toMatchObject({
      outcome: "ok",
      command: "bun run build",
      output_tail: "done",
      raw: text,
    });
  });

  test("a DM delivery carries the other bot's reply", () => {
    const block = parseProcessNotice(DM_NOTICE);
    expect(block?.event).toBe("completion");
    expect(block?.outcome).toBe("ok");
    expect(block?.dm?.to_profile).toBe("lead-qa");
    expect(block?.dm?.warnings).toEqual([
      "⚠ tirith security scanner enabled but not available — command scanning will use pattern matching only",
    ]);
    expect(block?.dm?.reply.startsWith('Checked its "byte-identical"')).toBe(true);
    expect(block?.dm?.reply.endsWith("/opt/hermetic build.")).toBe(true);
  });

  test("a failed DM delivery is a failure, not the other bot's reply", () => {
    const text = DM_NOTICE.replace("completed normally (exit code 0)", "exited (exit code 1)");
    const block = parseProcessNotice(text);
    expect(block?.outcome).toBe("failed");
    expect(block?.dm).toBeNull();
  });

  test("a command merely mentioning the DM script is not a delivery", () => {
    const text = completion("completed normally", "0").replace(
      "bun run build",
      "grep -n 'bot_mode_dm.py --run-delivery x hermes -p lead chat' notes.txt",
    );
    expect(parseProcessNotice(text)?.dm).toBeNull();
  });

  test("a quoted profile is read without its quotes", () => {
    const text = completion("completed normally", "0").replace(
      "bun run build",
      "python tools/bot_mode_dm.py --run-delivery q hermes -p 'lead qa' chat -Q",
    );
    expect(parseProcessNotice(text)?.dm?.to_profile).toBe("lead qa");
  });
});

describe("processNoticePreview", () => {
  /** Upstream's `preview`: first 60 characters, newlines flattened, `...` appended. */
  const upstreamPreview = (text: string) => {
    const flat = text.replace(/[\r\n]/g, " ").trim();
    return flat.length > 60 ? `${flat.slice(0, 60)}...` : flat;
  };

  test("a whole notice reads as its sentence", () => {
    expect(processNoticePreview(DM_NOTICE)).toStartWith("↩ lead-qa: Checked its");
    expect(processNoticePreview(completion("exited", "1"))).toBe("■ bun run build exited 1");
  });

  test("a notice cut off mid-status still reads as an event, never as the raw bracket", () => {
    expect(processNoticePreview(upstreamPreview(DM_NOTICE))).toBe("proc_f9a9a12fefed completed");
    // The exit code falls just past the 60th character, so it is not claimed.
    expect(processNoticePreview(upstreamPreview(completion("exited", "1")))).toBe(
      "■ proc_abc123 exited",
    );
  });

  test("a DM cut off in its output still names the recipient", () => {
    const cut = DM_NOTICE.replace(/\n/g, " ").slice(0, DM_NOTICE.indexOf("Output:") + 12);
    expect(processNoticePreview(`${cut}...`)).toBe("↩ lead-qa: …");
  });

  test("ambiguous and foreign previews", () => {
    expect(processNoticePreview("[IMPORTANT: Background process proc_x ma...")).toBe(
      "background process proc_x",
    );
    expect(processNoticePreview("[ASYNC DELEGATION BATCH COMPLETE — deleg_1] A back...")).toBe(
      "subagents finished",
    );
    expect(processNoticePreview("hello there")).toBeNull();
    expect(
      processNoticePreview('[IMPORTANT: The user has invoked the "review" skill, indic...'),
    ).toBeNull();
    expect(
      processNoticePreview("[IMPORTANT: You are running as a scheduled cron job. The..."),
    ).toBeNull();
    expect(processNoticePreview("")).toBeNull();
  });
});
