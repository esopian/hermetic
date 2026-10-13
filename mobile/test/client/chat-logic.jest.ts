import { activeGroup, groupSummary, sections } from "../../src/client/chat-activity.ts";
import {
  blockKind,
  failureCopy,
  messageRows,
  openableHref,
  railTime,
  safeHref,
  threadState,
  toolVerdict,
} from "../../src/client/chat-logic.ts";
import {
  failedPrompt,
  failureOf,
  isLatestFailure,
  recoveryPlan,
} from "../../src/client/chat-recovery.ts";
import { toolSummary, turnRows } from "../../src/client/chat-turns.ts";
import { vncScaleScript } from "../../src/client/vnc.ts";
import { approval, msg, tool } from "../helpers/fixtures.ts";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");

describe("time", () => {
  test("rail ladder: now · minutes · weekday · month day", () => {
    expect(railTime(new Date(NOW - 10_000).toISOString(), NOW)).toBe("now");
    expect(railTime(new Date(NOW - 9 * 60_000).toISOString(), NOW)).toBe("9m");
    expect(railTime(new Date(NOW + 60_000).toISOString(), NOW)).toBe("now");
    expect(railTime("2026-09-02T12:00:00.000Z", NOW)).toMatch(/^Sep [23]$/);
    expect(railTime(null, NOW)).toBe("—");
  });
});

describe("links", () => {
  test("allow-list, and the phone opens only absolute schemes", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("/api/x")).toBe("/api/x");
    expect(openableHref("/api/x")).toBeNull();
    expect(openableHref("#source-1")).toBeNull();
    expect(openableHref("https://e.com")).toBe("https://e.com");
    expect(openableHref("mailto:a@b.c")).toBe("mailto:a@b.c");
  });
});

describe("blocks and verdicts", () => {
  test("an unknown kind is unknown; running is accent", () => {
    expect(blockKind({ kind: "hologram" })).toBe("unknown");
    expect(blockKind({ kind: "tool" })).toBe("tool");
    expect(toolVerdict("running")).toBe("acc");
    expect(toolVerdict("weird")).toBe("unknown");
  });

  test("tool summary names the target for known families only", () => {
    expect(toolSummary(tool({ name: "terminal", args: { command: "ls -la" } }))).toBe("ls -la");
    expect(toolSummary(tool({ name: "mystery", args: { secret: "x" } }))).toBe("");
  });
});

describe("rows", () => {
  test("one author's consecutive messages continue; a failed one never does", () => {
    const rows = messageRows(
      [
        msg({ id: "a", at: "2026-10-13T11:00:00.000Z" }),
        msg({ id: "b", at: "2026-10-13T11:01:00.000Z" }),
        msg({ id: "c", at: "2026-10-13T11:02:00.000Z", error: "CHAT_UNREACHABLE" }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.continuation)).toEqual([false, true, false]);
    expect(rows[0]?.divider).not.toBeNull();
    expect(rows[1]?.divider).toBeNull();
  });

  test("a turn split across tool rows draws as one row named by its last id", () => {
    const rows = turnRows(
      [
        msg({ id: "u", role: "user", text: "go" }),
        msg({ id: "t1", blocks: [tool({ tool_id: "1", status: "ok" })] }),
        msg({ id: "t2", role: "system", blocks: [tool({ tool_id: "2", status: "ok" })] }),
        msg({ id: "p", text: "done" }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.ids)).toEqual([["u"], ["t1", "t2", "p"]]);
    expect(rows[1]?.message.id).toBe("p");
    expect(rows[1]?.message.blocks).toHaveLength(3);
  });

  test("the live reply never folds into the turn above it", () => {
    const rows = turnRows(
      [
        msg({ id: "t1", blocks: [tool({ status: "ok" })] }),
        msg({ id: "live", blocks: [tool({ tool_id: "x" })] }),
      ],
      NOW,
      { breakBefore: "live" },
    );
    expect(rows.map((r) => r.ids)).toEqual([["t1"], ["live"]]);
  });
});

describe("failures", () => {
  test("copy per code, with the code verbatim for an unknown one", () => {
    expect(failureCopy("RATE_LIMITED").tone).toBe("warn");
    expect(failureCopy("CHAT_UNREACHABLE").head).toBe("disconnected");
    expect(failureCopy("ZZZ", "the box said so")).toMatchObject({
      right: "ZZZ",
      detail: "the box said so",
    });
  });

  test("an old error string is read apart", () => {
    expect(failureOf(msg({ error: "CHAT_NO_SLOT · busy" }))).toEqual({
      code: "CHAT_NO_SLOT",
      message: "busy",
    });
  });

  test("recovery plans", () => {
    expect(recoveryPlan({ code: "RATE_LIMITED", message: "" }).retry).toBe(true);
    const overflow = recoveryPlan({
      code: "X",
      message: "",
      surface: { layer: "context", code: "context_overflow", retryable: false },
    });
    expect(overflow).toMatchObject({ retry: false, compact: true, newSession: true });
  });

  test("the failed prompt and whether this is the latest failure", () => {
    const list = [msg({ id: "u", role: "user", text: "do it" }), msg({ id: "f", error: "X" })];
    expect(failedPrompt(list, ["f"])).toBe("do it");
    expect(isLatestFailure(list, ["f"])).toBe(true);
    expect(isLatestFailure([...list, msg({ id: "later" })], ["f"])).toBe(false);
  });
});

describe("thread state", () => {
  test("the fleet row wins over what chat learned", () => {
    const base = { reachable: true, reconnecting: false, empty: false };
    expect(threadState({ ...base, status: "stopped", reconnecting: true })).toBe("stopped");
    expect(threadState({ ...base, status: "ready", reconnecting: true })).toBe("dropped");
    expect(threadState({ ...base, status: null, reachable: false })).toBe("unreachable");
    expect(threadState({ ...base, status: "ready", empty: true })).toBe("empty");
  });
});

describe("activity", () => {
  test("steps group; a request is its own section; the live group is the last run", () => {
    const list = sections([
      tool({ tool_id: "1" }),
      tool({ tool_id: "2" }),
      approval(),
      tool({ tool_id: "3" }),
    ]);
    expect(list.map((s) => [s.activity, s.blocks.length])).toEqual([
      [true, 2],
      [false, 1],
      [true, 1],
    ]);
    expect(activeGroup(list, true, "thinking", false)).toBe(2);
  });

  test("group words", () => {
    expect(groupSummary([tool({ status: "running" })], true, "thinking", false).status).toBe(
      "● terminal",
    );
    expect(groupSummary([tool({ status: "ok" })], false, "idle", false)).toMatchObject({
      status: "Tools complete",
      count: "1 tool",
    });
  });
});

test("noVNC scaling script sets the resize mode", () => {
  expect(vncScaleScript("fit")).toContain('"scale"');
  expect(vncScaleScript("actual")).toContain('"off"');
});
