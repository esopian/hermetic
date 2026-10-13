/**
 * The record's per-child memory (`chat-subagents.ts`), without a DOM.
 */
import { expect, test } from "bun:test";
import { fresh } from "../src/chat/chat-conversation-record.ts";
import { noteSubagent } from "../src/chat/chat-subagents.ts";
import type { SubagentView } from "../src/chat/chat-subagents.ts";

test("a child's tool stamps are kept only for the calls its block still holds", () => {
  const record = fresh({ instance: "atlas", bot: "atlas", session: null });
  const base = {
    kind: "subagent",
    subagent_id: "sa-long",
    depth: 0,
    task_index: 0,
    task_count: 1,
    goal: "A long run",
    status: "running",
    verdict: "running",
    origin: "live",
  } as const;
  for (let count = 0; count <= 60; count++) {
    // Like core's block: the last 24 calls, and the wire's own count.
    const tools = Array.from({ length: Math.min(count, 24) }, (_, i) => ({
      name: "terminal",
      preview: `step ${count - Math.min(count, 24) + i}`,
    }));
    noteSubagent(record, { ...base, tools, tool_count: count } as SubagentView, 1_000 + count);
  }
  const stamps = record.subagentTrail.get("sa-long")!.tools;
  expect(stamps.size).toBe(24);
  expect(Math.min(...stamps.keys())).toBe(36);
  expect(stamps.get(59)).toBe(1_060);
});
