/**
 * The desktop head's files requests (`handlers/files.ts`) over the fixture
 * backend: a webview drop sent in chunks, staged by id and streamed back as
 * `files.frame`s; a failure after the stream opened arriving as its last
 * frame; a thumbnail; and the app log never holding a file's name.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetTargetOf, openHermetic, type FilesStageFrame, type Hermetic } from "@hermetic/core";
import { createChatOwner } from "../src/chat-owner.ts";
import type { HandlerContext } from "../src/handlers/ctx.ts";
import { dispatch } from "../src/handlers/dispatch.ts";
import { createStreamRegistry, type StreamFrame } from "../src/handlers/streams.ts";
import { memoryLog } from "../src/log.ts";
import { OpRegistry } from "../src/ops.ts";
import { createRpcBinding, type RpcOptions } from "../src/rpc/bind.ts";
import { AppState, fixedInstance } from "../src/state.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function harness() {
  const hermetic: Hermetic = await openHermetic({ fixture: true });
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
  return { ctx, frames, sink, target, log };
}

async function until(frames: StreamFrame[], want: (f: StreamFrame) => boolean): Promise<StreamFrame> {
  for (let i = 0; i < 400; i += 1) {
    const hit = frames.find(want);
    if (hit) return hit;
    await Bun.sleep(5);
  }
  throw new Error("the frame never arrived");
}

async function dropped(ctx: HandlerContext, name: string, bytes: Uint8Array): Promise<string> {
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

test("a drop stages by upload id and ends on a staged `done` frame", async () => {
  const { ctx, frames, sink, target } = await harness();
  const upload_id = await dropped(ctx, "chart.png", PNG);
  const answer = (await dispatch(
    ctx,
    "files.stage",
    { instance: "atlas", source: { chunk_upload_id: upload_id }, target },
    sink,
  )) as { stream_id: string };
  expect(typeof answer.stream_id).toBe("string");
  const done = await until(frames, (f) => f.event === "done");
  const frame = done.data as FilesStageFrame;
  expect(frame.type).toBe("staged");
  if (frame.type !== "staged") throw new Error("unreachable");
  expect(frame.file).toMatchObject({ name: "chart.png", mime: "image/png", class: "image" });
  expect(frames.some((f) => f.event === "progress")).toBe(true);

  // The thumbnail: an image's bytes, base64, refused for anything else.
  const content = (await dispatch(ctx, "files.content", { instance: "atlas", id: frame.file.id })) as {
    mime: string;
    data_b64: string;
  };
  expect(content.mime).toBe("image/png");
  expect(Buffer.from(content.data_b64, "base64")).toEqual(Buffer.from(PNG));

  expect(
    await dispatch(ctx, "files.discard", { instance: "atlas", id: frame.file.id, target }),
  ).toEqual({
    discarded: true,
  });
});

test("a failure after the stream opened is its last frame, and the log never names the file", async () => {
  const { ctx, frames, sink, target, log } = await harness();
  const name = "FIXTURE-E2E_FILE_TOO_LARGE-offer-letter.pdf";
  const upload_id = await dropped(ctx, name, new TextEncoder().encode("%PDF-1.7 FIXTURE\n"));
  await dispatch(
    ctx,
    "files.stage",
    { instance: "atlas", source: { chunk_upload_id: upload_id }, target },
    sink,
  );
  const done = await until(frames, (f) => f.event === "done");
  expect(done.data).toMatchObject({ type: "error", code: "FILE_TOO_LARGE" });
  expect(JSON.stringify(done.data)).not.toContain("offer-letter");
  expect(log.lines.join("\n")).not.toContain("offer-letter");
});

test("a sink that throws (the window is gone) still settles `done` and closes the stream", async () => {
  const { ctx, target } = await harness();
  const upload_id = await dropped(
    ctx,
    "FIXTURE-E2E_FILE_TOO_LARGE-gone.pdf",
    new TextEncoder().encode("%PDF-1.7 FIXTURE\n"),
  );
  const rejections: unknown[] = [];
  const onRejection = (e: unknown): void => void rejections.push(e);
  process.on("unhandledRejection", onRejection);
  try {
    const { stream_id } = (await dispatch(
      ctx,
      "files.stage",
      { instance: "atlas", source: { chunk_upload_id: upload_id }, target },
      () => {
        throw new Error("webview gone");
      },
    )) as { stream_id: string };
    const handle = ctx.streams.get(stream_id);
    await handle?.done;
    await Bun.sleep(5);
    expect(ctx.streams.get(stream_id)).toBeUndefined();
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("files.content refuses a file that is not an image", async () => {
  const { ctx, frames, sink, target } = await harness();
  const upload_id = await dropped(ctx, "notes.txt", new TextEncoder().encode("hello"));
  await dispatch(
    ctx,
    "files.stage",
    { instance: "atlas", source: { chunk_upload_id: upload_id }, target },
    sink,
  );
  const done = await until(frames, (f) => f.event === "done");
  const frame = done.data as FilesStageFrame;
  if (frame.type !== "staged") throw new Error("expected staged");
  const e = await dispatch(ctx, "files.content", { instance: "atlas", id: frame.file.id }).catch(
    (x: unknown) => x as { code?: string },
  );
  expect((e as { code?: string }).code).toBe("FILE_TYPE_REJECTED");
});

test("the bridge sends stage frames on `files.frame`, the last as `done`", async () => {
  const { ctx, target } = await harness();
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
  const requests = captured.options?.handlers.requests;
  if (requests === undefined) throw new Error("no request table");
  const upload_id = await dropped(ctx, "chart.png", PNG);
  const stage = requests["files.stage"];
  if (stage === undefined) throw new Error("no files.stage handler");
  const { stream_id } = (await stage({
    instance: "atlas",
    source: { chunk_upload_id: upload_id },
    target,
  } as never)) as { stream_id: string };
  for (let i = 0; i < 400 && !sent.some((s) => (s.payload as { done?: unknown }).done); i += 1) {
    await Bun.sleep(5);
  }
  const mine = sent.filter((s) => s.name === "files.frame");
  expect(mine.length).toBeGreaterThan(1);
  const last = mine.at(-1)?.payload as { stream_id: string; done?: FilesStageFrame };
  expect(last.stream_id).toBe(stream_id);
  expect(last.done?.type).toBe("staged");
});

function nativeWith(pickFiles: () => Promise<string[]>): NonNullable<HandlerContext["native"]> {
  return {
    info: () => ({ version: "0.0.0", channel: "dev", home: ":memory:", logPath: null }),
    openExternal: () => undefined,
    checkForUpdate: async () => undefined,
    installCli: async () => ({ path: "/x", elevated: false }),
    notify: () => ({ delivered: true, permission: "granted" }),
    pickFiles,
  };
}

test("files.pickNative registers each pick and answers upload ids, never a path", async () => {
  const { ctx, frames, sink, target, log } = await harness();
  const dir = mkdtempSync(join(tmpdir(), "hermetic-pick-"));
  const path = join(dir, "secret-dir-name.png");
  writeFileSync(path, PNG);
  ctx.native = nativeWith(async () => [path]);
  const answer = (await dispatch(ctx, "files.pickNative", { instance: "atlas" })) as {
    files: { upload_id: string; name: string; size: number }[];
  };
  expect(answer.files).toHaveLength(1);
  expect(answer.files[0]?.name).toBe("secret-dir-name.png");
  expect(answer.files[0]?.size).toBe(PNG.byteLength);
  expect(JSON.stringify(answer)).not.toContain(dir);
  await dispatch(
    ctx,
    "files.stage",
    { instance: "atlas", source: { chunk_upload_id: answer.files[0]?.upload_id }, target },
    sink,
  );
  const done = await until(frames, (f) => f.event === "done");
  expect((done.data as FilesStageFrame).type).toBe("staged");
  expect(log.lines.join("\n")).not.toContain(dir);
});

test("files.pickNative sniffs each pick for key material (D6), answering a boolean only", async () => {
  const { ctx } = await harness();
  const dir = mkdtempSync(join(tmpdir(), "hermetic-pick-key-"));
  const key = join(dir, "deploy");
  const body =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nFIXTUREFIXTUREFIXTURE\n-----END OPENSSH PRIVATE KEY-----\n";
  writeFileSync(key, body);
  const png = join(dir, "pic.png");
  writeFileSync(png, PNG);
  ctx.native = nativeWith(async () => [key, png]);
  const answer = (await dispatch(ctx, "files.pickNative", { instance: "atlas" })) as {
    files: { name: string; looks_like_key: boolean }[];
  };
  expect(answer.files.map((f) => [f.name, f.looks_like_key])).toEqual([
    ["deploy", true],
    ["pic.png", false],
  ]);
  // The page learns a yes or no, never a byte of the head.
  expect(JSON.stringify(answer)).not.toContain("FIXTUREFIXTURE");
});

test("files.pickNative answers no files on a cancelled dialog", async () => {
  const { ctx } = await harness();
  ctx.native = nativeWith(async () => []);
  expect(await dispatch(ctx, "files.pickNative", { instance: "atlas" })).toEqual({ files: [] });
});

test("files.pickNative is UNSUPPORTED with no desktop head", async () => {
  const { ctx } = await harness();
  await expect(dispatch(ctx, "files.pickNative", { instance: "atlas" })).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});

// --- files.put, files.decline, files.request.get ------------------------------
// The success lanes need an open request slot, which only the fixture backend
// can open; `tests/files-put-bridge.test.ts` drives those through this same
// dispatch. Here: what the bridge refuses, and how a late failure travels.

test("files.put refuses a laptop path before anything reads it", async () => {
  const { ctx, sink, target } = await harness();
  await expect(
    dispatch(
      ctx,
      "files.put",
      {
        instance: "atlas",
        request_id: "fr_abcdefabcdef",
        source: { path: "/etc/FIXTURE-secret.pem" },
        target,
      },
      sink,
    ),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
});

test("files.put to a request the box does not have ends on an error `done`, logged by code only", async () => {
  const { ctx, frames, sink, target, log } = await harness();
  const upload_id = await dropped(ctx, "FIXTURE-private-name.log", new TextEncoder().encode("x\n"));
  const answer = (await dispatch(
    ctx,
    "files.put",
    {
      instance: "atlas",
      request_id: "fr_abcdefabcdef",
      source: { chunk_upload_id: upload_id },
      target,
    },
    sink,
  )) as { stream_id: string };
  expect(answer.stream_id).toBeTruthy();
  const done = await until(frames, (f) => f.event === "done");
  expect(done.data).toMatchObject({ type: "error", code: "FILE_NOT_FOUND" });
  expect(log.lines.join("\n")).toContain("FILE_NOT_FOUND");
  expect(log.lines.join("\n")).not.toContain("FIXTURE-private-name");
});

test("files.put validates its input as a refused request, not a stream", async () => {
  const { ctx, sink, target } = await harness();
  await expect(
    dispatch(
      ctx,
      "files.put",
      { instance: "atlas", request_id: "not-a-request", source: { chunk_upload_id: "up_x" }, target },
      sink,
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" });
});

test("files.decline and files.request.get answer the box's refusal", async () => {
  const { ctx, target } = await harness();
  await expect(
    dispatch(ctx, "files.decline", { instance: "atlas", request_id: "fr_abcdefabcdef", target }),
  ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  await expect(
    dispatch(ctx, "files.request.get", { instance: "atlas", request_id: "fr_abcdefabcdef" }),
  ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  await expect(
    dispatch(ctx, "files.request.get", { instance: "atlas", request_id: "f_abcdefabcdef" }),
  ).rejects.toMatchObject({ code: "VALIDATION" });
});
