import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  routinesList,
  routinesUpdate,
  routinesDelete,
  routinesRun,
  routinesHistory,
} from "../../api/index.ts";
import type { BotRoutineView, ChatMessageView } from "../../api/index.ts";
import { isVisible } from "../../lib/visibility.ts";
import { gateFor, useBotCapabilities } from "../bot-capabilities.ts";
import { useCronCallFinished } from "../cron-tools.ts";
import {
  LAPTOP_ZONE,
  dayLabel,
  describeSchedule,
  formatStamp,
  formatTime,
  laptopTime,
  relative,
  runTone,
} from "../routine-schedule.ts";
import { BotModeDialog } from "./BotModeDialog.tsx";
import { CapabilityNote, gateControl } from "./CapabilityNote.tsx";
import { Face } from "./Face.tsx";
import { RoutineDrawer } from "./RoutineDrawer.tsx";
import { RoutineHistory } from "./RoutineHistory.tsx";

/** How often an open rail re-reads the registry, for jobs changed anywhere else. */
export const ROUTINES_POLL_MS = 60_000;
/** Runs drawn as squares in an open row. */
const STRIP_RUNS = 14;

/** The platform interval, returning its cancel like `ChatTiming.setInterval`. */
const platformInterval = (fn: () => void, ms: number): (() => void) => {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
};

export function ScheduledJobs({
  instance,
  bot,
  title,
  fleetId,
  live = null,
  pollMs = ROUTINES_POLL_MS,
  setInterval: every = platformInterval,
}: {
  instance: string;
  bot: string;
  title: string;
  fleetId: string;
  /** This bot's turn in flight; a cron call finishing in it re-reads the registry. */
  live?: ChatMessageView | null;
  pollMs?: number;
  /** The scheduler behind the poll, for a test that steps its own clock. */
  setInterval?: (fn: () => void, ms: number) => () => void;
}) {
  const [jobs, setJobs] = useState<BotRoutineView[]>([]),
    // shortcut: a profile with no `timezone` runs on the box's clock, assumed UTC
    // (the EC2 image default); read the box's zone if an image ever changes it.
    [zone, setZone] = useState("UTC"),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0),
    [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null),
    [edit, setEdit] = useState<BotRoutineView | "new" | null>(null),
    [remove, setRemove] = useState<BotRoutineView | null>(null),
    [history, setHistory] = useState<BotRoutineView | null>(null);
  const target = { instance, bot };
  /**
   * The routine registry is probed before it is read. A gateway without one
   * 404s every `routines.*` call, and a list that came back empty because the
   * endpoint is missing is indistinguishable from a bot with no jobs — which is
   * exactly the claim this pane must not make on the portal's own guess.
   */
  const capabilities = useBotCapabilities(instance);
  const gate = gateFor(capabilities, "routines");
  /**
   * Set by a re-read nobody asked for — the poll, or a cron call in chat — so
   * the list stays on screen through it instead of flashing "Reading…" once a
   * minute.
   */
  const quiet = useRef(false);
  const reread = () => {
    quiet.current = true;
    setVersion((v) => v + 1);
  };
  useCronCallFinished(live, reread);
  /**
   * The poll runs only while the page is on screen: a hidden page cancels it,
   * and coming back re-arms it rather than reading at once, since the operator
   * returning is not news about the registry.
   */
  useEffect(() => {
    if (!gate.allowed) return;
    let cancel: (() => void) | null = null;
    const track = () => {
      const visible = isVisible();
      if (visible && !cancel) cancel = every(reread, pollMs);
      else if (!visible && cancel) {
        cancel();
        cancel = null;
      }
    };
    track();
    document.addEventListener("visibilitychange", track);
    return () => {
      document.removeEventListener("visibilitychange", track);
      cancel?.();
    };
  }, [gate.allowed, pollMs, every]);
  useEffect(() => {
    if (!gate.allowed) {
      setJobs([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    if (!quiet.current) setLoading(true);
    quiet.current = false;
    setError("");
    routinesList({ instance, bot }, controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return;
        setJobs(r.jobs);
        setZone(r.timezone ?? "UTC");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [instance, bot, version, gate.allowed]);
  async function act(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const now = Date.now();
  const upcoming = jobs
    .filter((j) => !j.paused && j.next_run_at)
    .map((j) => Date.parse(j.next_run_at ?? ""))
    .sort((a, b) => a - b)[0];
  const run = (job: BotRoutineView) => void act(() => routinesRun({ ...target, id: job.id }));
  return (
    <aside className="ch-ctx bm-jobs" aria-label="Scheduled jobs">
      <div className="ch-ctx-head">
        <span>Scheduled jobs</span>
        <button
          type="button"
          className="btn-mini"
          aria-label="Add scheduled job"
          {...gateControl(gate, "Add scheduled job")}
          onClick={() => setEdit("new")}
        >
          +
        </button>
      </div>
      <div className="ch-ctx-body">
        <div className="ch-ctx-sec bm-profile-summary">
          <Face fleetId={fleetId} instance={instance} bot={bot} size={30} status="ready" />
          <div>
            <b>{title}</b>
            {/*
              "0 profile routines" in the mono face reads as "8 profile
              routines" at this size — a zero and an eight are one slashed
              stroke apart, and the one number here that must not be misread is
              the one that says nothing is scheduled. Zero is therefore a word.
            */}
            <p>
              {!gate.allowed
                ? "Routines not read"
                : jobs.length === 0
                  ? "no routines"
                  : `${jobs.length === 1 ? "1 routine" : `${jobs.length} routines`}${
                      upcoming
                        ? ` · next ${dayLabel(upcoming, zone, now, true).toLowerCase()} ${formatTime(upcoming, zone)}`
                        : ""
                    }`}
            </p>
          </div>
        </div>
        <div className="ch-ctx-sec">
          <CapabilityNote gate={gate} onRetry={capabilities.reload} />
          {loading && gate.allowed ? <p className="bm-note">Reading scheduled jobs…</p> : null}
          {error ? (
            <p className="bm-error" role="alert">
              {error}
            </p>
          ) : null}
          {jobs.length ? (
            <div className="rt-list">
              {jobs.map((job) => (
                <RoutineRow
                  key={job.id}
                  job={job}
                  zone={zone}
                  now={now}
                  open={open === job.id}
                  onToggle={() => setOpen(open === job.id ? null : job.id)}
                >
                  <RoutineDetail
                    job={job}
                    zone={zone}
                    now={now}
                    busy={busy}
                    onRun={() => run(job)}
                    onPause={() =>
                      void act(() => routinesUpdate({ ...target, id: job.id, paused: !job.paused }))
                    }
                    onEdit={() => setEdit(job)}
                    onHistory={() => setHistory(job)}
                    onRemove={() => setRemove(job)}
                  />
                </RoutineRow>
              ))}
            </div>
          ) : null}
          {gate.allowed && !loading && !error && !jobs.length ? (
            <p className="bm-note">No routines yet. Give this bot a recurring task.</p>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary bm-wide"
            {...gateControl(gate, "Add scheduled job")}
            onClick={() => setEdit("new")}
          >
            + Add scheduled job
          </button>
        </div>
        <div className="ch-ctx-sec">
          <div className="kicker">Work that comes back to you</div>
          <p className="bm-note">
            Jobs run on the instance, even with this app closed. Times are in the instance’s timezone (
            {zone}).
          </p>
        </div>
      </div>
      {edit ? (
        <RoutineDrawer
          instance={instance}
          bot={bot}
          title={title}
          job={edit === "new" ? null : edit}
          zone={zone}
          onClose={() => setEdit(null)}
          onSaved={() => setVersion((v) => v + 1)}
        />
      ) : null}
      {remove ? (
        <BotModeDialog
          title="Remove scheduled job"
          onClose={() => setRemove(null)}
          submit="Remove job"
          onSubmit={async () => {
            await routinesDelete({ ...target, id: remove.id, confirm: true });
            setVersion((v) => v + 1);
          }}
        >
          <p>
            Remove “{remove.name}” from {bot} on {instance}?{" "}
            {remove.next_run_at && !remove.paused
              ? `Its next run (${formatStamp(Date.parse(remove.next_run_at), zone)}) and every later one stop.`
              : "Future scheduled runs will stop."}
          </p>
          <p className="bm-note">Results already delivered to the chat stay there.</p>
        </BotModeDialog>
      ) : null}
      {history ? (
        <RoutineHistory
          instance={instance}
          bot={bot}
          job={history}
          zone={zone}
          busy={busy}
          onRun={() => run(history)}
          onClose={() => setHistory(null)}
        />
      ) : null}
    </aside>
  );
}

function RoutineRow({
  job,
  zone,
  now,
  open,
  onToggle,
  children,
}: {
  job: BotRoutineView;
  zone: string;
  now: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const next = !job.paused && job.next_run_at ? Date.parse(job.next_run_at) : null;
  // A job that never ran has only a scheduler `state` ("scheduled") where a
  // run result would be; that is not a success.
  const tone = job.paused ? "paused" : job.last_run_at ? runTone(job.last_status) : "idle";
  return (
    <>
      <button
        type="button"
        className={`rt-row${open ? " open" : ""}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <i className={`rt-sq ${tone}`} aria-hidden="true" />
        <span className="rt-main">
          <span className="rt-name">{job.name}</span>
          <span className="rt-when">{describeSchedule(job.schedule, zone)}</span>
        </span>
        <span className="rt-next">
          {job.paused ? (
            <small>paused</small>
          ) : next ? (
            <>
              {formatTime(next, zone)}
              <small>{dayLabel(next, zone, now, true)}</small>
            </>
          ) : (
            <small>—</small>
          )}
        </span>
      </button>
      {open ? children : null}
    </>
  );
}

function RoutineDetail({
  job,
  zone,
  now,
  busy,
  onRun,
  onPause,
  onEdit,
  onHistory,
  onRemove,
}: {
  job: BotRoutineView;
  zone: string;
  now: number;
  busy: boolean;
  onRun: () => void;
  onPause: () => void;
  onEdit: () => void;
  onHistory: () => void;
  onRemove: () => void;
}) {
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof routinesHistory>>["runs"] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    routinesHistory(
      { instance: job.instance, bot: job.bot, id: job.id, limit: STRIP_RUNS },
      controller.signal,
    )
      .then((r) => {
        if (!controller.signal.aborted) setRuns(r.runs);
      })
      // The strip is a glance; History shows the error if the read fails there too.
      .catch(() => undefined);
    return () => controller.abort();
  }, [job.instance, job.bot, job.id, job.last_run_at]);
  const next = !job.paused && job.next_run_at ? Date.parse(job.next_run_at) : null;
  const last = job.last_run_at ? Date.parse(job.last_run_at) : null;
  const laptop = next ? laptopTime(next, zone, LAPTOP_ZONE) : "";
  const strip = runs ? [...runs].reverse() : [];
  const failed = strip.filter((r) => runTone(r.status) === "bad").length;
  return (
    <div className="rt-det">
      <p className="rt-prompt">{job.prompt}</p>
      <dl className="rt-meta">
        <dt>When</dt>
        <dd>
          {describeSchedule(job.schedule, zone)} <code className="rt-cron">{job.schedule}</code>
        </dd>
        <dt>Next</dt>
        <dd>
          {job.paused ? (
            "Paused"
          ) : next ? (
            <>
              {dayLabel(next, zone, now)}, {formatTime(next, zone)}{" "}
              <span className="rt-dim">· {relative(next, now)}</span>
              {laptop ? <span className="rt-dim rt-block">{laptop}</span> : null}
            </>
          ) : (
            "No further runs"
          )}
        </dd>
        <dt>Last</dt>
        <dd>
          {last ? (
            <>
              <span className={`rt-st ${runTone(job.last_status)}`}>{job.last_status ?? "ran"}</span>{" "}
              {formatStamp(last, zone)}
            </>
          ) : (
            "Never run"
          )}
        </dd>
        <dt>To</dt>
        <dd>
          {job.deliver === "bot"
            ? "Bot Chat"
            : job.deliver === "local"
              ? "Run history"
              : "Custom delivery"}
          {job.continuity ? " · continues from last run" : ""}
        </dd>
        {job.repeat.times ? (
          <>
            <dt>Runs</dt>
            <dd>
              {job.repeat.completed} of {job.repeat.times} ·{" "}
              {Math.max(0, job.repeat.times - job.repeat.completed)} left
            </dd>
          </>
        ) : null}
      </dl>
      {strip.length ? (
        <>
          <div className="rt-strip" role="img" aria-label={`Last ${strip.length} runs`}>
            {strip.map((r) => (
              <i
                key={r.id}
                className={runTone(r.status)}
                title={`${r.started_at ? formatStamp(Date.parse(r.started_at), zone) : "—"} · ${r.status}`}
              />
            ))}
          </div>
          <p className="rt-strip-l">
            last {strip.length} run{strip.length === 1 ? "" : "s"} · {strip.length - failed} ok
            {failed ? <b> · {failed} failed</b> : null}
          </p>
        </>
      ) : null}
      <button type="button" className="rt-primary" disabled={busy} onClick={onRun}>
        {busy ? "Working…" : "▶ Run now"}
      </button>
      <div className="rt-acts">
        <button type="button" disabled={busy} onClick={onPause}>
          <span aria-hidden="true">{job.paused ? "↺" : "‖"}</span>
          {job.paused ? "Resume" : "Pause"}
        </button>
        <button type="button" disabled={busy} onClick={onEdit}>
          <span aria-hidden="true">✎</span>Edit
        </button>
        <button type="button" onClick={onHistory}>
          <span aria-hidden="true">≡</span>History
        </button>
        <button
          type="button"
          className="rm"
          disabled={busy}
          onClick={onRemove}
          aria-label={`Remove ${job.name}`}
          title="Remove…"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
    </div>
  );
}
