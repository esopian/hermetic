/**
 * The in-app terminal's page-side rules (issue #18), pure so each is a unit
 * test rather than a timing: how keystrokes are cut up, when parsed output is
 * acked, which frames a screen keeps, and how a session is labelled.
 *
 * The other half of each rule is the app's (`app/src/terminal/`): the input
 * sequencer that refuses an oversize chunk, the credit window an ack opens,
 * the snapshot generation a resync bumps. The numbers here are the page's
 * side of those contracts, restated because the UI may not import the app.
 */
import { sanitizeProgramName } from "@hermetic/core/shared";

/** Largest keystroke chunk the app applies: UTF-16 code units for text, bytes for binary (`INPUT_CHUNK_MAX`). */
export const INPUT_CHUNK = 16 * 1024;
/** Parsed output between two acks. Well under the app's 128 KiB resume line, so a caught-up page always resumes. */
export const ACK_EVERY = 32 * 1024;
/** A sub-tab title, at most. */
export const TITLE_MAX = 24;
/** The pane's size settles this long before the PTY is told. */
export const RESIZE_DEBOUNCE_MS = 100;
/** A bell is a tab flash this long. */
export const BELL_FLASH_MS = 150;
/** D4: sessions per agent (`SESSIONS_PER_AGENT` in the app's host). */
export const SESSIONS_PER_AGENT = 3;
/** The size a session opens at when the pane cannot be measured (a test, a hidden pane). */
export const FALLBACK_SIZE = { cols: 120, rows: 32 } as const;

/**
 * Statuses with no box to log in to — the app's `AGENT_OFF`, which refuses
 * `terminal.open` with `TERMINAL_AGENT_OFF`. Restated so the section can show
 * the panel instead of offering a Connect that would only be refused.
 */
const AGENT_OFF = new Set(["stopping", "stopped", "destroying", "destroyed"]);

export function terminalAgentOff(status: string): boolean {
  return AGENT_OFF.has(status);
}

/* ── input ───────────────────────────────────────────────────────────────── */

/**
 * Text keystrokes (a paste, usually) in chunks of at most `max` UTF-16 code
 * units, in order, never splitting a surrogate pair — half an emoji in each
 * chunk would reach the PTY as two replacement characters.
 */
export function chunkText(data: string, max = INPUT_CHUNK): string[] {
  if (data.length <= max) return data.length === 0 ? [] : [data];
  const out: string[] = [];
  let at = 0;
  while (at < data.length) {
    let end = Math.min(at + max, data.length);
    const last = data.charCodeAt(end - 1);
    // A high surrogate at the cut belongs with the low one after it.
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(data.slice(at, end));
    at = end;
  }
  return out;
}

/**
 * xterm's `onBinary` payload — a string whose every char is one byte (mouse
 * reports in the X10 encoding, mostly) — as base64 chunks of at most `max`
 * bytes each.
 */
export function chunkBinary(data: string, max = INPUT_CHUNK): string[] {
  const out: string[] = [];
  for (let at = 0; at < data.length; at += max) {
    let bin = "";
    for (const ch of data.slice(at, at + max)) bin += String.fromCharCode(ch.charCodeAt(0) & 0xff);
    out.push(btoa(bin));
  }
  return out;
}

/** A frame's base64 payload as the bytes xterm parses. */
export function bytesOf(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ── one attach's frames ─────────────────────────────────────────────────── */

/**
 * The page's ledger for one attach: which screen generation it is drawing,
 * how far into the stream it has received and parsed, and when to ack.
 *
 * - A `snapshot` starts a generation. One older than the current is a screen
 *   the app has already replaced, and is dropped; so is any `data` frame not
 *   on the current generation.
 * - A snapshot after the first is a resync: the app stopped sending because
 *   this page fell behind, and the bytes between what the page last received
 *   and the snapshot's `seq` were never drawn. `snapshot()` reports how many,
 *   for the dim "[skipped N KiB to catch up]".
 * - `parsed()` is called from xterm's write callback with the frame's `end`,
 *   and answers the offset to ack once at least `ACK_EVERY` has been parsed
 *   since the last ack. The snapshot's `seq` counts as acked: the app does
 *   not charge a snapshot against credits.
 */
export class AttachLedger {
  private gen = -1;
  private received = 0;
  private acked = 0;

  /** The generation being drawn, or -1 before the first snapshot. */
  get generation(): number {
    return this.gen;
  }

  /** Whether to draw this snapshot, and how many bytes the resync skipped. */
  snapshot(gen: number, seq: number): { draw: boolean; skipped: number } {
    if (gen < this.gen) return { draw: false, skipped: 0 };
    const skipped = this.gen >= 0 && seq > this.received ? seq - this.received : 0;
    this.gen = gen;
    this.received = seq;
    this.acked = seq;
    return { draw: true, skipped };
  }

  /** Whether to draw this data frame. */
  data(gen: number, end: number): boolean {
    if (gen !== this.gen) return false;
    if (end > this.received) this.received = end;
    return true;
  }

  /** The offset to ack now, or null when it is not yet due (or the screen moved on). */
  parsed(gen: number, end: number): number | null {
    if (gen !== this.gen || end - this.acked < ACK_EVERY) return null;
    this.acked = end;
    return end;
  }
}

/** "[skipped 1.5 KiB to catch up]" — KiB with one decimal under 10, whole above. */
export function skippedNote(bytes: number): string {
  const kib = bytes / 1024;
  const shown = kib < 10 ? kib.toFixed(1).replace(/\.0$/, "") : String(Math.round(kib));
  return `[skipped ${shown} KiB to catch up]`;
}

/* ── labels ──────────────────────────────────────────────────────────────── */

/**
 * A shell's own title (OSC 0/2) as a sub-tab label: control characters and
 * escape debris out, whitespace collapsed, at most `TITLE_MAX` characters
 * (the last one an ellipsis when cut). Null when nothing printable is left,
 * so the tab keeps the label it had.
 *
 * The title is remote-controlled text, so this is also what keeps a hostile
 * one from drawing anything but plain characters into the strip.
 */
export function sanitizeTitle(raw: string): string | null {
  let kept = "";
  for (const ch of raw) if (!unprintable(ch.codePointAt(0) ?? 0)) kept += ch;
  const clean = kept.replace(/\s+/g, " ").trim();
  if (clean === "") return null;
  const chars = [...clean];
  return chars.length <= TITLE_MAX ? clean : `${chars.slice(0, TITLE_MAX - 1).join("")}…`;
}

/** C0, DEL and C1 controls, and the bidi marks and overrides that could reorder the strip. */
function unprintable(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

/** The program a busy session is running, for `apt ●` — never the arguments. */
export function busyProgram(activity: { state: string; cmd?: string }): string | null {
  return activity.state === "busy" ? sanitizeProgramName(activity.cmd ?? null) : null;
}

/** A session sub-tab's text: `1 · bash`, `2 · apt ●` while busy, `3 · ended`. */
export function sessionLabel(
  row: { index: number; state: "live" | "ended"; activity: { state: string; cmd?: string } },
  title: string | null,
): string {
  if (row.state === "ended") return `${row.index} · ended`;
  if (row.activity.state === "busy") {
    return `${row.index} · ${busyProgram(row.activity) ?? title ?? "busy"} ●`;
  }
  return `${row.index} · ${title ?? "bash"}`;
}

/** The sub-tab's tooltip, which is where "activity unknown" is said. */
export function sessionHint(row: {
  state: "live" | "ended";
  activity: { state: string };
}): string | undefined {
  if (row.state === "ended") return "session ended";
  return row.activity.state === "unknown" ? "activity unknown" : undefined;
}

/** "[session ended · exit 0 · 3m 12s]", written under the scrollback when the stream says so. */
export function endedLine(
  exit: { code: number | null; signal: string | null; reason: string },
  ranMs: number | null,
): string {
  const how =
    exit.reason === "closed"
      ? "closed"
      : exit.reason === "shutdown"
        ? "app quit"
        : exit.reason === "acl_denied"
          ? "denied by tailnet policy"
          : exit.signal !== null
            ? `signal ${exit.signal}`
            : `exit ${exit.code ?? "?"}`;
  const parts = ["session ended", how];
  if (ranMs !== null && ranMs >= 0) parts.push(duration(ranMs));
  return `[${parts.join(" · ")}]`;
}

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/* ── the nav's sub-line ──────────────────────────────────────────────────── */

/** A preflight refusal the section has seen, as the nav names it. */
export type TerminalProblem = "TAILSCALE_MISSING" | "TAILSCALE_STOPPED" | "TAILSCALE_WRONG_TAILNET";

/**
 * The Terminal entry's sub-line: what the section would show, without opening
 * it. `accent` is the `●` form, drawn in `--acc`.
 */
export function terminalSubline(input: {
  status: string;
  sessions: readonly {
    state: "live" | "ended";
    unseen: boolean;
    activity: { state: string; cmd?: string };
  }[];
  problem: TerminalProblem | null;
}): { text: string; accent: boolean } {
  if (terminalAgentOff(input.status)) return { text: `instance ${input.status}`, accent: false };
  const live = input.sessions.filter((s) => s.state === "live");
  if (live.length === 0) {
    if (input.problem === "TAILSCALE_MISSING") return { text: "tailscale not found", accent: false };
    if (input.problem === "TAILSCALE_STOPPED") return { text: "tailscale stopped", accent: false };
    if (input.problem === "TAILSCALE_WRONG_TAILNET") return { text: "wrong tailnet", accent: false };
    return { text: "tailscale ssh · no session", accent: false };
  }
  const n = `${live.length} session${live.length === 1 ? "" : "s"}`;
  const unseen = input.sessions.filter((s) => s.unseen).length;
  if (unseen > 0) return { text: `${n} · ${unseen} new output`, accent: true };
  const only = live.length === 1 ? live[0] : undefined;
  const program = only ? busyProgram(only.activity) : null;
  if (program !== null) return { text: `running: ${program}`, accent: true };
  return { text: n, accent: true };
}
