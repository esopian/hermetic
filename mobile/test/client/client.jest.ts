import type { ChatFrame, HermesChatClient } from "@hermetic/core/chat-client";
import type { MobileFleetView } from "@hermetic/core/schema";
import { encodeMobileLink } from "@hermetic/core/shared";
import {
  type Alert,
  createHermeticClient,
  REMOTE_FAILURES,
  REMOTE_POLL_MS,
} from "../../src/client/client.ts";
import type { Timers } from "../../src/client/timers.ts";
import { noteTunnel, resetTunnelChecks, tunnelVerified } from "../../src/gateway/hermeticd.ts";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import { FleetStore, memoryFile, memoryKv } from "../../src/fleet/store.ts";
import { InboxStore } from "../../src/inbox/store.ts";
import { FakeTimers, fakeFetch, flush, json } from "../helpers/fakes.ts";
import {
  approval,
  block,
  bot,
  delta,
  done,
  errorFrame,
  fleetView,
  swarm,
} from "../helpers/fixtures.ts";

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
  opts: { hold?: boolean; rpc?: (method: string) => unknown } = {},
): HermesChatClient & {
  sent: string[];
  swarmed: string[];
  aborts: string[];
  abortSessions: (string | undefined)[];
  steers: string[];
  rpcs: string[];
  turnSignals: (AbortSignal | undefined)[];
  watches: Watch[];
  histories: string[];
} {
  const abortSessions: (string | undefined)[] = [];
  const steers: string[] = [];
  const rpcs: string[] = [];
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
  const rpc = opts.rpc;
  return {
    sent,
    swarmed,
    aborts,
    abortSessions,
    steers,
    rpcs,
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
    abort: async (box, _bot, o) => {
      aborts.push(box.instance);
      abortSessions.push(o?.session);
      return true;
    },
    steer: async (_box, _bot, text) => {
      steers.push(text);
      return "queued";
    },
    ...(rpc
      ? {
          botModeRpc: async (_box: unknown, method: string) => {
            rpcs.push(method);
            return rpc(method);
          },
        }
      : {}),
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

async function setup(
  frames: ChatFrame[],
  opts: {
    hold?: boolean;
    view?: MobileFleetView;
    rpc?: (method: string) => unknown;
    timers?: Timers;
    previews?: boolean;
  } = {},
) {
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
    ...(opts.timers ? { timers: opts.timers } : {}),
    ...(opts.previews !== undefined ? { previews: () => opts.previews as boolean } : {}),
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

  test("a failed turn's phone-local entry says its headline, not its code, with previews off", async () => {
    const off = await setup([errorFrame("RATE_LIMITED", "slow down")], { previews: false });
    off.client.chat.send(T, "question");
    await settle();
    expect(off.alerts[0]).toMatchObject({ body: "Rate limited", data: { kind: "turn.error" } });
    expect(off.inbox.getState().entries[0]?.body).toBe("Rate limited");
    const on = await setup([errorFrame("RATE_LIMITED", "slow down")], { previews: true });
    on.client.chat.send(T, "question");
    await settle();
    expect(on.alerts[0]?.body).toBe("slow down");
  });

  test("every move into the background or the foreground forgets the tunnel proofs", async () => {
    const s = await setup([]);
    const host = "fxtr0001-atlas.hermetic.ts.net";
    noteTunnel(host, true);
    s.client.setPhase("background");
    expect(tunnelVerified(host)).toBe(false);
    noteTunnel(host, true);
    s.client.setPhase("active");
    expect(tunnelVerified(host)).toBe(false);
    // Inactive (a pulled-down Control Center) is not a network change.
    noteTunnel(host, true);
    s.client.setPhase("inactive");
    expect(tunnelVerified(host)).toBe(true);
    resetTunnelChecks();
    s.client.dispose();
  });
});

describe("a turn still running on its box after the phone was away", () => {
  const row = (status: string) => ({
    sessions: [{ id: "live-1", session_key: "s-1", status, message_count: 3 }],
  });

  /** A held turn on screen, sent, backgrounded and brought back; `answer` is the box's list. */
  async function away(answer: () => unknown) {
    const timers = new FakeTimers();
    const s = await setup([delta(1, "working on it")], {
      hold: true,
      timers,
      rpc: (method) => {
        if (method !== "session.active_list") throw new Error(`unexpected ${method}`);
        return answer();
      },
    });
    s.client.chat.open(T);
    expect(s.client.chat.send(T, "long job")).toBe(true);
    await settle();
    s.client.setPhase("background");
    await settle();
    s.client.setPhase("active");
    await settle();
    const tick = async (ms: number) => {
      timers.advance(ms);
      await settle();
    };
    return { ...s, timers, tick };
  }

  test("busy: still in flight as running on the box, sends are queued, idle releases the queue", async () => {
    let status = "working";
    const s = await away(() => row(status));
    expect(s.chat.rpcs).toEqual(["session.active_list"]);
    const view = s.client.chat.view(T);
    expect(view.sending).toBe(true);
    expect(view.dropped).toBe(false);
    expect(view.remote).toMatchObject({ status: "working", title: "Still running on the box." });
    // A plain send never reaches the busy session: it is refused, and the composer queues it.
    expect(s.client.chat.send(T, "next")).toBe(false);
    s.client.chat.enqueue(T, "next");
    await s.tick(REMOTE_POLL_MS);
    expect(s.chat.rpcs).toHaveLength(2);
    expect(s.chat.sent).toEqual(["long job"]);
    expect(s.client.chat.view(T).remote?.status).toBe("working");
    status = "idle";
    await s.tick(REMOTE_POLL_MS);
    await s.tick(0);
    const after = s.client.chat.view(T);
    expect(after.remote).toBeNull();
    expect(after.dropped).toBe(false);
    expect(after.queue).toEqual([]);
    expect(s.chat.sent).toEqual(["long job", "next"]);
    expect(s.chat.aborts).toEqual([]);
    // Settled: nobody asks after it any more.
    const asked = s.chat.rpcs.length;
    await s.tick(REMOTE_POLL_MS * 3);
    expect(s.chat.rpcs).toHaveLength(asked);
    s.client.dispose();
  });

  test("a session gone from the list after running is over too, not dropped", async () => {
    let answer: unknown = row("starting");
    const s = await away(() => answer);
    expect(s.client.chat.view(T).remote?.status).toBe("starting");
    answer = { sessions: [] };
    await s.tick(REMOTE_POLL_MS);
    await s.tick(0);
    expect(s.client.chat.view(T)).toMatchObject({ remote: null, sending: false, dropped: false });
    s.client.dispose();
  });

  test("Steer reaches the turn, and Stop interrupts it by its session", async () => {
    const s = await away(() => row("working"));
    expect(await s.client.chat.steer(T, "also check the logs")).toBe("queued");
    expect(s.chat.steers).toEqual(["also check the logs"]);
    await s.client.chat.stop(T);
    await settle();
    expect(s.chat.aborts).toEqual(["atlas"]);
    expect(s.chat.abortSessions).toEqual(["s-1"]);
    expect(s.client.chat.view(T)).toMatchObject({ sending: false, remote: null });
    const asked = s.chat.rpcs.length;
    await s.tick(REMOTE_POLL_MS * 2);
    expect(s.chat.rpcs).toHaveLength(asked);
    s.client.dispose();
  });

  test("waiting says the turn waits on the operator", async () => {
    const s = await away(() => row("waiting"));
    expect(s.client.chat.view(T).remote).toMatchObject({
      status: "waiting",
      title: "Still running on the box — waiting on you.",
    });
    expect(s.client.chat.view(T).remote?.sub).toContain("Open the request from history");
    s.client.dispose();
  });

  test("idle on the first ask is today's gone path: dropped and re-read", async () => {
    const s = await away(() => row("idle"));
    await s.tick(0);
    expect(s.client.chat.view(T)).toMatchObject({ sending: false, remote: null, dropped: true });
    s.client.dispose();
  });

  test("no answer on the first ask is today's gone path", async () => {
    const s = await away(() => {
      throw new Error("socket closed");
    });
    expect(s.client.chat.view(T)).toMatchObject({ sending: false, remote: null, dropped: true });
    s.client.dispose();
  });

  test(`${REMOTE_FAILURES} failed asks in a row while running give the turn up as gone`, async () => {
    let fail = false;
    const s = await away(() => {
      if (fail) throw new Error("socket closed");
      return row("working");
    });
    fail = true;
    for (let i = 1; i < REMOTE_FAILURES; i++) await s.tick(REMOTE_POLL_MS);
    expect(s.client.chat.view(T).remote?.status).toBe("working");
    await s.tick(REMOTE_POLL_MS);
    expect(s.client.chat.view(T)).toMatchObject({ sending: false, remote: null, dropped: true });
    s.client.dispose();
  });

  test("the asking stops when the conversation leaves the screen and resumes when it is back", async () => {
    const s = await away(() => row("working"));
    const asked = s.chat.rpcs.length;
    s.client.chat.leave(T);
    await s.tick(REMOTE_POLL_MS * 3);
    expect(s.chat.rpcs).toHaveLength(asked);
    expect(s.client.chat.view(T).remote?.status).toBe("working");
    s.client.chat.open(T);
    await settle();
    expect(s.chat.rpcs).toHaveLength(asked + 1);
    s.client.dispose();
  });

  test("the asking stops in the background and starts again on the return", async () => {
    const s = await away(() => row("working"));
    const asked = s.chat.rpcs.length;
    s.client.setPhase("background");
    await s.tick(REMOTE_POLL_MS * 3);
    expect(s.chat.rpcs).toHaveLength(asked);
    s.client.setPhase("active");
    await settle();
    expect(s.chat.rpcs).toHaveLength(asked + 1);
    expect(s.client.chat.view(T).remote?.status).toBe("working");
    s.client.dispose();
  });
});
