/**
 * One paired bridge, wired: HTTP, the socket, and the three stores, with the
 * socket's events routed into them and the alert decision made in one place.
 *
 * Pure TypeScript — the React Native layer (`src/bridge/`) supplies the real
 * `WebSocket`, `fetch`, SecureStore and expo-notifications; the root e2e test
 * supplies bun's. Either `WebSocket` is a `WebSocketLike` as-is
 * (`(url) => new WebSocket(url)`, no cast; see `socket.ts`). Nothing here
 * imports React or React Native.
 */
import type {
  ApprovalBlock,
  ChatMessage,
  FleetTarget,
  Hello,
  MobilePlatform,
  PushData,
  QuestionBlock,
} from "../protocol/types.ts";
import { MOBILE_PROTOCOL } from "../protocol/constants.ts";
import {
  ConversationStore,
  type ConversationTarget,
  type ConversationTransport,
} from "./conversation-store.ts";
import { BridgeError, CLIENT_ERROR_CODES } from "./errors.ts";
import { type BridgeHttp, createBridgeHttp, type FetchLike, wsUrlFor } from "./http.ts";
import {
  type AppPhase,
  alertFor,
  dedupeKey,
  NotificationsStore,
  type WatchedThread,
} from "./notifications-store.ts";
import { type RosterPrefsStorage, RosterStore } from "./roster-store.ts";
import { BridgeSocket, type Timers, type WebSocketFactory } from "./socket.ts";

/** Everything the phone keeps about one pairing. The token goes to the keychain, never to logs. */
export interface Credentials {
  baseUrl: string;
  token: string;
  device_id: string;
  fleet: Hello["fleet"];
  tailnet: string | null;
  paired_at: string;
}

export function targetOf(fleet: Hello["fleet"]): FleetTarget {
  return { account_id: fleet.account_id, region: fleet.region, fleet_id: fleet.fleet_id };
}

/** Pair with a one-time code; returns the credentials to store. */
export async function pairDevice(input: {
  baseUrl: string;
  code: string;
  device_name: string;
  platform: MobilePlatform;
  fetch?: FetchLike;
  now?: () => number;
}): Promise<{ credentials: Credentials; hello: Hello }> {
  const http = createBridgeHttp({
    baseUrl: input.baseUrl,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const result = await http.pair({
    code: input.code,
    device_name: input.device_name,
    platform: input.platform,
  });
  const now = input.now ?? Date.now;
  return {
    hello: result.hello,
    credentials: {
      baseUrl: http.baseUrl,
      token: result.token,
      device_id: result.device_id,
      fleet: result.hello.fleet,
      tailnet: result.hello.tailnet,
      paired_at: new Date(now()).toISOString(),
    },
  };
}

/* ── alerts ─────────────────────────────────────────────────────────────── */

export interface Alert {
  decision: "banner" | "local";
  title: string;
  body: string;
  data: PushData;
  /** iOS category for actionable notifications (`MOBILE_PUSH_CATEGORIES`). */
  category: string | null;
}

export const PREVIEW_MAX = MOBILE_PROTOCOL.PREVIEW_MAX_CHARS;

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

/* ── the client ─────────────────────────────────────────────────────────── */

export interface HermeticClientOptions {
  credentials: Credentials;
  createSocket: WebSocketFactory;
  fetch?: FetchLike;
  timers?: Timers;
  random?: () => number;
  rosterPrefs?: RosterPrefsStorage;
  /** Called with every alert that should be shown; the RN layer draws or schedules it. */
  onAlert?: (alert: Alert) => void;
  /** Whether alerts may carry message text (the per-device previews setting). */
  previews?: () => boolean;
}

export interface HermeticClient {
  readonly credentials: Credentials;
  readonly target: FleetTarget;
  readonly http: BridgeHttp;
  readonly socket: BridgeSocket;
  readonly conversations: ConversationStore;
  readonly roster: RosterStore;
  readonly inbox: NotificationsStore;
  /** Socket if it is open, else HTTP. */
  rpc<T = unknown>(method: string, params?: unknown): Promise<T>;
  connect(): void;
  disconnect(): void;
  setPhase(phase: AppPhase): void;
  setWatched(watched: WatchedThread | null): void;
  dispose(): void;
}

export function createHermeticClient(options: HermeticClientOptions): HermeticClient {
  const { credentials } = options;
  const target = targetOf(credentials.fleet);
  const token = () => credentials.token;
  const http = createBridgeHttp({
    baseUrl: credentials.baseUrl,
    token,
    target: () => target,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const socket = new BridgeSocket({
    url: wsUrlFor(credentials.baseUrl),
    token,
    target: () => target,
    createSocket: options.createSocket,
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.random ? { random: options.random } : {}),
  });

  const rpc = <T>(method: string, params: unknown = {}): Promise<T> =>
    socket.state === "open" ? socket.rpc<T>(method, params) : http.rpc<T>(method, params);

  let phase: AppPhase = "active";
  let watched: WatchedThread | null = null;
  const previews = options.previews ?? (() => true);

  const raise = (alert: Omit<Alert, "decision">, input: Parameters<typeof alertFor>[0]) => {
    const decision = alertFor(input, inbox.dedupe);
    if (decision === "none") return;
    options.onAlert?.({ ...alert, decision });
  };

  const transport: ConversationTransport = {
    history: (input) => rpc("chat.history", input),
    sessions: (input) => rpc("chat.sessions", input),
    startTurn: (turn) => socket.startTurn(turn),
    abortTurn: (turn_id) => socket.abortTurn(turn_id),
    abort: (input) => rpc("chat.abort", input),
    steer: (input) => rpc("chat.steer", input),
    respond: (input) => rpc("chat.respond", input),
    resumeTurn: (turn_id, after) => socket.resumeTurn(turn_id, after),
    forgetTurn: (turn_id) => socket.untrackTurn(turn_id),
    observe: (where, handlers) => {
      const id = socket.observe(where.instance, where.bot, where.session);
      const offEvent = socket.on("observe.event", (e) => {
        if (e.observation === id) handlers.event(e.event);
      });
      const offEnd = socket.on("observe.end", (e) => {
        if (e.observation === id) handlers.end(e.error);
      });
      return () => {
        offEvent();
        offEnd();
        socket.unobserve(id);
      };
    },
  };

  const title = (t: { instance: string; bot: string }) => `${t.bot} · ${t.instance}`;

  const conversations = new ConversationStore({
    transport,
    ...(options.timers ? { timers: options.timers } : {}),
    onTurnSettled: (where: ConversationTarget, outcome) => {
      if (!outcome.turnId) return;
      const thread = { instance: where.instance, bot: where.bot };
      const session = where.session;
      if (outcome.ok) {
        const preview = previews() ? replyPreview(outcome.reply) : null;
        const dedupe = dedupeKey.turnDone(outcome.turnId);
        raise(
          {
            title: title(where),
            body: preview ?? "Reply ready",
            category: null,
            data: { kind: "turn.done", ...thread, session, turn_id: outcome.turnId, dedupe },
          },
          { dedupe, thread, phase, watched },
        );
      } else if (outcome.error) {
        const dedupe = dedupeKey.turnError(outcome.turnId);
        raise(
          {
            title: title(where),
            body: outcome.error.code,
            category: null,
            data: { kind: "turn.error", ...thread, session, turn_id: outcome.turnId, dedupe },
          },
          { dedupe, thread, phase, watched },
        );
      }
    },
    onArrival: (where, arrival) => {
      roster.noteArrival({ instance: where.instance, bot: where.bot, ...arrival });
    },
    onRequestOpened: (where, { block }) => {
      const request_id = block.request_id;
      if (!request_id) return;
      const thread = { instance: where.instance, bot: where.bot };
      const dedupe = dedupeKey.request(request_id);
      raise(
        {
          title: title(where),
          body: previews() ? requestAlertBody(block) : "Needs you",
          category: block.kind === "approval" ? "hermetic.approval" : "hermetic.question",
          data: {
            kind: "needs_action",
            request_kind: block.kind,
            ...thread,
            session: where.session,
            request_id,
            dedupe,
          },
        },
        { dedupe, thread, phase, watched },
      );
    },
  });

  const roster = new RosterStore(
    {
      swarms: () => rpc("chat.swarms", {}),
      listening: () => rpc("chat.listening", {}),
      listen: (instance, listening) => rpc("chat.listen", { instance, listening }),
    },
    options.rosterPrefs ?? null,
  );
  void roster.setFleet(target.fleet_id);

  const inbox = new NotificationsStore({
    list: (input) => rpc("notifications.list", input),
    ack: (input) => rpc("notifications.ack", input),
  });

  const offs = [
    socket.on("turn.frame", (e) => conversations.onTurnFrame(e.turn_id, e.n, e.frame)),
    socket.on("turn.end", (e) => conversations.onTurnEnd(e.turn_id, e.state)),
    socket.on("turn.gone", (e) => conversations.onTurnGone(e.turn_id)),
    socket.on("turn.truncated", (e) => conversations.onTurnTruncated(e.turn_id)),
    socket.on("turn.started", (summary) => {
      conversations.attach(summary);
    }),
    socket.on("hello", (hello) => {
      roster.setListening(hello.listening);
      for (const summary of hello.active_turns) conversations.attach(summary);
      void inbox.refresh();
    }),
    socket.on("listening", (e) => {
      roster.setListening(e.instances);
      void roster.refresh();
    }),
    socket.on("notification", ({ row, counts }) => {
      inbox.ingest(row, counts);
      const dedupe = dedupeKey.notification(row.id);
      raise(
        {
          title: row.title,
          body: previews() ? (row.detail ?? "") : "",
          category: null,
          data: { kind: "notification", id: row.id, dedupe, ref: row.ref ?? null },
        },
        { dedupe, row, phase, watched },
      );
      if (row.kind.startsWith("chat.")) void roster.refresh();
    }),
  ];

  return {
    credentials,
    target,
    http,
    socket,
    conversations,
    roster,
    inbox,
    rpc,
    connect: () => socket.connect(),
    disconnect: () => socket.close(),
    setPhase: (next) => {
      phase = next;
      // Only an app on screen is "foreground" to the bridge: `inactive` (the
      // app switcher, Notification Centre over it) is somebody not looking.
      socket.setPhase(next === "active" ? "foreground" : "background");
    },
    setWatched: (next) => {
      watched = next;
    },
    dispose: () => {
      for (const off of offs) off();
      socket.reset();
      conversations.reset();
      roster.reset();
      inbox.reset();
    },
  };
}

/** True for errors that mean "this pairing is dead" (revoked device, wiped bridge). */
export function isUnpaired(error: unknown): boolean {
  return (
    error instanceof BridgeError &&
    (error.code === "UNAUTHORIZED" || error.code === CLIENT_ERROR_CODES.NOT_PAIRED)
  );
}
