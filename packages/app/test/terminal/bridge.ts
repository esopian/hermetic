/**
 * A window's bridge over the fixture, with a terminal host behind it — the
 * shared harness of `handlers-terminal.test.ts` and `terminal-log.test.ts`.
 *
 * The real `createRpcBinding`, `dispatch` and handlers; the fixture
 * `Hermetic`, its canned preflight and the canned shell. What the page would
 * have received is recorded, and the three page → main messages are called
 * the way the devkit calls them.
 */
import { fleetTargetOf, openHermetic } from "@hermetic/core";
import { createChatOwner } from "../../src/chat-owner.ts";
import type { HandlerContext } from "../../src/handlers/ctx.ts";
import { createStreamRegistry } from "../../src/handlers/streams.ts";
import type { AppLog } from "../../src/log.ts";
import { OpRegistry } from "../../src/ops.ts";
import { createRpcBinding, type RpcOptions } from "../../src/rpc/bind.ts";
import type { WebviewMessages } from "../../src/rpc/schema.ts";
import { AppState, fixedInstance } from "../../src/state.ts";
import type { TerminalFrame } from "../../src/terminal/channel.ts";
import { TerminalHost } from "../../src/terminal/host.ts";
import { fixturePtySpawner } from "../../src/terminal/pty-fixture.ts";
import { testHome } from "../home.ts";

export interface Bridge {
  ctx: HandlerContext;
  host: TerminalHost;
  home: string;
  /** Every `terminal.frame` push, in order. */
  frames: { stream_id: string; frame: TerminalFrame }[];
  request(name: string, params: unknown): Promise<unknown>;
  message(name: string, payload: unknown): void;
  /** The output frames of one stream, decoded. */
  text(streamId: string): string;
  /** The window goes away: its streams close and it stops counting as a viewer. */
  closeWindow(): void;
  close(): Promise<void>;
}

export async function bridge(
  options: { log?: AppLog; withHost?: boolean; home?: string } = {},
): Promise<Bridge> {
  const home = options.home ?? testHome("hermetic-terminal-bridge-");
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
  const host = new TerminalHost({
    hermetic: () => state.hermetic,
    spawner: fixturePtySpawner(),
    fixture: true,
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
  const ctx: HandlerContext = {
    state,
    hermetic: () => state.hermetic,
    ops: new OpRegistry(),
    poller: () => state.poller,
    chatOwner,
    fixture: true,
    opts: { fixture: true },
    streams: createStreamRegistry(),
    ...(options.withHost === false ? {} : { terminals: host }),
    ...(options.log !== undefined ? { log: options.log } : {}),
  };
  const frames: Bridge["frames"] = [];
  const captured: { options: RpcOptions | null } = { options: null };
  const binding = createRpcBinding({
    defineRPC: (rpcOptions) => {
      captured.options = rpcOptions;
      return {};
    },
    send: (name, payload) => {
      if (name === "terminal.frame") frames.push(payload as WebviewMessages["terminal.frame"]);
    },
    ctx,
    windowKey: "test-window",
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
  const rpc = captured.options;
  if (rpc === null) throw new Error("createRpcBinding must call defineRPC synchronously");
  return {
    ctx,
    host,
    home,
    frames,
    request: (name, params) => {
      const handler = rpc.handlers.requests[name];
      if (handler === undefined) throw new Error(`no request named ${name}`);
      return Promise.resolve(handler(params as never));
    },
    message: (name, payload) => {
      const handler = rpc.handlers.messages?.[name];
      if (handler === undefined) throw new Error(`no message named ${name}`);
      handler(payload as never);
    },
    text: (streamId) =>
      frames
        .filter((f) => f.stream_id === streamId)
        .map(({ frame }) =>
          frame.event === "data" || frame.event === "snapshot"
            ? Buffer.from(frame.data.b64, "base64").toString("utf8")
            : "",
        )
        .join(""),
    closeWindow: () => binding.close(),
    close: async () => {
      host.stopAll();
      binding.close();
      await chatOwner.stop();
    },
  };
}

export async function until(done: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
