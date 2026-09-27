/**
 * The chat store, held once per fleet across every chat frame (§9.2).
 *
 * Four things live here and nowhere else: the roster the rail draws, which bot
 * and session the operator is looking at, each conversation's transcript
 * and draft, and its independent live turn. The rules are not here — they are in `chat-logic.ts`,
 * pure, so "which origins need the banner" and "gold outranks orange" are
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
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
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
} from "../api/index.ts";
import type {
  ChatBlockView,
  ChatFrameView,
  ChatMessageView,
  SessionView,
  SwarmView,
} from "../api/index.ts";
import type { ConversationActivity, TurnActivity } from "./chat-activity.ts";
import { useConversations } from "./chat-conversations.ts";
import type { ChatArrival } from "./chat-conversations.ts";
export { reconnectDelayMs } from "./chat-conversations.ts";
export type { Observation, ObserveState } from "./chat-conversations.ts";
import type { Observation } from "./chat-conversations.ts";
import type { Destination, RailFilter, RailScope } from "./chat-logic.ts";
import { useListeningIfAvailable } from "../state/listening-state.tsx";
import { useNotifyIfAvailable } from "../state/notify-state.tsx";
import { isVisible, onReturnVisible, RETURN_READ_MIN_AGE_MS } from "../lib/visibility.ts";

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

/**
 * The cadences this store runs on, and the clock it runs them on, so a test
 * can own both.
 *
 * Every number here is minutes-to-seconds long, which is the point in a browser
 * and a problem in a test: asserting "this does not read for two minutes" means
 * either waiting two minutes or faking the clock, and a *process-wide* fake
 * clock held across `act()` behaves differently on different platforms. So the
 * clock is injected here instead of patched: a test hands in its own `now`,
 * `setTimeout` and `setInterval` (`test/fake-clock.ts`), steps them by hand,
 * and nothing React or Testing Library schedules is touched. The cadences stay
 * injectable too, for a test that wants a different shape rather than a
 * different clock.
 *
 * Absent or partial, every field falls back to the production constant above
 * or the platform timer, so the shipped tree behaves as if this option did not
 * exist.
 */
export interface ChatTiming {
  /** Roster re-read interval while the fleet is answering. */
  rosterIntervalMs: number;
  /** Roster re-read interval while the fleet is dark. */
  rosterRetryMs: number;
  /** How young the last roster read may be for a return to the tab to skip it. */
  returnReadMinAgeMs: number;
  /** How often an open named session re-reads its transcript. */
  transcriptTickMs: number;
  /**
   * The clock the age gate above reads.
   *
   * Injectable with the cadences because the two are one decision: a test that
   * shrinks `returnReadMinAgeMs` to milliseconds is measuring against real
   * scheduling jitter, while one that keeps the production age and steps this
   * clock by hand measures the gate itself, deterministically.
   */
  now: () => number;
  /**
   * The scheduler behind every timer this store arms, with `now` above.
   *
   * Both return the cancel, so an effect can `return timing.setInterval(...)`.
   * A test that hands in a fake clock (`test/fake-clock.ts`) steps *only* these
   * — React's own scheduling and Testing Library's `waitFor` stay on the real
   * clock, which is what a process-wide fake (`jest.useFakeTimers`) could not
   * promise: it patched the globals React's `act` parks on, and advanced them
   * on one platform and not another.
   */
  setTimeout: (fn: () => void, ms: number) => () => void;
  setInterval: (fn: () => void, ms: number) => () => void;
}

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

export interface ChatSelection {
  instance: string;
  bot: string;
  /** `null` means the bot's canonical session — the one an operator means. */
  session: string | null;
}

/**
 * One message typed while the agent was busy, waiting its turn.
 *
 * §9.2 gives a conversation one active turn and says sending waits, so the
 * composer keeps taking text while a turn runs and the portal holds it here.
 * The queue is this browser's, not the box's: nothing is sent, nothing is
 * persisted, and a reload loses it — which is the honest shape, because the box
 * has never heard of these and cannot be asked to remember them.
 */
export interface QueuedMessage {
  /** Local, monotonic, and only ever used to remove a row. */
  id: string;
  text: string;
  at: string;
}

/** One stable empty queue, so an idle conversation does not re-render on identity. */
const NO_QUEUE: QueuedMessage[] = [];

/** The queue's key. Same three fields the conversation store keys its records on. */
const queueKeyOf = (target: ChatSelection): string =>
  JSON.stringify([target.instance, target.bot, target.session]);

export interface Chat {
  /**
   * The cadences this store runs on, resolved.
   *
   * Carried on the context rather than passed down as props because the views
   * that own a tick of their own (`BotWorkspace`'s named-session poll) already
   * read this store, and a second channel for the same decision is a second
   * thing to keep in step.
   */
  timing: ChatTiming;
  swarms: SwarmView[];
  swarmsLoading: boolean;
  swarmsError: string | null;
  /** Every box in the fleet failed to answer. Necessary for "off the tailnet", not sufficient. */
  fleetUnreachable: boolean;
  /**
   * This laptop's own tailscale is unusable, as `doctor` reads it.
   *
   * The distinction this carries is the whole value of the pane it drives: "you
   * are not on the tailnet" and "that box did not answer" have completely
   * different fixes, and a portal that guessed between them would send an
   * operator to restart a box over a laptop that needed `tailscale up`. It is
   * only ever true once `local_tailscale.ok` has come back false — a silent
   * fleet on its own proves nothing about this machine.
   */
  offTailnet: boolean;
  /**
   * What is wrong with this machine's tailscale, in the preflight's own words
   * ("tailscale is installed but stopped; run `tailscale up`"). Null until the
   * read has come back. Never carries a secret — §8.3, and `problem` is
   * composed by `preflight.ts` from states, not from credentials.
   */
  tailnetDetail: string | null;
  /**
   * Read the roster now.
   *
   * Refused while the page is hidden — the read is a fan-out with one HTTPS
   * round trip per box and a background tab has no rail to keep fresh — and
   * the tab reads once when it comes back. `force` is for the caller that has
   * just changed the fleet and must see its own write regardless.
   */
  refreshSwarms: (options?: { force?: boolean }) => Promise<void>;

  scope: RailScope;
  setScope: (scope: RailScope) => void;
  filter: RailFilter;
  setFilter: (filter: RailFilter) => void;
  query: string;
  setQuery: (query: string) => void;

  selection: ChatSelection | null;
  select: (instance: string, bot: string, session?: string | null) => boolean;
  activate: () => void;
  draft: string;
  setDraft: (text: string) => void;
  stageDraft: (target: ChatSelection, text: string) => void;
  showThread: () => () => void;
  selectionError: string | null;

  sessions: SessionView[];
  /** The session being read, resolved from `selection`, the box, and the session list. */
  session: SessionView | null;
  /**
   * Where a reply would go, as far as this thread has actually established it.
   *
   * Not `session?.origin ?? "portal"`. `portal` is the one value that silences
   * the destination banner, so it has to be read rather than fallen back to —
   * `Destination` in `chat-logic.ts` has the argument.
   */
  destination: Destination;

  messages: ChatMessageView[];
  historyLoading: boolean;
  historyError: string | null;
  /** The transcript has been read at least once, so an empty list means empty. */
  historyRead: boolean;
  reloadHistory: () => Promise<void>;
  /**
   * The transcript alone, without the session list beside it. What a tick uses;
   * `reloadHistory` is what a gesture uses.
   */
  reloadTranscript: () => Promise<void>;

  /** The turn in flight, assembled from frames. Never persisted; see the header. */
  live: ChatMessageView | null;
  sending: boolean;
  /** The selected conversation’s observed work, independent of its transport lock. */
  activity: TurnActivity;
  /** Active local conversations, including those in background frames. */
  turnActivities: ConversationActivity[];
  /** The last turn's failure, cleared when the next one starts. */
  turnError: { code: string; message: string } | null;
  /**
   * This browser's stream to the portal dropped without a `done`, and the
   * transcript is being re-read. Core's own reconnect to the box (§9.2) never
   * shows up here — that turn is still streaming.
   */
  reconnecting: boolean;
  /** Which re-read is in flight, 1-based, for the band that says so. 0 when not. */
  reconnectAttempt: number;
  /**
   * What the portal's continuous watch on the selected conversation is doing
   * (§9.2). `live` draws nothing; the other two are bands.
   */
  observation: Observation;
  /** Ask a terminated observation back, deliberately, because the operator did. */
  resumeObservation: () => Promise<void>;
  send: (text: string) => void;
  abort: () => Promise<void>;

  /**
   * What the operator typed while this conversation's turn was in flight,
   * oldest first. Client-side and never persisted; see `QueuedMessage`.
   */
  queued: QueuedMessage[];
  /** Park a message behind the running turn. Ignored when there is no selection. */
  queueMessage: (text: string) => void;
  /** Take one back out of the queue, by its local id. */
  unqueue: (id: string) => void;
  /**
   * The queue is parked: it is holding rather than waiting for the turn to
   * end. Stopping, a failure, a dropped turn or leaving the thread parks one,
   * and a deliberate send releases it.
   */
  queueParked: boolean;

  /** A coarse clock, so every relative timestamp in one paint agrees with itself. */
  now: number;
}

/** The four calls, injectable so a DOM test can drive the provider without a fetch stub. */
export interface ChatApi {
  openConversation?: typeof chatOpen;
  fetchSwarms: typeof fetchSwarms;
  fetchSessions: typeof fetchSessions;
  fetchHistory: typeof fetchHistory;
  sendTurn: typeof sendTurn;
  abortTurn: typeof abortTurn;
  /**
   * `doctor`, for its `local_tailscale` field and nothing else.
   *
   * It is a heavy read — a whole fleet check — and it is called exactly once,
   * when every box in the fleet has already failed to answer. That is a state
   * the portal is in for minutes rather than seconds, so one AWS-backed read to
   * turn a guess into an answer is a good trade; calling it on a schedule would
   * not be. Optional so a test that is about the transcript need not answer it.
   */
  getDoctor?: typeof getDoctor;
  /**
   * The fan-in of every conversation this server observes (§9.2).
   *
   * Optional, and absent means "this tree does not watch anything" — which is
   * what a test about one transcript wants, and what the provider does when it
   * is mounted before the portal has a fleet to watch.
   */
  chatStream?: typeof chatStream;
  /**
   * `POST /api/chat/:instance/:bot/observe`: ask the server to hold *this*
   * conversation's observation again, after it ended.
   *
   * Optional for the same reason `chatStream` is — a tree with no fan-in has no
   * observation to ask back. It is deliberately not a write to
   * `PUT /api/chat/listening`, which reconciles every listened box: the listen
   * *preference* belongs to `listening-state.tsx`, and one operator asking for
   * one conversation back must not re-open every other one on the fleet.
   */
  resumeObservation?: typeof resumeObservation;
}

const LIVE_API: ChatApi = {
  openConversation: chatOpen,
  fetchSwarms,
  fetchSessions,
  fetchHistory,
  sendTurn,
  abortTurn,
  getDoctor,
  chatStream,
  resumeObservation,
};

const ChatContext = createContext<Chat | null>(null);

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
 * `request_id` is the whole key for an approval: one request, one card. A
 * clarify is a *batch* — `hermesRequest` in `hermes-chat-activity.ts` emits one
 * `question` block per entry in `payload.questions`, all of them under the same
 * request id — so the id alone would collapse a three-question batch into one
 * card. The prompt is what distinguishes them, and it is stable across a
 * replay because it is the question's own text. Two questions of one batch
 * that ask the same words in the same request do collapse; that is a batch
 * asking the same thing twice, and one card for it is not the wrong answer.
 */
function requestKey(block: ChatBlockView): string | null {
  if (block.kind !== "approval" && block.kind !== "question") return null;
  const id = block.request_id;
  if (typeof id !== "string" || id.length === 0) return null;
  return block.kind === "approval" ? `approval:${id}` : `question:${id}:${block.prompt}`;
}

/** The identity a block replaces on, or `null` for one that only ever appends. */
function blockKey(block: ChatBlockView): string | null {
  if (block.kind === "activity") return `activity:${block.key}`;
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

/** Folds one frame into the message being assembled. `error` is handled by the caller. */
export function applyFrame(
  live: ChatMessageView | null,
  frame: ChatFrameView,
  seed: { session: string; at: string },
): ChatMessageView | null {
  if (frame.type === "error") return live;
  const base: ChatMessageView =
    live ??
    ({
      id: frame.message,
      session: seed.session,
      role: "bot",
      author: null,
      at: seed.at,
      blocks: [],
      usage: null,
      error: null,
      incomplete: null,
    } as unknown as ChatMessageView);
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
  preview: string | null;
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
      const preview = bump.preview ?? bot.preview;
      if (bump.unread === 0 && at === bot.last_message_at && preview === bot.preview) return bot;
      touched = true;
      return { ...bot, unread: bot.unread + bump.unread, last_message_at: at, preview };
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
  const armTimeoutRef = useRef(armTimeout);
  armTimeoutRef.current = armTimeout;
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
  const [threadCount, setThreadCount] = useState(0);
  const showThread = useCallback(() => {
    setActive(true);
    setThreadCount((n) => n + 1);
    return () => setThreadCount((n) => n - 1);
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
  const [filter, setFilter] = useState<RailFilter>("all");
  const [query, setQuery] = useState("");
  /** `doctor`'s reading of this machine's own tailscale, once it has been asked. */
  const [localTailnet, setLocalTailnet] = useState<{ ok: boolean; detail: string } | null>(null);
  /** How many roster reads have completed, so the probe can re-examine an outage. */
  const [rosterReads, setRosterReads] = useState(0);
  /** Whether this tab is the one on screen; the roster tick is suspended when not. */
  const [visible, setVisible] = useState(() => !document.hidden);
  const [now, setNow] = useState(() => clock());

  useEffect(() => armInterval(() => setNow(clockRef.current()), CLOCK_MS), [armInterval]);

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

  const conversations = useConversations(api, refreshSwarms, applyFrame, instances, noteArrival);
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
    sending,
    activity,
    turnActivities,
    turnError,
    reconnecting,
    reconnectAttempt,
    observation,
    observe,
    observeDropped,
    observeTransport,
    resumeObservation,
    send,
    abort,
    reloadHistory,
    reloadTranscript,
    draft,
    setDraft,
    stageDraft,
  } = conversations;

  /* ── the send queue (§9.2 "one active turn", "sending waits") ───────────── */

  /**
   * Queued sends, per conversation, and every reason one does not go out.
   *
   * The queue is here rather than in the conversation record because a queued
   * message is not part of a turn: it has not been sent, the box has never
   * heard of it, and a turn that drops and reconnects must not resurrect one.
   * The store below owns turns; this owns the operator's backlog.
   *
   * `parked` is the other half of the rule, and four different things park a
   * queue: stopping a turn, a turn that failed, a turn that *dropped* and is
   * being re-read, and leaving the conversation. They are one judgement —
   * nothing goes out except into a conversation the operator is looking at,
   * which just finished a turn cleanly. Everything else keeps the rows and
   * waits to be told, and a deliberate send is what tells it.
   *
   * Nothing is ever removed on the way out. The store's `send` can refuse the
   * text it is handed — a conversation that is mid-abort, a box this tab is no
   * longer allowed to talk to — and it refuses by returning, so a queue that
   * dropped its head first would destroy the message with no row and no error.
   * `dispatched` holds the head until the turn it asked for actually starts.
   */
  const [queues, setQueues] = useState<ReadonlyMap<string, QueuedMessage[]>>(() => new Map());
  const parked = useRef<Set<string>>(new Set());
  /**
   * A counter, because `parked` is a ref and the composer has to say so.
   *
   * The set itself stays a ref: the drain reads it in the same tick it was
   * written in — stopping a turn parks it and the turn ending must already see
   * that — and a state read one render behind would drain the queue it was
   * meant to hold. This is what tells React the answer changed.
   */
  const [parkedAt, setParkedAt] = useState(0);
  const queueSeq = useRef(0);
  const park = useCallback((key: string) => {
    if (parked.current.has(key)) return;
    parked.current.add(key);
    setParkedAt((tick) => tick + 1);
  }, []);
  const unpark = useCallback((key: string) => {
    if (parked.current.delete(key)) setParkedAt((tick) => tick + 1);
  }, []);

  /** The head handed to the store and not yet seen to start a turn. */
  const dispatched = useRef<{ key: string; id: string } | null>(null);
  /** `sending` as of the last render, for the confirmation that runs off a timer. */
  const sendingNow = useRef(sending);
  sendingNow.current = sending;
  const queued = selection ? (queues.get(queueKeyOf(selection)) ?? NO_QUEUE) : NO_QUEUE;
  /**
   * The queue is held rather than waiting its turn, and the composer says so.
   *
   * Only meaningful with rows to hold: a parked conversation with nothing in
   * it is a park that will be dropped the next time anything touches it, and
   * announcing that would be announcing bookkeeping.
   */
  const queueParked = useMemo(
    // `parkedAt` is the dependency that matters: `parked` is a ref, so the
    // counter is the only thing that says its answer moved.
    () => queued.length > 0 && selection !== null && parked.current.has(queueKeyOf(selection)),
    [queued, selection, parkedAt],
  );

  /** Drop one row, and forget a conversation the moment it has no backlog left. */
  const dropQueued = useCallback((key: string, id: string) => {
    setQueues((previous) => {
      const held = previous.get(key);
      if (!held) return previous;
      const rest = held.filter((row) => row.id !== id);
      if (rest.length === held.length) return previous;
      const next = new Map(previous);
      if (rest.length === 0) {
        next.delete(key);
        parked.current.delete(key);
      } else next.set(key, rest);
      return next;
    });
  }, []);

  const queueMessage = useCallback(
    (text: string) => {
      const body = text.trim();
      if (!body || !selection) return;
      const id = `q${++queueSeq.current}`;
      const at = new Date().toISOString();
      const key = queueKeyOf(selection);
      setQueues((previous) => {
        const next = new Map(previous);
        next.set(key, [...(previous.get(key) ?? []), { id, text: body, at }]);
        return next;
      });
    },
    [selection],
  );

  const unqueue = useCallback(
    (id: string) => {
      if (!selection) return;
      dropQueued(queueKeyOf(selection), id);
    },
    [selection, dropQueued],
  );

  /**
   * One queued message goes out each time the conversation falls idle.
   *
   * One at a time and in order, because the box runs one turn per conversation
   * and a second `prompt.submit` mid-turn is a busy-mode interruption rather
   * than a second message.
   *
   * `reconnecting` is in the gate for a case that looks idle and is not: a turn
   * whose socket died ends with no error at all (`end(false, null)`), so
   * `sending` goes false, `turnError` stays null, and the transcript is being
   * re-read behind a band. Firing the backlog into that is how a queued message
   * lands in a conversation whose last turn nobody has read back yet.
   */
  useEffect(() => {
    if (dispatched.current || !selection || sending) return;
    const key = queueKeyOf(selection);
    if (turnError || reconnecting) {
      if (queues.get(key)?.length) park(key);
      return;
    }
    if (parked.current.has(key)) return;
    const head = queues.get(key)?.[0];
    if (!head) return;
    dispatched.current = { key, id: head.id };
    send(head.text);
    // The store reports nothing, so the turn starting is the receipt. A send it
    // refused leaves `sending` false through the next paint: keep the row, park
    // the queue, and let the operator decide rather than retrying into whatever
    // refused it.
    return armTimeoutRef.current(() => {
      if (dispatched.current?.id !== head.id) return;
      dispatched.current = null;
      if (!sendingNow.current) park(key);
    }, 0);
  }, [selection, sending, turnError, reconnecting, queues, send, park]);

  /** The turn started, so the message it was built from has left the queue. */
  useEffect(() => {
    const pending = dispatched.current;
    if (!pending || !sending) return;
    dispatched.current = null;
    dropQueued(pending.key, pending.id);
  }, [sending, dropQueued]);

  /**
   * Leaving a conversation parks its queue.
   *
   * The drain only ever runs for the conversation on screen — the store's
   * `send` addresses the selected one and nothing else — so a backlog left
   * behind is frozen either way. What this stops is the surprise on the way
   * back: rows queued twenty minutes ago firing by themselves because the
   * operator re-opened the thread to read it. They are still there, still
   * removable, and the next deliberate send releases them.
   */
  useEffect(() => {
    if (!selection) return;
    const key = queueKeyOf(selection);
    return () => {
      park(key);
      if (dispatched.current?.key === key) dispatched.current = null;
    };
  }, [selection, park]);

  /** A send the operator asked for un-parks the queue behind it. */
  const sendMessage = useCallback(
    (text: string) => {
      if (selection) {
        const key = queueKeyOf(selection);
        unpark(key);
        if (dispatched.current?.key === key) dispatched.current = null;
      }
      send(text);
    },
    [selection, send, unpark],
  );

  /** Stopping keeps the queue and parks it; nothing is dropped. */
  const stopTurn = useCallback(async () => {
    if (selection) park(queueKeyOf(selection));
    await abort();
  }, [selection, abort, park]);

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
  useEffect(() => {
    if (!setWatching) return;
    const report = (): void => {
      if (!selection || threadCount === 0) {
        setWatching(null);
        return;
      }
      setWatching({
        instance: selection.instance,
        bot: selection.bot,
        focused: isVisible() && document.hasFocus(),
      });
    };
    report();
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    document.addEventListener("visibilitychange", report);
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      document.removeEventListener("visibilitychange", report);
      setWatching(null);
    };
  }, [selection, setWatching, threadCount]);

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
      sending,
      activity,
      turnActivities,
      turnError,
      reconnecting,
      reconnectAttempt,
      observation,
      resumeObservation,
      send: sendMessage,
      abort: stopTurn,
      queued,
      queueMessage,
      unqueue,
      queueParked,
      now,
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
      sending,
      activity,
      turnActivities,
      turnError,
      reconnecting,
      reconnectAttempt,
      observation,
      resumeObservation,
      sendMessage,
      stopTurn,
      queued,
      queueMessage,
      unqueue,
      queueParked,
      now,
      chatTiming,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
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
