/**
 * The Diff view's field map (`shared/devtools-field-map.ts`) agrees with the
 * mappers it describes. Each case drives the real mapper on a recorded payload
 * and checks every rule the table states about it, and that nothing the
 * recording carries is left out of the table — so the table cannot drift from
 * `mapUsage` or `toolBlock` without this file failing.
 */
import { describe, expect, test } from "bun:test";
import { mapUsage, toolBlock } from "../src/chat/hermes/hermes-chat-blocks.ts";
import { DEVTOOLS_FIELD_MAP, devtoolsFieldMap } from "../src/shared/index.ts";
import type { DevtoolsFieldRule } from "../src/shared/index.ts";
import { RECORDED_MESSAGE_COMPLETE, UNKNOWN_TOOL_COMPLETE } from "./fixtures/hermes-frames.ts";

function payloadOf(frame: string): Record<string, unknown> {
  const doc = JSON.parse(frame) as { params: { payload: Record<string, unknown> } };
  return doc.params.payload;
}

function at(value: unknown, path: string): unknown {
  let cur = value;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function rule(rules: readonly DevtoolsFieldRule[], wire: string): DevtoolsFieldRule | undefined {
  return rules.find((r) => r.wire === wire);
}

describe("devtools field map · usage on message.complete", () => {
  const payload = payloadOf(RECORDED_MESSAGE_COMPLETE);
  const usage = payload.usage as Record<string, unknown>;
  const mapped = mapUsage(usage);
  const rules = devtoolsFieldMap("message.complete")?.fields ?? [];

  test("every field of the recorded usage has a rule", () => {
    expect(Object.keys(usage).length).toBeGreaterThanOrEqual(16);
    for (const key of Object.keys(usage)) expect(rule(rules, `usage.${key}`)).toBeDefined();
  });

  test("kept and renamed fields carry the wire value; dropped ones reach no frame field", () => {
    const frameKeys = new Set(Object.keys(mapped ?? {}).map((k) => `usage.${k}`));
    const reached = new Set<string>();
    for (const key of Object.keys(usage)) {
      const r = rule(rules, `usage.${key}`);
      if (!r) continue;
      if (r.fate === "dropped") {
        expect(r.frame).toBeNull();
        continue;
      }
      expect(r.frame).not.toBeNull();
      const out = at({ usage: mapped }, r.frame ?? "");
      if (key === "context_percent") expect(out).toBe(Math.round(Number(usage[key])));
      else expect(out).toBe(usage[key]);
      reached.add(r.frame ?? "");
    }
    // A frame field no rule explains is the drift this test exists for.
    for (const key of frameKeys) {
      const explained = rules.some(
        (r) => r.frame === key && (reached.has(key) || r.fate === "synthesized"),
      );
      expect({ key, explained }).toEqual({ key, explained: true });
    }
  });

  test("the recording's 16 fields become the frame's 7", () => {
    expect(Object.keys(mapped ?? {}).sort()).toEqual(
      [
        "context_max",
        "context_percent",
        "context_used",
        "cost_usd",
        "input_tokens",
        "model",
        "output_tokens",
      ].sort(),
    );
    expect(mapped?.cost_usd).toBeNull();
  });

  test("the alias spellings resolve as the table says", () => {
    const aliased = mapUsage({ input_tokens: 5, output_tokens: 6, cost: 0.25 });
    expect(aliased?.input_tokens).toBe(5);
    expect(aliased?.output_tokens).toBe(6);
    expect(aliased?.cost_usd).toBe(0.25);
    for (const wire of ["usage.input_tokens", "usage.output_tokens", "usage.cost"])
      expect(rule(rules, wire)?.fate).not.toBe("dropped");
    // `prompt`/`completion` are read only when both other spellings are absent.
    expect(mapUsage({ prompt: 9, completion: 8 })?.input_tokens).toBe(9);
  });
});

describe("devtools field map · tool blocks", () => {
  const rules = devtoolsFieldMap("tool.complete")?.fields ?? [];

  test("a recorded tool.complete maps as the table says", () => {
    const payload = payloadOf(UNKNOWN_TOOL_COMPLETE);
    const block = toolBlock(payload, null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(payload)) {
      const r = rule(rules, key) ?? rule(rules, "*");
      expect(r).toBeDefined();
      if (!r || r.fate === "dropped" || r.frame === null) continue;
      if (r.frame === "block.args.*") expect(at({ block }, `block.args.${key}`)).toEqual(value);
      else expect(at({ block }, r.frame)).toEqual(value);
    }
  });

  test("the renamed spellings land where the table says", () => {
    const block = toolBlock(
      {
        tool: "shell",
        call_id: "c1",
        arguments: { cmd: "ls" },
        output: "a b",
        returncode: 3,
        duration_s: 2,
        context: "shell(ls)",
      },
      null,
    ) as Record<string, unknown>;
    const expectations: Record<string, unknown> = {
      tool: "shell",
      call_id: "c1",
      output: "a b",
      returncode: 3,
      duration_s: 2000,
    };
    for (const [wire, value] of Object.entries(expectations)) {
      const r = rule(rules, wire);
      expect(r?.fate).toBe("renamed");
      expect(at({ block }, r?.frame ?? "")).toEqual(value);
    }
    expect(at({ block }, "block.args.cmd")).toBe("ls");
    expect(at({ block }, "block.args.context")).toBe("shell(ls)");
    expect(block.status).toBe("bad");
    expect(rules.filter((r) => r.fate === "synthesized").map((r) => r.frame)).toEqual([
      "block.server",
      "block.render",
    ]);
    for (const frame of ["block.server", "block.render"]) expect(frame.slice(6) in block).toBe(true);
  });
});

describe("devtools field map · shape", () => {
  test("every rule is coherent with its fate", () => {
    for (const entry of DEVTOOLS_FIELD_MAP) {
      expect(entry.events.length).toBeGreaterThan(0);
      for (const r of entry.fields) {
        if (r.fate === "synthesized") expect(r.wire).toBeNull();
        else expect(r.wire).not.toBeNull();
        if (r.fate === "dropped") expect(r.frame).toBeNull();
        else expect(r.frame).not.toBeNull();
      }
    }
  });
});
