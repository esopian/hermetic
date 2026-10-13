import type { ChatFrame, HermesChatClient } from "@hermetic/core/chat-client";
import type { MobileFleetView } from "@hermetic/core/schema";
import { encodeMobileLink } from "@hermetic/core/shared";
import { type Alert, createHermeticClient } from "../../src/client/client.ts";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import { FleetStore, memoryFile, memoryKv } from "../../src/fleet/store.ts";
import { InboxStore } from "../../src/inbox/store.ts";
import { fakeFetch, flush, json } from "../helpers/fakes.ts";
import { approval, block, bot, delta, done, fleetView, swarm } from "../helpers/fixtures.ts";

const NOW = "2026-10-13T10:00:00.000Z";
const T = { instance: "atlas", bot: "scribe", session: null };

interface Watch {
  instance: string;
  bot: string;
  signal: AbortSignal | undefined;
}

/**
 * An adapter whose turn says `frames` (and, with `hold`, then stays open until
 * its signal aborts); `observe` holds each hint stream open until its signal
 * aborts. Everything else answers empty.
 */
function adapter(
  frames: ChatFrame[],
  opts: { hold?: boolean } = {},
): HermesChatClient & {
  sent: string[];
  swarmed: string[];
  aborts: string[];
  turnSignals: (AbortSignal | undefined)[];
  watches: Watch[];
  histories: string[];
} {
  const sent: string[] = [];
  const swarmed: string[] = [];
  const aborts: string[] = [];
  const turnSignals: (AbortSignal | undefined)[] = [];
  const watches: Watch[] = [];
  const histories: string[] = [];
  const untilAborted = (signal: AbortSignal | undefined) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      signal?.addEventListener("abort", () => resolve());
    });
  return {
    sent,
    swarmed,
    aborts,
    turnSignals,
    watches,
    histories,
    token: async () => "FIXTURE",
    swarm: async (box) => {
      swarmed.push(box.baseUrl);
      return swarm(box.instance, [bot()]);
    },
    sessions: async () => [],
    history: async (box) => {
      histories.push(box.instance);
      return [];
    },
    conversation: async (box, b) => ({
      instance: box.instance,
      bot: b,
      root_session: "s-1",
      session: "s-1",
      kind: "canonical",
      created: false,
    }),
    send: (_box, _bot, text, o) => {
      sent.push(text);
      turnSignals.push(o?.signal);
      return (async function* () {
        yield* frames;
        if (opts.hold) await untilAborted(o?.signal);
      })();
    },
    abort: async (box) => {
      aborts.push(box.instance);
      return true;
    },
    observe: (box, b, o) => {
      const watch = { instance: box.instance, bot: b, signal: o?.signal };
      watches.push(watch);
      return (async function* () {
        await untilAborted(o?.signal);
        // A hint stream that ends without a hint once its watch is closed.
        yield* [];
      })();
    },
  };
}

const live = (watches: Watch[]) => watches.filter((w) => w.signal?.aborted === false);

/** The fixture fleet's view: atlas ready, corvid in error. */
const VIEW2: MobileFleetView = fleetView({
  agents: [
    {
      name: "atlas",
      status: "error",
      tailscale_dns_name: "fxtr0001-atlas.hermetic.ts.net",
      tailscale_ip: "100.64.0.1",
      version: "0.21.1",
    },
    {
      name: "corvid",
      status: "ready",
      tailscale_dns_name: "fxtr0001-corvid-2.hermetic.ts.net",
      tailscale_ip: "100.64.0.2",
      version: "0.21.1",
    },
  ],
});

async function setup(frames: ChatFrame[], opts: { hold?: boolean; view?: MobileFleetView } = {}) {
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
  const f = fakeFetch((url) => (url.endsWith("/fleet") && opts.view ? json(opts.view) : json({})));
  const fleet = new FleetStore({
    secure: memoryKv(),
    viewCache: memoryFile(),
    fetch: f.fetch,
    now: () => NOW,
  });
  await fleet.pair(read.link);
  const inbox = new InboxStore(memoryFile(), () => NOW);
  const alerts: Alert[] = [];
  const chat = adapter(frames, opts);
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
  return { client, chat, alerts, inbox, fleet, fetched: f.calls };
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

  test("the background detaches running turns and closes observations; nothing is interrupted", async () => {
    const s = await setup([delta(1, "working")], { hold: true });
    s.client.chat.open(T);
    expect(s.client.chat.send(T, "long job")).toBe(true);
    await settle();
    expect(live(s.chat.watches)).toHaveLength(1);
    s.client.setPhase("background");
    await settle();
    expect(s.chat.turnSignals[0]?.aborted).toBe(false);
    expect(s.chat.aborts).toEqual([]);
    expect(live(s.chat.watches)).toHaveLength(0);
    expect(s.client.chat.view(T).observe).toBe("off");
    // Back: the turn is reported gone (the transcript is re-read) and the watch re-opens.
    const reads = s.chat.histories.length;
    s.client.setPhase("active");
    await settle();
    expect(s.client.chat.view(T).sending).toBe(false);
    expect(s.chat.histories.length).toBeGreaterThan(reads);
    expect(live(s.chat.watches)).toHaveLength(1);
    expect(s.client.chat.view(T).observe).toBe("live");
    expect(s.chat.aborts).toEqual([]);
    s.client.dispose();
  });

  test("an unlistened agent is refused, and its open observation ends without failing", async () => {
    const s = await setup([]);
    s.client.chat.open(T);
    await settle();
    expect(live(s.chat.watches)).toHaveLength(1);
    await s.fleet.setListening("atlas", false);
    await settle();
    expect(live(s.chat.watches)).toHaveLength(0);
    expect(s.client.chat.view(T)).toMatchObject({
      observe: "off",
      observeError: { code: "UNLISTENED" },
    });
    s.client.chat.send(T, "hi");
    await settle();
    expect(s.client.chat.view(T).turnError?.code).toBe("VALIDATION");
    expect(s.chat.sent).toEqual([]);
    // Listened again: the conversation still on screen is watched again.
    await s.fleet.setListening("atlas", true);
    await settle();
    expect(live(s.chat.watches)).toHaveLength(1);
    expect(s.client.chat.view(T).observe).toBe("live");
    s.client.dispose();
  });

  test("once a fleet view exists it wins over the link: an agent gone from it is refused", async () => {
    const s = await setup([], { view: fleetView() });
    expect(await s.fleet.refresh()).toBe(true);
    await s.fleet.setListeningAll();
    const gone = { instance: "corvid", bot: "x", session: null };
    s.client.chat.send(gone, "hi");
    await settle();
    expect(s.client.chat.view(gone).turnError?.code).toBe("VALIDATION");
    expect(s.chat.sent).toEqual([]);
    s.client.dispose();
  });

  test("the Tailscale probe asks ready boxes first", async () => {
    const s = await setup([], { view: VIEW2 });
    expect(await s.fleet.refresh()).toBe(true);
    await s.fleet.setListeningAll();
    s.fetched.length = 0;
    await s.client.tailscale.probe();
    expect(s.fetched.map((c) => c.url)).toEqual([
      "https://fxtr0001-corvid-2.hermetic.ts.net/api/health",
      "https://fxtr0001-atlas.hermetic.ts.net/api/health",
    ]);
    s.client.dispose();
  });
});
