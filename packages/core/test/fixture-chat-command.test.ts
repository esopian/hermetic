/**
 * The fixture's command layer (`fixture-chat-command.ts`): a slash command in
 * a fixture chat is answered the way the live adapter answers one, and a
 * command answered in full never becomes a prompt or a transcript row.
 */
import { describe, expect, test } from "bun:test";
import { fixtureChatClient } from "../src/backend/fixture/fixture-chat.ts";
import type { BoxAddress } from "../src/chat/hermes/hermes-chat-types.ts";
import { ChatFrame } from "../src/schema/index.ts";

const BOX: BoxAddress = { instance: "atlas", baseUrl: "fixture://atlas" };

async function collect(stream: AsyncIterable<ChatFrame>): Promise<ChatFrame[]> {
  const out: ChatFrame[] = [];
  for await (const frame of stream) out.push(ChatFrame.parse(frame));
  return out;
}

const commandBlocks = (frames: ChatFrame[]) =>
  frames.flatMap((f) => (f.type === "block" && f.block.kind === "command" ? [f.block] : []));
const text = (frames: ChatFrame[]) =>
  frames.some((f) => f.type === "delta" || (f.type === "block" && f.block.kind === "text"));

describe("fixture chat · slash commands", () => {
  test("/help is answered with output and no model turn", async () => {
    const frames = await collect(fixtureChatClient().send(BOX, "default", "/help"));
    expect(commandBlocks(frames)).toMatchObject([{ command: "/help", state: "done" }]);
    expect(text(frames)).toBe(false);
    expect(frames.at(-1)?.type).toBe("done");
  });

  test("an unknown command is an error", async () => {
    const frames = await collect(fixtureChatClient().send(BOX, "default", "/nope"));
    expect(commandBlocks(frames)).toMatchObject([{ command: "/nope", state: "error" }]);
    expect(text(frames)).toBe(false);
  });

  test("/undo's prefill is reported unsupported, with its text", async () => {
    const frames = await collect(fixtureChatClient().send(BOX, "default", "/undo"));
    expect(commandBlocks(frames)).toMatchObject([
      { state: "unsupported", dispatch: "prefill", prefill: "the message before last" },
    ]);
  });

  test("/goal shows its notice, then runs a turn on its message", async () => {
    const frames = await collect(fixtureChatClient().send(BOX, "default", "/goal ship it"));
    expect(commandBlocks(frames)).toMatchObject([{ output: "⊙ Goal set: ship it", dispatch: "send" }]);
    expect(text(frames)).toBe(true);
    // One message: the notice and the turn it started.
    expect(new Set(frames.flatMap((f) => (f.type === "error" ? [] : [f.message]))).size).toBe(1);
  });

  test("prose with a slash in it is still a turn", async () => {
    const frames = await collect(fixtureChatClient().send(BOX, "default", "/usr/local/bin is missing"));
    expect(commandBlocks(frames)).toEqual([]);
    expect(text(frames)).toBe(true);
  });
});
