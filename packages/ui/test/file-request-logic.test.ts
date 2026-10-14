import { describe, expect, test } from "bun:test";
import type { ChatBlockView } from "../src/api/index.ts";
import type { FileRequestSlot } from "../src/api/files.ts";
import {
  capLabel,
  continueMessage,
  countdown,
  deliveredLate,
  isRequestTool,
  lifetimeLabel,
  markToldLate,
  requestOrigin,
  secretContinueMessage,
  toldLate,
  untrustedBefore,
} from "../src/chat/file-request-logic.ts";

const tool = (over: Partial<Extract<ChatBlockView, { kind: "tool" }>>): ChatBlockView =>
  ({
    kind: "tool",
    tool_id: "t1",
    name: "request_file",
    server: null,
    args: {},
    result: null,
    status: "ok",
    exit_code: null,
    duration_ms: 0,
    render: "file_request",
    request_id: "fr_abcdefabcdef",
    ...over,
  }) as ChatBlockView;

const slot = (state: FileRequestSlot["state"]): FileRequestSlot =>
  ({
    request_id: "fr_abcdefabcdef",
    kind: "file",
    purpose: "p",
    accept: [],
    max_bytes: 1,
    sensitivity: "normal",
    durable: false,
    state,
    created_at: "2026-10-13T12:00:00.000Z",
    expires_at: "2026-10-13T14:00:00.000Z",
  }) as FileRequestSlot;

describe("request card logic", () => {
  test("only file and secret request tools are cards", () => {
    expect(isRequestTool(tool({}))).toBe(true);
    expect(isRequestTool(tool({ render: "secret_request" }))).toBe(true);
    expect(isRequestTool(tool({ render: "terminal" }))).toBe(false);
    expect(isRequestTool({ kind: "text", markdown: "x" } as ChatBlockView)).toBe(false);
  });

  test("countdown reads h:mm:ss and stops at zero", () => {
    const at = Date.parse("2026-10-13T12:01:48.000Z");
    expect(countdown("2026-10-13T14:00:00.000Z", at)).toBe("1:58:12");
    expect(countdown("2026-10-13T12:00:00.000Z", at)).toBe("0:00:00");
  });

  test("caps and lifetimes read the way people write them", () => {
    expect(capLabel(256 * 1024 * 1024)).toBe("256 MB");
    expect(capLabel(4096)).toBe("4 KB");
    expect(lifetimeLabel(slot("expired"))).toBe("2 h");
    // A slot closed early carries its closing time: the default lifetime.
    expect(
      lifetimeLabel({ created_at: "2026-10-13T12:00:00.000Z", expires_at: "2026-10-13T12:00:00.000Z" }),
    ).toBe("2 h");
  });

  test("a late delivery is a finished wait that said pending, and a slot now fulfilled", () => {
    const pending = tool({ status: "ok", result: { status: "pending" } });
    expect(deliveredLate(pending as never, slot("fulfilled"))).toBe(true);
    expect(deliveredLate(pending as never, slot("open"))).toBe(false);
    // Consumed: the agent already read it, so there is nothing to tell it.
    expect(deliveredLate(pending as never, slot("consumed"))).toBe(false);
    expect(
      deliveredLate(
        tool({ status: "running", result: { status: "pending" } }) as never,
        slot("fulfilled"),
      ),
    ).toBe(false);
    expect(deliveredLate(tool({ result: { status: "fulfilled" } }) as never, slot("fulfilled"))).toBe(
      false,
    );
    expect(continueMessage("fr_x", "inbox/a.log")).toBe(
      "[hermetic] File for request fr_x delivered: inbox/a.log",
    );
  });

  test("untrusted: a risk notice or a web/browser tool earlier in the turn", () => {
    const risk = {
      kind: "activity",
      category: "notice",
      key: "risk:t0",
      state: "warning",
      title: "Tool output needs review",
    } as ChatBlockView;
    const web = tool({ name: "web_extract", render: null, request_id: null });
    const ask = tool({});
    expect(untrustedBefore([risk, ask], 1)).toBe(true);
    expect(untrustedBefore([web, ask], 1)).toBe(true);
    expect(untrustedBefore([ask, web], 0)).toBe(false);
    expect(untrustedBefore([tool({ name: "terminal", render: null }), ask], 1)).toBe(false);
    // An MCP server's output is a third party's words too.
    const mcp = tool({ name: "mcp_github_get_issue", render: null, request_id: null });
    expect(untrustedBefore([mcp, ask], 1)).toBe(true);
  });

  test("told late is remembered per instance and request, for the page's life", () => {
    expect(toldLate("atlas", "fr_told_1")).toBe(false);
    markToldLate("atlas", "fr_told_1");
    expect(toldLate("atlas", "fr_told_1")).toBe(true);
    expect(toldLate("sindri", "fr_told_1")).toBe(false);
  });

  test("a text secret's continue message names the path and keys, never a value", () => {
    expect(
      secretContinueMessage("fr_abcdefabcdef", "/run/hermetic/files/aws.env", [
        "AWS_KEY",
        "AWS_SECRET",
      ]),
    ).toBe(
      "[hermetic] Secret for request fr_abcdefabcdef delivered: /run/hermetic/files/aws.env (keys: AWS_KEY, AWS_SECRET)",
    );
    expect(secretContinueMessage("fr_abcdefabcdef", "/run/hermetic/files/x.env", [])).toBe(
      "[hermetic] Secret for request fr_abcdefabcdef delivered: /run/hermetic/files/x.env",
    );
  });

  test("a request is this conversation's only when the box recorded this session", () => {
    const at = (session_id?: string) => ({ ...slot("open"), ...(session_id ? { session_id } : {}) });
    expect(requestOrigin(at("sess_here"), "sess_here").own).toBe(true);
    expect(requestOrigin(at("sess_here"), "sess_here").label).toMatch(/ · from this conversation$/);
    expect(requestOrigin(at("sess_other"), "sess_here")).toEqual({
      own: false,
      label: expect.stringMatching(/ · from another session$/),
    });
    // Nothing recorded is never claimed, not even when no session is on screen.
    expect(requestOrigin(at(), undefined)).toEqual({
      own: false,
      label: expect.stringMatching(/ · session not recorded$/),
    });
    expect(requestOrigin(at("sess_other"), null).own).toBe(false);
  });
});
