/**
 * `core/src/backend/fixture-chat.ts`: the canned swarm, and
 * the one thing a fixture has to be able to prove about itself.
 *
 * Almost every assertion here is about **coverage**, which is an unusual thing
 * for a test file to be about and is the whole reason this one exists. The
 * renderer is developed and tested against this data, so a block kind, a
 * `render` hint, a `ToolStatus` or a `HermeticCard` with no fixture behind it is
 * not a gap in the fixture — it is a renderer nobody has ever looked at, and the
 * symptom shows up as a blank card in front of an operator rather than as a red
 * test.
 *
 * The expected sets are therefore **derived from the schema's own exported
 * option lists** — `CHAT_BLOCK_KINDS`, `ToolRender.options`, `ToolStatus.options`,
 * `HermeticCard.options`, `SESSION_ORIGINS` — and never hand-listed. A
 * hand-listed set is a copy, and a copy of an enum goes one entry stale the day
 * somebody adds a hint: the fixture would not cover it, this file would not
 * notice, and the renderer for it would ship unseen. That failure mode is the
 * thing being defended against, so the derivation is the assertion.
 *
 * Nothing here touches a network, and one test below says so in the only way a
 * test can: the client is built and every method driven without a `fetch`, a
 * `WebSocket` or a hostname existing anywhere in the module's imports.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CHAT_FAILURES,
  FIXTURE_CHAT_INSTANCES,
  FIXTURE_CHAT_REPLY,
  FIXTURE_CHAT_SESSIONS,
  FIXTURE_CHAT_TRANSCRIPTS,
  fixtureChatClient,
} from "../src/backend/fixture/fixture-chat.ts";
import { FIXTURE_WARM_SLOTS } from "../src/backend/fixture/fixture-chat.ts";
import type { BoxAddress } from "../src/chat/hermes/hermes-chat.ts";
import {
  CHAT_BLOCK_KINDS,
  ChatFrame,
  ChatMessage,
  HermeticCard,
  SESSION_ORIGINS,
  Session,
  Swarm,
  ToolRender,
  ToolStatus,
} from "../src/schema/index.ts";
import type { ChatBlock, ChatFrame as Frame } from "../src/schema/index.ts";

/** The `main` fixture fleet, which is the fleet `avatar_seed` has to carry. */
const FLEET = "fxtr0001";

const box = (instance: string): BoxAddress => ({
  instance,
  // A URL nothing will ever open. It is here because `BoxAddress` requires one,
  // and the point of the module under test is that it is never dialled.
  baseUrl: `https://${FLEET}-${instance}.fixture.ts.net/`,
  fleet_id: FLEET,
});

const client = fixtureChatClient({ delayMs: 0 });

/** Every block in every canned transcript, flat — the set coverage is measured over. */
const ALL_BLOCKS: ChatBlock[] = Object.values(FIXTURE_CHAT_TRANSCRIPTS).flatMap((messages) =>
  messages.flatMap((message) => [...message.blocks]),
);

const ALL_MESSAGES = Object.values(FIXTURE_CHAT_TRANSCRIPTS).flat();

/** Every swarm the table can produce, addressed to `main`. */
const ALL_SWARMS: Swarm[] = await Promise.all(FIXTURE_CHAT_INSTANCES.map((i) => client.swarm(box(i))));

describe("the catalogue is covered", () => {
  /**
   * Derived, not transcribed. If `schema/chat.ts` grows another block kind this
   * test fails until the fixture carries one, which is the only mechanism that
   * makes "the renderer's tests are driven from the fixture" a true statement
   * rather than an intention.
   */
  test("every block kind appears", () => {
    const seen = new Set(ALL_BLOCKS.map((b) => b.kind));
    expect([...seen].sort()).toEqual([...CHAT_BLOCK_KINDS].sort());
  });

  test("every tool render hint appears, including the null one", () => {
    const tools = ALL_BLOCKS.filter((b) => b.kind === "tool");
    const seen = new Set(tools.map((t) => t.render ?? null));
    for (const hint of ToolRender.options) expect(seen).toContain(hint);
    // The fallback path. A tool with no hint renders as name / arguments /
    // result / verdict, and it is the path every tool upstream adds next lands
    // on first — so it is not an edge case, it is the default.
    expect(seen).toContain(null);
  });

  test("every tool status appears", () => {
    const seen = new Set(ALL_BLOCKS.filter((b) => b.kind === "tool").map((t) => t.status));
    expect([...seen].sort()).toEqual([...ToolStatus.options].sort());
  });

  test("every hermetic card appears", () => {
    const seen = new Set(ALL_BLOCKS.filter((b) => b.kind === "hermetic").map((h) => h.card));
    expect([...seen].sort()).toEqual([...HermeticCard.options].sort());
  });

  /**
   * A `running` tool and the block that completes it arrive separately and
   * there is no frame type that *updates* one, so a head has to recognise the
   * second as the first one finishing — and the only key that works is
   * `tool_id`, because two parallel calls to the same tool share a name.
   * Without a pair in the fixture, a head keyed on the name passes everything.
   */
  test("a running tool and its completion share a tool_id", () => {
    const tools = ALL_BLOCKS.filter((b) => b.kind === "tool");
    const running = tools.filter((t) => t.status === "running");
    expect(running.length).toBeGreaterThan(0);
    for (const start of running) {
      expect(start.tool_id).toBeTruthy();
      const finished = tools.filter((t) => t.tool_id === start.tool_id && t.status !== "running");
      expect(finished.length).toBeGreaterThan(0);
    }
  });

  /**
   * The three things a `text` block can be: plain prose, fenced code, and
   * cited text with a matching sources card.
   */
  test("a text block carries fenced code, and another carries citations with a matching sources card", () => {
    const texts = ALL_BLOCKS.filter((b) => b.kind === "text");
    expect(texts.some((t) => t.markdown.includes("```"))).toBe(true);

    const cited = texts.filter((t) => /\[\d+]/.test(t.markdown));
    expect(cited.length).toBeGreaterThan(0);
    // The pairing, not just the presence: a sources card whose numbering does
    // not reach the markers above it renders fine and means nothing.
    const withSources = Object.values(FIXTURE_CHAT_TRANSCRIPTS).some((messages) =>
      messages.some((message) => {
        const markers = message.blocks
          .filter((b) => b.kind === "text")
          .flatMap((b) => [...b.markdown.matchAll(/\[(\d+)]/g)].map((m) => Number(m[1])));
        const sources = message.blocks.find((b) => b.kind === "sources");
        if (markers.length === 0 || sources === undefined) return false;
        return markers.every((n) => n >= 1 && n <= sources.items.length);
      }),
    );
    expect(withSources).toBe(true);
  });

  /** An attachment is an image or it is a file, and the two draw differently. */
  test("attachments cover both an image and a plain file", () => {
    const mimes = ALL_BLOCKS.filter((b) => b.kind === "attachment").map((a) => a.mime);
    expect(mimes.some((m) => m.startsWith("image/"))).toBe(true);
    expect(mimes.some((m) => !m.startsWith("image/"))).toBe(true);
  });
});

describe("the message-level failures", () => {
  const failed = ALL_MESSAGES.filter((m) => m.error != null);

  test("each is a message with an error and incomplete set, not a block kind", () => {
    // Six failures, six shapes. They are *cross-cutting* — one renderer keyed
    // off the code — which is why they are not in `CHAT_BLOCK_KINDS`.
    expect(Object.keys(FIXTURE_CHAT_FAILURES)).toHaveLength(6);
    for (const message of failed) expect(message.incomplete).toBe(true);
  });

  test("every declared failure string is actually reachable in a transcript", () => {
    const seen = new Set(failed.map((m) => m.error));
    for (const value of Object.values(FIXTURE_CHAT_FAILURES)) expect(seen).toContain(value);
  });

  test("the code leads, so a head can branch without reading English", () => {
    for (const value of Object.values(FIXTURE_CHAT_FAILURES)) {
      expect(value).toMatch(/^[A-Z][A-Z_]+ · /);
    }
  });

  /**
   * A box that goes away mid-turn keeps what had streamed. An operator who
   * watched half a sentence arrive and then saw the box die must still see
   * the half sentence: Hermes wrote its own transcript on the box, and the
   * portal throwing away its copy would be the portal being the only thing
   * that lost it.
   */
  test("the box that went away kept the half-sentence it was streaming", () => {
    const messages = FIXTURE_CHAT_TRANSCRIPTS["sx-ember-portal"] ?? [];
    const last = messages.at(-1);
    expect(last?.error).toBe(FIXTURE_CHAT_FAILURES.box_went_away);
    expect(last?.blocks.some((b) => b.kind === "text")).toBe(true);
  });
});

describe("the rail has something to group", () => {
  test("at least one instance runs more than one bot", () => {
    expect(ALL_SWARMS.some((s) => s.bots.length > 1)).toBe(true);
  });

  test("bots carry operator sections, and the swarm lists them in rail order", () => {
    const sectioned = ALL_SWARMS.filter((s) => s.sections.length > 0);
    expect(sectioned.length).toBeGreaterThan(0);
    for (const swarm of sectioned) {
      for (const bot of swarm.bots) {
        if (bot.section == null) continue;
        expect(swarm.sections).toContain(bot.section);
      }
    }
  });

  test("at least one instance is unreachable, and it says why", () => {
    const offline = ALL_SWARMS.filter((s) => !s.reachable);
    expect(offline.length).toBeGreaterThan(0);
    for (const swarm of offline) {
      expect(swarm.unreachable_reason).toBeTruthy();
      expect(swarm.bots).toEqual([]);
      // `0/3`, never `0/0`: the box has its three slots whether or not this
      // laptop can reach it, and a readout that changes shape with reachability
      // makes the rail's numbers mean two different things.
      expect(swarm.warm_slots).toEqual({ used: 0, total: FIXTURE_WARM_SLOTS });
    }
  });

  test("at least one room exists, and its members are all on its own instance", () => {
    const rooms = ALL_SWARMS.flatMap((s) => s.rooms);
    expect(rooms.length).toBeGreaterThan(0);
    // §9.2: a room is within one instance and cannot span boxes, because
    // hermetic has no Desktop to courier between gateways.
    for (const room of rooms) {
      for (const member of room.members) expect(member.instance).toBe(room.instance);
    }
  });

  /**
   * Three readouts, not three fields: empty, partly warm, and full with a bot
   * still wanting one. The last is the only way the rail can draw a *queued*
   * slot, and it is seeded as four warm bots against three slots rather than as
   * a field, because upstream has no such field — it just makes the fourth open
   * wait thirty seconds and then fail.
   */
  test("warm slots appear empty, partly used and full-with-a-queue", () => {
    const reachable = ALL_SWARMS.filter((s) => s.reachable);
    const used = reachable.map((s) => s.warm_slots.used);
    expect(used).toContain(0);
    expect(used.some((u) => u > 0 && u < FIXTURE_WARM_SLOTS)).toBe(true);
    expect(used).toContain(FIXTURE_WARM_SLOTS);

    const queued = reachable.some(
      (s) =>
        s.bots.filter((b) => b.warm).length > s.warm_slots.used &&
        s.warm_slots.used === FIXTURE_WARM_SLOTS,
    );
    expect(queued).toBe(true);
  });

  test("a bot flagged warm never exceeds the slots on a box that is not full", () => {
    for (const swarm of ALL_SWARMS.filter(
      (s) => s.reachable && s.warm_slots.used < FIXTURE_WARM_SLOTS,
    )) {
      expect(swarm.bots.filter((b) => b.warm).length).toBe(swarm.warm_slots.used);
    }
  });

  test("every box has exactly one default bot, or none at all", () => {
    for (const swarm of ALL_SWARMS) {
      const defaults = swarm.bots.filter((b) => b.is_default).length;
      expect(defaults).toBe(swarm.reachable ? 1 : 0);
    }
  });

  /** §9.2: `fleet_id/instance/bot`, and never the display title. */
  test("avatar seeds are the identity key and not the title", () => {
    for (const swarm of ALL_SWARMS) {
      for (const bot of swarm.bots) {
        expect(bot.avatar_seed).toBe(`${FLEET}/${swarm.instance}/${bot.name}`);
      }
    }
  });

  test("a box the table has never heard of still answers with a default bot", async () => {
    // `agent create` works in fixture mode, so an operator can be looking at an
    // agent that did not exist when the table was written. A real one has the
    // default profile on it and nothing else, which is what it gets.
    expect(FIXTURE_CHAT_INSTANCES).not.toContain("newcomer");
    const swarm = await client.swarm(box("newcomer"));
    expect(swarm.reachable).toBe(true);
    expect(swarm.bots.map((b) => b.name)).toEqual(["default"]);
    expect(swarm.bots[0]?.avatar_seed).toBe(`${FLEET}/newcomer/default`);
    expect(await client.sessions(box("newcomer"), "default")).toEqual([]);
  });
});

describe("sessions carry where they came from", () => {
  test("every origin is seeded, so the destination banner has something to fire on", () => {
    const seen = new Set(FIXTURE_CHAT_SESSIONS.map((s) => s.origin));
    expect([...seen].sort()).toEqual([...SESSION_ORIGINS].sort());
  });

  test("a foreign origin says concretely what it was", () => {
    for (const session of FIXTURE_CHAT_SESSIONS.filter((s) => s.origin !== "portal")) {
      expect(session.origin_detail).toBeTruthy();
    }
  });

  test("every session belongs to a bot its own instance actually runs", () => {
    for (const session of FIXTURE_CHAT_SESSIONS) {
      const swarm = ALL_SWARMS.find((s) => s.instance === session.instance);
      expect(swarm?.bots.map((b) => b.name)).toContain(session.bot);
    }
  });

  test("every transcript belongs to a session, and every session id is unique", () => {
    const ids = FIXTURE_CHAT_SESSIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of Object.keys(FIXTURE_CHAT_TRANSCRIPTS)) expect(ids).toContain(id);
    for (const [id, messages] of Object.entries(FIXTURE_CHAT_TRANSCRIPTS)) {
      for (const message of messages) expect(message.session).toBe(id);
    }
  });
});

describe("everything validates against the schema it claims to be", () => {
  test("swarms, sessions and messages all parse", () => {
    for (const swarm of ALL_SWARMS) expect(() => Swarm.parse(swarm)).not.toThrow();
    for (const session of FIXTURE_CHAT_SESSIONS) expect(() => Session.parse(session)).not.toThrow();
    for (const message of ALL_MESSAGES) expect(() => ChatMessage.parse(message)).not.toThrow();
  });
});

describe("the five methods", () => {
  test("sessions are scoped to the instance and the bot that asked", async () => {
    const found = await client.sessions(box("atlas"), "default");
    expect(found.length).toBeGreaterThan(1);
    for (const session of found) {
      expect(session.instance).toBe("atlas");
      expect(session.bot).toBe("default");
    }
  });

  test("history without a session reads the bot's canonical one", async () => {
    const messages = await client.history(box("atlas"), "default");
    expect(messages[0]?.session).toBe("sx-atlas-portal");
  });

  test("history with a limit returns the tail, because a transcript is read from the bottom", async () => {
    const whole = await client.history(box("atlas"), "default", { session: "sx-atlas-portal" });
    const tail = await client.history(box("atlas"), "default", {
      session: "sx-atlas-portal",
      limit: 2,
    });
    expect(tail).toHaveLength(2);
    expect(tail.map((m) => m.id)).toEqual(whole.slice(-2).map((m) => m.id));
  });

  test("an unreachable box answers empty everywhere rather than throwing", async () => {
    const swarm = await client.swarm(box("heron"));
    expect(swarm.reachable).toBe(false);
    expect(await client.sessions(box("heron"), "default")).toEqual([]);
    expect(await client.history(box("heron"), "default")).toEqual([]);
    await expect(client.abort(box("heron"), "default")).resolves.toBeUndefined();
  });

  test("a turn against an unreachable box is one error frame, not a hang", async () => {
    const frames = await collect(client.send(box("juniper"), "default", "hello"));
    expect(frames.map((f) => f.type)).toEqual(["error"]);
    const first = frames[0];
    expect(first?.type === "error" && first.code).toBe("CHAT_UNREACHABLE");
  });

  test("the tables are handed out by value, so a caller cannot edit the fixture", async () => {
    const once = await client.history(box("atlas"), "default", { session: "sx-atlas-portal" });
    const first = once[0];
    if (first) first.id = "mutated";
    const twice = await client.history(box("atlas"), "default", { session: "sx-atlas-portal" });
    expect(twice[0]?.id).not.toBe("mutated");
  });
});

describe("send streams like a real turn", () => {
  test("it opens a text block, streams deltas, runs a tool and finishes with usage", async () => {
    const frames = await collect(client.send(box("atlas"), "default", "what is wrong with granite?"));
    for (const frame of frames) expect(() => ChatFrame.parse(frame)).not.toThrow();

    const types = frames.map((f) => f.type);
    expect(types[0]).toBe("block");
    expect(types.at(-1)).toBe("done");
    // Not one lump: the delta gate in `chat.ts` and the streaming UI both need a
    // sentence arriving in pieces before either can be said to have been tried.
    expect(types.filter((t) => t === "delta").length).toBeGreaterThan(20);

    const done = frames.at(-1);
    expect(done?.type === "done" && done.usage?.model).toBe("claude-sonnet-5");
    expect(done?.type === "done" && done.incomplete).toBeNull();
  });

  test("the deltas reassemble into the canned reply", async () => {
    const frames = await collect(client.send(box("atlas"), "default", "hi"));
    const text = frames.filter((f) => f.type === "delta").reduce((acc, f) => acc + f.text, "");
    expect(text).toBe(FIXTURE_CHAT_REPLY);
  });

  /**
   * The property the whole streaming seam exists for. Upstream splits on tokens,
   * so a sentence — and a key — arrives cut mid-word, and every frame is clean on
   * its own while the browser that concatenates them has the whole thing. A
   * fixture that only ever split on spaces would let a broken gate pass.
   */
  test("at least one delta boundary falls inside a word", async () => {
    const frames = await collect(client.send(box("atlas"), "default", "hi"));
    const deltas = frames.filter((f) => f.type === "delta").map((f) => f.text);
    const midWord = deltas.some((text, i) => {
      const next = deltas[i + 1];
      if (next === undefined || text === "" || next === "") return false;
      return /\w$/.test(text) && /^\w/.test(next);
    });
    expect(midWord).toBe(true);
  });

  test("every delta rides on the same message id, so nothing opens a second bubble", async () => {
    const frames = await collect(client.send(box("atlas"), "default", "hi"));
    const ids = new Set(frames.filter((f) => f.type !== "error").map((f) => f.message));
    expect(ids.size).toBe(1);
  });

  test("seq numbers only ever go up, which is what a reconnecting client keys off", async () => {
    const frames = await collect(client.send(box("atlas"), "default", "hi"));
    const seqs = frames.filter((f) => f.type !== "error").map((f) => f.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("an aborted turn stops where it is and keeps what it said", async () => {
    const controller = new AbortController();
    const frames: Frame[] = [];
    for await (const frame of client.send(box("atlas"), "default", "hi", {
      signal: controller.signal,
    })) {
      frames.push(frame);
      if (frames.length === 6) controller.abort();
    }
    expect(frames).toHaveLength(6);
    expect(frames.at(-1)?.type).not.toBe("done");
  });

  /**
   * Two *fixtures*, not two turns against one: the property is that the frames
   * do not depend on the machine, and a fresh client is what a second developer
   * — or the next `bun run dev:fixture` — actually has.
   *
   * A turn's message id counts turns within a client, because that id is what
   * the transcript row is keyed on and an observation's cursor drops a second
   * row reusing an id it has already seen. A counter is still not a clock: the
   * same sequence of calls produces the same ids anywhere.
   */
  test("two fixtures produce identical frames, because a fixture does not depend on the machine", async () => {
    const once = await collect(fixtureChatClient({ delayMs: 0 }).send(box("atlas"), "default", "hi"));
    const twice = await collect(fixtureChatClient({ delayMs: 0 }).send(box("atlas"), "default", "hi"));
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  /**
   * A real box records a turn: the prompt and the reply are rows in its durable
   * transcript the moment they exist. A fixture that streamed a reply and then
   * answered `history` as though nothing had happened left one whole path
   * undemonstrable — a locally sent message reconciled by an observation is
   * supposed to be recognised as the one already on screen, and a transcript
   * that never gains it cannot show that working or broken.
   */
  test("a turn this client was sent is in the transcript it answers with", async () => {
    const fresh = fixtureChatClient({ delayMs: 0 });
    const before = await fresh.history(box("atlas"), "default");
    const frames = await collect(fresh.send(box("atlas"), "default", "what is wrong with granite?"));
    const done = frames.at(-1);
    const after = await fresh.history(box("atlas"), "default");

    expect(after.length).toBe(before.length + 2);
    const prompt = after.at(-2);
    expect(prompt?.role).toBe("user");
    expect(prompt?.blocks).toEqual([{ kind: "text", markdown: "what is wrong with granite?" }]);

    // The reply, folded out of the same frames the caller was handed: two text
    // blocks with the deltas in them, and the tool between them recorded once,
    // completed rather than still running.
    const reply = after.at(-1);
    expect(reply?.role).toBe("bot");
    // Under the id the frames carried, so a head that has already drawn the
    // turn from the stream recognises the durable copy as the same message.
    expect(reply?.id).toBe(done?.type === "done" ? done.message : "");
    const text = (reply?.blocks ?? []).flatMap((b) => (b.kind === "text" ? [b.markdown] : [])).join("");
    expect(text).toBe(FIXTURE_CHAT_REPLY);
    const tools = (reply?.blocks ?? []).filter((b) => b.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.kind === "tool" && tools[0].status).toBe("ok");
  });

  test("a second turn is a second row, not a second copy of the first one's id", async () => {
    const fresh = fixtureChatClient({ delayMs: 0 });
    const first = await collect(fresh.send(box("atlas"), "default", "hi"));
    const second = await collect(fresh.send(box("atlas"), "default", "again"));
    expect(first.at(-1)?.message).not.toBe(second.at(-1)?.message);
  });
});

/**
 * §9.2: a reconnecting client continues the turn from its cursor, and re-reading
 * is the fallback rather than the rule. The fixture cannot reach that by
 * describing a box — it is not a state a box is in, it is a socket dying
 * mid-turn — so the knob below is the only way the portal and the CLI can show
 * the reconnect UX without a real gateway being killed at the right moment.
 *
 * What is being asserted is deliberately narrow: the *frames*. Nothing in the
 * fixture fakes an RPC, so the replay logic itself is proved against the fake
 * sockets in `hermes-chat.test.ts`; what belongs here is that a cut turn and an
 * uncut one deliver the same turn.
 */
describe("a cut socket continues the turn from its cursor", () => {
  const cut = (n: number) =>
    fixtureChatClient({
      delayMs: 0,
      cutAfter: n,
      sleep: () => Promise.resolve(),
    });

  test("it shows the reconnect card, then delivers the rest of the turn exactly once", async () => {
    const frames = await collect(cut(3).send(box("atlas"), "default", "hi"));
    for (const frame of frames) expect(() => ChatFrame.parse(frame)).not.toThrow();

    const cards = frames.flatMap((f) =>
      f.type === "block" && f.block.kind === "activity" && f.block.key === "connection:reconnect"
        ? [f.block]
        : [],
    );
    expect(cards.map((b) => b.state)).toEqual(["running", "done"]);
    expect(cards.map((b) => b.title)).toEqual(["Reconnecting…", "Reconnected"]);
    expect(cards[0]?.detail).toBe("attempt 1 of 5");
    // One key, because a head replaces a status block by key: the running card
    // has to become the done one rather than leaving two behind.
    expect(cards.every((b) => b.role === "status" && b.category === "connection")).toBe(true);
    // Third frame onward, which is where the socket was said to have died.
    expect(frames.findIndex((f) => f.type === "block" && f.block.kind === "activity")).toBe(3);

    // The turn itself: every frame the uncut turn produced, once, in order, and
    // a `done` that does not claim the turn was cut short.
    const whole = await collect(cut(0).send(box("atlas"), "default", "hi"));
    const content = frames.filter(
      (f) =>
        !(f.type === "block" && f.block.kind === "activity" && f.block.key === "connection:reconnect"),
    );
    expect(content).toEqual(whole);
    const done = content.at(-1);
    expect(done?.type === "done" && done.incomplete).toBeNull();
  });

  test("the transcript row the box keeps is the same row either way", async () => {
    const withCut = fixtureChatClient({
      delayMs: 0,
      cutAfter: 3,
      sleep: () => Promise.resolve(),
    });
    const without = fixtureChatClient({ delayMs: 0 });
    await collect(withCut.send(box("atlas"), "default", "hi"));
    await collect(without.send(box("atlas"), "default", "hi"));

    const cutRow = (await withCut.history(box("atlas"), "default")).at(-1);
    const plainRow = (await without.history(box("atlas"), "default")).at(-1);
    expect(cutRow?.role).toBe("bot");
    // Blocks and id both: the reconnect cards are the client narrating itself,
    // and a durable row that gained one would make what the box wrote down
    // depend on whether the socket happened to survive.
    expect(cutRow?.blocks).toEqual(plainRow?.blocks ?? []);
    expect(cutRow?.id).toBe(plainRow?.id ?? "");
  });

  test("no cut by default, so the suite and an ordinary fixture never see one", async () => {
    const frames = await collect(client.send(box("atlas"), "default", "hi"));
    expect(frames.some((f) => f.type === "block" && f.block.kind === "activity")).toBe(false);
  });
});

describe("pacing", () => {
  /**
   * The precedent is `HERMETIC_FIXTURE_SLOW_STACK_MS`, and so is the default:
   * instant. A fixture that is slow by default is a suite that is slow by
   * default, and the env var exists so `bun run dev:fixture` can be the one
   * place that opts into watching it arrive.
   */
  test("the default never sleeps", async () => {
    let slept = 0;
    const instant = fixtureChatClient({
      delayMs: 0,
      sleep: (ms) => {
        slept += ms;
        return Promise.resolve();
      },
    });
    await collect(instant.send(box("atlas"), "default", "hi"));
    expect(slept).toBe(0);
  });

  test("a delay paces every frame through the injected sleep", async () => {
    const waits: number[] = [];
    const paced = fixtureChatClient({
      delayMs: 25,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const frames = await collect(paced.send(box("atlas"), "default", "hi"));
    expect(waits).toHaveLength(frames.length);
    expect(new Set(waits)).toEqual(new Set([25]));
  });
});

async function collect(stream: AsyncIterable<Frame>): Promise<Frame[]> {
  const out: Frame[] = [];
  for await (const frame of stream) out.push(frame);
  return out;
}
