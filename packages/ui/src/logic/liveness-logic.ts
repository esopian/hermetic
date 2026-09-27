/**
 * Liveness, decided here rather than in JSX.
 *
 * `display_status` says *that* an agent is unreachable; none of these say that
 * again. `lastSeenLabel` says how stale the silence is, `shouldAutoProbe` says
 * when the fleet views' passive reading has already failed hard enough that the
 * drawer should go and ask the layers directly (§9's `agents.probe`), and
 * `layerRows`/`verdictColor` are the shape that answer renders in.
 */
import type { AgentView, ProbeLayerOutcome, ProbeReport, ProbeVerdictLevel } from "../api/index.ts";
import { fmtClock, fmtDuration, heartbeatAge } from "./format.ts";

/**
 * The trailer under a status word, for the two statuses that are a silence
 * rather than a state: `unreachable` (no heartbeat for three intervals) and
 * `degraded` (heartbeats landing, checks failing). Everything else already
 * says all it has to say, so it gets no trailer at all.
 */
export function lastSeenLabel(a: AgentView): string | null {
  if (a.display_status === "unreachable") {
    if (a.heartbeat_age_ms === null) return "never seen";
    return `last seen ${fmtDuration(a.heartbeat_age_ms)} ago`;
  }
  if (a.display_status === "degraded") return `heartbeat ${heartbeatAge(a)}`;
  return null;
}

/** A bootstrap that has not moved in this long is stuck, not slow. */
export const BOOTSTRAP_STALL_MS = 10 * 60_000;
/** `creating` is a handful of AWS calls; a quarter-hour of it is a stall. */
export const CREATE_STALL_MS = 15 * 60_000;

const BROKEN: ReadonlySet<string> = new Set(["unreachable", "degraded", "error"]);

/**
 * Whether opening the drawer on this agent should spend the ~5s a probe costs
 * without being asked. True only when the passive row has already reported a
 * problem, or when a transient status has sat still long enough to be one.
 * A stopped, destroyed or ready agent is never probed on open — there is
 * nothing to diagnose, and the operator still has the `Probe` button.
 */
export function shouldAutoProbe(a: AgentView, now: number): boolean {
  if (BROKEN.has(a.display_status)) return true;
  const age = now - Date.parse(a.updated_at);
  if (!Number.isFinite(age)) return false;
  if (a.status === "bootstrapping") return age > BOOTSTRAP_STALL_MS;
  if (a.status === "creating") return age > CREATE_STALL_MS;
  return false;
}

export type LayerKey = "instance" | "hermeticd" | "dashboard" | "desktop" | "browser";

export interface LayerRow {
  key: LayerKey;
  outcome: ProbeLayerOutcome;
  label: string;
  detail: string;
  /** `null` when nothing was attempted, so there is no duration to report. */
  latency: string | null;
}

const LAYER_ORDER: readonly LayerKey[] = ["instance", "hermeticd", "dashboard", "desktop", "browser"];

/**
 * Outermost layer first: the box, then the daemon on it, then what it serves.
 * One word each — these render in `.check`'s 90px label track, which `EC2
 * instance` wrapped onto two lines.
 *
 * `desktop` and `browser` come after `dashboard` in the order core reports
 * them, which is the order they depend on each other in: a desktop is only
 * worth reaching if the node answers at all, and a browser is only worth
 * watching if the desktop serves.
 */
const LAYER_LABELS: Record<LayerKey, string> = {
  instance: "instance",
  hermeticd: "hermeticd",
  dashboard: "dashboard",
  desktop: "desktop",
  browser: "browser",
};

export function layerRows(report: ProbeReport): LayerRow[] {
  return LAYER_ORDER.map((key) => {
    const layer = report[key];
    return {
      key,
      outcome: layer.outcome,
      label: LAYER_LABELS[key],
      detail: layer.detail,
      latency: layer.latency_ms === null ? null : `${layer.latency_ms} ms`,
    };
  });
}

/**
 * The same rows before there is an answer, so the panel keeps its shape
 * while a probe is in flight instead of appearing under the button.
 */
export function pendingLayerRows(): LayerRow[] {
  return LAYER_ORDER.map((key) => ({
    key,
    outcome: "skip" as const,
    label: LAYER_LABELS[key],
    detail: "asking…",
    latency: null,
  }));
}

/** A layer that was never askable is muted, not red: `skip` is not a failure. */
export function outcomeColor(outcome: ProbeLayerOutcome): string {
  if (outcome === "ok") return "var(--ok)";
  if (outcome === "fail") return "var(--bad)";
  return "var(--fg3)";
}

export function verdictColor(level: ProbeVerdictLevel): string {
  if (level === "ok") return "var(--ok)";
  if (level === "warn") return "var(--warn)";
  if (level === "bad") return "var(--bad)";
  return "var(--fg3)";
}

/**
 * Local wall-clock for a `title=`. The relative ages everywhere else answer
 * "how stale"; this answers "against what", which is the form that matches a
 * console screenshot or a log line.
 *
 * The date comes with it whenever the instant is not today, because the whole
 * point of the tooltip is to disambiguate a `3d ago` — and a bare `11:59:55`
 * against a three-day-old heartbeat reads as this morning. Nothing to say (a
 * null, or a timestamp that will not parse) is `null` rather than a row of
 * dashes: a tooltip of `--:--:--` is worse than no tooltip.
 */
export function absoluteTime(iso: string | null, now: number = Date.now()): string | null {
  if (iso === null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const clock = fmtClock(iso);
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return clock;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clock}`;
}

/** A probe the panel has started and not yet retired. */
export interface ProbeTicket {
  readonly id: number;
  readonly name: string;
}

/**
 * Who owns the Liveness panel right now.
 *
 * A probe is a five-second round trip against a drawer that is *not* remounted
 * when the selection moves and whose row upserts on every fleet tick, so three
 * separate races land on one `probing` flag:
 *
 *   - A→B: A's answer (or A's rejection) arrives after the operator has moved
 *     on, and would otherwise be painted under B's name;
 *   - A→B: A's `finally` arrives after B's probe started and would clear B's
 *     `probing`, re-enabling the button under a live request;
 *   - StrictMode mounts every effect twice (`entry-app.tsx` wraps the app), and a
 *     click on top of an auto-probe is the same shape — two requests where the
 *     operator asked for one.
 *
 * All three are one question — "is this ticket still the one the panel wants?"
 * — so the answer lives here, as a state machine with no React in it, rather
 * than as three ad-hoc guards in the drawer.
 */
export interface ProbeSequencer {
  /**
   * Point the panel at an agent. Returns true when the focus actually moved,
   * which is the caller's cue to drop the report and clear `probing`; anything
   * in flight is abandoned. Re-focusing the *same* name is a no-op, so
   * StrictMode's second mount does not invalidate the first mount's request.
   */
  focus(name: string): boolean;
  /**
   * Claim the panel for a probe of `name`, or `null` when one is already in
   * flight for it — the double-fire guard for auto-probe + click.
   */
  begin(name: string): ProbeTicket | null;
  /** Whether this ticket's answer is still the one to paint. */
  isCurrent(ticket: ProbeTicket): boolean;
  /**
   * Retire a ticket. True when it was the current one, and therefore when the
   * caller should clear `probing`; a superseded ticket settles silently.
   */
  settle(ticket: ProbeTicket): boolean;
  /** The name a probe is in flight for, or null. */
  inFlight(): string | null;
}

export function probeSequencer(): ProbeSequencer {
  let seq = 0;
  let focused: string | null = null;
  let running: ProbeTicket | null = null;
  return {
    focus(name) {
      if (focused === name) return false;
      focused = name;
      running = null;
      return true;
    },
    begin(name) {
      if (running !== null && running.name === name) return null;
      seq += 1;
      running = { id: seq, name };
      return running;
    },
    isCurrent(ticket) {
      return running !== null && running.id === ticket.id;
    },
    settle(ticket) {
      if (running === null || running.id !== ticket.id) return false;
      running = null;
      return true;
    },
    inFlight() {
      return running === null ? null : running.name;
    },
  };
}
