/**
 * What the fixture's Bot Mode wrapper stores for a turn (`fixture-bot-mode.ts`,
 * `fixture-chat-fold.ts`): an ordinary turn is one flat text block, and a turn
 * with a delegation keeps its tool call with the settled subagent rows a box's
 * history rebuilds from the call's result.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHermetic } from "../src/index.ts";
import type { Hermetic } from "../src/hermetic.ts";
import { createFixtureChatStack } from "../src/backend/fixture/fixture-chat-stack.ts";

const INSTANCE = "atlas";
const BOT = "default";

async function fixtureHermetic(): Promise<Hermetic> {
  const home = mkdtempSync(join(tmpdir(), "hermetic-fixture-history-"));
  const hermetic = await openHermetic({ fixture: true, home });
  await hermetic.chat.listen({ instance: INSTANCE, listening: true });
  await hermetic.chat.open({ instance: INSTANCE, bot: BOT });
  return hermetic;
}

async function send(hermetic: Hermetic, message: string) {
  for await (const _frame of hermetic.chat.send({ instance: INSTANCE, bot: BOT, message })) {
    // drained
  }
  const read = await hermetic.chat.history({ instance: INSTANCE, bot: BOT });
  return read.messages.findLast((m) => m.role === "bot");
}

describe("a turn's stored row", () => {
  test("an ordinary turn is one flat text block", async () => {
    const row = await send(await fixtureHermetic(), "hi");
    expect(row?.blocks.map((b) => b.kind)).toEqual(["text"]);
  });

  test("a delegating turn keeps its tool call and the settled subagent rows", async () => {
    const row = await send(await fixtureHermetic(), "please E2E_SUBAGENT");
    const kinds = row?.blocks.map((b) => b.kind) ?? [];
    expect(kinds).toContain("tool");
    const tool = row?.blocks.find((b) => b.kind === "tool" && b.name === "delegate_task");
    expect(tool).toBeDefined();
    const children = row?.blocks.filter((b) => b.kind === "subagent") ?? [];
    expect(children.length).toBeGreaterThan(0);
    // Rebuilt from the result envelope, not the live rows.
    for (const child of children) expect(child).toMatchObject({ origin: "history" });
  });

  test("a background delegation's results turn lands in the conversation the wrapper resolved", async () => {
    // The client directly, with no `session` named (`chat.send` always names one).
    // Archiving the canonical conversation makes the wrapper open a new one
    // (`fx-botchat-N`) while the base client still knows only the old, so the
    // results must be filed under the wrapper's, not the base's idea of it.
    const hermes = createFixtureChatStack(true).hermes;
    if (!hermes?.archive || !hermes.conversation) throw new Error("the fixture stack has no Bot Mode");
    const box = { instance: INSTANCE, baseUrl: "https://fixture.invalid" };
    const first = await hermes.conversation(box, BOT, { create: true });
    if (!first) throw new Error("no canonical conversation");
    await hermes.archive(box, BOT, first.session);
    for await (const _frame of hermes.send(box, BOT, "please E2E_SUBAGENT_BACKGROUND")) {
      // drained
    }
    const second = await hermes.conversation(box, BOT, {});
    expect(second?.session).not.toBe(first.session);
    const deadline = Date.now() + 2000;
    let landed = false;
    while (!landed && Date.now() < deadline) {
      const read = await hermes.history(box, BOT);
      landed = read.some((m) => m.id.startsWith("mx-fixture-delegation-"));
      if (!landed) await new Promise((done) => setTimeout(done, 10));
    }
    expect(landed).toBe(true);
  });
});
