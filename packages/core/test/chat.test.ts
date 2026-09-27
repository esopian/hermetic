/**
 * `core/src/chat.ts` (§9.2): the five methods, and the three things
 * they are responsible for that nothing below them is.
 *
 * The adapter is a hand-written double here — the real one is covered by
 * `hermes-chat.test.ts` against recorded fixtures — because what this file is
 * about is not what Hermes says. It is:
 *
 * - **where the box is**, which is the rule `probe.ts` already had and which a
 *   second implementation would eventually get wrong (the `corvid` case below
 *   is the whole reason the rule exists);
 * - **what leaves this module**, which is the redaction door (§9.2): a session
 *   title is the first thing said in the session, so it is a place a key
 *   arrives, and the roster's labels are not exempt from that;
 * - **what a failure looks like**, which differs by method on purpose — a
 *   fleet-wide roster read reports one box's silence as that box's silence, and
 *   a turn that has started reports its failure inside the stream rather than
 *   as a throw nobody can see.
 *
 * No network, ever: the double is the only thing on the other side, and the
 * fixture client (`fixtureHermesChat`) is asserted to be the same.
 */
import { describe, expect, test } from "bun:test";
import { MemoryInstanceListeningStore } from "../src/chat/instance-listening.ts";
import { MemoryLocalChatSessions, createChat, fixtureHermesChat } from "../src/chat/chat.ts";
import type { ChatDeps } from "../src/chat/chat.ts";
import { mapHistory, WARM_SLOTS_PER_GATEWAY } from "../src/chat/hermes/hermes-chat.ts";
import type { BoxAddress, HermesChatClient } from "../src/chat/hermes/hermes-chat.ts";
import { redactText } from "../src/chat/chat-redact.ts";
import { HermeticError } from "../src/errors.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import type { StackInfo } from "../src/backend/types.ts";
import type { Agent, ChatFrame, ChatMessage, Session, Swarm } from "../src/schema/index.ts";

/** An Anthropic-shaped key built only from the `FIXTURE` sentinel (§8.3). */
const KEY = "sk-ant-FIXTUREFIXTUREFIXTURE";
const AT = "2026-09-17T09:00:00.000Z";

const backend = seedFixtureFleet(new MemoryBackend());
const agents = await backend.store.agents.scan();
const seeded = await backend.store.fleet.get();
if (seeded === null) throw new Error("the fixture seed writes a fleet item");
/** Narrowed once, because `ChatDeps.guardFleet` promises a fleet and not a maybe. */
const fleetItem = seeded;

function agentNamed(name: string): Agent {
  const found = agents.find((a) => a.name === name);
  if (found === undefined) throw new Error(`the fixture has no agent ${name}`);
  return found;
}

/** Where the double was asked to go, in the order it was asked. */
interface Visit {
  method: string;
  baseUrl: string;
  instance: string;
  bot?: string;
}

function harness(
  client: Partial<HermesChatClient> = {},
  deps: Partial<ChatDeps> = {},
): { chat: ReturnType<typeof createChat>; visits: Visit[] } {
  const visits: Visit[] = [];
  const note =
    (method: string) =>
    (box: BoxAddress, bot?: string): void => {
      visits.push({ method, baseUrl: box.baseUrl, instance: box.instance, ...(bot ? { bot } : {}) });
    };
  const instanceListening = new MemoryInstanceListeningStore();
  for (const agent of agents) instanceListening.set(fleetItem.fleet_id, agent.name, true);
  const hermes: HermesChatClient = {
    // Never reached by the chat surface — `agents.desktop` is the only caller —
    // but the interface has it, so a double that omits it would not compile.
    token: (box) => Promise.resolve(`token-${box.instance}`),
    swarm: (box) => {
      note("swarm")(box);
      return Promise.resolve(swarm(box.instance));
    },
    sessions: (box, bot) => {
      note("sessions")(box, bot);
      return Promise.resolve([]);
    },
    history: (box, bot) => {
      note("history")(box, bot);
      return Promise.resolve([]);
    },
    send: (box, bot) => {
      note("send")(box, bot);
      return (async function* () {})();
    },
    abort: (box, bot) => {
      note("abort")(box, bot);
      return Promise.resolve();
    },
    ...client,
  };
  const chat = createChat({
    // Chat never reads the config or the stack; the guard is in the deps to
    // prove it ran, which is what §4.2 is for.
    guardFleet: () =>
      Promise.resolve({ config: FIXTURE_CONFIG, fleet: fleetItem, stack: {} as StackInfo }),
    getAgent: (name: string) => Promise.resolve(agentNamed(name)),
    listAgents: () => Promise.resolve(agents),
    instanceListening,
    hermes,
    ...deps,
  });
  return { chat, visits };
}

function swarm(instance: string, over: Partial<Swarm> = {}): Swarm {
  return {
    instance,
    reachable: true,
    unreachable_reason: null,
    bots: [
      {
        instance,
        name: "default",
        title: "Bot Chat",
        description: null,
        is_default: true,
        model: "claude-sonnet-4-6",
        section: null,
        avatar_seed: `fxtr0001/${instance}/default`,
        last_message_at: AT,
        unread: 0,
        needs_action: false,
        muted: false,
        warm: true,
      },
    ],
    rooms: [],
    warm_slots: { used: 1, total: 3 },
    sections: [],
    ...over,
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: "ses-1",
    instance: "atlas",
    bot: "default",
    kind: "canonical",
    origin: "portal",
    origin_detail: null,
    title: "Bot Chat",
    last_message_at: AT,
    unread: 0,
    turn_count: 3,
    ...over,
  };
}

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    session: "ses-1",
    role: "user",
    author: null,
    at: AT,
    blocks: [{ kind: "text", markdown: "hello" }],
    usage: null,
    error: null,
    incomplete: null,
    ...over,
  };
}

async function collect(frames: AsyncIterable<ChatFrame>): Promise<ChatFrame[]> {
  const out: ChatFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

describe("where the box is", () => {
  test("the row's own tailnet name wins over the canonical one", async () => {
    const { chat, visits } = harness();
    await chat.swarms({ instance: "corvid" });
    /**
     * `corvid` is the fixture's recreated agent: it answers on
     * `fxtr0001-corvid-2`, because the device cleanup for its predecessor did
     * not run and MagicDNS still points `fxtr0001-corvid` at the dead node. A
     * chat sent to the corpse is not a failed send — it is a send that looks
     * like it worked and reaches a box nobody is watching.
     */
    expect(visits[0]?.baseUrl).toBe("https://fxtr0001-corvid-2.hermetic.ts.net/");
  });

  test("a row that has never reported falls back to the canonical cloud name", async () => {
    const { chat, visits } = harness();
    await chat.sessions({ instance: "juniper", bot: "default" });
    // `juniper` is stopped and has no `tailscale_dns_name`; `<fleet id>-<agent>`
    // is what the node is called when it comes back.
    expect(visits[0]?.baseUrl).toBe("https://fxtr0001-juniper.hermetic.ts.net/");
  });

  test("the bot travels with the box on every per-bot read", async () => {
    const { chat, visits } = harness();
    await chat.sessions({ instance: "atlas", bot: "researcher" });
    await chat.history({ instance: "atlas", bot: "researcher" });
    expect(visits.map((v) => [v.method, v.bot])).toEqual([
      ["sessions", "researcher"],
      ["history", "researcher"],
    ]);
  });
  test("a turn with no inbox spends nothing on the watermark read", async () => {
    /**
     * The turn's watermark is the *box's* coordinate, read back from the box
     * once the turn has ended (`chat-fence.ts`, and `boxCoordinate` in
     * `chat.ts`). That read exists to feed the inbox, so a `Hermetic` built
     * without one must not pay for it — two extra round trips per turn, on
     * every head that never raises a row.
     */
    const { chat, visits } = harness();
    for await (const _frame of chat.send({ instance: "atlas", bot: "default", message: "hi" })) {
      // The double says nothing; the turn is over as soon as it starts.
    }
    expect(visits.map((v) => v.method)).toEqual(["send"]);
  });
});

describe("the roster read", () => {
  test("no instance asks every box in the fleet, and skips the destroyed one", async () => {
    const { chat, visits } = harness();
    const result = await chat.swarms({});
    const asked = visits.map((v) => v.instance);
    expect(asked).toContain("atlas");
    // A destroyed agent is not a box that is down, it is a box that is gone:
    // listing it would put a permanent dead bucket in the rail.
    expect(asked).not.toContain("oriole");
    expect(result.swarms).toHaveLength(asked.length);
  });

  test("one box's silence is that box's, and the rest still answer", async () => {
    const { chat } = harness({
      swarm: (box) =>
        box.instance === "ember"
          ? Promise.reject(new HermeticError("NOT_FOUND", `no gateway on ${box.instance}`))
          : Promise.resolve(swarm(box.instance)),
    });
    const result = await chat.swarms({});
    const ember = result.swarms.find((s) => s.instance === "ember");
    expect(ember?.reachable).toBe(false);
    expect(ember?.unreachable_reason).toBe("NOT_FOUND: no gateway on ember");
    // The eleven that answered are still there. A read that threw on the first
    // failure would report a fleet smaller than it is.
    expect(result.swarms.filter((s) => s.reachable).length).toBeGreaterThan(5);
  });

  test("a named instance that has no row is an error, not an unreachable box", async () => {
    const { chat } = harness(
      {},
      { getAgent: () => Promise.reject(new HermeticError("NOT_FOUND", "no such agent")) },
    );
    await expect(chat.swarms({ instance: "atlas" })).rejects.toThrow("no such agent");
  });
});

describe("the redaction door", () => {
  test("a key in a bot's label does not leave this module", async () => {
    const { chat } = harness({
      swarm: (box) =>
        Promise.resolve(
          swarm(box.instance, {
            bots: [{ ...swarm(box.instance).bots[0]!, title: `key ${KEY}`, description: KEY }],
          }),
        ),
    });
    const result = await chat.swarms({ instance: "atlas" });
    const bot = result.swarms[0]?.bots[0];
    expect(bot?.title).not.toContain("sk-ant-");
    expect(bot?.description).not.toContain("sk-ant-");
  });

  test("a key in a session title does not leave this module", async () => {
    // Hermes titles a session from the first thing said in it, so a key pasted
    // into a composer is a session title before it is anything else.
    const { chat } = harness({ sessions: () => Promise.resolve([session({ title: KEY })]) });
    const result = await chat.sessions({ instance: "atlas", bot: "default" });
    expect(result.sessions[0]?.title).not.toContain("sk-ant-");
  });

  test("a key in a transcript does not leave this module", async () => {
    const { chat } = harness({
      history: () =>
        Promise.resolve([message({ blocks: [{ kind: "text", markdown: `export KEY=${KEY}` }] })]),
    });
    const result = await chat.history({ instance: "atlas", bot: "default" });
    expect(JSON.stringify(result.messages)).not.toContain("sk-ant-");
  });

  test("durable tool arguments and results pass through the same redaction door", async () => {
    const { chat } = harness({
      history: (box) =>
        Promise.resolve(
          mapHistory(box, "s1", [
            {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_FIXTURE",
                  function: {
                    name: "terminal",
                    arguments: JSON.stringify({ command: `printf ${KEY}` }),
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "call_FIXTURE",
              tool_name: "terminal",
              content: JSON.stringify({ output: KEY, exit_code: 0, error: null }),
            },
          ]),
        ),
    });
    const result = await chat.history({ instance: "atlas", bot: "default", session: "s1" });
    const block = result.messages[1]?.blocks[0];
    expect(block).toMatchObject({
      kind: "tool",
      name: "terminal",
      tool_id: "call_FIXTURE",
      status: "ok",
    });
    expect(JSON.stringify(block)).not.toContain(KEY);
    expect(JSON.stringify(block)).not.toContain("sk-ant-");
    expect(block?.kind === "tool" ? block.args : null).not.toEqual({ command: `printf ${KEY}` });
    expect(block?.kind === "tool" ? block.result : null).not.toEqual({
      output: KEY,
      exit_code: 0,
      error: null,
    });
  });

  test("a key in a live frame does not leave this module", async () => {
    const { chat } = harness({
      send: () =>
        (async function* () {
          yield { type: "delta", seq: 1, message: "m1", text: `the key is ${KEY}` } as const;
        })(),
    });
    const frames = await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    expect(JSON.stringify(frames)).not.toContain("sk-ant-");
  });
});

describe("a turn", () => {
  test("a bad request throws before the stream opens", () => {
    const { chat } = harness();
    // Eagerly, so the CLI can exit 2 and the server can refuse before it has
    // committed to a 200 and an SSE body.
    expect(() => chat.send({ instance: "atlas", bot: "default", message: "" })).toThrow(
      "chat input does not validate",
    );
  });

  test("a failure after it opens is an error frame, not a throw", async () => {
    const { chat } = harness({
      send: () =>
        (async function* (): AsyncIterable<ChatFrame> {
          yield { type: "delta", seq: 1, message: "m1", text: "thinking" };
          throw new HermeticError("CONFLICT", "no warm slot");
        })(),
    });
    const frames = await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    expect(frames.map((f) => f.type)).toEqual(["delta", "error"]);
    expect(frames[1]).toMatchObject({ code: "CONFLICT", message: "no warm slot" });
  });

  test("a guard refusal reaches the caller as a frame it can branch on", async () => {
    const { chat } = harness(
      {},
      { guardFleet: () => Promise.reject(new HermeticError("ACCOUNT_MISMATCH", "wrong account")) },
    );
    const frames = await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    expect(frames).toEqual([{ type: "error", code: "ACCOUNT_MISMATCH", message: "wrong account" }]);
  });

  test("an aborted caller stops reading, whatever the adapter is still doing", async () => {
    const controller = new AbortController();
    const { chat } = harness({
      send: () =>
        (async function* (): AsyncIterable<ChatFrame> {
          yield { type: "delta", seq: 1, message: "m1", text: "one" };
          controller.abort();
          yield { type: "delta", seq: 2, message: "m1", text: "two" };
        })(),
    });
    const frames = await collect(
      chat.send({ instance: "atlas", bot: "default", message: "hi" }, { signal: controller.signal }),
    );
    expect(frames).toHaveLength(1);
  });

  test("an adapter's idle abort remains false at the public surface", async () => {
    const { chat } = harness({ abort: () => Promise.resolve(false) });
    expect(await chat.abort({ instance: "atlas", bot: "default" })).toEqual({
      instance: "atlas",
      bot: "default",
      aborted: false,
    });
  });

  test("abort names the bot and says the stop was delivered", async () => {
    const { chat, visits } = harness();
    const result = await chat.abort({ instance: "atlas", bot: "default" });
    expect(result).toEqual({ instance: "atlas", bot: "default", aborted: true });
    expect(visits[0]?.method).toBe("abort");
  });
});

describe("the name rule", () => {
  test("an instance that is not a legal agent name never reaches the box", async () => {
    const { chat, visits } = harness();
    await expect(chat.history({ instance: "ATLAS", bot: "default" })).rejects.toThrow(
      "chat log input does not validate",
    );
    expect(visits).toEqual([]);
  });

  test("a bot name that could address something else is refused", async () => {
    const { chat, visits } = harness();
    // A bot name is spliced into a URL path. `../..` is not a bot.
    await expect(chat.sessions({ instance: "atlas", bot: "../../etc" })).rejects.toThrow(
      "chat ls input does not validate",
    );
    expect(visits).toEqual([]);
  });
});

/**
 * `backend/fixture-chat.ts`'s canned swarm replaced an earlier stopgap that
 * answered "no box behind any of these". `fixture-chat.test.ts` is where
 * the coverage of that data is asserted; what matters *here* is the property the
 * stopgap existed for and which the replacement had to keep: fixture mode
 * constructs no live client, so nothing below opens a socket or resolves a name.
 */
describe("the fixture client", () => {
  const fixtureChat = () => {
    const instanceListening = new MemoryInstanceListeningStore();
    for (const agent of agents) instanceListening.set(fleetItem.fleet_id, agent.name, true);
    return createChat({
      instanceListening,
      guardFleet: () =>
        Promise.resolve({ config: FIXTURE_CONFIG, fleet: fleetItem, stack: {} as StackInfo }),
      getAgent: (name: string) => Promise.resolve(agentNamed(name)),
      listAgents: () => Promise.resolve(agents),
      hermes: fixtureHermesChat({ delayMs: 0 }),
    });
  };

  test("a seeded box answers with a roster and a transcript, and nothing opens a socket", async () => {
    const chat = fixtureChat();
    const roster = await chat.swarms({ instance: "atlas" });
    expect(roster.swarms[0]?.reachable).toBe(true);
    expect(roster.swarms[0]?.bots.length).toBeGreaterThan(1);
    const listed = await chat.sessions({ instance: "atlas", bot: "default" });
    expect(listed.sessions.length).toBeGreaterThan(0);
    const frames = await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    expect(frames.at(-1)?.type).toBe("done");
  });

  test("a box the fixture marks unreachable is one error frame, not a hang", async () => {
    const chat = fixtureChat();
    // `heron`'s bootstrap stopped on a failed stage, so no gateway ever started.
    const roster = await chat.swarms({ instance: "heron" });
    expect(roster.swarms[0]?.reachable).toBe(false);
    expect(await chat.sessions({ instance: "heron", bot: "default" })).toMatchObject({
      sessions: [],
    });
    const frames = await collect(chat.send({ instance: "heron", bot: "default", message: "hi" }));
    // One frame, and it says why — not a hang, and not a stack trace in the UI.
    expect(frames.map((f) => f.type)).toEqual(["error"]);
  });
});

/**
 * The hole an adversarial review found, and the two properties the fix must not
 * break while closing it.
 *
 * Upstream streams a reply token by token, so a key the model echoes is split
 * across frames — and every one of those frames is clean on its own. Redaction
 * per frame therefore masks nothing, while the browser that concatenates them
 * has the key whole and `~/.hermetic/portal.log` has it too.
 */
describe("a secret split across frames", () => {
  const SPLIT = ["the key is sk-ant-", "api03-FIXTURE", "FIXTUREFIXTURE, and that is all of it"];

  function streaming(texts: readonly string[]): Partial<HermesChatClient> {
    return {
      send: () =>
        (async function* (): AsyncIterable<ChatFrame> {
          let seq = 0;
          for (const text of texts) {
            seq += 1;
            yield { type: "delta", seq, message: "m1", text };
          }
          yield { type: "done", seq: seq + 1, message: "m1", usage: null, incomplete: null };
        })(),
    };
  }

  function emitted(frames: readonly ChatFrame[]): string {
    return frames.map((f) => (f.type === "delta" ? f.text : "")).join("");
  }

  test("no single frame matches a pattern, which is why per-frame redaction cannot work", () => {
    // Not a property of the fix — a statement of the bug. Each of these is
    // returned unchanged by the redactor, and together they are a key.
    for (const piece of SPLIT) expect(redactText(piece)).toBe(piece);
    expect(redactText(SPLIT.join(""))).not.toContain("sk-ant-api03");
  });

  test("the key does not survive in what leaves this module", async () => {
    const { chat } = harness(streaming(SPLIT));
    const frames = await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    expect(emitted(frames)).not.toContain("sk-ant-api03");
    expect(JSON.stringify(frames)).not.toContain("sk-ant-api03");
  });

  test("text is emitted once, in order, and nothing is lost", async () => {
    // Long enough that the gate releases text mid-turn rather than only at the
    // end: a client that had to wait for `done` to see the first word would be
    // a worse chat than the one this replaced.
    const prose = Array.from({ length: 40 }, (_, i) => `word${i} `);
    const { chat } = harness(streaming(prose));
    const frames = await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    expect(emitted(frames)).toBe(prose.join(""));
    expect(frames.filter((f) => f.type === "delta").length).toBeGreaterThan(1);
  });

  test("an aborted turn keeps the words it had already said", async () => {
    const controller = new AbortController();
    const { chat } = harness({
      send: () =>
        (async function* (): AsyncIterable<ChatFrame> {
          yield { type: "delta", seq: 1, message: "m1", text: "half a sentence" };
          controller.abort();
          yield { type: "delta", seq: 2, message: "m1", text: " and the rest" };
        })(),
    });
    const frames = await collect(
      chat.send({ instance: "atlas", bot: "default", message: "hi" }, { signal: controller.signal }),
    );
    expect(emitted(frames)).toBe("half a sentence");
  });

  test("a turn that fails mid-sentence flushes before it reports the failure", async () => {
    const { chat } = harness({
      send: () =>
        (async function* (): AsyncIterable<ChatFrame> {
          yield { type: "delta", seq: 1, message: "m1", text: "half a sentence" };
          throw new HermeticError("CHAT_TURN_FAILED", "the socket closed");
        })(),
    });
    const frames = await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    expect(emitted(frames)).toBe("half a sentence");
    expect(frames.at(-1)).toMatchObject({ type: "error", code: "CHAT_TURN_FAILED" });
  });

  test("a block frame never overtakes the sentence it interrupted", async () => {
    const { chat } = harness({
      send: () =>
        (async function* (): AsyncIterable<ChatFrame> {
          yield { type: "delta", seq: 1, message: "m1", text: "before" };
          yield {
            type: "block",
            seq: 2,
            message: "m1",
            block: { kind: "text", markdown: "a block" },
          };
          yield { type: "delta", seq: 3, message: "m1", text: "after" };
        })(),
    });
    const frames = await collect(chat.send({ instance: "atlas", bot: "default", message: "hi" }));
    expect(frames.map((f) => f.type)).toEqual(["delta", "block", "delta"]);
  });
});

/**
 * A thrown error leaves this module as surely as a message does: the server
 * writes `HermeticError.message` to `portal.log` and returns it in the JSON
 * error body, and the CLI prints it.
 */
describe("a failure on the way out", () => {
  const thrower = (): Promise<never> =>
    Promise.reject(
      new HermeticError("CHAT_NO_TOKEN", `GET https://atlas/?token=${KEY} said 401`, {
        url: `https://atlas/?token=${KEY}`,
      }),
    );

  test("sessions, history and abort all mask the message they throw", async () => {
    const { chat } = harness({ sessions: thrower, history: thrower, abort: thrower });
    for (const call of [
      () => chat.sessions({ instance: "atlas", bot: "default" }),
      () => chat.history({ instance: "atlas", bot: "default" }),
      () => chat.abort({ instance: "atlas", bot: "default" }),
    ]) {
      const error = await call().then(
        () => null,
        (e: unknown) => e as HermeticError,
      );
      expect(error?.code).toBe("CHAT_NO_TOKEN");
      expect(error?.message).not.toContain("sk-ant-");
      // `details` is walked structurally, for the reason `args` and `result`
      // are: nothing models what a caller put in there.
      expect(JSON.stringify(error?.details)).not.toContain("sk-ant-");
    }
  });

  test("the stack is masked too, because its first line is the message", async () => {
    const { chat } = harness({ sessions: thrower });
    const error = await chat.sessions({ instance: "atlas", bot: "default" }).then(
      () => null,
      (e: unknown) => e as HermeticError,
    );
    expect(error?.stack ?? "").not.toContain("sk-ant-");
  });

  test("a guard refusal is masked on the roster read as well", async () => {
    const { chat } = harness(
      {},
      {
        guardFleet: () =>
          Promise.reject(new HermeticError("ACCOUNT_MISMATCH", `profile key ${KEY} is stale`)),
      },
    );
    const error = await chat.swarms({}).then(
      () => null,
      (e: unknown) => e as HermeticError,
    );
    expect(error?.message).not.toContain("sk-ant-");
  });
});

describe("an unreachable box", () => {
  test("still has the three warm slots the box has, whoever reports it", async () => {
    // Otherwise the rail reads "0/0" for a silent box and "0/3" for a busy one,
    // and the difference is which layer produced the row rather than anything
    // about the box.
    const { chat } = harness({ swarm: () => Promise.reject(new Error("no answer")) });
    const result = await chat.swarms({ instance: "atlas" });
    expect(result.swarms[0]?.warm_slots).toEqual({ used: 0, total: WARM_SLOTS_PER_GATEWAY });
  });
});

/**
 * Which conversations *this laptop* started (§9.2).
 *
 * The adapter maps upstream's `source` onto `SessionOrigin` and deliberately
 * maps **nothing** onto `portal`: the box cannot tell a session hermetic opened
 * over `/api/ws` from one its own TUI opened, and `portal` is the one value that
 * silences the composer's destination warning. That default is correct and it
 * stays. The cost, without this, is that the warning fires on every thread —
 * including the one the operator opened thirty seconds ago from this portal —
 * and a warning that always fires is a warning nobody reads.
 *
 * So the laptop keeps its own record. Every test below is about the direction of
 * the override: `portal` is only ever *granted*, only ever on this laptop's own
 * evidence, and absence always means foreign.
 */
describe("a session this laptop started", () => {
  const CHANNEL = session({ id: "ses-chan", origin: "channel", origin_detail: "#acme-support" });
  const TUI = session({ id: "ses-tui", origin: "cli", origin_detail: null });

  function withRecord(store = new MemoryLocalChatSessions()) {
    const { chat } = harness(
      {
        sessions: () => Promise.resolve([CHANNEL, TUI]),
        send: () =>
          (async function* () {
            yield { type: "done", seq: 0, message: "m1" } as ChatFrame;
          })(),
      },
      { localSessions: store },
    );
    return { chat, store };
  }

  test("a session nobody here opened keeps whatever the box said", async () => {
    const { chat } = withRecord();
    const result = await chat.sessions({ instance: "atlas", bot: "default" });
    expect(result.sessions.map((s) => s.origin)).toEqual(["channel", "cli"]);
  });

  test("a turn this laptop sent makes that one session portal, and only that one", async () => {
    const { chat } = withRecord();
    await collect(
      chat.send({ instance: "atlas", bot: "default", message: "hello", session: "ses-tui" }),
    );
    const result = await chat.sessions({ instance: "atlas", bot: "default" });
    expect(Object.fromEntries(result.sessions.map((s) => [s.id, s.origin]))).toEqual({
      "ses-chan": "channel",
      "ses-tui": "portal",
    });
  });

  test("claiming a session clears the detail the box hung on it", async () => {
    // `origin_detail` is "#acme-support" — the Slack channel a reply would land
    // in. A session this portal owns has no such destination, and leaving the
    // old one would have the banner name a room it is no longer sending to.
    const { chat } = withRecord();
    await collect(chat.send({ instance: "atlas", bot: "default", message: "hi", session: "ses-chan" }));
    const result = await chat.sessions({ instance: "atlas", bot: "default" });
    const claimed = result.sessions.find((s) => s.id === "ses-chan");
    expect(claimed?.origin).toBe("portal");
    expect(claimed?.origin_detail).toBeNull();
  });

  test("a turn that failed records nothing", async () => {
    // Nothing reached the box, so this portal has not joined that conversation.
    // The warning has to keep firing until it actually has.
    const store = new MemoryLocalChatSessions();
    const { chat } = harness(
      {
        sessions: () => Promise.resolve([TUI]),
        send: () =>
          (async function* () {
            yield { type: "error", code: "CHAT_UNREACHABLE", message: "no route" } as ChatFrame;
          })(),
      },
      { localSessions: store },
    );
    await collect(
      chat.send({ instance: "atlas", bot: "default", message: "hello", session: "ses-tui" }),
    );
    const result = await chat.sessions({ instance: "atlas", bot: "default" });
    expect(result.sessions[0]?.origin).toBe("cli");
  });

  test("a turn that named no session records nothing", async () => {
    // The box picks or creates one and nothing in the frames carries back which,
    // so the thread stays foreign until the next turn addresses it by id. One
    // extra warning, which is the direction this whole mechanism errs in.
    const { chat } = withRecord();
    await collect(chat.send({ instance: "atlas", bot: "default", message: "hello" }));
    const result = await chat.sessions({ instance: "atlas", bot: "default" });
    expect(result.sessions.map((s) => s.origin)).toEqual(["channel", "cli"]);
  });

  test("another laptop watching the same fleet still sees it as foreign", async () => {
    /**
     * Not a limitation — the design. The colleague's reply really is going into
     * a conversation they did not open, and they are owed the warning for it.
     * This is the same reasoning that keeps the inbox local, and it is why the
     * table must never move to DynamoDB.
     */
    const mine = new MemoryLocalChatSessions();
    const { chat } = withRecord(mine);
    await collect(
      chat.send({ instance: "atlas", bot: "default", message: "hello", session: "ses-tui" }),
    );

    const theirs = new MemoryLocalChatSessions();
    const { chat: other } = withRecord(theirs);
    const result = await other.sessions({ instance: "atlas", bot: "default" });
    expect(result.sessions.map((s) => s.origin)).toEqual(["channel", "cli"]);
  });

  test("a chat surface with no local record at all reads every session as foreign", async () => {
    // A `Hermetic` built without a local database, a wiped `hermetic.db`, a
    // first run. Every one of those must produce the warning.
    const { chat } = harness({ sessions: () => Promise.resolve([CHANNEL, TUI]) });
    const result = await chat.sessions({ instance: "atlas", bot: "default" });
    expect(result.sessions.map((s) => s.origin)).toEqual(["channel", "cli"]);
  });
});

describe("instance listening", () => {
  test("a new store contacts no boxes and refuses every direct chat operation", async () => {
    const { chat, visits } = harness({}, { instanceListening: new MemoryInstanceListeningStore() });
    expect(await chat.listening()).toEqual({ instances: [] });
    expect(await chat.swarms({})).toEqual({ swarms: [] });
    const target = { instance: "atlas", bot: "default" };
    await expect(chat.swarms({ instance: "atlas" })).rejects.toThrow("listen to this instance");
    await expect(chat.sessions(target)).rejects.toThrow("listen to this instance");
    await expect(chat.history(target)).rejects.toThrow("listen to this instance");
    await expect(chat.abort(target)).rejects.toThrow("listen to this instance");
    expect(await collect(chat.send({ ...target, message: "hello" }))).toMatchObject([
      { type: "error", code: "VALIDATION" },
    ]);
    expect(visits).toEqual([]);
  });

  test("only selected instances are contacted, and unlistening closes access again", async () => {
    const { chat, visits } = harness({}, { instanceListening: new MemoryInstanceListeningStore() });
    expect(await chat.listen({ instance: "atlas", listening: true })).toEqual({ instances: ["atlas"] });
    expect((await chat.swarms({})).swarms.map((swarm) => swarm.instance)).toEqual(["atlas"]);
    expect(visits.map((visit) => visit.instance)).toEqual(["atlas"]);
    await chat.listen({ instance: "atlas", listening: false });
    expect(await chat.swarms({})).toEqual({ swarms: [] });
    expect(visits).toHaveLength(1);
  });

  test("unlistening disconnects an active turn without accepting later frames", async () => {
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { chat } = harness({
      send: (_box, _bot, _message, opts) =>
        (async function* (): AsyncIterable<ChatFrame> {
          signal = opts?.signal;
          started();
          yield {
            type: "block",
            seq: 0,
            message: "m1",
            block: { kind: "reasoning", text: "", duration_ms: null },
          };
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "delta", seq: 1, message: "m1", text: "should never arrive" };
        })(),
    });
    const frames = collect(chat.send({ instance: "atlas", bot: "default", message: "hello" }));
    await ready;
    await chat.listen({ instance: "atlas", listening: false });
    expect(signal?.aborted).toBe(true);
    expect((await frames).some((frame) => frame.type === "delta")).toBe(false);
  });

  test("unlistening aborts an in-flight read and discards a late roster", async () => {
    let historySignal: AbortSignal | undefined;
    let releaseHistory!: () => void;
    let releaseRoster!: () => void;
    let startedHistory!: () => void;
    let startedRoster!: () => void;
    const historyStarted = new Promise<void>((resolve) => {
      startedHistory = resolve;
    });
    const rosterStarted = new Promise<void>((resolve) => {
      startedRoster = resolve;
    });
    const { chat } = harness({
      history: async (_box, _bot, opts) => {
        historySignal = opts?.signal;
        startedHistory();
        await new Promise<void>((resolve) => {
          releaseHistory = resolve;
        });
        return [];
      },
      swarm: async (box) => {
        startedRoster();
        await new Promise<void>((resolve) => {
          releaseRoster = resolve;
        });
        return swarm(box.instance);
      },
    });
    const history = chat.history({ instance: "atlas", bot: "default" });
    const roster = chat.swarms({ instance: "atlas" });
    await Promise.all([historyStarted, rosterStarted]);
    await chat.listen({ instance: "atlas", listening: false });
    expect(historySignal?.aborted).toBe(true);
    const outcome = history.then(
      () => "resolved",
      () => "rejected",
    );
    releaseHistory();
    releaseRoster();
    expect(await outcome).toBe("rejected");
    expect(await roster).toEqual({ swarms: [] });
  });
});
