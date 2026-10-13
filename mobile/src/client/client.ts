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
import { isRunning, type LiveStatus } from "../gateway/active-list.ts";
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
  PHONE_DEDUPE_MARK,
  type WatchedThread,
} from "../inbox/store.ts";
import { failureHeadline } from "./chat-logic.ts";
import { ConversationStore, type ConversationTarget } from "./conversation-store.ts";
import { type RosterPrefsStorage, RosterStore } from "./roster-store.ts";
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
 *   or gone (`chat.onRemoteDone`: the transcript is re-read, the queue
 *   released). Idle, gone, or no answer: the turn is reported gone
 *   (`chat.onTurnGone`), so the store re-reads its transcript from the box.
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
  let suspended = false;
  let watched: WatchedThread | null = null;
  const previews = options.previews ?? (() => true);
  const fleetId = () => fleet.getState().link?.payload.fleet_id ?? "";

  /** File an event this phone saw, and alert for it unless it should not interrupt. */
  const raise = (arrival: InboxArrival, category: string | null) => {
    const decision = alertFor(arrival, inbox, phase, watched);
    const onScreen =
      phase === "active" &&
      !!watched?.focused &&
      watched.instance === arrival.instance &&
      watched.bot === arrival.bot;
    inbox.ingest(onScreen ? { ...arrival, read_at: arrival.at } : arrival);
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
      roster.noteArrival({ instance: where.instance, bot: where.bot, ...arrival });
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

  const roster = new RosterStore(transport, options.rosterPrefs ?? null);
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

  /**
   * Ask a detached turn's box what its session is doing, and keep asking
   * while the box says it is busy and its conversation is on screen. `back`:
   * the first ask on the return to the foreground, where anything but "busy"
   * (idle, gone, no answer) is today's `onTurnGone`.
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
      for (let first = true; ; first = false) {
        if (!first) await pause(REMOTE_POLL_MS, signal);
        if (signal.aborted) return;
        const where = chat.turnTarget(turnId);
        if (!where) return done();
        if (!where.session) {
          done();
          return chat.onTurnGone(turnId);
        }
        let status: LiveStatus | null;
        try {
          status = await transport.liveStatus({
            instance: where.target.instance,
            session: where.session,
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
        if (!isRunning(status)) {
          done();
          return chat.onRemoteDone(turnId);
        }
        chat.onTurnRemote(turnId, status);
        // Off screen: the turn stays "running on the box" until it is shown again.
        if (!chat.turnTarget(turnId)?.opened) return done();
      }
    })();
  }

  /** Read the thread on screen, if the app is on screen too. */
  const readFocused = () => {
    if (phase !== "active" || !watched?.focused) return;
    roster.markSeen(watched.instance, watched.bot);
    inbox.markThreadRead(watched.instance, watched.bot);
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
        detached = [...detached, ...transport.detachTurns()];
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
      offFleet();
      transport.dispose();
      chat.reset();
      roster.reset();
    },
  };
}
