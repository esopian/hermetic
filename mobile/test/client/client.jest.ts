import type { ChatFrame, HermesChatClient } from "@hermetic/core/chat-client";
import { encodeMobileLink } from "@hermetic/core/shared";
import { type Alert, createHermeticClient } from "../../src/client/client.ts";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import { FleetStore, memoryFile, memoryKv } from "../../src/fleet/store.ts";
import { InboxStore } from "../../src/inbox/store.ts";
import { fakeFetch, flush, json } from "../helpers/fakes.ts";
import { approval, block, bot, delta, done, swarm } from "../helpers/fixtures.ts";

const NOW = "2026-10-13T10:00:00.000Z";
const T = { instance: "atlas", bot: "scribe", session: null };

/** An adapter whose turn says `frames`; everything else answers empty. */
function adapter(frames: ChatFrame[]): HermesChatClient & { sent: string[]; swarmed: string[] } {
  const sent: string[] = [];
  const swarmed: string[] = [];
  return {
    sent,
    swarmed,
    token: async () => "FIXTURE",
    swarm: async (box) => {
      swarmed.push(box.baseUrl);
      return swarm(box.instance, [bot()]);
    },
    sessions: async () => [],
    history: async () => [],
    conversation: async (box, b) => ({
      instance: box.instance,
      bot: b,
      root_session: "s-1",
      session: "s-1",
      kind: "canonical",
      created: false,
    }),
    send: (_box, _bot, text) => {
      sent.push(text);
      return (async function* () {
        yield* frames;
      })();
    },
    abort: async () => true,
  };
}

async function setup(frames: ChatFrame[]) {
  const read = readPairingLink(
    encodeMobileLink({
      fleet_id: "fxtr0001",
      alias: "main",
      account_id: "123456789012",
      region: "us-west-2",
      tailnet: "hermetic.ts.net",
      agents: [{ name: "atlas" }, { name: "corvid", host: "fxtr0001-corvid-2.hermetic.ts.net" }],
    }),
  );
  if (!read.ok) throw new Error("fixture link refused");
  const f = fakeFetch(() => json({}));
  const fleet = new FleetStore({
    secure: memoryKv(),
    viewCache: memoryFile(),
    fetch: f.fetch,
    now: () => NOW,
  });
  await fleet.pair(read.link);
  const inbox = new InboxStore(memoryFile(), () => NOW);
  const alerts: Alert[] = [];
  const chat = adapter(frames);
  const client = createHermeticClient({
    fleet,
    inbox,
    fetch: f.fetch,
    openSocket: () => {
      throw new Error("no socket in this test");
    },
    now: () => NOW,
    chat,
    onAlert: (a) => alerts.push(a),
  });
  return { client, chat, alerts, inbox, fleet };
}

async function settle() {
  for (let i = 0; i < 10; i++) await flush();
}

describe("createHermeticClient", () => {
  test("a turn streams into the store and its reply is filed and alerted once", async () => {
    const s = await setup([delta(1, "the answer"), done(2)]);
    expect(s.client.chat.send(T, "question")).toBe(true);
    await settle();
    expect(s.chat.sent).toEqual(["question"]);
    expect(s.client.chat.view(T).sending).toBe(false);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({
      decision: "banner",
      body: "the answer",
      data: {
        fleet_id: "fxtr0001",
        instance: "atlas",
        bot: "scribe",
        session: "s-1",
        kind: "turn.done",
      },
    });
    expect(s.inbox.getState().entries).toHaveLength(1);
  });

  test("the thread on screen is filed as read and does not alert", async () => {
    const s = await setup([delta(1, "x"), done(2)]);
    s.client.setWatched({ instance: "atlas", bot: "scribe", focused: true });
    s.client.chat.send(T, "question");
    await settle();
    expect(s.alerts).toEqual([]);
    expect(s.inbox.badgeCount()).toBe(0);
  });

  test("a request opening mid-turn is a needs-you alert with its category", async () => {
    const s = await setup([block(1, approval())]);
    s.client.setPhase("background");
    s.client.chat.send(T, "do it");
    await settle();
    expect(s.alerts[0]).toMatchObject({
      decision: "local",
      category: "hermetic.needs_action",
      body: "Approval needed: rm -rf build",
    });
  });

  test("the roster asks only listened boxes, at their link hosts", async () => {
    const s = await setup([]);
    await s.fleet.setListening("atlas", false);
    await s.client.roster.refresh();
    expect(s.chat.swarmed).toEqual(["https://fxtr0001-corvid-2.hermetic.ts.net/"]);
    expect(s.client.roster.getState().listening).toEqual(["corvid"]);
  });

  test("a conversation on an agent the fleet does not have is refused before any dial", async () => {
    const s = await setup([]);
    s.client.chat.send({ instance: "ghost", bot: "x", session: null }, "hi");
    await settle();
    expect(s.client.chat.view({ instance: "ghost", bot: "x", session: null }).turnError?.code).toBe(
      "VALIDATION",
    );
    expect(s.chat.sent).toEqual([]);
  });
});
