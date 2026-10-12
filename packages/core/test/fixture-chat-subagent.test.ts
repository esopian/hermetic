/**
 * The fixture's delegated children (`fixture-chat-subagent.ts`): the three
 * `E2E_SUBAGENT*` triggers, child steer and stop, the observation stream a
 * background delegation keeps reporting on, and the persisted row a history
 * read rebuilds the children from.
 *
 * The base client is driven directly where the assertion is about frame order
 * (a generator advanced by hand is a deterministic clock); the whole fixture
 * `Hermetic` where it is about the seam a head crosses.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureChatActivity, fixtureChatClient } from "../src/backend/fixture/fixture-chat.ts";
import type { BoxAddress } from "../src/chat/hermes/hermes-chat.ts";
import type { ChatObserveHint } from "../src/chat/chat-observe.ts";
import { openHermetic } from "../src/index.ts";
import { ChatBlock, type ChatFrame, type SubagentBlock } from "../src/schema/index.ts";

const INSTANCE = "atlas";
const BOT = "default";
const BOX: BoxAddress = { instance: INSTANCE, baseUrl: "https://atlas.fixture.invalid/" };

const subagentOf = (frame: ChatFrame | undefined): SubagentBlock | null =>
  frame?.type === "block" && frame.block.kind === "subagent" ? frame.block : null;

async function all(stream: AsyncIterable<ChatFrame>): Promise<ChatFrame[]> {
  const out: ChatFrame[] = [];
  for await (const frame of stream) out.push(frame);
  return out;
}

const children = (frames: ChatFrame[]): SubagentBlock[] =>
  frames.flatMap((f) => {
    const block = subagentOf(f);
    return block ? [block] : [];
  });

/** The last block each child reported, by id. */
const finals = (frames: ChatFrame[]): Map<string, SubagentBlock> =>
  new Map(children(frames).map((b) => [b.subagent_id, b]));

describe("E2E_SUBAGENT: one synchronous child", () => {
  test("delegate call, the child's life as whole blocks, the result envelope, then the parent's text", async () => {
    const client = fixtureChatClient();
    const frames = await all(client.send(BOX, BOT, "survey the disks E2E_SUBAGENT"));
    const blocks = children(frames);
    for (const block of blocks) expect(ChatBlock.parse(block)).toBeTruthy();
    expect(new Set(blocks.map((b) => b.subagent_id)).size).toBe(1);
    expect(blocks.map((b) => b.status)).toEqual([
      "queued",
      "running",
      "running",
      "running",
      "running",
      "running",
      "running",
      "completed",
    ]);
    const last = blocks.at(-1);
    expect(last).toMatchObject({
      verdict: "done",
      tool_count: 3,
      usage: { input_tokens: 18_420, output_tokens: 1_210, api_calls: 4 },
      progress: expect.stringContaining("nvme1n1"),
      thinking: expect.any(String),
      duration_ms: 14_200,
    });
    expect(last?.tools.map((t) => t.name)).toEqual(["terminal", "terminal", "read_file"]);
    const tools = frames.flatMap((f) =>
      f.type === "block" && f.block.kind === "tool" ? [f.block] : [],
    );
    expect(tools.map((t) => [t.name, t.status])).toEqual([
      ["delegate_task", "running"],
      ["delegate_task", "ok"],
    ]);
    expect(blocks.every((b) => b.tool_id === tools[0]?.tool_id)).toBe(true);
    expect(JSON.parse(String(tools[1]?.result))).toMatchObject({
      results: [{ task_index: 0, status: "completed", tokens: { input: 18_420 } }],
    });
    // The parent speaks after its child finished.
    const lastChild = frames.findLastIndex((f) => subagentOf(f) !== null);
    expect(frames.findIndex((f, i) => i > lastChild && f.type === "delta")).toBeGreaterThan(lastChild);
    expect(frames.at(-1)).toMatchObject({ type: "done" });
  });

  test("history keeps the call and rebuilds the child from its envelope, not the live blocks", async () => {
    const client = fixtureChatClient();
    await all(client.send(BOX, BOT, "E2E_SUBAGENT"));
    const history = await client.history(BOX, BOT);
    const row = history.at(-1);
    const kinds = row?.blocks.map((b) => b.kind) ?? [];
    expect(kinds.filter((k) => k === "subagent")).toHaveLength(1);
    const settled = row?.blocks.find((b) => b.kind === "subagent");
    expect(settled).toMatchObject({
      origin: "history",
      status: "completed",
      verdict: "done",
      tool_count: 3,
    });
  });

  test("a steer echoes into the child's next tool preview; a finished child rejects one", async () => {
    const client = fixtureChatClient();
    const it = client.send(BOX, BOT, "E2E_SUBAGENT")[Symbol.asyncIterator]();
    const seen: ChatFrame[] = [];
    let id = "";
    for (;;) {
      const next = await it.next();
      if (next.done) break;
      seen.push(next.value);
      const block = subagentOf(next.value);
      if (block && block.tools.length === 1 && !id) {
        id = block.subagent_id;
        expect(await client.subagentSteer?.(BOX, BOT, id, "check iotop too")).toBe("queued");
      }
    }
    const withSecond = children(seen).find((b) => b.tools.length === 2);
    expect(withSecond?.tools[1]?.preview).toContain("steer: check iotop too");
    expect(finals(seen).get(id)?.summary).not.toContain("[steer did not land");
    expect(await client.subagentSteer?.(BOX, BOT, id, "too late")).toBe("rejected");
  });

  test("a steer after the child's last tool misses, and the summary says so", async () => {
    const client = fixtureChatClient();
    const it = client.send(BOX, BOT, "E2E_SUBAGENT")[Symbol.asyncIterator]();
    const seen: ChatFrame[] = [];
    let steered = false;
    for (;;) {
      const next = await it.next();
      if (next.done) break;
      seen.push(next.value);
      const block = subagentOf(next.value);
      if (block && block.tools.length === 3 && block.status === "running" && !steered) {
        steered = true;
        expect(await client.subagentSteer?.(BOX, BOT, block.subagent_id, "and the swap")).toBe(
          "queued",
        );
      }
    }
    const last = children(seen).at(-1);
    expect(last?.status).toBe("completed");
    expect(last?.summary).toContain(
      "[steer did not land — the subagent finished before it could be delivered: and the swap]",
    );
  });

  test("a stop ends the child interrupted, found once; the parent turn carries on", async () => {
    const client = fixtureChatClient();
    const it = client.send(BOX, BOT, "E2E_SUBAGENT")[Symbol.asyncIterator]();
    const seen: ChatFrame[] = [];
    let stopped = false;
    for (;;) {
      const next = await it.next();
      if (next.done) break;
      seen.push(next.value);
      const block = subagentOf(next.value);
      if (block?.tools.length === 1 && block.status === "running" && !stopped) {
        stopped = true;
        expect(await client.subagentInterrupt?.(BOX, BOT, block.subagent_id)).toBe(true);
        expect(await client.subagentInterrupt?.(BOX, BOT, block.subagent_id)).toBe(false);
      }
    }
    const last = children(seen).at(-1);
    expect(last).toMatchObject({ status: "interrupted", verdict: "stopped", tool_count: 1 });
    expect(seen.at(-1)).toMatchObject({ type: "done" });
    expect(await client.subagentInterrupt?.(BOX, BOT, "sa-nobody")).toBe(false);
  });
});

describe("aborting a delegating turn", () => {
  test("stops the script and its waits, and leaves no child steerable", async () => {
    let sleeps = 0;
    const client = fixtureChatClient({
      delayMs: 1,
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
    });
    const controller = new AbortController();
    const it = client
      .send(BOX, BOT, "E2E_SUBAGENT", { signal: controller.signal })
      [Symbol.asyncIterator]();
    let id = "";
    let atAbort = -1;
    for (;;) {
      const next = await it.next();
      if (next.done) break;
      const block = subagentOf(next.value);
      if (block && block.status === "running" && atAbort < 0) {
        id = block.subagent_id;
        controller.abort();
        atAbort = sleeps;
      }
    }
    expect(id).not.toBe("");
    // Not one more paced step or frame after the abort.
    expect(sleeps).toBe(atAbort);
    expect(await client.subagentSteer?.(BOX, BOT, id, "too late")).toBe("rejected");
    expect(await client.subagentInterrupt?.(BOX, BOT, id)).toBe(false);
  });
});

describe("E2E_SUBAGENT_PARALLEL: three children", () => {
  test("one finishes early, one times out, one finishes last", async () => {
    const frames = await all(fixtureChatClient().send(BOX, BOT, "E2E_SUBAGENT_PARALLEL"));
    const blocks = children(frames);
    const ends = blocks.filter((b) => b.verdict !== "running");
    expect(ends.map((b) => [b.task_index, b.status, b.verdict])).toEqual([
      [1, "completed", "done"],
      [2, "timeout", "failed"],
      [0, "completed", "done"],
    ]);
    expect(blocks.every((b) => b.task_count === 3)).toBe(true);
    const tool = frames.findLast((f) => f.type === "block" && f.block.kind === "tool");
    const result =
      tool?.type === "block" && tool.block.kind === "tool"
        ? JSON.parse(String(tool.block.result))
        : null;
    expect(result.results.map((r: { status: string }) => r.status)).toEqual([
      "completed",
      "completed",
      "timeout",
    ]);
  });
});

describe("E2E_SUBAGENT_BACKGROUND: the turn ends, the children do not", () => {
  test("dispatched in the turn, progress on the observation stream, then a results turn", async () => {
    const activity = createFixtureChatActivity();
    const client = fixtureChatClient({ activity });
    const controller = new AbortController();
    const stream = client.observe?.(BOX, BOT, { signal: controller.signal });
    if (!stream) throw new Error("the fixture observes");
    const hints = stream[Symbol.asyncIterator]();
    const first = hints.next();

    const frames = await all(client.send(BOX, BOT, "E2E_SUBAGENT_BACKGROUND"));
    const tool = frames.findLast((f) => f.type === "block" && f.block.kind === "tool");
    const handle =
      tool?.type === "block" && tool.block.kind === "tool"
        ? JSON.parse(String(tool.block.result))
        : null;
    expect(handle).toMatchObject({
      status: "dispatched",
      goals: [expect.any(String), expect.any(String)],
    });
    expect(frames.at(-1)).toMatchObject({ type: "done" });
    // Spawned and started in the turn; nothing finished there.
    expect(children(frames).every((b) => b.verdict === "running")).toBe(true);

    const got: ChatObserveHint[] = [];
    let pending = first;
    for (;;) {
      const next = await pending;
      if (next.done) break;
      got.push(next.value);
      if (!next.value.subagent) break; // the results turn's plain hint
      pending = hints.next();
    }
    controller.abort();
    await hints.return?.();
    const updates = got.flatMap((h) => (h.subagent ? [h.subagent] : []));
    expect(updates.some((b) => b.progress)).toBe(true);
    expect(
      updates
        .filter((b) => b.status === "completed")
        .map((b) => b.task_index)
        .sort(),
    ).toEqual([0, 1]);
    expect(got.at(-1)?.subagent).toBeUndefined();

    const history = await client.history(BOX, BOT);
    const results = history.at(-1);
    expect(results?.role).toBe("bot");
    expect(results?.blocks[0]).toMatchObject({
      kind: "text",
      markdown: expect.stringContaining("background"),
    });
    const turnRow = history.find((m) =>
      m.blocks.some((b) => b.kind === "tool" && b.name === "delegate_task"),
    );
    expect(
      turnRow?.blocks
        .filter((b) => b.kind === "subagent")
        .map((b) => b.kind === "subagent" && b.status),
    ).toEqual(["dispatched", "dispatched"]);
  });
});

describe("through the fixture Hermetic", () => {
  test("chat.steer and chat.abort with subagent_id reach the child, and a gone one is an outcome", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermetic-fixture-subagent-"));
    const hermetic = await openHermetic({ fixture: true, home });
    await hermetic.chat.listen({ instance: INSTANCE, listening: true });
    const it = hermetic.chat
      .send({ instance: INSTANCE, bot: BOT, message: "E2E_SUBAGENT" })
      [Symbol.asyncIterator]();
    const seen: ChatFrame[] = [];
    for (;;) {
      const next = await it.next();
      if (next.done) break;
      seen.push(next.value);
      const block = subagentOf(next.value);
      if (block?.tools.length === 1 && block.status === "running") {
        const steer = await hermetic.chat.steer({
          instance: INSTANCE,
          bot: BOT,
          text: "check iotop",
          subagent_id: block.subagent_id,
        });
        expect(steer).toEqual({ instance: INSTANCE, bot: BOT, status: "queued" });
      }
      if (block?.tools.length === 2 && block.status === "running") {
        const stop = await hermetic.chat.abort({
          instance: INSTANCE,
          bot: BOT,
          subagent_id: block.subagent_id,
        });
        expect(stop).toEqual({ instance: INSTANCE, bot: BOT, aborted: true });
      }
    }
    const last = children(seen).at(-1);
    expect(last?.tools[1]?.preview).toContain("steer: check iotop");
    expect(last).toMatchObject({ status: "interrupted", verdict: "stopped" });
    expect(
      await hermetic.chat.abort({ instance: INSTANCE, bot: BOT, subagent_id: last?.subagent_id ?? "" }),
    ).toEqual({ instance: INSTANCE, bot: BOT, aborted: false });
    expect(
      (await hermetic.chat.steer({ instance: INSTANCE, bot: BOT, text: "x", subagent_id: "sa-gone" }))
        .status,
    ).toBe("rejected");
  });
});

describe("background delegation stays in its conversation", () => {
  test("a send naming no session delivers its children and results to the canonical one only", async () => {
    const activity = createFixtureChatActivity();
    const client = fixtureChatClient({ activity });
    const watch = (session?: string) => {
      const controller = new AbortController();
      const stream = client.observe?.(BOX, BOT, {
        signal: controller.signal,
        ...(session ? { session } : {}),
      });
      if (!stream) throw new Error("the fixture observes");
      const it = stream[Symbol.asyncIterator]();
      const got: ChatObserveHint[] = [];
      const first = it.next();
      /** Hints until the results turn's plain one. */
      const until = async () => {
        let pending = first;
        for (;;) {
          const next = await pending;
          if (next.done) break;
          got.push(next.value);
          if (!next.value.subagent) break;
          pending = it.next();
        }
        controller.abort();
        await it.return?.();
        return got;
      };
      return until;
    };
    const canonical = watch();
    const unrelated = watch("unrelated-session");
    await all(client.send(BOX, BOT, "E2E_SUBAGENT_BACKGROUND"));
    expect((await canonical()).some((h) => h.subagent)).toBe(true);
    expect((await unrelated()).some((h) => h.subagent)).toBe(false);
    expect(activity.extras({ instance: INSTANCE, bot: BOT }, "unrelated-session")).toEqual([]);
    expect((await client.history(BOX, BOT)).at(-1)?.role).toBe("bot");
  });
});
