/**
 * The request card against a faked `files.request.get`: a text secret says
 * which session asked, like a file request does; a request id that changes
 * under the card starts a fresh card (nothing typed carries over); and a text
 * secret delivered after the agent stopped waiting offers to tell it, with
 * the path and key names and never a value.
 *
 * The fixture has no text-secret timeout, so the late case is drawn from a
 * crafted block and slot rather than a flow.
 *
 * Assertions compare strings and booleans, never DOM nodes.
 */
import { act, cleanup, fireEvent, render, waitFor } from "./dom.ts";
import { afterEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import type { FileRequestSlot } from "../src/api/files.ts";
import { ChatContext } from "../src/chat/chat-state.tsx";
import type { Chat } from "../src/chat/chat-state.tsx";
import { FileRequestBlock } from "../src/chat/components/blocks/FileRequest.tsx";
import type { RequestToolBlock } from "../src/chat/file-request-logic.ts";
import { type FakeServer, type TransportCall, fakeServer } from "./fake-transport.ts";

let server: FakeServer | null = null;

afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
});

const SESSION = "sess_on_screen";
const VALUE = "FIXTURE_late_secret_value_0123456789";

function block(request_id: string, over: Partial<RequestToolBlock> = {}): RequestToolBlock {
  return {
    kind: "tool",
    tool_id: `t_${request_id}`,
    name: "request_secret",
    server: null,
    args: {},
    result: null,
    status: "running",
    exit_code: null,
    duration_ms: 0,
    render: "secret_request",
    request_id,
    ...over,
  } as RequestToolBlock;
}

function textSlot(request_id: string, over: Partial<FileRequestSlot> = {}): FileRequestSlot {
  return {
    request_id,
    kind: "secret_text",
    purpose: `purpose of ${request_id}`,
    accept: [],
    max_bytes: 65_536,
    sensitivity: "secret",
    durable: true,
    state: "open",
    created_at: "2026-10-13T12:00:00.000Z",
    expires_at: "2099-10-13T14:00:00.000Z",
    keys: ["GITHUB_TOKEN"],
    slug: "github",
    ...over,
  } as FileRequestSlot;
}

/**
 * A chat with a session on screen, recording what it was asked to send.
 * `accepts: false` is a chat that would not take the message (`send` answers
 * `false`: a turn in flight, nothing to send to).
 */
function chatWith(sent: string[], accepts = true): Chat {
  return {
    session: { id: SESSION },
    send: (text: string) => {
      sent.push(text);
      return accepts;
    },
  } as unknown as Chat;
}

function Shell({ chat, children }: { chat: Chat; children: ReactNode }) {
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

const cardText = (): string => document.querySelector(".ch-freq")?.textContent ?? "";
const warnText = (): string => document.querySelector(".ch-freq .ch-freq-warn")?.textContent ?? "";
const button = (label: string) =>
  Array.from(document.querySelectorAll(".ch-freq button")).find((b) => b.textContent === label);
const field = () => document.querySelector<HTMLInputElement>(".ch-freq .sti input");

test("a text secret says which session asked, and warns when it was not this one", async () => {
  const slots: Record<string, FileRequestSlot> = {
    fr_000000000own: textSlot("fr_000000000own", { session_id: SESSION }),
    fr_00000000other: textSlot("fr_00000000other", { session_id: "sess_elsewhere" }),
    fr_000000000none: textSlot("fr_000000000none"),
  };
  server = fakeServer({
    "files.request.get": (call: TransportCall) =>
      slots[(call.params as { request_id: string }).request_id],
  });
  const chat = chatWith([]);
  const { rerender } = render(
    <Shell chat={chat}>
      <FileRequestBlock block={block("fr_000000000own")} instance="atlas" agent="atlas" />
    </Shell>,
  );
  await waitFor(() => expect(cardText()).toContain("from this conversation"));
  expect(warnText()).toBe("");

  rerender(
    <Shell chat={chat}>
      <FileRequestBlock block={block("fr_00000000other")} instance="atlas" agent="atlas" />
    </Shell>,
  );
  await waitFor(() => expect(warnText()).toContain("from another session"));
  expect(cardText().includes("from this conversation")).toBe(false);

  rerender(
    <Shell chat={chat}>
      <FileRequestBlock block={block("fr_000000000none")} instance="atlas" agent="atlas" />
    </Shell>,
  );
  await waitFor(() => expect(warnText()).toContain("session not recorded"));
});

test("a request id that changes starts a fresh card: no old slot, nothing typed carried over", async () => {
  let releaseB: (slot: FileRequestSlot) => void = () => undefined;
  server = fakeServer({
    "files.request.get": (call: TransportCall) => {
      const id = (call.params as { request_id: string }).request_id;
      if (id === "fr_0000000000aa") return textSlot(id, { session_id: SESSION });
      return new Promise<FileRequestSlot>((resolve) => {
        releaseB = resolve;
      });
    },
  });
  const chat = chatWith([]);
  const { rerender } = render(
    <Shell chat={chat}>
      <FileRequestBlock block={block("fr_0000000000aa")} instance="atlas" agent="atlas" />
    </Shell>,
  );
  await waitFor(() => expect(field() !== null).toBe(true));
  fireEvent.input(field()!, { target: { value: VALUE } });
  expect(field()!.value).toBe(VALUE);

  rerender(
    <Shell chat={chat}>
      <FileRequestBlock block={block("fr_0000000000bb")} instance="atlas" agent="atlas" />
    </Shell>,
  );
  // Until the box answers for the new id, the card is reading — not the old slot.
  expect(cardText()).toContain("Reading the request from the box…");
  expect(cardText().includes("purpose of fr_0000000000aa")).toBe(false);
  expect(field() === null).toBe(true);

  await act(async () => releaseB(textSlot("fr_0000000000bb", { session_id: SESSION })));
  await waitFor(() => expect(cardText()).toContain("purpose of fr_0000000000bb"));
  expect(field()!.value).toBe("");
  const reads = server
    .to("files.request.get")
    .map((c) => (c.params as { request_id: string }).request_id);
  expect(reads.includes("fr_0000000000bb")).toBe(true);
});

test("a text secret delivered after the agent stopped waiting offers to tell it, once, by key name", async () => {
  const id = "fr_000000late01";
  const path = "/run/hermetic/files/github.env";
  server = fakeServer({
    "files.request.get": () =>
      textSlot(id, {
        session_id: SESSION,
        keys: ["GITHUB_TOKEN", "GITHUB_USER"],
        state: "fulfilled",
        fulfilled: {
          path,
          sha256: "a".repeat(64),
          bytes: 64,
          by: "operator@example.com",
          at: "2026-10-13T12:30:00.000Z",
          class: "secret",
          keys: ["GITHUB_TOKEN", "GITHUB_USER"],
          format: "dotenv",
          ssm_slot: "env-github",
        },
      }),
  });
  const sent: string[] = [];
  const late = block(id, { status: "ok", result: { status: "pending" } });
  const draw = () =>
    render(
      <Shell chat={chatWith(sent)}>
        <FileRequestBlock block={late} instance="atlas" agent="atlas" at="2026-10-13T12:05:00.000Z" />
      </Shell>,
    );
  draw();
  await waitFor(() => expect(cardText()).toContain("delivered after the turn ended"));
  expect(cardText()).toMatch(/atlas stopped waiting at \d\d:\d\d\. The secret is on the box\./);
  fireEvent.click(button("Tell atlas & continue")!);
  expect(sent).toEqual([
    `[hermetic] Secret for request ${id} delivered: ${path} (keys: GITHUB_TOKEN, GITHUB_USER)`,
  ]);
  expect(cardText()).toContain("Sent to atlas.");
  expect(sent.some((m) => m.includes(VALUE))).toBe(false);

  // Remounted, the card never offers to tell the agent a second time.
  cleanup();
  draw();
  await waitFor(() => expect(cardText()).toContain("delivered after the turn ended"));
  expect(button("Tell atlas & continue") === undefined).toBe(true);
  expect(sent.length).toBe(1);
});

test("a late tell the chat would not send stays offered, and is not marked told", async () => {
  const id = "fr_000000late02";
  const path = "/run/hermetic/files/github.env";
  server = fakeServer({
    "files.request.get": () =>
      textSlot(id, {
        session_id: SESSION,
        state: "fulfilled",
        fulfilled: {
          path,
          sha256: "c".repeat(64),
          bytes: 32,
          by: "operator@example.com",
          at: "2026-10-13T12:30:00.000Z",
          class: "secret",
          keys: ["GITHUB_TOKEN"],
          format: "dotenv",
          ssm_slot: "env-github",
        },
      }),
  });
  const sent: string[] = [];
  const late = block(id, { status: "ok", result: { status: "pending" } });
  const draw = (accepts: boolean) =>
    render(
      <Shell chat={chatWith(sent, accepts)}>
        <FileRequestBlock block={late} instance="atlas" agent="atlas" at="2026-10-13T12:05:00.000Z" />
      </Shell>,
    );
  draw(false);
  await waitFor(() => expect(cardText()).toContain("delivered after the turn ended"));
  fireEvent.click(button("Tell atlas & continue")!);
  expect(sent.length).toBe(1);
  expect(cardText().includes("Sent to atlas.")).toBe(false);
  expect(button("Tell atlas & continue") !== undefined).toBe(true);
  // Not marked told: a remount still offers it, and a send that goes through is recorded.
  cleanup();
  draw(true);
  await waitFor(() => expect(button("Tell atlas & continue") !== undefined).toBe(true));
  fireEvent.click(button("Tell atlas & continue")!);
  expect(sent.length).toBe(2);
  expect(cardText()).toContain("Sent to atlas.");
});

test("a text secret the agent was still waiting for offers nothing late", async () => {
  const id = "fr_00000000wait";
  server = fakeServer({
    "files.request.get": () =>
      textSlot(id, {
        session_id: SESSION,
        state: "fulfilled",
        fulfilled: {
          path: "/run/hermetic/files/github.env",
          sha256: "b".repeat(64),
          bytes: 32,
          by: "operator@example.com",
          at: "2026-10-13T12:30:00.000Z",
          class: "secret",
          keys: ["GITHUB_TOKEN"],
        },
      }),
  });
  render(
    <Shell chat={chatWith([])}>
      <FileRequestBlock
        block={block(id, { status: "ok", result: { status: "fulfilled" } })}
        instance="atlas"
        agent="atlas"
      />
    </Shell>,
  );
  await waitFor(() => expect(cardText()).toContain("secret delivered"));
  expect(cardText().includes("delivered after the turn ended")).toBe(false);
});

test("a native pick that answers after the slot expired is discarded, never put", async () => {
  const id = "fr_0000000late2";
  let state: FileRequestSlot["state"] = "open";
  let answerPick: (answer: unknown) => void = () => undefined;
  server = fakeServer({
    "files.request.get": () =>
      textSlot(id, {
        kind: "file",
        sensitivity: "normal",
        durable: false,
        accept: [".pdf"],
        keys: undefined,
        slug: undefined,
        session_id: SESSION,
        state,
      }),
    "files.pickNative": () =>
      new Promise((resolve) => {
        answerPick = resolve;
      }),
    "files.decline": () => {
      state = "expired";
      return { ok: true };
    },
    "files.chunk.discard": () => ({ ok: true }),
  });
  render(
    <Shell chat={chatWith([])}>
      <FileRequestBlock
        block={block(id, { name: "request_file", render: "file_request" })}
        instance="atlas"
        agent="atlas"
      />
    </Shell>,
  );
  await waitFor(() => expect(button("Choose file…") !== undefined).toBe(true));
  fireEvent.click(button("Choose file…")!);
  await waitFor(() => expect(server!.to("files.pickNative").length).toBe(1));
  // The slot closes while the dialog is still open.
  fireEvent.click(button("Decline")!);
  await waitFor(() => expect(button("Choose file…") === undefined).toBe(true));
  await act(async () =>
    answerPick({
      files: [{ upload_id: "up_late_pick_01", name: "report.pdf", size: 1024, looks_like_key: false }],
    }),
  );
  await waitFor(() => expect(server!.to("files.chunk.discard").length).toBe(1));
  const discarded = server!.to("files.chunk.discard")[0]!.params as { upload_id: string };
  expect(discarded.upload_id).toBe("up_late_pick_01");
  expect(server!.streams.some((s) => s.name === "files.put")).toBe(false);
  expect(cardText().includes("report.pdf")).toBe(false);
});
