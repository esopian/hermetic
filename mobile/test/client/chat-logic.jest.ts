import { activeGroup, groupSummary, sectionKeys, sections } from "../../src/client/chat-activity.ts";
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
      status: "Worked",
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
      status: "Worked",
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

describe("narration folds into the run as notes", () => {
  const text = (markdown: string) => ({ kind: "text", markdown }) as const;
  const shape = (list: ReturnType<typeof sections>) =>
    list.map((s) => [s.activity, s.blocks.map((b) => (b.kind === "text" ? b.markdown : b.kind))]);
  const t1 = tool({ tool_id: "1", status: "ok" });
  const t2 = tool({ tool_id: "2", status: "ok" });

  test("interleaved text and tools: one group with the notes, the answer outside", () => {
    expect(shape(sections([text("T1"), t1, text("T2"), t2, text("T3")]))).toEqual([
      [true, ["T1", "tool", "T2", "tool"]],
      [false, ["T3"]],
    ]);
  });

  test("a share splits the fold in two", () => {
    const share = tool({ tool_id: "s", render: "file_share", status: "bad" });
    expect(shape(sections([text("T1"), t1, share, text("T2"), t2, text("T3")]))).toEqual([
      [true, ["T1", "tool"]],
      [false, ["tool"]],
      [true, ["T2", "tool"]],
      [false, ["T3"]],
    ]);
  });

  test("settled, the last text stays outside even with steps after it; streaming, it folds", () => {
    const blocks = [text("T1"), t1, text("T2"), t2];
    expect(shape(sections(blocks))).toEqual([
      [true, ["T1", "tool"]],
      [false, ["T2"]],
      [true, ["tool"]],
    ]);
    expect(shape(sections(blocks, true))).toEqual([[true, ["T1", "tool", "T2", "tool"]]]);
  });

  test("plain question and answer is unchanged", () => {
    expect(shape(sections([text("Hello")]))).toEqual([[false, ["Hello"]]]);
    expect(shape(sections([t1, text("Done.")]))).toEqual([
      [true, ["tool"]],
      [false, ["Done."]],
    ]);
  });

  test("live head: the newest note's last sentence, unless a later step still runs", () => {
    const note = text("Found it. Let me **check** `that`:");
    const later = (status: "ok" | "running") => tool({ tool_id: "3", status });
    expect(groupSummary([t1, note, later("ok")], true, "thinking", false).status).toBe(
      "Let me check that…",
    );
    expect(groupSummary([t1, note, later("running")], true, "thinking", false).status).toBe(
      "● terminal",
    );
  });

  test("the run stays live while the answer streams after it", () => {
    const list = sections([t1, text("Let me look."), t2, text("The answer")], true);
    expect(shape(list)).toEqual([
      [true, ["tool", "Let me look.", "tool"]],
      [false, ["The answer"]],
    ]);
    expect(activeGroup(list, true, "streaming", false)).toBe(0);
    expect(groupSummary(list[0]?.blocks ?? [], true, "streaming", false, true).status).toBe(
      "Let me look.",
    );
  });

  test("the look-ahead stops at a settled turn's closing prose", () => {
    expect(shape(sections([text("A."), text("B."), t1]))).toEqual([
      [false, ["A."]],
      [false, ["B."]],
      [true, ["tool"]],
    ]);
  });

  test("notices are looked past: an answer followed only by a notice stays outside", () => {
    const notice = {
      kind: "activity",
      category: "notice",
      key: "n",
      title: "n",
      state: "done",
      role: "work",
    } as const;
    expect(shape(sections([t1, text("The answer."), notice], true))).toEqual([
      [true, ["tool"]],
      [false, ["The answer."]],
      [true, ["activity"]],
    ]);
    expect(shape(sections([text("Checking."), notice, t2], true))).toEqual([
      [true, ["Checking.", "activity", "tool"]],
    ]);
  });

  test("a group keeps its key when its leading note leaves it at settle", () => {
    const blocks = [text("Checking."), t1];
    const live = sections(blocks, true);
    const settled = sections(blocks);
    expect(shape(live)).toEqual([[true, ["Checking.", "tool"]]]);
    expect(shape(settled)).toEqual([
      [false, ["Checking."]],
      [true, ["tool"]],
    ]);
    expect(sectionKeys(live)[0]).toBe("a:tool:1");
    expect(sectionKeys(settled)[1]).toBe("a:tool:1");
    // Two groups led by the same step identity fall back to their index.
    expect(sectionKeys(sections([t1, text("x"), t1]))).toEqual(["a:tool:1", "b1", "a2"]);
  });

  test("counts include notes; settled says Worked", () => {
    expect(groupSummary([text("a"), t1, text("b"), t2], false, "idle", false)).toMatchObject({
      status: "Worked",
      count: "2 tools · 2 notes",
    });
    expect(groupSummary([text("a"), t1], false, "idle", false).count).toBe("1 tool · 1 note");
  });
});

test("noVNC scaling script sets the resize mode", () => {
  expect(vncScaleScript("fit")).toContain("var m='scale';");
  expect(vncScaleScript("actual")).toContain("var m='off';");
});
