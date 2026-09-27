/**
 * The progress view for any op: percent, bar, the step list derived from the
 * op's own `phase`s, and a log pane of its messages. Shared by create and init
 * so both read the same way.
 */
import { useEffect, useRef, useState } from "react";
import { fmtClock } from "../logic/format.ts";
import { railNotes } from "../logic/op-hints.ts";
import type { OpState } from "../lib/useOp.ts";

/**
 * How often the live region is allowed to speak. An op emits an event every
 * second or two and a screen reader that reads every one of them is unusable,
 * so the region carries the *latest* state on a slow tick rather than a
 * transcript. The final state is never throttled away: the trailing timer
 * always flushes what it was holding.
 */
const ANNOUNCE_MS = 4000;

/**
 * `value`, but changing at most once per `ms` — except when `final` is set, in
 * which case it changes now.
 *
 * The trailing flush is a `setTimeout` and React clears it on unmount, so a
 * throttle alone loses whatever it was holding when the component goes away.
 * That is precisely the outcome of a short op: a create that fails in four
 * seconds would announce "0% · starting", hold the verdict behind the timer,
 * and then have the timer cancelled when the drawer closed — the one sentence a
 * screen-reader user needed was the one guaranteed never to be spoken. So the
 * terminal value bypasses the throttle entirely rather than racing it.
 */
function useThrottled<T>(value: T, ms: number, final: boolean): T {
  const [shown, setShown] = useState(value);
  const lastAt = useRef(0);
  useEffect(() => {
    const since = Date.now() - lastAt.current;
    if (final || since >= ms) {
      lastAt.current = Date.now();
      setShown(value);
      return;
    }
    const id = setTimeout(() => {
      lastAt.current = Date.now();
      setShown(value);
    }, ms - since);
    return () => clearTimeout(id);
  }, [value, ms, final]);
  return shown;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** `…` became a number: how long the current step has been running, ticking. */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** One line of the log pane. `start` rows look different from completions. */
export function logGlyph(e: { level?: string | undefined; kind?: string | undefined }): string {
  if (e.level === "error") return "✖";
  if (e.level === "warn") return "⚠";
  if (e.kind === "start") return "…";
  return "▸";
}

export function opColor(op: OpState): string {
  if (!op.ok) return "var(--bad)";
  return op.finished ? "var(--ok)" : "var(--acc)";
}

/**
 * The step rail: one row per phase, in the order the op declares them, with the
 * same filled-square vocabulary the bootstrap checklist uses. Split out of
 * `OpProgress` so the agent drawer can show the *same* checklist next to its
 * compact bar — a create that hands off at 100% is only legible if you can see
 * which steps it actually ran (§6.3).
 */
export function OpSteps({ steps, now }: { steps: OpState["steps"]; now: number }) {
  if (steps.length === 0) return null;
  return (
    <div className="steps">
      {steps.map((s) => (
        <div key={s.phase} className="step" style={{ opacity: s.state === "pending" ? 0.5 : 1 }}>
          <i
            style={{
              background:
                s.state === "done"
                  ? "var(--ok)"
                  : s.state === "current"
                    ? "var(--acc)"
                    : "var(--line2)",
              animation: s.state === "current" ? "hpulse 1.2s infinite" : "none",
            }}
          />
          <b>{s.label}</b>
          <span>
            {s.state === "current" && s.startedAt ? fmtElapsed(now - Date.parse(s.startedAt)) : s.time}
          </span>
        </div>
      ))}
    </div>
  );
}

export function OpProgress({
  title,
  sub,
  op,
  hints = [],
  hintsLabel = "Before the first agent",
}: {
  title: string;
  sub: string;
  op: OpState;
  /**
   * Extra lines for the callout, beside the ones the op's own `ready` warnings
   * put there. The agent drawer uses it to say what to try after a failure;
   * nothing else needs it, so it defaults to nothing rather than to a policy.
   */
  hints?: readonly string[];
  hintsLabel?: string;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [op.events.length]);

  const color = opColor(op);
  const now = useTicker(op.running);
  const log = op.events
    .map((e) => `[${fmtClock(e.at)}] ${logGlyph(e)} ${e.phase.padEnd(11)} ${e.message}`)
    .join("\n");
  // Deduped: a terminal line that is both the op's last word and a `warn`
  // would otherwise be rendered twice under the same React key.
  const nextActions = railNotes(op.events, op.finished, hints);

  /**
   * What a screen reader hears. The whole region cannot be `aria-live` — the
   * log pane grows by a line every second or two and would be read out in full
   * — so this is one sentence carrying the same three facts the sighted view
   * shows at a glance, throttled so it is a status rather than a transcript.
   */
  const last = op.events[op.events.length - 1];
  const announcement = op.finished
    ? op.ok
      ? `${title}: complete`
      : `${title}: failed — ${op.error ? `${op.error.code}: ${op.error.message}` : "the op failed"}`
    : `${title}: ${op.percent}% · ${last?.phase ?? "starting"}${last?.message ? ` · ${last.message}` : ""}`;
  // The verdict is never throttled: see `useThrottled`.
  const spoken = useThrottled(announcement, ANNOUNCE_MS, op.finished);

  return (
    <>
      <div className="progress-top">
        <div style={{ minWidth: 0 }}>
          <div className="progress-name">{title}</div>
          <div className="progress-sub">{sub}</div>
        </div>
        <div className="progress-pct" style={{ color }}>
          {op.percent}%
        </div>
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {spoken}
      </div>
      <div
        className="progress-bar"
        role="progressbar"
        aria-valuenow={op.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${title} progress`}
      >
        <i
          style={{
            display: "block",
            height: "100%",
            width: `${op.percent}%`,
            background: color,
            transition: "width .4s",
          }}
        />
      </div>
      <OpSteps steps={op.steps} now={now} />
      {nextActions.length > 0 ? (
        <div className="op-next" role="note">
          <div className="kicker">{hintsLabel}</div>
          {nextActions.map((line) => (
            <div key={line} className="mono op-next-line">
              ⚠ {line}
            </div>
          ))}
        </div>
      ) : null}
      <div className="logpane progress-log" ref={logRef}>
        {log}
        {"\n"}
        {op.error ? `✖ ${op.error.code}: ${op.error.message}\n` : ""}
        {op.running ? <span className="caret" /> : null}
      </div>
    </>
  );
}
