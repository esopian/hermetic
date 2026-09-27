/**
 * The fixture-only staging surface (§9.2).
 *
 * The headline acceptance criterion for continuous observation — "an external
 * Desktop/CLI/routine message arrives without a two-minute wait" — could not
 * be demonstrated in fixture mode at all when it shipped: the activity store that makes an
 * observation notice anything was reachable only from a hand-assembled client
 * in a unit test, and the path `openHermetic({ fixture: true })` actually built
 * passed none, so `observe` returned immediately and every arrival was
 * invisible. These tests are therefore written against the **shipped** path and
 * not against a double: every one of them opens a real fixture `Hermetic` and
 * drives it through the same surface a head does.
 *
 * They also pin the two properties that make the surface safe to ship: it does
 * not exist outside fixture mode, and what it stages is a *transcript row*
 * rather than a pretend model turn.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXTURE_CHAT_REPLY,
  FIXTURE_CONFIG,
  MemoryBackend,
  createFixtureChatActivity,
  createFixtureChatStack,
  createFixtureControls,
  createHermetic,
  openHermetic,
  seedFixtureFleet,
} from "../src/index.ts";
import { FIXTURE_LEGACY_GATEWAY } from "../src/backend/fixture/fixture-bot-mode.ts";
import { isHermeticError } from "../src/errors.ts";
import type { Hermetic } from "../src/hermetic.ts";
import type { ChatObserveEvent } from "../src/schema/index.ts";

/** A reachable fixture box with a canonical conversation and a default bot. */
const INSTANCE = "atlas";
const BOT = "default";

/**
 * Its own home per open, not the preloaded one: several of these tests open a
 * `Hermetic` and one of them writes a listen mark, and a neighbour inheriting
 * that mark would make this file order-dependent.
 */
async function fixtureHermetic(): Promise<Hermetic> {
  const home = mkdtempSync(join(tmpdir(), "hermetic-fixture-controls-"));
  const hermetic = await openHermetic({ fixture: true, home });
  await hermetic.chat.listen({ instance: INSTANCE, listening: true });
  return hermetic;
}

/** `hermetic.fixture` is nullable by design; a test that needs it says so once. */
function staging(hermetic: Hermetic) {
  const controls = hermetic.fixture;
  if (!controls) throw new Error("fixture mode built no control surface");
  return controls;
}

const tick = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * An observation, drained in the background.
 *
 * Draining rather than pulling one event at a time, because racing a timeout
 * against `iterator.next()` leaves that `next()` pending and the call after it
 * interleaves with a read nobody is waiting on. The deadlines below are
 * failure budgets, not waits: everything here is driven by a hint, so the
 * predicate is true within a microtask when the wiring works, and the two
 * seconds are only ever spent on the way to a red test.
 */
function watching(hermetic: Hermetic, session?: string) {
  const controller = new AbortController();
  const events: ChatObserveEvent[] = [];
  let failure: unknown = null;
  const drained = (async () => {
    try {
      const stream = hermetic.chat.observe(
        { instance: INSTANCE, bot: BOT, ...(session !== undefined ? { session } : {}) },
        { signal: controller.signal },
      );
      for await (const event of stream) events.push(event);
    } catch (error) {
      if (!controller.signal.aborted) failure = error;
    }
  })();
  return {
    events,
    /** Every `message` event's markdown, in the order the observation reported. */
    said(): string[] {
      return events.flatMap((e) =>
        e.type === "message"
          ? e.message.blocks.flatMap((b) => (b.kind === "text" ? [b.markdown] : []))
          : [],
      );
    },
    async until(predicate: () => boolean, budgetMs = 2_000): Promise<void> {
      const deadline = Date.now() + budgetMs;
      while (!predicate() && Date.now() < deadline) await tick(5);
      if (failure) throw failure;
      // Loudly, rather than leaving the assertion after the call to notice: a
      // waiter that gives up quietly is how a test stops biting.
      if (!predicate()) throw new Error(`observation never satisfied it within ${budgetMs}ms`);
    },
    /** Let anything already in flight land, so "nothing more arrived" means it. */
    async settle(ms = 150): Promise<void> {
      await tick(ms);
      if (failure) throw failure;
    },
    async stop(): Promise<void> {
      controller.abort();
      await drained;
    },
  };
}

const open: Hermetic[] = [];
async function opened(): Promise<Hermetic> {
  const hermetic = await fixtureHermetic();
  open.push(hermetic);
  return hermetic;
}

afterEach(async () => {
  while (open.length > 0) {
    const hermetic = open.pop();
    await hermetic?.chat.listen({ instance: INSTANCE, listening: false });
  }
});

/* ── the acceptance criterion, on the shipped path ────────────────────────── */

describe("the fixture path openHermetic builds actually observes", () => {
  test("an injected external message reaches an observer with no local send", async () => {
    const hermetic = await opened();
    const watcher = watching(hermetic);
    await watcher.until(() => watcher.events.length > 0);
    expect(watcher.events[0]?.type).toBe("snapshot");

    // Nothing on this laptop sends anything: this is Hermes Desktop, another
    // operator's CLI, or a routine at 03:00, staged.
    const staged = staging(hermetic).chat.inject({
      instance: INSTANCE,
      bot: BOT,
      markdown: "the nightly digest finished",
    });

    await watcher.until(() => watcher.said().includes("the nightly digest finished"));
    const arrived = watcher.events.filter((e) => e.type === "message");
    expect(arrived).toHaveLength(1);
    expect(arrived[0]?.type === "message" && arrived[0].message.id).toBe(staged.message.id);
    await watcher.stop();
  });

  test("it reports how many streams the arrival was announced on", async () => {
    const hermetic = await opened();
    // Nobody watching yet: the row still lands, and the count says so.
    const quiet = staging(hermetic).chat.inject({
      instance: INSTANCE,
      bot: BOT,
      markdown: "nobody is looking",
    });
    expect(quiet.watchers).toBe(0);

    const watcher = watching(hermetic);
    await watcher.until(() => watcher.events.length > 0);
    const heard = staging(hermetic).chat.inject({
      instance: INSTANCE,
      bot: BOT,
      markdown: "somebody is looking",
    });
    expect(heard.watchers).toBe(1);
    await watcher.stop();
  });

  test("a durable row replayed under its own id is reported once, not twice", async () => {
    const hermetic = await opened();
    const watcher = watching(hermetic);
    await watcher.until(() => watcher.events.length > 0);

    const first = staging(hermetic).chat.inject({
      instance: INSTANCE,
      bot: BOT,
      markdown: "restart the indexer",
      id: "durable-prompt-1",
    });
    await watcher.until(() => watcher.said().includes("restart the indexer"));
    // The same durable row arriving a second time, which is what an upstream
    // replay after a dropped stream looks like from here.
    staging(hermetic).chat.inject({
      instance: INSTANCE,
      bot: BOT,
      markdown: "restart the indexer",
      id: first.message.id,
    });
    await watcher.settle();
    expect(watcher.said().filter((text) => text === "restart the indexer")).toHaveLength(1);
    await watcher.stop();
  });

  /**
   * The conversation the portal has *used* is a different store from the canned
   * one: the Bot Mode wrapper takes ownership of a transcript the moment
   * something is sent into it, and answers `history` from its own rows. An
   * arrival has to reach that copy too, or the criterion holds only for a
   * conversation nobody has touched — which is every conversation except the
   * ones a demo is actually in.
   */
  test("an arrival reaches a conversation this portal has already sent into", async () => {
    const hermetic = await opened();
    for await (const _frame of hermetic.chat.send({
      instance: INSTANCE,
      bot: BOT,
      message: "how is the disk?",
    })) {
      // drained
    }
    const watcher = watching(hermetic);
    await watcher.until(() => watcher.events.length > 0);
    staging(hermetic).chat.inject({
      instance: INSTANCE,
      bot: BOT,
      markdown: "and the routine finished too",
    });
    await watcher.until(() => watcher.said().includes("and the routine finished too"));
    expect(watcher.said()).toContain("and the routine finished too");
    await watcher.stop();
  });

  /**
   * Every arrival reaches the watcher, and none of them reaches the inbox.
   *
   * §4.9 gives `chat.message` one source — the `chat.swarms` roster diff — and
   * an observation is not one. It reconciles mid-turn, before the turn's own
   * `done` advances the watermark, so a row raised here would be a notification
   * about a message the operator is by construction already watching arrive.
   */
  test("each arrival is observed, and none of them raises an inbox row", async () => {
    const hermetic = await opened();
    const watcher = watching(hermetic);
    await watcher.until(() => watcher.events.length > 0);
    for (const markdown of ["the first one", "the second one"]) {
      staging(hermetic).chat.inject({ instance: INSTANCE, bot: BOT, markdown });
      await watcher.until(() => watcher.said().includes(markdown));
    }
    await watcher.stop();
    expect(watcher.said()).toContain("the first one");
    expect(watcher.said()).toContain("the second one");
    const inbox = await hermetic.notifications.list({});
    const raised = inbox.notifications.filter((n) => n.kind === "chat.message" && n.agent === INSTANCE);
    expect(raised).toEqual([]);
  });

  test("an injected message is in the transcript the next read returns", async () => {
    const hermetic = await opened();
    staging(hermetic).chat.inject({
      instance: INSTANCE,
      bot: BOT,
      markdown: "the release checklist is done",
    });
    const read = await hermetic.chat.history({ instance: INSTANCE, bot: BOT });
    const said = read.messages.flatMap((m) =>
      m.blocks.flatMap((b) => (b.kind === "text" ? [b.markdown] : [])),
    );
    expect(said).toContain("the release checklist is done");
  });
});

/* ── the guard ────────────────────────────────────────────────────────────── */

describe("injection cannot be reached outside fixture mode", () => {
  test("a real-mode Hermetic has no control surface at all", () => {
    const real = createHermetic({
      backend: seedFixtureFleet(new MemoryBackend()),
      config: FIXTURE_CONFIG,
    });
    expect(real.fixture).toBeNull();
  });

  test("the stack factory builds nothing when it is not fixture mode", () => {
    expect(createFixtureChatStack(false)).toEqual({ hermes: null, controls: null });
  });

  /**
   * The second, independent guard. A control surface handed an activity store
   * but told it is not fixture mode still refuses — so "it cannot happen
   * because nobody constructs one" is not the only thing standing between a
   * real account and a staged message.
   */
  test("controls constructed with fixture false refuse every method", () => {
    const controls = createFixtureControls({
      fixture: false,
      activity: createFixtureChatActivity(),
    });
    for (const call of [
      () => controls.chat.inject({ instance: INSTANCE, bot: BOT, markdown: "no" }),
      () => controls.chat.hint({ instance: INSTANCE, bot: BOT }),
    ]) {
      try {
        call();
        throw new Error("expected a refusal");
      } catch (error) {
        expect(isHermeticError(error) && error.code).toBe("UNSUPPORTED");
      }
    }
  });

  test("it refuses before it reads the input, so a malformed call is still refused", () => {
    const controls = createFixtureControls({
      fixture: false,
      activity: createFixtureChatActivity(),
    });
    try {
      controls.chat.inject({});
      throw new Error("expected a refusal");
    } catch (error) {
      expect(isHermeticError(error) && error.code).toBe("UNSUPPORTED");
    }
  });

  test("a box that cannot be reached is refused rather than silently staged", async () => {
    const hermetic = await opened();
    try {
      // `juniper` is the fixture's stopped instance: no gateway, no transcript.
      staging(hermetic).chat.inject({ instance: "juniper", bot: BOT, markdown: "hello" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(isHermeticError(error) && error.code).toBe("CHAT_UNREACHABLE");
    }
  });
});

/* ── the local send ───────────────────────────────────────────────────────── */

describe("a locally sent turn behaves like a real one", () => {
  test("it is in the transcript, and the reply's row is the id the frames carried", async () => {
    const hermetic = await opened();
    let streamed: string | null = null;
    for await (const frame of hermetic.chat.send({
      instance: INSTANCE,
      bot: BOT,
      message: "what is wrong with granite?",
    })) {
      if (frame.type === "done") streamed = frame.message;
    }
    expect(streamed).not.toBeNull();

    const read = await hermetic.chat.history({ instance: INSTANCE, bot: BOT });
    const mine = read.messages.find((m) => m.id === streamed);
    expect(mine?.role).toBe("bot");
    // The canned reply, folded out of the same frames the caller was handed.
    expect(mine?.blocks.some((b) => b.kind === "text" && b.markdown === FIXTURE_CHAT_REPLY)).toBe(true);
    const said = read.messages.flatMap((m) =>
      m.blocks.flatMap((b) => (b.kind === "text" ? [b.markdown] : [])),
    );
    expect(said).toContain("what is wrong with granite?");
  });

  /**
   * The whole point of the row carrying the streamed message id: a head that
   * has already drawn the turn from the stream recognises the observed copy as
   * the same message and draws it once. A row under a fresh id would be a
   * second bubble for a turn the operator watched arrive.
   */
  test("an observation reports the sent turn once, under the id the stream used", async () => {
    const hermetic = await opened();
    const watcher = watching(hermetic);
    await watcher.until(() => watcher.events.length > 0);

    let streamed: string | null = null;
    for await (const frame of hermetic.chat.send({
      instance: INSTANCE,
      bot: BOT,
      message: "check the disk",
    })) {
      if (frame.type === "done") streamed = frame.message;
    }
    // A send raises no hint of its own — a real gateway's does, a fixture's is
    // staged — so this is what makes the reconcile happen now rather than at
    // the poll floor.
    staging(hermetic).chat.hint({ instance: INSTANCE, bot: BOT });
    await watcher.until(() => watcher.said().includes(FIXTURE_CHAT_REPLY));

    const reported = watcher.events.filter((e) => e.type === "message" && e.message.id === streamed);
    expect(reported).toHaveLength(1);

    // And nothing re-announces it: a second reconcile over the same transcript
    // is a set difference against a window that already holds both rows.
    staging(hermetic).chat.hint({ instance: INSTANCE, bot: BOT });
    await watcher.settle();
    expect(
      watcher.events.filter((e) => e.type === "message" && e.message.id === streamed),
    ).toHaveLength(1);
    expect(watcher.said().filter((text) => text === "check the disk")).toHaveLength(1);
    await watcher.stop();
  });
});

/* ── nothing the fixture already did stopped working ──────────────────────── */

describe("the fixture the wiring changed still has everything it had", () => {
  test("both seeded fleets are still there", async () => {
    const hermetic = await opened();
    const fleets = await hermetic.fleets.list();
    const ids = fleets.fleets.map((f) => f.fleet_id).sort();
    expect(ids).toEqual(["fxtr0001", "sg7k2m4p"]);
  });

  test("the deliberately old gateway still reports an old gateway", async () => {
    // Named rather than read off the constant: a test that addresses whichever
    // box the constant points at cannot notice the constant moving.
    expect(FIXTURE_LEGACY_GATEWAY).toBe("kestrel");
    const hermetic = await opened();
    await hermetic.chat.listen({ instance: "kestrel", listening: true });
    const legacy = await hermetic.bots.capabilities({ instance: "kestrel" });
    const current = await hermetic.bots.capabilities({ instance: INSTANCE });
    expect(legacy.hosted_rooms).toBe(false);
    expect(current.hosted_rooms).toBe(true);
    await hermetic.chat.listen({ instance: "kestrel", listening: false });
  });

  test("the canned turn still streams the canned reply", async () => {
    const hermetic = await opened();
    let text = "";
    for await (const frame of hermetic.chat.send({
      instance: INSTANCE,
      bot: BOT,
      message: "hi",
    })) {
      if (frame.type === "delta") text += frame.text;
    }
    expect(text).toBe(FIXTURE_CHAT_REPLY);
  });

  test("an unreachable box is still unreachable, and says why", async () => {
    const hermetic = await opened();
    await hermetic.chat.listen({ instance: "juniper", listening: true });
    const swarms = await hermetic.chat.swarms({ instances: ["juniper"] });
    const stopped = swarms.swarms.find((s) => s.instance === "juniper");
    expect(stopped?.reachable).toBe(false);
    expect(stopped?.unreachable_reason).toBe("the instance is stopped");
    await hermetic.chat.listen({ instance: "juniper", listening: false });
  });
});
