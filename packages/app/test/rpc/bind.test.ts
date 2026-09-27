/**
 * The RPC binding, with no Electrobun anywhere.
 *
 * `createRpcBinding` takes `defineRPC` and `send` as arguments for exactly this
 * reason: the table it builds, the frames it pushes and the refusals it answers
 * with are all assertable against fakes, and the one thing that genuinely needs
 * a built app — `BrowserView.defineRPC` itself — is the one thing not exercised
 * here.
 *
 * The context is the fixture one `handlers/dispatch.test.ts` builds, so the
 * requests below run real handlers against the real fixture fleet.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { fleetTargetOf, openHermetic } from "@hermetic/core";
import { createChatOwner, type ChatOwner } from "../../src/chat-owner.ts";
import type { HandlerContext } from "../../src/handlers/ctx.ts";
import { HANDLERS } from "../../src/handlers/dispatch.ts";
import { createStreamRegistry, KEEPALIVE_EVENT } from "../../src/handlers/streams.ts";
import type { StreamFrame } from "../../src/handlers/streams.ts";
import { OpRegistry } from "../../src/ops.ts";
import { AppState, fixedInstance } from "../../src/state.ts";
import { INTERNAL_MESSAGE } from "../../src/errors.ts";
import {
  createRpcBinding,
  createStreamPump,
  refusalFor,
  RpcRefusal,
  STREAM_ENDED,
  type RpcBinding,
  type RpcOptions,
  type SendMessage,
} from "../../src/rpc/bind.ts";
import { MESSAGE_FOR_REQUEST, REQUEST_NAMES } from "../../src/rpc/schema.ts";
import type { WebviewMessages } from "../../src/rpc/schema.ts";
import { testHome } from "../home.ts";

const owners: ChatOwner[] = [];
const bindings: RpcBinding<unknown>[] = [];
afterAll(async () => {
  for (const binding of bindings.splice(0)) binding.close();
  for (const owner of owners.splice(0)) await owner.stop();
});

async function harness(): Promise<HandlerContext> {
  const home = testHome("hermetic-rpc-bind-");
  const hermetic = await openHermetic({ fixture: true, home });
  const state = new AppState({
    fixture: true,
    home,
    reopen: fixedInstance(hermetic),
    hermetic,
    target: hermetic.target === null ? null : fleetTargetOf(hermetic.target),
    poller: null,
  });
  const chatOwner = createChatOwner({ hermetic: () => state.hermetic });
  owners.push(chatOwner);
  return {
    state,
    hermetic: () => state.hermetic,
    ops: new OpRegistry(),
    poller: () => state.poller,
    chatOwner,
    fixture: true,
    opts: { fixture: true },
    streams: createStreamRegistry(),
  };
}

/** One push, as the page would have received it. */
interface Sent {
  name: keyof WebviewMessages;
  payload: WebviewMessages[keyof WebviewMessages];
}

function recorder(): { send: SendMessage; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send: (name, payload) => {
      sent.push({ name, payload });
    },
  };
}

/** Waits for a background pump to have pushed; the source runs on its own clock. */
async function until(done: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The binding, plus the options it handed `defineRPC` and the pushes it made. */
async function bound(): Promise<{
  ctx: HandlerContext;
  options: RpcOptions;
  sent: Sent[];
  request(name: string, params: unknown): Promise<unknown>;
  close(): void;
}> {
  const ctx = await harness();
  const { send, sent } = recorder();
  // A box rather than a plain `let`: the assignment happens inside a callback,
  // which narrowing does not follow.
  const captured: { options: RpcOptions | null } = { options: null };
  const binding = createRpcBinding({
    defineRPC: (options) => {
      captured.options = options;
      return { defined: true };
    },
    send,
    ctx,
  });
  bindings.push(binding);
  const options = captured.options;
  if (options === null) throw new Error("createRpcBinding must call defineRPC synchronously");
  return {
    ctx,
    options,
    sent,
    request: (name, params) => {
      const handler = options.handlers.requests[name];
      if (handler === undefined) throw new Error(`no request named ${name}`);
      return Promise.resolve(handler(params as never));
    },
    close: binding.close,
  };
}

describe("the contract and the dispatch table", () => {
  test("every name in the contract is a name dispatch knows, and the reverse", () => {
    expect(([...REQUEST_NAMES] as string[]).sort()).toEqual(Object.keys(HANDLERS).sort());
  });

  test("every streaming name is a request the contract carries", () => {
    const unknown = Object.keys(MESSAGE_FOR_REQUEST).filter(
      (name) => !(REQUEST_NAMES as readonly string[]).includes(name),
    );
    expect(unknown).toEqual([]);
  });

  test("the binding registers one handler per contract name", async () => {
    const { options } = await bound();
    expect(Object.keys(options.handlers.requests).sort()).toEqual(
      ([...REQUEST_NAMES] as string[]).sort(),
    );
  });

  test("requests never time out", async () => {
    // A create runs for twenty minutes and there is no socket to drop, so a
    // deadline could only abandon work the page still wants.
    const { options } = await bound();
    expect(options.maxRequestTime).toBe(Number.POSITIVE_INFINITY);
  });

  test("the page's one message is answered", async () => {
    const { options } = await bound();
    expect(Object.keys(options.handlers.messages ?? {})).toEqual(["page.ready"]);
  });
});

describe("answers and refusals", () => {
  test("a plain request answers with what the handler returned", async () => {
    const { request } = await bound();
    expect(await request("ops.list", {})).toEqual({ ops: [], next_cursor: null });
  });

  test("a refusal carries the code and the message, and no stack", async () => {
    const { request } = await bound();
    const thrown = await request("ops.get", { id: "nope" }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(RpcRefusal);
    const refusal = thrown as RpcRefusal;
    expect(refusal.body.code).toBe("NOT_FOUND");
    expect(refusal.stack).toBeUndefined();
  });

  test("a validation refusal carries the issues the caller can act on", async () => {
    const { request } = await bound();
    const refusal = (await request("ops.get", {}).catch((e: unknown) => e)) as RpcRefusal;
    expect(refusal.body.details).toHaveProperty("issues");
  });

  test("an unclassified throw tells the page nothing and the log everything", () => {
    const { refusal, internal } = refusalFor(new TypeError("cannot read x of undefined"));
    expect(refusal.body).toEqual({ code: "INTERNAL", message: INTERNAL_MESSAGE });
    expect(internal).toBe("cannot read x of undefined");
  });
});

describe("the stream pump", () => {
  const frame = (event: string, data: unknown): StreamFrame => ({ event, data });

  test("frames emitted before the id is known are flushed in order once it is", async () => {
    const { send, sent } = recorder();
    const pump = createStreamPump("logs.line", { name: "atlas" }, send);
    await pump.sink(frame("line", { text: "one" }));
    await pump.sink(frame("line", { text: "two" }));
    expect(sent).toEqual([]);

    pump.settle({ stream_id: "s1" });
    expect(sent).toEqual([
      { name: "logs.line", payload: { stream_id: "s1", line: { text: "one" } } },
      { name: "logs.line", payload: { stream_id: "s1", line: { text: "two" } } },
    ]);
  });

  test("frames after the id is known go straight out", async () => {
    const { send, sent } = recorder();
    const pump = createStreamPump("logs.line", {}, send);
    pump.settle({ stream_id: "s1" });
    await pump.sink(frame("line", { text: "late" }));
    expect(sent).toEqual([{ name: "logs.line", payload: { stream_id: "s1", line: { text: "late" } } }]);
  });

  test("the terminal frame is split out, so a reader can stop without inspecting one", async () => {
    const { send, sent } = recorder();
    const pump = createStreamPump("logs.line", {}, send);
    pump.settle({ stream_id: "s1" });
    await pump.sink(frame("done", { ok: true }));
    expect(sent[0]?.payload).toEqual({ stream_id: "s1", done: { ok: true } });
  });

  test("an op subscription correlates on the op the page named, not on the stream", async () => {
    const { send, sent } = recorder();
    const pump = createStreamPump("op.event", { op_id: "op-7" }, send);
    // Nothing is buffered: the correlator arrived with the request.
    await pump.sink(frame("event", { phase: "plan" }));
    expect(sent).toEqual([
      { name: "op.event", payload: { op_id: "op-7", msg: frame("event", { phase: "plan" }) } },
    ]);
  });

  test("keepalives are dropped: there is no idle socket to prove alive", async () => {
    const { send, sent } = recorder();
    const pump = createStreamPump("fleet.event", {}, send);
    pump.settle({ stream_id: "s1" });
    await pump.sink(frame(KEEPALIVE_EVENT, null));
    expect(sent).toEqual([]);
  });

  test("a refused request's buffered frames belong to nothing and are dropped", async () => {
    const { send, sent } = recorder();
    const pump = createStreamPump("chat.frame", {}, send);
    await pump.sink(frame("delta", { text: "hi" }));
    pump.abandon();
    pump.settle({ stream_id: "s1" });
    expect(sent).toEqual([]);
  });
});

describe("a pump with nothing to correlate to", () => {
  const frame = (event: string, data: unknown): StreamFrame => ({ event, data });

  /**
   * The mutation both of these hold: drop the `dead` flag and `sink` goes on
   * appending to a buffer that can never be flushed. The source does not stop
   * when the request is refused — it was started before the refusal and runs
   * under its own controller — so the array grows for as long as it does,
   * which for a fleet subscription is the life of the window.
   */
  test("stops buffering after the answer carried no stream id", async () => {
    const { send, sent } = recorder();
    const pump = createStreamPump("logs.line", {}, send);
    pump.settle({ not_a_stream: true });
    await pump.sink(frame("line", { text: "after" }));
    expect(pump.pending()).toBe(0);
    pump.settle({ stream_id: "s1" });
    expect(sent).toEqual([]);
  });

  test("stops buffering after the request was refused", async () => {
    const { send, sent } = recorder();
    const pump = createStreamPump("logs.line", {}, send);
    pump.abandon();
    await pump.sink(frame("line", { text: "after" }));
    expect(pump.pending()).toBe(0);
    pump.settle({ stream_id: "s1" });
    expect(sent).toEqual([]);
  });
});

describe("a stream that ends without saying so", () => {
  const frame = (event: string, data: unknown): StreamFrame => ({ event, data });

  /**
   * The mutation these hold: remove `end()`'s push and a page reader waits for
   * the life of the window. Over HTTP the socket closing was the terminal;
   * there is no socket here, and three sources end in silence — an aged-out op,
   * a turn that ended on an `error` frame, and any source that threw into a
   * handler's bare `catch {}` (`streams.ts` forbids `done` rejecting).
   */
  test("is closed with a synthetic terminal", async () => {
    const { send, sent } = recorder();
    const pump = createStreamPump("logs.line", {}, send);
    pump.settle({ stream_id: "s1" });
    pump.end();
    expect(sent).toEqual([{ name: "logs.line", payload: { stream_id: "s1", done: STREAM_ENDED } }]);
  });

  test("but a stream that said so is not closed twice", async () => {
    const { send, sent } = recorder();
    const pump = createStreamPump("logs.line", {}, send);
    pump.settle({ stream_id: "s1" });
    await pump.sink(frame("done", { ok: true }));
    pump.end();
    expect(sent).toHaveLength(1);
  });

  test("and a long-lived feed gets no terminal at all", async () => {
    // `fleet.subscribe` and `chat.subscribe` end when the *reader* closes them.
    // Their readers have no terminal to be waiting on, so a synthetic `done`
    // would be a frame with no meaning at the other end.
    const { send, sent } = recorder();
    const pump = createStreamPump("fleet.event", {}, send);
    pump.settle({ stream_id: "s1" });
    pump.end();
    expect(sent).toEqual([]);
  });

  test("a real source that dies silently still closes the page's reader", async () => {
    // `logs` on a name core refuses: the handler has already answered with a
    // `stream_id`, and the throw lands in its `catch {}` with nothing written
    // to the sink. This is the end-to-end version of the case above, and the
    // one that proves the binding watches the handle's `done` at all.
    const { request, sent } = await bound();
    const opened = (await request("logs.open", { name: "ghost", source: "agent" })) as {
      stream_id: string;
    };
    await until(() => sent.length > 0);
    expect(sent).toEqual([
      { name: "logs.line", payload: { stream_id: opened.stream_id, done: STREAM_ENDED } },
    ]);
  });
});

describe("closing a window", () => {
  /**
   * The mutation this holds: drop `ctx.streams.closeAll()` from `close()` and
   * the stream below survives its window — a fan-in listener attached to the
   * chat owner for the life of the process, pushing frames at a page that is
   * gone. Verified red by removing that call.
   */
  test("the streams a window opened do not outlive it", async () => {
    const { ctx, request, close } = await bound();
    const opened = (await request("chat.subscribe", {})) as { stream_id: string };
    expect(ctx.streams.has(opened.stream_id)).toBe(true);

    close();

    expect(ctx.streams.has(opened.stream_id)).toBe(false);
  });
});
