/**
 * New / edit scheduled job: numbered sections on the left, a live preview on
 * the right — the schedule in words and as Hermes stores it, a 7-day grid, the
 * next runs on the profile's clock and where each result goes.
 */
import { useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { routinesCreate, routinesUpdate } from "../../api/index.ts";
import type { BotRoutineView } from "../../api/index.ts";
import { Drawer, DrawerHead } from "../../components/Drawer.tsx";
import {
  KINDS,
  LAPTOP_ZONE,
  defaultPicker,
  describeSchedule,
  formatStamp,
  fromSchedule,
  laptopTime,
  nextRuns,
  relative,
  scheduleProblem,
  toSchedule,
  weekGrid,
  weekdayShort,
  withKind,
  zoneAbbr,
} from "../routine-schedule.ts";
import type { Picker } from "../routine-schedule.ts";

const DAYS = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function RoutineDrawer({
  instance,
  bot,
  title,
  job,
  zone,
  onClose,
  onSaved,
}: {
  instance: string;
  bot: string;
  /** The bot's display name. */
  title: string;
  /** null creates. */
  job: BotRoutineView | null;
  zone: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ids = useId();
  const [now] = useState(Date.now);
  const [name, setName] = useState(job?.name ?? ""),
    [prompt, setPrompt] = useState(job?.prompt ?? ""),
    [picker, setPickerState] = useState<Picker>(() =>
      job ? fromSchedule(job.schedule, zone, now) : defaultPicker(zone, now),
    ),
    // An edit that never touched the schedule sends none: a schedule this form
    // cannot read (a sixth cron field, a named weekday) survives a rename.
    [touched, setTouched] = useState(!job),
    [deliver, setDeliver] = useState<"local" | "bot" | "other">(job?.deliver ?? "local"),
    [repeat, setRepeat] = useState(job?.repeat.times ? String(job.repeat.times) : ""),
    [continuity, setContinuity] = useState(job?.continuity ?? false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const setPicker = (p: Picker) => {
    setPickerState(p);
    setTouched(true);
  };
  const schedule = touched ? toSchedule(picker) : (job?.schedule ?? ""),
    problem = touched ? scheduleProblem(picker, zone, now) : "",
    oneShot = picker.kind === "once" || picker.kind === "at",
    cap = repeat.trim() ? Number(repeat) : null,
    capBad = cap !== null && !(Number.isInteger(cap) && cap >= 1);
  const missing = !name.trim()
    ? "Name the job."
    : !prompt.trim()
      ? "Write the instructions."
      : problem || (capBad ? "Stop after takes a whole number of runs." : "");
  const runs = problem ? [] : nextRuns(schedule, zone, 200, now);
  const first = runs[0];

  async function save(event: FormEvent) {
    event.preventDefault();
    if (missing || busy) return;
    setBusy(true);
    setError("");
    const ref = { instance, bot };
    const runCap = oneShot ? null : cap;
    try {
      if (!job)
        await routinesCreate({
          ...ref,
          name: name.trim(),
          prompt,
          schedule,
          deliver: deliver === "bot" ? "bot" : "local",
          ...(runCap ? { repeat: runCap } : {}),
          ...(continuity ? { continuity } : {}),
        });
      else
        await routinesUpdate({
          ...ref,
          id: job.id,
          ...(name.trim() !== job.name ? { name: name.trim() } : {}),
          ...(prompt !== job.prompt ? { prompt } : {}),
          ...(touched && schedule !== job.schedule ? { schedule } : {}),
          ...(deliver !== "other" && deliver !== job.deliver ? { deliver } : {}),
          ...(runCap !== job.repeat.times && !oneShot ? { repeat: runCap } : {}),
          ...(continuity !== job.continuity ? { continuity } : {}),
        });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const time = (
    <input
      className="wiz-input rt-input"
      type="time"
      aria-label="Time"
      value={picker.time}
      onChange={(e) => setPicker({ ...picker, time: e.target.value || "08:00" })}
    />
  );
  const count = (field: "n" | "minute" | "dom", label: string, min: number, max?: number) => (
    <input
      className="wiz-input rt-input rt-num"
      type="number"
      aria-label={label}
      min={min}
      max={max}
      value={Number.isNaN(picker[field]) ? "" : picker[field]}
      onChange={(e) =>
        setPicker({ ...picker, [field]: e.target.value === "" ? Number.NaN : Number(e.target.value) })
      }
    />
  );
  const unit = (
    <select
      className="wiz-input rt-input"
      aria-label="Unit"
      value={picker.unit}
      onChange={(e) => setPicker({ ...picker, unit: e.target.value as Picker["unit"] })}
    >
      <option value="m">minutes</option>
      <option value="h">hours</option>
      <option value="d">days</option>
    </select>
  );
  const sub: Record<Picker["kind"], ReactNode> = {
    once: (
      <Row label="Run once, in">
        {count("n", "Amount", 1)}
        {unit}
      </Row>
    ),
    at: (
      <Row label="On" note={zone}>
        <input
          className="wiz-input rt-input"
          type="date"
          aria-label="Date"
          value={picker.date}
          onChange={(e) => setPicker({ ...picker, date: e.target.value })}
        />
        {time}
      </Row>
    ),
    hourly: (
      <Row label="At minute" note="past every hour">
        {count("minute", "Minute", 0, 59)}
      </Row>
    ),
    daily: <Row label="At">{time}</Row>,
    weekdays: <Row label="At">{time}</Row>,
    weekly: (
      <>
        <div className="bm-field">
          <span>On</span>
          <div className="rt-days">
            {DAYS.map((d) => (
              <button
                key={d}
                type="button"
                className="rt-chip"
                aria-pressed={picker.days.includes(d)}
                onClick={() =>
                  setPicker({
                    ...picker,
                    days: picker.days.includes(d)
                      ? picker.days.filter((x) => x !== d)
                      : [...picker.days, d],
                  })
                }
              >
                {DAY_NAMES[d]}
              </button>
            ))}
          </div>
        </div>
        <Row label="At">{time}</Row>
      </>
    ),
    monthly: (
      <Row label="On day" note={picker.dom > 28 ? "Months without that day are skipped." : undefined}>
        {count("dom", "Day of month", 1, 31)}
        {time}
      </Row>
    ),
    interval: (
      <Row label="Every" note="Counted from when the job is saved.">
        {count("n", "Amount", 1)}
        {unit}
      </Row>
    ),
    cron: (
      <label className="bm-field">
        <span>Cron expression</span>
        <input
          className="wiz-input rt-input rt-mono"
          spellCheck={false}
          value={picker.expr}
          onChange={(e) => setPicker({ ...picker, expr: e.target.value })}
        />
        <small className="rt-dim">minute · hour · day of month · month · weekday</small>
      </label>
    ),
  };

  return (
    <Drawer width={820} className="rt-drawer" onClose={onClose} labelledBy={`${ids}-title`}>
      <DrawerHead
        kicker={`${title} · ${instance}`}
        title={job ? "Edit scheduled job" : "New scheduled job"}
        titleId={`${ids}-title`}
        onClose={onClose}
      />
      <form className="drawer-body rt-form" onSubmit={save} id={`${ids}-form`}>
        <div className="rt-left">
          <Step n={1} title="What it does">
            <label className="bm-field">
              <span>Job name</span>
              <input
                className="wiz-input rt-input"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="bm-field">
              <span>Instructions</span>
              <textarea
                className="wiz-input rt-input"
                rows={5}
                value={prompt}
                placeholder={`What should ${title} do each time?`}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
          </Step>
          <Step n={2} title="When">
            <div className="rt-kinds" role="group" aria-label="When to run">
              {KINDS.map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  className="rt-chip"
                  aria-pressed={picker.kind === k}
                  onClick={() => setPicker(withKind(picker, k))}
                >
                  {label}
                </button>
              ))}
            </div>
            {sub[picker.kind]}
          </Step>
          <Step n={3} title="Where results go">
            <div className="rt-dest" role="group" aria-label="Send results to">
              {job?.deliver === "other" ? (
                <Dest
                  on={deliver === "other"}
                  pick={() => setDeliver("other")}
                  title="Keep existing destination"
                >
                  Set outside hermetic; left as it is.
                </Dest>
              ) : null}
              <Dest on={deliver === "local"} pick={() => setDeliver("local")} title="Run history only">
                Results stay with the job. Read them from History.
              </Dest>
              <Dest on={deliver === "bot"} pick={() => setDeliver("bot")} title={`${title}’s chat`}>
                Each run posts into the chat, marked as a cron delivery.
              </Dest>
            </div>
          </Step>
          <Step n={4} title="Options">
            <Row
              label="Stop after"
              note={
                oneShot
                  ? "A one-off job runs once."
                  : job?.repeat.times
                    ? `runs · ${job.repeat.completed} so far`
                    : "runs (blank runs forever)"
              }
            >
              <input
                className="wiz-input rt-input rt-num"
                type="number"
                min={1}
                aria-label="Stop after runs"
                placeholder="forever"
                disabled={oneShot}
                value={oneShot ? "" : repeat}
                onChange={(e) => setRepeat(e.target.value)}
              />
            </Row>
            <label className="rt-check">
              <input
                type="checkbox"
                checked={continuity}
                onChange={(e) => setContinuity(e.target.checked)}
              />
              <span>
                Continue from the last run
                <small>
                  Each run sees the previous run’s output — dedupe, pick up where it left off.
                </small>
              </span>
            </label>
          </Step>
        </div>
        <div className="rt-right">
          <div className="kicker">Preview</div>
          {problem ? (
            <p className="bm-error rt-flush" role="alert">
              {problem}
            </p>
          ) : (
            <>
              <p className="rt-big">{describeSchedule(schedule, zone)}</p>
              <code className="rt-cron">{schedule}</code>
              {runs.length ? (
                <>
                  <div className="kicker rt-gap">Next 7 days</div>
                  <Week runs={runs} zone={zone} now={now} />
                  <div className="kicker rt-gap">Next runs · {zone}</div>
                  <ul className="rt-next5">
                    {runs.slice(0, 5).map((t) => (
                      <li key={t}>
                        <span>
                          {formatStamp(t, zone)} <small>{zoneAbbr(t, zone)}</small>
                        </span>
                        <small>{relative(t, now)}</small>
                      </li>
                    ))}
                  </ul>
                  {first && laptopTime(first, zone, LAPTOP_ZONE) ? (
                    <p className="bm-note">First run is {laptopTime(first, zone, LAPTOP_ZONE)}.</p>
                  ) : null}
                  {oneShot ? <p className="bm-note">Runs once, then the job finishes.</p> : null}
                </>
              ) : (
                <p className="bm-note">
                  hermetic can’t preview this schedule; Hermes will check it on save.
                </p>
              )}
            </>
          )}
          <div className="kicker rt-gap">In the chat</div>
          <p className="bm-note rt-flush">
            {deliver === "bot"
              ? `Each result appears in ${title}’s chat as a cron delivery.`
              : deliver === "local"
                ? "Nothing posts to the chat. Runs are listed in the job’s history."
                : "Results keep going where they go today."}
          </p>
        </div>
      </form>
      <div className="drawer-foot">
        <span className={error ? "bm-error rt-flush" : "rt-dim"} role={error ? "alert" : undefined}>
          {error || missing}
        </span>
        <div className="rt-foot-acts">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={`${ids}-form`}
            className="btn btn-primary"
            disabled={!!missing || busy}
          >
            {busy ? "Saving…" : job ? "Save job" : "Create job"}
          </button>
        </div>
      </div>
    </Drawer>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="rt-step">
      <h3>
        <i>{n}</i>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="bm-field">
      <span>{label}</span>
      <div className="rt-row-in">
        {children}
        {note ? <small className="rt-dim">{note}</small> : null}
      </div>
    </div>
  );
}

function Dest({
  on,
  pick,
  title,
  children,
}: {
  on: boolean;
  pick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button type="button" className="rt-dest-card" aria-pressed={on} onClick={pick}>
      <b>{title}</b>
      <small>{children}</small>
    </button>
  );
}

function Week({ runs, zone, now }: { runs: number[]; zone: string; now: number }) {
  const grid = weekGrid(runs, zone, now);
  const total = grid.reduce((a, col) => a + col.reduce((b, v) => b + v, 0), 0);
  return (
    <>
      <div className="rt-week" role="img" aria-label={`${total} runs in the next 7 days`}>
        {grid.map((col, i) => (
          <div key={i}>
            <div className="rt-week-col">
              {col.map((v, h) => (
                <i key={h} className={v ? "on" : undefined} />
              ))}
            </div>
            <span>{weekdayShort(now + i * 86_400_000, zone)}</span>
          </div>
        ))}
      </div>
      <p className="rt-dim rt-small">
        Midnight at the top · {total} run{total === 1 ? "" : "s"}
      </p>
    </>
  );
}
