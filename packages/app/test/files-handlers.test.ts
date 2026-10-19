/**
 * The desktop head's files requests (`handlers/files.ts`) over the fixture
 * backend: a webview drop sent by loopback PUT, staged by id and streamed back as
 * `files.frame`s; a failure after the stream opened arriving as its last
 * frame; a thumbnail; and the app log never holding a file's name.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fleetTargetOf,
  openHermetic,
  type FilesGetFrame,
  type FilesStageFrame,
  type Hermetic,
  type Plan,
} from "@hermetic/core";
import { createChatOwner } from "../src/chat-owner.ts";
import type { HandlerContext } from "../src/handlers/ctx.ts";
import { dispatch } from "../src/handlers/dispatch.ts";
import { createStreamRegistry, type StreamFrame } from "../src/handlers/streams.ts";
import { memoryLog } from "../src/log.ts";
import { OpRegistry } from "../src/ops.ts";
import { createRpcBinding, type RpcOptions } from "../src/rpc/bind.ts";
import { AppState, fixedInstance, openState } from "../src/state.ts";
import { testHome } from "./home.ts";

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
  const { upload_id, url } = (await dispatch(ctx, "files.upload.open", {
    name,
    size: bytes.byteLength,
  })) as {
    upload_id: string;
    url: string;
  };
  void fetch(url, { method: "PUT", body: new Blob([bytes.slice().buffer as ArrayBuffer]) }).catch(
    () => undefined,
  );
  return upload_id;
}

test("a bounded text secret registers once and can be discarded", async () => {
  const { ctx } = await harness();
  const registered = (await dispatch(ctx, "files.secretText.upload", {
    name: "github.env",
    data_b64: Buffer.from("GITHUB_TOKEN=FIXTURE\n").toString("base64"),
  })) as { upload_id: string; size: number };
  expect(registered.upload_id).toMatch(/^up_/);
  expect(registered.size).toBe(21);
  expect(await dispatch(ctx, "files.upload.discard", { upload_id: registered.upload_id })).toEqual({
    discarded: true,
  });
  expect(await dispatch(ctx, "files.upload.discard", { upload_id: registered.upload_id })).toEqual({
    discarded: false,
  });
});

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

  // Like the box, a staged file has no content until a turn commits it.
  const early = await dispatch(ctx, "files.content", { instance: "atlas", id: frame.file.id }).catch(
    (error: unknown) => error as { code?: string },
  );
  expect((early as { code?: string }).code).toBe("FILE_NOT_FOUND");
  await ctx.hermetic().files.internal.commit("atlas", frame.file.id, "s1");

  // The thumbnail: an image's bytes, base64, refused for anything else.
  const content = (await dispatch(ctx, "files.content", { instance: "atlas", id: frame.file.id })) as {
    mime: string;
    data_b64: string;
  };
  expect(content.mime).toBe("image/png");
  expect(Buffer.from(content.data_b64, "base64")).toEqual(Buffer.from(PNG));
  expect(
    await dispatch(ctx, "files.content", {
      instance: "atlas",
      id: frame.file.id,
      expected_sha256: frame.file.sha256,
    }),
  ).toEqual(content);
  const mismatch = await dispatch(ctx, "files.content", {
    instance: "atlas",
    id: frame.file.id,
    expected_sha256: "0".repeat(64),
  }).catch((error: unknown) => error as { code?: string });
  expect((mismatch as { code?: string }).code).toBe("FILE_DIGEST_MISMATCH");

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
  await ctx.hermetic().files.internal.commit("atlas", frame.file.id, "s1");
  const e = await dispatch(ctx, "files.content", { instance: "atlas", id: frame.file.id }).catch(
    (x: unknown) => x as { code?: string },
  );
  expect((e as { code?: string }).code).toBe("FILE_TYPE_REJECTED");
});

test("files.content takes a share id (sh_…); files.discard still takes files only", async () => {
  const { ctx, target } = await harness();
  // The seeded share is a CSV: past the id check, refused as not an image.
  const share = await dispatch(ctx, "files.content", {
    instance: "atlas",
    id: "sh_fxatlascsv01",
  }).catch((e: unknown) => e as { code?: string });
  expect((share as { code?: string }).code).toBe("FILE_TYPE_REJECTED");
  const discard = await dispatch(ctx, "files.discard", {
    instance: "atlas",
    id: "sh_fxatlascsv01",
    target,
  }).catch((e: unknown) => e as { code?: string });
  expect((discard as { code?: string }).code).toBe("VALIDATION");
});

test("files.content reads a share for its purpose and refuses any other type", async () => {
  const { ctx } = await harness();
  // The seeded share is a CSV: text to show, never a picture or a player.
  const text = (await dispatch(ctx, "files.content", {
    instance: "atlas",
    id: "sh_fxatlascsv01",
    purpose: "text",
  })) as { mime: string; data_b64: string };
  expect(text.mime).toBe("text/csv");
  expect(Buffer.from(text.data_b64, "base64").toString("utf8").length).toBeGreaterThan(0);
  for (const purpose of ["image", "playback"]) {
    const e = await dispatch(ctx, "files.content", {
      instance: "atlas",
      id: "sh_fxatlascsv01",
      purpose,
    }).catch((x: unknown) => x as { code?: string });
    expect((e as { code?: string }).code).toBe("FILE_TYPE_REJECTED");
  }
  const bad = await dispatch(ctx, "files.content", {
    instance: "atlas",
    id: "sh_fxatlascsv01",
    purpose: "path",
  }).catch((x: unknown) => x as { code?: string });
  expect((bad as { code?: string }).code).toBe("VALIDATION");
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

function nativeWith(
  pickFiles: () => Promise<string[]>,
  pickFolder: () => Promise<string | null> = async () => null,
): NonNullable<HandlerContext["native"]> {
  return {
    info: () => ({ version: "0.0.0", channel: "dev", home: ":memory:", logPath: null }),
    openExternal: () => undefined,
    checkForUpdate: async () => undefined,
    installCli: async () => ({ path: "/x", elevated: false }),
    notify: () => ({ delivered: true, permission: "granted" }),
    pickFiles,
    pickFolder,
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

/**
 * A head that can switch fleets, for the pick's pin: the dialog stays open as
 * long as the operator likes, and a `fleets.switch` can land meanwhile.
 */
async function switchable() {
  const state = await openState({ fixture: true, home: testHome("hermetic-pick-switch-") });
  const ctx: HandlerContext = {
    state,
    hermetic: () => state.hermetic,
    ops: new OpRegistry(),
    poller: () => state.poller,
    chatOwner: createChatOwner({ hermetic: () => state.hermetic }),
    fixture: true,
    opts: { fixture: true },
    streams: createStreamRegistry(),
  };
  return { state, ctx };
}

/** Counts what an instance's upload registry is asked to keep and to forget. */
function spyUploads(h: Hermetic) {
  const uploads = h.files.internal.uploads;
  const seen = { registered: [] as string[], discarded: [] as string[] };
  const registerPath = uploads.registerPath;
  const discard = uploads.discard;
  uploads.registerPath = async (path) => {
    const picked = await registerPath(path);
    seen.registered.push(picked.upload_id);
    return picked;
  };
  uploads.discard = (id) => {
    seen.discarded.push(id);
    return discard(id);
  };
  return seen;
}

test("files.pickNative refuses a pick whose dialog closed after a fleet switch, registering nothing", async () => {
  const { state, ctx } = await switchable();
  const before = state.hermetic;
  expect(state.target?.fleet_id).toBe("fxtr0001");
  const old = spyUploads(before);
  const dir = mkdtempSync(join(tmpdir(), "hermetic-pick-switch-"));
  const path = join(dir, "late.png");
  writeFileSync(path, PNG);
  let close!: (paths: string[]) => void;
  ctx.native = nativeWith(() => new Promise<string[]>((resolve) => (close = resolve)));
  const pick = dispatch(ctx, "files.pickNative", { instance: "atlas" });
  await Bun.sleep(0);
  await dispatch(ctx, "fleets.switch", { fleet: "sg7k2m4p" });
  expect(state.target?.fleet_id).toBe("sg7k2m4p");
  expect(state.hermetic).not.toBe(before);
  const now = spyUploads(state.hermetic);
  close([path]);
  await expect(pick).rejects.toMatchObject({ code: "FLEET_MISMATCH" });
  expect(old.registered.length + now.registered.length).toBe(0);
});

test("files.pickNative discards what it registered when a switch lands while reading the picks", async () => {
  const { state, ctx } = await switchable();
  const before = state.hermetic;
  const old = spyUploads(before);
  const dir = mkdtempSync(join(tmpdir(), "hermetic-pick-switch-"));
  const path = join(dir, "mid.png");
  writeFileSync(path, PNG);
  ctx.native = nativeWith(async () => [path]);
  const registerPath = before.files.internal.uploads.registerPath;
  before.files.internal.uploads.registerPath = async (p) => {
    const picked = await registerPath(p);
    await dispatch(ctx, "fleets.switch", { fleet: "sg7k2m4p" });
    return picked;
  };
  await expect(dispatch(ctx, "files.pickNative", { instance: "atlas" })).rejects.toMatchObject({
    code: "FLEET_MISMATCH",
  });
  expect(old.registered.length).toBe(1);
  expect(old.discarded).toEqual(old.registered);
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

// --- The Files tab: list, the save dialog, a download, a removal plan --------

test("files.saveNative answers an opaque dest_id and files.get saves into that folder", async () => {
  const { ctx, frames, sink, log } = await harness();
  const folder = mkdtempSync(join(tmpdir(), "hermetic-save-private-folder-"));
  const quarantined: { path: string; existed: boolean }[] = [];
  ctx.native = {
    ...nativeWith(
      async () => [],
      async () => folder,
    ),
    quarantine: async (path) => {
      quarantined.push({ path, existed: existsSync(path) });
    },
  };
  const answer = (await dispatch(ctx, "files.saveNative", { instance: "atlas" })) as {
    dest_id: string | null;
  };
  expect(answer.dest_id).toMatch(/^sv_/);
  expect(JSON.stringify(answer)).not.toContain(folder);
  const listed = (await dispatch(ctx, "files.list", { name: "atlas" })) as {
    inbox: { id: string; name: string }[];
  };
  const pdf = listed.inbox.find((e) => e.name.endsWith(".pdf"));
  if (pdf === undefined) throw new Error("the fixture's seeded PDF is missing");
  const opened = (await dispatch(
    ctx,
    "files.get",
    { name: "atlas", id: pdf.id, dest: { dest_id: answer.dest_id } },
    sink,
  )) as { stream_id: string };
  expect(opened.stream_id).toBeString();
  const done = await until(frames, (f) => f.event === "done");
  const frame = done.data as FilesGetFrame;
  expect(frame.type).toBe("saved");
  expect(readdirSync(folder)).toEqual([pdf.name]);
  // Marked once, on the file just written, before the stream said saved.
  expect(quarantined).toEqual([{ path: join(folder, pdf.name), existed: true }]);
  expect(JSON.stringify(frames)).not.toContain(folder);
  expect(log.lines.join("\n")).not.toContain(folder);
  expect(log.lines.join("\n")).not.toContain(pdf.name);
});

test("files.saveNative answers a null dest_id on a cancelled dialog", async () => {
  const { ctx } = await harness();
  ctx.native = nativeWith(
    async () => [],
    async () => null,
  );
  expect(await dispatch(ctx, "files.saveNative", { instance: "atlas" })).toEqual({ dest_id: null });
});

test("files.get from the page never names a path", async () => {
  const { ctx, sink } = await harness();
  const path = join(mkdtempSync(join(tmpdir(), "hermetic-get-path-")), "x.pdf");
  const refused = await dispatch(
    ctx,
    "files.get",
    { name: "atlas", id: "f_fxatlaspdf01", dest: { path } },
    sink,
  ).catch((e: unknown) => e as { code?: string });
  expect((refused as { code?: string }).code).toBe("UNSUPPORTED");
  expect(existsSync(path)).toBe(false);
});

test("files.get of a secret ends on an error frame and writes nothing", async () => {
  const { ctx, frames, sink } = await harness();
  const folder = mkdtempSync(join(tmpdir(), "hermetic-save-secret-"));
  ctx.native = nativeWith(
    async () => [],
    async () => folder,
  );
  const { dest_id } = (await dispatch(ctx, "files.saveNative", { instance: "atlas" })) as {
    dest_id: string;
  };
  await dispatch(ctx, "files.get", { name: "atlas", id: "f_fxatlaspem01", dest: { dest_id } }, sink);
  const done = await until(frames, (f) => f.event === "done");
  expect(done.data).toMatchObject({ type: "error", code: "FILE_SECRET_FORBIDDEN" });
  expect(readdirSync(folder)).toEqual([]);
});

test("files.rm answers a plan naming the SSM slot, which apply then removes", async () => {
  const { ctx, target } = await harness();
  const plan = (await dispatch(ctx, "files.rm", { name: "atlas", id: "f_fxatlasenv01" })) as Plan;
  expect(plan.kind).toBe("files-rm");
  expect(plan.steps.map((s) => s.id)).toEqual(["ssm", "box"]);
  const accepted = (await dispatch(ctx, "apply", { plan, yes: true, target })) as { op_id: string };
  await ctx.ops.wait(accepted.op_id);
  const listed = (await dispatch(ctx, "files.list", { name: "atlas" })) as {
    secrets: { id: string }[];
  };
  expect(listed.secrets.map((e) => e.id)).not.toContain("f_fxatlasenv01");
});
