/**
 * The developer tools' capture and surface (§9.2 "Developer tools"): the ring,
 * its masking, `capture: while_open`, the off switch, the preferences, and the
 * fixture backend's synthetic wire beneath its frames.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVTAP_MAX_RINGS,
  DEVTAP_RING_MAX_BYTES,
  DEVTAP_TOTAL_MAX_BYTES,
  DevTap,
} from "../src/chat/devtap.ts";
import type { TapEntry } from "../src/chat/devtap.ts";
import { MemoryDevtoolsSettingsStore, createDevtools } from "../src/chat/devtools.ts";
import { TapSlot } from "../src/chat/hermes/hermes-chat-devtap.ts";
import { readRpc } from "../src/chat/hermes/hermes-chat-rpc.ts";
import type { ChatSocket } from "../src/chat/hermes/hermes-chat-types.ts";
import { isHermeticError } from "../src/errors.ts";
import { openHermetic } from "../src/open.ts";
import type { DevtoolsConversation, TapRecord } from "../src/schema/index.ts";

const CONV: DevtoolsConversation = { instance: "atlas", bot: "default", session: null };
const OTHER: DevtoolsConversation = { instance: "atlas", bot: "default", session: "s-other" };
const SECRET = "sk-or-v1-FIXTURE-DEVTOOLS-KEY";

const entry = (type: string, payload: unknown = {}): TapEntry => ({
  layer: "wire",
  dir: "in",
  type,
  payload,
});

function tapWith(opts: Partial<ConstructorParameters<typeof DevTap>[0]> = {}): DevTap {
  return new DevTap({ capture: "always", keep: 1000, redact: () => false, ...opts });
}

/** Read what a subscription delivers within a few ms, then hang up. */
async function read(
  tap: DevTap,
  conversation: DevtoolsConversation,
  during?: () => void,
): Promise<TapRecord[]> {
  const controller = new AbortController();
  const seen: TapRecord[] = [];
  const reading = (async () => {
    for await (const r of tap.subscribe(conversation, controller.signal)) seen.push(r);
  })();
  await new Promise((done) => setTimeout(done, 2));
  during?.();
  await new Promise((done) => setTimeout(done, 2));
  controller.abort();
  await reading;
  return seen;
}

function refusal(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return isHermeticError(e) ? String(e.code) : "not a HermeticError";
  }
}

describe("devtap · the ring", () => {
  test("a full ring evicts its oldest and counts what it dropped", () => {
    const tap = tapWith({ keep: 1000 });
    for (let i = 0; i < 1003; i += 1) tap.add(CONV, entry("message.delta", { i }));
    tap.add(OTHER, entry("message.delta", { i: 0 }));
    const stats = tap.stats();
    expect(stats.records).toBe(1001);
    expect(stats.conversations).toBe(2);
    expect(stats.dropped).toBe(3);
    expect(stats.bytes).toBeGreaterThan(0);
    const exported = tap.exportRing(CONV).ndjson.trim().split("\n");
    expect(exported).toHaveLength(1000);
    expect((JSON.parse(exported[0] ?? "{}") as TapRecord).payload).toEqual({ i: 3 });
  });

  test("ids are monotonic and `bytes` is the size before masking", () => {
    const tap = tapWith({ redact: () => true });
    const a = tap.add(CONV, { ...entry("x"), raw: `{"key":"${SECRET}"}`, payload: { key: SECRET } });
    const b = tap.add(CONV, entry("y"));
    expect(Number(b?.id.slice(1))).toBeGreaterThan(Number(a?.id.slice(1)));
    expect(a?.record.bytes).toBe(`{"key":"${SECRET}"}`.length);
  });

  test("a smaller `keep` re-bounds every ring at once", () => {
    const tap = tapWith({ keep: 5000 });
    for (let i = 0; i < 1500; i += 1) tap.add(CONV, entry("d"));
    tap.configure({ capture: "always", keep: 1000 });
    expect(tap.stats().records).toBe(1000);
    expect(tap.stats().dropped).toBe(500);
  });

  test("clear empties one conversation, or all of them and the dropped count", () => {
    const tap = tapWith();
    tap.add(CONV, entry("a"));
    tap.add(OTHER, entry("b"));
    tap.add(OTHER, entry("c"));
    expect(tap.clear(OTHER)).toBe(2);
    expect(tap.stats().records).toBe(1);
    expect(tap.clear()).toBe(1);
    expect(tap.stats()).toEqual({ conversations: 0, records: 0, bytes: 0, dropped: 0 });
  });

  test("a canonical session's id files its records under `session: null`", async () => {
    const tap = tapWith();
    tap.canonical("atlas", "default", "s-canon");
    tap.add({ ...CONV, session: "s-canon" }, entry("message.delta"));
    const seen = await read(tap, CONV);
    expect(seen.map((r) => r.conversation)).toEqual([CONV]);
  });

  test("a tap delivers its backlog, then live records, then a settled fate again", async () => {
    const tap = tapWith();
    const first = tap.add(CONV, entry("old"));
    const seen = await read(tap, CONV, () => {
      tap.add(CONV, entry("new"));
      first?.settle({ kind: "drop", reason: "internal" });
    });
    const firstId = first?.id ?? "missing";
    expect(seen.map((r) => [r.id === firstId, r.type, r.fate?.kind ?? null])).toEqual([
      [true, "old", null],
      [false, "new", null],
      [true, "old", "drop"],
    ]);
  });
});

describe("devtap · capture while open", () => {
  test("records only for a conversation an inspector is reading", async () => {
    const tap = tapWith({ capture: "while_open" });
    expect(tap.add(CONV, entry("before"))).toBeNull();
    const seen = await read(tap, CONV, () => {
      tap.add(CONV, entry("during"));
      tap.add(OTHER, entry("elsewhere"));
    });
    expect(seen.map((r) => r.type)).toEqual(["during"]);
    expect(tap.add(CONV, entry("after"))).toBeNull();
    expect(tap.stats().records).toBe(1);
  });
});

describe("devtap · masking", () => {
  test("redaction on at capture: the secret is never held", async () => {
    const tap = tapWith({ redact: () => true });
    tap.add(CONV, entry("tool.complete", { result: `key ${SECRET}` }));
    const seen = await read(tap, CONV);
    expect(JSON.stringify(seen)).not.toContain(SECRET);
  });

  test("redaction off: held and shown; masked once redaction turns on, and in every export", async () => {
    let redact = false;
    const tap = tapWith({ redact: () => redact });
    tap.add(CONV, entry("tool.complete", { result: `key ${SECRET}` }));
    expect(JSON.stringify(await read(tap, CONV))).toContain(SECRET);
    expect(tap.exportRing(CONV).ndjson).not.toContain(SECRET);
    redact = true;
    expect(JSON.stringify(await read(tap, CONV))).not.toContain(SECRET);
  });

  test("a URL token, a credential header and an error are masked whatever redaction says", async () => {
    const tap = tapWith({ redact: () => false });
    tap.add(CONV, {
      layer: "conn",
      dir: "out",
      type: "dial",
      payload: {
        url: "wss://box/api/ws?token=FIXTURE-HERMES-SESSION-TOKEN&x=1",
        headers: { Authorization: "Basic FIXTURE-AUTH-HEADER", Origin: "https://box" },
      },
    });
    tap.add(CONV, entry("session.resume", { id: 2, error: { message: `refused ${SECRET}` } }));
    tap.add(CONV, entry("turn.error", { message: `provider said ${SECRET}` }));
    const text = JSON.stringify(await read(tap, CONV));
    expect(text).not.toContain("FIXTURE-HERMES-SESSION-TOKEN");
    expect(text).not.toContain("FIXTURE-AUTH-HEADER");
    expect(text).not.toContain(SECRET);
    expect(text).toContain("token=[redacted]&x=1");
    expect(text).toContain("https://box");
  });
});

describe("devtools · the surface", () => {
  test("off: no capture exists, and every read refuses DEVTOOLS_DISABLED", () => {
    const devtools = createDevtools({ redact: () => false });
    expect(devtools.current()).toBeNull();
    const { controls } = devtools;
    expect(refusal(() => controls.stats())).toBe("DEVTOOLS_DISABLED");
    expect(refusal(() => controls.clear())).toBe("DEVTOOLS_DISABLED");
    expect(refusal(() => controls.export({ conversation: CONV }))).toBe("DEVTOOLS_DISABLED");
    expect(refusal(() => controls.tap({ conversation: CONV }))).toBe("DEVTOOLS_DISABLED");
  });

  test("bad input is VALIDATION, before the off switch is consulted", () => {
    const { controls } = createDevtools({ redact: () => false });
    expect(refusal(() => controls.settings({ keep: 7 }))).toBe("VALIDATION");
    expect(refusal(() => controls.settings({ bogus: true }))).toBe("VALIDATION");
    expect(refusal(() => controls.tap({ conversation: { instance: "atlas" } }))).toBe("VALIDATION");
  });

  test("an empty request reads; a stated field writes", () => {
    const store = new MemoryDevtoolsSettingsStore();
    const { controls } = createDevtools({ store, redact: () => false });
    expect(controls.settings()).toEqual({ enabled: false, capture: "always", keep: 5000 });
    expect(controls.settings({ keep: 1000 })).toEqual({
      enabled: false,
      capture: "always",
      keep: 1000,
    });
    expect(store.settings().keep).toBe(1000);
  });

  test("turning the tools off discards every ring and ends every tap at once", async () => {
    const devtools = createDevtools({ redact: () => false });
    devtools.controls.settings({ enabled: true });
    const tap = devtools.current();
    expect(tap).not.toBeNull();
    tap?.add(CONV, entry("a"));
    const reading = (async () => {
      const seen: TapRecord[] = [];
      for await (const r of devtools.controls.tap({ conversation: CONV })) seen.push(r);
      return seen;
    })();
    await new Promise((done) => setTimeout(done, 2));
    devtools.controls.settings({ enabled: false });
    expect(await reading).toHaveLength(1);
    expect(devtools.current()).toBeNull();
    expect(tap?.add(CONV, entry("late"))).toBeNull();
    devtools.controls.settings({ enabled: true });
    expect(devtools.controls.stats().records).toBe(0);
  });
});

describe("devtools · against the fixture backend", () => {
  test("the preference persists in this laptop's prefs", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermetic-devtools-prefs-"));
    const first = await openHermetic({ fixture: true, home });
    first.devtools.settings({ enabled: true, capture: "while_open", keep: 20000 });
    const second = await openHermetic({ fixture: true, home });
    expect(second.devtools.settings()).toEqual({ enabled: true, capture: "while_open", keep: 20000 });
    expect(second.devtools.stats().records).toBe(0);
  });

  test("off by default: a fixture turn captures nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermetic-devtools-off-"));
    const hermetic = await openHermetic({ fixture: true, home });
    await hermetic.chat.listen({ instance: "atlas", listening: true });
    for await (const _ of hermetic.chat.send({ instance: "atlas", bot: "default", message: "hi" })) {
      // drain
    }
    expect(refusal(() => hermetic.devtools.stats())).toBe("DEVTOOLS_DISABLED");
    hermetic.devtools.settings({ enabled: true });
    expect(hermetic.devtools.stats().records).toBe(0);
  });

  test("a fixture turn shows synthetic wire beneath every frame, under the canonical key", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermetic-devtools-fixture-"));
    const hermetic = await openHermetic({ fixture: true, home });
    await hermetic.chat.listen({ instance: "atlas", listening: true });
    hermetic.devtools.settings({ enabled: true });
    let frames = 0;
    for await (const _ of hermetic.chat.send({ instance: "atlas", bot: "default", message: "hi" }))
      frames += 1;
    const exported = hermetic.devtools.export({ conversation: CONV });
    const records = exported.ndjson
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TapRecord);
    const wire = records.filter((r) => r.layer === "wire");
    const framed = records.filter((r) => r.layer === "frame");
    expect(framed.length).toBe(frames);
    expect(wire.length).toBeGreaterThan(0);
    for (const r of wire) expect(r.synthetic).toBe(true);
    const wireIds = new Set(wire.map((r) => r.id));
    const parented = framed.filter((r) => r.parent !== null);
    expect(parented.length).toBe(wire.length);
    for (const r of parented) expect(wireIds.has(r.parent ?? "")).toBe(true);
    expect(hermetic.devtools.stats().conversations).toBe(1);
  });
});

describe("devtap · bounds and lifetimes", () => {
  test("a ring is bounded by bytes as well as by count, newest kept", () => {
    const tap = tapWith({ keep: 1000 });
    const big = "x".repeat(DEVTAP_RING_MAX_BYTES / 4);
    for (let i = 0; i < 6; i += 1)
      tap.add(CONV, { ...entry("tool.complete"), raw: big, payload: { i } });
    const stats = tap.stats();
    expect(stats.bytes).toBeLessThanOrEqual(DEVTAP_RING_MAX_BYTES);
    expect(stats.records).toBe(4);
    expect(stats.dropped).toBe(2);
    const huge = "y".repeat(DEVTAP_RING_MAX_BYTES + 1);
    tap.add(CONV, { ...entry("tool.complete"), raw: huge, payload: { last: true } });
    expect(tap.stats().records).toBe(1);
  });

  test("past the ring cap the least recently written unread ring goes, never a read one", async () => {
    const tap = tapWith();
    const conv = (i: number): DevtoolsConversation => ({
      instance: "atlas",
      bot: "b",
      session: `s${i}`,
    });
    tap.add(conv(0), entry("first"));
    const seen = await read(tap, conv(0), () => {
      for (let i = 1; i <= DEVTAP_MAX_RINGS + 10; i += 1) tap.add(conv(i), entry("x"));
      tap.add(conv(0), entry("still-read"));
    });
    expect(seen.map((r) => r.type)).toEqual(["first", "still-read"]);
    for (let i = 1; i <= DEVTAP_MAX_RINGS + 10; i += 1) tap.add(conv(i), entry("x"));
    const stats = tap.stats();
    expect(stats.conversations).toBeLessThanOrEqual(DEVTAP_MAX_RINGS);
    expect(stats.dropped).toBeGreaterThan(0);
  });

  test("a cleared record whose fate settles later is not delivered again", async () => {
    const tap = tapWith();
    const mark = tap.add(CONV, entry("x"));
    const seen = await read(tap, CONV, () => {
      tap.clear(CONV);
      mark?.settle({ kind: "none" });
    });
    expect(seen.map((r) => r.id)).toEqual([mark?.id ?? "missing"]);
  });

  test("a socket's pending record does not survive the tools being turned off and on", () => {
    const devtools = createDevtools({ redact: () => false });
    devtools.controls.settings({ enabled: true });
    const slot = new TapSlot(() => devtools.current(), "atlas");
    slot.conn("dial", { url: "wss://box/api/ws" });
    devtools.controls.settings({ enabled: false });
    devtools.controls.settings({ enabled: true });
    slot.bind("default", null);
    expect(devtools.controls.stats().records).toBe(0);
  });

  test("an unbound socket holds nothing under while_open with no inspector, and gives up past its cap", () => {
    const quiet = tapWith({ capture: "while_open" });
    const slot = new TapSlot(() => quiet, "atlas");
    expect(slot.conn("dial", {})).toBeNull();
    const always = tapWith();
    const roster = new TapSlot(() => always, "atlas");
    for (let i = 0; i < 64; i += 1) roster.conn("x", { i });
    expect(roster.conn("y", {})).toBeNull();
    roster.bind("default", null);
    expect(always.stats().records).toBe(0);
  });
});

describe("devtap · heartbeat", () => {
  test("a ping and its pong are both captured, named `ping`, fate none", async () => {
    const tap = tapWith();
    const slot = new TapSlot(() => tap, "atlas");
    slot.bind("default", null, "hint");
    const lines: string[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const sent: { id: number; method: string }[] = [];
    const push = (line: string): void => {
      lines.push(line);
      wake?.();
    };
    const socket: ChatSocket = {
      opened: Promise.resolve(),
      frames: (async function* () {
        for (;;) {
          const next = lines.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      })(),
      send: (data: string) => {
        const doc = JSON.parse(data) as { id: number; method: string };
        sent.push(doc);
        if (doc.method === "ping") push(JSON.stringify({ jsonrpc: "2.0", id: doc.id, result: {} }));
      },
      close: () => {
        closed = true;
        wake?.();
      },
    };
    const rpc = readRpc(socket, 1000, "atlas", { intervalMs: 5, deadlineMs: 10_000 }, slot);
    push(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "gateway.ready", payload: { heartbeat: true }, seq: 1 },
      }),
    );
    await new Promise((done) => setTimeout(done, 30));
    rpc.close();
    const records = await read(tap, CONV);
    const pings = records.filter((r) => r.type === "ping");
    expect(sent.some((d) => d.method === "ping")).toBe(true);
    expect(pings.some((r) => r.dir === "out")).toBe(true);
    expect(pings.some((r) => r.dir === "in")).toBe(true);
    for (const r of pings) expect(r.fate).toEqual({ kind: "none" });
    expect(records.some((r) => r.type === "response")).toBe(false);
  });
});

describe("devtap · frames chat.send makes itself", () => {
  test("a refused turn's error frame is captured", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermetic-devtools-refused-"));
    const hermetic = await openHermetic({ fixture: true, home });
    hermetic.devtools.settings({ enabled: true });
    const frames: string[] = [];
    // Not listened to: the guarded lookup refuses inside the stream.
    for await (const f of hermetic.chat.send({ instance: "atlas", bot: "default", message: "hi" }))
      frames.push(f.type);
    expect(frames).toEqual(["error"]);
    const records = hermetic.devtools
      .export({ conversation: CONV })
      .ndjson.trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TapRecord);
    expect(records.map((r) => [r.layer, r.type])).toEqual([["frame", "error"]]);
  });

  test("a compaction's notice and done are captured", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermetic-devtools-compact-"));
    const hermetic = await openHermetic({ fixture: true, home });
    await hermetic.chat.listen({ instance: "atlas", listening: true });
    hermetic.devtools.settings({ enabled: true });
    const frames: string[] = [];
    for await (const f of hermetic.chat.send({
      instance: "atlas",
      bot: "default",
      message: "/compact",
    }))
      frames.push(f.type);
    const types = hermetic.devtools
      .export({ conversation: CONV })
      .ndjson.trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as TapRecord).type);
    expect(frames).toEqual(["block", "done"]);
    expect(types).toEqual(["block.text", "done"]);
  });
});

describe("devtap · round two", () => {
  /** Open subscriptions on several conversations at once; returns the hang-up. */
  function reading(tap: DevTap, conversations: DevtoolsConversation[]) {
    const controller = new AbortController();
    const seen: TapRecord[] = [];
    const loops = conversations.map(async (c) => {
      for await (const r of tap.subscribe(c, controller.signal)) seen.push(r);
    });
    return {
      seen,
      stop: async () => {
        controller.abort();
        await Promise.all(loops);
      },
    };
  }
  const MIB = 1024 * 1024;
  const conv = (i: number): DevtoolsConversation => ({ instance: "atlas", bot: "b", session: `s${i}` });

  test("every ring together stays under the total budget, unread rings going first", () => {
    const tap = tapWith();
    const chunk = "x".repeat(30 * MIB);
    for (let i = 0; i < 10; i += 1) tap.add(conv(i), { ...entry("big"), raw: chunk, payload: { i } });
    const stats = tap.stats();
    expect(stats.bytes).toBeLessThanOrEqual(DEVTAP_TOTAL_MAX_BYTES);
    expect(stats.conversations).toBe(8);
    expect(stats.dropped).toBe(2);
    // The two discarded are the two written longest ago.
    expect(tap.exportRing(conv(0)).count).toBe(0);
    expect(tap.exportRing(conv(9)).count).toBe(1);
  });

  test("when every ring is read, the largest loses its oldest records instead", async () => {
    const tap = tapWith();
    const all = Array.from({ length: 9 }, (_, i) => conv(i));
    const open = reading(tap, all);
    await new Promise((done) => setTimeout(done, 2));
    const chunk = "x".repeat(15 * MIB);
    for (const c of all)
      for (let j = 0; j < 2; j += 1) tap.add(c, { ...entry("big"), raw: chunk, payload: { j } });
    const stats = tap.stats();
    expect(stats.bytes).toBeLessThanOrEqual(DEVTAP_TOTAL_MAX_BYTES);
    expect(stats.conversations).toBe(9);
    expect(stats.dropped).toBeGreaterThan(0);
    await open.stop();
  });

  test("a reply is delivered once, already settled", async () => {
    const tap = tapWith();
    const slot = new TapSlot(() => tap, "atlas");
    slot.bind("default", null, "held");
    const lines: string[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const push = (line: string): void => {
      lines.push(line);
      wake?.();
    };
    const socket: ChatSocket = {
      opened: Promise.resolve(),
      frames: (async function* () {
        for (;;) {
          const next = lines.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      })(),
      send: (data: string) => {
        const doc = JSON.parse(data) as { id: number };
        push(JSON.stringify({ jsonrpc: "2.0", id: doc.id, result: { ok: true } }));
      },
      close: () => {
        closed = true;
        wake?.();
      },
    };
    const open = reading(tap, [CONV]);
    await new Promise((done) => setTimeout(done, 2));
    const rpc = readRpc(socket, 1000, "atlas", {}, slot);
    await rpc.request("session.list", {});
    await new Promise((done) => setTimeout(done, 2));
    await open.stop();
    rpc.close();
    const replies = open.seen.filter((r) => r.type === "session.list" && r.dir === "in");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.fate).toEqual({ kind: "none" });
  });

  test("tools turned on mid-turn capture the rest of that turn's frames", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermetic-devtools-midturn-"));
    const hermetic = await openHermetic({ fixture: true, home });
    await hermetic.chat.listen({ instance: "atlas", listening: true });
    let after = 0;
    let first = true;
    for await (const _ of hermetic.chat.send({ instance: "atlas", bot: "default", message: "hi" })) {
      if (first) {
        first = false;
        hermetic.devtools.settings({ enabled: true });
        continue;
      }
      after += 1;
    }
    expect(after).toBeGreaterThan(0);
    const frames = hermetic.devtools
      .export({ conversation: CONV })
      .ndjson.trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TapRecord)
      .filter((r) => r.layer === "frame");
    expect(frames.length).toBe(after);
  });
});

describe("devtap · a rotated canonical conversation", () => {
  test("only the current canonical id folds to `session: null`", () => {
    const tap = tapWith();
    tap.canonical("atlas", "default", "s1");
    expect(tap.resolve({ ...CONV, session: "s1" })).toEqual(CONV);
    tap.canonical("atlas", "default", "s2");
    expect(tap.resolve({ ...CONV, session: "s1" })).toEqual({ ...CONV, session: "s1" });
    expect(tap.resolve({ ...CONV, session: "s2" })).toEqual(CONV);
    // Another bot's canonical is its own.
    expect(tap.resolve({ instance: "atlas", bot: "other", session: "s2" }).session).toBe("s2");
  });

  test("records already filed as canonical stay; later ones for the old id file under it", () => {
    const tap = tapWith();
    tap.canonical("atlas", "default", "s1");
    tap.add({ ...CONV, session: "s1" }, entry("before"));
    tap.canonical("atlas", "default", "s2");
    tap.add({ ...CONV, session: "s1" }, entry("after"));
    expect(tap.exportRing(CONV).count).toBe(1);
    expect(tap.exportRing({ ...CONV, session: "s1" }).count).toBe(1);
  });
});
