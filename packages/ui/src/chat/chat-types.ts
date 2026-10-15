/**
 * The chat store's public shapes (`chat-state.tsx`): what a consumer reads
 * (`Chat`), what a test injects (`ChatApi`, `ChatTiming`), and the address of
 * one conversation (`ChatSelection`). Types only; `chat-state.tsx` re-exports
 * every one, so importers may name either module.
 */
import type {
  abortTurn,
  chatOpen,
  chatStream,
  ChatMessageView,
  fetchHistory,
  fetchSessions,
  fetchSwarms,
  getDoctor,
  resumeObservation,
  sendTurn,
  SessionView,
  steerSubagent,
  steerTurn,
  stopSubagent,
  SwarmView,
} from "../api/index.ts";
import type { ConversationActivity, TurnActivity } from "./chat-activity.ts";
import type { Observation } from "./chat-observation.ts";
import type { QueuedMessage } from "./chat-queue.ts";
import type { AttachmentsApi, AttachmentsControl, SentAttachment } from "./chat-attachments.ts";
import type { TurnPrompt } from "./chat-conversation-record.ts";
import type { SubagentControls } from "./chat-subagent-control.ts";
import type { Destination, RailFilter, RailScope } from "./chat-logic.ts";
import type { ContextReading } from "./context-usage.ts";

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
 * Absent or partial, every field falls back to the production constant
 * (`DEFAULT_CHAT_TIMING`, `chat-state.tsx`) or the platform timer, so the
 * shipped tree behaves as if this option did not exist.
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

export interface ChatSelection {
  instance: string;
  bot: string;
  /** `null` means the bot's canonical session — the one an operator means. */
  session: string | null;
}

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
  showThread: (target?: ChatSelection) => () => void;
  selectionError: string | null;

  sessions: SessionView[];
  /** The session being read, resolved from `selection`, the box, and the session list. */
  session: SessionView | null;
  /**
   * Where a reply would go, as far as this thread has actually established it.
   *
   * Not `session?.origin ?? "portal"`. `portal` is the one value that silences
   * the composer's destination restatement (send label and footer), and an
   * unread destination disables sending, so it has to be read rather than
   * fallen back to —
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
  /**
   * The conversation's newest context-window figure, held on its record
   * because the box's stored rows carry none (`Conversation.context`).
   */
  context: ContextReading | null;
  sending: boolean;
  /** The selected conversation’s observed work, independent of its transport lock. */
  activity: TurnActivity;
  /** Active local conversations, including those in background frames. */
  turnActivities: ConversationActivity[];
  /** The last turn's failure, cleared when the next one starts. */
  turnError: { code: string; message: string } | null;
  /** Requests answered from their own card, which no longer wait on anyone (`chat-requests.ts`). */
  released: ReadonlySet<string>;
  /** The prompt that started each turn seen failing here, by failed message id (`FailureCard`). */
  turnPrompts: ReadonlyMap<string, TurnPrompt>;
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
  /**
   * Start a turn; `false` when the store refused to, and nothing was sent.
   * `attachments` are files already staged on the box (`chat-attachments.ts`);
   * with any, `text` may be empty.
   */
  send: (text: string, attachments?: readonly SentAttachment[]) => boolean;
  abort: () => Promise<void>;
  /** Stop the turn shown in a particular dock pane. */
  stopTarget: (target: ChatSelection) => Promise<void>;
  /**
   * Close a server request's card: a finished notice for `request_id` folded
   * into the message that holds the card, as a `request.cancel` would be. The
   * composer calls it once the box has acknowledged a declined clarify, because
   * the gateway sends no close after an ordinary answer. `target` is the
   * conversation the decline was made in, when the selection may have moved
   * since. See `chat-conversations.ts`.
   */
  settleRequest: (request_id: string, outcome: "skipped" | "answered", target?: ChatSelection) => void;
  /**
   * Stop counting `request_id` as one the turn is parked on, without closing
   * its card: the operator answered it from the card, which stays as its
   * settled summary. Re-arms the no-frame timer; `openRequest` no longer names
   * it. See `chat-conversations.ts`.
   */
  releaseRequest: (request_id: string, target?: ChatSelection) => void;
  /**
   * The clarify the selected conversation is waiting on, by request id, or
   * `null` — across the live message and the parts of the reply a steer closed
   * off, the same scope `settleRequest` closes in. Read at call time.
   */
  openRequest: () => string | null;

  /**
   * What the operator typed while this conversation's turn was in flight,
   * oldest first. Client-side and never persisted; see `QueuedMessage`.
   */
  queued: QueuedMessage[];
  /** Park a message behind the running turn. Ignored when there is no selection. */
  queueMessage: (text: string, attachments?: readonly SentAttachment[]) => void;
  /** Take one back out of the queue, by its local id. */
  unqueue: (id: string) => void;
  /**
   * Send this now rather than queue it: steered into the running turn, or, if
   * the box will not take a steer, sent once that turn is stopped. An ordinary
   * send when nothing is running. See `chat-queue.ts`. `false` when nothing
   * took the message, so the caller can give it back.
   */
  sendNow: (text: string, attachments?: readonly SentAttachment[]) => Promise<boolean>;
  /** The same, for a row already in the queue, by its local id. A refused row stays queued. */
  sendQueuedNow: (id: string) => Promise<boolean>;
  /**
   * The queue is parked: it is holding rather than waiting for the turn to
   * end. Stopping, a failure, a dropped turn or leaving the thread parks one,
   * and a deliberate send releases it.
   */
  queueParked: boolean;

  /** A coarse clock, so every relative timestamp in one paint agrees with itself. */
  now: number;
  /** Steer and Stop for one delegated child, and its unsent steer (`chat-subagent-control.ts`). */
  subagents: SubagentControls;
  /** The composer's pending files for this conversation (`chat-attachments.ts`). */
  attachments: AttachmentsControl;
}

/** The four calls, injectable so a DOM test can drive the provider without a fetch stub. */
export interface ChatApi {
  openConversation?: typeof chatOpen;
  fetchSwarms: typeof fetchSwarms;
  fetchSessions: typeof fetchSessions;
  fetchHistory: typeof fetchHistory;
  sendTurn: typeof sendTurn;
  abortTurn: typeof abortTurn;
  /** `chat.steer`. Optional: a tree without it falls back to stopping the turn. */
  steerTurn?: typeof steerTurn;
  /** `chat.steer`/`chat.abort` with `subagent_id`: one delegated child. Optional, like `steerTurn`. */
  steerSubagent?: typeof steerSubagent;
  stopSubagent?: typeof stopSubagent;
  /** The attachment pipeline's calls (`api/files.ts`). Optional: absent means the real bridge. */
  files?: AttachmentsApi;
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
