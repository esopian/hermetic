/**
 * The fixture's approval loop (`fixture-chat-approval.ts`): a trigger phrase in
 * the prompt parks the turn on an `approval` card, `chat.respond kind:"approval"`
 * settles it, and the same stream carries on to `done`.
 *
 * Like the clarify tests, every case goes through `chat.send` and `chat.respond`
 * on a real fixture `Hermetic`, because the seam under test is the one between
 * the turn generator and `respond`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHermetic } from "../src/index.ts";
import type { Hermetic } from "../src/hermetic.ts";
import { ChatBlock, type ApprovalChoice, type ChatFrame } from "../src/schema/index.ts";

const INSTANCE = "atlas";
const BOT = "default";

async function fixtureHermetic(): Promise<{ hermetic: Hermetic; session: string }> {
  const home = mkdtempSync(join(tmpdir(), "hermetic-fixture-approval-"));
  const hermetic = await openHermetic({ fixture: true, home });
  await hermetic.chat.listen({ instance: INSTANCE, listening: true });
  const conversation = await hermetic.chat.open({ instance: INSTANCE, bot: BOT });
  return { hermetic, session: conversation.session };
}

const tick = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function stillPending(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await tick(25);
  return !settled;
}

type ApprovalCard = Extract<ChatBlock, { kind: "approval" }>;

/** A turn read up to its approval card, with the next read already in flight. */
async function untilApproval(hermetic: Hermetic, message: string) {
  const it = hermetic.chat.send({ instance: INSTANCE, bot: BOT, message })[Symbol.asyncIterator]();
  const frames: ChatFrame[] = [];
  for (;;) {
    const read = await it.next();
    if (read.done) throw new Error("the turn ended before asking anything");
    frames.push(read.value);
    const frame = read.value;
    if (frame.type === "block" && frame.block.kind === "approval")
      return { it, frames, card: frame.block as ApprovalCard, next: it.next() };
  }
}
type Turn = Awaited<ReturnType<typeof untilApproval>>;

async function drain(turn: Turn): Promise<ChatFrame[]> {
  let read = await turn.next;
  while (!read.done) {
    turn.frames.push(read.value);
    read = await turn.it.next();
  }
  return turn.frames;
}

function lastText(frames: readonly ChatFrame[]): string {
  const opened = frames.findLastIndex((f) => f.type === "block" && f.block.kind === "text");
  return frames
    .slice(opened + 1)
    .flatMap((f) => (f.type === "delta" ? [f.text] : []))
    .join("");
}

const answer = (hermetic: Hermetic, session: string, turn: Turn, choice: ApprovalChoice) =>
  hermetic.chat.respond({
    instance: INSTANCE,
    bot: BOT,
    session,
    kind: "approval",
    request_id: String(turn.card.request_id),
    choice,
  });

const toolOf = (frames: readonly ChatFrame[]) =>
  frames.flatMap((f) =>
    f.type === "block" && f.block.kind === "tool" && f.block.status !== "running" ? [f.block] : [],
  );

describe("which choices an approval offers", () => {
  const cases: [string, ApprovalChoice[], Record<string, unknown>][] = [
    ["E2E_APPROVAL", ["once", "session", "always", "deny"], {}],
    ["E2E_APPROVAL_SMART", ["once", "deny"], { smart_denied: true }],
    ["E2E_APPROVAL_NOSESSION", ["once", "deny"], {}],
    ["E2E_APPROVAL_TIMEOUT", ["once", "session", "always", "deny"], {}],
  ];
  for (const [trigger, choices, extra] of cases) {
    test(`${trigger} offers ${choices.join(" / ")}`, async () => {
      const { hermetic, session } = await fixtureHermetic();
      const turn = await untilApproval(hermetic, `please ${trigger} now`);
      expect(ChatBlock.safeParse(turn.card).success).toBe(true);
      expect(turn.card.choices).toEqual(choices);
      expect(turn.card.request_id).toMatch(/^srq-fixture-\d+$/);
      expect(turn.card.pattern).toBe("recursive delete");
      expect(turn.card.summary).toContain("rm -rf");
      expect(turn.card.tool).toBe("terminal");
      for (const [key, value] of Object.entries(extra))
        expect(turn.card[key as keyof ApprovalCard]).toBe(value);
      const frames = turn.frames
        .filter((f) => f.type === "block")
        .map((f) => (f as { block: ChatBlock }).block.kind);
      expect(frames).toEqual(["reasoning", "tool", "approval"]);
      // Release the turn so nothing is left parked.
      await answer(hermetic, session, turn, "deny");
    });
  }

  test("the payload is the gateway's: choices filled in, `allow_session: false` carried", async () => {
    const { hermetic } = await fixtureHermetic();
    const turn = await untilApproval(hermetic, "E2E_APPROVAL_NOSESSION");
    expect(turn.card.payload).toMatchObject({
      command: "rm -rf /var/cache/fixture-build",
      allow_session: false,
      choices: ["once", "deny"],
    });
  });
});

describe("an approval parks the turn and settles once", () => {
  test("`once` runs the command and the turn continues", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilApproval(hermetic, "E2E_APPROVAL");
    expect(await stillPending(turn.next)).toBe(true);

    expect(await answer(hermetic, session, turn, "once")).toEqual({ status: "ok" });
    const frames = await drain(turn);
    expect(frames.at(-1)?.type).toBe("done");
    expect(lastText(frames)).toBe("Approved once: ran `rm -rf /var/cache/fixture-build`.");
    expect(toolOf(frames).map((t) => [t.name, t.status, t.exit_code])).toEqual([["terminal", "ok", 0]]);

    // Settled; a second answer finds nothing waiting.
    expect(await answer(hermetic, session, turn, "deny")).toEqual({ status: "expired" });
  });

  test("`deny` does not run it", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilApproval(hermetic, "E2E_APPROVAL");
    expect(await answer(hermetic, session, turn, "deny")).toEqual({ status: "ok" });
    const frames = await drain(turn);
    expect(lastText(frames)).toBe("Denied: did not run `rm -rf /var/cache/fixture-build`.");
    expect(toolOf(frames).map((t) => t.status)).toEqual(["bad"]);
  });

  test("`session` and `always` say what they granted", async () => {
    for (const [choice, said] of [
      ["session", "Allowed this session"],
      ["always", "Always allowed"],
    ] as const) {
      const { hermetic, session } = await fixtureHermetic();
      const turn = await untilApproval(hermetic, "E2E_APPROVAL");
      await answer(hermetic, session, turn, choice);
      expect(lastText(await drain(turn))).toStartWith(`${said}: ran`);
    }
  });

  test("the stored turn keeps the tool and drops the parked card", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilApproval(hermetic, "E2E_APPROVAL");
    await answer(hermetic, session, turn, "once");
    await drain(turn);
    const read = await hermetic.chat.history({ instance: INSTANCE, bot: BOT });
    const stored = read.messages.findLast((m) => m.blocks.some((b) => b.kind === "tool"));
    expect(stored?.blocks.some((b) => b.kind === "approval")).toBe(false);
    expect(stored?.blocks.some((b) => b.kind === "tool" && b.status === "ok")).toBe(true);
  });

  test("an abort while parked ends the stream, and the request with it", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const controller = new AbortController();
    const it = hermetic.chat
      .send({ instance: INSTANCE, bot: BOT, message: "E2E_APPROVAL" }, { signal: controller.signal })
      [Symbol.asyncIterator]();
    let card: ApprovalCard | null = null;
    while (card === null) {
      const read = await it.next();
      if (read.done) throw new Error("the turn ended before asking anything");
      if (read.value.type === "block" && read.value.block.kind === "approval")
        card = read.value.block as ApprovalCard;
    }
    controller.abort();
    const rest: ChatFrame[] = [];
    for (let read = await it.next(); !read.done; read = await it.next()) rest.push(read.value);
    expect(rest.some((f) => f.type === "done")).toBe(false);
    const late = await hermetic.chat.respond({
      instance: INSTANCE,
      bot: BOT,
      session,
      kind: "approval",
      request_id: String(card.request_id),
      choice: "once",
    });
    expect(late).toEqual({ status: "expired" });
  });
});

describe("what the stored turn keeps", () => {
  const stored = async (hermetic: Hermetic) => {
    const read = await hermetic.chat.history({ instance: INSTANCE, bot: BOT });
    return read.messages.findLast((m) => m.blocks.some((b) => b.kind === "tool"))?.blocks ?? [];
  };

  test("a denied command is stored as a failed tool, and no parked card", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilApproval(hermetic, "E2E_APPROVAL");
    await answer(hermetic, session, turn, "deny");
    await drain(turn);
    const blocks = await stored(hermetic);
    expect(blocks.flatMap((b) => (b.kind === "tool" ? [b.status] : []))).toEqual(["bad"]);
    expect(blocks.some((b) => b.kind === "approval")).toBe(false);
  });

  test("a timed-out approval stores no `request:` notice", async () => {
    const { hermetic } = await fixtureHermetic();
    const turn = await untilApproval(hermetic, "E2E_APPROVAL_TIMEOUT");
    const frames = await drain(turn);
    // The live stream had the notice...
    expect(frames.some((f) => f.type === "block" && f.block.kind === "activity")).toBe(true);
    // ...the stored turn does not, nor the parked card; the denied tool stays.
    const blocks = await stored(hermetic);
    expect(blocks.some((b) => b.kind === "activity" || b.kind === "approval")).toBe(false);
    expect(blocks.flatMap((b) => (b.kind === "tool" ? [b.status] : []))).toEqual(["bad"]);
  });
});

describe("the gateway does not check an answer against the offered choices (D27)", () => {
  test("gateway accepts an unoffered approval choice as a grant", async () => {
    const { hermetic, session } = await fixtureHermetic();
    // `smart_denied` offers once / deny only; `always` was never on the card.
    const turn = await untilApproval(hermetic, "E2E_APPROVAL_SMART");
    expect(turn.card.choices).not.toContain("always");

    // Accepted, not refused: `{resolved:N}` upstream, `ok` here.
    expect(await answer(hermetic, session, turn, "always")).toEqual({ status: "ok" });
    const frames = await drain(turn);
    expect(frames.at(-1)?.type).toBe("done");
    // A grant: the command ran. Under `smart_denied` it is one-shot, nothing persisted.
    expect(toolOf(frames).map((t) => t.status)).toEqual(["ok"]);
    expect(lastText(frames)).toBe("Approved once: ran `rm -rf /var/cache/fixture-build`.");
  });

  test("`session` on a no-session card is a grant too", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilApproval(hermetic, "E2E_APPROVAL_NOSESSION");
    expect(turn.card.choices).toEqual(["once", "deny"]);
    expect(await answer(hermetic, session, turn, "session")).toEqual({ status: "ok" });
    expect(toolOf(await drain(turn)).map((t) => t.status)).toEqual(["ok"]);
  });
});

describe("an approval nobody answers", () => {
  test("E2E_APPROVAL_TIMEOUT closes with reason `timeout` and the command is not run", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilApproval(hermetic, "E2E_APPROVAL_TIMEOUT");
    expect(await stillPending(turn.next)).toBe(true);

    const frames = await drain(turn);
    const closed = frames.flatMap((f) =>
      f.type === "block" && f.block.kind === "activity" && f.block.reason ? [f.block] : [],
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      reason: "timeout",
      request_id: turn.card.request_id,
      detail: "Timed out",
    });
    expect(frames.at(-1)?.type).toBe("done");
    expect(lastText(frames)).toBe("Approval timed out: did not run `rm -rf /var/cache/fixture-build`.");
    expect(toolOf(frames).map((t) => t.status)).toEqual(["bad"]);

    expect(await answer(hermetic, session, turn, "once")).toEqual({ status: "expired" });
  });

  test("the other triggers never time out on their own", async () => {
    const { hermetic, session } = await fixtureHermetic();
    const turn = await untilApproval(hermetic, "E2E_APPROVAL");
    await tick(1200);
    expect(await stillPending(turn.next)).toBe(true);
    await answer(hermetic, session, turn, "deny");
    await drain(turn);
  });
});

describe("any other prompt still gets the ordinary turn", () => {
  test("no approval card", async () => {
    const { hermetic } = await fixtureHermetic();
    const frames: ChatFrame[] = [];
    for await (const frame of hermetic.chat.send({ instance: INSTANCE, bot: BOT, message: "hi" }))
      frames.push(frame);
    expect(frames.some((f) => f.type === "block" && f.block.kind === "approval")).toBe(false);
    expect(frames.at(-1)?.type).toBe("done");
  });
});
