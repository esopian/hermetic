/**
 * `chat/compact-turn.ts`: which composer lines compact, and the frames a
 * compaction turn sends. The desktop's `chat-send.ts` and the phone's
 * transport both run through it.
 */
import { describe, expect, test } from "bun:test";
import { compactNotice, compactionFor, compactionFrames } from "../src/chat/compact-turn.ts";
import type { ChatFrame } from "../src/schema/index.ts";

async function collect(frames: AsyncIterable<ChatFrame>): Promise<ChatFrame[]> {
  const out: ChatFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

describe("compactionFor", () => {
  test("/compact and /compress compact any session, with the argument as focus", () => {
    expect(compactionFor("/compact", "thread")).toEqual({});
    expect(compactionFor("/compress", "canonical")).toEqual({});
    expect(compactionFor("/compact the auth refactor", "thread")).toEqual({
      focus_topic: "the auth refactor",
    });
  });
  test("/new and /reset compact only Bot Chat", () => {
    expect(compactionFor("/new", "canonical")).toEqual({});
    expect(compactionFor("/reset side quest", "canonical")).toEqual({});
    expect(compactionFor("/new", "thread")).toBeNull();
    expect(compactionFor("/help", "canonical")).toBeNull();
    expect(compactionFor("compact please", "canonical")).toBeNull();
  });
});

describe("compactNotice", () => {
  test("a compute host still compressing is said plainly", () => {
    expect(compactNotice("/compact", { compressed: false, status: "pending" })).toContain(
      "still running on the box",
    );
    expect(compactNotice("/compact", { compressed: false, status: "blocked" })).toBe(
      "Compaction: blocked",
    );
  });
});

describe("compactionFrames", () => {
  test("status, the answer as a command block, then done", async () => {
    const frames = await collect(
      compactionFrames("/compact", async () => ({ compressed: true, status: "compressed" })),
    );
    expect(frames.map((f) => (f.type === "block" ? f.block.kind : f.type))).toEqual([
      "activity",
      "command",
      "done",
    ]);
    expect(frames.map((f) => ("seq" in f ? f.seq : null))).toEqual([0, 1, 2]);
    expect(frames[1]).toMatchObject({
      block: { command: "/compact", output: "✓ Context compression complete", state: "done" },
    });
  });

  test("a long compaction repeats its status, so a head's no-frame timer never fires", async () => {
    const frames = await collect(
      compactionFrames(
        "/compact",
        () => new Promise((resolve) => setTimeout(() => resolve({ compressed: true }), 55)),
        undefined,
        10,
      ),
    );
    const statuses = frames.filter((f) => f.type === "block" && f.block.kind === "activity");
    expect(statuses.length).toBeGreaterThan(2);
    expect(frames.at(-1)?.type).toBe("done");
  });

  test("a failed compaction throws for the caller's error frame", async () => {
    const run = collect(
      compactionFrames("/compact", async () => {
        throw new Error("summary call failed");
      }),
    );
    await expect(run).rejects.toThrow("summary call failed");
  });

  test("Stop ends the wait at once", async () => {
    const controller = new AbortController();
    const frames = compactionFrames("/compact", () => new Promise(() => {}), controller.signal);
    expect((await frames.next()).value).toMatchObject({ block: { kind: "activity" } });
    const next = frames.next();
    controller.abort();
    await expect(next).rejects.toThrow();
  });
});
