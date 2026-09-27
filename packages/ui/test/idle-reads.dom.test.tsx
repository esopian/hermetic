/**
 * What an idle chat view puts on the tailnet, and what a hidden one does not.
 *
 * Both reads guarded here are fan-outs to boxes over the tailnet, and both were
 * measured against a running portal doing far more work than anything asked
 * for: the roster read (`chat.swarms`) landing every couple of seconds
 * on a tab nobody was looking at, and the open conversation re-reading its
 * transcript *and* its session list in pairs on a timer.
 *
 * The two rules, stated once here so a future edit has to break a test rather
 * than a measurement somebody happened to take:
 *
 * - a hidden page reads no roster at all, whoever asks, and reads one when it
 *   comes back;
 * - a tick that catches new messages reads the transcript, never the session
 *   list beside it, and not at all while the page is hidden.
 *
 * The cadences are the *shipped* ones and the clock is the test's: every test
 * hands `ChatProvider` a `fakeClock()` (`fake-clock.ts`) through `timing`
 * (`ChatTiming` in `chat-state.tsx`) and steps it by hand, so "two minutes go
 * by" is `advance(ROSTER_INTERVAL_MS)` and a "nothing reads" window is a
 * number rather than a sleep. Two earlier shapes of this file are why it is
 * built this way: one faked the process clock (`jest.useFakeTimers`), which
 * React's `act()` parked on and which advanced on a laptop and not on the CI
 * runner; the next shrank the cadences to milliseconds and slept on the real
 * clock, which measured scheduling jitter as much as the store. A clock only
 * the store reads has neither problem, and every assertion below is exact.
 */
import { act, cleanup, render, screen, setPageHidden, waitFor } from "./dom.ts";
import { useState } from "react";
import { ListeningProvider } from "../src/state/listening-state.tsx";
import { RETURN_READ_MIN_AGE_MS } from "../src/lib/visibility.ts";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { ChatSwarmsResult, SwarmView } from "../src/api/index.ts";
import { setFleetTarget } from "../src/api/index.ts";
import { invalidateFetchCache } from "../src/lib/fetch-cache.ts";
import { resetBotCapabilityMemo } from "../src/chat/bot-capabilities.ts";
import { ChatProvider, DEFAULT_CHAT_TIMING, useChat } from "../src/chat/chat-state.tsx";
import type { Chat, ChatApi } from "../src/chat/chat-state.tsx";
import { BotWorkspace } from "../src/chat/components/BotWorkspace.tsx";
import { fakeClock, settle } from "./fake-clock.ts";
import type { FakeClock } from "./fake-clock.ts";
import { fakeServer, FAKE_TARGET } from "./fake-transport.ts";
import type { FakeRoutes, FakeServer } from "./fake-transport.ts";

const AT = "2026-09-18T12:00:00Z";
const INSTANCE = "atlas";
const SESSION = "s-named";

/** The shipped cadences, named for the assertions that step past them. */
const ROSTER_MS = DEFAULT_CHAT_TIMING.rosterIntervalMs;
const TICK_MS = DEFAULT_CHAT_TIMING.transcriptTickMs;

/**
 * Every process-wide thing this file's subject reads, put where this file wants
 * it — before each test rather than once, because `bun test` runs every
 * package's files in one process and each of these is written by somebody else.
 *
 * What this file measures is *how many reads a mounted store makes*, so a piece
 * of shared state that suppresses a read (a memo another file's test warmed), or
 * that turns one into a throw (`api.ts`'s fleet target left null, so `target()`
 * refuses; a transport still installed by a neighbour's fake server, which
 * throws on any route it does not know), does not fail an assertion — it empties the
 * tree and leaves the counts at zero. That is the failure this file kept
 * producing on CI and never on a laptop, and it is not something the tests
 * below can see. So: a fleet target, a fake server wide enough to answer
 * anything this tree asks for, and both browser-side memos cleared.
 */
/**
 * The wildcard the old fetch fake spelled `"GET /api/*"`: every request name
 * answers, emptily. Route keys are a closed union now, so "anything this tree
 * asks for" is a proxy rather than three globs.
 */
const ANY_ROUTE = new Proxy({}, { get: () => ({}) }) as FakeRoutes;

let server: FakeServer | undefined;
let clock: FakeClock;
beforeEach(() => {
  // The store's timers are the fake clock's; `waitFor` and React's own
  // scheduling are the platform's, and a neighbouring file that installed
  // `jest.useFakeTimers` and did not put it back would park those instead.
  jest.useRealTimers();
  clock = fakeClock();
  setFleetTarget(FAKE_TARGET);
  invalidateFetchCache();
  resetBotCapabilityMemo();
  server = fakeServer(ANY_ROUTE);
});
afterEach(() => {
  server?.restore();
  server = undefined;
  // A visible page, back for the next file: the reset is each suite's own (`setup.ts`).
  setPageHidden(false);
  cleanup();
});

function swarmOf(): SwarmView {
  return {
    instance: INSTANCE,
    reachable: true,
    unreachable_reason: null,
    bots: [
      {
        instance: INSTANCE,
        name: INSTANCE,
        title: INSTANCE,
        description: "the box",
        is_default: true,
        model: null,
        section: null,
        avatar_seed: `${INSTANCE}/${INSTANCE}`,
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
  } as unknown as SwarmView;
}

/** Every read the view can make, counted. */
interface Counts {
  swarms: number;
  sessions: number;
  history: number;
}

function countingApi(counts: Counts): ChatApi {
  return {
    fetchSwarms: () => {
      counts.swarms += 1;
      return Promise.resolve({ swarms: [swarmOf()] } as ChatSwarmsResult);
    },
    fetchSessions: (instance: string, bot: string) => {
      counts.sessions += 1;
      return Promise.resolve({
        instance,
        bot,
        sessions: [
          { id: SESSION, origin: "portal", started_at: AT, last_message_at: AT, title: "Named" },
        ],
      } as never);
    },
    fetchHistory: (instance: string, bot: string) => {
      counts.history += 1;
      return Promise.resolve({ instance, bot, session: SESSION, messages: [] } as never);
    },
    sendTurn: () => () => {},
    abortTurn: () => Promise.resolve({} as never),
  };
}

/** One `act` step — an event, a selection, a call — and whatever it started. */
async function step(run: () => Promise<void> | void) {
  await act(async () => {
    await run();
  });
  await settle();
}

describe("the roster is not read for a page nobody is looking at", () => {
  test("no read while hidden, one on return, then the two-minute cadence", async () => {
    setPageHidden(true);
    const counts: Counts = { swarms: 0, sessions: 0, history: 0 };
    let chat!: Chat;
    function Probe() {
      chat = useChat();
      return null;
    }
    render(
      // The age gate is off here — it is the last test's subject. This one is
      // about the visibility gate, and a return has to be answerable.
      <ChatProvider api={countingApi(counts)} timing={{ ...clock.timing, returnReadMinAgeMs: 0 }}>
        <Probe />
      </ChatProvider>,
    );
    await settle();
    // The mount read is a read like any other: a hidden tab does not make it.
    expect(counts.swarms).toBe(0);

    // Two whole cadences, hidden: the tick is not armed, not merely gated.
    await clock.advance(ROSTER_MS * 2);
    expect(counts.swarms).toBe(0);

    // An explicit ask from a background tab is refused too — the rail it would
    // refresh is not on screen, and the read is a sweep of the whole fleet.
    await step(async () => {
      await chat.refreshSwarms();
    });
    expect(counts.swarms).toBe(0);

    // Coming back reads immediately rather than waiting out an interval.
    setPageHidden(false);
    await step(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(counts.swarms).toBe(1);

    // And then the designed cadence, not a poll: nothing for most of an
    // interval after that read, and then exactly one more.
    await clock.advance(ROSTER_MS - 1);
    expect(counts.swarms).toBe(1);
    await clock.advance(1);
    expect(counts.swarms).toBe(2);
    await clock.advance(ROSTER_MS - 1);
    expect(counts.swarms).toBe(2);
  });
});

describe("an open named session polls its transcript and nothing else", () => {
  async function openNamed(counts: Counts) {
    let chat!: Chat;
    function Probe() {
      chat = useChat();
      return null;
    }
    render(
      <ChatProvider api={countingApi(counts)} timing={{ ...clock.timing, returnReadMinAgeMs: 0 }}>
        <Probe />
        <BotWorkspace withContext={false} />
      </ChatProvider>,
    );
    await settle();
    await step(() => {
      chat.select(INSTANCE, INSTANCE, SESSION);
    });
    await waitFor(() => screen.getByText(/Additional session/));
    return chat;
  }

  test("the tick reads history alone, and not at all while hidden", async () => {
    const counts: Counts = { swarms: 0, sessions: 0, history: 0 };
    await openNamed(counts);
    // Opening a conversation reads its transcript and the list of this bot's
    // conversations. Whatever that cost — the rail's default bot is opened
    // first and then the named session — it is waited for rather than assumed
    // to have landed by the time the session's name reached the screen.
    await waitFor(() => {
      expect(counts.history).toBeGreaterThan(0);
      expect(counts.sessions).toBeGreaterThan(0);
    });
    await settle();

    // Hidden first, and the baseline is taken *after* the page is hidden, so a
    // tick that was already in flight cannot be read as one this window caused.
    setPageHidden(true);
    await step(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const opened = { history: counts.history, sessions: counts.sessions };
    // Ten cadences' worth of hidden page: not one transcript read.
    await clock.advance(TICK_MS * 10);
    expect(counts.history).toBe(opened.history);
    expect(counts.sessions).toBe(opened.sessions);

    setPageHidden(false);
    await step(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Visible again, the tick reads the transcript — one read per cadence,
    // and the session list beside it stays untouched, which is the pair that
    // made this a double cost.
    const returned = counts.history;
    await clock.advance(TICK_MS * 3);
    expect(counts.history).toBe(returned + 3);
    expect(counts.sessions).toBe(opened.sessions);
  });
});

describe("a re-render is not a reason to read anything", () => {
  /**
   * The churn this guards against is structural rather than hypothetical. The
   * listened set reaches this store as a fresh array (`listening-state.tsx`
   * rebuilds it with `filter` inside its value), the fleet stream re-renders
   * the tree on its own poll frame every few seconds, and every reader in the
   * conversation store used to be memoised on the injected `api` object — so a
   * parent that rebuilt any of those handed the store a new dependency, and
   * two of them are the dependencies of the effect that opens the selected
   * conversation and of the one that reads the roster. Each render was a read
   * against a box, over the tailnet, for an answer nothing had changed.
   *
   * A visible page, an open canonical conversation, and a run of renders and
   * listening re-reads that answer exactly what they answered before. Nothing
   * on the wire. The clock does not move for the length of this test, so a
   * count that moved moved because something *rendered* — which is what this
   * test is for, and what the first test is not.
   */
  test("renders and repeated listening reads leave every count where it was", async () => {
    const counts: Counts = { swarms: 0, sessions: 0, history: 0 };
    const listeningApi = {
      // A new array each time, as the real read gives: the identity churns,
      // the answer does not.
      fetchListening: () => Promise.resolve({ instances: [INSTANCE] }),
      setInstanceListening: () => Promise.resolve({ instances: [INSTANCE] }),
    };
    let bump!: () => void;
    let chat!: Chat;
    function Probe() {
      chat = useChat();
      return null;
    }
    /**
     * The render has to come from above the store and rebuild its element,
     * which is what an ancestor re-rendering on a stream frame does. A
     * component that only passes `children` through cannot produce it: React
     * reuses the element it was handed.
     */
    function Churn() {
      const [, setN] = useState(0);
      bump = () => setN((n) => n + 1);
      return (
        <ChatProvider api={countingApi(counts)} timing={clock.timing}>
          <Probe />
        </ChatProvider>
      );
    }
    render(
      <ListeningProvider api={listeningApi as never}>
        <Churn />
      </ListeningProvider>,
    );
    await settle();
    await step(() => {
      chat.select(INSTANCE, INSTANCE);
    });
    // Waited for rather than assumed: opening a conversation is a roster read,
    // then a selection the roster's answer unblocks, then the transcript read —
    // a chain of promises the store resolves over several turns. What follows
    // measures reads *against this baseline*, so the baseline has to be the
    // finished open.
    await waitFor(() => expect(counts.history).toBeGreaterThan(0));
    await settle();
    const opened = { ...counts };
    expect(opened.swarms).toBeGreaterThan(0);

    // Ten rounds of everything that is not news: a render from above, and the
    // listening provider re-reading and being told the same set.
    for (let i = 0; i < 10; i++) {
      await step(() => {
        bump();
        window.dispatchEvent(new Event("focus"));
      });
    }
    expect(counts.swarms).toBe(opened.swarms);
    expect(counts.sessions).toBe(opened.sessions);
    expect(counts.history).toBe(opened.history);
  });
});

describe("a flapping page is not a poll", () => {
  /**
   * The live shape of the roster regression, reproduced: the pane the portal
   * was being watched in flapped hidden↔visible every couple of seconds, and
   * the "read on return" path answered every flap with a fleet-wide fan-out.
   *
   * The age gate keeps its shipped fifteen seconds and the clock is stepped
   * between flaps. What the gate does is compare two numbers, so a test that
   * steps those numbers measures it exactly.
   */
  test("thirty toggles in a minute cost the reads of one minute, not of thirty flaps", async () => {
    const counts: Counts = { swarms: 0, sessions: 0, history: 0 };
    render(
      <ChatProvider api={countingApi(counts)} timing={clock.timing}>
        <div />
      </ChatProvider>,
    );
    await settle();
    const opened = counts.swarms;
    for (let i = 0; i < 15; i++) {
      setPageHidden(true);
      await step(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await clock.advance(1_000);
      setPageHidden(false);
      await step(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await clock.advance(3_000);
    }
    // Sixty seconds of flapping: at most one read per RETURN_READ_MIN_AGE_MS,
    // and the roster tick has not come round once.
    expect(counts.swarms - opened).toBeLessThanOrEqual(Math.floor(60_000 / RETURN_READ_MIN_AGE_MS) + 1);
    // Three, not four: the mount's own read stamps the same cell, so the first
    // return inside fifteen seconds of it correctly reads nothing.
    expect(counts.swarms - opened).toBe(3);
  });
});
