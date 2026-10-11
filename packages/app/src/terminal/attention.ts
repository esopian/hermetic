/**
 * When a terminal session nobody is looking at deserves a notification (D10,
 * issue #18).
 *
 * Pure rules over injected inputs: output bytes, the shell's markers (through
 * `ActivitySource`), the bell, the session's exit and whether any window shows
 * the session. What to say and where it lands is core's (`notifyTerminalEvent`,
 * bound to `raise` by the host); this module only decides *that* something
 * happened, and passes along nothing but the event kind, the sanitized program
 * name, an exit code and a run time — never a byte of output, never the cursor
 * line it matched.
 *
 * The rules, each validated against the probe's eight scenarios
 * (`test/terminal/attention.test.ts`):
 *
 *   output        printable output after the 2 s grace, once per absence
 *   finished      a command line that ran ≥ 10 s ended
 *   input         a running command went quiet ≥ 3 s on a line that looks
 *                 like a question, once per command
 *   bell          BEL
 *   disconnected  the session ended without the shell's `exit` or the user's
 *                 End while nobody was looking
 *
 * `output` is a condition (one keyed row per session in core), bounded by the
 * once-per-absence latch; the other four are events, each at most once per
 * session per 30 s.
 */
import { type ShellMarker, sanitizeProgramName } from "@hermetic/core/shared";
import type { ActivitySource } from "./activity.ts";
import type { TimerHandle, Timers } from "./timers.ts";

export type AttentionEventKind = "output" | "finished" | "input" | "bell" | "disconnected";

export interface AttentionEvent {
  event: AttentionEventKind;
  /** `sanitizeProgramName` of the running command line; null when it did not pass. */
  program?: string | null;
  exit_code?: number;
  ran_ms?: number;
}

export interface AttentionDeps {
  timers: Timers;
  activity: ActivitySource;
  /** The mirror's cursor line, read only when the input rule asks. */
  cursorLine(): string;
  /** The `terminal_alerts` setting, read at the moment of raising. */
  alertsOn(): boolean;
  raise(event: AttentionEvent): void;
  /** The poller's notification flush, so the page hears now and not on the next tick. */
  flush(): void;
}

/** Output this soon after leaving is the tail of what the operator just watched. */
export const GRACE_MS = 2000;
/** A command must have run this long for its end to be news. */
export const FINISHED_MIN_MS = 10_000;
/** Busy and this quiet on a question-shaped line: probably waiting for an answer. */
export const INPUT_QUIET_MS = 3000;
/** Each event kind, per session. */
export const EVENT_GAP_MS = 30_000;
/** A line that reads like something wants an answer. Matched in memory, never kept. */
export const INPUT_PROMPT_RE = /(\[y\/n\]|\(yes\/no\)|password|passphrase|continue\?|\?\s*$|:\s*$)/i;

/** An escape sequence cut off at a chunk boundary is carried this far, no further. */
const MAX_CARRY = 4096;

/**
 * Whether a chunk of output holds anything a person would see.
 *
 * Stateful only to survive a chunk boundary: a UTF-8 sequence or an escape
 * sequence split across two reads is completed from the next one, so the tail
 * of an OSC 133 marker is never mistaken for text. What is carried is bounded
 * and dropped once the sequence ends.
 */
export class PrintableScanner {
  private readonly decoder = new TextDecoder();
  private carry = "";

  scan(bytes: Uint8Array | string): boolean {
    const text =
      this.carry + (typeof bytes === "string" ? bytes : this.decoder.decode(bytes, { stream: true }));
    this.carry = "";
    let i = 0;
    let seen = false;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code !== 0x1b) {
        // Whitespace, C0, DEL and C1 are not something to look at.
        if (!seen && code > 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
          if (!/\s/.test(text[i] ?? "")) seen = true;
        }
        i += 1;
        continue;
      }
      const end = escapeEnd(text, i);
      if (end === -1) {
        const rest = text.slice(i);
        if (rest.length <= MAX_CARRY) this.carry = rest;
        break;
      }
      i = end;
    }
    return seen;
  }
}

/**
 * Index just past the escape sequence starting at `start`, or -1 when the
 * chunk ends inside it. CSI and OSC (and the string sequences DCS, APC, PM,
 * SOS, which xterm swallows the same way), plus the two-byte ESC forms.
 */
function escapeEnd(text: string, start: number): number {
  const kind = text[start + 1];
  if (kind === undefined) return -1;
  if (kind === "[") {
    for (let j = start + 2; j < text.length; j += 1) {
      const c = text.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j + 1;
    }
    return -1;
  }
  if (kind === "]" || kind === "P" || kind === "_" || kind === "^" || kind === "X") {
    for (let j = start + 2; j < text.length; j += 1) {
      if (text[j] === "\x07") return j + 1;
      if (text[j] === "\x1b") {
        if (j + 1 >= text.length) return -1;
        if (text[j + 1] === "\\") return j + 2;
      }
    }
    return -1;
  }
  // Charset designation takes one more byte (`ESC ( B`); the rest are two bytes.
  if ("()*+-./#%".includes(kind)) return start + 3 <= text.length ? start + 3 : -1;
  return start + 2;
}

const THROTTLED: ReadonlySet<AttentionEventKind> = new Set([
  "finished",
  "input",
  "bell",
  "disconnected",
]);

export class Attention {
  private readonly deps: AttentionDeps;
  private readonly scanner = new PrintableScanner();
  private readonly unsubscribe: () => void;
  private visible: boolean;
  private leftAt = 0;
  /** One `output` per absence; re-armed only by looking again. */
  private outputRaised = false;
  private lastOutputAt: number;
  /** The running command line: when it started and what it is. */
  private running: { since: number; cmd: string | undefined } | null = null;
  private inputRaised = false;
  private inputTimer: TimerHandle | null = null;
  private readonly lastRaised = new Map<AttentionEventKind, number>();
  private ended = false;

  constructor(deps: AttentionDeps, opts: { visible?: boolean } = {}) {
    this.deps = deps;
    this.visible = opts.visible ?? true;
    this.lastOutputAt = deps.timers.now();
    this.unsubscribe = deps.activity.onMarker((marker) => this.marker(marker));
  }

  /** Raw session output, in arrival order — before the mirror parses it. */
  output(bytes: Uint8Array | string): void {
    if (this.ended || !this.scanner.scan(bytes)) return;
    const now = this.deps.timers.now();
    this.lastOutputAt = now;
    this.scheduleInputCheck();
    // With the integration live, only a running command's output is news: the
    // prompt redrawn after it is not. With activity unknown, all of it counts.
    const { state, cmd } = this.deps.activity.activity;
    if (this.deps.activity.nonce !== null && state === "idle") return;
    if (this.visible || this.outputRaised || now - this.leftAt < GRACE_MS) return;
    const program = state === "busy" ? sanitizeProgramName(cmd) : null;
    if (this.raise({ event: "output", program })) this.outputRaised = true;
  }

  bell(): void {
    if (this.ended) return;
    this.raise({ event: "bell", program: this.programNow() });
  }

  /**
   * The session ended. `clean` is the shell's own `exit` or the operator's
   * End/close; anything else while nobody was looking is a disconnect.
   */
  exit(opts: { clean: boolean }): void {
    if (this.ended) return;
    if (!opts.clean) this.raise({ event: "disconnected" });
    this.dispose();
  }

  /** Whether any window shows this session right now. */
  view(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) {
      this.outputRaised = false;
      return;
    }
    this.leftAt = this.deps.timers.now();
    // A question already on screen still counts once nobody is looking at it.
    this.scheduleInputCheck();
  }

  dispose(): void {
    this.ended = true;
    this.unsubscribe();
    this.cancelInputCheck();
  }

  private marker(marker: ShellMarker): void {
    if (this.ended) return;
    const now = this.deps.timers.now();
    if (marker.kind === "C") {
      this.running = { since: now, cmd: marker.cmd };
      this.inputRaised = false;
      this.lastOutputAt = now;
      this.scheduleInputCheck();
      return;
    }
    if (marker.kind === "D" && this.running !== null) {
      const ran = now - this.running.since;
      const program = sanitizeProgramName(this.running.cmd);
      this.running = null;
      this.cancelInputCheck();
      if (ran >= FINISHED_MIN_MS) {
        this.raise({
          event: "finished",
          program,
          ran_ms: ran,
          ...(marker.exit !== undefined ? { exit_code: marker.exit } : {}),
        });
      }
      return;
    }
    if (marker.kind === "A") {
      // A prompt with no `D` before it (a shell that just started, or a
      // nested one exiting) ends whatever was running all the same.
      this.running = null;
      this.cancelInputCheck();
    }
  }

  /**
   * The input rule runs on a timer rather than a poll: it can only become true
   * `INPUT_QUIET_MS` after the last output, so one timer is armed for that
   * moment and re-armed by every output, command start and departure.
   */
  private scheduleInputCheck(): void {
    this.cancelInputCheck();
    if (this.running === null || this.inputRaised || this.visible || this.ended) return;
    const due = Math.max(0, this.lastOutputAt + INPUT_QUIET_MS - this.deps.timers.now());
    this.inputTimer = this.deps.timers.setTimeout(() => {
      this.inputTimer = null;
      this.checkInput();
    }, due);
  }

  private cancelInputCheck(): void {
    if (this.inputTimer === null) return;
    this.deps.timers.clearTimeout(this.inputTimer);
    this.inputTimer = null;
  }

  private checkInput(): void {
    if (this.running === null || this.inputRaised || this.visible || this.ended) return;
    if (this.deps.timers.now() - this.lastOutputAt < INPUT_QUIET_MS) return;
    // Read, tested and dropped: the line can hold anything the remote printed.
    if (!INPUT_PROMPT_RE.test(this.deps.cursorLine())) return;
    if (this.raise({ event: "input", program: sanitizeProgramName(this.running.cmd) })) {
      this.inputRaised = true;
    }
  }

  private programNow(): string | null {
    return this.running === null ? null : sanitizeProgramName(this.running.cmd);
  }

  /** The gates every rule shares. True when the event was handed to `raise`. */
  private raise(event: AttentionEvent): boolean {
    if (this.visible || !this.deps.alertsOn()) return false;
    const now = this.deps.timers.now();
    if (THROTTLED.has(event.event)) {
      const last = this.lastRaised.get(event.event);
      if (last !== undefined && now - last < EVENT_GAP_MS) return false;
      this.lastRaised.set(event.event, now);
    }
    this.deps.raise(event);
    this.deps.flush();
    return true;
  }
}
