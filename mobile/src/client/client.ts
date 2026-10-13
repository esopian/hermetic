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
import { boxAddress, createGatewayClient } from "../gateway/client.ts";
import type { FetchLike } from "../gateway/hermeticd.ts";
import type { OpenSocket } from "../gateway/socket.ts";
import { probeTailscale, type TailscaleProbe } from "../gateway/tailscale.ts";
import { createGatewayTransport, type GatewayTransport } from "../gateway/transport.ts";
import {
  type AlertDecision,
  type AppPhase,
  alertFor,
  type InboxArrival,
  type InboxStore,
  type WatchedThread,
} from "../inbox/store.ts";
import { ConversationStore, type ConversationTarget } from "./conversation-store.ts";
import { type RosterPrefsStorage, RosterStore } from "./roster-store.ts";
import type { Timers } from "./timers.ts";

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
 * (`SAME_EVENT_MS`) is what folds the two.
 */
export function localDedupe(
  where: { instance: string; session: string },
  kind: MobilePushKind,
  ref: string,
): string {
  return `${where.instance}:${where.session}:phone-${ref}:${kind}`;
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
 */
export interface HermeticClient {
  readonly fleet: FleetStore;
  readonly chat: ConversationStore;
  readonly roster: RosterStore;
  readonly inbox: InboxStore;
  /** Bot Mode lifecycle and subagent control beside the store (`open`, `compact`, `steerSubagent`, …). */
  readonly gateway: GatewayTransport;
  readonly tailscale: {
    /** Probe up to three listened boxes; the answer is also kept as `last`. */
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

  const address = (instance: string) => {
    const hosts = fleet.hosts();
    if (!hosts?.agents.some((a) => a.name === instance))
      throw new HermeticError("VALIDATION", `${instance} is not an agent of the paired fleet`, {
        instance,
      });
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
            body: outcome.error.code,
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
  });

  const roster = new RosterStore(transport, options.rosterPrefs ?? null);
  const pairedFleet = fleetId();
  if (pairedFleet) void roster.setFleet(pairedFleet);
  roster.setListening(fleet.listened());
  const offFleet = fleet.subscribe(() => roster.setListening(fleet.listened()));

  let lastProbe: TailscaleProbe | null = null;
  const tailscale = {
    probe: async () => {
      const hosts = fleet
        .listened()
        .map((name) => fleet.hostOf(name))
        .filter((h): h is string => h !== null);
      lastProbe = await probeTailscale({ hosts, fetch: options.fetch });
      return lastProbe;
    },
    last: () => lastProbe,
  };

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
      if (next === "active" && was !== "active") readFocused();
    },
    setWatched: (next) => {
      watched = next;
      readFocused();
    },
    dispose: () => {
      offFleet();
      transport.dispose();
      chat.reset();
      roster.reset();
    },
  };
}
