/**
 * `files.put` and `files.decline` across the desktop bridge, against a request
 * slot the fixture backend opened.
 *
 * A seam test, here because it needs both sides: the fixture's request slots
 * live in core's `MemoryBackend`, which no head can reach (`openHermetic`
 * never hands one out), and the requests go through the app's real `dispatch`
 * and `createRpcBinding`. What it pins: a drop answers a request by upload id;
 * the frames ride `files.put.frame` and end on `fulfilled`; the operator's
 * "Treat as" reaches the box; and neither a file's name nor a secret's value
 * reaches the app log.
 */
import { describe, expect, test } from "bun:test";
import { fleetTargetOf, type FilesPutFrame, type Hermetic } from "@hermetic/core";
import {
  FIXTURE_CONFIG,
  MemoryBackend,
  seedFixtureFleet,
} from "../packages/core/src/backend/memory.ts";
import { testHermetic } from "../packages/core/test/helpers.ts";
import { createChatOwner } from "../packages/app/src/chat-owner.ts";
import type { HandlerContext } from "../packages/app/src/handlers/ctx.ts";
import { dispatch } from "../packages/app/src/handlers/dispatch.ts";
import { createStreamRegistry, type StreamFrame } from "../packages/app/src/handlers/streams.ts";
import { memoryLog } from "../packages/app/src/log.ts";
import { OpRegistry } from "../packages/app/src/ops.ts";
import { createRpcBinding, type RpcOptions } from "../packages/app/src/rpc/bind.ts";
import { AppState, fixedInstance } from "../packages/app/src/state.ts";

const AGENT = "atlas";
const VALUE = "FIXTUREbridgeSecretValue0001";

function harness() {
  const backend = seedFixtureFleet(new MemoryBackend());
  const hermetic: Hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
  const target = hermetic.target === null ? null : fleetTargetOf(hermetic.target);
  const log = memoryLog();
  const state = new AppState({
    fixture: true,
    home: ":memory:",
    reopen: fixedInstance(hermetic),
    hermetic,
    target,
    poller: null,
  });
  const ctx: HandlerContext = {
    state,
    hermetic: () => state.hermetic,
    ops: new OpRegistry(),
    poller: () => null,
    chatOwner: createChatOwner({ hermetic: () => state.hermetic }),
    fixture: true,
    opts: { fixture: true, log },
    log,
    streams: createStreamRegistry(),
  };
  const frames: StreamFrame[] = [];
  const sink = (frame: StreamFrame): void => void frames.push(frame);
  return { backend, ctx, frames, sink, target, log };
}

async function dropped(ctx: HandlerContext, name: string, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const { upload_id } = (await dispatch(ctx, "files.chunk.open", { name, size: bytes.byteLength })) as {
    upload_id: string;
  };
  await dispatch(ctx, "files.chunk.append", {
    upload_id,
    offset: 0,
    data_b64: Buffer.from(bytes).toString("base64"),
  });
  await dispatch(ctx, "files.chunk.close", { upload_id });
  return upload_id;
}

async function until(frames: StreamFrame[], want: (f: StreamFrame) => boolean): Promise<StreamFrame> {
  for (let i = 0; i < 400; i += 1) {
    const hit = frames.find(want);
    if (hit) return hit;
    await Bun.sleep(5);
  }
  throw new Error("the frame never arrived");
}

describe("files.put over the bridge", () => {
  test("a drop answers a file request; the last frame is `fulfilled`", async () => {
    const { backend, ctx, frames, sink, target, log } = harness();
    const slot = backend.files.openRequest(AGENT, { purpose: "FIXTURE log", accept: [".log"] });
    const upload_id = await dropped(ctx, "FIXTURE-private-name.log", "127.0.0.1 GET / 200\n");
    await dispatch(
      ctx,
      "files.put",
      { instance: AGENT, request_id: slot.request_id, source: { chunk_upload_id: upload_id }, target },
      sink,
    );
    const done = await until(frames, (f) => f.event === "done");
    const frame = done.data as FilesPutFrame;
    if (frame.type !== "fulfilled") throw new Error(`expected fulfilled, got ${frame.type}`);
    expect(frame.result.class).toBe("file");
    const box = (await dispatch(ctx, "files.request.get", {
      instance: AGENT,
      request_id: slot.request_id,
    })) as { state: string };
    expect(box.state).toBe("fulfilled");
    expect(log.lines.join("\n")).not.toContain("FIXTURE-private-name");
  });

  test("a text secret's Treat-as reaches the box, and its value never reaches the log", async () => {
    const { backend, ctx, frames, sink, target, log } = harness();
    const slot = backend.files.openRequest(AGENT, {
      kind: "secret_text",
      purpose: "FIXTURE key",
      keys: ["GH_APP_KEY"],
      durable: false,
    });
    const upload_id = await dropped(ctx, "secret.env", `A=${VALUE}\nsecond line\n`);
    await dispatch(
      ctx,
      "files.put",
      {
        instance: AGENT,
        request_id: slot.request_id,
        source: { chunk_upload_id: upload_id },
        as: "raw",
        target,
      },
      sink,
    );
    const done = await until(frames, (f) => f.event === "done");
    expect(done.data).toMatchObject({
      type: "fulfilled",
      result: { format: "raw", keys: ["GH_APP_KEY"] },
    });
    expect(backend.files.lastSecretAs(AGENT, slot.request_id)).toBe("raw");
    expect(JSON.stringify(frames)).not.toContain(VALUE);
    expect(log.lines.join("\n")).not.toContain(VALUE);
  });

  test("a refused text secret is a `done` error naming the line, never the value", async () => {
    const { backend, ctx, frames, sink, target, log } = harness();
    const slot = backend.files.openRequest(AGENT, {
      kind: "secret_text",
      purpose: "FIXTURE token",
      keys: ["GITHUB_TOKEN"],
    });
    const upload_id = await dropped(
      ctx,
      "secret.env",
      `GITHUB_TOKEN=${VALUE}\nAWS_SECRET_ACCESS_KEY=${VALUE}x\n`,
    );
    await dispatch(
      ctx,
      "files.put",
      { instance: AGENT, request_id: slot.request_id, source: { chunk_upload_id: upload_id }, target },
      sink,
    );
    const done = await until(frames, (f) => f.event === "done");
    expect(done.data).toMatchObject({ type: "error", code: "VALIDATION" });
    expect(JSON.stringify(done.data)).toContain("Line 2");
    expect(JSON.stringify(done.data)).toContain("not requested");
    expect(JSON.stringify(frames)).not.toContain(VALUE);
    expect(log.lines.join("\n")).not.toContain(VALUE);
  });

  test("put frames ride `files.put.frame`, the last as `done`", async () => {
    const { backend, ctx, target } = harness();
    const sent: Array<{ name: string; payload: unknown }> = [];
    const captured: { options: RpcOptions | null } = { options: null };
    createRpcBinding({
      defineRPC: (options) => {
        captured.options = options;
        return { defined: true };
      },
      send: (name, payload) => void sent.push({ name, payload }),
      ctx,
    });
    const put = captured.options?.handlers.requests["files.put"];
    if (put === undefined) throw new Error("no files.put handler");
    const slot = backend.files.openRequest(AGENT, { purpose: "FIXTURE" });
    const upload_id = await dropped(ctx, "notes.txt", "FIXTURE notes\n");
    const { stream_id } = (await put({
      instance: AGENT,
      request_id: slot.request_id,
      source: { chunk_upload_id: upload_id },
      target,
    } as never)) as { stream_id: string };
    for (let i = 0; i < 400 && !sent.some((s) => (s.payload as { done?: unknown }).done); i += 1) {
      await Bun.sleep(5);
    }
    const mine = sent.filter((s) => s.name === "files.put.frame");
    expect(mine.length).toBeGreaterThan(0);
    expect(sent.some((s) => s.name === "files.frame")).toBe(false);
    const last = mine.at(-1)?.payload as { stream_id: string; done?: FilesPutFrame };
    expect(last.stream_id).toBe(stream_id);
    expect(last.done?.type).toBe("fulfilled");
  });

  test("files.decline closes the slot the agent is waiting on", async () => {
    const { backend, ctx, target } = harness();
    const slot = backend.files.openRequest(AGENT, { purpose: "FIXTURE" });
    const waiting = backend.files.waitFor(AGENT, slot.request_id, { timeoutMs: 5_000 });
    const declined = (await dispatch(ctx, "files.decline", {
      instance: AGENT,
      request_id: slot.request_id,
      reason: "wrong file",
      target,
    })) as { state: string };
    expect(declined.state).toBe("declined");
    expect((await waiting).declined?.reason).toBe("wrong file");
  });
});
