/**
 * Bot-to-bot DMs (`message_agent`, Hermes v2026.9.24) as core maps them: the
 * delivery row a target's Bot Chat stores on the user role becomes a message
 * signed `from_bot` with the signature stripped, and the sender's tool call
 * carries the `message_agent` render hint.
 */
import { describe, expect, test } from "bun:test";
import { mapHistory, mapSessions } from "../src/chat/hermes/hermes-chat.ts";
import type { BoxAddress } from "../src/chat/hermes/hermes-chat.ts";
import { toolBlock } from "../src/chat/hermes/hermes-chat-blocks.ts";
import { parseBotDelivery } from "../src/chat/hermes/bot-delivery.ts";
import { ChatMessage } from "../src/schema/index.ts";

const BOX: BoxAddress = {
  instance: "atlas",
  baseUrl: "https://fxtr0001-atlas.tail0000.ts.net/",
  fleet_id: "fxtr0001",
};
const SESSION = "s-bot-chat";

const userRow = (id: number, content: unknown) => ({
  id,
  role: "user",
  content,
  timestamp: 1_789_000_000 + id,
});

describe("a delivery row", () => {
  test("upstream's signature becomes from_bot and the text keeps only the message", () => {
    const [message] = mapHistory(BOX, SESSION, {
      messages: [
        userRow(1, "Message from 🤖 Marshall (@scribe): Please re-run QA on #4124.\n\nThanks."),
      ],
    });
    expect(message?.role).toBe("user");
    expect(message?.from_bot).toEqual({ name: "Marshall", handle: "scribe" });
    expect(message?.blocks).toEqual([
      { kind: "text", markdown: "Please re-run QA on #4124.\n\nThanks." },
    ]);
    // The id is the row's, so a read either side of this mapping agrees.
    expect(message?.id).toBe(`${SESSION}:1`);
    expect(ChatMessage.parse(message).from_bot).toEqual({ name: "Marshall", handle: "scribe" });
  });

  test("a relayed handle drops its connection, and the robot glyph is optional", () => {
    expect(parseBotDelivery("Message from Nick QA (@auditor@laptop-2): ok")).toEqual({
      from: { name: "Nick QA", handle: "auditor" },
      body: "ok",
    });
  });

  test("a signature with no handle, and the legacy form, name the sender only", () => {
    const [bare, legacy] = mapHistory(BOX, SESSION, {
      messages: [
        userRow(1, "Message from 🤖 hermes: are you there?"),
        userRow(2, [{ type: "text", text: "[Message from agent 'scribe'] digest is late" }]),
      ],
    });
    expect(bare?.from_bot).toEqual({ name: "hermes", handle: null });
    expect(bare?.blocks).toEqual([{ kind: "text", markdown: "are you there?" }]);
    expect(legacy?.from_bot).toEqual({ name: "scribe", handle: null });
    expect(legacy?.blocks).toEqual([{ kind: "text", markdown: "digest is late" }]);
  });

  test("ordinary text, and a signature anywhere but the start, are left alone", () => {
    const plain = "why is the digest late?";
    const quoted = "Forwarding this — Message from 🤖 Marshall (@scribe): hi";
    const messages = mapHistory(BOX, SESSION, {
      messages: [userRow(1, plain), userRow(2, quoted)],
    });
    for (const [message, text] of [
      [messages[0], plain],
      [messages[1], quoted],
    ] as const) {
      expect(message?.blocks).toEqual([{ kind: "text", markdown: text }]);
      // Omitted, not null: every other row keeps the shape it always had.
      expect(message && "from_bot" in message).toBe(false);
    }
  });

  test("a bot row that starts with the words is the bot speaking", () => {
    const [message] = mapHistory(BOX, SESSION, {
      messages: [{ id: 1, role: "assistant", content: "Message from 🤖 Marshall (@scribe): hi" }],
    });
    expect(message?.role).toBe("bot");
    expect(message && "from_bot" in message).toBe(false);
  });

  test("the rail previews a delivery as the sender speaking", () => {
    const [session] = mapSessions(BOX, "auditor", {
      sessions: [
        {
          session_id: "s1",
          title: "Bot Chat",
          preview: "Message from 🤖 Marshall (@scribe): re-run QA...",
        },
      ],
    });
    expect(session?.preview).toBe("Marshall: re-run QA...");
  });
});

describe("the message_agent tool", () => {
  test("carries its own render hint", () => {
    const block = toolBlock(
      {
        tool_id: "call-1",
        name: "message_agent",
        args: { target: "@auditor", message: "re-run QA" },
        result: '{"status":"queued","to":"@auditor","process_id":"proc_1"}',
      },
      null,
    );
    expect(block.kind === "tool" ? block.render : null).toBe("message_agent");
  });
});
