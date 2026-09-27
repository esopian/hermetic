/**
 * The dedicated chat sockets' liveness (plan: heartbeat on turn and watch).
 *
 * The failure this covers cannot be reached from the adapter's other tests,
 * because their fake box always answers: a tailnet drop *after* the first
 * content frame leaves a half-open socket that yields nothing and never ends.
 * `SLOT_WAIT_MS` has been spent by then, so before the heartbeat there was no
 * clock left running at all — a turn waited forever and a watch never noticed
 * it had stopped being watched.
 *
 * Everything here drives `readRpc` directly, with the two heartbeat numbers
 * injected down to milliseconds. Nothing waits fifteen seconds to prove a
 * fifteen-second interval.
 */
import { describe, expect, test } from "bun:test";
import { readRpc } from "../src/chat/hermes/hermes-chat-rpc.ts";
import { createChatTurn, type ChatTurnDeps } from "../src/chat/hermes/hermes-chat-turn.ts";
import {
  CHAT_HEARTBEAT_DEADLINE_MS,
  CHAT_HEARTBEAT_MS,
  type ChatSocket,
} from "../src/chat/hermes/hermes-chat-types.ts";
import { ChatFrame } from "../src/schema/index.ts";

const NOW = "2026-09-19T00:00:00.000Z";
const BOX = { instance: "veronica", baseUrl: "https://veronica.example/" };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The gateway's first frame, with and without the capability flag. */
function ready(heartbeat: boolean | undefined): string {
  const payload = heartbeat === undefined ? {} : { heartbeat };
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "gateway.ready", session_id: "s1", payload, seq: 1 },
  });
}

function event(type: string, seq: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: { type, session_id: "s1", payload: {}, seq },
  });
}

interface Fake {
  socket: ChatSocket;
  /** Every JSON-RPC document the adapter wrote, pings included. */
  sent: { id: number; method: string }[];
  pings(): number;
  push(frame: string): void;
  isClosed(): boolean;
}

/**
 * A socket that answers requests and is otherwise silent — which is the whole
 * point: every frame it delivers is one a test pushed deliberately.
 *
 * `ping` is deliberately **not** answered unless `pong` is set, so the
 * any-inbound rule is tested rather than a pong round-trip.
 */
function fake(
  opts: {
    results?: Record<string, unknown>;
    after?: Record<string, string[]>;
    errors?: Record<string, { code: number; message: string }>;
  } = {},
): Fake {
  const buffer: string[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const nudge = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  const push = (frame: string): void => {
    buffer.push(frame);
    nudge();
  };
  const sent: { id: number; method: string }[] = [];
  let closed = false;

  const socket: ChatSocket = {
    send(data: string) {
      const doc = JSON.parse(data) as { id: number; method: string };
      sent.push(doc);
      if (doc.method === "ping") return;
      const failure = opts.errors?.[doc.method];
      if (failure) push(JSON.stringify({ jsonrpc: "2.0", id: doc.id, error: failure }));
      else
        push(JSON.stringify({ jsonrpc: "2.0", id: doc.id, result: opts.results?.[doc.method] ?? {} }));
      for (const frame of opts.after?.[doc.method] ?? []) push(frame);
    },
    close() {
      closed = true;
      done = true;
      nudge();
    },
    opened: Promise.resolve(),
    frames: (async function* () {
      for (;;) {
        while (buffer.length > 0) {
          const head = buffer.shift();
          if (head !== undefined) yield head;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })(),
  };

  return {
    socket,
    sent,
    pings: () => sent.filter((d) => d.method === "ping").length,
    push,
    isClosed: () => closed,
  };
}

describe("hermes chat · heartbeat", () => {
  test("Desktop's numbers, so the gateway meets a cadence it already survives", () => {
    expect(CHAT_HEARTBEAT_MS).toBe(15_000);
    expect(CHAT_HEARTBEAT_DEADLINE_MS).toBe(45_000);
  });

  test("probes on the interval, and only once the gateway says it answers them", async () => {
    const f = fake();
    const rpc = readRpc(f.socket, 1_000, "veronica", { intervalMs: 10, deadlineMs: 10_000 });
    // An older gateway omits the flag. No ping, and — see the silence test
    // below — no deadline either: a watch socket is silent by design, and
    // killing one every 45s would be a regression dressed as a fix.
    f.push(ready(undefined));
    f.push(event("session.info", 2));
    await sleep(60);
    expect(f.pings()).toBe(0);
    expect(f.isClosed()).toBe(false);

    f.push(ready(true));
    await sleep(60);
    expect(f.pings()).toBeGreaterThanOrEqual(2);
    // A probe is a request, not an event: it must not move the counter the turn
    // uses to tell "the gateway said nothing at all" from "it is talking".
    expect(rpc.arrived()).toBe(3);
    rpc.close();
  });

  test("a gateway that never advertised a heartbeat is never on a clock", async () => {
    const f = fake();
    const rpc = readRpc(f.socket, 1_000, "veronica", { intervalMs: 10, deadlineMs: 40 });
    f.push(ready(undefined));
    await sleep(150);
    expect(f.isClosed()).toBe(false);
    expect(f.pings()).toBe(0);
    rpc.close();
  });

  test("silence past the deadline closes the socket and ends the turn incomplete", async () => {
    const f = fake({
      results: { "session.create": { session_id: "s1" }, "prompt.submit": { status: "streaming" } },
      // This gateway cannot replay from a cursor, so the turn runs without
      // continuation and a closed socket is the end of it. Scripted rather than
      // left to the fake's default answer: "the reconnect never happens" has to
      // be a fact about the box, not about what a double forgot to mention.
      errors: { "session.events.since": { code: -32601, message: "method not found" } },
      after: { "prompt.submit": [ready(true), event("message.start", 3)] },
    });
    const rpc = readRpc(f.socket, 1_000, "veronica", { intervalMs: 5, deadlineMs: 60 });
    let dials = 0;
    const turn = createChatTurn({
      connect: () => {
        dials += 1;
        return Promise.resolve(rpc);
      },
      now: () => NOW,
      // Shorter than a real turn's, and still five times the heartbeat
      // deadline: whichever clock ends this turn, the assertion below names it.
      waitMs: 300,
      conversation: (() => Promise.resolve(null)) as unknown as ChatTurnDeps["conversation"],
    });

    const frames: ChatFrame[] = [];
    for await (const frame of turn.send(BOX, "default", "hi")) frames.push(ChatFrame.parse(frame));

    const last = frames.at(-1);
    expect(last?.type).toBe("done");
    if (last?.type !== "done") throw new Error("unreachable");
    expect(last.incomplete).toBe(true);
    expect(f.isClosed()).toBe(true);
    // It was the silence, not the turn's own first-frame deadline: an error
    // frame is what `waitMs` produces, and there is none.
    expect(frames.some((frame) => frame.type === "error")).toBe(false);
    // And the heartbeat's close was final: nothing tried to rebuild a socket
    // this gateway could not have carried the turn over anyway.
    expect(dials).toBe(1);
  });

  test("any inbound frame defers the deadline — a pong is not required", async () => {
    const f = fake();
    const rpc = readRpc(f.socket, 1_000, "veronica", { intervalMs: 5, deadlineMs: 60 });
    f.push(ready(true));
    // Six hundred milliseconds of traffic on a sixty-millisecond deadline, and
    // not one of the frames is a reply to a probe.
    for (let i = 0; i < 12; i += 1) {
      await sleep(50);
      f.push(event("message.delta", i + 2));
    }
    expect(f.isClosed()).toBe(false);
    expect(f.pings()).toBeGreaterThan(0);

    await sleep(150);
    expect(f.isClosed()).toBe(true);
    rpc.close();
  });

  test("closing stops the probes rather than leaving a timer on a dead socket", async () => {
    const f = fake();
    const rpc = readRpc(f.socket, 1_000, "veronica", { intervalMs: 5, deadlineMs: 10_000 });
    f.push(ready(true));
    await sleep(40);
    expect(f.pings()).toBeGreaterThan(0);

    rpc.close();
    const written = f.sent.length;
    await sleep(60);
    expect(f.sent.length).toBe(written);
  });
});
