/**
 * Fixture chat with attachments: a staged file is committed by the turn, the
 * reply names it, the transcript shows it as a chip, and the canned
 * transcripts' chips load real bytes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHermetic } from "../src/index.ts";
import type { Hermetic } from "../src/hermetic.ts";
import { FIXTURE_CHAT_FILES, attachmentReply } from "../src/backend/fixture/fixture-chat-files.ts";
import { FIXTURE_CHAT_TRANSCRIPTS } from "../src/backend/fixture/fixture-chat-catalog.ts";
import { ChatSendInput, type ChatFrame } from "../src/schema/index.ts";

const INSTANCE = "atlas";
const BOT = "default";
const dir = mkdtempSync(join(tmpdir(), "hermetic-fixture-chat-files-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function fixtureHermetic(): Promise<{ hermetic: Hermetic; session: string }> {
  const hermetic = await openHermetic({ fixture: true, home: mkdtempSync(join(dir, "home-")) });
  await hermetic.chat.listen({ instance: INSTANCE, listening: true });
  const conversation = await hermetic.chat.open({ instance: INSTANCE, bot: BOT });
  return { hermetic, session: conversation.session };
}

async function stage(hermetic: Hermetic, name: string, text: string): Promise<string> {
  const path = join(dir, name);
  writeFileSync(path, text);
  for await (const e of hermetic.files.stage({ instance: INSTANCE, source: { path } })) {
    if (e.type === "staged") return e.file.id;
  }
  throw new Error("the stage ended without an id");
}

async function turn(hermetic: Hermetic, input: Record<string, unknown>): Promise<ChatFrame[]> {
  const frames: ChatFrame[] = [];
  for await (const frame of hermetic.chat.send({ instance: INSTANCE, bot: BOT, ...input }))
    frames.push(frame);
  return frames;
}

function said(frames: readonly ChatFrame[]): string {
  return frames.map((f) => (f.type === "delta" ? f.text : "")).join("");
}

describe("fixture chat · attachments", () => {
  test("a staged file is committed by the turn, acknowledged, and shown as a chip", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const id = await stage(hermetic, "queue-notes.txt", "queue depth notes, FIXTURE\n");
    const frames = await turn(hermetic, { message: "read this", attachments: [{ file_id: id }] });
    expect(frames.at(-1)?.type).toBe("done");
    expect(said(frames)).toBe("I have the 1 attached file: queue-notes.txt. Reading them now.");

    const history = await hermetic.chat.history({ instance: INSTANCE, bot: BOT, session });
    const mine = history.messages.findLast((m) => m.role === "user");
    expect(mine?.blocks[0]).toEqual({ kind: "text", markdown: "read this" });
    const chip = mine?.blocks[1];
    if (chip?.kind !== "attachment") throw new Error("expected an attachment chip");
    expect(chip).toMatchObject({ name: "queue-notes.txt", mime: "text/plain", file_id: id });
    expect(chip.href).toMatch(new RegExp(`^inbox/\\d{4}-\\d{2}-\\d{2}/${id}/queue-notes\\.txt$`));
  });

  test("a retry with the same id commits again without complaint", async () => {
    const { hermetic } = await fixtureHermetic();
    const id = await stage(hermetic, "twice.txt", "FIXTURE\n");
    await turn(hermetic, { message: "one", attachments: [{ file_id: id }] });
    const again = await turn(hermetic, { message: "", attachments: [{ file_id: id }] });
    expect(again.at(-1)?.type).toBe("done");
  });

  test("an id the box does not have ends the turn with the box's refusal", async () => {
    const { hermetic } = await fixtureHermetic();
    const frames = await turn(hermetic, {
      message: "look",
      attachments: [{ file_id: "f_zzzzzzzzzzzz" }],
    });
    const last = frames.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") expect(last.code).toBe("FILE_NOT_FOUND");
  });

  test("the canned transcripts' chips load real bytes by file_id", async () => {
    const { hermetic } = await fixtureHermetic();
    const chips = Object.values(FIXTURE_CHAT_TRANSCRIPTS)
      .flat()
      .flatMap((m) => m.blocks)
      .filter((b) => b.kind === "attachment");
    expect(chips.map((c) => c.kind === "attachment" && c.file_id).sort()).toEqual(
      [FIXTURE_CHAT_FILES.iostat.id, FIXTURE_CHAT_FILES.queueDepth.id].sort(),
    );
    for (const chip of chips) {
      if (chip.kind !== "attachment" || !chip.file_id) continue;
      const content = await hermetic.files.internal.content(INSTANCE, chip.file_id, 1024 * 1024);
      expect(content.mime).toBe(chip.mime);
      expect(content.bytes.byteLength).toBe(chip.bytes);
      expect(content.sha256).toBe(chip.sha256 ?? "");
    }
    const png = await hermetic.files.internal.content(
      INSTANCE,
      FIXTURE_CHAT_FILES.queueDepth.id,
      1024 * 1024,
    );
    expect([...png.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test("the reply counts the files", () => {
    const two = [{ name: "a.png" }, { name: "b.pdf" }] as unknown as Parameters<
      typeof attachmentReply
    >[0];
    expect(attachmentReply(two)).toBe("I have the 2 attached files: a.png, b.pdf. Reading them now.");
  });
});

describe("ChatSendInput", () => {
  const base = { instance: INSTANCE, bot: BOT };
  test("an empty message needs an attachment", () => {
    expect(ChatSendInput.safeParse({ ...base, message: "" }).success).toBe(false);
    expect(
      ChatSendInput.safeParse({ ...base, message: "", attachments: [{ file_id: "f_aaaaaaaaaaaa" }] })
        .success,
    ).toBe(true);
  });

  test("an id attached twice, or eleven files, is refused", () => {
    const twice = [{ file_id: "f_aaaaaaaaaaaa" }, { file_id: "f_aaaaaaaaaaaa" }];
    expect(ChatSendInput.safeParse({ ...base, message: "x", attachments: twice }).success).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      file_id: `f_${String(i).padStart(12, "0")}`,
    }));
    expect(ChatSendInput.safeParse({ ...base, message: "x", attachments: eleven }).success).toBe(false);
  });
});
