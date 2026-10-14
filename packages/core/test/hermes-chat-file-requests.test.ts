/**
 * Request cards (`request_file`, `await_file`, `request_secret`): the render
 * hint, the one id core takes from such a call, and the slot lookup that gives
 * a running card the slot its tool opened.
 */
import { describe, expect, test } from "bun:test";
import { toolBlock } from "../src/chat/hermes/hermes-chat-blocks.ts";
import {
  toolRequestId,
  turnFileRequests,
  type FileRequestLookupDeps,
} from "../src/chat/hermes/hermes-chat-file-requests.ts";
import { createHermesChat, mapHistory } from "../src/chat/hermes/hermes-chat.ts";
import type { BoxAddress, ChatFetch, ChatSocket } from "../src/chat/hermes/hermes-chat.ts";
import { ChatMessage } from "../src/schema/index.ts";
import type { ChatBlock, ChatFrame, FileRequest } from "../src/schema/index.ts";
import {
  DASHBOARD_HTML,
  eventFrame,
  PROMPT_SUBMIT_RESULT,
  SESSION_CREATE_RESULT,
  SESSION_ID,
  STORED_SESSION_ID,
} from "./fixtures/hermes-frames.ts";

type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;

const BOX: BoxAddress = {
  instance: "sindri",
  baseUrl: "https://fxtr0001-sindri.tail0000.ts.net/",
  fleet_id: "fxtr0001",
};
const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function slot(over: Partial<FileRequest> & { request_id: string }): FileRequest {
  return {
    kind: "file",
    purpose: "the log",
    accept: [],
    max_bytes: 1024,
    sensitivity: "normal",
    durable: false,
    state: "open",
    created_at: iso(T0 + 200),
    expires_at: iso(T0 + 7_200_000),
    session_id: SESSION_ID,
    ...over,
  };
}

function running(name: string, tool_id: string, args: unknown = { purpose: "the log" }): ToolBlock {
  const block = toolBlock({ tool_id, name, args }, "running");
  if (block.kind !== "tool") throw new Error("not a tool block");
  return block;
}

/** A lookup whose sleep is instant and whose list answers from a script, one entry per read. */
function lookup(
  reads: readonly (readonly FileRequest[] | Error)[],
  over: Partial<FileRequestLookupDeps> = {},
): FileRequestLookupDeps & { calls: number } {
  const deps: FileRequestLookupDeps & { calls: number } = {
    calls: 0,
    list: (): Promise<readonly FileRequest[]> => {
      const answer = reads[Math.min(deps.calls, reads.length - 1)] ?? [];
      deps.calls += 1;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    now: () => T0,
    sleep: () => Promise.resolve(),
    ...over,
  };
  return deps;
}

/** Races a never-settling step, so only a lookup can answer. */
const never = new Promise<never>(() => undefined);

async function found(requests: ReturnType<typeof turnFileRequests>): Promise<ToolBlock | null> {
  const raced = await requests.race(Promise.race([never, Bun.sleep(50).then(() => "idle" as const)]));
  return "block" in raced ? raced.block : null;
}

describe("render hints", () => {
  test("request tools map to file_request / secret_request; others keep their shape", () => {
    expect(running("request_file", "c1").render).toBe("file_request");
    expect(running("await_file", "c1").render).toBe("file_request");
    expect(running("request_secret", "c1").render).toBe("secret_request");
    const shell = running("bash", "c1");
    expect(shell.render).toBe("terminal");
    expect("request_id" in shell).toBe(false);
    expect(running("share_file", "c1").render).toBeNull();
  });
});

describe("toolRequestId", () => {
  test("await_file's argument names its slot", () => {
    expect(toolRequestId("await_file", { request_id: "fr_abcdefabcdef" }, null)).toBe(
      "fr_abcdefabcdef",
    );
    expect(running("await_file", "c1", { request_id: "fr_abcdefabcdef" }).request_id).toBe(
      "fr_abcdefabcdef",
    );
  });

  test("a request_file / request_secret argument is never trusted", () => {
    expect(toolRequestId("request_file", { request_id: "fr_abcdefabcdef" }, null)).toBeNull();
    expect(toolRequestId("request_secret", { request_id: "fr_abcdefabcdef" }, null)).toBeNull();
    expect(running("request_file", "c1", { request_id: "fr_abcdefabcdef" }).request_id).toBeNull();
  });

  test("the plugin's result names the slot, as an object or a JSON string", () => {
    const result = { status: "fulfilled", request_id: "fr_abcdefabcdef" };
    expect(toolRequestId("request_file", {}, result)).toBe("fr_abcdefabcdef");
    expect(toolRequestId("request_secret", {}, JSON.stringify(result))).toBe("fr_abcdefabcdef");
    const done = toolBlock(
      { tool_id: "c1", name: "request_file", result: JSON.stringify(result) },
      null,
    );
    expect(done.kind === "tool" && done.request_id).toBe("fr_abcdefabcdef");
  });

  test("something that is not a request id is ignored", () => {
    expect(toolRequestId("await_file", { request_id: "f_abcdefabcdef" }, null)).toBeNull();
    expect(toolRequestId("await_file", {}, { request_id: "fr_../../etc" })).toBeNull();
    expect(toolRequestId("request_file", {}, "not json")).toBeNull();
    expect(toolRequestId("bash", {}, { request_id: "fr_abcdefabcdef" })).toBeNull();
  });
});

describe("history", () => {
  test("a request row carries the result's id; no box is asked", () => {
    const result = { status: "fulfilled", request_id: "fr_abcdefabcdef", deliver_with: [] };
    const messages = mapHistory(BOX, STORED_SESSION_ID, {
      messages: [
        {
          id: 1,
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call-1", function: { name: "request_file", arguments: '{"purpose":"the log"}' } },
            {
              id: "call-2",
              function: { name: "await_file", arguments: '{"request_id":"fr_000000000002"}' },
            },
          ],
        },
        { id: 2, role: "tool", tool_call_id: "call-1", content: JSON.stringify(result) },
      ],
    });
    const tools = messages.flatMap((m) => m.blocks).filter((b): b is ToolBlock => b.kind === "tool");
    expect(tools.map((t) => [t.name, t.render, t.request_id])).toEqual([
      // The unanswered call stays on the assistant row; the answered one is its result row.
      ["await_file", "file_request", "fr_000000000002"],
      ["request_file", "file_request", "fr_abcdefabcdef"],
    ]);
    for (const message of messages) ChatMessage.parse(message);
  });
});

describe("turnFileRequests", () => {
  const ctx = { box: BOX, sessions: [SESSION_ID, STORED_SESSION_ID] };

  test("finds the oldest matching slot and re-sends the same card with it", async () => {
    const deps = lookup([
      [],
      [
        slot({ request_id: "fr_older0000001", created_at: iso(T0 + 100) }),
        slot({ request_id: "fr_newer0000002", created_at: iso(T0 + 300) }),
      ],
    ]);
    const requests = turnFileRequests(deps, ctx);
    const first = requests.tool(running("request_file", "c1"));
    expect(first.request_id).toBeNull();
    const again = await found(requests);
    expect(again).toMatchObject({ tool_id: "c1", status: "running", request_id: "fr_older0000001" });
    expect(deps.calls).toBe(2);
    requests.close();
  });

  test("filters on kind, session and time", async () => {
    const deps = lookup([
      [
        slot({ request_id: "fr_secrettext01", kind: "secret_text" }),
        slot({ request_id: "fr_othersessn01", session_id: "someone-else" }),
        slot({ request_id: "fr_nosession001", session_id: undefined }),
        slot({ request_id: "fr_tooold000001", created_at: iso(T0 - 60_000) }),
        slot({
          request_id: "fr_stored000001",
          session_id: STORED_SESSION_ID,
          created_at: iso(T0 - 1000),
        }),
      ],
    ]);
    const requests = turnFileRequests(deps, ctx);
    requests.tool(running("request_file", "c1"));
    expect((await found(requests))?.request_id).toBe("fr_stored000001");
    requests.close();

    const secret = turnFileRequests(
      lookup([[slot({ request_id: "fr_secrettext01", kind: "secret_text" })]]),
      ctx,
    );
    secret.tool(running("request_secret", "c2", { keys: ["GITHUB_TOKEN"] }));
    expect((await found(secret))?.request_id).toBe("fr_secrettext01");
    secret.close();
  });

  test("a slot one card owns is never handed to another", async () => {
    const both = [
      slot({ request_id: "fr_first0000001", created_at: iso(T0 + 100) }),
      slot({ request_id: "fr_second000002", created_at: iso(T0 + 200) }),
    ];
    const requests = turnFileRequests(lookup([both]), ctx);
    requests.tool(running("request_file", "c1"));
    const a = await found(requests);
    requests.tool(running("request_file", "c2"));
    const b = await found(requests);
    expect([a?.tool_id, a?.request_id, b?.tool_id, b?.request_id]).toEqual([
      "c1",
      "fr_first0000001",
      "c2",
      "fr_second000002",
    ]);
    // An id a completion named is claimed too.
    const claimed = turnFileRequests(lookup([[slot({ request_id: "fr_first0000001" })]]), ctx);
    const done = toolBlock(
      { tool_id: "c0", name: "request_file", result: { request_id: "fr_first0000001" } },
      null,
    );
    if (done.kind === "tool") claimed.tool(done);
    claimed.tool(running("request_file", "c1"));
    expect(await found(claimed)).toBeNull();
    requests.close();
    claimed.close();
  });

  test("parallel request_secret calls get distinct slots in call order, whichever poll sees them", async () => {
    const both = [
      slot({ request_id: "fr_parallel0002", kind: "secret_text", created_at: iso(T0 + 300) }),
      slot({ request_id: "fr_parallel0001", kind: "secret_text", created_at: iso(T0 + 100) }),
    ];
    // Either c1's first read sees both slots, or it sees nothing and c2's does.
    for (const reads of [[both], [[], both]]) {
      const requests = turnFileRequests(lookup(reads), ctx);
      requests.tool(running("request_secret", "c1", { keys: ["A_KEY"] }));
      requests.tool(running("request_secret", "c2", { keys: ["B_KEY"] }));
      const a = await found(requests);
      const b = await found(requests);
      const got = Object.fromEntries([a, b].map((x) => [x?.tool_id, x?.request_id]));
      expect(got).toEqual({ c1: "fr_parallel0001", c2: "fr_parallel0002" });
      requests.close();
    }
  });

  test("a slot a card in an earlier turn on the session claimed is not grabbed", async () => {
    const first = slot({ request_id: "fr_turnone00001", created_at: iso(T0 + 100) });
    const second = slot({ request_id: "fr_turntwo00001", created_at: iso(T0 + 200) });
    // One client's deps across turns. The first slot stays open: its agent still waits.
    let box: readonly FileRequest[] = [first];
    const deps = lookup([], { list: () => Promise.resolve(box) });
    const one = turnFileRequests(deps, ctx);
    one.tool(running("request_file", "c1"));
    expect((await found(one))?.request_id).toBe("fr_turnone00001");
    one.close();

    const idle = turnFileRequests(deps, ctx);
    idle.tool(running("request_file", "c2"));
    expect(await found(idle)).toBeNull();
    idle.close();

    box = [first, second];
    const two = turnFileRequests(deps, ctx);
    two.tool(running("request_file", "c3"));
    expect(await found(two)).toMatchObject({ tool_id: "c3", request_id: "fr_turntwo00001" });
    two.close();

    // Another client (its own deps) has no such history.
    const other = turnFileRequests(lookup([[first]]), ctx);
    other.tool(running("request_file", "c1"));
    expect((await found(other))?.request_id).toBe("fr_turnone00001");
    other.close();
  });

  test("only open or receiving slots match; a slot made long after the call does", async () => {
    const deps = lookup([
      [
        slot({ request_id: "fr_fulfilled001", state: "fulfilled", created_at: iso(T0 - 100) }),
        slot({ request_id: "fr_declined0001", state: "declined", created_at: iso(T0) }),
        slot({ request_id: "fr_expired00001", state: "expired", created_at: iso(T0 + 10) }),
        slot({ request_id: "fr_consumed0001", state: "consumed", created_at: iso(T0 + 20) }),
        slot({ request_id: "fr_receiving001", state: "receiving", created_at: iso(T0 + 600_000) }),
      ],
    ]);
    const requests = turnFileRequests(deps, ctx);
    requests.tool(running("request_file", "c1"));
    expect((await found(requests))?.request_id).toBe("fr_receiving001");
    requests.close();

    const none = turnFileRequests(
      lookup([[slot({ request_id: "fr_declined0002", state: "declined" })]]),
      ctx,
    );
    none.tool(running("request_file", "c1"));
    expect(await found(none)).toBeNull();
    none.close();
  });

  test("retries a bounded number of times, then leaves the card without an id", async () => {
    const deps = lookup([new Error("box unreachable"), []], { attempts: 4 });
    const requests = turnFileRequests(deps, ctx);
    requests.tool(running("request_file", "c1"));
    expect(await found(requests)).toBeNull();
    expect(deps.calls).toBe(4);
    requests.close();
  });

  test("the turn's abort stops the lookup", async () => {
    const controller = new AbortController();
    let wake: () => void = () => undefined;
    const deps = lookup([[slot({ request_id: "fr_late00000001" })]], {
      sleep: () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
    });
    const requests = turnFileRequests(deps, { ...ctx, signal: controller.signal });
    requests.tool(running("request_file", "c1"));
    controller.abort();
    wake();
    expect(await found(requests)).toBeNull();
    expect(deps.calls).toBe(0);
    requests.close();
  });

  test("a completion settles the card: its id is kept, and a late lookup is dropped", async () => {
    let wake: () => void = () => undefined;
    const deps = lookup([[slot({ request_id: "fr_late00000001" })]], {
      sleep: () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
    });
    const requests = turnFileRequests(deps, ctx);
    requests.tool(running("request_file", "c1"));
    const done = toolBlock(
      {
        tool_id: "c1",
        name: "request_file",
        result: { status: "pending", request_id: "fr_fromresult01" },
      },
      null,
    );
    if (done.kind !== "tool") throw new Error("not a tool");
    expect(requests.tool(done).request_id).toBe("fr_fromresult01");
    wake();
    expect(await found(requests)).toBeNull();
    requests.close();
  });

  test("await_file and a card without a tool_id start no lookup; no deps, no lookup", async () => {
    const deps = lookup([[slot({ request_id: "fr_any000000001" })]]);
    const requests = turnFileRequests(deps, ctx);
    expect(
      requests.tool(running("await_file", "c1", { request_id: "fr_abcdefabcdef" })).request_id,
    ).toBe("fr_abcdefabcdef");
    const anonymous = toolBlock({ name: "request_file", args: {} }, "running");
    if (anonymous.kind === "tool") requests.tool(anonymous);
    expect(await found(requests)).toBeNull();
    expect(deps.calls).toBe(0);
    const bare = turnFileRequests(undefined, ctx);
    expect(bare.tool(running("request_file", "c1")).request_id).toBeNull();
    expect(await found(bare)).toBeNull();
    requests.close();
    bare.close();
  });
});

/* ── through a live turn ──────────────────────────────────────────────────── */

function liveClient(list: () => Promise<readonly FileRequest[]>) {
  const pushes: ((frame: string) => void)[] = [];
  const fetchImpl: ChatFetch = () =>
    Promise.resolve(
      new Response(DASHBOARD_HTML, { status: 200, headers: { "content-type": "text/html" } }),
    );
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
    pushes.push(push);
    const results: Record<string, unknown> = {
      "session.create": SESSION_CREATE_RESULT,
      "prompt.submit": PROMPT_SUBMIT_RESULT,
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
        const doc = JSON.parse(data) as { id: number; method: string };
        push(JSON.stringify({ jsonrpc: "2.0", id: doc.id, result: results[doc.method] ?? {} }));
        if (doc.method === "prompt.submit")
          push(
            eventFrame("tool.start", 1, {
              tool_id: "call-1",
              name: "request_file",
              args: { purpose: "x" },
            }),
          );
      },
      close: () => {
        done = true;
        const w = wake;
        wake = null;
        w?.();
      },
    };
  };
  const client = createHermesChat({
    fetch: fetchImpl,
    openSocket,
    now: () => iso(T0),
    slotWaitMs: 2000,
    pooled: false,
    listFileRequests: (instance) => {
      expect(instance).toBe("sindri");
      return list();
    },
  });
  return { client, push: (frame: string) => pushes.at(-1)?.(frame) };
}

describe("a live turn", () => {
  test("the running card is sent again with the slot the box opened, before the tool completes", async () => {
    const { client, push } = liveClient(() =>
      Promise.resolve([slot({ request_id: "fr_livelookup01", session_id: STORED_SESSION_ID })]),
    );
    const tools: ToolBlock[] = [];
    const out: ChatFrame[] = [];
    for await (const frame of client.send(BOX, "default", "need the log")) {
      out.push(frame);
      if (frame.type !== "block" || frame.block.kind !== "tool") continue;
      tools.push(frame.block);
      if (frame.block.request_id && frame.block.status === "running") {
        push(
          eventFrame("tool.complete", 2, {
            tool_id: "call-1",
            name: "request_file",
            result: '{"status":"declined","request_id":"fr_livelookup01","deliver_with":[]}',
          }),
        );
        push(eventFrame("message.complete", 3, { text: "ok", status: "complete" }));
      }
    }
    expect(tools.map((t) => [t.tool_id, t.status, t.request_id])).toEqual([
      ["call-1", "running", null],
      ["call-1", "running", "fr_livelookup01"],
      ["call-1", "ok", "fr_livelookup01"],
    ]);
    expect(out.at(-1)?.type).toBe("done");
  });
});
