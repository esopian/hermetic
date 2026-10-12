/**
 * What the remote shell is doing, read out of the session's own output
 * (issue #18).
 *
 * The box sources core's `SHELL_INTEGRATION_SCRIPT` into every interactive
 * bash, which prints OSC 133 markers: `A` when a prompt is drawn, `C` when a
 * command line starts, `D` when it finishes. This module registers the OSC
 * handler on the session's headless xterm (the mirror's) and turns the markers
 * into one of three states:
 *
 *   busy     a command line is running, or the prompt reports background jobs
 *            that would die on hangup
 *   idle     at a prompt, nothing to lose
 *   unknown  no marker yet, or the shell's DEBUG trap was replaced (`pre=0`):
 *            the integration can no longer see commands start, so a prompt
 *            proves nothing
 *
 * Everything the remote side prints reaches this parser, including whatever a
 * running command chooses to print — so a marker is believed only when it
 * carries the nonce the session's first prompt carried. The nonce is minted
 * per login on the box and never shown; a program that prints a forged "idle"
 * marker to silence the quit prompt does not know it.
 *
 * Nothing here stores session bytes: the parser sees the marker payload only,
 * and keeps the state and the short `cmd` field the script already trimmed to
 * program plus first argument.
 */
import { Terminal } from "@xterm/headless";
import {
  DETACHABLE_PROGRAMS,
  SHELL_MARKER_OSC,
  type ShellMarker,
  parseShellMarker,
  sanitizeProgramName,
} from "@hermetic/core/shared";

export type ActivityState = "busy" | "idle" | "unknown";

export interface Activity {
  state: ActivityState;
  /** The running command line, program and first argument only. Set while busy in one. */
  cmd?: string;
  /** Background jobs at the last prompt. Set while busy because of them. */
  jobs?: number;
}

/** What `attention.ts` reads: the state, whether a nonce is pinned, and the accepted markers. */
export interface ActivitySource {
  readonly nonce: string | null;
  readonly activity: Activity;
  onMarker(cb: (marker: ShellMarker) => void): () => void;
}

/** The scrollback the mirror keeps (D2). Exported so the seam test builds the same terminal. */
export const MIRROR_SCROLLBACK = 5000;

/**
 * A headless xterm as the session mirror builds one. `allowProposedApi`
 * because the serialize addon needs it; the OSC handler does not.
 */
export function createHeadlessTerminal(cols: number, rows: number): Terminal {
  return new Terminal({ cols, rows, scrollback: MIRROR_SCROLLBACK, allowProposedApi: true });
}

/**
 * The text of the line the cursor is on, without the blank cells nothing
 * wrote — what the "may be
 * waiting for input" rule matches. Read on demand and handed straight to the
 * caller; never kept.
 */
export function readCursorLine(term: Terminal): string {
  const buf = term.buffer.active;
  return buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
}

const DETACHABLE: ReadonlySet<string> = new Set(DETACHABLE_PROGRAMS);

/**
 * How a busy session is named in the quit prompt: the program, plus its first
 * argument only when that too reads as a plain word (`apt upgrade`, but
 * `export` for `export TOKEN=x`). Null when even the program does not pass.
 */
export function commandLabel(cmd: string | undefined): string | null {
  const program = sanitizeProgramName(cmd);
  if (program === null || cmd === undefined) return null;
  const words = cmd.trim().split(/\s+/);
  const arg = words[words.indexOf(program) + 1];
  return arg !== undefined && sanitizeProgramName(arg) !== null ? `${program} ${arg}` : program;
}

function sameActivity(a: Activity, b: Activity): boolean {
  return a.state === b.state && a.cmd === b.cmd && a.jobs === b.jobs;
}

export class ShellActivity implements ActivitySource {
  private pinned: string | null = null;
  private current: Activity = { state: "unknown" };
  private readonly changeListeners = new Set<(activity: Activity) => void>();
  private readonly markerListeners = new Set<(marker: ShellMarker) => void>();
  private readonly handler: { dispose(): void };

  constructor(term: Terminal) {
    this.handler = term.parser.registerOscHandler(SHELL_MARKER_OSC, (data) => {
      this.accept(data);
      // Consumed either way: a 133 sequence never has anything to draw.
      return true;
    });
  }

  /** The nonce the session's first prompt carried, or null before one was seen. */
  get nonce(): string | null {
    return this.pinned;
  }

  get activity(): Activity {
    return { ...this.current };
  }

  /** Called on every state change, not on a marker that leaves the state as it was. */
  onChange(cb: (activity: Activity) => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  /** Called for every accepted marker (the right nonce), after the state has moved. */
  onMarker(cb: (marker: ShellMarker) => void): () => void {
    this.markerListeners.add(cb);
    return () => this.markerListeners.delete(cb);
  }

  /**
   * Whether closing this session would lose work (D9). A foreground tmux or
   * screen survives the hangup — that is why it was started — so it does not
   * count; background jobs do, since bash sends them the hangup too.
   */
  busyForQuit(): { busy: boolean; label?: string } {
    const { state, cmd, jobs } = this.current;
    if (state !== "busy") return { busy: false };
    if (jobs !== undefined && jobs > 0) {
      return { busy: true, label: jobs === 1 ? "1 background job" : `${jobs} background jobs` };
    }
    const program = sanitizeProgramName(cmd);
    if (program !== null && DETACHABLE.has(program)) return { busy: false };
    const label = commandLabel(cmd);
    return label === null ? { busy: true } : { busy: true, label };
  }

  dispose(): void {
    this.handler.dispose();
    this.changeListeners.clear();
    this.markerListeners.clear();
  }

  private accept(data: string): void {
    const marker = parseShellMarker(data);
    if (marker === null) return;
    // The first prompt pins the nonce; until then nothing is believed, since a
    // command line cannot have started before the shell drew a prompt.
    if (this.pinned === null && marker.kind === "A" && marker.nonce) this.pinned = marker.nonce;
    if (this.pinned === null || marker.nonce !== this.pinned) return;

    const next = this.transition(marker);
    if (next !== null && !sameActivity(next, this.current)) {
      this.current = next;
      for (const cb of this.changeListeners) cb({ ...next });
    }
    for (const cb of this.markerListeners) cb(marker);
  }

  /** The state a marker moves to; null for `D`, which the next `A` settles. */
  private transition(marker: ShellMarker): Activity | null {
    if (marker.kind === "C") {
      return marker.cmd === undefined ? { state: "busy" } : { state: "busy", cmd: marker.cmd };
    }
    if (marker.kind === "A") {
      if (marker.pre === false) return { state: "unknown" };
      if (marker.jobs !== undefined && marker.jobs > 0) return { state: "busy", jobs: marker.jobs };
      return { state: "idle" };
    }
    return null;
  }
}
