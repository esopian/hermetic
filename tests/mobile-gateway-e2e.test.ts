/**
 * The phone's gateway seam, over a real socket.
 *
 * The phone talks to each box's Hermes gateway directly, through core's
 * adapter (`@hermetic/core/chat-client`) with its own socket wrapper
 * (`mobile/src/gateway/socket.ts`), polyfills and transport
 * (`mobile/src/gateway/transport.ts`). The desktop talks to the same gateway
 * through the same adapter with Bun's `fetch` and socket
 * (`defaultHermesChat`, `packages/core/src/chat/chat-transport.ts`). This test
 * runs both against one scripted Hermes-wire gateway on `Bun.serve` — the
 * dashboard page carrying `__HERMES_SESSION_TOKEN__`, the durable messages
 * route, and `/api/ws` answering JSON-RPC with the turn the live probe
 * recorded — and asserts the phone sees exactly the `ChatFrame`s the desktop
 * does. Bun's `WebSocket` stands in for React Native's: the wrapper takes the
 * constructor, and both take `(url, protocols?, …)`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChatFrame } from "@hermetic/core/chat-client";
import { createBotMode } from "../packages/core/src/chat/bot-mode.ts";
import { defaultHermesChat } from "../packages/core/src/chat/chat-transport.ts";
import { MemoryInstanceListeningStore } from "../packages/core/src/chat/instance-listening.ts";
import {
  DASHBOARD_HTML,
  FIXTURE_SESSION_TOKEN,
  PROMPT_SUBMIT_RESULT,
  RECORDED_TURN,
  SESSION_CREATE_RESULT,
  SESSION_ID,
  SESSION_LIST_RESULT,
} from "../packages/core/test/fixtures/hermes-frames.ts";
import type { TurnState } from "../mobile/src/client/chat-types.ts";
import { ConversationStore } from "../mobile/src/client/conversation-store.ts";
import { createGatewayClient } from "../mobile/src/gateway/client.ts";
import { createSocketOpener, type WebSocketCtor } from "../mobile/src/gateway/socket.ts";
import { createGatewayTransport, type TurnSink } from "../mobile/src/gateway/transport.ts";

const NOW = "2026-10-13T10:00:00.000Z";
const BOT = "default";
/** A thread session the transport resolves as-is (no Bot Chat lookup creates anything). */
const STORED = "stored-thread-1";

/** JSON-RPC results by method; anything unlisted answers `{}`. */
const RESULTS: Record<string, unknown> = {
  "client.capabilities": {},
  "session.list": SESSION_LIST_RESULT,
  "session.create": SESSION_CREATE_RESULT,
  "session.resume": { session_id: SESSION_ID, stored_session_id: STORED },
  "prompt.submit": PROMPT_SUBMIT_RESULT,
  "profiles.create": { ok: true, name: "scout" },
  "profiles.configure": { ok: true, applied: { ui_meta: true } },
  "profiles.describe": {
    name: "scout",
    description: "Finds things",
    soul: "",
    model: { provider: "anthropic", default: "claude" },
    skills: [],
    toolsets: [],
    mcp_servers: [],
  },
  ping: {},
};

interface Gateway {
  url: string;
  methods: string[];
  /** Every JSON-RPC request as `method` and its `params` re-serialised, in arrival order. */
  calls: { method: string; params: string }[];
  /**
   * While set, a prompt gets only the turn's opening frames (no completion):
   * a turn still running on the box. `push` sends it the next frame.
   */
  hold: boolean;
  push(frame: string): void;
  stop(): void;
}

/** The recorded turn up to and including its first reply delta. */
const OPENING = RECORDED_TURN.slice(0, 6);
const NEXT_FRAME = RECORDED_TURN[6] as string;

function startGateway(): Gateway {
  const methods: string[] = [];
  const calls: { method: string; params: string }[] = [];
  const sockets = new Set<{ send(data: string): unknown }>();
  const state = { hold: false };
  const server = Bun.serve<{ token: string }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/api/ws") {
        if (url.searchParams.get("token") !== FIXTURE_SESSION_TOKEN)
          return new Response("bad token", { status: 403 });
        return srv.upgrade(req, { data: { token: FIXTURE_SESSION_TOKEN } })
          ? undefined
          : new Response("no upgrade", { status: 400 });
      }
      const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
      if (messages) {
        return Response.json({
          session_id: decodeURIComponent(messages[1] ?? ""),
          profile: url.searchParams.get("profile"),
          messages: [],
          pagination: { returned: 0, limit: Number(url.searchParams.get("limit")), offset: 0 },
        });
      }
      if (url.pathname === "/")
        return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        for (const line of String(raw).split("\n")) {
          if (!line.trim()) continue;
          const doc = JSON.parse(line) as { id: number; method: string; params?: unknown };
          methods.push(doc.method);
          calls.push({ method: doc.method, params: JSON.stringify(doc.params ?? null) });
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: doc.id, result: RESULTS[doc.method] ?? {} }));
          if (doc.method === "prompt.submit")
            for (const frame of state.hold ? OPENING : RECORDED_TURN) ws.send(frame);
        }
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    methods,
    calls,
    get hold() {
      return state.hold;
    },
    set hold(on: boolean) {
      state.hold = on;
    },
    push: (frame) => {
      for (const ws of sockets) ws.send(frame);
    },
    stop: () => server.stop(true),
  };
}

let gateway: Gateway;
beforeAll(() => {
  gateway = startGateway();
});
afterAll(() => gateway.stop());

const box = () => ({ instance: "atlas", baseUrl: gateway.url, fleet_id: "fxtr0001" });

/** The desktop's path: `defaultHermesChat` (Bun's `fetch` and socket), straight `send`. */
async function desktopFrames(): Promise<ChatFrame[]> {
  const out: ChatFrame[] = [];
  for await (const frame of defaultHermesChat(() => NOW).send(box(), BOT, "ping", { session: STORED }))
    out.push(frame);
  return out;
}

/** The phone's path: its socket wrapper over Bun's `WebSocket`, its gateway client and transport. */
function phone(onTurn: Partial<TurnSink> = {}) {
  const frames: ChatFrame[] = [];
  const ends: TurnState[] = [];
  let resolveEnd: (state: TurnState | "gone") => void = () => {};
  const ended = new Promise<TurnState | "gone">((resolve) => {
    resolveEnd = resolve;
  });
  const client = createGatewayClient({
    fetch: (input, init) => fetch(input, init),
    openSocket: createSocketOpener(WebSocket as unknown as WebSocketCtor),
    now: () => NOW,
  });
  const sink: TurnSink = {
    frame: (id, n, frame) => {
      frames.push(frame);
      onTurn.frame?.(id, n, frame);
    },
    end: (id, state) => {
      ends.push(state);
      onTurn.end?.(id, state);
      resolveEnd(state);
    },
    gone: (id) => {
      onTurn.gone?.(id);
      resolveEnd("gone");
    },
    session: (id, session) => onTurn.session?.(id, session),
  };
  const transport = createGatewayTransport({
    client,
    address: (instance) => ({ ...box(), instance }),
    listening: () => ["atlas"],
    setListening: () => ["atlas"],
    turns: () => sink,
    now: () => NOW,
  });
  return { transport, frames, ends, ended };
}

describe("phone gateway ↔ scripted Hermes gateway", () => {
  test("the phone's transport yields the same ChatFrames the desktop's adapter does", async () => {
    const expected = await desktopFrames();
    expect(expected.some((f) => f.type === "done")).toBe(true);
    expect(expected.some((f) => f.type === "delta")).toBe(true);

    const p = phone();
    const { turn_id } = await p.transport.startTurn({
      instance: "atlas",
      bot: BOT,
      session: STORED,
      message: "ping",
    });
    expect(await p.ended).toBe("done");
    expect(turn_id.length).toBeGreaterThan(0);
    expect(p.frames).toEqual(expected);
    expect(gateway.methods).toContain("session.resume");
    expect(gateway.methods).toContain("prompt.submit");
  });

  test("through the conversation store: the reply assembles and the turn settles cleanly", async () => {
    let store: ConversationStore | null = null;
    const p = phone({
      frame: (id, n, frame) => store?.onTurnFrame(id, n, frame),
      end: (id, state) => store?.onTurnEnd(id, state),
      gone: (id) => store?.onTurnGone(id),
      session: (id, session) => store?.onTurnSession(id, session),
    });
    store = new ConversationStore({ transport: p.transport });
    const target = { instance: "atlas", bot: BOT, session: STORED };
    expect(store.send(target, "ping")).toBe(true);
    expect(await p.ended).toBe("done");
    const view = store.view(target);
    expect(view.sending).toBe(false);
    expect(view.turnError).toBeNull();
    expect(view.dropped).toBe(false);
    const said = p.frames
      .flatMap((f) => (f.type === "delta" ? [f.text] : []))
      .join("")
      .trim();
    expect(said.length).toBeGreaterThan(0);
    store.reset();
  });

  test("a forgotten turn is let go without session.interrupt; abortTurn still interrupts", async () => {
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(5);
      expect(ok()).toBe(true);
    };
    const interrupts = () => gateway.methods.filter((m) => m === "session.interrupt").length;
    gateway.hold = true;
    try {
      const p = phone();
      const before = interrupts();
      const { turn_id } = await p.transport.startTurn({
        instance: "atlas",
        bot: BOT,
        session: STORED,
        message: "ping",
      });
      await until(() => p.frames.some((f) => f.type === "delta"));
      p.transport.forgetTurn?.(turn_id);
      const delivered = p.frames.length;
      // The box keeps talking: the pump drains the frame and delivers nothing.
      gateway.push(NEXT_FRAME);
      await Bun.sleep(100);
      expect(interrupts()).toBe(before);
      expect(p.frames).toHaveLength(delivered);

      const q = phone();
      const second = await q.transport.startTurn({
        instance: "atlas",
        bot: BOT,
        session: STORED,
        message: "ping",
      });
      await until(() => q.frames.some((f) => f.type === "delta"));
      await q.transport.abortTurn(second.turn_id);
      await until(() => interrupts() > before);
      q.transport.dispose();
      gateway.push(NEXT_FRAME);
    } finally {
      gateway.hold = false;
    }
  });

  test("createBot sends the desktop's bots.create sequence, the same bytes", async () => {
    // Core's `bots.create` over the real adapter, its box pointed at this gateway.
    const hermes = defaultHermesChat(() => NOW);
    const botModeRpc = hermes.botModeRpc;
    if (!botModeRpc) throw new Error("the desktop adapter has Bot Mode RPC");
    const listening = new MemoryInstanceListeningStore();
    listening.set("fxtr0001", "atlas", true);
    type Deps = Parameters<typeof createBotMode>[0];
    const desktop = createBotMode({
      guardFleet: async () =>
        ({ fleet: { fleet_id: "fxtr0001", tailnet: "example.ts.net" } }) as unknown as Awaited<
          ReturnType<Deps["guardFleet"]>
        >,
      getAgent: async (name: string) =>
        ({ name, tailscale_dns_name: null }) as unknown as Awaited<ReturnType<Deps["getAgent"]>>,
      instanceListening: listening,
      hermes: {
        ...hermes,
        botModeRpc: (_box, method, params, opts) => botModeRpc(box(), method, params, opts),
      },
    });
    const input = { name: "scout", title: "Scout", description: "Finds things", model: "claude" };
    const sent = (from: number) =>
      gateway.calls
        .slice(from)
        .filter((c) => c.method.startsWith("profiles."))
        // `created` is each side's own clock: equal in shape, not in value.
        .map((c) => ({ method: c.method, params: c.params.replace(/"created":\d+/, '"created":0') }));

    const before = Date.now();
    const desktopFrom = gateway.calls.length;
    const desktopProfile = await desktop.bots.create({ instance: "atlas", ...input });
    const desktopSent = sent(desktopFrom);

    const phoneFrom = gateway.calls.length;
    const phoneProfile = await phone().transport.createBot("atlas", input);
    const phoneSent = sent(phoneFrom);

    expect(desktopSent.map((c) => c.method)).toEqual([
      "profiles.create",
      "profiles.configure",
      "profiles.describe",
    ]);
    // Both heads ask upstream to copy the default `.env` (the provider key)
    // into the new bot (§9.2).
    expect(JSON.parse(desktopSent[0]?.params ?? "{}")).toMatchObject({ mirror_credentials: true });
    expect(desktopSent[1]?.params).toBe(
      '{"name":"scout","ui_meta":{"hermes-bots":{"version":1,"title":"Scout","created":0}}}',
    );
    expect(phoneSent).toEqual(desktopSent);
    const created = /"created":(\d+)/.exec(
      gateway.calls.slice(phoneFrom).find((c) => c.method === "profiles.configure")?.params ?? "",
    );
    expect(Number(created?.[1])).toBeGreaterThanOrEqual(before);
    expect(phoneProfile).toEqual(desktopProfile);
    expect(phoneProfile).toMatchObject({
      instance: "atlas",
      bot: "scout",
      description: "Finds things",
    });
  });

  test("history composes conversation and the durable route over HTTP", async () => {
    const p = phone();
    const result = await p.transport.history({ instance: "atlas", bot: BOT, session: STORED });
    expect(result).toMatchObject({ instance: "atlas", bot: BOT, session: STORED, messages: [] });
  });
});
