/**
 * The RPC transport, against a fake `Electroview`.
 *
 * The real one comes from the Hutch devkit and only exists behind a `views://`
 * page, so what is provable here is the mapping — a request name to a bridge
 * call, a push to a `StreamFrame`, a close to its closing request — which is
 * exactly the half that can drift without anybody noticing until the desktop
 * build is the only build.
 *
 * The load-bearing case is the replay cursor. Nothing resumes an op stream on
 * the transport's behalf, so it has to remember the last frame it saw and put
 * it back on the second `ops.subscribe` itself. Nothing above the seam would
 * report the loss: a resubscribe that replayed from zero looks like an op with
 * duplicate events, and `makeFrameFilter` swallows those silently.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "../src/api/errors.ts";
import {
  type ElectroviewLike,
  type RpcHandle,
  asFailure,
  createRpcTransport,
  failureOf,
  sendPageReady,
} from "../src/api/transport-rpc.ts";
import { electrobunRequest } from "./electrobun-request.ts";
import { clearPageVisible, isVisible } from "../src/lib/visibility.ts";
import { clearAppUpdate, onAppUpdate } from "../src/state/app-update-state.tsx";
import type { StreamFrame } from "../src/api/transport.ts";

/**
 * Building a transport seeds the page visible (`lib/visibility.ts`), and that
 * state is the module's, not this file's: bun runs every test file in one
 * process, and a page pinned visible here would silence the return-to-visible
 * tests that stub `document` instead (`room-poll`, `view-ack`, `idle-reads`).
 */
afterEach(clearPageVisible);

/** Lets every queued microtask and timer-zero callback run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Bridge {
  Electroview: ElectroviewLike;
  /** Every request the transport made, in order. */
  sent: { name: string; params: unknown }[];
  /** Every `bun.messages` name the page sent, in order. */
  messagesSent: { name: string; payload: unknown }[];
  /** Canned answers by request name; an `Error` value rejects instead. */
  answers: Map<string, unknown>;
  /** Push one `webview.messages` payload at the page, as the main process would. */
  push: (name: string, payload: unknown) => void;
}

function makeBridge(): Bridge {
  const sent: { name: string; params: unknown }[] = [];
  const answers = new Map<string, unknown>();
  let messages: Record<string, (payload: never) => unknown> = {};

  const request = electrobunRequest((name, params) => {
    sent.push({ name, params });
    const answer = answers.get(name);
    if (answer instanceof Error) return Promise.reject(answer);
    if (typeof answer === "object" && answer !== null && "reject" in answer) {
      return Promise.reject((answer as { reject: unknown }).reject);
    }
    return Promise.resolve(answer ?? {});
  });
  const messagesSent: { name: string; payload: unknown }[] = [];
  const handle: RpcHandle = {
    request,
    send: (name, payload) => {
      messagesSent.push({ name: String(name), payload });
    },
  };

  class FakeElectroview {
    constructor(readonly options: { rpc?: RpcHandle }) {}
    static defineRPC(options: {
      handlers: { messages?: Record<string, (payload: never) => unknown> };
    }): RpcHandle {
      messages = options.handlers.messages ?? {};
      return handle;
    }
  }

  return {
    Electroview: FakeElectroview as unknown as ElectroviewLike,
    sent,
    messagesSent,
    answers,
    push: (name, payload) => {
      (messages[name] as ((payload: unknown) => unknown) | undefined)?.(payload);
    },
  };
}

/** A `StreamHandlers` that records everything, so a test can assert on the sequence. */
function recorder() {
  const frames: StreamFrame[] = [];
  const ends: { ok: boolean; failure: { code: string; message: string } | null }[] = [];
  return {
    frames,
    ends,
    handlers: {
      onFrame: (frame: StreamFrame) => {
        frames.push(frame);
      },
      onEnd: (ok: boolean, failure: { code: string; message: string } | null) => {
        ends.push({ ok, failure });
      },
    },
  };
}

describe("request", () => {
  test("a request name reaches the bridge under the app's own name for it", async () => {
    const bridge = makeBridge();
    bridge.answers.set("init.verifyOauth", { ok: true });
    bridge.answers.set("agents.list", { agents: [] });
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    // The one divergence between `RequestName` and the app's machinery names.
    await transport.request("init.tailscale.oauth", { client_id: "FIXTURE" });
    await transport.request("agents.list", {});

    expect(bridge.sent.map((s) => s.name)).toEqual(["init.verifyOauth", "agents.list"]);
    expect(bridge.sent[0]?.params).toEqual({ client_id: "FIXTURE" });
  });

  // `apply` shares its name with `Function.prototype.apply`, which Electrobun's
  // request proxy returns in preference to a request stub. Reached through
  // `request[name]`, it sent a request with no method and the app answered
  // "The requested method has no handler: undefined" — the destroy flow's
  // second step.
  test("`apply` reaches the bridge as `apply`", async () => {
    const bridge = makeBridge();
    bridge.answers.set("apply", { op_id: "op-1" });
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    const answer = await transport.request("apply", { plan: {}, yes: true });

    expect(bridge.sent).toEqual([{ name: "apply", params: { plan: {}, yes: true } }]);
    expect(answer).toEqual({ op_id: "op-1" });
  });

  test("a refusal becomes the same `ApiError` the HTTP transport throws", async () => {
    const bridge = makeBridge();
    bridge.answers.set("agents.create", {
      reject: { code: "NAME_TAKEN", message: "already an agent called atlas", op_id: "op7" },
    });
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    const failure = await transport.request("agents.create", { name: "atlas" }).catch((e) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("NAME_TAKEN");
    expect((failure as ApiError).opId).toBe("op7");
  });

  test("an aborted request settles as aborted, and the late answer is dropped", async () => {
    const bridge = makeBridge();
    // An answer this test settles by hand, so the abort provably wins the race.
    // Held on an object rather than a `let`, which `tsc` would narrow to `never`
    // for not seeing that a promise executor runs synchronously.
    const late = { answer: (_value: unknown): void => {} };
    bridge.answers.set(
      "doctor",
      new Promise((resolve) => {
        late.answer = resolve;
      }),
    );
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    const controller = new AbortController();
    const pending = transport
      .request("doctor", {}, { signal: controller.signal })
      .then(() => "resolved")
      .catch((e: Error) => e.name);
    controller.abort();
    expect(await pending).toBe("AbortError");

    // The bridge has no cancel, so the answer still turns up — and is dropped,
    // rather than delivered to a caller that already gave up.
    late.answer({ ok: true });
    await settle();
    expect(await pending).toBe("AbortError");
  });
});

describe("subscribe", () => {
  test("joins the feed, routes its pushes, and closes with the matching request", async () => {
    const bridge = makeBridge();
    bridge.answers.set("fleet.subscribe", { stream_id: "feed-1" });
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    const frames: StreamFrame[] = [];
    const connected: boolean[] = [];
    const retries: number[] = [];
    const stop = transport.subscribe("fleet", null, {
      onFrame: (f) => frames.push(f),
      onConnected: (c) => connected.push(c),
      onRetryIn: (ms) => retries.push(ms),
    });
    await settle();

    expect(bridge.sent[0]).toEqual({ name: "fleet.subscribe", params: {} });
    expect(connected).toEqual([true]);

    bridge.push("fleet.event", { event: { event: "agent", data: { name: "atlas" } } });
    bridge.push("fleet.event", { event: { event: "keepalive", data: null } });
    expect(frames).toEqual([{ event: "agent", id: "", data: { name: "atlas" } }]);

    stop();
    await settle();
    expect(bridge.sent.at(-1)).toEqual({
      name: "fleet.unsubscribe",
      params: { stream_id: "feed-1" },
    });
    // There is no socket to drop, so a reconnect is never scheduled.
    expect(retries).toEqual([]);
  });
});

describe("openStream", () => {
  test("a turn's frames route by `stream_id`, even the ones that beat the id back", async () => {
    const bridge = makeBridge();
    bridge.answers.set("chat.turn", { stream_id: "turn-1" });
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    const reader = recorder();
    transport.openStream(
      "chat.turn",
      { instance: "atlas", bot: "nous", message: "hi" },
      reader.handlers,
    );
    // Pushed before the answer named the stream. `chat.frame` carries the turn
    // frame alone, so the frame's own `type` is where its name comes from.
    bridge.push("chat.frame", { stream_id: "turn-1", frame: { type: "delta", text: "h" } });
    await settle();
    bridge.push("chat.frame", { stream_id: "turn-1", done: { type: "done", ok: true } });

    expect(reader.frames.map((f) => f.event)).toEqual(["delta", "done"]);
    expect(reader.ends).toEqual([{ ok: true, failure: null }]);
  });

  test("a console read closes with `logs.close` on the id it was given", async () => {
    const bridge = makeBridge();
    bridge.answers.set("logs.open", { stream_id: "log-1" });
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    const reader = recorder();
    const close = transport.openStream(
      "logs.open",
      { name: "atlas", source: "console" },
      reader.handlers,
    );
    await settle();
    bridge.push("logs.line", { stream_id: "log-1", line: "boot" });
    close();
    await settle();

    expect(reader.frames).toEqual([{ event: "line", id: "", data: "boot" }]);
    expect(bridge.sent.at(-1)).toEqual({ name: "logs.close", params: { stream_id: "log-1" } });
  });

  test("an open that refuses ends the stream with the refusal", async () => {
    const bridge = makeBridge();
    bridge.answers.set("ops.subscribe", { reject: { code: "NOT_FOUND", message: "no such op" } });
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    const reader = recorder();
    transport.openStream("ops.subscribe", { op_id: "gone" }, reader.handlers);
    await settle();

    expect(reader.ends).toEqual([{ ok: false, failure: { code: "NOT_FOUND", message: "no such op" } }]);
  });

  /**
   * The mutation proof. Break the cursor — send `after: undefined` always — and
   * this is the assertion that goes red; every other test in this file passes
   * with the cursor gone, which is the point of writing it out.
   */
  test("a reopened op stream resumes after the last frame it saw", async () => {
    const bridge = makeBridge();
    bridge.answers.set("ops.subscribe", { stream_id: "op-stream-1" });
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    const first = recorder();
    const close = transport.openStream("ops.subscribe", { op_id: "op1" }, first.handlers);
    await settle();
    for (const seq of [1, 2, 3]) {
      bridge.push("op.event", {
        op_id: "op1",
        msg: { event: "event", id: `1:${seq}`, data: { phase: "create", seq } },
      });
    }
    expect(first.frames.map((f) => f.id)).toEqual(["1:1", "1:2", "1:3"]);
    close();
    await settle();

    const second = recorder();
    transport.openStream("ops.subscribe", { op_id: "op1" }, second.handlers);
    await settle();

    const subscribes = bridge.sent.filter((s) => s.name === "ops.subscribe");
    expect(subscribes).toHaveLength(2);
    expect(subscribes[0]?.params).toEqual({ op_id: "op1" });
    expect(subscribes[1]?.params).toEqual({ op_id: "op1", after: { generation: 1, seq: 3 } });
  });
});

describe("page visibility", () => {
  /**
   * The webview reports `document.visibilityState === "hidden"` for the life of
   * the window and fires no `visibilitychange`, so every read the UI gates on
   * visibility would be gated off for ever: the roster read returns early when
   * hidden, so `chat.swarms` is never asked for and the bot rail reads "0
   * instances · 0 profiles" on a fleet whose instances are all being listened
   * to. The head's own answer is what the page reads instead.
   */
  test("building the transport seeds the page visible, before anything can read it", () => {
    clearPageVisible();
    const doc = { visibilityState: "hidden", hidden: true };
    const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
    try {
      // Without the seed this reads `document`, which lies.
      expect(isVisible()).toBe(false);
      createRpcTransport({ Electroview: makeBridge().Electroview });
      expect(isVisible()).toBe(true);
      // The webview's own state is never written, only ignored.
      expect(doc.visibilityState).toBe("hidden");
    } finally {
      clearPageVisible();
      if (saved === undefined) Reflect.deleteProperty(globalThis, "document");
      else Object.defineProperty(globalThis, "document", saved);
    }
  });

  test("an `app.visibility` push is what moves it after that", () => {
    clearPageVisible();
    const bridge = makeBridge();
    try {
      createRpcTransport({ Electroview: bridge.Electroview });
      expect(isVisible()).toBe(true);
      bridge.push("app.visibility", { visible: false });
      expect(isVisible()).toBe(false);
      bridge.push("app.visibility", { visible: true });
      expect(isVisible()).toBe(true);
    } finally {
      clearPageVisible();
    }
  });
});

/**
 * The bugs a single reader cannot see.
 *
 * Every case below is two things happening at once — two readers of one op, two
 * components mounting in the same tick, a close racing an open request — which
 * is exactly what the HTTP transport got for free from having a socket per
 * reader and what a shared bridge has to arrange for itself.
 */
describe("concurrency", () => {
  test("two readers of one op both get its frames, and one closing spares the other", async () => {
    const bridge = makeBridge();
    bridge.answers.set("ops.subscribe", { stream_id: "op-stream-1" });
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    const first = recorder();
    const second = recorder();
    const closeFirst = transport.openStream("ops.subscribe", { op_id: "op1" }, first.handlers);
    transport.openStream("ops.subscribe", { op_id: "op1" }, second.handlers);
    await settle();

    const push = (seq: number) => {
      bridge.push("op.event", {
        op_id: "op1",
        msg: { event: "event", id: `1:${seq}`, data: { seq } },
      });
    };
    push(1);
    closeFirst();
    push(2);

    expect(first.frames.map((f) => f.id)).toEqual(["1:1"]);
    // Without the fan-out, the second reader either never registered or was
    // deleted along with the first, and this is empty or one frame short.
    expect(second.frames.map((f) => f.id)).toEqual(["1:1", "1:2"]);
  });

  test("two subscribers in one tick open one subscription, and each frame arrives once", async () => {
    const bridge = makeBridge();
    bridge.answers.set("fleet.subscribe", { stream_id: "feed-1" });
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    const a: StreamFrame[] = [];
    const b: StreamFrame[] = [];
    const connected: boolean[] = [];
    transport.subscribe("fleet", null, {
      onFrame: (f) => a.push(f),
      onConnected: (c) => connected.push(c),
    });
    transport.subscribe("fleet", null, {
      onFrame: (f) => b.push(f),
      onConnected: (c) => connected.push(c),
    });
    await settle();

    expect(bridge.sent.filter((s) => s.name === "fleet.subscribe")).toHaveLength(1);
    expect(connected).toEqual([true, true]);

    bridge.push("fleet.event", { event: { event: "agent", data: { name: "atlas" } } });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test("unsubscribing before the open answers still closes the subscription", async () => {
    const bridge = makeBridge();
    let answer: ((value: unknown) => void) | undefined;
    bridge.answers.set(
      "fleet.subscribe",
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    const stop = transport.subscribe("fleet", null, {
      onFrame: () => {},
      onConnected: () => {},
    });
    stop();
    // The subscription only exists from here on: nothing the unsubscribe could
    // have closed existed when it ran.
    answer?.({ stream_id: "feed-9" });
    await settle();

    expect(bridge.sent.filter((s) => s.name === "fleet.unsubscribe")).toEqual([
      { name: "fleet.unsubscribe", params: { stream_id: "feed-9" } },
    ]);
  });
});

describe("the op cursor", () => {
  test("does not advance past frames that reached no reader", async () => {
    const bridge = makeBridge();
    bridge.answers.set("ops.subscribe", { stream_id: "op-stream-1" });
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    const reader = recorder();
    const close = transport.openStream("ops.subscribe", { op_id: "op1" }, reader.handlers);
    await settle();
    const push = (seq: number) => {
      bridge.push("op.event", {
        op_id: "op1",
        msg: { event: "event", id: `1:${seq}`, data: { seq } },
      });
    };
    push(1);
    close();
    // In flight when the close ran, and landing after it: the `ops.unsubscribe`
    // is a round trip, so the app goes on pushing for a moment. Nobody sees
    // these, so nothing may resume past them.
    push(2);
    push(3);

    transport.openStream("ops.subscribe", { op_id: "op1" }, recorder().handlers);
    await settle();

    const subscribes = bridge.sent.filter((s) => s.name === "ops.subscribe");
    expect(subscribes[1]?.params).toEqual({ op_id: "op1", after: { generation: 1, seq: 1 } });
  });

  test("is not moved by a reader that does not resume the op, but is cleared by its `done`", async () => {
    const bridge = makeBridge();
    bridge.answers.set("ops.subscribe", { stream_id: "op-stream-1" });
    const transport = createRpcTransport({ Electroview: bridge.Electroview });
    const push = (seq: number, event = "event") => {
      bridge.push("op.event", {
        op_id: "op1",
        msg: { event, id: `1:${seq}`, data: event === "done" ? { ok: true, error: null } : { seq } },
      });
    };

    // A drawer, and the board's watcher that only wants the op's end.
    const closeDrawer = transport.openStream("ops.subscribe", { op_id: "op1" }, recorder().handlers);
    const watcher = recorder();
    transport.openStream("ops.subscribe", { op_id: "op1" }, { ...watcher.handlers, resumes: false });
    await settle();
    push(1);
    closeDrawer();
    // The drawer is shut; only the watcher reads these.
    push(2);
    push(3);
    expect(watcher.frames.map((f) => f.id)).toEqual(["1:1", "1:2", "1:3"]);

    // The drawer reopened mid-op resumes where *it* stopped, not where the watcher did.
    transport.openStream("ops.subscribe", { op_id: "op1" }, recorder().handlers).call(null);
    await settle();
    let subscribes = bridge.sent.filter((s) => s.name === "ops.subscribe");
    expect(subscribes[2]?.params).toEqual({ op_id: "op1", after: { generation: 1, seq: 1 } });

    // The watcher's `done` still counts: the finished op replays whole.
    push(4, "done");
    expect(watcher.ends).toEqual([{ ok: true, failure: null }]);
    transport.openStream("ops.subscribe", { op_id: "op1" }, recorder().handlers);
    await settle();
    subscribes = bridge.sent.filter((s) => s.name === "ops.subscribe");
    expect(subscribes[3]?.params).toEqual({ op_id: "op1" });
  });

  test("is forgotten once the op is done, so a reopen replays the whole of it", async () => {
    const bridge = makeBridge();
    bridge.answers.set("ops.subscribe", { stream_id: "op-stream-1" });
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    const reader = recorder();
    transport.openStream("ops.subscribe", { op_id: "op1" }, reader.handlers);
    await settle();
    bridge.push("op.event", { op_id: "op1", msg: { event: "event", id: "1:1", data: {} } });
    bridge.push("op.event", {
      op_id: "op1",
      msg: { event: "done", id: "1:2", data: { ok: true, error: null } },
    });
    expect(reader.ends).toEqual([{ ok: true, failure: null }]);

    transport.openStream("ops.subscribe", { op_id: "op1" }, recorder().handlers);
    await settle();

    const subscribes = bridge.sent.filter((s) => s.name === "ops.subscribe");
    expect(subscribes[1]?.params).toEqual({ op_id: "op1" });
  });

  test("is bounded, evicting the op followed longest ago", async () => {
    const bridge = makeBridge();
    bridge.answers.set("ops.subscribe", { stream_id: "op-stream-1" });
    const transport = createRpcTransport({ Electroview: bridge.Electroview });

    // One frame each for more ops than the cap, oldest first.
    for (let n = 0; n < 70; n += 1) {
      const opId = `op${n}`;
      transport.openStream("ops.subscribe", { op_id: opId }, recorder().handlers);
      bridge.push("op.event", { op_id: opId, msg: { event: "event", id: "1:1", data: {} } });
    }
    await settle();
    const before = bridge.sent.length;

    transport.openStream("ops.subscribe", { op_id: "op0" }, recorder().handlers);
    transport.openStream("ops.subscribe", { op_id: "op69" }, recorder().handlers);
    await settle();

    const reopened = bridge.sent.slice(before);
    // The oldest cursor was evicted, so its op replays whole; the newest is
    // still remembered.
    expect(reopened[0]?.params).toEqual({ op_id: "op0" });
    expect(reopened[1]?.params).toEqual({ op_id: "op69", after: { generation: 1, seq: 1 } });
  });
});

/**
 * The refusal shape, from this side of the seam.
 *
 * `rpc/bind.ts` nests the refusal under `body` and the thrown error carries the
 * same fields flat; a transport that read only one of them would drop the code
 * every component branches on and hand up a bare `RPC_FAILED`. The root `tests/`
 * seam test drives the app's real throw against these same two functions.
 */
describe("asFailure", () => {
  test("reads a refusal flat on the error", () => {
    const failure = asFailure({ code: "NOT_FOUND", message: "no such agent" });
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("NOT_FOUND");
  });

  test("reads one nested under `body`, which is how the bridge throws it", () => {
    const thrown = Object.assign(new Error("RPC error"), {
      body: { code: "FLEET_MISMATCH", message: "wrong fleet", op_id: "op3", details: { a: 1 } },
    });
    const failure = asFailure(thrown);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("FLEET_MISMATCH");
    expect((failure as ApiError).opId).toBe("op3");
    expect((failure as ApiError).details).toEqual({ a: 1 });
    // And the same code reaches a stream's `onEnd`, not `RPC_FAILED`.
    expect(failureOf(thrown)).toEqual({ code: "FLEET_MISMATCH", message: "wrong fleet" });
  });

  test("passes anything that is not a refusal through untouched", () => {
    const boom = new Error("the bridge died");
    expect(asFailure(boom)).toBe(boom);
    expect(failureOf(boom).code).toBe("RPC_FAILED");
  });
});

/**
 * The two things on the bridge that are not a stream: the page's one outbound
 * message and the updater's broadcast.
 */
describe("the bridge beside the streams", () => {
  test("`page.ready` goes out on the handle the transport built", () => {
    const bridge = makeBridge();
    createRpcTransport({ Electroview: bridge.Electroview });
    expect(sendPageReady()).toBe(true);
    expect(bridge.messagesSent).toEqual([{ name: "page.ready", payload: {} }]);
  });

  test("an `app.update` push reaches its subscribers, and the last one is replayed", () => {
    const bridge = makeBridge();
    createRpcTransport({ Electroview: bridge.Electroview });
    clearAppUpdate();

    const seen: { status: string; version?: string }[] = [];
    const stop = onAppUpdate((update) => seen.push(update));
    bridge.push("app.update", { status: "available", version: "1.2.3" });
    expect(seen).toEqual([{ status: "available", version: "1.2.3" }]);
    stop();

    // A subscriber that arrives after the push still learns the state: the
    // next broadcast is six hours away (`main/updates.ts`).
    const late: { status: string; version?: string }[] = [];
    onAppUpdate((update) => late.push(update))();
    expect(late).toEqual([{ status: "available", version: "1.2.3" }]);

    // And a push after everybody unsubscribed is not an error.
    bridge.push("app.update", { status: "none" });
    expect(seen).toHaveLength(1);
    clearAppUpdate();
  });
});
