/**
 * The developer tools' requests (`handlers/devtools.ts`), against a stand-in
 * for core's `hermetic.devtools` that holds the contract and nothing else.
 *
 * What is asserted is the head's half: the gate refuses while the tools are
 * off, a tap's records reach the sink coalesced into batches, and closing a
 * tap stops its pushes and its source. What core captures, and how it masks
 * it, is core's suite.
 */
import { describe, expect, test } from "bun:test";
import { HermeticError, isHermeticError } from "@hermetic/core";
import type { Hermetic, TapRecord } from "@hermetic/core";
import type { HandlerContext } from "../../src/handlers/ctx.ts";
import { TAP_BATCH_MAX, TAP_FLUSH_MS } from "../../src/handlers/devtools.ts";
import { HANDLERS, dispatch } from "../../src/handlers/dispatch.ts";
import { createStreamRegistry, type StreamFrame } from "../../src/handlers/streams.ts";
import { MACHINERY_RPC } from "../../src/rpc/registry.ts";
import { MESSAGE_FOR_REQUEST } from "../../src/rpc/schema.ts";

const CONVERSATION = { instance: "atlas", bot: "default", session: null };

function record(n: number): TapRecord {
  return {
    id: `t${n}`,
    at: 1_700_000_000_000 + n,
    mono: n,
    conversation: CONVERSATION,
    socket: "held#1",
    layer: "wire",
    dir: "in",
    type: "message.delta",
    seq: n,
    parent: null,
    fate: { kind: "frames", count: 1 },
    bytes: 10,
    payload: { text: `chunk ${n}` },
  };
}

/** A capture core would hold: a settings row, and a live source per tap. */
function fakeDevtools(enabled: boolean) {
  let settings = { enabled, capture: "always" as const, keep: 5000 as const };
  const taps: {
    push: (r: TapRecord) => void;
    end: (error?: unknown) => void;
    signal: AbortSignal;
    ended: () => boolean;
  }[] = [];
  const disabled = () => new HermeticError("DEVTOOLS_DISABLED", "developer tools are off");
  const devtools = {
    settings(input: unknown = {}) {
      settings = { ...settings, ...(input as object) };
      return settings;
    },
    stats() {
      if (!settings.enabled) throw disabled();
      return { conversations: 1, records: 0, bytes: 0, dropped: 0 };
    },
    clear() {
      return { cleared: 0 };
    },
    export() {
      return { ndjson: "", count: 0 };
    },
    tap(_input: unknown, opts: { signal?: AbortSignal } = {}): AsyncIterable<TapRecord> {
      if (!settings.enabled) throw disabled();
      const queue: TapRecord[] = [];
      let wake: (() => void) | null = null;
      let finished = false;
      let failure: unknown = null;
      let returned = false;
      const signal = opts.signal ?? new AbortController().signal;
      signal.addEventListener("abort", () => {
        finished = true;
        wake?.();
      });
      taps.push({
        push: (r) => {
          queue.push(r);
          wake?.();
        },
        end: (error) => {
          finished = true;
          failure = error ?? null;
          wake?.();
        },
        signal,
        ended: () => returned,
      });
      return {
        async *[Symbol.asyncIterator]() {
          try {
            while (true) {
              if (queue.length > 0) {
                yield queue.shift()!;
                continue;
              }
              if (finished) {
                if (failure !== null) throw failure;
                return;
              }
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = null;
            }
          } finally {
            returned = true;
          }
        },
      };
    },
  };
  return { devtools, taps };
}

function harness(enabled: boolean) {
  const fake = fakeDevtools(enabled);
  const hermetic = { devtools: fake.devtools } as unknown as Hermetic;
  const ctx = {
    hermetic: () => hermetic,
    streams: createStreamRegistry(),
  } as unknown as HandlerContext;
  const frames: StreamFrame[] = [];
  const sink = (frame: StreamFrame) => {
    frames.push(frame);
  };
  return { ctx, frames, sink, ...fake };
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (e) {
    if (isHermeticError(e)) return e.code;
    throw e;
  }
  throw new Error("expected a refusal; the call resolved");
}

const settle = (ms = TAP_FLUSH_MS * 3) => new Promise((resolve) => setTimeout(resolve, ms));

describe("devtools requests", () => {
  test("are machinery, answered by dispatch, and the tap rides devtools.record", () => {
    for (const name of [
      "devtools.settings",
      "devtools.stats",
      "devtools.tap",
      "devtools.untap",
      "devtools.clear",
      "devtools.export",
    ]) {
      expect(MACHINERY_RPC).toContain(name);
      expect(HANDLERS[name]).toBeDefined();
    }
    expect(MESSAGE_FOR_REQUEST["devtools.tap"]).toBe("devtools.record");
  });

  test("with the tools off, settings answers and everything else refuses", async () => {
    const h = harness(false);
    expect(await dispatch(h.ctx, "devtools.settings", {})).toMatchObject({ enabled: false });
    expect(await codeOf(dispatch(h.ctx, "devtools.stats", {}))).toBe("DEVTOOLS_DISABLED");
    expect(await codeOf(dispatch(h.ctx, "devtools.clear", {}))).toBe("DEVTOOLS_DISABLED");
    expect(await codeOf(dispatch(h.ctx, "devtools.export", { conversation: CONVERSATION }))).toBe(
      "DEVTOOLS_DISABLED",
    );
    expect(await codeOf(dispatch(h.ctx, "devtools.tap", { conversation: CONVERSATION }, h.sink))).toBe(
      "DEVTOOLS_DISABLED",
    );
    // Refused before a stream was opened: nothing to close, nothing pushed.
    expect(h.taps.length).toBe(0);
    expect(h.frames.length).toBe(0);
  });

  test("turning the tools on through settings opens the gate", async () => {
    const h = harness(false);
    expect(await dispatch(h.ctx, "devtools.settings", { enabled: true })).toMatchObject({
      enabled: true,
    });
    expect(await dispatch(h.ctx, "devtools.stats", {})).toMatchObject({ conversations: 1 });
  });

  test("a tap's records reach the sink coalesced, and untap stops them", async () => {
    const h = harness(true);
    const { stream_id } = (await dispatch(
      h.ctx,
      "devtools.tap",
      { conversation: CONVERSATION },
      h.sink,
    )) as { stream_id: string };
    expect(h.taps.length).toBe(1);
    const source = h.taps[0]!;
    for (let n = 1; n <= 5; n++) source.push(record(n));
    await settle();
    // Five records inside one flush window are one push.
    expect(h.frames.length).toBe(1);
    expect(h.frames[0]?.event).toBe("records");
    expect((h.frames[0]!.data as TapRecord[]).map((r) => r.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);

    source.push(record(6));
    await settle();
    expect(h.frames.length).toBe(2);

    expect(await dispatch(h.ctx, "devtools.untap", { stream_id })).toEqual({ closed: true });
    expect(source.signal.aborted).toBe(true);
    source.push(record(7));
    await settle();
    expect(h.frames.length).toBe(2);
    expect(source.ended()).toBe(true);
    // Closing twice is not an error.
    expect(await dispatch(h.ctx, "devtools.untap", { stream_id })).toEqual({ closed: false });
  });

  test("a backlog larger than one batch goes out in several pushes, in order", async () => {
    const h = harness(true);
    await dispatch(h.ctx, "devtools.tap", { conversation: CONVERSATION }, h.sink);
    const source = h.taps[0]!;
    const total = TAP_BATCH_MAX * 2 + 3;
    for (let n = 1; n <= total; n++) source.push(record(n));
    await settle();
    const sizes = h.frames.map((f) => (f.data as TapRecord[]).length);
    expect(sizes.every((s) => s <= TAP_BATCH_MAX)).toBe(true);
    const ids = h.frames.flatMap((f) => (f.data as TapRecord[]).map((r) => r.id));
    expect(ids.length).toBe(total);
    expect(ids[0]).toBe("t1");
    expect(ids[total - 1]).toBe(`t${total}`);
  });

  test("a source that fails ends the tap with a done naming the code", async () => {
    const h = harness(true);
    const { stream_id } = (await dispatch(
      h.ctx,
      "devtools.tap",
      { conversation: CONVERSATION },
      h.sink,
    )) as { stream_id: string };
    const source = h.taps[0]!;
    source.push(record(1));
    source.end(new HermeticError("DEVTOOLS_DISABLED", "developer tools are off"));
    await settle();
    expect(h.frames.map((f) => f.event)).toEqual(["records", "done"]);
    expect(h.frames[1]?.data).toMatchObject({ ok: false, error: { code: "DEVTOOLS_DISABLED" } });
    // The finished stream forgot itself.
    expect(h.ctx.streams.has(stream_id)).toBe(false);
  });
});
