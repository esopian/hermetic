/**
 * The app's terminal sessions (issue #18, D2): owned by the main process, so a
 * session outlives the drawer, the tab and the page that opened it.
 *
 * The host is the table and the policy around it:
 *
 * - **open** — caps (D4), the agent's state, core's `ssh` argv, the local
 *   Tailscale preflight (D8), then a spawn with the resolved binary in place
 *   of `tailscale`. Fixture mode runs the same path over core's canned
 *   preflight and the fixture spawner, so nothing is ever spawned.
 * - **views** — which window shows which session. Any window looking makes a
 *   session visible to its attention rules; looking resolves its inbox rows.
 * - **close/stopAll** — the operator's End, and the app quitting.
 * - **attaches** — the streams pages hold, by stream id, for `terminal.ack`.
 *
 * One `TerminalSession` (`session.ts`) per row holds the wiring. The handlers
 * (`handlers/terminal.ts`) validate and call in; the binding (`rpc/bind.ts`)
 * routes the three page messages here.
 */
import { randomUUID } from "node:crypto";
import { HermeticError, terminalNotices } from "@hermetic/core";
import type { Hermetic, TailscalePreflight } from "@hermetic/core";
import type { AppLog } from "../log.ts";
import type { AttentionEvent } from "./attention.ts";
import type { TerminalAttach, TerminalChannel } from "./channel.ts";
import { openInTerminal, spawnRunner } from "./command-file.ts";
import { gateTerminal } from "./gate.ts";
import type { PtySpawner } from "./pty.ts";
import { TerminalSession, type TerminalSessionRow } from "./session.ts";
import { realTimers, type Timers } from "./timers.ts";

/** D4. */
export const SESSIONS_PER_AGENT = 3;
export const SESSIONS_PER_APP = 8;

/** Statuses with no box to log in to. Anything else is worth a try; ssh says why not. */
const AGENT_OFF: ReadonlySet<string> = new Set(["stopping", "stopped", "destroying", "destroyed"]);

export interface TerminalOpenInput {
  name: string;
  cols: number;
  rows: number;
}

export interface TerminalOpened {
  session_id: string;
  index: number;
  name: string;
  started_at: string;
  /** Core's argv as the operator would type it (`tailscale ssh hermes@<host>`). */
  command: string;
}

/** A busy session, as the quit prompt names it (D9). */
export interface BusySession {
  name: string;
  index: number;
  label?: string;
}

export interface TerminalHostDeps {
  /** Read per call: the state swaps instances on adopt and fleet switch. */
  hermetic: () => Hermetic;
  spawner: PtySpawner;
  fixture: boolean;
  /** Defaults to `hermetic().init.localTailscale()` — canned in fixture mode. */
  preflight?: () => Promise<TailscalePreflight>;
  /** The poller's notification flush. Must not throw. */
  flush?: () => void;
  timers?: Timers;
  log?: AppLog;
  /** "Open in Terminal ↗" (D6). Defaults to a `.command` file run through `open`. */
  openExternal?: (argv: string[]) => Promise<unknown>;
  /** Session ids; must match core's `^[A-Za-z0-9_-]{1,64}$`. */
  newId?: () => string;
  /** Wall clock for `started_at`. */
  now?: () => Date;
}

/** How long a read of `terminal_alerts` is trusted before core is asked again. */
const ALERTS_READ_MS = 1000;

export class TerminalHost {
  private readonly deps: TerminalHostDeps;
  private readonly timers: Timers;
  /** Insertion order is open order, which is what eviction and `list` read. */
  private readonly sessions = new Map<string, TerminalSession>();
  /** Opens past the cap check and not yet in the table, per agent. */
  private readonly pending = new Map<string, number>();
  /** window → the session it shows. */
  private readonly views = new Map<string, string>();
  private readonly attaches = new Map<string, TerminalAttach>();
  /**
   * What `alertsOn` answers when core cannot (no instance yet): the last value
   * this head was told, starting at the default.
   */
  private lastKnownAlerts = true;
  /** When `lastKnownAlerts` was last read from core or told; null before either. */
  private alertsReadAt: number | null = null;

  constructor(deps: TerminalHostDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
  }

  /**
   * The `terminal_alerts` setting, read from core rather than remembered, so a
   * change made anywhere, the CLI's `inbox settings --terminal-alerts`
   * included, holds within a second without this process being told.
   */
  get alertsOn(): boolean {
    // At most one read a second: attention asks on every hidden chunk of a
    // flood once alerts are off (nothing latches when nothing is raised), and
    // each read is a settings parse. A second's staleness is invisible next to
    // a person flipping a switch; this head's own flips land at once
    // (`setAlerts`).
    const now = this.timers.now();
    if (this.alertsReadAt !== null && now - this.alertsReadAt < ALERTS_READ_MS) {
      return this.lastKnownAlerts;
    }
    try {
      this.lastKnownAlerts = terminalNotices(this.deps.hermetic()).alertsOn();
      this.alertsReadAt = now;
    } catch {
      // No instance yet (an uninitialized home): the last value heard.
    }
    return this.lastKnownAlerts;
  }

  /**
   * `notifications.settings` changed it through this head. Core already holds
   * the value `alertsOn` reads; this only keeps the fallback current for the
   * moment core cannot answer.
   */
  setAlerts(on: boolean): void {
    this.lastKnownAlerts = on;
    this.alertsReadAt = this.timers.now();
  }

  async open(input: TerminalOpenInput): Promise<TerminalOpened> {
    const { name } = input;
    this.checkCaps(name);
    this.pending.set(name, (this.pending.get(name) ?? 0) + 1);
    try {
      const h = this.deps.hermetic();
      const { argv, binary, fleetId } = await this.resolve(h, name);
      // Nothing awaited from here on: the slot checked above is the slot taken.
      this.makeRoom(name);
      const id = (this.deps.newId ?? randomUUID)();
      const startedAt = (this.deps.now?.() ?? new Date()).toISOString();
      const index = this.freeIndex(name);
      const pty = this.deps.spawner([binary, ...argv.slice(1)], {
        cols: input.cols,
        rows: input.rows,
      });
      const session: TerminalSession = new TerminalSession({
        id,
        name,
        index,
        fleetId,
        pty,
        cols: input.cols,
        rows: input.rows,
        timers: this.timers,
        visible: this.viewed(id),
        startedAt,
        alertsOn: () => this.alertsOn,
        raise: (event) => this.raise(session, event),
        flush: () => this.flush(),
        ...(this.deps.log !== undefined ? { log: this.deps.log } : {}),
      });
      this.sessions.set(id, session);
      this.deps.log?.line("info", "terminal", "session opened", {
        name,
        session: id,
        cols: input.cols,
        rows: input.rows,
      });
      return { session_id: id, index, name, started_at: startedAt, command: argv.join(" ") };
    } finally {
      const left = (this.pending.get(name) ?? 1) - 1;
      if (left > 0) this.pending.set(name, left);
      else this.pending.delete(name);
    }
  }

  /** "Open in Terminal ↗" (D6): the same gate, the same argv, handed to macOS Terminal. */
  async external(name: string): Promise<{ opened: true }> {
    if (this.deps.fixture) {
      throw new HermeticError("UNSUPPORTED", "the fixture has no box to open a terminal on");
    }
    const { argv, binary } = await this.resolve(this.deps.hermetic(), name);
    const run =
      this.deps.openExternal ??
      ((full: string[]) => openInTerminal(full, { run: spawnRunner, timers: this.timers }));
    await run([binary, ...argv.slice(1)]);
    return { opened: true };
  }

  list(name?: string): TerminalSessionRow[] {
    const rows: TerminalSessionRow[] = [];
    for (const session of this.sessions.values()) {
      if (name === undefined || session.name === name) rows.push(session.row());
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name) || a.index - b.index);
  }

  /** D9: the sessions a quit would interrupt. */
  busySessions(): BusySession[] {
    const busy: BusySession[] = [];
    for (const session of this.sessions.values()) {
      const state = session.busy();
      if (!state.busy) continue;
      busy.push({
        name: session.name,
        index: session.index,
        ...(state.label !== undefined ? { label: state.label } : {}),
      });
    }
    return busy;
  }

  attach(sessionId: string, channel: TerminalChannel): TerminalAttach {
    return this.get(sessionId).attach(channel);
  }

  /** Names an attach by the stream id the page will ack with, until it ends. */
  track(streamId: string, attach: TerminalAttach): void {
    this.attaches.set(streamId, attach);
    void attach.done.then(() => {
      if (this.attaches.get(streamId) === attach) this.attaches.delete(streamId);
    });
  }

  /**
   * The tracked attach streams `owns` claims — one binding's, by its own stream
   * registry — so a reloaded page's dead attaches can be closed rather than
   * stall on credits nobody will ever ack for the rest of the session.
   */
  attachIds(owns: (streamId: string) => boolean): string[] {
    return [...this.attaches.keys()].filter(owns);
  }

  ack(streamId: string, gen: number, upto: number): void {
    this.attaches.get(streamId)?.ack(gen, upto);
  }

  /**
   * A keystroke chunk from one window. An unknown or ended session drops it:
   * the page will hear `exit`. Sequenced per window (`TerminalSession.write`).
   */
  input(windowKey: string, sessionId: string, inSeq: number, data: string | Uint8Array): void {
    this.sessions.get(sessionId)?.write(windowKey, inSeq, data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.get(sessionId).resize(cols, rows);
  }

  /**
   * End a session and drop it from the table. A live one is hung up (then
   * killed, `CLOSE_KILL_MS` on) and this resolves once its exit is handled.
   */
  async close(sessionId: string): Promise<{ closed: boolean }> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { closed: false };
    await session.close();
    this.drop(session);
    return { closed: true };
  }

  /** Shutdown: every live session hung up, synchronously (`shutdown.ts`). */
  stopAll(): void {
    for (const session of this.sessions.values()) {
      try {
        session.stop();
      } catch {
        // One session that will not stop must not keep the others running.
      }
    }
  }

  /**
   * What one window shows: a session id, or null for none. Any window
   * showing a session makes it visible; becoming visible marks its inbox
   * rows read and resolves its `output` condition.
   */
  view(windowKey: string, sessionId: string | null): void {
    const before = this.viewedSet();
    if (sessionId === null || !this.sessions.has(sessionId)) this.views.delete(windowKey);
    else this.views.set(windowKey, sessionId);
    const after = this.viewedSet();
    for (const id of new Set([...before, ...after])) {
      const now = after.has(id);
      if (before.has(id) === now) continue;
      const session = this.sessions.get(id);
      if (session === undefined) continue;
      session.view(now);
      if (now) this.resolveNotices(session, true);
    }
  }

  /**
   * The window has gone, or its page reloaded: whatever it showed is no longer
   * shown by it, and its keystroke sequences start over.
   */
  forgetWindow(windowKey: string): void {
    this.view(windowKey, null);
    for (const session of this.sessions.values()) session.forgetSender(windowKey);
  }

  private get(sessionId: string): TerminalSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new HermeticError("NOT_FOUND", `no terminal session ${sessionId}`, {
        session_id: sessionId,
      });
    }
    return session;
  }

  /**
   * Agent state, core's argv and the preflight gate. Shared by `open` and
   * `external`, so both refuse the same things with the same codes.
   */
  private async resolve(
    h: Hermetic,
    name: string,
  ): Promise<{ argv: string[]; binary: string; fleetId: string }> {
    const agent = await h.agents.get(name);
    if (AGENT_OFF.has(agent.status)) {
      throw new HermeticError(
        "TERMINAL_AGENT_OFF",
        `${name} is ${agent.status}; start it to open a terminal`,
        { name, status: agent.status },
      );
    }
    const argv = await h.ssh({ name });
    const preflight = this.deps.preflight ?? (() => h.init.localTailscale());
    const binary = gateTerminal(await preflight(), argv);
    const fleetId = h.target?.fleet_id;
    if (fleetId === undefined) {
      throw new HermeticError("NOT_INITIALIZED", "no fleet is configured on this Mac");
    }
    return { argv, binary, fleetId };
  }

  /**
   * D4, counting live sessions and opens in flight. Ended sessions hold a tab
   * but not a slot: the oldest makes room at commit (`makeRoom`), so
   * Reconnect at the cap works without a Close first.
   */
  private checkCaps(name: string): void {
    let agentLive = this.pending.get(name) ?? 0;
    let appLive = [...this.pending.values()].reduce((a, b) => a + b, 0);
    for (const session of this.sessions.values()) {
      if (!session.live) continue;
      appLive++;
      if (session.name === name) agentLive++;
    }
    if (agentLive >= SESSIONS_PER_AGENT) {
      throw new HermeticError(
        "TERMINAL_LIMIT",
        `${name} already has ${SESSIONS_PER_AGENT} terminal sessions; end one first`,
        { scope: "agent", limit: SESSIONS_PER_AGENT, name },
      );
    }
    if (appLive >= SESSIONS_PER_APP) {
      throw new HermeticError(
        "TERMINAL_LIMIT",
        `${SESSIONS_PER_APP} terminal sessions are open; end one first`,
        { scope: "app", limit: SESSIONS_PER_APP },
      );
    }
  }

  /** Drops the oldest ended sessions until this open fits in both caps. */
  private makeRoom(name: string): void {
    const ended = (filter: (s: TerminalSession) => boolean) =>
      [...this.sessions.values()].find((s) => !s.live && filter(s));
    while ([...this.sessions.values()].filter((s) => s.name === name).length >= SESSIONS_PER_AGENT) {
      const oldest = ended((s) => s.name === name);
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    while (this.sessions.size >= SESSIONS_PER_APP) {
      const oldest = ended(() => true);
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  private freeIndex(name: string): number {
    const used = new Set(
      [...this.sessions.values()].filter((s) => s.name === name).map((s) => s.index),
    );
    for (let i = 1; i <= SESSIONS_PER_AGENT; i++) if (!used.has(i)) return i;
    // `makeRoom` left fewer than the cap; unreachable unless that changes.
    return used.size + 1;
  }

  private drop(session: TerminalSession): void {
    if (!this.sessions.delete(session.id)) return;
    for (const [window, id] of this.views) if (id === session.id) this.views.delete(window);
    session.dispose();
    this.resolveNotices(session, false);
  }

  private viewedSet(): Set<string> {
    return new Set(this.views.values());
  }

  private viewed(sessionId: string): boolean {
    return this.viewedSet().has(sessionId);
  }

  private raise(session: TerminalSession, event: AttentionEvent): void {
    try {
      terminalNotices(this.deps.hermetic()).raise({
        fleet_id: session.fleetId,
        agent: session.name,
        session_id: session.id,
        session_index: session.index,
        event: event.event,
        ...(event.program !== undefined ? { program: event.program } : {}),
        ...(event.exit_code !== undefined ? { exit_code: event.exit_code } : {}),
        ...(event.ran_ms !== undefined ? { ran_ms: Math.round(event.ran_ms) } : {}),
      });
    } catch (e) {
      this.warn("terminal notice failed", e);
    }
  }

  private resolveNotices(session: TerminalSession, read: boolean): void {
    try {
      terminalNotices(this.deps.hermetic()).resolve({
        fleet_id: session.fleetId,
        session_id: session.id,
        read,
      });
    } catch (e) {
      this.warn("terminal notice resolve failed", e);
      return;
    }
    // The badge counts read and resolved rows; without this it would stay
    // stale until the next one-minute tick.
    this.flush();
  }

  private flush(): void {
    try {
      this.deps.flush?.();
    } catch (e) {
      this.warn("notification flush failed", e);
    }
  }

  /** Core's message and nothing else: it names the event, never a byte of the session. */
  private warn(message: string, e: unknown): void {
    this.deps.log?.line("warn", "terminal", message, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
