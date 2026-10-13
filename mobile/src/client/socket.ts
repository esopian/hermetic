/**
 * `BridgeSocket` — the phone's one WebSocket to the bridge.
 *
 * It owns the connection's whole life: `auth` within the bridge's deadline,
 * `pong` for every `ping`, request/response correlation by `id`, reconnecting
 * with backoff, and — the reason it exists — *resume*. Every turn the phone is
 * following is tracked with the last frame number `n` it has seen; on every
 * reconnect the `auth` frame asks for exactly the frames after that, so a turn
 * that kept running on the laptop while the phone slept is replayed and then
 * followed live. Observations are re-opened the same way.
 *
 * Pure TypeScript: the WebSocket constructor, the timers and the random source
 * are injected, so jest drives it with fake timers and bun drives it against a
 * real bridge. No React, no React Native.
 */
import { MOBILE_CLOSE_CODES, MOBILE_PROTOCOL } from "../protocol/constants.ts";
import type {
  BridgeErrorBody,
  ChatFrame,
  ChatObserveEvent,
  ClientFrame,
  FleetTarget,
  Hello,
  Notification,
  NotificationCounts,
  ObserveOpenResult,
  ServerFrame,
  TurnRequest,
  TurnResumeResult,
  TurnStartResult,
  TurnState,
  TurnSummary,
} from "../protocol/types.ts";
import { BridgeError, CLIENT_ERROR_CODES, errorBody } from "./errors.ts";

/* ── injected effects ───────────────────────────────────────────────────── */

/**
 * An event-handler slot, checked bivariantly. A real socket types its handlers
 * with its own, richer event (`MessageEvent`, `CloseEvent`, RN's
 * `WebSocketMessageEvent`); under `strictFunctionTypes` a plain function-typed
 * property would reject those as narrower than the shape read here. A
 * method-derived type is compared bivariantly, so any socket whose events carry
 * at least these fields is assignable without a cast.
 */
type EventHandler<E> = { bivarianceHack(event: E): unknown }["bivarianceHack"];

/**
 * The slice of a WebSocket the client uses. The browser, React Native and bun
 * `WebSocket` satisfy it as-is: `(url) => new WebSocket(url)` is a
 * `WebSocketFactory` with no cast.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: EventHandler<unknown> | null;
  onmessage: EventHandler<{ data: unknown }> | null;
  onclose: EventHandler<{ code: number; reason: string }> | null;
  onerror: EventHandler<unknown> | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export type TimerHandle = unknown;

export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  now(): number;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/* ── backoff ────────────────────────────────────────────────────────────── */

export const RECONNECT_MAX_MS = 30_000;
/** Consecutive pre-auth 4400 closes after which the socket stops dialling (`unauthorized`). */
export const BAD_FRAME_LIMIT = 3;

/**
 * The wait before reconnect attempt `attempt` (1-based): 0, 1, 2, 4, 8, 16 s,
 * capped at 30 s — the desktop's transcript-recovery ladder, continued — plus
 * up to 20% jitter so a fleet of phones does not reconnect on the same beat.
 * The first attempt is always immediate.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  if (attempt <= 1) return 0;
  const base = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** (attempt - 2));
  const jitter = Math.floor(base * 0.2 * random());
  return Math.min(RECONNECT_MAX_MS, base + jitter);
}

/* ── events ─────────────────────────────────────────────────────────────── */

export type SocketState =
  /** Not started, or stopped by `close()`. */
  | "idle"
  | "connecting"
  | "authenticating"
  | "open"
  /** Dropped; a reconnect is scheduled. */
  | "reconnecting"
  /**
   * The bridge answered but cannot serve a fleet right now (close 4503: the
   * laptop is mid-teardown or showing its setup wizard). The token is still
   * good; reconnecting on the normal backoff continues until it can. Sticky
   * across attempts until an `auth.ok` or a different kind of drop.
   */
  | "unavailable"
  /**
   * The bridge refused this device: revoked, an unknown token (a device row the
   * laptop never re-paired after an upgrade answers the same 4401, so the phone
   * cannot tell the two apart), or a handshake it rejected as malformed
   * `BAD_FRAME_LIMIT` times in a row. Reconnecting will not help; a re-pair does.
   */
  | "unauthorized"
  /** The bridge speaks another protocol version. Reconnecting will not help. */
  | "mismatch"
  /**
   * The bridge now serves another fleet than the one this phone was paired on
   * (the laptop switched fleets): close 4403, an `auth.error` or HTTP 403
   * `WRONG_FLEET`, or an `auth.ok` whose `hello.fleet` is not this pairing's.
   * The token is not revoked, but every call would be refused: only a re-pair
   * helps. Sticky across `close()`; `reset()` or `clearFatal()` leaves it.
   */
  | "wrong_fleet";

export interface SocketEvents {
  state: SocketState;
  hello: Hello;
  "turn.frame": { turn_id: string; n: number; frame: ChatFrame };
  "turn.end": { turn_id: string; n: number; state: Exclude<TurnState, "running"> };
  "turn.started": TurnSummary;
  /** A turn this socket followed is no longer buffered: re-read `chat.history`. */
  "turn.gone": { turn_id: string };
  /** The bridge's buffer dropped frames this phone never saw: re-read history once the turn ends. */
  "turn.truncated": { turn_id: string };
  "observe.event": { observation: string; sub_id: string; event: ChatObserveEvent };
  "observe.end": {
    observation: string;
    sub_id: string;
    error: { code: string; message: string } | null;
  };
  notification: { row: Notification; counts: NotificationCounts };
  listening: { instances: string[] };
  "auth.error": BridgeErrorBody;
  /** A protocol-level `error` frame from the bridge. */
  error: BridgeErrorBody;
}

type Handler<T> = (payload: T) => void;

/** What the phone tells the bridge about itself, so it pushes only when nobody is looking. */
export type SocketPhase = "foreground" | "background";

/* ── options ────────────────────────────────────────────────────────────── */

export interface BridgeSocketOptions {
  /** `ws://host:port/mobile/v1/ws` (`wsUrlFor`). */
  url: string;
  token: () => string | null;
  target: () => FleetTarget | null;
  createSocket: WebSocketFactory;
  timers?: Timers;
  random?: () => number;
  /** How long a request waits for its `res`, including any wait for the socket to open. */
  requestTimeoutMs?: number;
  /**
   * Silence longer than this (no frame at all, `ping` included) means the
   * socket is dead even if the OS has not said so. Default: two heartbeats
   * plus slack.
   */
  silenceMs?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: BridgeError) => void;
  timer: TimerHandle;
  frame: ClientFrame;
  /** A turn.start/turn.abort is never re-sent on a new socket: a re-send could repeat the prompt. */
  sent: boolean;
}

interface TrackedTurn {
  lastN: number;
  ended: boolean;
  /** A `turn.resume` for frames this socket skipped is on the wire; out-of-order frames wait for it. */
  gap?: boolean;
  /** The bridge said its buffer was truncated: the next frame may jump past `lastN + 1`. */
  jump?: boolean;
}

interface Observation {
  id: string;
  instance: string;
  bot: string;
  session: string | null;
  subId: string | null;
  attempt: number;
  timer: TimerHandle | null;
  opening: boolean;
}

/** What a call made in `wrong_fleet` rejects with. */
export function wrongFleetError(served: Hello["fleet"] | null): BridgeError {
  const now = served ? ` now serves ${served.alias ?? served.fleet_id}` : " serves another fleet";
  return new BridgeError(
    CLIENT_ERROR_CODES.WRONG_FLEET,
    `The bridge${now}, not the fleet this phone was paired on. Pair again to use it.`,
    403,
  );
}

const CONNECTING = 0;
const OPEN = 1;

export class BridgeSocket {
  private readonly opts: BridgeSocketOptions;
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly requestTimeoutMs: number;
  private readonly silenceMs: number;

  private ws: WebSocketLike | null = null;
  private _state: SocketState = "idle";
  private wanted = false;
  private attempt = 0;
  private reconnectTimer: TimerHandle | null = null;
  private silenceTimer: TimerHandle | null = null;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly turns = new Map<string, TrackedTurn>();
  private readonly observations = new Map<string, Observation>();
  private readonly bySubId = new Map<string, string>();
  private readonly handlers = new Map<keyof SocketEvents, Set<Handler<never>>>();
  private _hello: Hello | null = null;
  private phase: SocketPhase = "foreground";
  /** The last drop was a 4503: say "unavailable" rather than "reconnecting" until something else happens. */
  private unavailable = false;
  /** Consecutive pre-auth 4400 closes; reset by an `auth.ok`, any other close code, or a re-pair. */
  private badFrames = 0;
  /** The fleet the bridge said it serves instead, when it said (`auth.ok`, HTTP `hello`). */
  private _servedFleet: Hello["fleet"] | null = null;
  /** In-flight `turn.resume` request ids → turn, answered synchronously in `receive`. */
  private readonly resumes = new Map<string, string>();

  constructor(options: BridgeSocketOptions) {
    this.opts = options;
    this.timers = options.timers ?? realTimers;
    this.random = options.random ?? Math.random;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.silenceMs = options.silenceMs ?? MOBILE_PROTOCOL.HEARTBEAT_MS * 2 + 5_000;
  }

  /* ── public surface ─────────────────────────────────────────────────── */

  get state(): SocketState {
    return this._state;
  }

  get hello(): Hello | null {
    return this._hello;
  }

  /** In `wrong_fleet`: the fleet the bridge serves now, or `null` when it only refused. */
  get servedFleet(): Hello["fleet"] | null {
    return this._state === "wrong_fleet" ? this._servedFleet : null;
  }

  /** The turns being followed and the last `n` seen of each. */
  trackedTurns(): { turn_id: string; after: number; ended: boolean }[] {
    return [...this.turns].map(([turn_id, t]) => ({ turn_id, after: t.lastN, ended: t.ended }));
  }

  on<K extends keyof SocketEvents>(event: K, handler: Handler<SocketEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => {
      set.delete(handler as Handler<never>);
    };
  }

  /** Start (or resume after `close`) connecting. Idempotent. */
  connect(): void {
    this.wanted = true;
    if (this.ws || this.reconnectTimer !== null) return;
    if (this.fatal()) return;
    this.attempt = 0;
    this.unavailable = false;
    this.open();
  }

  /**
   * Stop: close the socket, cancel any reconnect, fail every pending request.
   * Tracked turns and observations are kept, so a later `connect()` resumes
   * them — that is what backgrounding the app does.
   */
  close(): void {
    this.wanted = false;
    this.clearReconnect();
    this.clearSilence();
    const ws = this.ws;
    this.ws = null;
    if (ws) this.retire(ws, 1000, "client closing");
    this.failPending(new BridgeError(CLIENT_ERROR_CODES.DISCONNECTED, "The connection was closed."));
    for (const obs of this.observations.values()) this.clearObservationTimer(obs);
    this.bySubId.clear();
    for (const obs of this.observations.values()) obs.subId = null;
    // A wrong fleet outlives a backgrounding or a Reconnect: only a re-pair clears it.
    if (this._state !== "wrong_fleet") this.setState("idle");
  }

  /** Forget everything (sign out). */
  reset(): void {
    this.close();
    this.turns.clear();
    this.observations.clear();
    this._hello = null;
    this._servedFleet = null;
    this.badFrames = 0;
    if (this._state !== "idle") this.setState("idle");
  }

  /**
   * Tell the bridge whether the app is in front. Sent now if the socket is
   * open, and again after every `auth.ok`; the bridge pushes only to a device
   * none of whose sockets is in the foreground.
   */
  setPhase(phase: SocketPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    if (this._state === "open") this.sendRaw({ type: "phase", phase });
  }

  /** Allow connecting again after `unauthorized`/`mismatch`/`wrong_fleet` (a re-pair). */
  clearFatal(): void {
    if (this.fatal()) {
      this._servedFleet = null;
      this.badFrames = 0;
      this.setState("idle");
    }
  }

  /**
   * The bridge serves another fleet than this pairing's: stop, fail everything
   * in flight with `WRONG_FLEET`, and do not dial again. `fleet` is what the
   * bridge said it serves, when it said; a later bare refusal keeps it.
   */
  wrongFleet(fleet: Hello["fleet"] | null = null): void {
    if (fleet) this._servedFleet = fleet;
    this.wanted = false;
    this.unavailable = false;
    this.clearReconnect();
    this.clearSilence();
    const ws = this.ws;
    this.ws = null;
    if (ws) this.retire(ws, 1000, "wrong fleet");
    this.failPending(wrongFleetError(this._servedFleet));
    this.bySubId.clear();
    for (const obs of this.observations.values()) {
      obs.subId = null;
      obs.opening = false;
      this.clearObservationTimer(obs);
    }
    this.setState("wrong_fleet");
  }

  private fatal(): boolean {
    return (
      this._state === "unauthorized" || this._state === "mismatch" || this._state === "wrong_fleet"
    );
  }

  rpc<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const target = this.opts.target();
    if (!target)
      return Promise.reject(
        new BridgeError(CLIENT_ERROR_CODES.NO_TARGET, "No fleet target: pair first."),
      );
    return this.request<T>({ type: "rpc", id: this.nextId(), method, params, target });
  }

  async startTurn(turn: TurnRequest): Promise<TurnStartResult> {
    const target = this.opts.target();
    if (!target) throw new BridgeError(CLIENT_ERROR_CODES.NO_TARGET, "No fleet target: pair first.");
    const result = await this.request<TurnStartResult>({
      type: "turn.start",
      id: this.nextId(),
      target,
      turn,
    });
    if (!this.turns.has(result.turn_id)) this.turns.set(result.turn_id, { lastN: 0, ended: false });
    return result;
  }

  /** Follow a turn some other device (or an earlier run of the app) started. */
  async resumeTurn(turn_id: string, after = 0): Promise<TurnResumeResult> {
    const known = this.turns.get(turn_id);
    const from = Math.max(after, known?.lastN ?? 0);
    if (!known) this.turns.set(turn_id, { lastN: from, ended: false });
    try {
      // `turn.truncated` is emitted from `resumeAnswered`, synchronously with the `res`.
      return await this.sendResume(turn_id, from);
    } catch (error) {
      if (error instanceof BridgeError && error.code === "TURN_GONE") this.forgetGone(turn_id);
      throw error;
    }
  }

  abortTurn(turn_id: string): Promise<unknown> {
    return this.request({ type: "turn.abort", id: this.nextId(), turn_id });
  }

  /** Stop following a turn (its conversation was left, or it was superseded). */
  untrackTurn(turn_id: string): void {
    this.turns.delete(turn_id);
  }

  /**
   * Observe a conversation. Returns the observation's local id; events arrive
   * as `observe.event` carrying it. Survives reconnects (re-opened on each).
   */
  observe(instance: string, bot: string, session: string | null = null): string {
    const id = `obs${++this.seq}`;
    const obs: Observation = {
      id,
      instance,
      bot,
      session,
      subId: null,
      attempt: 0,
      timer: null,
      opening: false,
    };
    this.observations.set(id, obs);
    if (this._state === "open") void this.openObservation(obs);
    return id;
  }

  unobserve(observation: string): void {
    const obs = this.observations.get(observation);
    if (!obs) return;
    this.observations.delete(observation);
    this.clearObservationTimer(obs);
    if (obs.subId) {
      this.bySubId.delete(obs.subId);
      if (this._state === "open")
        this.request({ type: "observe.close", id: this.nextId(), sub_id: obs.subId }).catch(() => {});
    }
  }

  /* ── connection lifecycle ───────────────────────────────────────────── */

  private open(): void {
    const token = this.opts.token();
    if (!token) {
      this.wanted = false;
      this.setState("unauthorized");
      return;
    }
    if (!this.unavailable) this.setState("connecting");
    let ws: WebSocketLike;
    try {
      ws = this.opts.createSocket(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (!this.unavailable) this.setState("authenticating");
      const resume = [...this.turns]
        .filter(([, t]) => !t.ended)
        .map(([turn_id, t]) => ({ turn_id, after: t.lastN }));
      this.sendRaw({
        type: "auth",
        token,
        protocol: MOBILE_PROTOCOL.PROTOCOL_VERSION,
        ...(resume.length > 0 ? { resume: { turns: resume } } : {}),
      });
      this.armSilence();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.armSilence();
      this.receive(event.data);
    };
    ws.onerror = () => {
      // `onclose` follows and decides; an error alone says nothing actionable.
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.dropped(event.code);
    };
  }

  private dropped(code: number): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) this.detach(ws);
    this.clearSilence();
    this.failPending(
      new BridgeError(CLIENT_ERROR_CODES.DISCONNECTED, "The connection to the bridge dropped."),
    );
    this.bySubId.clear();
    for (const obs of this.observations.values()) {
      obs.subId = null;
      obs.opening = false;
      this.clearObservationTimer(obs);
    }
    // The next `auth` resumes every turn from its `lastN`, which covers any gap.
    for (const t of this.turns.values()) t.gap = false;
    this.unavailable = code === MOBILE_CLOSE_CODES.UNAVAILABLE;
    // A rejected frame is retried (it may be a one-off), but the same handshake
    // would be rejected the same way: give up after a few and ask for a re-pair.
    this.badFrames = code === MOBILE_CLOSE_CODES.BAD_FRAME ? this.badFrames + 1 : 0;
    if (code === MOBILE_CLOSE_CODES.UNAUTHORIZED || this.badFrames >= BAD_FRAME_LIMIT) {
      this.wanted = false;
      this.setState("unauthorized");
      return;
    }
    if (code === MOBILE_CLOSE_CODES.PROTOCOL_MISMATCH) {
      this.wanted = false;
      this.setState("mismatch");
      return;
    }
    if (code === MOBILE_CLOSE_CODES.WRONG_FLEET) {
      this.wrongFleet();
      return;
    }
    if (!this.wanted) {
      this.setState("idle");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    this.attempt += 1;
    this.setState(this.unavailable ? "unavailable" : "reconnecting");
    const delay = backoffDelay(this.attempt, this.random);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wanted) this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private armSilence(): void {
    this.clearSilence();
    this.silenceTimer = this.timers.setTimeout(() => {
      this.silenceTimer = null;
      const ws = this.ws;
      if (!ws) return;
      // Do not wait for the OS to deliver `onclose` on a dead link.
      this.dropped(4000);
      this.retire(ws, 4000, "silent");
    }, this.silenceMs);
  }

  private clearSilence(): void {
    if (this.silenceTimer !== null) this.timers.clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  /**
   * Close a socket this client is done with, listeners first.
   *
   * One still handshaking is not closed there and then: it is closed the
   * moment it opens. On iOS, closing a WebSocket mid-handshake is the path on
   * which SocketRocket can report the same socket's end twice, and React
   * Native drops a socket's native subscriptions on the first report — so the
   * second arrives with nothing listening ("Sending `websocketClosed` with no
   * listeners registered", a dev-build warning). A socket already closing or
   * closed is left alone: its own end event is already on the way.
   */
  private retire(ws: WebSocketLike, code: number, reason: string): void {
    this.detach(ws);
    if (ws.readyState === CONNECTING) {
      ws.onopen = () => {
        ws.onopen = null;
        try {
          ws.close(code, reason);
        } catch {
          // already gone
        }
      };
      return;
    }
    if (ws.readyState !== OPEN) return;
    try {
      ws.close(code, reason);
    } catch {
      // already gone
    }
  }

  private detach(ws: WebSocketLike): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
  }

  private setState(state: SocketState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit("state", state);
  }

  /* ── frames in ──────────────────────────────────────────────────────── */

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data) as ServerFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object" || typeof (frame as { type?: unknown }).type !== "string")
      return;
    switch (frame.type) {
      case "ping":
        this.sendRaw({ type: "pong" });
        return;
      case "auth.ok":
        this.authenticated(frame.hello);
        return;
      case "auth.error": {
        const err = errorBody(frame.error) ?? { code: "UNAUTHORIZED", message: "Unauthorized" };
        this.emit("auth.error", err);
        if (err.code === "PROTOCOL_MISMATCH") {
          this.wanted = false;
          this.setState("mismatch");
        } else if (err.code === "UNAUTHORIZED") {
          this.wanted = false;
          this.setState("unauthorized");
        } else if (err.code === CLIENT_ERROR_CODES.WRONG_FLEET) {
          this.wrongFleet();
        }
        return;
      }
      case "res": {
        const resumed = this.resumes.get(frame.id);
        if (resumed !== undefined) this.resumeAnswered(resumed, frame);
        this.settle(frame);
        return;
      }
      case "turn.frame": {
        const turn = this.turns.get(frame.turn_id);
        if (turn) {
          if (frame.n <= turn.lastN) return;
          // A frame past the next one means this socket missed some (the bridge
          // closes a socket it cannot keep up with, and a replay can overlap a
          // live stream). Hold everything out of order and ask for the rest.
          if (frame.n !== turn.lastN + 1 && !turn.jump) {
            this.resumeGap(frame.turn_id, turn);
            return;
          }
          turn.jump = false;
          turn.lastN = frame.n;
        } else this.turns.set(frame.turn_id, { lastN: frame.n, ended: false });
        this.emit("turn.frame", { turn_id: frame.turn_id, n: frame.n, frame: frame.frame });
        return;
      }
      case "turn.end": {
        const turn = this.turns.get(frame.turn_id);
        if (turn?.ended) return;
        // Frames before the end are missing: the resume replays them and the end again.
        if (turn && frame.n > turn.lastN && !turn.jump) {
          this.resumeGap(frame.turn_id, turn);
          return;
        }
        this.turns.set(frame.turn_id, { lastN: Math.max(turn?.lastN ?? 0, frame.n), ended: true });
        this.emit("turn.end", { turn_id: frame.turn_id, n: frame.n, state: frame.state });
        return;
      }
      case "turn.started":
        this.emit("turn.started", frame.turn);
        return;
      case "observe.event": {
        const observation = this.bySubId.get(frame.sub_id);
        if (!observation) return;
        const obs = this.observations.get(observation);
        if (obs) obs.attempt = 0;
        this.emit("observe.event", { observation, sub_id: frame.sub_id, event: frame.event });
        return;
      }
      case "observe.end": {
        const observation = this.bySubId.get(frame.sub_id);
        if (!observation) return;
        this.bySubId.delete(frame.sub_id);
        const obs = this.observations.get(observation);
        this.emit("observe.end", { observation, sub_id: frame.sub_id, error: frame.error ?? null });
        if (obs) {
          obs.subId = null;
          this.reopenLater(obs);
        }
        return;
      }
      case "notification":
        this.emit("notification", { row: frame.row, counts: frame.counts });
        return;
      case "listening":
        this.emit("listening", { instances: frame.instances });
        return;
      case "error":
        this.emit("error", errorBody(frame.error) ?? { code: "BAD_FRAME", message: "Protocol error" });
        return;
    }
  }

  private authenticated(hello: Hello): void {
    // A bridge answering for another fleet would refuse every call with
    // FLEET_MISMATCH: stop here rather than follow its turns or open watches.
    const target = this.opts.target();
    if (target && hello.fleet.fleet_id !== target.fleet_id) {
      this.wrongFleet(hello.fleet);
      return;
    }
    this._hello = hello;
    this.attempt = 0;
    this.badFrames = 0;
    this.unavailable = false;
    this.setState("open");
    // The bridge counts a fresh socket as foreground; say where the app really is.
    this.sendRaw({ type: "phase", phase: this.phase });
    // A turn this phone was following that the bridge no longer lists has
    // expired from its buffer: the frames are gone, history is the record.
    const live = new Map(hello.active_turns.map((t) => [t.turn_id, t]));
    for (const [turn_id, t] of [...this.turns]) {
      if (t.ended) {
        this.turns.delete(turn_id);
        continue;
      }
      const summary = live.get(turn_id);
      if (!summary) this.forgetGone(turn_id);
      else if (summary.truncated) {
        t.jump = true;
        this.emit("turn.truncated", { turn_id });
      }
    }
    this.emit("hello", hello);
    for (const [, p] of this.pending) {
      if (!p.sent) {
        p.sent = true;
        this.sendRaw(p.frame);
      }
    }
    for (const obs of this.observations.values()) void this.openObservation(obs);
  }

  /** Ask once for the frames after `lastN`; later out-of-order frames wait for that answer. */
  private resumeGap(turn_id: string, turn: TrackedTurn): void {
    if (turn.gap) return;
    turn.gap = true;
    this.sendResume(turn_id, turn.lastN).catch((error: unknown) => {
      const t = this.turns.get(turn_id);
      if (t) t.gap = false;
      if (error instanceof BridgeError && error.code === "TURN_GONE" && t) this.forgetGone(turn_id);
    });
  }

  private sendResume(turn_id: string, after: number): Promise<TurnResumeResult> {
    const id = this.nextId();
    this.resumes.set(id, turn_id);
    return this.request<TurnResumeResult>({ type: "turn.resume", id, turn_id, after }).finally(() => {
      this.resumes.delete(id);
    });
  }

  /**
   * A `turn.resume` answered. Handled here, in the same tick as the `res`,
   * because the replay follows it on the wire: the gap must be closed and a
   * truncated buffer's first frame allowed through before those frames land.
   */
  private resumeAnswered(turn_id: string, frame: Extract<ServerFrame, { type: "res" }>): void {
    const turn = this.turns.get(turn_id);
    if (turn) turn.gap = false;
    if (!frame.ok) return;
    if ((frame.result as Partial<TurnResumeResult> | null)?.truncated) {
      if (turn) turn.jump = true;
      this.emit("turn.truncated", { turn_id });
    }
  }

  private forgetGone(turn_id: string): void {
    this.turns.delete(turn_id);
    this.emit("turn.gone", { turn_id });
  }

  private settle(frame: Extract<ServerFrame, { type: "res" }>): void {
    const p = this.pending.get(frame.id);
    if (!p) {
      // A batched resume (`auth.resume.turns`) that missed answers under the
      // synthetic id `resume:<turn_id>`.
      if (!frame.ok && frame.id.startsWith("resume:") && errorBody(frame.error)?.code === "TURN_GONE") {
        const turn_id = frame.id.slice("resume:".length);
        if (this.turns.has(turn_id)) this.forgetGone(turn_id);
      }
      return;
    }
    this.pending.delete(frame.id);
    this.timers.clearTimeout(p.timer);
    if (frame.ok) p.resolve(frame.result);
    else {
      const err = errorBody(frame.error) ?? {
        code: "INTERNAL",
        message: "The bridge refused the request.",
      };
      p.reject(new BridgeError(err.code, err.message, 0, err.details));
    }
  }

  /* ── frames out ─────────────────────────────────────────────────────── */

  private nextId(): string {
    return `c${++this.seq}`;
  }

  private sendRaw(frame: ClientFrame): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // the close handler will follow
    }
  }

  private request<T>(frame: ClientFrame & { id: string }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        if (!this.pending.delete(frame.id)) return;
        reject(
          new BridgeError(CLIENT_ERROR_CODES.TIMEOUT, `No answer from the bridge for ${frame.type}.`),
        );
      }, this.requestTimeoutMs);
      const ready = this._state === "open";
      this.pending.set(frame.id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        frame,
        sent: ready,
      });
      if (ready) this.sendRaw(frame);
      else if (!this.wanted) {
        this.pending.delete(frame.id);
        this.timers.clearTimeout(timer);
        reject(
          this._state === "wrong_fleet"
            ? wrongFleetError(this._servedFleet)
            : new BridgeError(CLIENT_ERROR_CODES.DISCONNECTED, "Not connected to the bridge."),
        );
      }
    });
  }

  /**
   * Fail every request already on the wire. One not yet sent waits for the
   * next socket, except when the client is stopping.
   */
  private failPending(error: BridgeError): void {
    for (const [id, p] of [...this.pending]) {
      if (p.sent || !this.wanted) {
        this.pending.delete(id);
        this.timers.clearTimeout(p.timer);
        p.reject(error);
      }
    }
  }

  /* ── observations ───────────────────────────────────────────────────── */

  private async openObservation(obs: Observation): Promise<void> {
    if (obs.opening || obs.subId) return;
    const target = this.opts.target();
    if (!target) return;
    obs.opening = true;
    try {
      const result = await this.request<ObserveOpenResult>({
        type: "observe.open",
        id: this.nextId(),
        target,
        instance: obs.instance,
        bot: obs.bot,
        session: obs.session,
      });
      obs.opening = false;
      if (!this.observations.has(obs.id)) {
        // Unobserved while opening: close what the bridge just opened.
        this.request({ type: "observe.close", id: this.nextId(), sub_id: result.sub_id }).catch(
          () => {},
        );
        return;
      }
      obs.subId = result.sub_id;
      this.bySubId.set(result.sub_id, obs.id);
    } catch (error) {
      obs.opening = false;
      if (error instanceof BridgeError && error.code === CLIENT_ERROR_CODES.DISCONNECTED) return;
      if (this.observations.has(obs.id)) {
        this.emit("observe.end", {
          observation: obs.id,
          sub_id: "",
          error: {
            code: error instanceof BridgeError ? error.code : "INTERNAL",
            message: String(error),
          },
        });
        this.reopenLater(obs);
      }
    }
  }

  private reopenLater(obs: Observation): void {
    this.clearObservationTimer(obs);
    obs.attempt += 1;
    // An observation that ends is retried on the same ladder, from 1 s: an
    // immediate re-open of a stream that just failed is a busy loop.
    const delay = backoffDelay(obs.attempt + 1, this.random);
    obs.timer = this.timers.setTimeout(() => {
      obs.timer = null;
      if (this.observations.has(obs.id) && this._state === "open") void this.openObservation(obs);
    }, delay);
  }

  private clearObservationTimer(obs: Observation): void {
    if (obs.timer !== null) this.timers.clearTimeout(obs.timer);
    obs.timer = null;
  }

  private emit<K extends keyof SocketEvents>(event: K, payload: SocketEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as Handler<SocketEvents[K]>)(payload);
      } catch {
        // A listener's failure is its own; it must not break the socket.
      }
    }
  }
}
