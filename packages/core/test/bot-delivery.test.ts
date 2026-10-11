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

  test("a relayed handle keeps its connection", () => {
    expect(parseBotDelivery("Message from 🤖 Nick QA (@auditor@laptop-2): ok")).toEqual({
      from: { name: "Nick QA", handle: "auditor", connection: "laptop-2" },
      body: "ok",
    });
  });

  test("upstream's own stamps parse", () => {
    // `tests/tools/test_bot_mode_dm.py:312,516,530,546` (v2026.9.24): the
    // prefix `message_agent` writes, and a friendly name over the handle.
    for (const [stamp, name, handle] of [
      ["Message from 🤖 hermes (@hermes): ", "hermes", "hermes"],
      ["Message from 🤖 Maia (@hermes): ", "Maia", "hermes"],
      ["Message from 🤖 Maia Prime (@hermes): ", "Maia Prime", "hermes"],
      ["Message from 🤖 coder (@coder): ", "coder", "coder"],
    ] as const) {
      expect(parseBotDelivery(`${stamp}ping`)).toEqual({ from: { name, handle }, body: "ping" });
    }
  });

  test("an operator line that only reads like a signature is the operator speaking", () => {
    // Desktop's pattern takes all of these as deliveries; upstream never
    // writes a stamp without both the glyph and the handle.
    for (const text of [
      "Message from HR: the offsite moved",
      "Message from 🤖 HR: the offsite moved",
      "Message from Nick QA (@auditor): ok",
      "Message from agent 'researcher': here is the paper",
    ]) {
      expect(parseBotDelivery(text)).toBeNull();
    }
    const [message] = mapHistory(BOX, SESSION, {
      messages: [userRow(1, "Message from HR: the offsite moved")],
    });
    expect(message?.blocks).toEqual([{ kind: "text", markdown: "Message from HR: the offsite moved" }]);
    expect(message && "from_bot" in message).toBe(false);
  });

  test("a relayed sender reaches the message as from_bot.connection; a local one carries none", () => {
    const [relayed, local] = mapHistory(BOX, SESSION, {
      messages: [
        userRow(1, "Message from 🤖 Marshall (@scribe@laptop): from the other side"),
        userRow(2, "Message from 🤖 Marshall (@scribe): from next door"),
      ],
    });
    // `scribe@laptop` is not this box's scribe: without the connection a head
    // would resolve the handle to the local bot of the same name.
    expect(relayed?.from_bot).toEqual({ name: "Marshall", handle: "scribe", connection: "laptop" });
    expect(relayed?.blocks).toEqual([{ kind: "text", markdown: "from the other side" }]);
    expect(ChatMessage.parse(relayed).from_bot?.connection).toBe("laptop");
    expect(local?.from_bot).toEqual({ name: "Marshall", handle: "scribe" });
    expect(local?.from_bot && "connection" in local.from_bot).toBe(false);
  });

  test("the legacy bracketed form names the sender only", () => {
    const [legacy] = mapHistory(BOX, SESSION, {
      messages: [userRow(2, [{ type: "text", text: "[Message from agent 'scribe'] digest is late" }])],
    });
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

  test("the rail quotes an operator line that reads like a signature as typed", () => {
    const [session] = mapSessions(BOX, "auditor", {
      sessions: [
        { session_id: "s1", title: "Bot Chat", preview: "Message from HR: the offsite moved" },
      ],
    });
    expect(session?.preview).toBe("Message from HR: the offsite moved");
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
