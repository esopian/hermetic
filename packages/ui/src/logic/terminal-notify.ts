/**
 * The terminal's notification rules (issue #18), pure and DOM-free.
 *
 * Split out of `notification-logic.ts` rather than grown into it: the terminal
 * adds four rules of its own, and each is a decision worth a test without a
 * provider mounted.
 *
 * - **Watching.** A row about the session on screen and in focus never
 *   interrupts (`isWatchingTerminalSession`), the terminal's half of
 *   `isWatchingThread`.
 * - **Trigger.** The Terminal group's page-level choice: `output` lets every
 *   terminal row interrupt; `important` sends `terminal.output` to the inbox
 *   silently and lets only finished, input, bell and disconnected through.
 * - **Banners.** A desktop banner is the loudest thing this page can do, and a
 *   build log in three sessions would otherwise raise one per session per
 *   burst. At most one per session per 60 s and one per 10 s app-wide; the
 *   rest fold into one "N terminal sessions have new output"
 *   (`TerminalBannerGate`).
 * - **Return toast.** Electrobun cannot say which banner was clicked, so when
 *   the window comes back the page offers the newest terminal row delivered
 *   while it was away (`pickReturnToast`).
 *
 * Rows are described structurally, as in `notification-logic.ts`: a terminal
 * row's `ref` is its session id, and its action's ref is `<agent>/<session_id>`
 * (`terminalActionRef` in core's `schema/terminal.ts`).
 */
import { agentHash } from "../nav/agent-nav.ts";

/** Whether a kind is one of the five `terminal.*` kinds core writes. */
export function isTerminalKind(kind: string): boolean {
  return kind.startsWith("terminal.");
}

/* ── watching ────────────────────────────────────────────────────────────── */

/**
 * Whether this row is about the session somebody is looking at. `viewed` is
 * the session on screen in a visible, focused window (`viewedTerminal()` in
 * `state/terminal-watch.ts`), or `null` when there is none — in which case
 * nothing is being watched and everything may interrupt.
 *
 * The app's attention rules already raise no row for a viewed session; this
 * gate covers the row that was written in the instant before the view report
 * arrived, which would otherwise toast over the very output it is about.
 */
export function isWatchingTerminalSession(
  n: { kind: string; ref?: string | null },
  viewed: string | null | undefined,
): boolean {
  if (!viewed || !isTerminalKind(n.kind)) return false;
  return n.ref === viewed;
}

/* ── the Terminal group's trigger ────────────────────────────────────────── */

export type TerminalTrigger = "output" | "important";

export const TERMINAL_TRIGGERS: readonly TerminalTrigger[] = ["output", "important"];

/** What the settings row calls each choice. */
export const TERMINAL_TRIGGER_LABEL: Record<TerminalTrigger, string> = {
  output: "New output",
  important: "Finished & input only",
};

export const DEFAULT_TERMINAL_TRIGGER: TerminalTrigger = "output";

export function isTerminalTrigger(v: unknown): v is TerminalTrigger {
  return v === "output" || v === "important";
}

/**
 * Whether the trigger lets this row interrupt. Only `terminal.output` under
 * `important` is held back, and only from interrupting: the row is still
 * written and still sits in the inbox, which is what "silently" means.
 */
export function terminalTriggerAllows(n: { kind: string }, trigger: TerminalTrigger): boolean {
  return !(trigger === "important" && n.kind === "terminal.output");
}

/* ── where `Open session` goes ───────────────────────────────────────────── */

/**
 * `<agent>/<session_id>`, taken apart on the first `/` — an agent name admits
 * no `/`, and a session id admits neither `/` nor `:` — or `null` for a ref
 * that is not one.
 */
export function terminalActionRoute(
  ref: string | null | undefined,
): { agent: string; session: string } | null {
  const raw = ref ?? "";
  const cut = raw.indexOf("/");
  if (cut <= 0 || cut === raw.length - 1) return null;
  return { agent: raw.slice(0, cut), session: raw.slice(cut + 1) };
}

/**
 * The hash a terminal action lands on: `#agent/<name>/terminal/<session_id>`.
 * A ref with no agent in it has nowhere to go and is `null`, like any other
 * action `actionHash` cannot route.
 */
export function terminalActionHash(ref: string | null | undefined): string | null {
  const route = terminalActionRoute(ref);
  return route === null ? null : agentHash(route.agent, "terminal", route.session);
}

/* ── banner coalescing ───────────────────────────────────────────────────── */

/** At most one banner per session in this window. */
export const TERMINAL_BANNER_SESSION_MS = 60_000;
/** At most one terminal banner, from any session, in this window. */
export const TERMINAL_BANNER_APP_MS = 10_000;

export interface TerminalBanner {
  title: string;
  body: string;
  /** Collapses repeats on the OS side; the row id for a single row. */
  tag?: string;
}

/** The coalesced banner's words, for `count` sessions held behind the app-wide limit. */
export function coalescedBannerTitle(count: number): string {
  return count === 1
    ? "1 terminal session has new output"
    : `${count} terminal sessions have new output`;
}

/**
 * The two banner limits, with a clock the caller passes in.
 *
 * A banner offered for a session that had one inside `sessionMs` is dropped:
 * that session already said it wants attention, and its row is in the inbox.
 * A banner offered inside the app-wide `appMs` of the last one is *held*, and
 * every held session is folded into one banner once the window has passed
 * (`flush`, at `nextFlushAt`). So a burst across three sessions is one banner
 * now and one "2 terminal sessions have new output" ten seconds later, rather
 * than three in a row.
 *
 * A single held session is flushed as its own banner rather than as "1
 * terminal session has new output": it is no less specific for having waited.
 */
export class TerminalBannerGate {
  #lastApp = Number.NEGATIVE_INFINITY;
  readonly #lastBySession = new Map<string, number>();
  /** Held sessions, each with the newest banner it offered. Insertion-ordered. */
  readonly #held = new Map<string, TerminalBanner>();

  constructor(
    readonly sessionMs: number = TERMINAL_BANNER_SESSION_MS,
    readonly appMs: number = TERMINAL_BANNER_APP_MS,
  ) {}

  #recent(session: string, now: number): boolean {
    const last = this.#lastBySession.get(session);
    return last !== undefined && now - last < this.sessionMs;
  }

  /** The banner to raise now, or `null` when it was dropped or held. */
  offer(session: string, banner: TerminalBanner, now: number): TerminalBanner | null {
    if (this.#recent(session, now)) return null;
    if (now - this.#lastApp < this.appMs) {
      this.#held.set(session, banner);
      return null;
    }
    this.#lastApp = now;
    this.#lastBySession.set(session, now);
    this.#held.delete(session);
    return banner;
  }

  /** When the held banners may go out, or `null` when nothing is held. */
  nextFlushAt(): number | null {
    return this.#held.size === 0 ? null : this.#lastApp + this.appMs;
  }

  /**
   * The folded banner for every held session, once the app-wide window has
   * passed; `null` before then or with nothing held. Sessions that bannered
   * in the meantime are left out rather than told twice.
   */
  flush(now: number): TerminalBanner | null {
    if (this.#held.size === 0 || now - this.#lastApp < this.appMs) return null;
    const sessions = [...this.#held].filter(([session]) => !this.#recent(session, now));
    this.#held.clear();
    const first = sessions[0];
    if (first === undefined) return null;
    this.#lastApp = now;
    for (const [session] of sessions) this.#lastBySession.set(session, now);
    if (sessions.length === 1) return first[1];
    return { title: coalescedBannerTitle(sessions.length), body: "", tag: "terminal:coalesced" };
  }
}

/* ── the return toast ────────────────────────────────────────────────────── */

/** The fields `pickReturnToast` reads. */
export interface ReturnCandidate {
  id: string;
  at: string;
  kind: string;
  read_at?: string | null;
  resolved_at?: string | null;
  cleared_at?: string | null;
}

export interface ReturnToastPick<T> {
  /** The newest unseen row: the toast's title and its `Open session`. */
  newest: T;
  /** The next newest, for the `also: …` line; `null` when there is only one. */
  also: T | null;
  /** How many more beyond those two. */
  more: number;
}

/**
 * What the return toast shows, from the terminal rows delivered while the
 * window was away. Each is read through `current` — the rows the inbox holds
 * now — so a row the operator read, cleared, or whose condition resolved (they
 * looked at the session from somewhere else) since it arrived no longer
 * counts; a row `current` has no copy of is taken as it arrived. Newest first;
 * `null` when nothing unseen is left.
 */
export function pickReturnToast<T extends ReturnCandidate>(
  away: readonly T[],
  current: readonly T[],
): ReturnToastPick<T> | null {
  const byId = new Map(current.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const live: T[] = [];
  for (const row of away) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const now = byId.get(row.id) ?? row;
    if (!isTerminalKind(now.kind) || now.read_at || now.resolved_at || now.cleared_at) continue;
    live.push(now);
  }
  live.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const newest = live[0];
  if (newest === undefined) return null;
  return { newest, also: live[1] ?? null, more: Math.max(0, live.length - 2) };
}
