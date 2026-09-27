/**
 * The observations this head holds, and the fan-in that carries them
 * (`src/chat-owner.ts`, `src/chat-stream.ts`).
 *
 * The phase's acceptance criteria are about what happens when *nobody is
 * looking*: an external Desktop, CLI or routine message has to arrive without
 * a two-minute wait, several observers must not double a turn, and closing a
 * tab must detach that tab and nothing else. None of that is provable against
 * a design where one request is one observation, so what these tests pin down is
 * the ownership: the subscription is the head's, a request joins it, and a
 * request leaving does not take it away.
 *
 * Core is a double here, and deliberately. `chat.observe`'s own guarantees —
 * deduplication, bounded reconnect, one upstream stream per conversation — are
 * core's tests (`packages/core/test/chat-observe.test.ts`). What is being
 * asserted here is the count of calls *into* core and the lifetime of each,
 * which is exactly what a double can say and a real fixture cannot. The
 * sharing policy itself — the folded seed, its window, session rollover,
 * the bound on remembered failures — is core's `createObservePool`, and its
 * tests are `packages/core/test/observe-pool.test.ts`.
 *
 * §11.6's rule holds: no network, no timers left armed, and every wait is
 * bounded — `openStream` gives up rather than hanging the suite.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Bot, ChatObserveEvent, Hermetic, Swarm } from "@hermetic/core";
import { createChatOwner, type ChatOwner, type OwnedChatEvent } from "../src/chat-owner.ts";
import { CHAT_STREAM_MAX_QUEUED } from "../src/chat-stream.ts";
import { INTERNAL_MESSAGE } from "../src/errors.ts";
import type { HandlerContext } from "../src/handlers/ctx.ts";
import { dispatch } from "../src/handlers/dispatch.ts";
import { KEEPALIVE_EVENT, createStreamRegistry } from "../src/handlers/streams.ts";
import { memoryLog } from "../src/log.ts";
import { OpRegistry } from "../src/ops.ts";
import { MACHINERY_RPC, RPC_DECLARATIONS } from "../src/rpc/registry.ts";
import { AppState, fixedInstance } from "../src/state.ts";

/* ── the core double ──────────────────────────────────────────────────────── */

/** One open `chat.observe` call, driven by the test. */
interface Channel {
  pending: ChatObserveEvent[];
  ended: boolean;
  wake: (() => void) | null;
  /** Set by the generator's own `finally`: the call is over and let go. */
  closed: boolean;
}

interface ScriptOptions {
  listening?: string[];
  /** Instance → the bots its roster reports. */
  bots?: Record<string, string[]>;
  /** Instances whose roster read fails, as an unreachable box's would. */
  unreadable?: string[];
  /** Thrown by `chat.observe` instead of returning a stream. */
  throws?: unknown;
}

function conversationKey(instance: string, bot: string, session?: string): string {
  return session === undefined ? `${instance}/${bot}` : `${instance}/${bot}#${session}`;
}

function botRow(instance: string, name: string): Bot {
  return {
    instance,
    name,
    title: name,
    is_default: name === "default",
    avatar_seed: `fixture/${instance}/${name}`,
    unread: 0,
    needs_action: false,
    muted: false,
    warm: false,
  };
}

function swarmRow(instance: string, bots: string[]): Swarm {
  return {
    instance,
    reachable: true,
    bots: bots.map((name) => botRow(instance, name)),
    rooms: [],
    warm_slots: { used: 0, total: 3 },
    sections: [],
  };
}

/**
 * A `Hermetic` that is nothing but the four chat methods the owner uses, with
 * every `chat.observe` call recorded and drivable by name.
 */
function chatScript(options: ScriptOptions = {}) {
  const listening = new Set(options.listening ?? []);
  const bots = options.bots ?? {};
  const unreadable = new Set(options.unreadable ?? []);
  const opens: string[] = [];
  const channels = new Map<string, Channel[]>();

  function open(key: string): Channel[] {
    const held = channels.get(key) ?? [];
    channels.set(key, held);
    return held;
  }

  let listeningReads = 0;

  const chat = {
    listening: () => {
      listeningReads += 1;
      return Promise.resolve({ instances: [...listening].sort() });
    },
    listen: (input: { instance: string; listening: boolean }) => {
      if (input.listening) listening.add(input.instance);
      else listening.delete(input.instance);
      return Promise.resolve({ instances: [...listening].sort() });
    },
    swarms: (input: { instance?: string }) => {
      const instance = input.instance ?? "";
      if (unreadable.has(instance)) return Promise.reject(new Error("the box did not answer"));
      return Promise.resolve({ swarms: [swarmRow(instance, bots[instance] ?? [])] });
    },
    observe: (
      input: { instance: string; bot: string; session?: string },
      opts: { signal?: AbortSignal } = {},
    ): AsyncIterable<ChatObserveEvent> => {
      if (options.throws !== undefined) throw options.throws;
      const key = conversationKey(input.instance, input.bot, input.session);
      opens.push(key);
      const channel: Channel = { pending: [], ended: false, wake: null, closed: false };
      open(key).push(channel);
      const nudge = (): void => {
        const resume = channel.wake;
        channel.wake = null;
        resume?.();
      };
      return (async function* () {
        opts.signal?.addEventListener("abort", nudge, { once: true });
        try {
          for (;;) {
            while (channel.pending.length > 0) {
              const head = channel.pending.shift();
              if (head !== undefined) yield head;
            }
            if (channel.ended || opts.signal?.aborted === true) return;
            await new Promise<void>((resolve) => {
              channel.wake = resolve;
            });
          }
        } finally {
          opts.signal?.removeEventListener("abort", nudge);
          channel.closed = true;
        }
      })();
    },
  };

  function each(key: string, run: (channel: Channel) => void): void {
    for (const channel of channels.get(key) ?? []) {
      run(channel);
      const resume = channel.wake;
      channel.wake = null;
      resume?.();
    }
  }

  return {
    hermetic: {
      chat,
      // §4.7: the head reads the instance's own target to bind the mutation guard.
      target: FLEET_TARGET,
    } as unknown as Hermetic,
    /** Every `chat.observe` call made, in order. */
    opens,
    /** Calls for this conversation that have not returned yet. */
    live(key: string): number {
      return (channels.get(key) ?? []).filter((channel) => !channel.closed).length;
    },
    /** How many times the listen preference was read. */
    listeningReads(): number {
      return listeningReads;
    },
    /** How many calls were ever made for this conversation. */
    calls(key: string): number {
      return opens.filter((open) => open === key).length;
    },
    push(key: string, event: ChatObserveEvent): void {
      each(key, (channel) => channel.pending.push(event));
    },
    end(key: string): void {
      each(key, (channel) => {
        channel.ended = true;
      });
    },
    /** From now on this box's roster read fails, as an unreachable one's does. */
    blind(instance: string): void {
      unreadable.add(instance);
    },
  };
}

/**
 * The row a `message` carries and a `snapshot` lists, under one id scheme so a
 * test can say "the same message" and mean the thing dedupe is keyed on.
 */
type ChatRow = Extract<ChatObserveEvent, { type: "message" }>["message"];

const row = (instance: string, bot: string, text: string): ChatRow => ({
  id: `${instance}-${bot}-${text}`,
  session: `${bot}-canonical`,
  role: "bot",
  at: "2026-09-18T12:00:00.000Z",
  blocks: [{ kind: "text", markdown: text }],
});

const message = (instance: string, bot: string, text: string): ChatObserveEvent => ({
  type: "message",
  instance,
  bot,
  session: `${bot}-canonical`,
  message: row(instance, bot, text),
});

/** The upstream read dropped and is being retried. Advisory, never terminal. */
const reconnecting = (instance: string, bot: string, attempt: number): ChatObserveEvent => ({
  type: "reconnect",
  instance,
  bot,
  attempt,
  delay_ms: 2000,
  code: "CHAT_UNREACHABLE",
  message: `${instance}: dashboard did not answer`,
});

/** The observation is over and said why. Terminal by contract. */
const failed = (
  instance: string,
  bot: string,
  message = "the retry budget is spent",
): ChatObserveEvent => ({
  type: "error",
  instance,
  bot,
  code: "CHAT_UNREACHABLE",
  message,
});

const snapshot = (instance: string, bot: string, texts: string[] = []): ChatObserveEvent => ({
  type: "snapshot",
  instance,
  bot,
  session: `${bot}-canonical`,
  messages: texts.map((text) => row(instance, bot, text)),
  at: "2026-09-18T12:00:00.000Z",
});

/* ── the harness ──────────────────────────────────────────────────────────── */

/** §4.7: the fleet every guarded request in this file names. */
const FLEET_TARGET = { account_id: "123456789012", region: "us-west-2", fleet_id: "fxtr0001" };

const owners: ChatOwner[] = [];

/** The context the bridge builds, over one doubled instance and one owner. */
function contextFor(hermetic: Hermetic, chatOwner: ChatOwner, log: ReturnType<typeof memoryLog>) {
  const state = new AppState({
    fixture: true,
    home: ":memory:",
    reopen: fixedInstance(hermetic),
    hermetic,
    target: { ...FLEET_TARGET },
  });
  const ctx: HandlerContext = {
    state,
    hermetic: () => state.hermetic,
    ops: new OpRegistry(),
    poller: () => null,
    chatOwner,
    fixture: true,
    opts: { fixture: true, log },
    log,
    streams: createStreamRegistry(),
  };
  return ctx;
}

function harness(options: ScriptOptions = {}) {
  const script = chatScript(options);
  const log = memoryLog();
  const owner = createChatOwner({ hermetic: () => script.hermetic, log });
  owners.push(owner);
  return { script, owner, ctx: contextFor(script.hermetic, owner, log), log };
}

/** No test may leave a read loop armed, whatever it asserted or threw. */
afterEach(async () => {
  while (owners.length > 0) {
    const owner = owners.pop();
    await owner?.stop();
  }
});

/* ── a bounded stream reader ─────────────────────────────────────────────── */

interface Frame {
  event: string;
  data: string;
}

/**
 * Opens a streaming request and reads its frames with a deadline on every read,
 * so a test that is wrong about what the head pushes fails instead of hanging
 * the suite.
 *
 * `data` is kept as JSON text rather than as the value: these assertions are
 * about what a reader is *told*, including that a redacted message really is
 * absent from the bytes, and a live object reference would prove neither.
 */
async function openStream(ctx: HandlerContext, name: string, params: Record<string, unknown> = {}) {
  const queue: Frame[] = [];
  let wake: (() => void) | null = null;
  const nudge = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  const { stream_id } = (await dispatch(ctx, name, params, (frame) => {
    // A keepalive is traffic, not a frame — the same reading SSE gives its
    // `: keepalive` comment.
    if (frame.event === KEEPALIVE_EVENT) return;
    queue.push({ event: frame.event, data: JSON.stringify(frame.data) });
    nudge();
  })) as { stream_id: string };
  let ended = false;
  void ctx.streams.get(stream_id)?.done.then(() => {
    ended = true;
    nudge();
  });

  return {
    async next(ms = 2000): Promise<Frame | null> {
      const deadline = Date.now() + ms;
      for (;;) {
        const ready = queue.shift();
        if (ready !== undefined) return ready;
        // A source that has run out is an ended stream, not a slow one: the
        // reader says so rather than spending the whole deadline on it.
        if (ended) return null;
        const left = deadline - Date.now();
        if (left <= 0) return null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, Math.min(left, 20));
        });
        wake = null;
        if (timer !== null) clearTimeout(timer);
      }
    },
    /** What a closed window does: drop the stream it asked for. */
    cancel(): Promise<void> {
      ctx.streams.close(stream_id);
      return Promise.resolve();
    },
  };
}

/** Long enough for an abort to reach the read loop; never a wait for work. */
const settle = (): Promise<void> => Bun.sleep(10);

const sorted = (owner: ChatOwner): string[] =>
  owner
    .owned()
    .map((ref) => conversationKey(ref.instance, ref.bot, ref.session ?? undefined))
    .sort();

/* ── the tests ────────────────────────────────────────────────────────────── */

describe("the server owns its observations", () => {
  test("boot starts one per listened bot, and none for a box nobody listens to", async () => {
    const { script, owner } = harness({
      listening: ["atlas", "kestrel"],
      bots: { atlas: ["default", "granite"], kestrel: ["default"], corvid: ["default"] },
    });

    await owner.sync();

    expect([...script.opens].sort()).toEqual(["atlas/default", "atlas/granite", "kestrel/default"]);
    expect(sorted(owner)).toEqual(["atlas/default", "atlas/granite", "kestrel/default"]);
    // The unlistened box is not watched, and its roster was never even read.
    expect(script.opens.some((open) => open.startsWith("corvid/"))).toBe(false);
  });

  test("a second sync changes nothing: the subscriptions are the ones already held", async () => {
    const { script, owner } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });

    await owner.sync();
    await owner.sync();

    expect(script.calls("atlas/default")).toBe(1);
    expect(script.live("atlas/default")).toBe(1);
  });

  test("chat.listen turns exactly one observation on, and off, leaving the other alone", async () => {
    const { script, owner, ctx } = harness({
      listening: ["atlas"],
      bots: { atlas: ["default"], corvid: ["default"] },
    });
    await owner.sync();

    await dispatch(ctx, "chat.listen", {
      instance: "corvid",
      listening: true,
      target: FLEET_TARGET,
    });
    expect(sorted(owner)).toEqual(["atlas/default", "corvid/default"]);
    expect(script.calls("corvid/default")).toBe(1);
    // The one that was already running was not restarted to make room for it.
    expect(script.calls("atlas/default")).toBe(1);

    await dispatch(ctx, "chat.listen", {
      instance: "corvid",
      listening: false,
      target: FLEET_TARGET,
    });
    await settle();

    expect(sorted(owner)).toEqual(["atlas/default"]);
    expect(script.live("corvid/default")).toBe(0);
    // Unlisten is local observation control: atlas is still being watched, and
    // nothing was sent to either box to stop anything.
    expect(script.live("atlas/default")).toBe(1);
  });

  test("a roster that could not be read leaves that box's observations alone", async () => {
    const { script, owner, log } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();

    // The box goes off the tailnet between one reconcile and the next. A roster
    // this laptop could not read is not a roster that changed, so the watch
    // stays and lets core's own bounded reconnect do its work.
    script.blind("atlas");
    await owner.sync();

    expect(sorted(owner)).toEqual(["atlas/default"]);
    expect(script.live("atlas/default")).toBe(1);
    expect(script.calls("atlas/default")).toBe(1);
    expect(log.lines.join("")).toContain("WARN  chat roster read failed");
  });
});

describe("a browser tab joins the observation rather than starting one", () => {
  test("a tab joining an owned conversation opens no second stream", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();
    expect(script.calls("atlas/default")).toBe(1);

    const tab = await openStream(ctx, "chat.observe", { instance: "atlas", bot: "default" });
    script.push("atlas/default", message("atlas", "default", "from Desktop"));
    const frame = await tab.next();
    expect(frame?.event).toBe("message");

    // One upstream stream for the conversation, not one per reader.
    expect(script.calls("atlas/default")).toBe(1);
    expect(script.live("atlas/default")).toBe(1);
    await tab.cancel();
  });

  test("a second tab is handed the snapshot the server already holds", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();
    script.push("atlas/default", snapshot("atlas", "default"));
    await settle();

    const tab = await openStream(ctx, "chat.observe", { instance: "atlas", bot: "default" });
    const frame = await tab.next();

    expect(frame?.event).toBe("snapshot");
    expect(script.calls("atlas/default")).toBe(1);
    await tab.cancel();
  });

  test("a tab that connects and disconnects leaves the owner's subscription running", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();
    const seen: string[] = [];
    owner.subscribe((event) => void seen.push(event.event.type));

    const tab = await openStream(ctx, "chat.observe", { instance: "atlas", bot: "default" });
    script.push("atlas/default", message("atlas", "default", "one"));
    expect((await tab.next())?.event).toBe("message");
    await tab.cancel();
    await settle();

    // The tab is gone; the observation is not.
    expect(sorted(owner)).toEqual(["atlas/default"]);
    expect(script.live("atlas/default")).toBe(1);
    expect(script.calls("atlas/default")).toBe(1);

    // And it is still delivering: this is the message nobody was looking at.
    script.push("atlas/default", message("atlas", "default", "two"));
    await settle();
    expect(seen).toEqual(["message", "message"]);
  });

  test("a watch on a conversation nobody listens to ends when its last reader leaves", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();

    const tab = await openStream(ctx, "chat.observe", {
      instance: "atlas",
      bot: "default",
      session: "thread-7",
    });
    script.push("atlas/default#thread-7", message("atlas", "default", "in the thread"));
    expect((await tab.next())?.event).toBe("message");
    expect(script.live("atlas/default#thread-7")).toBe(1);

    await tab.cancel();
    await settle();

    // A guest is refcounted; a pinned one is not, which is the whole difference.
    expect(script.live("atlas/default#thread-7")).toBe(0);
    expect(script.live("atlas/default")).toBe(1);
  });
});

describe("the fan-in transport", () => {
  test("one connection carries several conversations, each routable to its own", async () => {
    const { script, owner, ctx } = harness({
      listening: ["atlas", "kestrel"],
      bots: { atlas: ["default", "granite"], kestrel: ["default"] },
    });
    await owner.sync();

    const stream = await openStream(ctx, "chat.subscribe", {});

    script.push("atlas/default", message("atlas", "default", "one"));
    script.push("atlas/granite", message("atlas", "granite", "two"));
    script.push("kestrel/default", message("kestrel", "default", "three"));

    const routed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const frame = await stream.next();
      expect(frame?.event).toBe("message");
      const body = JSON.parse(frame?.data ?? "null") as {
        conversation: { instance: string; bot: string; session: string | null };
        event: { type: string };
      };
      // Identity travels with the event: a client routes on `conversation`
      // without inferring anything from the payload.
      expect(body.conversation.session).toBeNull();
      routed.push(`${body.conversation.instance}/${body.conversation.bot}`);
    }

    expect(routed.sort()).toEqual(["atlas/default", "atlas/granite", "kestrel/default"]);
    await stream.cancel();
  });

  test("a tab on the fan-in is a reader too: leaving it ends no observation", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();

    const stream = await openStream(ctx, "chat.subscribe", {});
    script.push("atlas/default", message("atlas", "default", "one"));
    expect((await stream.next())?.event).toBe("message");
    await stream.cancel();
    await settle();

    expect(script.live("atlas/default")).toBe(1);
    expect(sorted(owner)).toEqual(["atlas/default"]);
  });

  test("the fan-in is machinery, not a second declared method", () => {
    expect(MACHINERY_RPC).toContain("chat.subscribe");
    // `chat.observe` keeps exactly one declaration, which is the one the
    // parity contract counts (§11.4).
    expect(RPC_DECLARATIONS.filter((d) => d.path === "chat.observe")).toHaveLength(1);
  });
});

describe("a failing observation", () => {
  test("a terminal error is logged with its code and the server keeps serving", async () => {
    const { script, owner, ctx, log } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();

    script.push("atlas/default", {
      type: "error",
      instance: "atlas",
      bot: "default",
      code: "CHAT_UNREACHABLE",
      message: "atlas: dashboard did not answer",
    });
    script.end("atlas/default");
    await settle();

    const text = log.lines.join("");
    expect(text).toContain("ERROR chat observation failed");
    expect(text).toContain("CHAT_UNREACHABLE");
    expect(owner.owned()).toEqual([]);
    // The head is still answering: a dead observation is not a dead process.
    // `chat.listening` rather than `meta.get`, because the doubled instance in
    // this file has a chat surface and no config to show.
    expect(await dispatch(ctx, "chat.listening", {})).toBeDefined();
  });

  test("an unclassified throw reaches the log whole and the reader masked", async () => {
    const leaky = new Error("connect ECONNREFUSED 10.11.12.13:443 assuming arn:aws:iam::1234:role/x");
    const { owner, ctx, log } = harness({
      listening: ["atlas"],
      bots: { atlas: ["default"] },
      throws: leaky,
    });

    const tab = await openStream(ctx, "chat.observe", { instance: "atlas", bot: "default" });
    const frame = await tab.next();

    expect(frame?.event).toBe("error");
    const body = JSON.parse(frame?.data ?? "null") as { code: string; message: string };
    expect(body).toMatchObject({ code: "INTERNAL", message: INTERNAL_MESSAGE });
    expect(frame?.data).not.toContain("ECONNREFUSED");
    // §8.3: the operator gets the truth in the app log, the page does not.
    expect(log.lines.join("")).toContain("ECONNREFUSED");
    await tab.cancel();
    expect(owner.owned()).toEqual([]);
  });
});

describe("shutdown", () => {
  test("every observation is let go, and a later sync starts nothing", async () => {
    const { script, owner } = harness({
      listening: ["atlas", "kestrel"],
      bots: { atlas: ["default", "granite"], kestrel: ["default"] },
    });
    await owner.sync();
    expect(script.opens).toHaveLength(3);

    await owner.stop();

    for (const key of ["atlas/default", "atlas/granite", "kestrel/default"]) {
      expect(script.live(key)).toBe(0);
    }
    expect(owner.owned()).toEqual([]);
    expect(owner.observing()).toEqual([]);

    // A stopped owner stays stopped: nothing re-arms it after the signal.
    await owner.sync();
    expect(script.opens).toHaveLength(3);
  });

  test("a reader parked on a stopped observation is released, not left hanging", async () => {
    const { owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();

    const tab = await openStream(ctx, "chat.observe", { instance: "atlas", bot: "default" });
    await owner.stop();

    // The stream ends rather than sitting open against a subscription that is
    // gone: `next` returns null on end of body as well as on its deadline.
    expect(await tab.next(1000)).toBeNull();
  });
});

/* ── observation health, for a reader that was not there ──────────────────── */

interface StreamFrame {
  conversation: { instance: string; bot: string; session: string | null };
  event: {
    type: string;
    code?: string;
    message?: string;
    attempt?: number;
    messages?: { id: string }[];
  };
}

const parse = (frame: Frame | null): StreamFrame => JSON.parse(frame?.data ?? "null") as StreamFrame;

/** Every frame the fan-in sends before it goes quiet. Bounded; never a hang. */
async function frames(stream: Awaited<ReturnType<typeof openStream>>, quiet = 150): Promise<Frame[]> {
  const seen: Frame[] = [];
  for (;;) {
    const frame = await stream.next(quiet);
    if (frame === null) return seen;
    seen.push(frame);
  }
}

/** Kill one conversation the way core does: the reason, and then the end. */
function die(script: ReturnType<typeof chatScript>, key: string, message?: string): void {
  const [instance, bot] = key.split("/");
  script.push(key, failed(instance ?? "", bot ?? "", message));
  script.end(key);
}

describe("a reader that connects late learns the observation's health", () => {
  test("a fan-in tab opened after a failure is told the conversation failed, and why", async () => {
    const { script, owner, ctx } = harness({
      listening: ["atlas"],
      bots: { atlas: ["default", "granite"] },
    });
    await owner.sync();
    script.push("atlas/default", snapshot("atlas", "default"));
    die(script, "atlas/default", "atlas: dashboard did not answer");
    await settle();

    // The tab arrives now, with the failure already in the past.
    const stream = await openStream(ctx, "chat.subscribe", {});
    const seeded = await frames(stream);

    expect(seeded.map((f) => f.event)).toEqual(["error"]);
    const frame = parse(seeded[0] ?? null);
    expect(frame.conversation).toEqual({ instance: "atlas", bot: "default", session: null });
    // Terminal, with the reason — which is what the `Watch again` band needs.
    expect(frame.event).toMatchObject({
      type: "error",
      code: "CHAT_UNREACHABLE",
      message: "atlas: dashboard did not answer",
    });
    await stream.cancel();
  });

  test("a tab reading only that conversation is told the same, and no box is re-read", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();
    die(script, "atlas/default");
    await settle();

    const tab = await openStream(ctx, "chat.observe", { instance: "atlas", bot: "default" });
    expect((await tab.next())?.event).toBe("error");
    // And then the stream ends, exactly as it ended for a reader who was here.
    expect(await tab.next(300)).toBeNull();
    // Reconnecting readers must not turn a terminal failure into a retry loop
    // against the box: one upstream read was made, and it is still one.
    expect(script.calls("atlas/default")).toBe(1);
  });

  test("a tab opened mid-backoff is told it is reconnecting, with the attempt", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();
    script.push("atlas/default", snapshot("atlas", "default"));
    script.push("atlas/default", reconnecting("atlas", "default", 4));
    await settle();

    const stream = await openStream(ctx, "chat.subscribe", {});
    const seeded = await frames(stream);

    // The transcript, and then what is wrong with the watch on it.
    expect(seeded.map((f) => f.event)).toEqual(["snapshot", "reconnect"]);
    expect(parse(seeded[1] ?? null).event).toMatchObject({ type: "reconnect", attempt: 4 });

    // The same for a tab on the single-conversation transport.
    const tab = await openStream(ctx, "chat.observe", { instance: "atlas", bot: "default" });
    expect((await tab.next())?.event).toBe("snapshot");
    expect((await tab.next())?.event).toBe("reconnect");
    await tab.cancel();
    await stream.cancel();
  });

  test("a healthy conversation seeds no health frame, and a recovery is not replayed", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();
    // It wobbled and then read successfully, which is the end of the matter.
    script.push("atlas/default", reconnecting("atlas", "default", 1));
    script.push("atlas/default", snapshot("atlas", "default"));
    await settle();

    const stream = await openStream(ctx, "chat.subscribe", {});
    const seeded = await frames(stream);

    // One frame, and it is the transcript: nothing tells this tab to show a
    // band for a reconnect that has already succeeded.
    expect(seeded.map((f) => f.event)).toEqual(["snapshot"]);
    await stream.cancel();
  });

  test("a replayed failure is masked the way the log line is", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();
    die(script, "atlas/default", "upstream refused: Bearer FIXTURE-BEARER-TOKEN");
    await settle();

    const stream = await openStream(ctx, "chat.subscribe", {});
    const seeded = await frames(stream);

    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.data).not.toContain("FIXTURE-BEARER-TOKEN");
    expect(parse(seeded[0] ?? null).event.message).toContain("Bearer [redacted]");
    await stream.cancel();
  });

  test("a failure is forgotten when the operator stops listening to its box", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();
    die(script, "atlas/default");
    await settle();
    expect(owner.snapshots()).toHaveLength(1);

    await dispatch(ctx, "chat.listen", {
      instance: "atlas",
      listening: false,
      target: FLEET_TARGET,
    });
    await settle();

    // Not watching it is not the same as failing to watch it: a box the
    // operator turned off has nothing to report and no band to show.
    expect(owner.snapshots()).toEqual([]);
  });

  test("a fleet switch carries no failures into the fleet it switches to", async () => {
    const { script, owner } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();
    die(script, "atlas/default");
    await settle();
    expect(owner.snapshots()).toHaveLength(1);

    await owner.reset();

    expect(owner.snapshots()).toEqual([]);
  });
});

/* ── `Watch again`: one conversation, not the fleet ───────────────────────── */

/** How many times the owner has logged that it started watching something. */
const observings = (log: ReturnType<typeof memoryLog>): number =>
  log.lines.filter((line) => line.includes("chat observing")).length;

const NINE = [
  "default",
  "atlas2",
  "corvid",
  "granite",
  "kestrel",
  "merlin",
  "osprey",
  "raven",
  "shrike",
];

describe("resuming one conversation re-establishes that conversation", () => {
  test("resuming one of nine failed conversations starts exactly one observation", async () => {
    const { script, owner, ctx, log } = harness({ listening: ["atlas"], bots: { atlas: NINE } });
    await owner.sync();
    expect(script.opens).toHaveLength(9);
    for (const bot of NINE) die(script, `atlas/${bot}`);
    await settle();
    expect(owner.observing()).toEqual([]);
    const started = observings(log);

    const answer = await dispatch(ctx, "chat.observe.resume", {
      instance: "atlas",
      bot: "corvid",
    });

    expect(answer).toEqual({
      instance: "atlas",
      bot: "corvid",
      session: null,
      observing: true,
      restarted: true,
      listening: true,
    });
    // The measurement QA made: one operator click, one new upstream read — not
    // one per bot on the box.
    expect(script.opens).toHaveLength(10);
    expect(script.opens.at(-1)).toBe("atlas/corvid");
    expect(observings(log) - started).toBe(1);
    expect(script.live("atlas/corvid")).toBe(1);
  });

  test("resuming one conversation disturbs none of the others", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: NINE } });
    await owner.sync();
    for (const bot of NINE) die(script, `atlas/${bot}`);
    await settle();

    await dispatch(ctx, "chat.observe.resume", { instance: "atlas", bot: "corvid" });
    await settle();

    // Exactly one conversation is watched again, and the other eight still say
    // why they stopped rather than quietly coming back.
    expect(sorted(owner)).toEqual(["atlas/corvid"]);
    for (const bot of NINE) {
      expect(script.live(`atlas/${bot}`)).toBe(bot === "corvid" ? 1 : 0);
      expect(script.calls(`atlas/${bot}`)).toBe(bot === "corvid" ? 2 : 1);
    }
    const kept = owner.snapshots().filter((seed) => seed.event.type === "error");
    expect(kept.map((seed) => seed.conversation.bot).sort()).toEqual(
      NINE.filter((bot) => bot !== "corvid").sort(),
    );
  });

  test("a resumed conversation is watched again, and no longer reported as failed", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();
    die(script, "atlas/default");
    await settle();

    await dispatch(ctx, "chat.observe.resume", { instance: "atlas", bot: "default" });
    script.push("atlas/default", snapshot("atlas", "default"));
    await settle();

    const stream = await openStream(ctx, "chat.subscribe", {});
    const seeded = await frames(stream);

    // The tab that connects now is seeded with a healthy conversation: the
    // remembered failure went when the watch came back.
    expect(seeded.map((f) => f.event)).toEqual(["snapshot"]);
    await stream.cancel();
  });

  test("resuming a conversation that is already watched opens nothing", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();

    const answer = await dispatch(ctx, "chat.observe.resume", {
      instance: "atlas",
      bot: "default",
    });

    expect(answer).toMatchObject({ observing: true, restarted: false, listening: true });
    expect(script.calls("atlas/default")).toBe(1);
    expect(script.live("atlas/default")).toBe(1);
  });

  test("resuming on a box nobody listens to holds nothing, and says which", async () => {
    const { script, owner, ctx } = harness({ listening: [], bots: { corvid: ["default"] } });
    await owner.sync();

    const answer = await dispatch(ctx, "chat.observe.resume", {
      instance: "corvid",
      bot: "default",
    });

    // Nothing for the head to hold, and the answer says why: it asks for the
    // instance to be listened to rather than guessing.
    expect(answer).toMatchObject({ observing: false, restarted: false, listening: false });
    expect(script.opens).toEqual([]);
    expect(owner.observing()).toEqual([]);
  });

  test("a named session is resumed as itself, not as the bot's canonical conversation", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();

    const answer = await dispatch(ctx, "chat.observe.resume", {
      instance: "atlas",
      bot: "default",
      session: "thread-7",
    });

    expect(answer).toMatchObject({ session: "thread-7", observing: true, restarted: true });
    expect(script.calls("atlas/default#thread-7")).toBe(1);
    // The canonical one was already running and was not restarted for it.
    expect(script.calls("atlas/default")).toBe(1);
  });

  test("a resume after shutdown starts nothing", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();
    await owner.stop();
    const before = script.opens.length;
    const reads = script.listeningReads();

    const answer = await dispatch(ctx, "chat.observe.resume", {
      instance: "atlas",
      bot: "default",
    });

    expect(answer).toMatchObject({ observing: false, restarted: false });
    expect(script.opens).toHaveLength(before);
    // Not even the cheap local read: a stopped owner asks nothing of anything.
    expect(script.listeningReads()).toBe(reads);
  });

  test("a resume caught by a shutdown mid-read leaves nothing running behind it", async () => {
    const { script, owner } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();

    // The resume is suspended on its listen read when the signal arrives. The
    // check it makes when it wakes is the only thing between that and a
    // subscription outliving the server it belongs to.
    const pending = owner.resume({ instance: "atlas", bot: "default" });
    await owner.stop();

    expect(await pending).toMatchObject({ observing: false, restarted: false });
    expect(owner.observing()).toEqual([]);
    expect(script.live("atlas/default")).toBe(0);
  });

  test("the resume is machinery, not a second declaration for `chat.observe`", () => {
    expect(MACHINERY_RPC).toContain("chat.observe.resume");
    expect(RPC_DECLARATIONS.filter((d) => d.path === "chat.observe")).toHaveLength(1);
  });

  test("a resumed conversation is still one subscription however many tabs read it", async () => {
    const { script, owner, ctx } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();
    die(script, "atlas/default");
    await settle();

    await dispatch(ctx, "chat.observe.resume", { instance: "atlas", bot: "default" });
    await settle();

    const tabs = [];
    for (let i = 0; i < 3; i++) {
      tabs.push(await openStream(ctx, "chat.observe", { instance: "atlas", bot: "default" }));
    }
    const fan = await openStream(ctx, "chat.subscribe", {});
    script.push("atlas/default", message("atlas", "default", "from Desktop"));
    for (const tab of tabs) expect((await tab.next())?.event).toBe("message");
    expect((await fan.next())?.event).toBe("message");

    // Four readers, one resume, one upstream read since the resume — and the
    // resume itself is the only reason a second one was ever made.
    expect(script.calls("atlas/default")).toBe(2);
    expect(script.live("atlas/default")).toBe(1);

    // And a tab leaving takes nothing with it.
    await tabs[0]?.cancel();
    await settle();
    expect(script.live("atlas/default")).toBe(1);
    for (const tab of tabs.slice(1)) await tab.cancel();
    await fan.cancel();
  });
});

/**
 * The two races the ownership rules leave open, and the shape of the answer.
 *
 * `resume` is deliberately outside the reconcile lock (§9.2: "a resume racing a
 * sync() still yields exactly one subscription"), and `join` runs on a request
 * that arrives whenever the browser feels like it. Both therefore have to hold
 * their own against the two things that empty the map underneath them — a
 * §4.8 fleet switch, and a shutdown.
 */
describe("a race against the map being emptied", () => {
  /** The same script, with the one read `resume` awaits held open by the test. */
  function gated(options: ScriptOptions) {
    const script = chatScript(options);
    let open = (): void => {};
    const held = new Promise<void>((resolve) => {
      open = () => resolve();
    });
    const hermetic = {
      ...script.hermetic,
      chat: {
        ...script.hermetic.chat,
        listening: async () => {
          await held;
          return script.hermetic.chat.listening({});
        },
      },
    } as unknown as Hermetic;
    const owner = createChatOwner({ hermetic: () => hermetic, log: memoryLog() });
    owners.push(owner);
    return { script, owner, open: (): void => open() };
  }

  test("a resume suspended across a fleet switch resumes nothing", async () => {
    // The fleet the resume was asked about is not the fleet `hermetic()` will
    // answer for by the time its `listening` read comes back. Re-reading `subs`
    // is not enough to see that: `reset()` cleared the map rather than putting
    // something else in it, so the check passes and the subscription lands in
    // the fleet this server has left.
    const { script, owner, open } = gated({ listening: ["atlas"], bots: { atlas: ["default"] } });

    const resuming = owner.resume({ instance: "atlas", bot: "default" });
    await owner.reset();
    open();
    const answer = await resuming;

    expect(answer).toMatchObject({ observing: false, restarted: false });
    expect(owner.observing()).toEqual([]);
    expect(script.opens).toEqual([]);
  });

  test("a resume suspended across a shutdown resumes nothing", async () => {
    const { script, owner, open } = gated({ listening: ["atlas"], bots: { atlas: ["default"] } });

    const resuming = owner.resume({ instance: "atlas", bot: "default" });
    await owner.stop();
    open();

    expect(await resuming).toMatchObject({ observing: false, restarted: false });
    expect(owner.observing()).toEqual([]);
    expect(script.opens).toEqual([]);
  });

  test("a request that arrives after the shutdown joins nothing and starts nothing", async () => {
    // An SSE `GET …/observe` in flight when the process was asked to stop used
    // to create a guest subscription — and an upstream `chat.observe` — after
    // the drain had already finished waiting for every read loop there was.
    const { script, owner } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();
    await owner.stop();

    const controller = new AbortController();
    const seen: ChatObserveEvent[] = [];
    const reading = (async () => {
      for await (const event of owner.join({ instance: "atlas", bot: "default" }, controller.signal))
        seen.push(event);
    })();
    // A stream that does not end on its own must not hang the suite.
    const guard = setTimeout(() => controller.abort(), 500);
    await reading;
    clearTimeout(guard);

    expect(seen).toEqual([
      {
        type: "error",
        instance: "atlas",
        bot: "default",
        code: "ABORTED",
        message: "the portal stopped observing",
      },
    ]);
    expect(owner.observing()).toEqual([]);
    // The one the boot sync opened, and nothing after it.
    expect(script.calls("atlas/default")).toBe(1);
  });

  /**
   * Keyed on the canonical subscription's *held read*, not merely on one being
   * pinned: a session that is genuinely not the canonical one is resumed as
   * its own subscription and held as one (see "a named session is resumed as
   * itself" above), and refusing every session on a bot with a pinned
   * canonical conversation would take that feature away.
   */
  test("resuming a canonical conversation by its session id finds the one already held", async () => {
    // What the `Watch again` button used to send. A canonical subscription is
    // keyed on `session: null`, so the session id the browser had resolved
    // missed it and started a second pinned observation of one conversation.
    const { script, owner } = harness({ listening: ["atlas"], bots: { atlas: ["default"] } });
    await owner.sync();
    script.push("atlas/default", snapshot("atlas", "default", ["one"]));
    await settle();

    const answer = await owner.resume({
      instance: "atlas",
      bot: "default",
      session: "default-canonical",
    });

    expect(answer).toMatchObject({ observing: true, restarted: false });
    expect(script.opens).toEqual(["atlas/default"]);
  });
});

/**
 * The fan-in's seed and its bound are one queue, not two.
 *
 * `dropped` is this route's promise that a gap is announced rather than
 * hidden, and the seed used to be pushed past the trim — so a server owning
 * more conversations than the cap started over it, and the first live event
 * evicted *seed* frames the client had not been sent yet and reported them as
 * a gap in the live stream.
 */
describe("the fan-in seed", () => {
  test("a seed larger than the cap is trimmed, and says so", async () => {
    const seeds: OwnedChatEvent[] = [];
    for (let i = 0; i <= CHAT_STREAM_MAX_QUEUED; i++) {
      seeds.push({
        conversation: { instance: "atlas", bot: `bot${i}`, session: null },
        event: snapshot("atlas", `bot${i}`),
      });
    }
    const script = chatScript();
    const owner = {
      snapshots: () => seeds,
      subscribe: () => () => {},
    } as unknown as ChatOwner;
    const ctx = contextFor(script.hermetic, owner, memoryLog());

    const stream = await openStream(ctx, "chat.subscribe", {});
    const first = await stream.next();
    expect(first?.event).toBe("dropped");
    expect(JSON.parse(first?.data ?? "null")).toEqual({ count: 1 });
    // The oldest went, so the stream opens on the second conversation seeded.
    const second = await stream.next();
    expect(
      (JSON.parse(second?.data ?? "null") as { conversation: { bot: string } }).conversation.bot,
    ).toBe("bot1");
    await stream.cancel();
  });
});
