/**
 * A job's runs: totals across the top, the list on the left and the chosen
 * run's output on the right, every time on the profile's clock.
 */
import { useEffect, useId, useState } from "react";
import { routinesHistory } from "../../api/index.ts";
import type { BotRoutineView } from "../../api/index.ts";
import { Drawer, DrawerHead } from "../../components/Drawer.tsx";
import { describeSchedule, formatStamp, relative, runTone, zoneAbbr } from "../routine-schedule.ts";

type Run = Awaited<ReturnType<typeof routinesHistory>>["runs"][number];
const seconds = (r: Run) =>
  r.started_at && r.finished_at
    ? Math.max(0, Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000))
    : null;
const word = (status: string) => {
  const tone = runTone(status);
  return tone === "ok" ? "OK" : tone === "bad" ? "FAILED" : status.toUpperCase();
};

export function RoutineHistory({
  instance,
  bot,
  job,
  zone,
  busy,
  onRun,
  onClose,
}: {
  instance: string;
  bot: string;
  job: BotRoutineView;
  zone: string;
  busy: boolean;
  onRun: () => void;
  onClose: () => void;
}) {
  const ids = useId();
  const [runs, setRuns] = useState<Run[] | null>(null),
    [error, setError] = useState(""),
    [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    routinesHistory({ instance, bot, id: job.id, limit: 50 }, controller.signal)
      .then((r) => {
        if (!controller.signal.aborted) setRuns(r.runs);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
    // A run started from here lands in `last_run_at`, so the list follows it.
  }, [instance, bot, job.id, job.last_run_at]);
  const now = Date.now();
  const list = runs ?? [];
  const run = list.find((r) => r.id === picked) ?? list[0];
  const ok = list.filter((r) => runTone(r.status) === "ok").length,
    failed = list.filter((r) => runTone(r.status) === "bad").length,
    timed = list.map(seconds).filter((s): s is number => s !== null),
    avg = timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
  const at = (iso: string | null) => (iso ? formatStamp(Date.parse(iso), zone) : "—");
  return (
    <Drawer width={820} className="rt-drawer" onClose={onClose} labelledBy={`${ids}-title`}>
      <DrawerHead
        kicker={`Run history · ${describeSchedule(job.schedule, zone)}`}
        title={job.name}
        titleId={`${ids}-title`}
        onClose={onClose}
      />
      <div className="ch-tiles rt-tiles">
        <div className="ch-tile">
          <b>{runs ? list.length : "…"}</b>
          <span>runs</span>
        </div>
        <div className="ch-tile">
          <b className="rt-st ok">{ok}</b>
          <span>ok</span>
        </div>
        <div className="ch-tile">
          <b className={failed ? "rt-st bad" : undefined}>{failed}</b>
          <span>failed</span>
        </div>
        <div className="ch-tile">
          <b>{avg === null ? "—" : `${avg}s`}</b>
          <span>avg duration</span>
        </div>
      </div>
      <div className="drawer-body rt-split">
        <div className="rt-runs" role="listbox" aria-label="Runs">
          {error ? (
            <p className="bm-error" role="alert">
              {error}
            </p>
          ) : !runs ? (
            <p className="bm-note rt-pad">Reading runs…</p>
          ) : !list.length ? (
            <p className="bm-note rt-pad">No runs recorded yet.</p>
          ) : (
            list.map((r) => (
              <button
                key={r.id}
                type="button"
                role="option"
                aria-selected={r === run}
                className="rt-run"
                onClick={() => setPicked(r.id)}
              >
                <i className={`rt-sq ${runTone(r.status)}`} aria-hidden="true" />
                <span>{at(r.started_at)}</span>
                <span className="rt-dim">{seconds(r) === null ? "" : `${seconds(r)}s`}</span>
              </button>
            ))
          )}
        </div>
        <div className="rt-out">
          {run ? (
            <>
              <p className="rt-out-head">
                <b className={`rt-st ${runTone(run.status)}`}>{word(run.status)}</b>
                <span>
                  {at(run.started_at)}
                  {run.started_at ? ` ${zoneAbbr(Date.parse(run.started_at), zone)}` : ""}
                </span>
                {run.started_at ? (
                  <span className="rt-dim">{relative(Date.parse(run.started_at), now)}</span>
                ) : null}
              </p>
              {run.error ? (
                <pre className="bm-error rt-pre">{run.error}</pre>
              ) : (
                <pre className="rt-pre">{run.text || "No output recorded."}</pre>
              )}
              <p className="bm-note">
                {job.deliver === "bot" ? "Delivered to Bot Chat." : "Kept in run history only."}
              </p>
            </>
          ) : null}
        </div>
      </div>
      <div className="drawer-foot">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onRun}>
          {busy ? "Working…" : "▶ Run now"}
        </button>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Drawer>
  );
}
