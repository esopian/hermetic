import { describe, expect, test } from "bun:test";
import { createBranches } from "../src/chat/hermes/hermes-chat-branch.ts";
import type { Rpc } from "../src/chat/hermes/hermes-chat-rpc.ts";
import type { BoxAddress } from "../src/chat/hermes/hermes-chat-types.ts";
import { HermeticError } from "../src/errors.ts";
import type { ChatBlock, ChatMessage } from "../src/schema/index.ts";

const BOX = { instance: "ember", baseUrl: "http://ember.test/" } as BoxAddress;

const row = (
  n: number,
  role: ChatMessage["role"],
  blocks: ChatBlock[],
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: `p:${n}`,
  session: "parent-1",
  role,
  at: `2026-10-30T12:00:${String(n).padStart(2, "0")}.000Z`,
  blocks,
  usage: null,
  error: null,
  incomplete: null,
  ...extra,
});
const text = (markdown: string): ChatBlock => ({ kind: "text", markdown });
const tool = { kind: "tool", id: "t1", name: "terminal", state: "done" } as unknown as ChatBlock;

/** A parent mid-turn after 12:00:06: its prompt and a tool step must stay out. */
const PARENT: ChatMessage[] = [
  row(1, "user", [text("hello")]),
  row(2, "bot", [text("let me look"), tool]),
  row(3, "bot", [text("hi there")]),
  row(4, "system", [text("a notice")]),
  row(5, "user", [text("check the logs")]),
  row(6, "bot", [text("all clear")]),
  row(7, "user", [text("now deploy")]),
  row(8, "bot", [text("deploying"), tool]),
  row(9, "user", [text("after the snapshot")]),
  row(10, "bot", [text("late reply")]),
];

interface Sent {
  method: string;
  params: Record<string, unknown>;
}

function gateway(reply: (method: string) => unknown) {
  const sent: Sent[] = [];
  let closed = false;
  let connects = 0;
  const rpc = {
    request: (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      try {
        return Promise.resolve(reply(method));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    close: () => {
      closed = true;
    },
  } as unknown as Rpc;
  const branches = createBranches({
    connect: () => {
      connects++;
      return Promise.resolve(rpc);
    },
    conversation: () => Promise.resolve({ session: "parent-1" } as never),
    history: (_box, _bot, opts) =>
      Promise.resolve(opts?.session === "parent-1" ? PARENT.map((m) => ({ ...m })) : []),
  });
  return { branches, sent, closed: () => closed, connects: () => connects };
}

const created = (method: string): unknown =>
  method === "session.create"
    ? { session_id: "rt-9", stored_session_id: "child-9", message_count: 7 }
    : { closed: true };

describe("hermes-chat · branch", () => {
  test("seeds visible history to the snapshot, trimmed to a finished reply, then the Q&A", async () => {
    const g = gateway(created);
    const result = await g.branches.branch(BOX, "research", {
      until: "2026-10-30T12:00:08.000Z",
      question: "what changed?",
      answer: "nothing yet",
    });
    expect(result).toEqual({ session: "child-9", parent_session: "parent-1", messages: 7 });
    expect(g.sent).toEqual([
      {
        method: "session.create",
        params: {
          profile: "research",
          source: "hermetic",
          parent_session_id: "parent-1",
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "let me look" },
            { role: "assistant", content: "hi there" },
            { role: "user", content: "check the logs" },
            { role: "assistant", content: "all clear" },
            { role: "user", content: "what changed?" },
            { role: "assistant", content: "nothing yet" },
          ],
        },
      },
      // The new runtime session is closed; the parent is never resumed.
      { method: "session.close", params: { session_id: "rt-9" } },
    ]);
    expect(g.connects()).toBe(1);
    expect(g.closed()).toBe(true);
  });

  test("without a question it is the history alone, from a named session", async () => {
    const g = gateway(created);
    await g.branches.branch(BOX, "research", { session: "parent-1" });
    const seed = g.sent[0]?.params.messages as { content: string }[];
    expect(seed.map((m) => m.content)).toEqual([
      "hello",
      "let me look",
      "hi there",
      "check the logs",
      "all clear",
      "now deploy",
      "deploying",
      "after the snapshot",
      "late reply",
    ]);
  });

  test("until_message cuts after a known row; an unknown id is ignored", async () => {
    const seeded = async (until_message: string) => {
      const g = gateway(created);
      await g.branches.branch(BOX, "research", { until_message });
      return ((g.sent[0]?.params.messages ?? []) as { content: string }[]).map((m) => m.content);
    };
    expect(await seeded("p:3")).toEqual(["hello", "let me look", "hi there"]);
    // A cut on a user row still trims back to the reply before it.
    expect(await seeded("p:7")).toEqual([
      "hello",
      "let me look",
      "hi there",
      "check the logs",
      "all clear",
    ]);
    expect(await seeded("local:prompt-1")).toHaveLength(9);
  });

  test("a gateway that ignores messages or lacks session.create seeding is CHAT_PROTOCOL", async () => {
    const ignoring = gateway((m) =>
      m === "session.create" ? { session_id: "rt-1", stored_session_id: "child-1" } : {},
    );
    const refusal = ignoring.branches.branch(BOX, "research", {});
    await expect(refusal).rejects.toMatchObject({
      code: "CHAT_PROTOCOL",
      message: "This gateway cannot seed a branch session",
    });
    // The empty draft it made is closed all the same.
    expect(ignoring.sent.at(-1)).toEqual({ method: "session.close", params: { session_id: "rt-1" } });
    expect(ignoring.closed()).toBe(true);

    const old = gateway(() => {
      throw new HermeticError("CHAT_PROTOCOL", "method not found", { code: -32601 });
    });
    await expect(old.branches.branch(BOX, "research", {})).rejects.toMatchObject({
      code: "CHAT_PROTOCOL",
      message: "This gateway cannot seed a branch session",
    });
    expect(old.closed()).toBe(true);
  });

  test("nothing to branch is VALIDATION, before any socket", async () => {
    const g = gateway(created);
    await expect(g.branches.branch(BOX, "research", { session: "empty" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      g.branches.branch(BOX, "research", { until: "2026-10-30T11:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(g.connects()).toBe(0);
  });
});
