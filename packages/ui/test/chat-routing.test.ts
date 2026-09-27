import { describe, expect, test } from "bun:test";
import { chatHash, chatRefHash, parseChatHash } from "../src/chat/chat-routing.ts";
import { actionHash } from "../src/logic/notification-logic.ts";

describe("bot-aware chat links", () => {
  test("identities and session/message IDs round-trip reserved characters", () => {
    const target = { instance: "atlas", bot: "research/ops?100%✓", session: "s /?%+" };
    const hash = chatHash(target, "m /#?+%");
    expect(parseChatHash(hash)).toEqual({ ...target, message: "m /#?+%" });
  });
  test("bare instance defaults bot while malformed links do not select", () => {
    expect(parseChatHash("#chat/atlas")).toEqual({
      instance: "atlas",
      bot: "default",
      session: null,
      message: null,
    });
    for (const hash of [
      "#chat",
      "#chat/",
      "#chat//default",
      "#chat/a/b/c",
      "#chat/a/%xy",
      "#chat/a/b?session=%xy",
      "#chat/a/%00",
    ])
      expect(parseChatHash(hash)).toBeNull();
  });
  test("raw notification refs preserve the entire bot suffix literally", () => {
    for (const bot of ["research/ops", "ops?review", "%20", "résumé#one"]) {
      const hash = actionHash({ target: "chat", ref: `atlas/${bot}` });
      expect(parseChatHash(hash!)).toEqual({ instance: "atlas", bot, session: null, message: null });
    }
    expect(chatRefHash(null)).toBe("#chat");
  });
  test("explicit chat URL notification refs retain session and message", () => {
    const target = { instance: "atlas", bot: "clio", session: "sx-channel" };
    const hash = chatHash(target, "message-one");
    expect(actionHash({ target: "chat", ref: hash })).toBe(hash);
  });
});
