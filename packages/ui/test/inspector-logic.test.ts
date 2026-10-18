/**
 * The stream inspector's pure rules (`chat/inspector-logic.ts`) and the page's
 * reducer notes (`chat/devtap.ts`): naming, the filter grammar, delta folding,
 * turn grouping, the field diff, lineage, block versions, and the bound on
 * every ring.
 */
import { describe, expect, test } from "bun:test";
import type { ChatBlockView, ChatFrameView } from "../src/api/types.ts";
import type { Conversation } from "../src/chat/chat-conversation-record.ts";
import { landOnSegment } from "../src/chat/chat-requests.ts";
import { applyFrame } from "../src/chat/chat-state.tsx";
import { PageCapture, devtap } from "../src/chat/devtap.ts";
import {
  CATEGORIES,
  buildRows,
  categoryOf,
  collapseDeltas,
  diffRowKey,
  fateLabel,
  fieldDiff,
  fmtClockMs,
  groupByTurn,
  lineage,
  matchesFilter,
  messageStates,
  outcomeLabel,
  parseFilter,
  pushBounded,
  summarize,
  upsertBounded,
  wireEvent,
  type PageNote,
  type Row,
  type TapRecord,
} from "../src/chat/inspector-logic.ts";

const CONV = { instance: "veronica", bot: "default", session: null };

let n = 0;
function rec(partial: Partial<TapRecord> & Pick<TapRecord, "type">): TapRecord {
  n += 1;
  return {
    id: `t${n}`,
    at: 1_760_000_000_000 + n * 10,
    mono: n * 10,
    conversation: CONV,
    socket: "held#3",
    layer: "wire",
    dir: "in",
    seq: null,
    parent: null,
    fate: null,
    bytes: 100,
    payload: null,
    ...partial,
  };
}

/** A JSON-RPC event document, the way core captures one off the socket. */
function event(type: string, seq: number, payload: unknown, extra: Partial<TapRecord> = {}): TapRecord {
  return rec({
    type,
    seq,
    payload: { jsonrpc: "2.0", method: "event", params: { type, seq, payload } },
    ...extra,
  });
}

const rows = (records: TapRecord[]): Row[] =>
  records.map((r) => ({ kind: "record" as const, rec: r, depth: 0 as const, note: null }));

describe("naming a record", () => {
  test("a wire event's text is read from its payload, not the envelope", () => {
    const r = event("message.delta", 3, { text: "User wants disk usage" });
    expect(wireEvent(r)).toEqual({ text: "User wants disk usage" });
    expect(summarize(r)).toBe('"User wants disk usage"');
  });

  test("categories follow the type, and an internal drop is internal whatever it is", () => {
    expect(categoryOf(event("thinking.delta", 1, {}))).toBe("reasoning");
    expect(categoryOf(event("tool.start", 1, {}))).toBe("tool");
    expect(categoryOf(event("approval.request", 1, {}))).toBe("approval");
    expect(categoryOf(event("message.delta", 1, {}))).toBe("text");
    expect(categoryOf(event("message.complete", 1, {}))).toBe("usage");
    expect(categoryOf(rec({ type: "prompt.submit", dir: "out" }))).toBe("rpc");
    expect(
      categoryOf(event("tool.output_risk", 8, {}, { fate: { kind: "drop", reason: "internal" } })),
    ).toBe("internal");
    // A frame is named by the block it carries.
    expect(
      categoryOf(
        rec({
          type: "block.tool",
          layer: "frame",
          payload: { type: "block", block: { kind: "tool" } },
        }),
      ),
    ).toBe("tool");
  });

  test("fates read as the badge says them", () => {
    expect(fateLabel({ kind: "frames", count: 1 })).toBe("→ 1 frame");
    expect(fateLabel({ kind: "frames", count: 0 })).toBe("no frame");
    expect(fateLabel({ kind: "drop", reason: "child_session" })).toBe("dropped · child session");
    expect(fateLabel({ kind: "buffer", into: "reasoning" })).toBe("buffered → reasoning");
    expect(outcomeLabel({ kind: "replaced", version: 2 })).toBe("replaced v2");
    expect(outcomeLabel({ kind: "dropped", reason: "seq_lt_last" })).toBe("dropped · seq<last");
    expect(outcomeLabel({ kind: "history" })).toBe("replaced by history");
  });

  test("clock times always carry an explicit locale and milliseconds", () => {
    expect(fmtClockMs(Date.UTC(2026, 9, 16, 10, 42, 3, 512))).toMatch(/^\d\d:\d\d:\d\d\.512$/);
  });
});

describe("the filter", () => {
  test("parses seq, fate, type, message and free text in any order", () => {
    expect(parseFilter("tool seq:5-9 fate:drop type:Delta message:m1")).toEqual({
      seq: { from: 5, to: 9 },
      fate: "drop",
      type: "delta",
      message: "m1",
      text: "tool",
    });
    expect(parseFilter("seq:9").seq).toEqual({ from: 9, to: 9 });
    // A malformed seq is free text, not a silently dropped term.
    expect(parseFilter("seq:abc").text).toBe("seq:abc");
  });

  test("matches each term", () => {
    const delta = event(
      "message.delta",
      9,
      { text: "hello there" },
      { fate: { kind: "frames", count: 1 } },
    );
    const dropped = event("session.info", 1, {}, { fate: { kind: "drop", reason: "internal" } });
    expect(matchesFilter(delta, parseFilter("seq:9"))).toBe(true);
    expect(matchesFilter(delta, parseFilter("seq:10"))).toBe(false);
    expect(matchesFilter(dropped, parseFilter("fate:drop"))).toBe(true);
    expect(matchesFilter(dropped, parseFilter("fate:internal"))).toBe(true);
    expect(matchesFilter(delta, parseFilter("fate:drop"))).toBe(false);
    expect(matchesFilter(delta, parseFilter("type:delta"))).toBe(true);
    expect(matchesFilter(delta, parseFilter("HELLO"))).toBe(true);
    expect(matchesFilter(delta, parseFilter("goodbye"))).toBe(false);
  });

  test("a message filter keeps the frames that name it and the wire messages they came from", () => {
    const wire = event("message.delta", 4, { text: "x" });
    const frame = rec({
      type: "delta",
      layer: "frame",
      dir: "out",
      seq: 4,
      parent: wire.id,
      payload: { type: "delta", seq: 4, message: "veronica:2026-10-16T10:42:01Z", text: "x" },
    });
    const other = event("message.delta", 5, { text: "y" });
    const all = [wire, frame, other];
    const kept = buildRows(all, [], "wire", {
      filter: parseFilter("message:veronica:2026-10-16T10:42:01Z"),
      categories: new Set(CATEGORIES),
      collapse: false,
      showDropped: true,
      framesUnderEvents: false,
      byTurn: false,
    });
    expect(kept.map((r) => (r.kind === "record" ? r.rec.id : null))).toEqual([wire.id]);
  });
});

describe("the list", () => {
  test("a run of deltas folds into one row with its count, text and span", () => {
    const a = event("message.delta", 1, { text: "Hel" });
    const b = event("message.delta", 2, { text: "lo" });
    const c = event("message.complete", 3, {});
    const folded = collapseDeltas(rows([a, b, c]));
    expect(folded.length).toBe(2);
    const head = folded[0]!;
    expect(head.kind).toBe("deltas");
    if (head.kind !== "deltas") throw new Error("unreachable");
    expect(head.recs.length).toBe(2);
    expect(head.text).toBe("Hello");
    expect(head.spanMs).toBe(b.mono - a.mono);
    // A lone delta stays a record.
    expect(collapseDeltas(rows([a, c]))[0]?.kind).toBe("record");
    // Different delta types do not fold together.
    const t = event("thinking.delta", 4, { text: "hm" });
    expect(collapseDeltas(rows([a, t])).every((r) => r.kind === "record")).toBe(true);
  });

  test("turns open on a prompt going out, with the full usage behind the header", () => {
    const before = rec({ type: "conn.dial", layer: "wire" });
    const prompt = rec({
      type: "prompt.submit",
      dir: "out",
      payload: { method: "prompt.submit", params: { text: "How full is the data disk?" } },
    });
    const reply = event("message.delta", 1, { text: "61%" });
    const done = event("message.complete", 2, {
      usage: { model: "deepseek", input: 13300, output: 4, avg_tps: 2.2, calls: 1 },
    });
    const grouped = groupByTurn(rows([before, prompt, reply, done]));
    expect(grouped.map((r) => r.kind)).toEqual(["record", "turn", "record", "record", "record"]);
    const header = grouped[1]!;
    if (header.kind !== "turn") throw new Error("unreachable");
    expect(header.turn.title).toBe("How full is the data disk?");
    expect(header.turn.model).toBe("deepseek");
    expect(header.turn.inputTokens).toBe(13300);
    expect(header.turn.outputTokens).toBe(4);
    expect(header.turn.tps).toBe(2.2);
    expect(header.turn.durationMs).toBe(done.mono - prompt.mono);
    expect(header.turn.latencyMs).toBe(reply.mono - prompt.mono);
    expect(header.turn.usage).toMatchObject({ calls: 1 });
  });

  test("frames are drawn under the wire message that made them, and dropped ones hide on request", () => {
    const wire = event("message.delta", 1, { text: "a" }, { fate: { kind: "frames", count: 1 } });
    const frame = rec({
      type: "delta",
      layer: "frame",
      dir: "out",
      seq: 1,
      parent: wire.id,
      payload: { type: "delta", seq: 1 },
    });
    const drop = event("session.info", 2, {}, { fate: { kind: "drop", reason: "internal" } });
    const options = {
      filter: parseFilter(""),
      categories: new Set(CATEGORIES),
      collapse: false,
      showDropped: true,
      framesUnderEvents: true,
      byTurn: false,
    };
    const shown = buildRows([wire, frame, drop], [], "wire", options);
    expect(shown.map((r) => (r.kind === "record" ? `${r.rec.id}@${r.depth}` : r.kind))).toEqual([
      `${wire.id}@0`,
      `${frame.id}@1`,
      `${drop.id}@0`,
    ]);
    expect(buildRows([wire, frame, drop], [], "wire", { ...options, showDropped: false }).length).toBe(
      2,
    );
    // A category chip switched off hides its records.
    expect(
      buildRows([wire, frame, drop], [], "wire", { ...options, categories: new Set(["text" as const]) })
        .length,
    ).toBe(2);
  });

  test("a frame carries the page's reducer outcome as its badge", () => {
    const frame = rec({
      type: "block.tool",
      layer: "frame",
      dir: "out",
      seq: 9,
      payload: { type: "block", seq: 9, block: { kind: "tool" } },
    });
    const note: PageNote = {
      id: "p1",
      at: 0,
      mono: 0,
      type: "block",
      seq: 9,
      outcome: { kind: "replaced", version: 2 },
      message: "m",
      key: "tool:tc_01",
    };
    const [row] = buildRows([frame], [note], "frames", {
      filter: parseFilter(""),
      categories: new Set(CATEGORIES),
      collapse: false,
      showDropped: true,
      framesUnderEvents: false,
      byTurn: false,
    });
    expect(row?.kind === "record" ? row.note?.outcome : null).toEqual({ kind: "replaced", version: 2 });
  });

  test("a record delivered again with its settled fate replaces itself, in place", () => {
    const a = event("message.delta", 1, {});
    const b = event("tool.start", 2, {});
    const c = event("message.delta", 3, {});
    const settled = { ...b, fate: { kind: "frames" as const, count: 1 } };
    const d = event("message.complete", 4, {});
    const { ring } = upsertBounded([a, b, c], [settled, d], 10);
    expect(ring.map((r) => r.id)).toEqual([a.id, b.id, c.id, d.id]);
    expect(ring[1]?.fate).toEqual({ kind: "frames", count: 1 });
    // Within one batch, too.
    const again = upsertBounded([], [a, b, { ...b, fate: settled.fate }], 10).ring;
    expect(again.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(again[1]?.fate).toEqual(settled.fate);
    // An id that has already fallen off the ring is not resurrected.
    expect(upsertBounded([c], [{ ...a }], 10).ring.map((r) => r.id)).toEqual([c.id]);
  });

  test("under a folded run of deltas, the run's frames fold into one child row", () => {
    const a = event("message.delta", 1, { text: "Hel" });
    const b = event("message.delta", 2, { text: "lo" });
    const fa = rec({
      type: "delta",
      layer: "frame",
      dir: "out",
      seq: 1,
      parent: a.id,
      payload: { type: "delta", text: "Hel" },
    });
    const fb = rec({
      type: "delta",
      layer: "frame",
      dir: "out",
      seq: 2,
      parent: b.id,
      payload: { type: "delta", text: "lo" },
    });
    const built = buildRows([a, fa, b, fb], [], "wire", {
      filter: parseFilter(""),
      categories: new Set(CATEGORIES),
      collapse: true,
      showDropped: true,
      framesUnderEvents: true,
      byTurn: false,
    });
    expect(built.map((r) => `${r.kind}@${r.kind === "turn" ? "" : r.depth}`)).toEqual([
      "deltas@0",
      "deltas@1",
    ]);
    const child = built[1]!;
    expect(child.kind === "deltas" ? child.text : null).toBe("Hello");
  });

  test("a ring keeps the newest and counts what fell off", () => {
    expect(pushBounded([1, 2, 3], [4, 5], 4)).toEqual({ ring: [2, 3, 4, 5], evicted: 1 });
    expect(pushBounded([1], [2], 4)).toEqual({ ring: [1, 2], evicted: 0 });
  });
});

describe("detail", () => {
  test("the diff reads core's field map: renamed, dropped and unmapped fields", () => {
    const rows = fieldDiff("message.complete", {
      text: "done",
      usage: { model: "m", input: 10, output: 2, reasoning: 0 },
      surprise: true,
    });
    expect(rows).not.toBeNull();
    const byPath = new Map(rows!.filter((r) => r.wire !== null).map((r) => [r.wire, r]));
    expect(byPath.get("usage.input")).toMatchObject({
      op: "renamed",
      frame: "usage.input_tokens",
      value: 10,
    });
    expect(byPath.get("usage.model")).toMatchObject({ op: "kept", value: "m" });
    expect(byPath.get("surprise")).toMatchObject({ op: "unmapped", value: true });
    // A field the adapter makes up has no wire side, so it can never be
    // mistaken for (or keyed like) a wire field of the same frame name.
    const made = rows!.filter((r) => r.op === "synthesized");
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((r) => r.wire === null && r.frame !== null)).toBe(true);
    // Every row has its own key, even where a wire field and a made-up field
    // land on the same frame path (`usage.cost_usd`, `message`).
    const withMessage = fieldDiff("message.complete", { message: "m1", usage: { cost_usd: 1 } })!;
    const keys = withMessage.map(diffRowKey);
    expect(new Set(keys).size).toBe(keys.length);
    // A type core does not map has no diff at all.
    expect(fieldDiff("session.info", {})).toBeNull();
  });

  test("lineage follows a wire message to its frames and the page's outcome", () => {
    const wire = event("tool.complete", 9, {}, { fate: { kind: "frames", count: 1 } });
    const frame = rec({
      type: "block.tool",
      layer: "frame",
      dir: "out",
      seq: 9,
      parent: wire.id,
      payload: { type: "block", seq: 9 },
    });
    const note: PageNote = {
      id: "p1",
      at: 0,
      mono: 0,
      type: "block",
      seq: 9,
      outcome: { kind: "replaced", version: 2 },
      message: "m",
      key: "k",
    };
    const chains = lineage(wire, [wire, frame], [note]);
    expect(chains.length).toBe(1);
    expect(chains[0]!.map((s) => s.detail)).toEqual([
      "seq 9 · 100 B",
      "→ 1 frame",
      "seq 9",
      "replaced v2",
    ]);
    // Selecting the frame shows the same chain.
    expect(lineage(frame, [wire, frame], [note])[0]!.at(-1)?.detail).toBe("replaced v2");
    // A drop stops at the adapter.
    const dropped = event("tool.output_risk", 8, {}, { fate: { kind: "drop", reason: "internal" } });
    expect(lineage(dropped, [dropped], [])[0]!.map((s) => s.layer)).toEqual(["wire", "adapter"]);
  });
});

describe("state", () => {
  test("deltas fold into the text block they were appended to", () => {
    const note = (partial: Partial<PageNote> & Pick<PageNote, "type" | "outcome">): PageNote => ({
      id: "p",
      at: 0,
      mono: 0,
      seq: null,
      message: "m",
      key: null,
      ...partial,
    });
    const [state] = messageStates([
      note({ type: "block", outcome: { kind: "new_block" }, block: { kind: "text", markdown: "" } }),
      note({ type: "delta", outcome: { kind: "appended" }, text: "Hel" }),
      note({ type: "delta", outcome: { kind: "appended" }, text: "lo" }),
      note({
        type: "block",
        outcome: { kind: "new_block" },
        block: { kind: "tool", name: "bash" },
        key: "tool:a",
      }),
      // A delta after a tool call appends to the last text block, as `appendDelta` does.
      note({ type: "delta", outcome: { kind: "appended" }, text: "!" }),
    ]);
    const text = state!.blocks.find((b) => b.kind === "text");
    expect(text?.current).toEqual({ kind: "text", markdown: "Hello!" });
    expect(text?.deltas).toBe(3);
    // With no text block yet, a delta makes one.
    const [fresh] = messageStates([note({ type: "delta", outcome: { kind: "appended" }, text: "hi" })]);
    expect(fresh!.blocks[0]?.current).toEqual({ kind: "text", markdown: "hi" });
  });
});

describe("the page's reducer notes", () => {
  const keyOf = (block: { kind: string; id?: string }) =>
    block.kind === "tool" ? `tool:${block.id}` : null;

  test("cost nothing and keep nothing while the tools are off", () => {
    const cap = new PageCapture();
    expect(cap.on).toBe(false);
    cap.applied(CONV, { type: "delta", seq: 1 }, "m");
    expect(cap.notesFor(CONV)).toEqual([]);
  });

  test("count block versions the way the store merges them, and record drops and history", () => {
    const cap = new PageCapture();
    cap.setMergeKey(keyOf as (block: never) => string | null);
    cap.configure({ enabled: true, capture: "always", keep: 100 });
    expect(cap.on).toBe(true);
    cap.applied(CONV, { type: "block", seq: 1, block: { kind: "tool", id: "a" } }, "m");
    cap.applied(CONV, { type: "block", seq: 2, block: { kind: "tool", id: "a" } }, "m");
    cap.applied(CONV, { type: "block", seq: 3, block: { kind: "text" } }, "m");
    cap.applied(CONV, { type: "delta", seq: 4 }, "m");
    cap.dropped(CONV, { type: "delta", seq: 2 }, "seq_lt_last", "m");
    cap.history(CONV, "m");
    const outcomes = cap.notesFor(CONV).map((note) => outcomeLabel(note.outcome));
    expect(outcomes).toEqual([
      "new block",
      "replaced v2",
      "new block",
      "appended",
      "dropped · seq<last",
      "replaced by history",
    ]);
    const [state] = messageStates(cap.notesFor(CONV));
    expect(state?.replacedByHistory).toBe(true);
    expect(state?.deltas).toBe(1);
    expect(state?.blocks.find((b) => b.key === "tool:a")?.versions.length).toBe(2);
  });

  test("are bounded to keep, and only for watched conversations under while_open", () => {
    const cap = new PageCapture();
    cap.configure({ enabled: true, capture: "always", keep: 3 });
    for (let i = 0; i < 5; i++) cap.applied(CONV, { type: "delta", seq: i }, "m");
    expect(cap.notesFor(CONV).map((note) => note.seq)).toEqual([2, 3, 4]);

    const quiet = new PageCapture();
    quiet.configure({ enabled: true, capture: "while_open", keep: 10 });
    expect(quiet.on).toBe(false);
    quiet.applied(CONV, { type: "delta", seq: 1 }, "m");
    expect(quiet.notesFor(CONV)).toEqual([]);
    const release = quiet.watch(CONV);
    expect(quiet.on).toBe(true);
    quiet.applied(CONV, { type: "delta", seq: 2 }, "m");
    expect(quiet.notesFor(CONV).length).toBe(1);
    release();
    expect(quiet.on).toBe(false);
  });
});

describe("the page's notes across a steer and a wrapped ring", () => {
  test("a block that lands on a part a steer closed off is filed there, as the replacement it is", () => {
    const tool = (status: string) =>
      ({ kind: "tool", tool_id: "tc_1", name: "terminal", status }) as unknown as ChatBlockView;
    // The store's own merge key comes in with the store (`chat-state.tsx`).
    devtap.configure({ enabled: true, capture: "always", keep: 100 });
    try {
      devtap.clear();
      devtap.applied(CONV, { type: "block", seq: 1, block: tool("running") }, "m");
      // The operator steers: the live message is closed off as `m~1`.
      devtap.segment(CONV, "m", "m~1");
      const record = {
        segments: ["m~1"],
        messages: [{ id: "m~1", role: "bot", blocks: [tool("running")] }],
      } as unknown as Conversation;
      const frame = { type: "block", seq: 2, message: "m", block: tool("ok") } as ChatFrameView;
      const landed = landOnSegment(record, frame, { session: "", at: "" }, applyFrame);
      expect(landed).toBe("m~1");
      devtap.applied(CONV, frame, landed);
      const last = devtap.notesFor(CONV).at(-1);
      expect(last?.message).toBe("m~1");
      expect(last?.outcome).toEqual({ kind: "replaced", version: 2 });
      // State shows one message, the closed-off part, holding both versions.
      const states = messageStates(devtap.notesFor(CONV));
      expect(states.map((s) => s.message)).toEqual(["m~1"]);
      expect(states[0]?.blocks[0]?.versions.length).toBe(2);
      // A block that is new work lands nowhere and belongs to the live message.
      const fresh = { ...frame, block: { kind: "tool", tool_id: "tc_2", name: "x" } } as ChatFrameView;
      expect(landOnSegment(record, fresh, { session: "", at: "" }, applyFrame)).toBeNull();
    } finally {
      devtap.configure({ enabled: false });
    }
  });

  test("a message whose oldest notes fell off the ring is marked partial", () => {
    const cap = new PageCapture();
    cap.configure({ enabled: true, capture: "always", keep: 1000 });
    cap.applied(CONV, { type: "block", seq: 0, block: { kind: "text", markdown: "" } }, "m");
    for (let i = 1; i <= 1500; i++) cap.applied(CONV, { type: "delta", seq: i, text: "x" }, "m");
    cap.applied(CONV, { type: "block", seq: 1501, block: { kind: "text", markdown: "" } }, "n");
    const notes = cap.notesFor(CONV);
    expect(notes.length).toBe(1000);
    const states = messageStates(notes, cap.truncatedFor(CONV));
    const m = states.find((s) => s.message === "m");
    expect(m?.truncated).toBe(true);
    // The counts are what survived, and say so through the marker.
    expect(m?.deltas).toBe(999);
    expect(states.find((s) => s.message === "n")?.truncated).toBe(false);
    // Clearing forgets the marker with the notes.
    cap.clear(CONV);
    expect(cap.truncatedFor(CONV).size).toBe(0);
  });
});
