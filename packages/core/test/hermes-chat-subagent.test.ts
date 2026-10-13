/**
 * The subagent ledger: upstream's `subagent.*` events on the parent session,
 * accumulated per child and handed back as whole blocks.
 */
import { describe, expect, test } from "bun:test";
import {
  createSubagentLedger,
  isSubagentEvent,
  steerMissed,
  subagentVerdict,
} from "../src/chat/hermes/hermes-chat-subagent.ts";
import { ChatBlock, SUBAGENT_TOOLS_MAX } from "../src/schema/index.ts";

/** Upstream always sends goal, task_count and task_index (`_progress_subagent`). */
const base = (extra: Record<string, unknown> = {}) => ({
  goal: "Audit volumes",
  task_count: 2,
  task_index: 0,
  subagent_id: "sa-1",
  delegation_id: "deleg-1",
  depth: 0,
  ...extra,
});

const clock = () => "2026-10-12T10:00:00.000Z";

describe("the subagent ledger", () => {
  test("only spawn_requested and start create a row", () => {
    const ledger = createSubagentLedger();
    expect(ledger.apply("subagent.tool", base({ tool_name: "terminal" }))).toBeNull();
    expect(ledger.apply("subagent.progress", base({ text: "x" }))).toBeNull();
    expect(ledger.apply("subagent.complete", base({ status: "completed" }))).toBeNull();
    expect(ledger.all()).toEqual([]);
    expect(ledger.apply("message.delta", base())).toBeNull();

    const queued = ledger.apply("subagent.spawn_requested", base());
    expect(queued).toMatchObject({ status: "queued", verdict: "running", origin: "live" });
    const started = createSubagentLedger({ now: clock }).apply("subagent.start", base());
    expect(started).toMatchObject({ status: "running", started_at: "2026-10-12T10:00:00.000Z" });
    expect(ChatBlock.parse(started)).toBeTruthy();
  });

  test("events accumulate, and every change hands back the whole block", () => {
    const ledger = createSubagentLedger({ now: clock });
    ledger.apply("subagent.start", base({ model: "claude-sonnet-5", child_session_id: "child-1" }));
    const first = ledger.apply(
      "subagent.tool",
      base({ tool_name: "terminal", tool_preview: "ls /srv", text: "ls /srv", tool_count: 1 }),
    );
    const second = ledger.apply(
      "subagent.tool",
      base({ tool_name: "read_file", tool_preview: "/srv/a", tool_count: 2, files_read: ["/srv/a"] }),
    );
    // One row per child: the second tool event replaces the block, it does not
    // add a row, and it carries the first tool too.
    expect(ledger.all()).toHaveLength(1);
    expect(first?.tools).toEqual([{ name: "terminal", preview: "ls /srv" }]);
    expect(second?.tools).toEqual([
      { name: "terminal", preview: "ls /srv" },
      { name: "read_file", preview: "/srv/a" },
    ]);
    expect(second).toMatchObject({
      subagent_id: "sa-1",
      model: "claude-sonnet-5",
      child_session_id: "child-1",
      delegation_id: "deleg-1",
      tool_count: 2,
      files_read: ["/srv/a"],
      started_at: "2026-10-12T10:00:00.000Z",
    });
    // An emitted block is a snapshot: later events do not change it underneath its holder.
    expect(first?.tools).toHaveLength(1);

    const progress = ledger.apply("subagent.progress", base({ text: "half way", api_calls: 3 }));
    const thinking = ledger.apply(
      "subagent.thinking",
      base({ text: "considering gp3", input_tokens: 900 }),
    );
    expect(progress).toMatchObject({ progress: "half way", usage: { api_calls: 3 } });
    expect(thinking).toMatchObject({
      progress: "half way",
      thinking: "considering gp3",
      usage: { api_calls: 3, input_tokens: 900 },
      tools: second?.tools,
    });
  });

  test("tools are capped, while tool_count is the wire's own count", () => {
    const ledger = createSubagentLedger();
    ledger.apply("subagent.start", base());
    let last = null;
    for (let i = 1; i <= SUBAGENT_TOOLS_MAX + 6; i++)
      last = ledger.apply("subagent.tool", base({ tool_name: `t${i}`, tool_count: i + 100 }));
    expect(last?.tools).toHaveLength(SUBAGENT_TOOLS_MAX);
    expect(last?.tools[0]?.name).toBe("t7");
    expect(last?.tools.at(-1)?.name).toBe(`t${SUBAGENT_TOOLS_MAX + 6}`);
    expect(last?.tool_count).toBe(SUBAGENT_TOOLS_MAX + 106);
    // Without a wire count, the observed (uncapped) count stands in.
    const other = createSubagentLedger();
    other.apply("subagent.start", base({ subagent_id: "sa-2" }));
    for (let i = 0; i < SUBAGENT_TOOLS_MAX + 2; i++)
      last = other.apply("subagent.tool", base({ subagent_id: "sa-2", tool_name: "x" }));
    expect(last?.tool_count).toBe(SUBAGENT_TOOLS_MAX + 2);
  });

  test("complete is terminal: later events for the child are ignored", () => {
    const ledger = createSubagentLedger();
    ledger.apply("subagent.start", base());
    const done = ledger.apply(
      "subagent.complete",
      base({
        status: "completed",
        summary: "Found three",
        duration_seconds: 4.25,
        output_tail: [{ tool: "terminal", preview: "exit 1", is_error: true }, { preview: "no tool" }],
      }),
    );
    expect(done).toMatchObject({
      status: "completed",
      verdict: "done",
      summary: "Found three",
      duration_ms: 4250,
      output_tail: [{ name: "terminal", preview: "exit 1", is_error: true }],
    });
    expect(ledger.apply("subagent.tool", base({ tool_name: "late" }))).toBeNull();
    expect(ledger.apply("subagent.complete", base({ status: "failed" }))).toBeNull();
    expect(ledger.get("sa-1")).toMatchObject({ status: "completed", tools: [] });
  });

  test.each([
    ["completed", "completed", "done"],
    ["failed", "failed", "failed"],
    ["error", "error", "failed"],
    ["timeout", "timeout", "failed"],
    ["interrupted", "interrupted", "stopped"],
    ["cancelled", "interrupted", "stopped"],
    ["running", "unobserved", "unknown"],
    ["exploded", "unobserved", "unknown"],
    [undefined, "unobserved", "unknown"],
  ])("a completion with status %s folds to %s / %s", (wire, status, verdict) => {
    const ledger = createSubagentLedger();
    ledger.apply("subagent.start", base());
    expect(ledger.apply("subagent.complete", base({ status: wire }))).toMatchObject({
      status,
      verdict,
    });
  });

  test("a child with no id is held by delegation, depth and index", () => {
    const ledger = createSubagentLedger();
    const row = ledger.apply("subagent.start", { goal: "g", task_count: 1, task_index: 0 });
    expect(row?.subagent_id).toBe("anon:-:0:0");
    expect(
      ledger.apply("subagent.tool", { goal: "g", task_count: 1, task_index: 0, tool_name: "x" })?.tools,
    ).toHaveLength(1);
  });

  test("markUnobserved turns live rows missing from the roster into unknowns, and nothing else", () => {
    const ledger = createSubagentLedger();
    ledger.apply("subagent.start", base({ subagent_id: "gone" }));
    ledger.apply("subagent.start", base({ subagent_id: "alive" }));
    ledger.apply("subagent.start", base({ subagent_id: "finished" }));
    ledger.apply("subagent.complete", base({ subagent_id: "finished", status: "completed" }));
    const changed = ledger.markUnobserved(["alive"]);
    expect(changed.map((b) => [b.subagent_id, b.status, b.verdict])).toEqual([
      ["gone", "unobserved", "unknown"],
    ]);
    expect(ledger.markUnobserved(["alive"])).toEqual([]);
    // Not terminal: a replayed completion still lands.
    expect(
      ledger.apply("subagent.complete", base({ subagent_id: "gone", status: "failed" })),
    ).toMatchObject({ status: "failed", verdict: "failed" });
  });
});

describe("subagent helpers", () => {
  test("the verdict fold never reads an unknown status as success", () => {
    expect(subagentVerdict("dispatched")).toBe("running");
    expect(subagentVerdict("unobserved")).toBe("unknown");
    expect(subagentVerdict("something")).toBe("unknown");
  });

  test("upstream's missed-steer note is recognised in a summary", () => {
    expect(
      steerMissed(
        "Done.\n\n[steer did not land — the subagent finished before it could be delivered: x]",
      ),
    ).toBe(true);
    expect(steerMissed("Done.")).toBe(false);
    expect(steerMissed(undefined)).toBe(false);
  });

  test("the event vocabulary", () => {
    expect(isSubagentEvent("subagent.tool")).toBe(true);
    expect(isSubagentEvent("subagent.text")).toBe(false);
  });
});
