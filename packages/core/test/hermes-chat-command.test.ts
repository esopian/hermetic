/**
 * A slash command typed into the chat (issue #73), through the live adapter:
 * `chat.send` with a `/command` line runs it on the gateway's command layer
 * (`slash.exec`, then `command.dispatch` only when `slash.exec` disowns it)
 * and never submits the line as a prompt.
 *
 * No network: the socket is a closure answering JSON-RPC from a per-method
 * table, the same seam `hermes-chat.test.ts` drives.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHermesChat, disposeChatRequestPools } from "../src/chat/hermes/hermes-chat.ts";
import type { BoxAddress, ChatFetch, ChatSocket } from "../src/chat/hermes/hermes-chat.ts";
import { COMMAND_DEADLINE_MS, dispatchFallback } from "../src/chat/hermes/hermes-chat-command.ts";
import { HermeticError } from "../src/errors.ts";
import { ChatFrame } from "../src/schema/index.ts";
import type { ChatBlock, CommandBlock } from "../src/schema/index.ts";
import {
  DASHBOARD_HTML,
  PROMPT_SUBMIT_RESULT,
  RECORDED_TURN,
  SESSION_CREATE_RESULT,
  SESSION_ID,
} from "./fixtures/hermes-frames.ts";

afterEach(() => disposeChatRequestPools());

const BOX: BoxAddress = {
  instance: "veronica",
  baseUrl: "https://fxtr0001-veronica.tail0000.ts.net/",
  fleet_id: "fxtr0001",
};

type Reply = { result: unknown } | { error: { code: number; message: string } };

/** RPC method → its reply, or a function of the params for one that varies. */
type Script = Record<string, Reply | ((params: Record<string, unknown>) => Reply)>;

interface Sent {
  method: string;
  params: Record<string, unknown>;
}

function harness(script: Script, after: Record<string, readonly string[]> = {}) {
  const sent: Sent[] = [];
  const fetchImpl: ChatFetch = () =>
    Promise.resolve(new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html" } }));
  const openSocket = (): ChatSocket => {
    const buffer: string[] = [];
    let done = false;
    let wake: (() => void) | null = null;
    const push = (frame: string): void => {
      buffer.push(frame);
      const w = wake;
      wake = null;
      w?.();
    };
    return {
      opened: Promise.resolve(),
      frames: (async function* () {
        for (;;) {
          while (buffer.length > 0) yield buffer.shift() as string;
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      })(),
      send(data: string) {
        const doc = JSON.parse(data) as { id: number; method: string; params: Record<string, unknown> };
        sent.push({ method: doc.method, params: doc.params });
        const entry = script[doc.method];
        const reply: Reply =
          typeof entry === "function" ? entry(doc.params) : (entry ?? { result: {} });
        push(JSON.stringify({ jsonrpc: "2.0", id: doc.id, ...reply }));
        for (const frame of after[doc.method] ?? []) push(frame);
      },
      close() {
        done = true;
        const w = wake;
        wake = null;
        w?.();
      },
    };
  };
  const chat = createHermesChat({
    fetch: fetchImpl,
    openSocket,
    now: () => "2026-10-15T12:00:00.000Z",
    slotWaitMs: 50,
  });
  return { chat, sent, methods: () => sent.map((s) => s.method) };
}

async function collect(stream: AsyncIterable<ChatFrame>): Promise<ChatFrame[]> {
  const out: ChatFrame[] = [];
  for await (const frame of stream) out.push(ChatFrame.parse(frame));
  return out;
}

function commands(frames: ChatFrame[]): CommandBlock[] {
  return frames.flatMap((f) =>
    f.type === "block" && f.block.kind === "command" ? [f.block as CommandBlock] : [],
  );
}

function blocks(frames: ChatFrame[]): ChatBlock[] {
  return frames.flatMap((f) => (f.type === "block" ? [f.block] : []));
}

const created = { result: SESSION_CREATE_RESULT };
const DISPATCH_METHODS = ["slash.exec", "command.dispatch"];
const dispatches = (methods: string[]): string[] => methods.filter((m) => DISPATCH_METHODS.includes(m));

describe("hermes-chat · slash commands", () => {
  test("a command line is dispatched, its output shown, and no prompt submitted", async () => {
    const h = harness({
      "session.create": created,
      "slash.exec": { result: { output: "Available commands:\n  /help" } },
    });
    const frames = await collect(h.chat.send(BOX, "default", "/help"));
    expect(h.methods()).not.toContain("prompt.submit");
    expect(dispatches(h.methods())).toEqual(["slash.exec"]);
    const exec = h.sent.find((s) => s.method === "slash.exec");
    expect(exec?.params).toEqual({ session_id: SESSION_ID, command: "help" });
    expect(commands(frames)).toEqual([
      { kind: "command", command: "/help", output: "Available commands:\n  /help", state: "done" },
    ]);
    expect(frames.at(-1)).toMatchObject({ type: "done", incomplete: null });
    // Nothing a model turn draws: no text, no tools.
    expect(blocks(frames).some((b) => b.kind === "text" || b.kind === "tool")).toBe(false);
  });

  test("prose that starts with a slash reaches the model unchanged", async () => {
    const h = harness(
      { "session.create": created, "prompt.submit": { result: PROMPT_SUBMIT_RESULT } },
      { "prompt.submit": RECORDED_TURN },
    );
    await collect(h.chat.send(BOX, "default", "/usr/local/bin is missing"));
    expect(dispatches(h.methods())).toEqual([]);
    const submit = h.sent.filter((s) => s.method === "prompt.submit");
    expect(submit).toHaveLength(1);
    expect(submit[0]?.params.text).toBe("/usr/local/bin is missing");
  });

  test("the argument's interior and its lines reach the gateway verbatim", async () => {
    const h = harness({
      "session.create": created,
      "slash.exec": { result: { output: "ok" } },
    });
    await collect(h.chat.send(BOX, "default", "/goal ship   it\n\n  second line"));
    expect(h.sent.find((s) => s.method === "slash.exec")?.params.command).toBe(
      "goal ship   it\n\n  second line",
    );
  });

  test("slash.exec's warning travels with its output", async () => {
    const h = harness({
      "session.create": created,
      "slash.exec": { result: { output: "model set", warning: "not mirrored to the live agent" } },
    });
    const [block] = commands(await collect(h.chat.send(BOX, "default", "/model x")));
    expect(block).toMatchObject({ output: "model set", warning: "not mirrored to the live agent" });
  });

  describe("every directive", () => {
    test("exec and plugin render their output and submit nothing", async () => {
      for (const type of ["exec", "plugin"] as const) {
        const h = harness({
          "session.create": created,
          "slash.exec": { result: { type, output: `${type} out` } },
        });
        const frames = await collect(h.chat.send(BOX, "default", "/thing"));
        expect(commands(frames)).toEqual([
          { kind: "command", command: "/thing", output: `${type} out`, state: "done", dispatch: type },
        ]);
        expect(h.methods()).not.toContain("prompt.submit");
      }
    });

    test("send shows its notice and submits its message, once, in the line's place", async () => {
      const h = harness(
        {
          "session.create": created,
          "slash.exec": { result: { type: "send", notice: "⊙ Goal set", message: "do the thing" } },
          "prompt.submit": { result: PROMPT_SUBMIT_RESULT },
        },
        { "prompt.submit": RECORDED_TURN },
      );
      const frames = await collect(h.chat.send(BOX, "default", "/goal do the thing"));
      expect(commands(frames)).toEqual([
        { kind: "command", command: "/goal", output: "⊙ Goal set", state: "done", dispatch: "send" },
      ]);
      const submits = h.sent.filter((s) => s.method === "prompt.submit");
      expect(submits.map((s) => s.params.text)).toEqual(["do the thing"]);
      expect(dispatches(h.methods())).toEqual(["slash.exec"]);
      expect(frames.at(-1)?.type).toBe("done");
      expect(blocks(frames).some((b) => b.kind === "text")).toBe(true);
    });

    test("skill falls through to command.dispatch and submits the expanded body", async () => {
      const h = harness(
        {
          "session.create": created,
          "slash.exec": {
            error: { code: 4018, message: "skill command: use command.dispatch for /work" },
          },
          "command.dispatch": {
            result: { type: "skill", name: "work", message: "<skill body>", display: "/work fix" },
          },
          "prompt.submit": { result: PROMPT_SUBMIT_RESULT },
        },
        { "prompt.submit": RECORDED_TURN },
      );
      const frames = await collect(h.chat.send(BOX, "default", "/Work fix"));
      expect(dispatches(h.methods())).toEqual(["slash.exec", "command.dispatch"]);
      expect(h.sent.find((s) => s.method === "command.dispatch")?.params).toEqual({
        session_id: SESSION_ID,
        name: "work",
        arg: "fix",
      });
      expect(h.sent.filter((s) => s.method === "prompt.submit").map((s) => s.params.text)).toEqual([
        "<skill body>",
      ]);
      // No notice, so nothing to show beyond the turn itself.
      expect(commands(frames)).toEqual([]);
    });

    test("alias dispatches its target with the same argument", async () => {
      const h = harness({
        "session.create": created,
        "slash.exec": (params) =>
          params.command === "h now"
            ? { result: { type: "alias", target: "help" } }
            : { result: { output: `ran ${String(params.command)}` } },
      });
      const frames = await collect(h.chat.send(BOX, "default", "/h now"));
      expect(h.sent.filter((s) => s.method === "slash.exec").map((s) => s.params.command)).toEqual([
        "h now",
        "help now",
      ]);
      expect(commands(frames)).toEqual([
        { kind: "command", command: "/help", output: "ran help now", state: "done" },
      ]);
      expect(h.methods()).not.toContain("prompt.submit");
    });

    test("an alias that never resolves is reported as a loop, not followed forever", async () => {
      const h = harness({
        "session.create": created,
        "slash.exec": { result: { type: "alias", target: "loop" } },
      });
      const [block] = commands(await collect(h.chat.send(BOX, "default", "/loop")));
      expect(block).toMatchObject({ state: "error", dispatch: "alias" });
      expect(block?.output).toContain("Alias loop");
      expect(h.sent.filter((s) => s.method === "slash.exec").length).toBeLessThanOrEqual(4);
    });

    test("prefill is reported unsupported, with the text it returned", async () => {
      const h = harness({
        "session.create": created,
        "slash.exec": { result: { type: "prefill", message: "my last message", notice: "↶ rewound" } },
      });
      const frames = await collect(h.chat.send(BOX, "default", "/undo"));
      const [block] = commands(frames);
      expect(block).toMatchObject({
        command: "/undo",
        state: "unsupported",
        dispatch: "prefill",
        prefill: "my last message",
      });
      expect(block?.output).toStartWith("↶ rewound\n");
      expect(h.methods()).not.toContain("prompt.submit");
    });

    test("a send with no message is an error, and nothing is submitted", async () => {
      const h = harness({
        "session.create": created,
        "slash.exec": { result: { type: "skill", name: "empty", message: "  " } },
      });
      const [block] = commands(await collect(h.chat.send(BOX, "default", "/empty")));
      expect(block).toMatchObject({ state: "error", dispatch: "skill" });
      expect(h.methods()).not.toContain("prompt.submit");
    });

    test("a directive this build cannot read is an error, not a silent drop", async () => {
      const h = harness({
        "session.create": created,
        "slash.exec": { result: { type: "teleport", output: "?" } },
      });
      const [block] = commands(await collect(h.chat.send(BOX, "default", "/beam")));
      expect(block?.state).toBe("error");
      expect(block?.output).toContain("cannot read");
    });
  });

  describe("unknown and unavailable commands", () => {
    test("the worker's unknown-command answer is shown as an error", async () => {
      const text =
        "Unknown command /nope — nothing was sent. Did you mean /new?\nType /help for the full list.";
      const h = harness({ "session.create": created, "slash.exec": { result: { output: text } } });
      const frames = await collect(h.chat.send(BOX, "default", "/nope"));
      expect(commands(frames)).toEqual([
        { kind: "command", command: "/nope", output: text, state: "error" },
      ]);
      expect(h.methods()).not.toContain("prompt.submit");
    });

    test("a command.dispatch refusal is shown as itself", async () => {
      const h = harness({
        "session.create": created,
        "slash.exec": {
          error: { code: 4018, message: "skill command: use command.dispatch for /gone" },
        },
        "command.dispatch": {
          error: { code: 4018, message: "not a quick/plugin/bundle/skill command: gone" },
        },
      });
      const [block] = commands(await collect(h.chat.send(BOX, "default", "/gone")));
      expect(block).toEqual({
        kind: "command",
        command: "/gone",
        output: "not a quick/plugin/bundle/skill command: gone",
        state: "error",
      });
      expect(h.methods()).not.toContain("prompt.submit");
    });

    test("a failed worker is the answer, never retried through command.dispatch", async () => {
      const h = harness({
        "session.create": created,
        "slash.exec": { error: { code: 5030, message: "slash worker timed out" } },
      });
      const [block] = commands(await collect(h.chat.send(BOX, "default", "/usage")));
      expect(block).toMatchObject({ state: "error", output: "slash worker timed out" });
      expect(dispatches(h.methods())).toEqual(["slash.exec"]);
    });

    test("a 4018 from a handler slash.exec already forwarded to is not re-dispatched", async () => {
      // `/undo` with nothing to undo: slash.exec forwarded it and it refused.
      // Dispatching again would run a mutating command twice.
      const h = harness({
        "session.create": created,
        "slash.exec": { error: { code: 4018, message: "nothing to undo" } },
      });
      const [block] = commands(await collect(h.chat.send(BOX, "default", "/undo")));
      expect(block).toMatchObject({ state: "error", output: "nothing to undo" });
      expect(dispatches(h.methods())).toEqual(["slash.exec"]);
    });

    test("a bare slash is reported, and nothing is dispatched or submitted", async () => {
      const h = harness({ "session.create": created });
      const [block] = commands(await collect(h.chat.send(BOX, "default", "/")));
      expect(block?.state).toBe("error");
      expect(dispatches(h.methods())).toEqual([]);
      expect(h.methods()).not.toContain("prompt.submit");
    });
  });

  test("a command with attachments is refused before anything is dispatched", async () => {
    const h = harness({ "session.create": created });
    const frames = await collect(
      h.chat.send(BOX, "default", "/help", {
        attachments: { ids: ["f_1"], commit: () => Promise.reject(new Error("never committed")) },
      }),
    );
    expect(commands(frames)[0]).toMatchObject({ command: "/help", state: "error" });
    expect(h.sent).toEqual([]);
  });

  describe("exactly once", () => {
    test("one line is one slash.exec and no prompt, whatever the directive", async () => {
      const replies: Reply[] = [
        { result: { output: "plain" } },
        { result: { type: "exec", output: "x" } },
        { result: { type: "plugin", output: "x" } },
        { result: { type: "prefill", message: "m" } },
        { error: { code: 5030, message: "worker died" } },
      ];
      for (const reply of replies) {
        const h = harness({ "session.create": created, "slash.exec": reply });
        await collect(h.chat.send(BOX, "default", "/cmd arg"));
        expect(dispatches(h.methods())).toEqual(["slash.exec"]);
        expect(h.methods()).not.toContain("prompt.submit");
      }
    });

    test("a command that becomes a prompt is submitted exactly once", async () => {
      const h = harness(
        {
          "session.create": created,
          "slash.exec": { result: { type: "send", message: "queued text" } },
          "prompt.submit": { result: PROMPT_SUBMIT_RESULT },
        },
        { "prompt.submit": RECORDED_TURN },
      );
      await collect(h.chat.send(BOX, "default", "/queue queued text"));
      expect(dispatches(h.methods())).toEqual(["slash.exec"]);
      expect(h.methods().filter((m) => m === "prompt.submit")).toHaveLength(1);
    });
  });

  test("only slash.exec's own disowning refusals fall through", () => {
    const refusal = (code: number, message: string) =>
      new HermeticError("CHAT_PROTOCOL", `veronica: ${message}`, { code });
    expect(dispatchFallback(refusal(4018, "skill command: use command.dispatch for /x"))).toBe(true);
    expect(
      dispatchFallback(
        refusal(
          4018,
          "snapshot restore mutates live config/state; use command.dispatch for /snapshot restore",
        ),
      ),
    ).toBe(true);
    expect(dispatchFallback(refusal(4018, "retry cannot safely reconstruct"))).toBe(false);
    expect(dispatchFallback(refusal(5030, "skill command: use command.dispatch for /x"))).toBe(false);
    expect(dispatchFallback(new Error("skill command: use command.dispatch for /x"))).toBe(false);
  });

  test("a command waits longer than a prompt's first frame", () => {
    expect(COMMAND_DEADLINE_MS).toBeGreaterThan(30_000);
  });
});
