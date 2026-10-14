/**
 * One paired fleet, wired: the gateway transport over core's adapter, the
 * conversation store, the roster, the phone-local inbox, and the Tailscale
 * probe, with turn events routed into the stores and the alert decision made
 * in one place.
 *
 * Pure TypeScript. The React Native layer (`src/fleet/FleetProvider.tsx`)
 * hands in the loaded `FleetStore` and `InboxStore`, `fetch`, the socket opener
 * over the global `WebSocket`, and draws the alerts; fixture mode hands in
 * core's `fixtureChatClient` as `chat`. Nothing here imports React or React
 * Native.
 */
import {
  HermeticError,
  type ApprovalBlock,
  type ChatMessage,
  type HermesChatClient,
  type QuestionBlock,
} from "@hermetic/core/chat-client";
import type { MobilePushData, MobilePushKind } from "@hermetic/core/schema";
import type { FleetStore } from "../fleet/store.ts";
import { isRunning, type LiveRow } from "../gateway/active-list.ts";
import { boxAddress, createGatewayClient } from "../gateway/client.ts";
import { type FetchLike, resetTunnelChecks } from "../gateway/hermeticd.ts";
import type { OpenSocket } from "../gateway/socket.ts";
import { probeHosts, probeTailscale, type TailscaleProbe } from "../gateway/tailscale.ts";
import { createGatewayTransport, type GatewayTransport } from "../gateway/transport.ts";
import {
  type AlertDecision,
  type AppPhase,
  alertFor,
  type InboxArrival,
  type InboxStore,
  onScreen,
  PHONE_DEDUPE_MARK,
  type WatchedThread,
} from "../inbox/store.ts";
import { failureHeadline } from "./chat-logic.ts";
import { ConversationStore, type ConversationTarget, type TurnWhere } from "./conversation-store.ts";
import { markConversationRead } from "./read.ts";
import { botKey, type RosterPrefsStorage, RosterStore } from "./roster-store.ts";
import { realTimers, type Timers } from "./timers.ts";

/* ── alerts ─────────────────────────────────────────────────────────────── */

/** The iOS category of a needs-you notification (no inline actions: a tap opens the conversation). */
export const NEEDS_ACTION_CATEGORY = "hermetic.needs_action";

export interface Alert {
  decision: Exclude<AlertDecision, "none">;
  title: string;
  body: string;
  /** Shaped like a box's push `data`, so a tap on either opens the same place. */
  data: MobilePushData;
  category: string | null;
}

export const PREVIEW_MAX = 140;

/** First line-folded `PREVIEW_MAX` characters of a reply's text. */
export function replyPreview(message: ChatMessage | null): string | null {
  if (!message) return null;
  const text = message.blocks
    .map((b) => (b.kind === "text" ? b.markdown : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}

export function requestAlertBody(block: ApprovalBlock | QuestionBlock): string {
  if (block.kind === "approval") return `Approval needed: ${block.summary || block.tool}`;
  return block.questions && block.questions.length > 1
    ? `${block.questions.length} questions: ${block.questions[0]?.prompt ?? block.prompt}`
    : block.prompt;
}

/**
 * The key an event this phone saw on its own socket is filed under. The box
 * keys its pushes `<instance>:<session>:<message_count>:<kind>`, which the
 * phone cannot know; the inbox's same-conversation, same-kind window
 * (`SAME_EVENT_MS`) is what folds a phone-local entry (marked by
 * `PHONE_DEDUPE_MARK`) with the box's push for the same event.
 */
export function localDedupe(
  where: { instance: string; session: string },
  kind: MobilePushKind,
  ref: string,
): string {
  return `${where.instance}:${where.session}${PHONE_DEDUPE_MARK}${ref}:${kind}`;
}

/** Why an observation ended when its agent stopped being listened (or left the fleet). */
export const UNLISTENED = "UNLISTENED";

/** How often a turn still running on its box is asked after (`session.active_list`). */
export const REMOTE_POLL_MS = 3_000;
/** Failed asks in a row after which a turn still running on its box is reported gone. */
export const REMOTE_FAILURES = 5;
/**
 * Answers in a row that do not list a turn's session before it is taken as
 * over. One is not enough: a compaction mid-turn renames the stored session,
 * and until an answer has named the turn's live id the phone cannot match it.
 * With no live id learned, misses alone never conclude: see
 * `REMOTE_UNKNOWN_MAX_MS`.
 */
export const REMOTE_MISSES = 2;
/**
 * How long a turn whose session the box stops listing, with no live id
 * learned to match it on, is still taken as running unless its transcript
 * shows it ended (`tailShowsDone`). Core's adapter does not reveal a turn's
 * live id, so a compaction while the phone was away (stored key rotated, the
 * live id never seen) looks exactly like a turn that ended; concluding on
 * misses would drain the queue into a busy session, and upstream's
 * `busy_input_mode = interrupt` would kill the turn. Timed from the first
 * miss; at the bound the turn is taken as over.
 */
export const REMOTE_UNKNOWN_MAX_MS = 120_000;
/** Transcript rows read to confirm such a turn ended (`tailShowsDone`). */
export const REMOTE_TAIL_ROWS = 5;

const isProcessEvent = (m: ChatMessage): boolean =>
  m.blocks.length > 0 && m.blocks.every((b) => b.kind === "process_event");

/**
 * Whether a transcript's tail (oldest first) shows that a turn started at
 * `since` ended: its last row, process events aside, was written after
 * `since` and either carries a failure or is a bot reply that does not stop
 * on a tool call. `since` unknown: never.
 */
export function tailShowsDone(messages: readonly ChatMessage[], since: string | null): boolean {
  const start = since === null ? Number.NaN : Date.parse(since);
  if (Number.isNaN(start)) return false;
  const last = messages.filter((m) => !isProcessEvent(m)).pop();
  if (!last || !(Date.parse(last.at) > start)) return false;
  if (last.failure || last.error) return true;
  return last.role === "bot" && last.blocks[last.blocks.length - 1]?.kind !== "tool";
}

/* ── the client ─────────────────────────────────────────────────────────── */

export interface HermeticClientOptions {
  /** The paired fleet, already loaded. */
  fleet: FleetStore;
  /** The phone-local inbox, already loaded. */
  inbox: InboxStore;
  fetch: FetchLike;
  openSocket: OpenSocket;
  /** ISO-8601 now. */
  now?: () => string;
  timers?: Timers;
  /** The adapter to use instead of a live one (fixture mode: core's `fixtureChatClient`). */
  chat?: HermesChatClient;
  rosterPrefs?: RosterPrefsStorage;
  /** Called with every alert that should be shown; the RN layer draws or schedules it. */
  onAlert?: (alert: Alert) => void;
  /** Whether alerts may carry message text (the phone's previews preference). */
  previews?: () => boolean;
}

/**
 * What the screens use (`src/client/index.ts` documents each member).
 *
 * Phase (`setPhase`):
 *
 * - `"background"` — called by the RN layer once its linger after the app left
 *   the screen has run out. Every running turn pump is detached (forgotten, not
 *   aborted: each turn keeps running on its box) and every observation is
 *   closed, hint socket and all. Nothing is interrupted on any box.
 * - `"active"` after `"background"` — every conversation still on screen is
 *   re-opened (`chat.resume`, `open` semantics: a fresh snapshot, then hints),
 *   and the box of every turn detached on the way out is asked what that
 *   turn's session is doing (`session.active_list`). Still busy (`working`,
 *   `starting`, `waiting`): the store keeps the turn in flight as running on
 *   the box (`chat.onTurnRemote`), and while its conversation is on screen
 *   the box is asked again every `REMOTE_POLL_MS` until the session is idle
 *   or gone. A definite answer that it is over — `idle`, or absent from
 *   `REMOTE_MISSES` answers in a row — is `chat.onRemoteDone` on the first ask
 *   as on any later one: the turn ran to its end, so the transcript is re-read
 *   and the queue released, with nothing marked dropped. Absent with no live
 *   id learned is over only once the transcript's tail shows a reply or a
 *   failure written after the turn started (`tailShowsDone`), or after
 *   `REMOTE_UNKNOWN_MAX_MS` of misses. No answer (the first
 *   ask failing, or `REMOTE_FAILURES` in a row) is `chat.onTurnGone`: dropped,
 *   and the transcript re-read from the box.
 * - `"inactive"` — alerts only; nothing is detached.
 *
 * Every move into `"background"` or `"active"` forgets the hermeticd tunnel
 * proofs (`resetTunnelChecks`): the network may have changed while away.
 *
 * Addressing: a conversation, roster read or Bot Mode call reaches an agent
 * only while this phone listens to it and the fleet still has it — the live
 * `GET /fleet` view when there is one, else the pairing link. Anything else is
 * refused with `VALIDATION` before a dial. An observation open on an agent that
 * stops qualifying ends with `observe: "off"` and `observeError.code`
 * `UNLISTENED` (not a failure); it resumes on its own when the agent is
 * listened again.
 */
export interface HermeticClient {
  readonly fleet: FleetStore;
  readonly chat: ConversationStore;
  readonly roster: RosterStore;
  readonly inbox: InboxStore;
  /** Bot Mode lifecycle and subagent control beside the store (`open`, `compact`, `steerSubagent`, …). */
  readonly gateway: GatewayTransport;
  readonly tailscale: {
    /** Probe up to three listened boxes, ready ones first; the answer is also kept as `last`. */
    probe(): Promise<TailscaleProbe>;
    last(): TailscaleProbe | null;
  };
  setPhase(phase: AppPhase): void;
  setWatched(watched: WatchedThread | null): void;
  dispose(): void;
}

export function createHermeticClient(options: HermeticClientOptions): HermeticClient {
  const { fleet, inbox } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const adapter =
    options.chat ?? createGatewayClient({ fetch: options.fetch, openSocket: options.openSocket, now });

  /** In the fleet: the live view when there is one (it wins over the link), else the link. */
  const inFleet = (instance: string): boolean => {
    const state = fleet.getState();
    if (!state.link) return false;
    if (state.view) return state.view.agents.some((a) => a.name === instance);
    return state.link.payload.agents.some((a) => a.name === instance);
  };
  const addressable = (instance: string): boolean => inFleet(instance) && fleet.isListening(instance);

  const address = (instance: string) => {
    const hosts = fleet.hosts();
    if (!hosts || !inFleet(instance))
      throw new HermeticError("VALIDATION", `${instance} is not an agent of the paired fleet`, {
        instance,
      });
    if (!fleet.isListening(instance))
      throw new HermeticError(
        "VALIDATION",
        `This phone is not listening to ${instance}. Turn listening on to reach it.`,
        { instance },
      );
    return boxAddress(hosts, instance);
  };

  const transport = createGatewayTransport({
    client: adapter,
    address,
    listening: () => fleet.listened(),
    setListening: (instance, on) => fleet.setListening(instance, on),
    turns: () => ({
      frame: (id, n, frame) => chat.onTurnFrame(id, n, frame),
      end: (id, state) => chat.onTurnEnd(id, state),
      gone: (id) => chat.onTurnGone(id),
      session: (id, session) => chat.onTurnSession(id, session),
    }),
    now,
  });

  let phase: AppPhase = "active";
  /** Turns detached when the app went to the background, reported gone on its return. */
  let detached: string[] = [];
  /** When each detached turn was started (`tailShowsDone`), until it settles. */
  const turnStarts = new Map<string, string>();
  let suspended = false;
  let watched: WatchedThread | null = null;
  const previews = options.previews ?? (() => true);
  const fleetId = () => fleet.getState().link?.payload.fleet_id ?? "";

  /**
   * File an event this phone saw, and alert for it unless it should not
   * interrupt. An event about the conversation on screen (`onScreen`: same
   * bot and same session) is filed read; one about the bot's other
   * conversation is not, and alerts as any other would.
   */
  const raise = (arrival: InboxArrival, category: string | null) => {
    const decision = alertFor(arrival, inbox, phase, watched);
    inbox.ingest(onScreen(arrival, phase, watched) ? { ...arrival, read_at: arrival.at } : arrival);
    if (decision === "none") return;
    options.onAlert?.({
      decision,
      title: arrival.title,
      body: arrival.body,
      category,
      data: {
        fleet_id: fleetId(),
        instance: arrival.instance,
        bot: arrival.bot,
        session: arrival.session,
        kind: arrival.kind,
        dedupe: arrival.dedupe,
      },
    });
  };

  const title = (t: { instance: string; bot: string }) => `${t.bot} · ${t.instance}`;
  const sessionOf = (where: ConversationTarget) =>
    chat.view(where).resolvedSession ?? where.session ?? "";

  const chat = new ConversationStore({
    transport,
    ...(options.timers ? { timers: options.timers } : {}),
    onTurnSettled: (where, outcome) => {
      if (!outcome.turnId) return;
      turnStarts.delete(outcome.turnId);
      const session = sessionOf(where);
      const base = {
        instance: where.instance,
        bot: where.bot,
        session,
        title: title(where),
        at: now(),
      };
      if (outcome.ok) {
        const preview = previews() ? replyPreview(outcome.reply) : null;
        raise(
          {
            ...base,
            kind: "turn.done",
            body: preview ?? "Reply ready",
            dedupe: localDedupe({ instance: where.instance, session }, "turn.done", outcome.turnId),
          },
          null,
        );
      } else if (outcome.error) {
        raise(
          {
            ...base,
            kind: "turn.error",
            // The failure text with previews on; else its headline ("Rate limited"),
            // which is phone-local copy and never leaves the device.
            body: (previews() && outcome.error.message) || failureHeadline(outcome.error.code),
            dedupe: localDedupe({ instance: where.instance, session }, "turn.error", outcome.turnId),
          },
          null,
        );
      }
    },
    onArrival: (where, arrival) => {
      // A separate session's words move the bot's time, never its Bot Chat count.
      const elsewhere = where.session !== null && !isBotChat(where);
      roster.noteArrival({
        instance: where.instance,
        bot: where.bot,
        ...arrival,
        ...(elsewhere ? { elsewhere } : {}),
      });
    },
    onRequestOpened: (where, { block }) => {
      const request_id = block.request_id;
      if (!request_id) return;
      const session = sessionOf(where);
      raise(
        {
          instance: where.instance,
          bot: where.bot,
          session,
          title: title(where),
          at: now(),
          kind: "needs_action",
          body: previews() ? requestAlertBody(block) : "Needs you",
          dedupe: localDedupe({ instance: where.instance, session }, "needs_action", request_id),
        },
        NEEDS_ACTION_CATEGORY,
      );
    },
    onRemoteShown: (turnId, on) => {
      if (on) {
        if (!suspended) followRemote(turnId, false);
      } else stopFollowing(turnId);
    },
  });

  /** A `?session=` conversation that is the bot's canonical one counts as its Bot Chat. */
  const isBotChat = (where: ConversationTarget): boolean =>
    where.session === null ||
    chat.view(where).sessions.find((s) => s.id === where.session)?.kind === "canonical";

  const roster = new RosterStore(transport, options.rosterPrefs ?? null);
  // A request open in a followed turn marks its bot needs-you on home until it
  // is answered or its turn ends, whether or not its thread has been read.
  const offWaiting = chat.subscribe(() => {
    roster.setWaiting(chat.waiting().map((t) => botKey(t.instance, t.bot)));
  });
  const pairedFleet = fleetId();
  if (pairedFleet) void roster.setFleet(pairedFleet);
  roster.setListening(fleet.listened());
  const unlistened = {
    code: UNLISTENED,
    message: "This phone is no longer listening to this agent.",
  };
  const offFleet = fleet.subscribe(() => {
    roster.setListening(fleet.listened());
    chat.endObservations((t) => !addressable(t.instance), unlistened);
    if (!suspended)
      chat.resume((t) => addressable(t.instance) && chat.view(t).observeError?.code === UNLISTENED);
  });

  let lastProbe: TailscaleProbe | null = null;
  const tailscale = {
    probe: async () => {
      const listened = new Set(fleet.listened());
      const hosts = probeHosts(fleet.agents().filter((a) => listened.has(a.name)));
      lastProbe = await probeTailscale({ hosts, fetch: options.fetch });
      return lastProbe;
    },
    last: () => lastProbe,
  };

  /* ── turns still running on their box ──────────────────────────────── */

  const timers = options.timers ?? realTimers;
  /** The turns whose box is being asked after, each with its stop. */
  const following = new Map<string, AbortController>();
  const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const handle = timers.setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          timers.clearTimeout(handle);
          resolve();
        },
        { once: true },
      );
    });
  const stopFollowing = (turnId: string) => {
    following.get(turnId)?.abort();
    following.delete(turnId);
  };

  /** Whether the transcript's tail shows the turn ended; a failed read shows nothing. */
  const tailDone = async (turnId: string, where: TurnWhere, session: string): Promise<boolean> => {
    try {
      const tail = await transport.history({
        instance: where.target.instance,
        bot: where.target.bot,
        session,
        limit: REMOTE_TAIL_ROWS,
      });
      return tailShowsDone(tail.messages, turnStarts.get(turnId) ?? null);
    } catch {
      return false;
    }
  };

  /**
   * Ask a detached turn's box what its session is doing, and keep asking
   * while the box says it is busy and its conversation is on screen. `back`:
   * the first ask on the return to the foreground, where no answer at all is
   * `onTurnGone`. A row once matched names the turn's live id, which the next
   * ask matches on too (a compaction renames the stored id, not the live one).
   * With no live id learned, a session gone from the list may be one renamed
   * while the phone was away: the turn is over only when the transcript's
   * tail says so, or `REMOTE_UNKNOWN_MAX_MS` after the first miss.
   */
  function followRemote(turnId: string, back: boolean): void {
    if (following.has(turnId)) return;
    const stop = new AbortController();
    following.set(turnId, stop);
    const { signal } = stop;
    const done = () => {
      if (following.get(turnId) === stop) following.delete(turnId);
    };
    void (async () => {
      let failures = 0;
      let misses = 0;
      /** `timers.now()` at the first of the current misses. */
      let missedSince: number | null = null;
      for (let first = true; ; first = false) {
        if (!first) await pause(REMOTE_POLL_MS, signal);
        if (signal.aborted) return;
        const where = chat.turnTarget(turnId);
        if (!where) {
          turnStarts.delete(turnId);
          return done();
        }
        if (!where.session) {
          done();
          return chat.onTurnGone(turnId);
        }
        let row: LiveRow | null;
        try {
          row = await transport.liveStatus({
            instance: where.target.instance,
            session: where.session,
            runtime: where.runtime,
            signal,
          });
        } catch {
          if (signal.aborted) return;
          if ((back && first && !where.remote) || ++failures >= REMOTE_FAILURES) {
            done();
            return chat.onTurnGone(turnId);
          }
          continue;
        }
        if (signal.aborted) return;
        failures = 0;
        if (row === null) {
          missedSince ??= timers.now();
          // Not listed: over, or renamed under a live id not yet learned. Ask again.
          if (++misses < REMOTE_MISSES) continue;
          if (!where.runtime && timers.now() - missedSince < REMOTE_UNKNOWN_MAX_MS) {
            const ended = await tailDone(turnId, where, where.session);
            if (signal.aborted) return;
            if (!ended) continue;
          }
          done();
          return chat.onRemoteDone(turnId);
        }
        if (!isRunning(row.status)) {
          done();
          return chat.onRemoteDone(turnId);
        }
        misses = 0;
        missedSince = null;
        chat.onTurnRemote(turnId, row.status, row.id, row.session_key);
        // Off screen: the turn stays "running on the box" until it is shown again.
        if (!chat.turnTarget(turnId)?.opened) return done();
      }
    })();
  }

  /**
   * Read the conversation on screen, if the app is on screen too: the Bot Chat
   * clears the bot, a separate session only its own entries (`read.ts`).
   */
  const readFocused = () => {
    if (phase !== "active" || !watched?.focused) return;
    markConversationRead({ roster, inbox }, watched);
  };

  return {
    fleet,
    chat,
    roster,
    inbox,
    gateway: transport,
    tailscale,
    setPhase: (next) => {
      const was = phase;
      phase = next;
      if (next !== was && (next === "background" || next === "active")) resetTunnelChecks();
      if (next === "background" && !suspended) {
        suspended = true;
        // A first ask still out is asked again on the return; a turn already
        // known to run on its box is asked again when its conversation reopens.
        for (const turnId of [...following.keys()]) {
          if (chat.turnTarget(turnId)?.remote === null) detached.push(turnId);
          stopFollowing(turnId);
        }
        for (const turn of transport.detachTurnsSince()) {
          turnStarts.set(turn.turn_id, turn.since);
          detached.push(turn.turn_id);
        }
        chat.suspend();
      }
      if (next === "active" && suspended) {
        suspended = false;
        const back = [...new Set(detached)];
        detached = [];
        for (const id of back) followRemote(id, true);
        chat.resume((t) => addressable(t.instance));
      }
      if (next === "active" && was !== "active") readFocused();
    },
    setWatched: (next) => {
      watched = next;
      readFocused();
    },
    dispose: () => {
      for (const turnId of [...following.keys()]) stopFollowing(turnId);
      turnStarts.clear();
      offFleet();
      offWaiting();
      transport.dispose();
      chat.reset();
      roster.reset();
    },
  };
}
