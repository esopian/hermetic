import { useEffect, useState } from "react";
import {
  routinesList,
  routinesCreate,
  routinesUpdate,
  routinesDelete,
  routinesRun,
  routinesHistory,
} from "../../api/index.ts";
import type { BotRoutineView } from "../../api/index.ts";
import { gateFor, useBotCapabilities } from "../bot-capabilities.ts";
import { BotModeDialog, BotField } from "./BotModeDialog.tsx";
import { CapabilityNote, gateControl } from "./CapabilityNote.tsx";
import { Face } from "./Face.tsx";
export function ScheduledJobs({
  instance,
  bot,
  title,
  fleetId,
}: {
  instance: string;
  bot: string;
  title: string;
  fleetId: string;
}) {
  const [jobs, setJobs] = useState<BotRoutineView[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0),
    [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<BotRoutineView | "new" | null>(null),
    [remove, setRemove] = useState<BotRoutineView | null>(null),
    [history, setHistory] = useState<Awaited<ReturnType<typeof routinesHistory>> | null>(null);
  const target = { instance, bot };
  /**
   * The routine registry is probed before it is read. A gateway without one
   * 404s every `routines.*` call, and a list that came back empty because the
   * endpoint is missing is indistinguishable from a bot with no jobs — which is
   * exactly the claim this pane must not make on the portal's own guess.
   */
  const capabilities = useBotCapabilities(instance);
  const gate = gateFor(capabilities, "routines");
  useEffect(() => {
    if (!gate.allowed) {
      setJobs([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    routinesList({ instance, bot }, controller.signal)
      .then((r) => {
        if (!controller.signal.aborted) setJobs(r.jobs);
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
                  : jobs.length === 1
                    ? "1 routine"
                    : `${jobs.length} routines`}
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
          {jobs.map((job) => (
            <article className="bm-job" key={job.id}>
              <h3>
                <i className={job.paused ? "paused" : ""} />
                {job.name}
              </h3>
              <p className="mono">{job.schedule}</p>
              <p className="bm-note">
                {job.deliver === "bot"
                  ? "Delivers to Bot Chat"
                  : job.deliver === "local"
                    ? "Separate run history"
                    : "Custom delivery"}
              </p>
              <p className="bm-note">{job.paused ? "Paused" : (job.last_status ?? "Scheduled")}</p>
              <div className="bm-job-actions">
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => void act(() => routinesRun({ ...target, id: job.id }))}
                >
                  Run now
                </button>
                <button
                  disabled={busy}
                  type="button"
                  onClick={() =>
                    void act(() => routinesUpdate({ ...target, id: job.id, paused: !job.paused }))
                  }
                >
                  {job.paused ? "Resume" : "Pause"}
                </button>
                <button type="button" disabled={busy} onClick={() => setEdit(job)}>
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => setHistory(await routinesHistory({ ...target, id: job.id })))
                  }
                >
                  History
                </button>
                <button type="button" disabled={busy} onClick={() => setRemove(job)}>
                  Remove
                </button>
              </div>
            </article>
          ))}
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
            Jobs run on the instance, even with this portal closed. Choose explicit delivery to Bot Chat
            when creating a routine.
          </p>
        </div>
      </div>
      {edit ? (
        <BotModeDialog
          title={edit === "new" ? "New scheduled job" : "Edit scheduled job"}
          onClose={() => setEdit(null)}
          submit={edit === "new" ? "Create job" : "Save job"}
          onSubmit={async (data) => {
            const fields = {
              name: String(data.get("name")),
              prompt: String(data.get("prompt")),
              schedule: String(data.get("schedule")),
            };
            const deliver = data.get("deliver") === "bot" ? ("bot" as const) : ("local" as const);
            if (edit === "new") await routinesCreate({ ...target, ...fields, deliver });
            else
              await routinesUpdate({
                ...target,
                id: edit.id,
                ...fields,
                ...(data.get("deliver") === "other" ? {} : { deliver }),
              });
            setVersion((v) => v + 1);
          }}
        >
          <BotField label="Job name" name="name" value={edit === "new" ? "" : edit.name} required />
          <BotField
            label="Instructions"
            name="prompt"
            value={edit === "new" ? "" : edit.prompt}
            textarea
            required
          />
          <BotField
            label="Schedule"
            name="schedule"
            value={edit === "new" ? "0 8 * * *" : edit.schedule}
            required
          />
          <p className="bm-note">
            Cron expression or schedule supported by Hermes. Uses the instance’s configured timezone.
          </p>
          <label className="bm-field">
            Delivery
            <select
              className="wiz-input"
              name="deliver"
              defaultValue={edit === "new" ? "local" : edit.deliver}
            >
              {edit !== "new" && edit.deliver === "other" ? (
                <option value="other">Keep existing destination</option>
              ) : null}
              <option value="local">Separate run history</option>
              <option value="bot">Bot Chat</option>
            </select>
          </label>
        </BotModeDialog>
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
            Remove “{remove.name}” from {bot} on {instance}? Future scheduled runs will stop.
          </p>
        </BotModeDialog>
      ) : null}
      {history ? (
        <BotModeDialog title="Job run history" onClose={() => setHistory(null)}>
          {history.runs.length ? (
            history.runs.map((run) => (
              <article className="bm-job" key={run.id}>
                <b>{run.status}</b>
                <p>{run.started_at}</p>
                <p>{run.text}</p>
                {run.error ? <p role="alert">{run.error}</p> : null}
              </article>
            ))
          ) : (
            <p>No runs recorded yet.</p>
          )}
        </BotModeDialog>
      ) : null}
    </aside>
  );
}
