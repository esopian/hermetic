/**
 * The fixture's share turn (`fixture-chat-file-share.ts`): two `share_file`
 * cards whose files land in the fixture box's outbox, readable through
 * `files.content` under the digest the card names, and a reply whose `MEDIA:`
 * outbox line becomes an attachment chip and leaves the text.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fixtureChatClient } from "../src/backend/fixture/fixture-chat.ts";
import {
  FIXTURE_FOREIGN_MEDIA_PATH,
  FIXTURE_MEDIA_KINDS_DELTA,
} from "../src/backend/fixture/fixture-chat-file-share.ts";
import { MemoryFiles } from "../src/backend/fixture/memory-files.ts";
import type { BoxAddress } from "../src/chat/hermes/hermes-chat.ts";
import type { ChatBlock, ChatFrame } from "../src/schema/index.ts";
import { ChatFrame as ChatFrameSchema } from "../src/schema/index.ts";
import { MEDIA_TAG } from "../src/shared/files.ts";

type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;

const AGENT = "atlas";
const SESSION = "sx-atlas-portal";
const BOX: BoxAddress = { instance: AGENT, baseUrl: "https://fxtr0001-atlas.tail0000.ts.net/" };

async function run(prompt: string) {
  const files = new MemoryFiles({ hasAgent: (name) => name === AGENT, now: () => new Date() });
  const client = fixtureChatClient({ files });
  const frames: ChatFrame[] = [];
  for await (const frame of client.send(BOX, "default", prompt, { session: SESSION }))
    frames.push(frame);
  const blocks = frames.flatMap((f) => (f.type === "block" ? [f.block] : []));
  const text = frames.flatMap((f) => (f.type === "delta" ? [f.text] : [])).join("");
  return { files, client, frames, blocks, text };
}

describe("E2E_FILE_SHARE", () => {
  test("two share cards, a chip for the MEDIA line, and the bytes in the outbox", async () => {
    const { files, frames, blocks, text } = await run("E2E_FILE_SHARE the Q3 numbers");
    for (const frame of frames) expect(ChatFrameSchema.safeParse(frame).success).toBe(true);

    const done = blocks.filter(
      (b): b is ToolBlock => b.kind === "tool" && b.name === "share_file" && b.status === "ok",
    );
    expect(done.map((b) => [b.render, b.share?.name, b.share?.mime])).toEqual([
      ["file_share", "q3-revenue.png", "image/png"],
      ["file_share", "q3-revenue.csv", "text/csv"],
    ]);
    // The running cards have no share yet.
    const running = blocks.filter((b): b is ToolBlock => b.kind === "tool" && b.status === "running");
    expect(running.map((b) => b.share ?? null)).toEqual([null, null]);

    // Both are in the outbox, and the bytes behind each card match its digest.
    const listed = await files.list(AGENT, {});
    expect(listed.outbox.map((e) => e.name).sort()).toEqual(["q3-revenue.csv", "q3-revenue.png"]);
    for (const card of done) {
      const share = card.share!;
      const content = await files.content(AGENT, share.share_id, { maxBytes: 1 << 20 });
      expect(content.bytes.byteLength).toBe(share.bytes);
      expect(createHash("sha256").update(content.bytes).digest("hex")).toBe(share.sha256);
      expect(listed.outbox.find((e) => e.id === share.share_id)?.session_id).toBe(SESSION);
    }

    // The chart's MEDIA line is a chip, described from the outbox, not text.
    const chart = done[0]!.share!;
    const chips = blocks.filter((b) => b.kind === "attachment");
    expect(chips).toEqual([
      {
        kind: "attachment",
        name: "q3-revenue.png",
        mime: "image/png",
        bytes: chart.bytes,
        href: `outbox/${chart.share_id}/q3-revenue.png`,
        file_id: chart.share_id,
        sha256: chart.sha256,
      },
    ]);
    expect(text).toContain("Q3 revenue chart");
    expect(text).not.toContain(MEDIA_TAG);
    expect(frames.at(-1)?.type).toBe("done");
  });

  test("the transcript keeps the cards and the chip", async () => {
    const { client } = await run("E2E_FILE_SHARE");
    const history = await client.history(BOX, "default", { session: SESSION });
    const reply = history.at(-1)!;
    expect(reply.role).toBe("bot");
    const kinds = reply.blocks.map((b) => (b.kind === "tool" ? `tool:${b.render}` : b.kind));
    expect(kinds.filter((k) => k === "tool:file_share")).toHaveLength(2);
    expect(kinds).toContain("attachment");
  });

  test("without a files service the prompt is an ordinary turn", async () => {
    const client = fixtureChatClient({});
    const frames: ChatFrame[] = [];
    for await (const frame of client.send(BOX, "default", "E2E_FILE_SHARE", { session: SESSION }))
      frames.push(frame);
    expect(
      frames.some(
        (f) => f.type === "block" && f.block.kind === "tool" && f.block.name === "share_file",
      ),
    ).toBe(false);
  });
});

describe("E2E_MEDIA_SHARE", () => {
  test("no tool call: each MEDIA line is a chip, described from the outbox", async () => {
    const { files, frames, blocks, text } = await run("E2E_MEDIA_SHARE the Q3 numbers");
    for (const frame of frames) expect(ChatFrameSchema.safeParse(frame).success).toBe(true);
    expect(blocks.some((b) => b.kind === "tool")).toBe(false);

    const listed = await files.list(AGENT, {});
    const chips = blocks.filter((b) => b.kind === "attachment");
    expect(chips.map((c) => [c.name, c.mime])).toEqual([
      ["q3-revenue.png", "image/png"],
      ["q3-revenue.csv", "text/csv"],
    ]);
    for (const chip of chips) {
      const entry = listed.outbox.find((e) => e.id === chip.file_id)!;
      expect(entry.session_id).toBe(SESSION);
      expect(chip).toEqual({
        kind: "attachment",
        name: entry.name,
        mime: entry.mime,
        bytes: entry.bytes,
        href: `outbox/${entry.id}/${entry.name}`,
        file_id: entry.id,
        sha256: entry.sha256,
      });
    }
    // The prose on both sides of the lines survives; the lines do not.
    expect(text).toContain("CSV behind it.");
    expect(text).toContain("September is up 8% on August.");
    expect(text).not.toContain(MEDIA_TAG);
    expect(frames.at(-1)?.type).toBe("done");
  });

  test("the transcript keeps both chips", async () => {
    const { client } = await run("E2E_MEDIA_SHARE");
    const history = await client.history(BOX, "default", { session: SESSION });
    const reply = history.at(-1)!;
    expect(reply.blocks.filter((b) => b.kind === "attachment").map((b) => b.name)).toEqual([
      "q3-revenue.png",
      "q3-revenue.csv",
    ]);
  });
});

describe("E2E_MEDIA_KINDS", () => {
  test("audio, video and a text file are chips; the laptop path stays prose", async () => {
    const { files, frames, blocks, text } = await run("E2E_MEDIA_KINDS today's files");
    for (const frame of frames) expect(ChatFrameSchema.safeParse(frame).success).toBe(true);
    const chips = blocks.filter((b) => b.kind === "attachment");
    // Spaced names, read whole from bare, backticked and quoted lines alike.
    expect(chips.map((c) => [c.name, c.mime])).toEqual([
      ["standup recap.wav", "audio/wav"],
      ["build preview.webm", "video/webm"],
      ["release notes.md", "text/markdown"],
    ]);
    const listed = await files.list(AGENT, {});
    for (const chip of chips) {
      const entry = listed.outbox.find((e) => e.id === chip.file_id)!;
      expect(chip.sha256).toBe(entry.sha256);
      expect(chip.bytes).toBe(entry.bytes);
    }
    expect(text).toBe(
      `Here are today's files.\n${MEDIA_TAG}${FIXTURE_FOREIGN_MEDIA_PATH}\nThat last one is on your laptop, not on this box.\n`,
    );
  });

  test("no delta ever shows a shared line, whole or in part", async () => {
    const { frames } = await run("E2E_MEDIA_KINDS");
    const deltas = frames.flatMap((f) => (f.type === "delta" ? [f.text] : []));
    // Small enough pieces that every path was split across deltas.
    expect(FIXTURE_MEDIA_KINDS_DELTA).toBeLessThan("standup recap.wav".length);
    for (const delta of deltas) {
      for (const part of ["/data/hermes", "recap", "preview", "notes", "outbox", "`", '"', "**"])
        expect(delta.includes(part)).toBe(false);
    }
  });
});

describe("without a files service", () => {
  test("E2E_MEDIA_SHARE is an ordinary turn", async () => {
    const client = fixtureChatClient({});
    const frames: ChatFrame[] = [];
    for await (const frame of client.send(BOX, "default", "E2E_MEDIA_SHARE", { session: SESSION }))
      frames.push(frame);
    expect(frames.some((f) => f.type === "block" && f.block.kind === "attachment")).toBe(false);
  });
});
