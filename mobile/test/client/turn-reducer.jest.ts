import {
  appendDelta,
  applyFrame,
  blockKey,
  foldFrame,
  freshFold,
  mergeBlock,
  nextTurnActivity,
  type TurnFold,
} from "../../src/client/turn-reducer.ts";
import type { ChatFrame } from "@hermetic/core/chat-client";
import {
  approval,
  block,
  delta,
  done,
  errorFrame,
  question,
  subagent,
  tool,
} from "../helpers/fixtures.ts";

const seed = { session: "s-1", at: "2026-10-13T10:00:00.000Z" };
const fold = (frames: ChatFrame[], start: TurnFold = freshFold()): TurnFold =>
  frames.reduce((state, frame) => foldFrame(state, frame, seed), start);
const texts = (state: TurnFold) =>
  (state.live?.blocks ?? [])
    .filter((b) => b.kind === "text")
    .map((b) => (b.kind === "text" ? b.markdown : ""));

describe("applyFrame", () => {
  test("mints the message from the first frame's id and seed", () => {
    const live = applyFrame(null, delta(0, "Hi"), seed);
    expect(live.id).toBe("m1");
    expect(live.session).toBe("s-1");
    expect(live.role).toBe("bot");
    expect(live.at).toBe(seed.at);
    expect(live.blocks).toEqual([{ kind: "text", markdown: "Hi" }]);
  });

  test("an error with nothing said mints a failed message carrying the failure", () => {
    const live = applyFrame(null, errorFrame("AUTH", "bad key"), seed);
    expect(live.id).toBe(`failed:${seed.at}`);
    expect(live.failure).toEqual({ code: "AUTH", message: "bad key" });
  });

  test("an error prefers core's structured failure", () => {
    const frame: ChatFrame = {
      type: "error",
      code: "X",
      message: "m",
      failure: {
        code: "RATE_LIMITED",
        message: "later",
        surface: { layer: "provider", code: "429", retryable: true },
      },
    };
    expect(applyFrame(null, frame, seed).failure?.code).toBe("RATE_LIMITED");
  });

  test("done records usage and incomplete", () => {
    const live = applyFrame(
      applyFrame(null, delta(0, "x"), seed),
      { ...(done(1) as Extract<ChatFrame, { type: "done" }>), incomplete: true },
      seed,
    );
    expect(live.usage?.output_tokens).toBe(20);
    expect(live.incomplete).toBe(true);
  });
});

describe("block identity", () => {
  test("keys", () => {
    expect(blockKey(tool())).toBe("id:t1");
    expect(blockKey(tool({ tool_id: null }))).toBe("name:terminal");
    expect(blockKey(approval())).toBe("approval:r1");
    expect(blockKey(question())).toBe("question:q1");
    expect(blockKey(approval({ request_id: null }))).toBeNull();
    expect(blockKey(subagent())).toBe("subagent:s1");
    expect(
      blockKey({
        kind: "activity",
        category: "generation",
        key: "gen",
        title: "Thinking",
        state: "running",
      }),
    ).toBe("activity:gen");
    expect(blockKey({ kind: "text", markdown: "x" })).toBeNull();
  });

  test("a running tool is replaced by its completion, by tool_id", () => {
    const blocks = mergeBlock([tool()], tool({ status: "ok", result: "a\nb" }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ status: "ok", result: "a\nb" });
  });

  test("two parallel calls with distinct ids stay two cards", () => {
    const blocks = mergeBlock([tool()], tool({ tool_id: "t2" }));
    expect(blocks).toHaveLength(2);
  });

  test("without an id the tool name is the fallback key", () => {
    const blocks = mergeBlock([tool({ tool_id: null })], tool({ tool_id: null, status: "bad" }));
    expect(blocks).toEqual([tool({ tool_id: null, status: "bad" })]);
  });

  test("text blocks always append", () => {
    expect(mergeBlock([{ kind: "text", markdown: "a" }], { kind: "text", markdown: "b" })).toHaveLength(
      2,
    );
  });

  test("appendDelta extends the last text block, or opens one after a tool", () => {
    expect(appendDelta([{ kind: "text", markdown: "a" }, tool()], "b")).toEqual([
      { kind: "text", markdown: "ab" },
      tool(),
    ]);
    expect(appendDelta([tool()], "x")).toEqual([tool(), { kind: "text", markdown: "x" }]);
  });
});

describe("foldFrame — a whole turn", () => {
  test("text deltas stream into one block", () => {
    const state = fold([delta(0, "Hel"), delta(1, "lo"), delta(2, " world"), done(3)]);
    expect(texts(state)).toEqual(["Hello world"]);
    expect(state.terminal).toBe(true);
    expect(state.activity).toBe("idle");
  });

  test("tool running → ok replaces in place; reasoning appends", () => {
    const state = fold([
      block(0, { kind: "reasoning", text: "let me look" }),
      block(1, tool()),
      delta(2, "Found it."),
      block(3, tool({ status: "ok", exit_code: 0 })),
      done(4),
    ]);
    const kinds = state.live?.blocks.map((b) => b.kind);
    expect(kinds).toEqual(["reasoning", "tool", "text"]);
    expect(state.live?.blocks[1]).toMatchObject({ status: "ok", exit_code: 0 });
  });

  test("a replayed approval updates its own card, and opens a request once", () => {
    const state = fold([
      delta(0, "Need a yes."),
      block(1, approval()),
      block(1, approval({ summary: "rm -rf build/" })),
    ]);
    const approvals = state.live?.blocks.filter((b) => b.kind === "approval") ?? [];
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ summary: "rm -rf build/" });
    expect(state.openRequests).toEqual(["r1"]);
    expect(state.activity).toBe("idle");
  });

  test("a done notice closes the request", () => {
    const state = fold([
      block(0, question()),
      block(1, {
        kind: "activity",
        category: "notice",
        key: "req:q1",
        title: "Answered",
        state: "done",
        request_id: "q1",
      }),
    ]);
    expect(state.openRequests).toEqual([]);
  });

  test("a released request is not reopened by its replay", () => {
    const released = new Set(["r1"]);
    const state = foldFrame(freshFold(), block(0, approval()), seed, released);
    expect(state.openRequests).toEqual([]);
  });

  test("subagent blocks replace by subagent id", () => {
    const state = fold([
      block(0, subagent()),
      block(1, subagent({ status: "completed", verdict: "done" })),
    ]);
    expect(state.live?.blocks).toHaveLength(1);
    expect(state.live?.blocks[0]).toMatchObject({ verdict: "done" });
  });

  test("activity blocks replace by key", () => {
    const state = fold([
      block(0, {
        kind: "activity",
        category: "generation",
        key: "gen",
        title: "Thinking",
        state: "running",
      }),
      block(1, {
        kind: "activity",
        category: "generation",
        key: "gen",
        title: "Thought",
        state: "done",
      }),
    ]);
    expect(state.live?.blocks).toEqual([
      { kind: "activity", category: "generation", key: "gen", title: "Thought", state: "done" },
    ]);
  });

  test("a frame with a lower seq is dropped (same object back)", () => {
    const state = fold([delta(0, "a"), delta(5, "b")]);
    expect(foldFrame(state, delta(3, "late"), seed)).toBe(state);
    expect(texts(state)).toEqual(["ab"]);
  });

  test("a delta repeated verbatim at the same seq is dropped; a different one is not", () => {
    const state = fold([delta(0, "a"), delta(1, "b"), delta(1, "b"), delta(1, "c")]);
    expect(texts(state)).toEqual(["abc"]);
  });

  test("nothing folds after done", () => {
    const state = fold([delta(0, "a"), done(1)]);
    expect(foldFrame(state, delta(2, "b"), seed)).toBe(state);
  });

  test("an error after text keeps the text and sets the failure", () => {
    const state = fold([delta(0, "partial"), errorFrame("CONTEXT_OVERFLOW", "too long")]);
    expect(texts(state)).toEqual(["partial"]);
    expect(state.live?.failure?.code).toBe("CONTEXT_OVERFLOW");
    expect(state.terminal).toBe(true);
  });

  test("activity follows the desktop's rules", () => {
    expect(nextTurnActivity("thinking", delta(0, "  "))).toBe("thinking");
    expect(nextTurnActivity("thinking", delta(0, "x"))).toBe("streaming");
    expect(nextTurnActivity("streaming", block(0, tool()))).toBe("thinking");
    expect(nextTurnActivity("streaming", block(0, approval()))).toBe("idle");
    expect(nextTurnActivity("idle", done(0))).toBe("idle");
  });
});
