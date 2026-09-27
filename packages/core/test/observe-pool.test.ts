/**
 * The observe pool's sharing policy (`src/chat/observe-pool.ts`).
 *
 * What these pin down is the multiplexing: one upstream `observe` per
 * conversation however many readers, what a late reader is seeded with, what
 * is remembered once a read ends and for how long. Lifetime — which
 * conversations are pinned and when the pool stops — is the head's, and the
 * portal's tests for it are `packages/app/test/chat-owner.test.ts`.
 *
 * `observe` is a double: every call is recorded and driven by name. No
 * network, no timers left armed, every wait bounded.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { HermeticError } from "../src/errors.ts";
import { OBSERVE_WINDOW } from "../src/chat/chat-observe.ts";
import {
  OBSERVE_POOL_MAX_REMEMBERED_FAILURES,
  createObservePool,
  type ChatConversationRef,
  type ObservePool,
  type ObservePoolLogLevel,
} from "../src/chat/observe-pool.ts";
import type { ChatObserveEvent, ChatObserveInput } from "../src/schema/index.ts";

/* ── the upstream double ──────────────────────────────────────────────────── */

interface Channel {
  pending: ChatObserveEvent[];
  ended: boolean;
  wake: (() => void) | null;
  closed: boolean;
}

const key = (input: ChatObserveInput): string =>
  input.session === undefined
    ? `${input.instance}/${input.bot}`
    : `${input.instance}/${input.bot}#${input.session}`;

function script(options: { throws?: unknown } = {}) {
  const opens: string[] = [];
  const channels = new Map<string, Channel[]>();
  const lines: { level: ObservePoolLogLevel; message: string; fields: Record<string, unknown> }[] = [];

  const observe = (
    input: ChatObserveInput,
    opts: { signal: AbortSignal },
  ): AsyncIterable<ChatObserveEvent> => {
    if (options.throws !== undefined) throw options.throws;
    const k = key(input);
    opens.push(k);
    const channel: Channel = { pending: [], ended: false, wake: null, closed: false };
    channels.set(k, [...(channels.get(k) ?? []), channel]);
    const nudge = (): void => {
      const resume = channel.wake;
      channel.wake = null;
      resume?.();
    };
    return (async function* () {
      opts.signal.addEventListener("abort", nudge, { once: true });
      try {
        for (;;) {
          while (channel.pending.length > 0) {
            const head = channel.pending.shift();
            if (head !== undefined) yield head;
          }
          if (channel.ended || opts.signal.aborted) return;
          await new Promise<void>((resolve) => {
            channel.wake = resolve;
          });
        }
      } finally {
        opts.signal.removeEventListener("abort", nudge);
        channel.closed = true;
      }
    })();
  };

  function each(k: string, run: (channel: Channel) => void): void {
    for (const channel of channels.get(k) ?? []) {
      run(channel);
      const resume = channel.wake;
      channel.wake = null;
      resume?.();
    }
  }

  return {
    observe,
    opens,
    lines,
    log: (level: ObservePoolLogLevel, message: string, fields: Record<string, unknown>) => {
      lines.push({ level, message, fields });
    },
    live: (k: string): number => (channels.get(k) ?? []).filter((c) => !c.closed).length,
    calls: (k: string): number => opens.filter((open) => open === k).length,
    push(k: string, event: ChatObserveEvent): void {
      each(k, (channel) => channel.pending.push(event));
    },
    end(k: string): void {
      each(k, (channel) => {
        channel.ended = true;
      });
    },
  };
}

/* ── events ───────────────────────────────────────────────────────────────── */

type ChatRow = Extract<ChatObserveEvent, { type: "message" }>["message"];

const row = (bot: string, text: string, session = `${bot}-canonical`): ChatRow => ({
  id: `${bot}-${session}-${text}`,
  session,
  role: "bot",
  at: "2026-09-18T12:00:00.000Z",
  blocks: [{ kind: "text", markdown: text }],
});

const snapshot = (bot: string, texts: string[] = [], session = `${bot}-canonical`) =>
  ({
    type: "snapshot",
    instance: "atlas",
    bot,
    session,
    messages: texts.map((text) => row(bot, text, session)),
    at: "2026-09-18T12:00:00.000Z",
  }) satisfies ChatObserveEvent;

const message = (bot: string, text: string, session = `${bot}-canonical`) =>
  ({
    type: "message",
    instance: "atlas",
    bot,
    session,
    message: row(bot, text, session),
  }) satisfies ChatObserveEvent;

const reconnecting = (bot: string, attempt: number): ChatObserveEvent => ({
  type: "reconnect",
  instance: "atlas",
  bot,
  attempt,
  delay_ms: 2000,
  code: "CHAT_UNREACHABLE",
  message: "atlas: dashboard did not answer",
});

const failed = (bot: string, message = "the retry budget is spent"): ChatObserveEvent => ({
  type: "error",
  instance: "atlas",
  bot,
  code: "CHAT_UNREACHABLE",
  message,
});

const ref = (bot: string, session: string | null = null): ChatConversationRef => ({
  instance: "atlas",
  bot,
  session,
});

/* ── harness ──────────────────────────────────────────────────────────────── */

const pools: ObservePool[] = [];

function harness(options: { throws?: unknown; maxRememberedFailures?: number } = {}) {
  const upstream = script(options);
  const pool = createObservePool({
    observe: upstream.observe,
    log: upstream.log,
    ...(options.maxRememberedFailures === undefined
      ? {}
      : { maxRememberedFailures: options.maxRememberedFailures }),
  });
  pools.push(pool);
  return { upstream, pool };
}

afterEach(async () => {
  while (pools.length > 0) await pools.pop()?.stop();
});

/** Long enough for a microtask-started read loop to run; never a wait for work. */
const settle = (): Promise<void> => Bun.sleep(10);

/** A reader: collects until aborted or ended, with a deadline so nothing hangs. */
function reader(pool: ObservePool, bot: string, session?: string) {
  const controller = new AbortController();
  const seen: ChatObserveEvent[] = [];
  const done = (async () => {
    for await (const event of pool.join(
      { instance: "atlas", bot, ...(session === undefined ? {} : { session }) },
      controller.signal,
    ))
      seen.push(event);
  })();
  const guard = setTimeout(() => controller.abort(), 2000);
  return {
    seen,
    async leave(): Promise<ChatObserveEvent[]> {
      controller.abort();
      await done;
      clearTimeout(guard);
      return seen;
    },
    async ended(): Promise<ChatObserveEvent[]> {
      await done;
      clearTimeout(guard);
      return seen;
    },
  };
}

const seededIds = (events: ChatObserveEvent[]): string[] => {
  const held = events.find((event) => event.type === "snapshot");
  return held?.type === "snapshot" ? held.messages.map((m) => m.id) : [];
};

/* ── one subscription, many readers ───────────────────────────────────────── */

describe("one upstream read per conversation", () => {
  test("a pinned conversation is one call however many readers join it", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    await settle();
    const tabs = [reader(pool, "default"), reader(pool, "default"), reader(pool, "default")];
    upstream.push("atlas/default", message("default", "one"));
    await settle();

    expect(upstream.calls("atlas/default")).toBe(1);
    for (const tab of tabs) expect(tab.seen.map((e) => e.type)).toEqual(["message"]);

    // A reader leaving takes nothing with it.
    await tabs[0]?.leave();
    expect(upstream.live("atlas/default")).toBe(1);
    expect(pool.held().map((entry) => entry.pinned)).toEqual([true]);
    for (const tab of tabs.slice(1)) await tab.leave();
    expect(upstream.live("atlas/default")).toBe(1);
  });

  test("a guest is refcounted: opened by the first reader, ended by the last", async () => {
    const { upstream, pool } = harness();
    const first = reader(pool, "default", "thread-7");
    await settle();
    const second = reader(pool, "default", "thread-7");
    await settle();

    expect(upstream.calls("atlas/default#thread-7")).toBe(1);
    expect(pool.held()).toEqual([{ ref: ref("default", "thread-7"), pinned: false, session: null }]);

    await first.leave();
    await settle();
    expect(upstream.live("atlas/default#thread-7")).toBe(1);
    await second.leave();
    await settle();
    expect(upstream.live("atlas/default#thread-7")).toBe(0);
    expect(pool.held()).toEqual([]);
  });

  test("pinning a guest holds it past its readers; unpinning hands it back", async () => {
    const { upstream, pool } = harness();
    const tab = reader(pool, "default");
    await settle();
    pool.pin(ref("default"));
    await tab.leave();
    await settle();
    expect(upstream.live("atlas/default")).toBe(1);

    pool.unpin(ref("default"), "roster changed");
    await settle();
    expect(upstream.live("atlas/default")).toBe(0);
    expect(upstream.calls("atlas/default")).toBe(1);
  });

  test("a reader that throws loses its own events and ends nobody else's", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    await settle();
    const seen: string[] = [];
    pool.subscribe(() => {
      throw new Error("a bad listener");
    });
    pool.subscribe((event) => void seen.push(event.event.type));
    upstream.push("atlas/default", message("default", "one"));
    await settle();

    expect(seen).toEqual(["message"]);
    expect(upstream.live("atlas/default")).toBe(1);
  });
});

/* ── the seed ─────────────────────────────────────────────────────────────── */

describe("a reader that connects late is seeded with the messages it missed", () => {
  test("a message that landed before the reader joined is in the snapshot it is handed", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    await settle();
    upstream.push("atlas/default", snapshot("default", ["one"]));
    upstream.push("atlas/default", message("default", "two"));
    await settle();

    const tab = reader(pool, "default");
    await settle();
    expect(tab.seen.map((e) => e.type)).toEqual(["snapshot"]);
    expect(seededIds(tab.seen)).toEqual([
      "default-default-canonical-one",
      "default-default-canonical-two",
    ]);
    // `snapshots()` answers with the same held read.
    expect(seededIds(pool.snapshots().map((seed) => seed.event))).toEqual(seededIds(tab.seen));
    await tab.leave();
  });

  test("a message the seed already carries is not folded in twice", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    await settle();
    upstream.push("atlas/default", snapshot("default", ["one"]));
    upstream.push("atlas/default", message("default", "two"));
    upstream.push("atlas/default", message("default", "two"));
    upstream.push("atlas/default", message("default", "one"));
    await settle();

    expect(seededIds(pool.snapshots().map((seed) => seed.event))).toEqual([
      "default-default-canonical-one",
      "default-default-canonical-two",
    ]);
  });

  test("a conversation longer than the window seeds the newest window of it", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    await settle();
    upstream.push("atlas/default", snapshot("default", ["m0"]));
    const extra = 5;
    for (let i = 1; i <= OBSERVE_WINDOW + extra - 1; i++) {
      upstream.push("atlas/default", message("default", `m${i}`));
    }
    await settle();

    const ids = seededIds(pool.snapshots().map((seed) => seed.event));
    expect(ids).toHaveLength(OBSERVE_WINDOW);
    expect(ids[0]).toBe(`default-default-canonical-m${extra}`);
    expect(ids.at(-1)).toBe(`default-default-canonical-m${OBSERVE_WINDOW + extra - 1}`);
  });

  test("a message folded in leaves `at` unchanged", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    await settle();
    const opened = snapshot("default", ["one"]);
    upstream.push("atlas/default", opened);
    upstream.push("atlas/default", {
      ...message("default", "two"),
      message: { ...row("default", "two"), at: "2026-09-18T13:30:00.000Z" },
    });
    await settle();

    const held = pool.snapshots()[0]?.event;
    expect(held?.type === "snapshot" ? held.at : null).toBe(opened.at);
    expect(seededIds(pool.snapshots().map((seed) => seed.event))).toHaveLength(2);
  });
});

describe("a conversation whose session rolled over", () => {
  test("the held read resets on the rollover snapshot rather than accumulating", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    await settle();
    upstream.push("atlas/default", snapshot("default", ["one"], "s1"));
    upstream.push("atlas/default", message("default", "two", "s1"));
    upstream.push("atlas/default", snapshot("default", ["fresh"], "s2"));
    await settle();

    const held = pool.snapshots()[0]?.event;
    expect(held?.type === "snapshot" ? held.session : null).toBe("s2");
    expect(seededIds(pool.snapshots().map((seed) => seed.event))).toEqual(["default-s2-fresh"]);
    expect(pool.held()[0]?.session).toBe("s2");
  });

  test("a message from a session the held read did not come from is never folded in", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    await settle();
    upstream.push("atlas/default", snapshot("default", ["one"], "s1"));
    upstream.push("atlas/default", message("default", "stray", "s2"));
    upstream.push("atlas/default", message("default", "two", "s1"));
    await settle();

    // Refusing one message is not the same as dropping the read.
    expect(seededIds(pool.snapshots().map((seed) => seed.event))).toEqual([
      "default-s1-one",
      "default-s1-two",
    ]);
  });
});

/* ── health ───────────────────────────────────────────────────────────────── */

describe("a reader that connects late learns the observation's health", () => {
  test("a reader opened mid-backoff is told it is reconnecting, after the transcript", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    await settle();
    upstream.push("atlas/default", snapshot("default"));
    upstream.push("atlas/default", reconnecting("default", 4));
    await settle();

    const tab = reader(pool, "default");
    await settle();
    expect(tab.seen.map((e) => e.type)).toEqual(["snapshot", "reconnect"]);
    expect(pool.snapshots().map((seed) => seed.event.type)).toEqual(["snapshot", "reconnect"]);
    await tab.leave();
  });

  test("a recovery is not replayed", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    await settle();
    upstream.push("atlas/default", reconnecting("default", 1));
    upstream.push("atlas/default", snapshot("default"));
    await settle();

    expect(pool.snapshots().map((seed) => seed.event.type)).toEqual(["snapshot"]);
  });

  test("a pinned conversation that failed is remembered, replayed, and not re-read", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    await settle();
    upstream.push("atlas/default", failed("default", "atlas: dashboard did not answer"));
    upstream.end("atlas/default");
    await settle();

    expect(pool.held()).toEqual([]);
    expect(pool.failed()).toEqual([ref("default")]);
    expect(pool.snapshots()).toEqual([
      { conversation: ref("default"), event: failed("default", "atlas: dashboard did not answer") },
    ]);
    // Told what it missed, and then the stream ends — no retry loop.
    const seen = await reader(pool, "default").ended();
    expect(seen.map((e) => e.type)).toEqual(["error"]);
    expect(upstream.calls("atlas/default")).toBe(1);
  });

  test("a guest that failed is not remembered: its reader saw it live", async () => {
    const { upstream, pool } = harness();
    const tab = reader(pool, "default");
    await settle();
    upstream.push("atlas/default", failed("default"));
    upstream.end("atlas/default");
    const seen = await tab.ended();

    expect(seen.map((e) => e.type)).toEqual(["error"]);
    expect(pool.failed()).toEqual([]);
    expect(pool.snapshots()).toEqual([]);
  });

  test("a replayed failure is masked", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    await settle();
    upstream.push("atlas/default", failed("default", "upstream refused: Bearer FIXTURE-BEARER-TOKEN"));
    upstream.end("atlas/default");
    await settle();

    const seed = pool.snapshots()[0]?.event;
    const text = seed?.type === "error" ? seed.message : "";
    expect(text).not.toContain("FIXTURE-BEARER-TOKEN");
    expect(text).toContain("Bearer [redacted]");
    expect(JSON.stringify(upstream.lines)).not.toContain("FIXTURE-BEARER-TOKEN");
  });

  test("the remembered failures are bounded, oldest evicted first", async () => {
    const cap = 8;
    const { upstream, pool } = harness({ maxRememberedFailures: cap });
    const names = Array.from({ length: cap + 3 }, (_, i) => `bot${String(i).padStart(2, "0")}`);
    for (const name of names) pool.pin(ref(name));
    await settle();
    for (const name of names) {
      upstream.push(`atlas/${name}`, failed(name));
      upstream.end(`atlas/${name}`);
    }
    await settle();

    const kept = pool.failed().map((r) => r.bot);
    expect(kept).toHaveLength(cap);
    expect(kept).toEqual(names.slice(3));
    expect(OBSERVE_POOL_MAX_REMEMBERED_FAILURES).toBe(64);
  });

  test("pinning a failed conversation again forgets the failure; `forget` drops it alone", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    pool.pin(ref("granite"));
    await settle();
    for (const bot of ["default", "granite"]) {
      upstream.push(`atlas/${bot}`, failed(bot));
      upstream.end(`atlas/${bot}`);
    }
    await settle();
    expect(pool.failed()).toHaveLength(2);

    pool.forget(ref("granite"));
    expect(pool.failed()).toEqual([ref("default")]);
    expect(upstream.calls("atlas/granite")).toBe(1);

    pool.pin(ref("default"));
    await settle();
    expect(pool.failed()).toEqual([]);
    expect(upstream.calls("atlas/default")).toBe(2);
  });

  test("an unclassified throw is masked for the reader and whole in the log", async () => {
    const leaky = new Error("connect ECONNREFUSED 10.11.12.13:443");
    const { upstream, pool } = harness({ throws: leaky });
    const seen = await reader(pool, "default").ended();

    expect(seen).toEqual([
      { type: "error", instance: "atlas", bot: "default", code: "INTERNAL", message: "internal error" },
    ]);
    const line = upstream.lines.find((l) => l.message === "observation failed");
    expect(line?.fields.internal).toContain("ECONNREFUSED");
  });

  test("a HermeticError throw is forwarded with its code", async () => {
    const { pool } = harness({ throws: new HermeticError("CHAT_UNREACHABLE", "box is down") });
    const seen = await reader(pool, "default").ended();
    expect(seen).toEqual([
      {
        type: "error",
        instance: "atlas",
        bot: "default",
        code: "CHAT_UNREACHABLE",
        message: "box is down",
      },
    ]);
  });
});

/* ── drain and stop ───────────────────────────────────────────────────────── */

describe("drain and stop", () => {
  test("a drain lets every subscription go, forgets every failure, and bumps the epoch", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    pool.pin(ref("granite"));
    await settle();
    upstream.push("atlas/granite", failed("granite"));
    upstream.end("atlas/granite");
    await settle();
    const before = pool.epoch();
    const tab = reader(pool, "default");
    await settle();

    await pool.drain("fleet switch");

    expect(pool.epoch()).toBe(before + 1);
    expect(pool.held()).toEqual([]);
    expect(pool.failed()).toEqual([]);
    expect(upstream.live("atlas/default")).toBe(0);
    // The reader's stream ended rather than hanging on a subscription that is gone.
    expect((await tab.ended()).map((e) => e.type)).toEqual([]);

    // Still usable: a pin after a drain observes again.
    pool.pin(ref("default"));
    await settle();
    expect(upstream.calls("atlas/default")).toBe(2);
  });

  test("after stop, a pin starts nothing and a join ends at once with ABORTED", async () => {
    const { upstream, pool } = harness();
    pool.pin(ref("default"));
    await settle();
    await pool.stop();

    pool.pin(ref("granite"));
    await settle();
    expect(upstream.opens).toEqual(["atlas/default"]);
    expect(pool.stopped()).toBe(true);

    const seen = await reader(pool, "default").ended();
    expect(seen).toEqual([
      {
        type: "error",
        instance: "atlas",
        bot: "default",
        code: "ABORTED",
        message: "the portal stopped observing",
      },
    ]);
  });
});
