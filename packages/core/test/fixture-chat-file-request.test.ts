/**
 * The fixture's request turns (`fixture-chat-file-request.ts`): each trigger's
 * block sequence, the slot it opens on the fixture box for the turn's session,
 * and how the tool completes once the slot is answered, declined or expires —
 * or, for the timeout trigger, `pending` with the slot left open.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fixtureChatClient } from "../src/backend/fixture/fixture-chat.ts";
import { fixtureWaitResult } from "../src/backend/fixture/fixture-chat-file-request.ts";
import { MemoryFiles } from "../src/backend/fixture/memory-files.ts";
import type { BoxAddress } from "../src/chat/hermes/hermes-chat.ts";
import type { ChatBlock, ChatFrame, FileRequest } from "../src/schema/index.ts";

type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;

const AGENT = "atlas";
const SESSION = "sx-atlas-portal";
const BOX: BoxAddress = { instance: AGENT, baseUrl: "https://fxtr0001-atlas.tail0000.ts.net/" };

function harness(waits: { open?: number; pending?: number } = {}) {
  const files = new MemoryFiles({ hasAgent: (name) => name === AGENT, now: () => new Date() });
  const client = fixtureChatClient({ files, fileRequestWaitMs: waits });
  return { files, client };
}

/** One turn; `act` runs once, when the running card naming the slot arrives. */
async function run(
  prompt: string,
  act: (files: MemoryFiles, id: string) => Promise<unknown> | unknown = () => undefined,
  waits: { open?: number; pending?: number } = {},
) {
  const { files, client } = harness(waits);
  const frames: ChatFrame[] = [];
  let slot: FileRequest | null = null;
  for await (const frame of client.send(BOX, "default", prompt, { session: SESSION })) {
    frames.push(frame);
    if (frame.type !== "block" || frame.block.kind !== "tool") continue;
    const id = frame.block.request_id;
    if (frame.block.status === "running" && id && !slot) {
      slot = await files.request(AGENT, id, {});
      await act(files, id);
    }
  }
  const tools = frames.flatMap((f) =>
    f.type === "block" && f.block.kind === "tool" ? [f.block as ToolBlock] : [],
  );
  const text = frames.flatMap((f) => (f.type === "delta" ? [f.text] : [])).join("");
  return { files, frames, tools, slot, text };
}

const decline = (files: MemoryFiles, id: string) => files.decline(AGENT, id, undefined, {});
const expire = (files: MemoryFiles, id: string) => files.expire(AGENT, id);

describe("E2E_FILE_REQUEST", () => {
  test("opens a normal slot for the turn's session and completes on a delivery", async () => {
    const bytes = new TextEncoder().encode("127.0.0.1 - - GET / 502\n");
    const { tools, slot, frames, text } = await run("E2E_FILE_REQUEST please", (files, id) =>
      files.fulfil(
        AGENT,
        id,
        {
          fileName: "access-2026-10-12.log",
          size: bytes.length,
          body: bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        {},
      ),
    );
    expect(slot).toMatchObject({
      kind: "file",
      sensitivity: "normal",
      session_id: SESSION,
      accept: [".log", ".txt", ".gz"],
      name_hint: "access-2026-10-12.log",
    });
    expect(frames.map((f) => (f.type === "block" ? f.block.kind : f.type))).toEqual([
      "reasoning",
      "tool",
      "tool",
      "text",
      "delta",
      "delta",
      "done",
    ]);
    const [start, end] = tools;
    expect(start).toMatchObject({
      name: "request_file",
      render: "file_request",
      status: "running",
      request_id: slot?.request_id,
    });
    expect((start?.args as { purpose?: string } | undefined)?.purpose ?? "").toStartWith(
      "Raw nginx access log for 2026-10-12 01:30–02:30",
    );
    expect(end).toMatchObject({
      tool_id: start?.tool_id,
      status: "ok",
      request_id: slot?.request_id,
      result: { status: "fulfilled", request_id: slot?.request_id, bytes: bytes.length },
    });
    expect(text).toContain("on the box");
  });

  test("a declined slot completes declined", async () => {
    const { tools, text } = await run("E2E_FILE_REQUEST", decline);
    expect(tools.at(-1)?.result).toMatchObject({ status: "declined" });
    expect(text).toContain("won't use it");
  });

  test("an expired slot completes expired", async () => {
    const { tools } = await run("E2E_FILE_REQUEST", expire);
    expect(tools.at(-1)?.result).toMatchObject({ status: "expired" });
  });

  test("a stop ends the turn where it is, without completing the tool", async () => {
    const { files, client } = harness();
    const controller = new AbortController();
    const tools: ToolBlock[] = [];
    for await (const frame of client.send(BOX, "default", "E2E_FILE_REQUEST", {
      session: SESSION,
      signal: controller.signal,
    })) {
      if (frame.type === "block" && frame.block.kind === "tool") {
        tools.push(frame.block);
        controller.abort();
      }
    }
    expect(tools.map((t) => t.status)).toEqual(["running"]);
    expect(files.requestsFor(AGENT).map((r) => r.state)).toEqual(["open"]);
  });
});

describe("E2E_FILE_REQUEST_TIMEOUT", () => {
  test("completes pending with deliver_with, ends the turn, and leaves the slot open", async () => {
    const { tools, slot, files, frames, text } = await run("E2E_FILE_REQUEST_TIMEOUT", undefined, {
      pending: 20,
    });
    const id = slot?.request_id ?? "";
    expect(tools.at(-1)).toMatchObject({
      status: "ok",
      request_id: id,
      result: {
        status: "pending",
        request_id: id,
        deliver_with: [
          `hermetic files put ${AGENT} --request ${id} <path>`,
          `curl -T <path> http://${AGENT}:7434/files/requests/${id}`,
        ],
      },
    });
    expect(frames.at(-1)?.type).toBe("done");
    expect(text).toContain(`hermetic files put ${AGENT} --request ${id}`);
    expect((await files.request(AGENT, id, {})).state).toBe("open");
  });
});

describe("E2E_SECRET_REQUEST", () => {
  test("opens a durable secret slot for a .pem", async () => {
    const { slot, tools } = await run("E2E_SECRET_REQUEST", decline);
    expect(slot).toMatchObject({
      kind: "file",
      sensitivity: "secret",
      durable: true,
      accept: [".pem"],
      name_hint: "github-app.pem",
      max_bytes: 4096,
      session_id: SESSION,
    });
    expect(tools.map((t) => [t.name, t.render, t.status])).toEqual([
      ["request_file", "file_request", "running"],
      ["request_file", "file_request", "ok"],
    ]);
    expect(tools.at(-1)?.result).toMatchObject({ status: "declined" });
  });
});

describe("E2E_TEXT_SECRET", () => {
  test("one key, a request_secret card", async () => {
    const { slot, tools } = await run("E2E_TEXT_SECRET", expire);
    expect(slot).toMatchObject({ kind: "secret_text", keys: ["GITHUB_TOKEN"], session_id: SESSION });
    expect(tools.map((t) => [t.name, t.render])).toEqual([
      ["request_secret", "secret_request"],
      ["request_secret", "secret_request"],
    ]);
    expect(tools.at(-1)?.result).toMatchObject({
      status: "expired",
      deliver_with: [`hermetic files put ${AGENT} --request ${slot?.request_id} --secret-stdin`],
    });
  });

  test("E2E_TEXT_SECRET_MULTI asks for three keys, multi-line", async () => {
    const { slot } = await run("E2E_TEXT_SECRET_MULTI", decline);
    expect(slot).toMatchObject({
      kind: "secret_text",
      keys: ["DB_USER", "DB_PASS", "DB_URL"],
      input: "multi",
    });
  });

  test("a fulfilled text secret's result names keys and the load line, never a value", () => {
    const result = fixtureWaitResult(AGENT, {
      request_id: "fr_textsecret01",
      kind: "secret_text",
      purpose: "token",
      accept: [],
      max_bytes: 4096,
      sensitivity: "secret",
      durable: true,
      state: "fulfilled",
      created_at: "2026-10-12T10:00:00.000Z",
      expires_at: "2026-10-12T12:00:00.000Z",
      keys: ["GITHUB_TOKEN"],
      fulfilled: {
        path: "/run/hermetic/files/github-token.env",
        sha256: "0".repeat(64),
        bytes: 52,
        by: "operator@fixture.example",
        at: "2026-10-12T10:01:00.000Z",
        class: "secret",
        keys: ["GITHUB_TOKEN"],
        format: "dotenv",
      },
    } as FileRequest);
    expect(result).toEqual({
      status: "fulfilled",
      request_id: "fr_textsecret01",
      path: "/run/hermetic/files/github-token.env",
      by: "operator@fixture.example",
      class: "secret",
      keys: ["GITHUB_TOKEN"],
      format: "dotenv",
      load: "set -a; . /run/hermetic/files/github-token.env; set +a",
      deliver_with: [`hermetic files put ${AGENT} --request fr_textsecret01 --secret-stdin`],
      expires_at: "2026-10-12T12:00:00.000Z",
    });
  });
});

describe("without a files service", () => {
  test("the prompt is an ordinary turn", async () => {
    const client = fixtureChatClient({});
    const tools: string[] = [];
    for await (const frame of client.send(BOX, "default", "E2E_FILE_REQUEST", { session: SESSION }))
      if (frame.type === "block" && frame.block.kind === "tool") tools.push(frame.block.name);
    expect(tools).not.toContain("request_file");
  });

  test("a box that refuses the slot fails the tool", async () => {
    const files = new MemoryFiles({ hasAgent: () => false, now: () => new Date() });
    const client = fixtureChatClient({ files });
    const tools: ToolBlock[] = [];
    for await (const frame of client.send(BOX, "default", "E2E_FILE_REQUEST", { session: SESSION }))
      if (frame.type === "block" && frame.block.kind === "tool") tools.push(frame.block);
    expect(tools.map((t) => [t.status, t.request_id])).toEqual([
      ["running", null],
      ["bad", null],
    ]);
  });
});
