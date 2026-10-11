/**
 * One terminal session: a PTY and everything that watches it (issue #18).
 *
 * The host (`host.ts`) owns the table and the policy — caps, the preflight,
 * which window is looking at what. This is one row of that table, and it is
 * the wiring the transport units were built to be put together with:
 *
 *     pty ──onData──▶ attention.output ─▶ mirror.write ─▶ broadcaster.push
 *                                            │
 *                         activity (OSC 133) ┘  bell ─▶ attention.bell
 *
 * Attention sees each chunk *before* the mirror parses it, so a command's
 * output and the `D` marker that ends it arrive in the order the rules expect
 * (`attention.ts`). The broadcaster is pushed the offset the mirror returned,
 * which is what lets an attach's snapshot-plus-tail meet the live pushes
 * exactly (`channel.ts`).
 *
 * Nothing here keeps a byte of output or input. The mirror's screen is the
 * only copy, in memory, and the one place this module reads it — the ACL
 * check at exit — tests a few lines against a pattern and drops them.
 */
import { sanitizeProgramName } from "@hermetic/core/shared";
import type { Activity } from "./activity.ts";
import { ShellActivity } from "./activity.ts";
import { Attention, type AttentionEvent, PrintableScanner } from "./attention.ts";
import {
  type TerminalAttach,
  type TerminalChannel,
  type TerminalExitInfo,
  type TerminalExitReason,
  TerminalBroadcaster,
} from "./channel.ts";
import { InputSequencer } from "./input.ts";
import { Mirror } from "./mirror.ts";
import type { PtyExit, PtyLike, PtySignal } from "./pty.ts";
import type { TimerHandle, Timers } from "./timers.ts";
import type { AppLog } from "../log.ts";

/** What `tailscale ssh` prints when the tailnet policy has no `ssh` rule for this user. */
export const ACL_DENIED_RE = /tailnet policy does not permit|not allowed to ssh/i;
/** The ssh client's own failure status: what a refused connection exits with. */
export const ACL_EXIT_CODE = 255;
/**
 * What `nologin` prints when the login account has no shell: a box whose
 * `hermes` account predates the login shell (§9.3) and has not yet run a
 * hermeticd that sets it. Tailscale lets the login through, so the session
 * shows the MOTD and then ends with an ordinary status, not 255.
 */
export const NO_LOGIN_SHELL_RE = /This account is currently not available/;
/** A refusal comes at connect time; a 255 after this long is something else. */
export const ACL_WINDOW_MS = 10_000;
/** Between the hangup `close` sends and the kill that follows it. */
export const CLOSE_KILL_MS = 2000;
/** Screen lines the ACL check reads from the bottom of the mirror. */
const ACL_TAIL_LINES = 24;

/** Who asked for the session to end, when somebody did. */
type EndRequest = "closed" | "shutdown";

/** One row of `terminal.list`. */
export interface TerminalSessionRow {
  session_id: string;
  /** 1–3, the lowest free per agent at open; what the UI calls `session 1`. */
  index: number;
  name: string;
  started_at: string;
  state: "live" | "ended";
  exit?: TerminalExitInfo;
  activity: Activity;
  /** Printable output arrived while no window was looking at the session. */
  unseen: boolean;
}

/**
 * Why a session ended, from what is known at the moment its process exited.
 * Pure, so each branch is a test rather than a timing.
 *
 * The ACL branch needs all three: a 255 alone is any ssh failure, the text
 * alone could be something the operator `cat`-ed, and the window is what makes
 * it a refusal at connect rather than a remote command that happened to print
 * those words. The login-shell branch is the same idea without the status:
 * `nologin`'s words within the window, whatever the ssh client exited with.
 */
export function exitReason(input: {
  requested: EndRequest | null;
  code: number | null;
  signal: string | null;
  ranMs: number;
  tail: () => string;
  /** The integration saw the operator type `exit`/`logout` (`endedByShellExit`). */
  shellExit?: boolean;
}): TerminalExitReason {
  if (input.requested !== null) return input.requested;
  if (input.code === ACL_EXIT_CODE && input.ranMs < ACL_WINDOW_MS && ACL_DENIED_RE.test(input.tail())) {
    return "acl_denied";
  }
  if (input.ranMs < ACL_WINDOW_MS && NO_LOGIN_SHELL_RE.test(input.tail())) return "no_login_shell";
  // A signal, or no status at all, is the client being killed under the
  // operator: never a shell that chose to end.
  if (input.signal !== null || input.code === null) return "disconnected";
  // ssh reserves 255 for its own failures (the connection dropped, the box went
  // away), so a 255 is a disconnect unless the shell integration saw the
  // operator type `exit 255` themselves. Any other status is the remote
  // shell's own — `exit 1`, or Ctrl-D after a failed command — and that shell
  // ended because it was told to.
  if (input.code === ACL_EXIT_CODE) return input.shellExit ? "exited" : "disconnected";
  return "exited";
}

/** Programs that end the login shell when typed at its prompt. */
const SHELL_EXIT_PROGRAMS = new Set(["exit", "logout"]);

/**
 * Whether the last command line the shell integration saw start was the shell's
 * own `exit`: a `C` marker with no `D` after it, because the shell is gone.
 */
export function endedByShellExit(activity: Activity): boolean {
  if (activity.state !== "busy" || activity.cmd === undefined) return false;
  const program = sanitizeProgramName(activity.cmd);
  return program !== null && SHELL_EXIT_PROGRAMS.has(program);
}

/** The bottom of the screen as text, for one test against a pattern. Never kept. */
export function mirrorTail(mirror: Mirror, lines = ACL_TAIL_LINES): string {
  const buffer = mirror.terminal.buffer.active;
  const last = buffer.baseY + buffer.cursorY;
  const out: string[] = [];
  for (let y = Math.max(0, last - lines + 1); y <= last; y++) {
    out.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  return out.join("\n");
}

export interface TerminalSessionOptions {
  id: string;
  name: string;
  index: number;
  fleetId: string;
  pty: PtyLike;
  cols: number;
  rows: number;
  timers: Timers;
  /** Whether any window shows this session as it starts. */
  visible: boolean;
  startedAt: string;
  /** The `terminal_alerts` setting, read at the moment of raising. */
  alertsOn(): boolean;
  /** Hands an attention event to core's inbox (`terminalNotices`). Must not throw. */
  raise(event: AttentionEvent): void;
  /** The poller's notification flush. Must not throw. */
  flush(): void;
  log?: AppLog;
}

export class TerminalSession {
  readonly id: string;
  readonly name: string;
  readonly index: number;
  readonly fleetId: string;
  readonly startedAt: string;
  /** Settles once the exit has been handled: frames sent, attention told, logged. Never rejects. */
  readonly ended: Promise<TerminalExitInfo>;
  private readonly startedMs: number;
  private readonly pty: PtyLike;
  private readonly mirror: Mirror;
  private readonly activity: ShellActivity;
  private readonly attention: Attention;
  private readonly broadcaster: TerminalBroadcaster;
  /**
   * One keystroke sequence per sender (a window's page). Each page counts
   * `in_seq` from 0 on its own, so two windows typing into one session through
   * a shared sequencer would collide: B's first chunk would reset A's count
   * and hold A's next one as out of order.
   */
  private readonly inputs = new Map<string, InputSequencer>();
  private readonly timers: Timers;
  private readonly log: AppLog | undefined;
  /** A second scanner, because "unseen" and attention's "new output" are different latches. */
  private readonly unseenScanner = new PrintableScanner();
  private readonly unsubscribeBell: () => void;
  private visible: boolean;
  private unseen = false;
  private requested: EndRequest | null = null;
  private exitInfo: TerminalExitInfo | null = null;
  private killTimer: TimerHandle | null = null;
  private disposed = false;

  constructor(options: TerminalSessionOptions) {
    this.id = options.id;
    this.name = options.name;
    this.index = options.index;
    this.fleetId = options.fleetId;
    this.startedAt = options.startedAt;
    this.pty = options.pty;
    this.timers = options.timers;
    this.log = options.log;
    this.visible = options.visible;
    this.startedMs = options.timers.now();

    this.mirror = new Mirror({
      cols: options.cols,
      rows: options.rows,
      valve: (sig) => this.signal(sig),
    });
    this.activity = new ShellActivity(this.mirror.terminal);
    // Built visible and then told otherwise, so a session nobody is looking at
    // yet starts its 2 s grace now: the login banner is not "new output".
    this.attention = new Attention(
      {
        timers: options.timers,
        activity: this.activity,
        cursorLine: () => this.mirror.cursorLine(),
        alertsOn: options.alertsOn,
        raise: options.raise,
        flush: options.flush,
      },
      { visible: true },
    );
    if (!options.visible) this.attention.view(false);
    this.broadcaster = new TerminalBroadcaster({ source: this.mirror, timers: options.timers });
    this.unsubscribeBell = this.mirror.onBell(() => this.attention.bell());
    this.pty.onData((bytes) => this.data(bytes));
    this.ended = this.pty.exited.then(
      (exit) => this.finish(exit),
      // `exited` never rejects (`pty.ts`); this is the type's due, not a path.
      () => this.finish({ code: null, signal: null }),
    );
  }

  get live(): boolean {
    return this.exitInfo === null;
  }

  get exit(): TerminalExitInfo | null {
    return this.exitInfo;
  }

  row(): TerminalSessionRow {
    return {
      session_id: this.id,
      index: this.index,
      name: this.name,
      started_at: this.startedAt,
      state: this.exitInfo === null ? "live" : "ended",
      ...(this.exitInfo !== null ? { exit: this.exitInfo } : {}),
      // An ended session has nothing running; "unknown" rather than a last
      // `busy` that would read as work still in flight.
      activity: this.exitInfo === null ? this.activity.activity : { state: "unknown" },
      unseen: this.unseen,
    };
  }

  /** D9: whether quitting now would lose work in this session. */
  busy(): { busy: boolean; label?: string } {
    if (this.exitInfo !== null || this.requested !== null) return { busy: false };
    return this.activity.busyForQuit();
  }

  attach(channel: TerminalChannel): TerminalAttach {
    return this.broadcaster.attach(channel);
  }

  /** One keystroke chunk from one sender (a window), in its `in_seq` place. */
  write(sender: string, inSeq: number, data: string | Uint8Array): void {
    if (this.exitInfo !== null) return;
    let input = this.inputs.get(sender);
    if (input === undefined) {
      input = new InputSequencer({
        apply: (chunk) => {
          if (this.exitInfo === null && this.requested === null) this.pty.write(chunk);
        },
        // To every attach: the broadcaster cannot tell which page sent what.
        // A page reads `in_seq` against its own count, so it may see another
        // window's refusal; that costs a stray notice, never a keystroke.
        error: (seq, code) => this.broadcaster.inputError(seq, code),
      });
      this.inputs.set(sender, input);
    }
    input.accept(inSeq, data);
  }

  /** The sender has gone (its window closed or its page reloaded): its sequence with it. */
  forgetSender(sender: string): void {
    this.inputs.delete(sender);
  }

  resize(cols: number, rows: number): void {
    if (this.exitInfo !== null) return;
    this.pty.resize(cols, rows);
    this.mirror.resize(cols, rows);
  }

  /** Whether any window shows this session now. Looking clears `unseen`. */
  view(visible: boolean): void {
    this.visible = visible;
    if (visible) this.unseen = false;
    if (this.exitInfo === null) this.attention.view(visible);
  }

  /**
   * The operator's End: a hangup to the whole group, then a kill if the group
   * is still there `CLOSE_KILL_MS` later. Resolves with the exit once it has
   * been handled. Calling it again, or on an ended session, just waits.
   */
  close(): Promise<TerminalExitInfo> {
    if (this.exitInfo === null && this.requested === null) {
      this.requested = "closed";
      this.hangup();
      this.killTimer = this.timers.setTimeout(() => {
        this.killTimer = null;
        this.signal("SIGKILL");
        this.closePty();
      }, CLOSE_KILL_MS);
    }
    return this.ended;
  }

  /**
   * The app is quitting: everything synchronous, because nothing after this
   * gets to wait. The hangup goes to the group and the PTY is closed, which is
   * a second hangup from the kernel; every attach is told `shutdown` now
   * rather than after an exit this process will not live to handle.
   */
  stop(): void {
    if (this.exitInfo !== null) return;
    this.requested ??= "shutdown";
    this.hangup();
    this.closePty();
    this.broadcaster.exit({ code: null, signal: "SIGHUP", reason: "shutdown" });
  }

  /** Frees the mirror. Only for a session that has ended and is leaving the table. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.killTimer !== null) this.timers.clearTimeout(this.killTimer);
    this.killTimer = null;
    this.attention.dispose();
    this.activity.dispose();
    this.unsubscribeBell();
    this.broadcaster.closeAll();
    this.mirror.dispose();
  }

  private data(bytes: Uint8Array): void {
    if (this.disposed) return;
    // Every chunk goes through the scanner, so an escape split across reads
    // is completed rather than mistaken for text on the next one.
    if (this.unseenScanner.scan(bytes) && !this.visible) this.unseen = true;
    this.attention.output(bytes);
    this.broadcaster.push(bytes, this.mirror.write(bytes));
  }

  private async finish(exit: PtyExit): Promise<TerminalExitInfo> {
    try {
      // The last screen is the whole screen: an attach that stalled resyncs on
      // it, and the ACL check reads it.
      await this.mirror.drained();
    } catch {
      // A mirror that cannot drain still lets the session end.
    }
    if (this.killTimer !== null) this.timers.clearTimeout(this.killTimer);
    this.killTimer = null;
    const ranMs = this.timers.now() - this.startedMs;
    const reason = exitReason({
      requested: this.requested,
      code: exit.code,
      signal: exit.signal,
      ranMs,
      tail: () => (this.disposed ? "" : mirrorTail(this.mirror)),
      shellExit: endedByShellExit(this.activity.activity),
    });
    const info: TerminalExitInfo = { code: exit.code, signal: exit.signal, reason };
    this.exitInfo = info;
    this.attention.exit({ clean: reason === "exited" || reason === "closed" || reason === "shutdown" });
    this.broadcaster.exit(info);
    this.log?.line("info", "terminal", "session ended", {
      session: this.id,
      code: exit.code,
      signal: exit.signal,
      reason,
      duration_ms: Math.round(ranMs),
    });
    return info;
  }

  /** SIGHUP, and SIGCONT after it if the valve holds the group stopped: a stopped process does not act on a hangup. */
  private hangup(): void {
    this.signal("SIGHUP");
    if (this.mirror.stopped) this.signal("SIGCONT");
  }

  private signal(sig: PtySignal): void {
    try {
      this.pty.signalGroup(sig);
    } catch {
      // A group we cannot signal is a group we cannot help; the exit still comes.
    }
  }

  private closePty(): void {
    try {
      this.pty.close();
    } catch {
      // Already closed.
    }
  }
}
