import { activeGroup, groupSummary, sections } from "../../src/client/chat-activity.ts";
import {
  blockKind,
  composerState,
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
  failedTurnPrompt,
  failureOf,
  isLatestFailure,
  recoveryPlan,
  turnErrorNeedsBand,
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

  test("the failed turn's prompt carries its files; a files-only prompt still has one", () => {
    const chip = {
      kind: "attachment" as const,
      name: "a.png",
      mime: "image/png",
      bytes: 3,
      href: "f_1",
      file_id: "f_1",
    };
    const echo = { ...msg({ id: "local:1", role: "user", text: "" }), blocks: [chip] };
    const failed = msg({ id: "f", error: "X" });
    expect(failedTurnPrompt([echo, failed], ["f"])).toEqual({
      text: "",
      files: [chip],
      recorded: false,
    });
    expect(failedPrompt([echo, failed], ["f"])).toBeNull();
    const recorded = {
      ...msg({ id: "u", role: "user", text: "look" }),
      blocks: [{ kind: "text" as const, markdown: "look" }, chip],
    };
    expect(failedTurnPrompt([recorded, failed], ["f"])).toEqual({
      text: "look",
      files: [chip],
      recorded: true,
    });
  });
});

describe("turn error band", () => {
  test("only when no message carries the failure, as on the desktop", () => {
    const asked = msg({ id: "u", role: "user", text: "hi" });
    const failed = msg({ id: "b", role: "bot", error: "CHAT_TURN_FAILED · rate limited" });
    expect(turnErrorNeedsBand([asked], null)).toBe(true);
    expect(turnErrorNeedsBand([asked, failed], null)).toBe(false);
    expect(turnErrorNeedsBand([asked], failed)).toBe(false);
    expect(turnErrorNeedsBand([], null)).toBe(true);
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

  test("a bot the bridge does not know is missing, with nothing to send to", () => {
    const base = { reachable: true, reconnecting: true, empty: false, missing: true };
    // A destroyed or stopped instance still says so first.
    expect(threadState({ ...base, status: "destroyed" })).toBe("destroyed");
    expect(threadState({ ...base, status: "ready" })).toBe("missing");
    expect(composerState("missing").enabled).toBe(false);
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

  test("a group in a turn still running is never called complete or stopped", () => {
    const step = (key: string) =>
      ({
        kind: "activity",
        category: "notice",
        key,
        title: key,
        state: "done",
        role: "work",
      }) as const;
    const steps = [step("read"), step("plan")];
    expect(groupSummary(steps, false, "streaming", false)).toMatchObject({
      status: "Activity complete",
      count: "2 steps",
    });
    expect(groupSummary(steps, false, "streaming", false, true)).toMatchObject({
      status: "Working…",
      count: "2 steps",
    });
    expect(groupSummary([tool({ status: "running" })], false, "streaming", false).status).toBe(
      "Activity stopped",
    );
    expect(groupSummary([tool({ status: "running" })], false, "streaming", false, true).status).toBe(
      "Working…",
    );
  });
});

test("noVNC scaling script sets the resize mode", () => {
  expect(vncScaleScript("fit")).toContain("var m='scale';");
  expect(vncScaleScript("actual")).toContain("var m='off';");
});
