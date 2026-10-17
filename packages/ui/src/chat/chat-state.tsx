/**
 * The chat store, held once per fleet across every chat frame (§9.2).
 *
 * Four things live here and nowhere else: the roster the rail draws, which bot
 * and session the operator is looking at, each conversation's transcript
 * and draft, and its independent live turn. The rules are not here — they are in `chat-logic.ts`,
 * pure, so "which origins relabel the send button" and "gold outranks orange" are
 * testable without mounting a provider. The shape is `notify-state.tsx`'s:
 * a provider, injectable calls, and a `useChatIfAvailable()` for a tree that
 * has no provider.
 *
 * Two decisions here are not stylistic, and both come from the plan.
 *
 * **A turn is not an op (§9.2).** `useOp.ts` is not this module's hook and
 * `OpRegistry` is not involved. A turn is a live pipe to a process already
 * running elsewhere: one-shot SSE, nothing buffered on the server, and the only
 * way to observe one is to be attached while it happens. So the live turn is
 * assembled here, frame by frame, and it is *not* persisted anywhere.
 *
 * **The reconnect path re-reads and never merges (§9.2).** The box is
 * authoritative; anything this browser is holding is a cache that is allowed to
 * be wrong. When *this browser's* stream drops mid-turn the transcript is read
 * again from the box, whole, and the read *replaces* `messages` rather than
 * being folded into it. Merging the two would look like it works — which is
 * exactly why the risk register names it.
 *
 * A drop further down, between the portal and the box, is not this: core holds
 * a cursor on that socket and continues the turn from it (§9.2), which arrives
 * here as a replaceable status block on a turn that never ended. Only when core
 * runs out of ways to continue does it finish the turn `incomplete`, and that
 * is the ordinary settle this file already re-reads on.
 *
 * The half-built reply is the one thing that survives that read, and it is not
 * an exception to the rule: the reply is kept, marked incomplete. It stays in `live`, which is separate from the cache and drawn
 * as a turn that was cut off; the moment the box's own transcript comes back
 * carrying this reply (by stored ID or turn timestamp), the local copy is
 * dropped and the box's wins. Discarding it instead would throw away the only copy of an answer in
 * the case where the box never wrote one — and keeping it *in* `messages` would
 * be the merge the risk register forbids. It is neither.
 */
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { TargetScopeContext } from "./chat-target-scope.tsx";
import { chatForTarget } from "./chat-target-chat.ts";
import {
  chatOpen,
  abortTurn,
  chatStream,
  fetchHistory,
  fetchSessions,
  fetchSwarms,
  getDoctor,
  resumeObservation,
  sendTurn,
  steerSubagent,
  steerTurn,
  stopSubagent,
} from "../api/index.ts";
import type { ChatBlockView, ChatFrameView, ChatMessageView, SwarmView } from "../api/index.ts";
import { useConversations } from "./chat-conversations.ts";
import { useSendQueue } from "./chat-queue.ts";
import { NO_ATTACHMENTS } from "./chat-attachments.ts";
import type { SentAttachment } from "./chat-attachments.ts";
export type { QueuedMessage } from "./chat-queue.ts";
import type { ChatArrival } from "./chat-conversations.ts";
export { reconnectDelayMs } from "./chat-conversations.ts";
export type { Observation, ObserveState } from "./chat-conversations.ts";
import type { Destination, RailFilter, RailScope } from "./chat-logic.ts";
import { useListeningIfAvailable } from "../state/listening-state.tsx";
import { useNotifyIfAvailable } from "../state/notify-state.tsx";
import {
  isPageActive,
  isVisible,
  onReturnVisible,
  RETURN_READ_MIN_AGE_MS,
  subscribePageActive,
} from "../lib/visibility.ts";
import type { Chat, ChatApi, ChatSelection, ChatTiming } from "./chat-types.ts";
import { ChatContext, ChatStoreProvider } from "./chat-select.tsx";
export type { Chat, ChatApi, ChatSelection, ChatTiming } from "./chat-types.ts";

/** How often the relative timestamps in the rail are recomputed. */
const CLOCK_MS = 30_000;

/**
 * How often the roster is re-read while the fleet is answering.
 *
 * Not for freshness, though the rail gets that for free. It is what makes the
 * off-tailnet diagnosis able to fire at all: `fleetUnreachable` is derived from
 * the roster, so a laptop that drops off the tailnet *after* this view opened
 * would never re-evaluate it, and the operator would get five "Reconnecting…"
 * attempts and then a raw error instead of the pane that names the fix.
 *
 * The server's poller reads the same roster on its own two-minute tick for the
 * notification source (`CHAT_INTERVAL_MS` in `packages/app/src/poller.ts`).
 * The two are unsynchronised and that is accepted rather than engineered
 * around: a roster read takes no warm backend slot (§9.2), and the alternative
 * is shared state between a browser store and a server poller for the sake of
 * one HTTPS round trip per box every two minutes.
 */
const ROSTER_INTERVAL_MS = 120_000;

/**
 * How often it is re-read while *nothing* is answering.
 *
 * Faster, not slower, and the reason is a promise the no-route pane makes in as
 * many words: "this pane reconnects on its own". Something has to be asking for
 * that to be true, and the fleet is already dark, so there is nothing to be
 * polite to.
 */
const ROSTER_RETRY_MS = 15_000;

/**
 * How often an open *named* session re-reads its transcript.
 *
 * Lives here rather than beside the effect that arms it
 * (`components/chat/BotWorkspace.tsx`) so that every cadence this store owns is
 * one object a caller can replace — see `ChatTiming`.
 */
const TRANSCRIPT_TICK_MS = 5_000;

/** What `ChatTiming` is when nobody passes one. */
export const DEFAULT_CHAT_TIMING: ChatTiming = {
  rosterIntervalMs: ROSTER_INTERVAL_MS,
  rosterRetryMs: ROSTER_RETRY_MS,
  returnReadMinAgeMs: RETURN_READ_MIN_AGE_MS,
  transcriptTickMs: TRANSCRIPT_TICK_MS,
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  setInterval: (fn, ms) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },
};

/**
 * The longest a `doctor` answer about this machine's tailscale is trusted.
 *
 * The probe is "once per outage", but an outage is not a single condition: the
 * fleet can be dark because every box is stopped, and *then* the laptop can
 * drop off the tailnet without `fleetUnreachable` ever going false to reset
 * anything. So the answer expires. One full fleet check a minute while the
 * whole fleet is unreachable is a real cost, and it is the right one — the
 * operator is looking at a broken pane and the question it cannot answer is the
 * only thing they need.
 */
const TAILNET_PROBE_TTL_MS = 60_000;

export { ChatTargetScope } from "./chat-target-scope.tsx";

const LIVE_API: ChatApi = {
  openConversation: chatOpen,
  fetchSwarms,
  fetchSessions,
  fetchHistory,
  sendTurn,
  abortTurn,
  steerTurn,
  steerSubagent,
  stopSubagent,
  getDoctor,
  chatStream,
  resumeObservation,
};

export { ChatContext };

/* ── frame assembly ──────────────────────────────────────────────────────── */

/**
 * A block arriving for a tool that is already on screen replaces it rather than
 * appending a second card.
 *
 * Upstream sends a running tool and its completion as two separate blocks with
 * no frame type that *updates* one, so the head has to recognise the second as
 * the first one finishing. `tool_id` is the key when there is one; the tool's
 * name is the fallback, and the fallback is wrong the moment an agent makes two
 * parallel calls to the same tool — which the schema says in more words, and
 * which is accepted there as rendering badly rather than not at all.
 */
function toolKey(block: ChatBlockView): string | null {
  if (block.kind !== "tool") return null;
  const id = "tool_id" in block ? block.tool_id : null;
  return typeof id === "string" && id.length > 0 ? `id:${id}` : `name:${block.name}`;
}

/**
 * The key a redelivered server request lands on, so it updates its own card.
 *
 * `hermetic.server_request` frames are *unsequenced* — the box replays the
 * outstanding approval or clarify whenever a head attaches, and it carries no
 * sequence a reader could dedupe on. Without a key the replay appends a second
 * identical approval card, and the operator is asked the same question twice
 * with no way to tell which one is live.
 *
 * `request_id` is the whole key, for an approval and a clarify alike: one
 * request, one card. A clarify *batch* is one `question` block listing every
 * question in `questions`, and the gateway holds the turn until all of them
 * are answered — so they are answered together, on one card. Keying a batch
 * per question would draw a card per question that each looked answered on
 * its own while the turn still waited for the rest.
 */
function requestKey(block: ChatBlockView): string | null {
  if (block.kind !== "approval" && block.kind !== "question") return null;
  const id = block.request_id;
  if (typeof id !== "string" || id.length === 0) return null;
  return `${block.kind}:${id}`;
}

/**
 * The identity a block replaces on, or `null` for one that only ever appends.
 * A delegated child is re-sent whole on every change, so it replaces by its
 * own id (`subagent:<subagent_id>`).
 */
function blockKey(block: ChatBlockView): string | null {
  if (block.kind === "activity") return `activity:${block.key}`;
  if (block.kind === "subagent") return `subagent:${block.subagent_id}`;
  return toolKey(block) ?? requestKey(block);
}

function mergeBlock(blocks: ChatBlockView[], incoming: ChatBlockView): ChatBlockView[] {
  const key = blockKey(incoming);
  if (key === null) return [...blocks, incoming];
  const at = blocks.findIndex((b) => blockKey(b) === key);
  if (at === -1) return [...blocks, incoming];
  const next = [...blocks];
  next[at] = incoming;
  return next;
}

/**
 * A `delta` appends to the last `text` block, creating one when the turn has
 * opened with a tool call and no prose yet.
 */
function appendDelta(blocks: ChatBlockView[], text: string): ChatBlockView[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.kind === "text") {
      const next = [...blocks];
      next[i] = { ...block, markdown: block.markdown + text };
      return next;
    }
  }
  return [...blocks, { kind: "text", markdown: text } as ChatBlockView];
}

/**
 * Folds one frame into the message being assembled. An `error` sets the turn's
 * `failure` — core's structured one, else its code and message — minting the
 * message when the turn failed before saying anything, so the failure card is
 * drawn live from the same shape history gives it (`FailureCard`).
 */
export function applyFrame(
  live: ChatMessageView | null,
  frame: ChatFrameView,
  seed: { session: string; at: string },
): ChatMessageView | null {
  const base: ChatMessageView =
    live ??
    ({
      id: frame.type === "error" ? `failed:${seed.at}` : frame.message,
      session: seed.session,
      role: "bot",
      author: null,
      at: seed.at,
      blocks: [],
      usage: null,
      error: null,
      incomplete: null,
    } as unknown as ChatMessageView);
  if (frame.type === "error")
    return { ...base, failure: frame.failure ?? { code: frame.code, message: frame.message } };
  if (frame.type === "block") return { ...base, blocks: mergeBlock(base.blocks, frame.block) };
  if (frame.type === "delta") return { ...base, blocks: appendDelta(base.blocks, frame.text) };
  return { ...base, usage: frame.usage ?? base.usage, incomplete: frame.incomplete ?? null };
}

/* ── the rail, ahead of the roster ───────────────────────────────────────── */

/**
 * One bot's stream-delivered activity, held until a roster read covers it.
 *
 * `bot.unread` has exactly one source — the roster read, on its two-minute tick
 * — and the fan-in never touched it, so a message delivered over the stream
 * moved an open thread at once and the rail badge an operator actually scans up
 * to two minutes later. That is the wait this phase exists to remove, showing
 * up in the most visible surface in the view.
 *
 * So the increment is local and the roster read stays authoritative. `seq` is
 * what makes those two agree rather than fight: it is stamped from a counter,
 * and a roster read discards every bump stamped before the read *started*.
 * Anything that arrived while the read was in flight is kept, because the
 * answer now in hand was decided before it happened.
 */
interface RailBump {
  unread: number;
  at: string | null;
  /**
   * What the row quotes until the next roster read answers for it. `null` means
   * this bump has nothing to say about the words and the roster's stand.
   */
  preview: NonNullable<ChatArrival["preview"]> | null;
  seq: number;
}

const railKey = (instance: string, bot: string): string => `${instance}\u0000${bot}`;

/** The later of two timestamps, tolerating a null or an unparseable one. */
function newest(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left)) return b;
  if (Number.isNaN(right)) return a;
  return right > left ? b : a;
}

/** Fold the local bumps into the roster the rail draws. */
function withBumps(swarms: readonly SwarmView[], bumps: ReadonlyMap<string, RailBump>): SwarmView[] {
  if (bumps.size === 0) return swarms as SwarmView[];
  return swarms.map((swarm) => {
    let touched = false;
    const bots = swarm.bots.map((bot) => {
      const bump = bumps.get(railKey(swarm.instance, bot.name));
      if (!bump) return bot;
      const at = newest(bot.last_message_at, bump.at);
      if (bump.unread === 0 && at === bot.last_message_at && !bump.preview) return bot;
      touched = true;
      // A bump's quote moves the words and who wrote them together (`preview_role`).
      return { ...bot, ...bump.preview, unread: bot.unread + bump.unread, last_message_at: at };
    });
    return touched ? { ...swarm, bots } : swarm;
  });
}

/* ── the provider ────────────────────────────────────────────────────────── */

export function ChatProvider({
  children,
  api = LIVE_API,
  eager = true,
  timing,
}: {
  children: ReactNode;
  api?: ChatApi;
  eager?: boolean;
  /** Cadences, for a test that cannot wait two minutes. See `ChatTiming`. */
  timing?: Partial<ChatTiming>;
}) {
  const {
    rosterIntervalMs = DEFAULT_CHAT_TIMING.rosterIntervalMs,
    rosterRetryMs = DEFAULT_CHAT_TIMING.rosterRetryMs,
    returnReadMinAgeMs = DEFAULT_CHAT_TIMING.returnReadMinAgeMs,
    transcriptTickMs = DEFAULT_CHAT_TIMING.transcriptTickMs,
    now: clock = DEFAULT_CHAT_TIMING.now,
    setTimeout: armTimeout = DEFAULT_CHAT_TIMING.setTimeout,
    setInterval: armInterval = DEFAULT_CHAT_TIMING.setInterval,
  } = timing ?? {};
  const chatTiming = useMemo<ChatTiming>(
    () => ({
      rosterIntervalMs,
      rosterRetryMs,
      returnReadMinAgeMs,
      transcriptTickMs,
      now: clock,
      setTimeout: armTimeout,
      setInterval: armInterval,
    }),
    [
      rosterIntervalMs,
      rosterRetryMs,
      returnReadMinAgeMs,
      transcriptTickMs,
      clock,
      armTimeout,
      armInterval,
    ],
  );
  /** Read at call time, like `api`, so the readers below never churn on it. */
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const listening = useListeningIfAvailable();
  const instances = listening?.instances;
  const pending = listening?.pending;
  /** The injected calls, read at call time so this store's readers never churn. */
  const apiRef = useRef(api);
  apiRef.current = api;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const allowed = useRef(instances);
  allowed.current = instances;
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [active, setActive] = useState(eager);
  const activate = useCallback(() => setActive(true), []);
  const visibleThreads = useRef(new Map<symbol, ChatSelection | null>());
  const [threadCount, setThreadCount] = useState(0);
  const showThread = useCallback((target?: ChatSelection) => {
    const id = Symbol("chat view");
    visibleThreads.current.set(id, target ?? null);
    setActive(true);
    setThreadCount((n) => n + 1);
    return () => {
      visibleThreads.current.delete(id);
      setThreadCount((n) => n - 1);
    };
  }, []);
  const [roster, setSwarms] = useState<SwarmView[]>([]);
  /** Stream-delivered activity the roster has not caught up with yet; see `RailBump`. */
  const [bumps, setBumps] = useState<ReadonlyMap<string, RailBump>>(() => new Map());
  const bumpSeq = useRef(0);
  const swarms = useMemo(() => {
    const listed =
      instances === undefined ? roster : roster.filter((s) => instances.includes(s.instance));
    return withBumps(listed, bumps);
  }, [roster, instances, bumps]);
  /** When the roster last came back, shared with the return-to-visible read. */
  const rosterReadAt = useRef(0);
  const rosterGeneration = useRef(0);
  const rosterController = useRef<AbortController | null>(null);
  const [swarmsLoading, setSwarmsLoading] = useState(false);
  const [swarmsError, setSwarmsError] = useState<string | null>(null);
  const [scope, setScope] = useState<RailScope>({ kind: "all" });
  const [filter, setFilter] = useState<RailFilter>("unread");
  const [query, setQuery] = useState("");
  /** `doctor`'s reading of this machine's own tailscale, once it has been asked. */
  const [localTailnet, setLocalTailnet] = useState<{ ok: boolean; detail: string } | null>(null);
  /** How many roster reads have completed, so the probe can re-examine an outage. */
  const [rosterReads, setRosterReads] = useState(0);
  /** Whether this tab is the one on screen; the roster tick is suspended when not. */
  const [visible, setVisible] = useState(() => isVisible());
  const [now, setNow] = useState(() => clock());

  // The clock only drives relative times on screen, and every tick re-renders
  // whatever reads it, so it sits out a page nobody is looking at (inactive:
  // hidden, or not the window in front — `lib/visibility.ts`) and catches up
  // the moment the page is back rather than waiting out the interval.
  useEffect(() => {
    const tick = (): void => setNow(clockRef.current());
    const stopTicking = armInterval(() => {
      if (isPageActive()) tick();
    }, CLOCK_MS);
    const stopWatching = subscribePageActive((active) => {
      if (active) tick();
    });
    return () => {
      stopWatching();
      stopTicking();
    };
  }, [armInterval]);

  /**
   * Every roster read, whoever asked for it, goes through one visibility gate.
   *
   * The tick below suspends itself while the page is hidden, but it was never
   * the only caller: a mount, a listening change, a `online` event and each of
   * this pane's own mutations all call here, and an effect whose dependency is
   * rebuilt on render turns any of them into a poll. Gating the *read* rather
   * than each of its callers is what makes "nothing sweeps the tailnet for a
   * tab nobody is looking at" a property of the store instead of a rule five
   * call sites have to keep remembering. The debt is not dropped: coming back
   * to the tab reads immediately (`onVisible`).
   *
   * It is also identity-stable for the life of this provider, which is the
   * other half of the same rule: this function is the dependency of the effect
   * that reads on wake, of the tick, and of three listeners, so a rebuilt
   * `refreshSwarms` *is* a roster read per render. The calls are therefore
   * reached through a ref rather than closed over, and the dependency list is
   * empty by construction instead of by luck.
   */
  const refreshSwarms = useCallback(async (options?: { force?: boolean }) => {
    // `isVisible`, not `document`: in the app the webview says "hidden" for
    // the life of the window, so the head's own answer is the only true one
    // (`lib/visibility.ts`). The same helper gates the tick and the rest of the
    // chat surface (`BotWorkspace`'s transcript tick, `RoomConversation`'s).
    if (!options?.force && !isVisible()) return;
    const gen = ++rosterGeneration.current;
    rosterController.current?.abort();
    if (pendingRef.current?.length) {
      setSwarmsLoading(false);
      return;
    }
    if (allowed.current?.length === 0) {
      setSwarms([]);
      setSwarmsLoading(false);
      setSwarmsError(null);
      return;
    }
    const controller = new AbortController();
    rosterController.current = controller;
    // Everything stamped up to here is about to be answered for by the read
    // below; anything stamped after it happened while the read was in flight
    // and the answer cannot include it. See `RailBump`.
    const mark = bumpSeq.current;
    setSwarmsLoading(true);
    try {
      const result = await apiRef.current.fetchSwarms({}, controller.signal);
      if (gen !== rosterGeneration.current) return;
      setSwarms(
        result.swarms.filter(
          (s) => allowed.current === undefined || allowed.current.includes(s.instance),
        ),
      );
      setBumps((previous) => {
        if (previous.size === 0) return previous;
        const kept = new Map([...previous].filter(([, bump]) => bump.seq > mark));
        return kept.size === previous.size ? previous : kept;
      });
      setSwarmsError(null);
    } catch (e: unknown) {
      if (gen !== rosterGeneration.current) return;
      setSwarmsError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === rosterGeneration.current) {
        // Every completed read stamps the same cell the return-to-visible path
        // consults, so a read this store just made is one a return will reuse.
        rosterReadAt.current = clockRef.current();
        setSwarmsLoading(false);
        // Every completed read, answered or not. The tailnet probe below is keyed
        // on this rather than on `fleetUnreachable` alone, so that a condition
        // which changes *under* a continuing outage still gets re-examined.
        setRosterReads((n) => n + 1);
      }
    }
  }, []);

  useLayoutEffect(() => {
    rosterGeneration.current += 1;
    rosterController.current?.abort();
    setSelectionError(null);
    setSwarms((previous) =>
      instances === undefined ? previous : previous.filter((s) => instances.includes(s.instance)),
    );
    setScope((previous) =>
      previous.kind === "instance" && instances !== undefined && !instances.includes(previous.instance)
        ? { kind: "all" }
        : previous,
    );
    return () => {
      rosterGeneration.current += 1;
      rosterController.current?.abort();
    };
  }, [instances]);

  /**
   * The roster is read when this store wakes up, and when the set of listened
   * boxes or the set of pending listening writes *changes*.
   *
   * Keyed on the contents of those two sets rather than on the arrays
   * themselves. Both are rebuilt by their provider — `instances` is a `filter`
   * inside a memo — so one re-render up there hands this effect a new
   * dependency for an unchanged answer, and this effect's body is a fleet-wide
   * fan-out over the tailnet. A string of what the sets contain is the thing
   * the effect actually cares about, and it cannot churn.
   */
  const listenedKey = instances === undefined ? "*" : instances.join("\u0000");
  const pendingKey = pending === undefined ? "" : pending.join("\u0000");
  useEffect(() => {
    if (active) void refreshSwarms();
  }, [refreshSwarms, active, listenedKey, pendingKey]);

  /**
   * The roster is re-read on a schedule, and this is not about freshness.
   *
   * It is what lets the off-tailnet diagnosis fire at all after the view is
   * open. The browser's own hop to the portal is loopback and keeps working
   * when the tailnet does not, so a laptop that drops off it mid-session shows
   * up here exactly as it should: the next roster read comes back with every
   * box `reachable: false`, `fleetUnreachable` goes true, and the probe runs.
   * Without a tick nothing re-derives that, and the operator gets a reconnect
   * loop and a raw error instead of the pane naming the fix.
   *
   * Faster while the fleet is dark than while it is answering, because the
   * no-route pane says "this pane reconnects on its own" and something has to
   * make that true.
   */
  const darkRef = useRef(false);
  useEffect(() => {
    /**
     * Nothing ticks for a tab nobody is looking at.
     *
     * This read is a fan-out over the tailnet, one HTTPS round trip per box, and
     * a background tab left open on the chat view has no rail to keep fresh and
     * no pane to reconnect. The `chat.message` source does not depend on this —
     * it is the server poller's tick (`CHAT_INTERVAL_MS`), which runs whether or
     * not a browser is pointed at the portal — so suspending here costs the
     * operator nothing and saves a fleet-wide sweep every two minutes per idle
     * tab. Coming back to the tab reads immediately rather than waiting out an
     * interval, below.
     */
    if (!visible || !active) return;
    return armInterval(() => void refreshSwarms(), darkRef.current ? rosterRetryMs : rosterIntervalMs);
    // `rosterReads` rather than `fleetUnreachable`: the cadence has to be
    // re-chosen after each read, and `fleetUnreachable` is derived further down
    // this component than an effect can be hoisted to.
  }, [refreshSwarms, rosterReads, visible, active, rosterIntervalMs, rosterRetryMs, armInterval]);

  /**
   * Coming back to the tab reads the roster — once per return, not per event.
   *
   * The tick above is suspended while the page is hidden, so this is what makes
   * a tab that has been in the background for an hour current again. It is also
   * the one path that was measured turning into a two-second poll against a
   * live portal: an embedded browser pane flaps hidden↔visible while it is
   * being captured, and every visible half used to be a fleet-wide fan-out.
   * `onReturnVisible` is where "a return is a transition, and a read has a
   * minimum age" is decided, for this read and every other one like it.
   *
   * `setVisible` still follows every event, because it gates the tick and the
   * tick is the thing that must stop the moment the page goes away.
   */
  useEffect(() => {
    const track = (): void => setVisible(isVisible());
    document.addEventListener("visibilitychange", track);
    const stop = onReturnVisible(
      () => {
        if (active) void refreshSwarms();
      },
      // The clock through its ref, like `api`: a caller that rebuilds the
      // `timing` object on every render must not cost this listener a
      // re-registration, and nothing here reads it except at event time.
      { lastReadAt: rosterReadAt, minAgeMs: returnReadMinAgeMs, now: () => clockRef.current() },
    );
    return () => {
      document.removeEventListener("visibilitychange", track);
      stop();
    };
  }, [refreshSwarms, active, returnReadMinAgeMs]);

  /**
   * Waking from sleep, or a network coming back.
   *
   * Marginal here rather than central — the portal is reached over loopback, so
   * `online` says nothing about the tailnet — but a laptop that has just woken
   * is the common way to arrive at a fleet that has been unreachable for hours,
   * and asking immediately beats waiting out an interval.
   */
  useEffect(() => {
    const again = (): void => {
      if (active) void refreshSwarms();
    };
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, [refreshSwarms, active]);

  /**
   * A message arrived on the fan-in for some bot: move the rail now.
   *
   * The count is additive on top of whatever the last roster read said, and the
   * next roster read prunes it — so this never replaces the authoritative
   * number, only leads it. Not a notification: `notify-state.tsx` keeps its one
   * producer (`fleet.subscribeNotifications`) and one message still makes
   * exactly one toast.
   */
  const noteArrival = useCallback((arrival: ChatArrival) => {
    const id = railKey(arrival.instance, arrival.bot);
    const seq = ++bumpSeq.current;
    setBumps((previous) => {
      const held = previous.get(id);
      const next = new Map(previous);
      next.set(id, {
        unread: (held?.unread ?? 0) + (arrival.unread ? 1 : 0),
        at: newest(held?.at, arrival.at),
        // An arrival that quotes nothing keeps whatever the last one quoted;
        // the roster read is what clears both, by discarding the bump.
        preview: arrival.preview ?? held?.preview ?? null,
        seq,
      });
      return next;
    });
  }, []);

  const selectedForVisibility = useRef<ChatSelection | null>(null);
  const isThreadShown = useCallback((instance: string, bot: string) => {
    if (!isVisible() || !document.hasFocus()) return false;
    for (const target of visibleThreads.current.values()) {
      const showing = target ?? selectedForVisibility.current;
      if (showing?.instance === instance && showing.bot === bot) return true;
    }
    return false;
  }, []);
  const conversations = useConversations(
    api,
    refreshSwarms,
    applyFrame,
    instances,
    noteArrival,
    isThreadShown,
  );
  const {
    selection,
    sessions,
    sessionsState,
    sessionsError,
    resolvedSession,
    messages,
    historyLoading,
    historyError,
    historyRead,
    live,
    context,
    sending,
    remoteBusy,
    activity,
    turnActivities,
    turnError,
    released,
    turnPrompts,
    reconnecting,
    reconnectAttempt,
    observation,
    observe,
    observeDropped,
    observeTransport,
    resumeObservation,
    send,
    steer,
    settleRequest,
    releaseRequest,
    openRequest,
    abort,
    reloadHistory,
    reloadTranscript,
    draft,
    setDraft,
    stageDraft,
    subagents,
  } = conversations;
  selectedForVisibility.current = selection;

  /* ── the send queue (§9.2 "one active turn", "sending waits"), `chat-queue.ts` ── */
  const sendSelected = useCallback(
    (text: string, files?: readonly SentAttachment[]) => send(text, undefined, files),
    [send],
  );
  const {
    queued,
    queueMessage,
    unqueue,
    queueParked,
    sendMessage,
    stopTurn,
    sendNow,
    sendQueuedNow,
    forTarget: queueForTarget,
    watch: watchQueueTarget,
  } = useSendQueue({
    selection,
    sending,
    remoteBusy,
    turnError,
    reconnecting,
    send: sendSelected,
    abort,
    steer,
    stateFor: (target) => {
      const record = conversations.view(target);
      return {
        sending: record.sending,
        remoteBusy: record.remoteBusy,
        turnError: record.turnError,
        reconnecting: record.reconnecting,
      };
    },
    sendTo: (text, target, files) => conversations.send(text, target, files),
    abortTo: (target) => conversations.abort(target),
    steerTo: (text, target) => conversations.steer(text, target),
  });

  /**
   * Opening a thread retracts the badge this browser raised for it.
   *
   * Only the local half: the roster's own count is the box's to clear, on its
   * own schedule. But a bump added here because nobody was looking is one this
   * store can honestly take back the moment somebody is, and leaving it up for
   * the rest of the two-minute tick would be a badge on the conversation
   * already on screen.
   */
  useEffect(() => {
    if (!selection) return;
    const id = railKey(selection.instance, selection.bot);
    setBumps((previous) => {
      const held = previous.get(id);
      if (!held || held.unread === 0) return previous;
      const next = new Map(previous);
      next.set(id, { ...held, unread: 0 });
      return next;
    });
  }, [selection]);
  /**
   * The portal's one chat subscription (§9.2).
   *
   * One socket for every conversation this server observes, opened once for as
   * long as this provider is mounted — which is once per portal session, and
   * once per fleet, because `App` keys the provider on the fleet's identity and
   * a §4.8 switch therefore remounts it with an empty store. There is no
   * per-view subscribe and no restart when a bot starts being listened to: the
   * server answers `PUT /api/chat/listening` only once the observation exists,
   * so the fan-in carries a newly listened bot on the socket already open.
   *
   * It is not gated on the chat view being open. A transcript that only catches
   * up while somebody is looking at it is the two-minute wait this phase exists
   * to remove.
   */
  const stream = api.chatStream;
  useEffect(() => {
    if (!stream) return;
    return stream({
      onFrame: observe,
      onDropped: observeDropped,
      onConnected: observeTransport,
    });
  }, [stream, observe, observeDropped, observeTransport]);

  const select = useCallback(
    (instance: string, bot: string, session: string | null = null) => {
      if (allowed.current !== undefined && !allowed.current.includes(instance)) {
        setSelectionError(`Listen to ${instance} on the fleet screen to open its chat.`);
        return false;
      }
      setSelectionError(null);
      setActive(true);
      return conversations.select(instance, bot, session);
    },
    [conversations.select, instances],
  );

  useEffect(() => {
    if (selection || swarms.length === 0) return;
    const swarm = swarms.find((s) => s.reachable && s.bots.length > 0);
    const bot = swarm?.bots.find((b) => b.is_default) ?? swarm?.bots[0];
    if (swarm && bot) select(swarm.instance, bot.name);
  }, [swarms, selection, select]);

  /**
   * The session this thread is addressed to: the operator's explicit pick when
   * there is one, otherwise the one the box said it answered from.
   */
  const activeSessionId = selection?.session ?? resolvedSession;

  const session = useMemo(() => {
    if (!activeSessionId) return null;
    return sessions.find((s) => s.id === activeSessionId) ?? null;
  }, [activeSessionId, sessions]);

  /**
   * Where a reply goes, and how sure the thread is.
   *
   * The order of these branches is the safety property. Anything short of "the
   * box listed this session and here is its origin" is *not* `portal`, because
   * `portal` is the value that turns the warning off.
   */
  const destination = useMemo<Destination>(() => {
    if (sessionsState === "failed") {
      return { state: "unknown", reason: sessionsError ?? "The session list could not be read." };
    }
    if (sessionsState === "pending" || !historyRead) return { state: "pending" };
    // A bot the box lists no sessions for has no foreign session to answer into:
    // a turn from here creates one, and it is this portal's. That is the one
    // place `portal` may be concluded rather than read.
    if (sessions.length === 0 && !activeSessionId) {
      return { state: "known", origin: "portal", detail: null };
    }
    // The box listed conversations but named none as the one it answered from,
    // which is what a bot with no canonical session looks like. Not an error,
    // and not `portal` either: the operator has to say which one.
    if (!activeSessionId) return { state: "unchosen", count: sessions.length };
    if (!session) {
      return {
        state: "unknown",
        reason: "The box named a session it then did not list.",
      };
    }
    return { state: "known", origin: session.origin, detail: session.origin_detail ?? null };
  }, [sessionsState, sessionsError, historyRead, sessions.length, activeSessionId, session]);

  /**
   * Every box in the fleet failed to answer.
   *
   * Said only once there is something to say it about: an empty roster is "not
   * read yet", and reporting "no route to the tailnet" over a read that has not
   * come back is the kind of wrong that sends an operator to fix their laptop.
   *
   * On its own this is a *symptom*, not a diagnosis. Thirteen boxes that are all
   * stopped look identical from here to a laptop that is off the tailnet, and
   * the two have nothing in common except the silence.
   */
  const fleetUnreachable = swarms.length > 0 && swarms.every((s) => !s.reachable);

  /**
   * Which of the two it is, asked rather than guessed.
   *
   * hermetic can tell them apart, and it is worth saying exactly how, because
   * the answer was not obvious. `doctor` runs `preflight.ts`'s
   * `probeLocalTailscale` — `tailscale status --json` on *this machine*, three
   * second timeout — and reports it as `local_tailscale`: `ok` false with a
   * `detail` that already names the state and the fix ("tailscale is installed
   * but stopped; run `tailscale up`"), including the cases where the binary is
   * missing, the daemon is wedged, or the tailnet has MagicDNS or HTTPS
   * certificates switched off. That is a read of the laptop and says nothing
   * about any box, which is exactly the half `CHAT_UNREACHABLE` cannot answer:
   * the transport code means "hermetic asked the box and the box did not
   * answer", and it means that whether the silence started at this end or the
   * other.
   *
   * It is asked once per outage rather than polled. The read is a whole fleet
   * check and this is a state the portal sits in for minutes; one round trip to
   * replace a guess with an answer is worth it, and a schedule of them would
   * not be. A roster read that comes back with a reachable box clears it, so the
   * next outage asks again.
   */
  const probedAtRef = useRef(0);
  useEffect(() => {
    const ask = api.getDoctor;
    if (!fleetUnreachable) {
      probedAtRef.current = 0;
      setLocalTailnet(null);
      return;
    }
    if (!ask) return;
    /**
     * Once per outage, where an outage is a stretch of time and not a single
     * condition. A latch that reset only when a box answered would wedge shut
     * exactly where it is needed: the fleet goes dark because the boxes are
     * stopped, the probe runs and says the laptop is fine, and *then* the
     * laptop drops off the tailnet — with nothing ever asking again, because
     * `fleetUnreachable` never went false in between. So the answer expires.
     */
    if (probedAtRef.current !== 0 && clockRef.current() - probedAtRef.current < TAILNET_PROBE_TTL_MS)
      return;
    probedAtRef.current = clockRef.current();
    let live = true;
    void ask()
      .then((report) => {
        if (!live) return;
        setLocalTailnet({
          ok: report.local_tailscale.ok,
          detail: report.local_tailscale.detail,
        });
      })
      .catch(() => {
        /**
         * A `doctor` that could not run leaves the question open, and an open
         * question must read as "that box did not answer" rather than as "you
         * are off the tailnet": the second is a claim about the operator's own
         * machine, and making it on no evidence is how a portal sends somebody
         * to fix something that was never broken.
         */
        if (live) setLocalTailnet(null);
      });
    return () => {
      live = false;
    };
  }, [api, fleetUnreachable, rosterReads]);

  // Read by the roster interval above, which is declared before this value
  // exists and must not be re-registered on every render to see it.
  darkRef.current = fleetUnreachable;

  const offTailnet = fleetUnreachable && localTailnet !== null && !localTailnet.ok;
  const tailnetDetail = localTailnet === null ? null : localTailnet.detail;

  /**
   * Tell the inbox which conversation is on screen (§4.9).
   *
   * This provider is the only thing that knows, and the inbox is the only thing
   * that needs it — a reply landing in the thread the operator is reading is
   * not something to interrupt them about. The direction is deliberate: chat
   * reaches up to the inbox, which is mounted for the whole page. Mounted
   * chat frames register their visibility separately: the persistent store
   * alone is not evidence that the operator can see its selected thread.
   *
   * `focused` is recomputed on every focus, blur and visibility change, because
   * a chat view left open behind an editor is not somebody watching a
   * conversation, and treating it as one would drop exactly the notifications
   * they went to the other window in order to be told about. The cleanup clears
   * the fact rather than leaving it stale, so hiding the final visible frame
   * re-enables every toast it was suppressing.
   */
  const notify = useNotifyIfAvailable();
  const setWatching = notify?.setWatching;
  const setWatchingThreads = notify?.setWatchingThreads;
  useEffect(() => {
    if (!setWatching && !setWatchingThreads) return;
    const report = (): void => {
      if (threadCount === 0) {
        if (setWatchingThreads) setWatchingThreads([]);
        else setWatching?.(null);
        return;
      }
      const targets = [...visibleThreads.current.values()]
        .map((target) => target ?? selection)
        .filter((target): target is ChatSelection => target !== null);
      const unique = new Map(targets.map((target) => [`${target.instance}/${target.bot}`, target]));
      const focused = isVisible() && document.hasFocus();
      const showing = [...unique.values()].map((target) => ({
        instance: target.instance,
        bot: target.bot,
        focused,
      }));
      if (setWatchingThreads) setWatchingThreads(showing);
      else setWatching?.(showing[0] ?? null);
    };
    report();
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    document.addEventListener("visibilitychange", report);
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      document.removeEventListener("visibilitychange", report);
      if (setWatchingThreads) setWatchingThreads([]);
      else setWatching?.(null);
    };
  }, [selection, setWatching, setWatchingThreads, threadCount]);

  const selectedAttachments = selection
    ? conversations.attachments.forTarget(selection)
    : NO_ATTACHMENTS;
  const value = useMemo<Chat>(
    () => ({
      timing: chatTiming,
      activate,
      draft,
      setDraft,
      stageDraft,
      showThread,
      selectionError,
      swarms,
      swarmsLoading,
      swarmsError,
      fleetUnreachable,
      offTailnet,
      tailnetDetail,
      refreshSwarms,
      scope,
      setScope,
      filter,
      setFilter,
      query,
      setQuery,
      selection,
      select,
      sessions,
      session,
      destination,
      messages,
      historyLoading,
      historyError,
      historyRead,
      reloadHistory,
      reloadTranscript,
      live,
      context,
      sending,
      remoteBusy,
      activity,
      turnActivities,
      turnError,
      released,
      turnPrompts,
      reconnecting,
      reconnectAttempt,
      observation,
      resumeObservation,
      send: (text, files) => sendMessage(text, undefined, files),
      abort: stopTurn,
      stopTarget: (target) =>
        conversations.view(target).sending ? queueForTarget(target).stopTurn() : Promise.resolve(),
      settleRequest,
      releaseRequest,
      openRequest,
      queued,
      queueMessage: (text, files) => queueMessage(text, undefined, files),
      unqueue,
      sendNow: (text, files) => sendNow(text, undefined, files),
      sendQueuedNow,
      queueParked,
      now,
      subagents,
      attachments: selectedAttachments,
    }),
    [
      activate,
      draft,
      setDraft,
      stageDraft,
      showThread,
      selectionError,
      swarms,
      swarmsLoading,
      swarmsError,
      fleetUnreachable,
      offTailnet,
      tailnetDetail,
      refreshSwarms,
      scope,
      filter,
      query,
      selection,
      select,
      sessions,
      session,
      destination,
      messages,
      historyLoading,
      historyError,
      historyRead,
      reloadHistory,
      reloadTranscript,
      live,
      context,
      sending,
      remoteBusy,
      activity,
      turnActivities,
      turnError,
      released,
      turnPrompts,
      reconnecting,
      reconnectAttempt,
      observation,
      resumeObservation,
      sendMessage,
      stopTurn,
      queueForTarget,
      conversations.view,
      settleRequest,
      releaseRequest,
      openRequest,
      queued,
      queueMessage,
      unqueue,
      sendNow,
      sendQueuedNow,
      queueParked,
      now,
      chatTiming,
      subagents,
      selectedAttachments,
    ],
  );

  const showScopedThread = useCallback(
    (target: ChatSelection) => {
      const hide = showThread(target);
      const stopWatchingQueue = watchQueueTarget(target);
      return () => {
        stopWatchingQueue();
        hide();
      };
    },
    [showThread, watchQueueTarget],
  );
  const targetChat = (target: ChatSelection, onSelect?: (target: ChatSelection) => void): Chat =>
    chatForTarget(value, conversations, queueForTarget, target, onSelect);
  return (
    <TargetScopeContext.Provider
      value={{ chat: targetChat, ensure: conversations.ensure, showThread: showScopedThread }}
    >
      <ChatContext.Provider value={value}>
        <ChatStoreProvider value={value}>{children}</ChatStoreProvider>
      </ChatContext.Provider>
    </TargetScopeContext.Provider>
  );
}

export function useChat(): Chat {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used inside <ChatProvider>");
  return ctx;
}

/**
 * The chat store when this tree has a provider, `null` when it does not — the
 * same shape as `useFleetIfAvailable` and `useNotifyIfAvailable`, and for the
 * same reason: `App` is rendered in tests that are about the fleet and have no
 * business opening a roster read.
 */
export function useChatIfAvailable(): Chat | null {
  return useContext(ChatContext);
}
