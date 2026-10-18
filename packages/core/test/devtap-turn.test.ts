/**
 * The developer tools' wire capture against the real adapter (§9.2): a turn
 * replayed from recorded upstream frames, through `createHermesChat`, with a
 * `DevTap` behind it. What it pins is the part only the adapter knows — which
 * conversation a socket served, what became of every event the turn read, and
 * which wire record each frame came from.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { disposeChatRequestPools } from "../src/chat/hermes/hermes-chat.ts";
import { DevTap, recordOf } from "../src/chat/devtap.ts";
import type { TapRecord } from "../src/schema/index.ts";
import { FIXTURE_SESSION_TOKEN, RECORDED_TURN, eventFrame } from "./fixtures/hermes-frames.ts";
import { DEVTAP_CONVERSATION as CONVERSATION, devtapTurn as turn } from "./fixtures/devtap-box.ts";

/** A sentinel shaped like an OpenRouter key, so the redaction patterns know it. */
const FIXTURE_TOOL_SECRET = "sk-or-v1-FIXTURE-DEVTOOLS-KEY";

afterEach(() => disposeChatRequestPools());

const wireIn = (records: TapRecord[], type: string, seq?: number): TapRecord[] =>
  records.filter(
    (r) =>
      r.layer === "wire" && r.dir === "in" && r.type === type && (seq === undefined || r.seq === seq),
  );

describe("devtap · a recorded turn", () => {
  test("every wire document lands in the conversation's ring, in and out", async () => {
    const { records } = await turn(RECORDED_TURN);
    const out = records.filter((r) => r.layer === "wire" && r.dir === "out").map((r) => r.type);
    expect(out.slice(0, 2)).toEqual(["client.capabilities", "session.create"]);
    expect(out).toContain("prompt.submit");
    // Responses are named by the request they answer, and settle as `none`.
    expect(wireIn(records, "session.create")[0]?.fate).toEqual({ kind: "none" });
    // Every event the box sent is captured, read by the turn or not.
    expect(records.filter((r) => r.layer === "wire" && r.dir === "in" && r.seq !== null).length).toBe(
      RECORDED_TURN.length,
    );
    expect(new Set(records.map((r) => r.socket))).toEqual(
      new Set(["held#" + records[0]?.socket?.split("#")[1]]),
    );
    const ids = records.map((r) => Number(r.id.slice(1)));
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    for (const r of records) expect(r.bytes).toBeGreaterThan(0);
  });

  test("an internal event is a drop, reasoning is buffered, content is frames", async () => {
    const { records } = await turn(RECORDED_TURN);
    expect(wireIn(records, "gateway.ready")[0]?.fate).toEqual({ kind: "drop", reason: "internal" });
    for (const r of wireIn(records, "thinking.delta"))
      expect(r.fate).toEqual({ kind: "buffer", into: "reasoning" });
    // `message.start` flushes the buffered reasoning: its two frames are its own.
    expect(wireIn(records, "message.start")[0]?.fate).toEqual({ kind: "frames", count: 2 });
    expect(wireIn(records, "message.complete")[0]?.fate?.kind).toBe("frames");
  });

  test("a frame's lineage names the wire record that produced it", async () => {
    const { frames, records } = await turn(RECORDED_TURN);
    const done = frames.find((f) => f.type === "done");
    const parent = recordOf(done);
    expect(parent?.record.type).toBe("message.complete");
    expect(records.some((r) => r.id === parent?.id)).toBe(true);
    const delta = frames.find((f) => f.type === "delta");
    expect(recordOf(delta)?.record.type).toBe("message.delta");
  });

  test("a retransmitted event is a replay drop", async () => {
    const repeat = eventFrame("message.delta", 6, { text: "po" });
    const { records } = await turn([
      eventFrame("message.delta", 6, { text: "po" }),
      repeat,
      eventFrame("message.complete", 7, { text: "po", status: "complete" }),
    ]);
    const deltas = wireIn(records, "message.delta", 6);
    expect(deltas.map((r) => r.fate)).toEqual([
      { kind: "frames", count: 2 },
      { kind: "drop", reason: "replay" },
    ]);
  });

  test("the dial and the scrape never hold the dashboard token", async () => {
    const { records } = await turn(RECORDED_TURN);
    const conn = records.filter((r) => r.layer === "conn").map((r) => r.type);
    expect(conn).toEqual(expect.arrayContaining(["token.scrape", "dial", "open", "session.create"]));
    expect(JSON.stringify(records)).not.toContain(FIXTURE_SESSION_TOKEN);
    const dial = records.find((r) => r.type === "dial");
    expect(JSON.stringify(dial?.payload)).toContain("token=[redacted]");
  });
});

describe("devtap · off", () => {
  test("a turn with no tap captures nothing and yields the same frames", async () => {
    const on = await turn(RECORDED_TURN);
    const off = await turn(RECORDED_TURN, { tap: null });
    expect(off.records).toEqual([]);
    expect(off.frames).toEqual(on.frames);
    expect(recordOf(off.frames.find((f) => f.type === "done"))).toBeUndefined();
  });

  test("a closed tap takes nothing more", async () => {
    const tap = new DevTap({ capture: "always", keep: 1000, redact: () => false });
    tap.close();
    await turn(RECORDED_TURN, { tap });
    expect(tap.stats()).toEqual({ conversations: 0, records: 0, bytes: 0, dropped: 0 });
  });
});

describe("devtap · a secret in a tool result", () => {
  const TOOL_TURN = [
    eventFrame("tool.complete", 3, {
      tool_id: "tc_FIXTURE_1",
      name: "terminal",
      args: { command: "env" },
      result: `OPENROUTER_API_KEY=${FIXTURE_TOOL_SECRET}`,
    }),
    eventFrame("message.complete", 4, { text: "done", status: "complete" }),
  ];

  test("redaction on: never buffered, never read, never exported", async () => {
    const { tap, records } = await turn(TOOL_TURN, { redact: true });
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(FIXTURE_TOOL_SECRET);
    expect(tap?.exportRing(CONVERSATION).ndjson).not.toContain(FIXTURE_TOOL_SECRET);
  });

  test("redaction off: shown in the inspector, masked in the export", async () => {
    const { tap, records } = await turn(TOOL_TURN, { redact: false });
    expect(JSON.stringify(records)).toContain(FIXTURE_TOOL_SECRET);
    const exported = tap?.exportRing(CONVERSATION);
    expect(exported?.count).toBe(records.length);
    expect(exported?.ndjson).not.toContain(FIXTURE_TOOL_SECRET);
  });
});
