/**
 * The one-line wording of a background-process event (`shared/process-event.ts`),
 * which the thread, the rail, the CLI and the inbox all print.
 */
import { describe, expect, test } from "bun:test";
import {
  PROCESS_COMMAND_MAX,
  isRoutineProcessEvent,
  processEventSentence,
  shortCommand,
} from "../src/shared/process-event.ts";

const DM_COMMAND =
  "/usr/local/lib/hermes-agent/venv/bin/python /usr/local/lib/hermes-agent/tools/bot_mode_dm.py " +
  '--run-delivery --author \'{"id":"bot:default","name":"hermes","is_bot":true}\' query-file ' +
  "/tmp/hermes-dm-999/dm-dw5rf82j.txt hermes -p lead-qa chat -Q";

describe("shortCommand", () => {
  test("drops an interpreter given by path and keeps the script's file name", () => {
    const short = shortCommand(DM_COMMAND);
    expect(short.startsWith("…/bot_mode_dm.py --run-delivery")).toBe(true);
    expect(short.length).toBeLessThanOrEqual(PROCESS_COMMAND_MAX);
    expect(short.endsWith("…")).toBe(true);
  });

  test("leaves a short command, and a bare interpreter name, alone", () => {
    expect(shortCommand("bun run build")).toBe("bun run build");
    expect(shortCommand("python -m http.server 8080")).toBe("python -m http.server 8080");
  });
});

describe("processEventSentence", () => {
  test("a DM reply reads as the replying bot, never the operator", () => {
    const sentence = processEventSentence({
      event: "completion",
      outcome: "ok",
      command: DM_COMMAND,
      dm: { to_profile: "lead-qa", reply: "\nChecked its claim.\nMore." },
    });
    expect(sentence).toBe("↩ lead-qa: Checked its claim.");
  });

  test("a failure is marked and carries its exit code; a clean exit just completed", () => {
    const base = { event: "completion", command: "bun test packages/ui" };
    expect(processEventSentence({ ...base, outcome: "failed", status: "exited", exit_code: 1 })).toBe(
      "■ bun test packages/ui exited 1",
    );
    expect(
      processEventSentence({ ...base, outcome: "failed", status: "failed to start", exit_code: -1 }),
    ).toBe("■ bun test packages/ui failed to start");
    expect(
      processEventSentence({ ...base, outcome: "ok", status: "completed normally", exit_code: 0 }),
    ).toBe("bun test packages/ui completed");
  });

  test("watch matches, subagents and one-line notices", () => {
    expect(
      processEventSentence({
        event: "watch_match",
        outcome: "info",
        command: "tail -F x.log",
        watch: { pattern: "ERROR" },
      }),
    ).toBe('tail -F x.log matched "ERROR"');
    expect(
      processEventSentence({
        event: "delegation",
        outcome: "ok",
        delegation: { total: 3, succeeded: 3 },
      }),
    ).toBe("subagents 3 of 3 finished");
    expect(
      processEventSentence({
        event: "mcp_reload",
        outcome: "info",
        message: "MCP servers have been reloaded.",
      }),
    ).toBe("MCP servers have been reloaded.");
  });
});

describe("isRoutineProcessEvent", () => {
  test("failures, DM replies and subagent results are never routine", () => {
    expect(isRoutineProcessEvent({ event: "completion", outcome: "ok" })).toBe(true);
    expect(isRoutineProcessEvent({ event: "completion", outcome: "terminated" })).toBe(true);
    expect(isRoutineProcessEvent({ event: "watch_match", outcome: "info" })).toBe(true);
    expect(isRoutineProcessEvent({ event: "completion", outcome: "failed" })).toBe(false);
    expect(isRoutineProcessEvent({ event: "delegation", outcome: "ok" })).toBe(false);
    expect(
      isRoutineProcessEvent({
        event: "completion",
        outcome: "ok",
        dm: { to_profile: "lead-qa", reply: "hi" },
      }),
    ).toBe(false);
  });
});
