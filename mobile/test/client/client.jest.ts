import type {
  Bot,
  ChatFrame,
  ChatMessage,
  HermesChatClient,
  Session,
} from "@hermetic/core/chat-client";
import type { MobileFleetView } from "@hermetic/core/schema";
import { encodeMobileLink } from "@hermetic/core/shared";
import {
  type Alert,
  createHermeticClient,
  type HermeticClient,
  REMOTE_FAILURES,
  REMOTE_MISSES,
  REMOTE_POLL_MS,
  REMOTE_UNKNOWN_MAX_MS,
  REMOTE_WAITING_POLL_MS,
  alertTitle,
  tailShowsDone,
} from "../../src/client/client.ts";
import { failedBots, homeRowsByKey, needsBots } from "../../src/client/home-rows.ts";
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
  msg,
  question,
  swarm,
  tool,
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
  opts: {
    hold?: boolean;
    rpc?: (method: string) => unknown;
    history?: () => ChatMessage[];
    /** What `abort` answers (default `true`: the box interrupted something). */
    aborted?: () => boolean;
    /** The bots every swarm lists (default one `scribe`). */
    bots?: Bot[];
  } = {},
): HermesChatClient & {
  sent: string[];
  swarmed: string[];
  aborts: string[];
  abortSessions: (string | undefined)[];
  steers: string[];
  steerSessions: (string | undefined)[];
  rpcs: string[];
  turnSignals: (AbortSignal | undefined)[];
  watches: Watch[];
  histories: string[];
} {
  const abortSessions: (string | undefined)[] = [];
  const steers: string[] = [];
  const steerSessions: (string | undefined)[] = [];
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
    steerSessions,
    rpcs,
    turnSignals,
    watches,
    histories,
    token: async () => "FIXTURE",
    swarm: async (box) => {
      swarmed.push(box.baseUrl);
      return swarm(box.instance, opts.bots ?? [bot()]);
    },
    sessions: async (box, b) => [
      session({ id: "s-1", instance: box.instance, bot: b, kind: "canonical" }),
      session({ id: "s-2", instance: box.instance, bot: b, kind: "thread" }),
    ],
    respond: async () => ({ status: "ok" as const }),
    history: async (box) => {
      histories.push(box.instance);
      return opts.history?.() ?? [];
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
      return opts.aborted?.() ?? true;
    },
    steer: async (_box, _bot, text, o) => {
      steers.push(text);
      steerSessions.push(o?.session);
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

const BOT_CHAT = { instance: "atlas", bot: "scribe", session: null, resolved: "s-1" };
const SEPARATE = { instance: "atlas", bot: "scribe", session: "s-2", resolved: "s-2" };

const session = (
  over: Partial<Session> & Pick<Session, "id" | "instance" | "bot" | "kind">,
): Session => ({
  origin: "portal",
  title: over.id,
  unread: 0,
  turn_count: 1,
  ...over,
});

const unreadSessions = (inbox: InboxStore) =>
  inbox
    .getState()
    .entries.filter((e) => !e.read_at)
    .map((e) => e.session)
    .sort();

/** What home draws on a bot's row: the roster as read, the inbox's needs folded in. */
function badgeOf(s: { client: HermeticClient; inbox: InboxStore }, key: string): string | null {
  const roster = s.client.roster.getState();
  const rows = homeRowsByKey({
    swarms: roster.swarms,
    listening: roster.listening,
    unreadOf: s.inbox.unreadFor,
    needs: needsBots(s.inbox.getState().entries),
  });
  return rows.get(key)?.badge ?? null;
}

/** Whether home draws a bot's row with the failed mark. */
function failedOf(s: { client: HermeticClient; inbox: InboxStore }, key: string): boolean {
  const roster = s.client.roster.getState();
  const rows = homeRowsByKey({
    swarms: roster.swarms,
    listening: roster.listening,
    unreadOf: s.inbox.unreadFor,
    failed: failedBots(s.inbox.getState().entries),
  });
  return rows.get(key)?.failed ?? false;
}

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
    history?: () => ChatMessage[];
    aborted?: () => boolean;
    timers?: Timers;
    previews?: boolean;
    bots?: Bot[];
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
    s.client.setWatched({ ...BOT_CHAT, focused: true });
    s.client.chat.send(T, "question");
    await settle();
    expect(s.alerts).toEqual([]);
    expect(s.inbox.badgeCount()).toBe(0);
  });

  test("a separate session on screen reads only itself, and the Bot Chat's events still alert", async () => {
    const s = await setup([delta(1, "x"), done(2)]);
    for (const [session, n] of [
      ["s-1", 1],
      ["s-2", 2],
    ] as const)
      s.inbox.ingest({
        kind: "turn.done",
        instance: "atlas",
        bot: "scribe",
        session,
        title: "scribe · atlas",
        body: "Reply ready",
        // An hour back: not the same event as the reply this test sends.
        at: "2026-10-13T09:00:00.000Z",
        dedupe: `atlas:${session}:${n}:turn.done`,
      });
    await s.client.roster.refresh();
    const markSeen = jest.spyOn(s.client.roster, "markSeen");
    s.client.setWatched({ ...SEPARATE, focused: true });
    expect(markSeen).not.toHaveBeenCalled();
    expect(unreadSessions(s.inbox)).toEqual(["s-1"]);
    // A Bot Chat reply lands while the separate session is on screen: filed unread, and alerted.
    s.client.chat.send(T, "question");
    await settle();
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ decision: "banner", data: { session: "s-1" } });
    expect(unreadSessions(s.inbox)).toEqual(["s-1", "s-1"]);
    expect(markSeen).not.toHaveBeenCalled();
    // The Bot Chat focused clears the bot.
    s.client.setWatched({ ...BOT_CHAT, focused: true });
    expect(markSeen).toHaveBeenCalledWith("atlas", "scribe");
    expect(unreadSessions(s.inbox)).toEqual([]);
  });

  test("a request still open after the operator left keeps needs-you on home until answered", async () => {
    const s = await setup([block(1, question())], { hold: true });
    await s.client.roster.refresh();
    s.client.chat.open(T);
    s.client.setWatched({ ...BOT_CHAT, focused: true });
    s.client.chat.send(T, "pick one");
    await settle();
    // Opened while on screen: filed read, no alert.
    expect(s.alerts).toEqual([]);
    expect(s.inbox.getState().entries[0]).toMatchObject({ kind: "needs_action" });
    expect(s.inbox.badgeCount()).toBe(0);
    // Back home: still waiting, so the row says so.
    s.client.setWatched(null);
    s.client.chat.leave(T);
    expect(badgeOf(s, "atlas/scribe")).toBe("!");
    // Reading the thread again does not clear a request nobody answered.
    s.client.setWatched({ ...BOT_CHAT, focused: true });
    s.client.setWatched(null);
    expect(badgeOf(s, "atlas/scribe")).toBe("!");
    // A roster read does not either.
    await s.client.roster.refresh();
    expect(badgeOf(s, "atlas/scribe")).toBe("!");
    await s.client.chat.respond(T, { request_id: "q1", kind: "question", answer: "main" });
    expect(badgeOf(s, "atlas/scribe")).toBeNull();
    s.client.dispose();
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

  test("a separate session's message moves the bot's time, never its Bot Chat count", async () => {
    const s = await setup([], { bots: [bot({ unread: 3 })] });
    await s.client.roster.refresh();
    const scribe = () =>
      s.client.roster.getState().swarms.find((sw) => sw.instance === "atlas")?.bots[0];
    expect(scribe()?.unread).toBe(3);
    const separate = { instance: "atlas", bot: "scribe", session: "s-2" };
    const at = "2026-10-13T10:05:00.000Z";
    s.client.chat.onObserveEvent(s.client.chat.view(separate).key, {
      type: "message",
      ...separate,
      message: msg({ id: "sep-1", at, text: "in the thread" }),
    });
    expect(scribe()).toMatchObject({ unread: 3, last_message_at: at });
    // The Bot Chat's own message is what the operator sees there: its count clears.
    s.client.chat.onObserveEvent(s.client.chat.view(T).key, {
      type: "message",
      ...T,
      message: msg({ id: "bot-1", at, text: "in the Bot Chat" }),
    });
    expect(scribe()?.unread).toBe(0);
    s.client.dispose();
  });

  test("a failure that lands off screen marks the bot failed on home; opening its chat clears it", async () => {
    const s = await setup([errorFrame("RATE_LIMITED", "slow down")]);
    await s.client.roster.refresh();
    s.client.chat.send(T, "question");
    await settle();
    expect(failedOf(s, "atlas/scribe")).toBe(true);
    s.client.setWatched({ ...BOT_CHAT, focused: true });
    expect(failedOf(s, "atlas/scribe")).toBe(false);
    s.client.setWatched(null);
    expect(failedOf(s, "atlas/scribe")).toBe(false);
  });

  test("a failure seen on screen is read: leaving the chat leaves no failed mark", async () => {
    const s = await setup([errorFrame("RATE_LIMITED", "slow down")]);
    await s.client.roster.refresh();
    s.client.setWatched({ ...BOT_CHAT, focused: true });
    s.client.chat.send(T, "question");
    await settle();
    s.client.setWatched(null);
    expect(s.inbox.getState().entries[0]).toMatchObject({ kind: "turn.error" });
    expect(failedOf(s, "atlas/scribe")).toBe(false);
  });

  test("an alert is titled with the bot's display title, and its instance only when it tells bots apart", async () => {
    const s = await setup([delta(1, "x"), done(2)]);
    s.client.chat.send(T, "before the roster");
    await settle();
    // No roster read yet: the bot's name; two instances listened, so the instance too.
    expect(s.alerts[0]?.title).toBe("scribe · atlas");
    await s.client.roster.refresh();
    s.client.chat.send(T, "two instances");
    await settle();
    expect(s.alerts[1]?.title).toBe("SCRIBE · atlas");
    expect(s.inbox.getState().entries[0]?.title).toBe("SCRIBE · atlas");
    await s.fleet.setListening("corvid", false);
    await s.client.roster.refresh();
    s.client.chat.send(T, "one instance");
    await settle();
    expect(s.alerts[2]?.title).toBe("SCRIBE");
    s.client.dispose();
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

  /**
   * A held turn on screen, sent, backgrounded and brought back; `answer` is the
   * box's list. `frames` is what the turn said before it was detached, and
   * `queued` is put in the queue while it runs, before the phone goes away.
   */
  async function away(
    answer: () => unknown,
    opts: {
      frames?: ChatFrame[];
      queued?: string;
      history?: () => ChatMessage[];
      aborted?: () => boolean;
    } = {},
  ) {
    const timers = new FakeTimers();
    const s = await setup(opts.frames ?? [delta(1, "working on it")], {
      hold: true,
      timers,
      ...(opts.history ? { history: opts.history } : {}),
      ...(opts.aborted ? { aborted: opts.aborted } : {}),
      rpc: (method) => {
        if (method !== "session.active_list") throw new Error(`unexpected ${method}`);
        return answer();
      },
    });
    s.client.chat.open(T);
    expect(s.client.chat.send(T, "long job")).toBe(true);
    await settle();
    if (opts.queued) s.client.chat.enqueue(T, opts.queued);
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

  test(`a session gone from the list is over only after ${REMOTE_MISSES} answers in a row, not dropped`, async () => {
    let answer: unknown = row("starting");
    const s = await away(() => answer);
    expect(s.client.chat.view(T).remote?.status).toBe("starting");
    s.client.chat.enqueue(T, "next");
    answer = { sessions: [] };
    // One answer without the session is not yet an answer: nothing drains into it.
    await s.tick(REMOTE_POLL_MS);
    expect(s.client.chat.view(T)).toMatchObject({ sending: true, remote: { status: "starting" } });
    expect(s.chat.sent).toEqual(["long job"]);
    await s.tick(REMOTE_POLL_MS);
    await s.tick(0);
    // Over: the queued message is the next turn (it holds open, so `sending` again).
    expect(s.client.chat.view(T)).toMatchObject({ remote: null, dropped: false, queue: [] });
    expect(s.chat.sent).toEqual(["long job", "next"]);
    s.client.dispose();
  });

  test("a compaction renaming the stored session mid-turn is matched on the live id", async () => {
    let answer: unknown = row("working");
    const s = await away(() => answer);
    s.client.chat.enqueue(T, "next");
    // Upstream's `session_key` is the rotated stored id; the live `id` stays.
    answer = { sessions: [{ id: "live-1", session_key: "s-1b", status: "working" }] };
    const asked = s.chat.rpcs.length;
    for (let i = 0; i < REMOTE_MISSES + 1; i++) await s.tick(REMOTE_POLL_MS);
    expect(s.chat.rpcs).toHaveLength(asked + REMOTE_MISSES + 1);
    expect(s.client.chat.view(T)).toMatchObject({ sending: true, remote: { status: "working" } });
    expect(s.chat.sent).toEqual(["long job"]);
    answer = { sessions: [{ id: "live-1", session_key: "s-1b", status: "idle" }] };
    await s.tick(REMOTE_POLL_MS);
    await s.tick(0);
    // Over: the queued message is the next turn (it holds open, so `sending` again).
    expect(s.client.chat.view(T)).toMatchObject({ remote: null, dropped: false, queue: [] });
    expect(s.chat.sent).toEqual(["long job", "next"]);
    s.client.dispose();
  });

  test("Stop before the box has answered the first ask interrupts the turn by its session", async () => {
    let answer!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      answer = resolve;
    });
    const s = await away(() => pending, { queued: "next" });
    expect(s.chat.rpcs).toEqual(["session.active_list"]);
    expect(s.client.chat.view(T)).toMatchObject({ sending: true, remote: null });
    await s.client.chat.stop(T);
    await settle();
    expect(s.chat.aborts).toEqual(["atlas"]);
    expect(s.chat.abortSessions).toEqual(["s-1"]);
    // Parked, never drained into the session it just interrupted.
    expect(s.client.chat.view(T)).toMatchObject({ sending: false, queueParked: true });
    expect(s.chat.sent).toEqual(["long job"]);
    answer(row("working"));
    await settle();
    expect(s.client.chat.view(T).remote).toBeNull();
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

  test("after a compaction renamed the stored session, Steer and Stop go by the row's new key", async () => {
    let answer: unknown = row("working");
    const s = await away(() => answer);
    answer = { sessions: [{ id: "live-1", session_key: "s-1b", status: "working" }] };
    await s.tick(REMOTE_POLL_MS);
    expect(await s.client.chat.steer(T, "also check the logs")).toBe("queued");
    expect(s.chat.steerSessions).toEqual(["s-1b"]);
    await s.client.chat.stop(T);
    await settle();
    // The old key resolves to the idle parent, which has nothing to interrupt.
    expect(s.chat.abortSessions).toEqual(["s-1b"]);
    expect(s.client.chat.view(T)).toMatchObject({ sending: false, remote: null });
    s.client.dispose();
  });

  test("a Stop the box did not act on keeps the turn running and the queue parked", async () => {
    let interrupted = false;
    const s = await away(() => row("working"), { queued: "next", aborted: () => interrupted });
    await s.client.chat.stop(T);
    await settle();
    expect(s.chat.abortSessions).toEqual(["s-1"]);
    expect(s.client.chat.view(T)).toMatchObject({
      sending: true,
      aborting: false,
      remote: { status: "working" },
      queueParked: true,
      turnError: { code: "ABORT_FAILED", message: "Could not stop the turn — try again." },
    });
    expect(s.chat.sent).toEqual(["long job"]);
    // Still followed: a second Stop that lands settles it.
    await s.tick(REMOTE_POLL_MS);
    expect(s.client.chat.view(T).remote?.status).toBe("working");
    interrupted = true;
    await s.client.chat.stop(T);
    await settle();
    expect(s.client.chat.view(T)).toMatchObject({
      sending: false,
      remote: null,
      turnError: null,
      queueParked: true,
    });
    expect(s.chat.sent).toEqual(["long job"]);
    s.client.dispose();
  });

  test("a refused Stop is moot once the turn ends by itself", async () => {
    let answer: unknown = row("working");
    const s = await away(() => answer, { aborted: () => false });
    await s.client.chat.stop(T);
    await settle();
    expect(s.client.chat.view(T).turnError?.code).toBe("ABORT_FAILED");
    answer = row("idle");
    await s.tick(REMOTE_POLL_MS);
    await s.tick(0);
    expect(s.client.chat.view(T)).toMatchObject({ sending: false, remote: null, turnError: null });
    s.client.dispose();
  });

  test("a request in a turn running on its box unfollowed is not open here", async () => {
    const s = await away(() => row("waiting"), { frames: [block(1, approval())] });
    expect(s.client.chat.view(T)).toMatchObject({ remote: { status: "waiting" }, openRequests: [] });
    s.client.dispose();
  });

  test("waiting says the turn waits on the operator", async () => {
    const s = await away(() => row("waiting"));
    expect(s.client.chat.view(T).remote).toMatchObject({
      status: "waiting",
      title: "Still running on the box — waiting on you.",
    });
    expect(s.client.chat.view(T).remote?.sub).toMatch(
      /^Waiting on you — answer from the desktop, or stop the turn here\./,
    );
    s.client.dispose();
  });

  test("idle on the first ask finished while away: re-read, queue drained, nothing dropped", async () => {
    // No frame before the phone left: nothing assembled to fall back on.
    const s = await away(() => row("idle"), { frames: [], queued: "next" });
    await s.tick(0);
    expect(s.client.chat.view(T)).toMatchObject({
      remote: null,
      dropped: false,
      live: null,
      queue: [],
    });
    expect(s.chat.histories.length).toBeGreaterThan(0);
    expect(s.chat.sent).toEqual(["long job", "next"]);
    s.client.dispose();
  });

  // The turn started at NOW (the client's clock in these tests).
  const OLD = msg({ id: "old", at: "2026-10-13T09:59:00.000Z", text: "earlier reply" });
  const FRESH = msg({ id: "fresh", at: "2026-10-13T10:05:00.000Z", text: "all done" });
  /** A busy row with no live `id`: the phone never learns the turn's runtime session. */
  const keyOnly = (status: string) => ({ sessions: [{ session_key: "s-1", status }] });

  test(`missing from ${REMOTE_MISSES} first answers, a fresh reply in the tail: finished while away, not dropped`, async () => {
    const s = await away(() => ({ sessions: [] }), { frames: [], history: () => [OLD, FRESH] });
    expect(s.client.chat.view(T)).toMatchObject({ sending: true, remote: null });
    await s.tick(REMOTE_POLL_MS);
    await s.tick(0);
    // No "reply stopped arriving" band over a transcript the re-read made whole.
    expect(s.client.chat.view(T)).toMatchObject({
      sending: false,
      dropped: false,
      reconnecting: false,
      live: null,
    });
    expect(s.chat.histories.length).toBeGreaterThan(0);
    s.client.dispose();
  });

  test("missing with no live id and an old tail: still running on the box, still asked", async () => {
    let answer: unknown = keyOnly("working");
    const s = await away(() => answer, { history: () => [OLD] });
    expect(s.client.chat.view(T).remote?.status).toBe("working");
    s.client.chat.enqueue(T, "next");
    // Renamed by a compaction while away, or over: the tail has no reply since the turn began.
    answer = { sessions: [] };
    const asked = s.chat.rpcs.length;
    for (let i = 0; i < REMOTE_MISSES * 3; i++) await s.tick(REMOTE_POLL_MS);
    expect(s.chat.rpcs).toHaveLength(asked + REMOTE_MISSES * 3);
    expect(s.client.chat.view(T)).toMatchObject({ sending: true, remote: { status: "working" } });
    expect(s.chat.sent).toEqual(["long job"]);
    s.client.dispose();
  });

  test(`missing with no live id is over at ${REMOTE_UNKNOWN_MAX_MS / 1000} s whatever the tail says`, async () => {
    let answer: unknown = keyOnly("working");
    const s = await away(() => answer, { history: () => [OLD] });
    s.client.chat.enqueue(T, "next");
    answer = { sessions: [] };
    await s.tick(REMOTE_POLL_MS); // the first miss
    for (let t = REMOTE_POLL_MS; t < REMOTE_UNKNOWN_MAX_MS; t += REMOTE_POLL_MS)
      await s.tick(REMOTE_POLL_MS);
    expect(s.client.chat.view(T)).toMatchObject({ sending: true, remote: { status: "working" } });
    expect(s.chat.sent).toEqual(["long job"]);
    await s.tick(REMOTE_POLL_MS);
    await s.tick(0);
    expect(s.client.chat.view(T)).toMatchObject({ remote: null, dropped: false, queue: [] });
    expect(s.chat.sent).toEqual(["long job", "next"]);
    const asked = s.chat.rpcs.length;
    await s.tick(REMOTE_POLL_MS * 3);
    expect(s.chat.rpcs).toHaveLength(asked);
    s.client.dispose();
  });

  test("an idle row for the stored key with no live id is final at once", async () => {
    let answer: unknown = keyOnly("working");
    const s = await away(() => answer, { history: () => [OLD] });
    s.client.chat.enqueue(T, "next");
    answer = keyOnly("idle");
    await s.tick(REMOTE_POLL_MS);
    await s.tick(0);
    expect(s.client.chat.view(T)).toMatchObject({ remote: null, dropped: false, queue: [] });
    expect(s.chat.sent).toEqual(["long job", "next"]);
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

  test("off screen, a turn waiting on the operator keeps needs-you until the box says it moved on", async () => {
    let status = "waiting";
    const s = await away(() => row(status), { frames: [block(1, approval())] });
    await s.client.roster.refresh();
    expect(badgeOf(s, "atlas/scribe")).toBe("!");
    // Read and left: the request is still pending on the box, so the mark stays.
    s.client.setWatched({ ...BOT_CHAT, focused: true });
    s.client.setWatched(null);
    s.client.chat.leave(T);
    expect(s.inbox.badgeCount()).toBe(0);
    expect(badgeOf(s, "atlas/scribe")).toBe("!");
    // The on-screen pace runs out once; off screen it is the slow one.
    await s.tick(REMOTE_POLL_MS);
    const asked = s.chat.rpcs.length;
    await s.tick(REMOTE_POLL_MS * 5);
    expect(s.chat.rpcs).toHaveLength(asked);
    await s.tick(REMOTE_WAITING_POLL_MS - REMOTE_POLL_MS * 5);
    expect(s.chat.rpcs).toHaveLength(asked + 1);
    expect(badgeOf(s, "atlas/scribe")).toBe("!");
    // Answered on the desktop: cleared within one slow ask, and the asking stops.
    status = "working";
    await s.tick(REMOTE_WAITING_POLL_MS);
    expect(badgeOf(s, "atlas/scribe")).toBeNull();
    await s.client.roster.refresh();
    expect(badgeOf(s, "atlas/scribe")).toBeNull();
    const after = s.chat.rpcs.length;
    await s.tick(REMOTE_WAITING_POLL_MS * 3);
    expect(s.chat.rpcs).toHaveLength(after);
    expect(s.client.chat.view(T).remote?.status).toBe("working");
    s.client.dispose();
  });

  test("a waiting turn's conversation shown again is asked at once and at the on-screen pace", async () => {
    const s = await away(() => row("waiting"), { frames: [block(1, approval())] });
    s.client.chat.leave(T);
    await s.tick(REMOTE_POLL_MS);
    const asked = s.chat.rpcs.length;
    s.client.chat.open(T);
    await settle();
    expect(s.chat.rpcs).toHaveLength(asked + 1);
    await s.tick(REMOTE_POLL_MS);
    expect(s.chat.rpcs).toHaveLength(asked + 2);
    s.client.dispose();
  });

  test("a turn waiting on the operator off screen is asked after again on the return from the background", async () => {
    let status = "waiting";
    const s = await away(() => row(status), { frames: [block(1, approval())] });
    await s.client.roster.refresh();
    s.client.chat.leave(T);
    s.client.setPhase("background");
    await settle();
    status = "idle";
    const asked = s.chat.rpcs.length;
    expect(badgeOf(s, "atlas/scribe")).toBe("!");
    s.client.setPhase("active");
    await settle();
    await s.tick(0);
    expect(s.chat.rpcs).toHaveLength(asked + 1);
    expect(s.client.chat.view(T)).toMatchObject({ sending: false, remote: null });
    expect(s.client.chat.waiting()).toEqual([]);
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

describe("alertTitle", () => {
  const b = (instance: string, name: string, title: string) => bot({ instance, name, title });
  const roster = (listening: string[], bots: ReturnType<typeof bot>[]) => ({
    listening,
    swarms: listening.map((instance) =>
      swarm(
        instance,
        bots.filter((x) => x.instance === instance),
      ),
    ),
  });

  test("one instance: the display title alone, the name when the bot has no title or is not listed", () => {
    const r = roster(["atlas"], [b("atlas", "clio", "Clio"), b("atlas", "wren", "")]);
    expect(alertTitle(r, { instance: "atlas", bot: "clio" })).toBe("Clio");
    expect(alertTitle(r, { instance: "atlas", bot: "wren" })).toBe("wren");
    expect(alertTitle(r, { instance: "atlas", bot: "ghost" })).toBe("ghost");
  });

  test("two bots of one instance with one title are told apart by name", () => {
    const r = roster(["atlas"], [b("atlas", "clio", "Helper"), b("atlas", "wren", "helper")]);
    expect(alertTitle(r, { instance: "atlas", bot: "clio" })).toBe("Helper (clio)");
  });

  test("more than one instance listened: the instance follows", () => {
    const r = roster(["atlas", "corvid"], [b("atlas", "clio", "Clio"), b("corvid", "wren", "Wren")]);
    expect(alertTitle(r, { instance: "atlas", bot: "clio" })).toBe("Clio · atlas");
  });
});

describe("tailShowsDone", () => {
  const since = "2026-10-13T10:00:00.000Z";
  const at = "2026-10-13T10:01:00.000Z";

  test("a bot reply written after the start ends the turn", () => {
    expect(tailShowsDone([msg({ role: "user", at: since }), msg({ at })], since)).toBe(true);
  });

  test("a failure written after the start ends it, whatever its role", () => {
    const failed = msg({ role: "system", at, failure: { code: "RATE_LIMITED", message: "slow down" } });
    expect(tailShowsDone([failed], since)).toBe(true);
  });

  test("an older row, a user row, a reply stopping on a tool call, or no start: not yet", () => {
    expect(tailShowsDone([msg({ at: since })], since)).toBe(false);
    expect(tailShowsDone([msg({ at }), msg({ role: "user", at })], since)).toBe(false);
    expect(tailShowsDone([msg({ at, blocks: [tool()] })], since)).toBe(false);
    expect(tailShowsDone([], since)).toBe(false);
    expect(tailShowsDone([msg({ at })], null)).toBe(false);
  });

  test("process events after the reply are looked past", () => {
    const event = msg({
      at,
      role: "system",
      blocks: [{ kind: "process_event" } as ChatMessage["blocks"][number]],
    });
    expect(tailShowsDone([msg({ at }), event], since)).toBe(true);
  });
});
