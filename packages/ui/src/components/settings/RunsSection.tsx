/**
 * The local `runs` table (§4.6) as an audit log: every command this laptop ran
 * — from the CLI and from the portal both — narrowed by fleet, outcome, time
 * and free text, and **scoped to the fleet this portal is open on by default**.
 *
 * The scoping is the point. A home may freeze several fleets (§4.8), and every
 * head writes into one shared run log, so an unfiltered list interleaves three
 * fleets' histories and stops answering the question the screen exists for:
 * what did I do to *this* fleet, and did it work. Widening to all fleets stays
 * one click away, and the footer says which scope is in force either way.
 *
 * Filtering is client-side over a fetched window rather than query parameters
 * on `runs.list`: the run log is a small local SQLite table, the window is one
 * read, and the rules live in `runs-filter.ts` where they can be tested without
 * a server. `Run.log` already carries the whole log, so the FULL LOG toggle
 * expands it in place — the route has no `?full=` to ask for one.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { listRuns } from "../../api/index.ts";
import type { LocalConfig, Run } from "../../api/index.ts";
import { fmtClock, fmtDate } from "../../logic/format.ts";
import {
  ALL_FLEETS,
  RUN_OUTCOMES,
  RUN_RANGES,
  type RunOutcome,
  type RunRange,
  type RunsFilter,
  defaultRunsFilter,
  describeRunsFilter,
  filterRuns,
  fleetOptions,
  hasActiveRunsFilter,
  runFleetLabel,
  runLabel,
  runOutcome,
} from "../../logic/runs-filter.ts";
import { InlineScan, Skel } from "../Loading.tsx";
import { Block, SettingsPage, Sq, TextAction } from "./Section.tsx";
import type { SqTone } from "./Section.tsx";

/**
 * How many rows one read pulls back, and how far "load more" will go.
 *
 * Bounded because a row carries its captured output (capped at 4 KiB by the
 * head that wrote it), so the window is a payload decision, not a display one.
 * `runs.list` refuses anything over 1000.
 */
const WINDOWS = [200, 500, 1000] as const;

/**
 * The fleet this portal is open on, as the rows are keyed: its `fleet_id`.
 *
 * Not its alias. The run log records `fleet_id` because that is what a fleet
 * *is* — an alias is a label that can move to another fleet, and scoping an
 * audit log by one would silently re-point it (§4.8). A null here (no config
 * yet) simply means the default filter is `ALL_FLEETS`.
 */
function currentFleetId(config: LocalConfig | null): string | null {
  if (!config) return null;
  const id = (config as { fleet_id?: unknown }).fleet_id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** What that fleet is called on screen: its alias, else the id (§4.6). */
function currentFleetAlias(config: LocalConfig | null): string | null {
  if (!config) return null;
  const named = (config as { name?: unknown }).name;
  return typeof named === "string" && named !== "" ? named : null;
}

const OUTCOME_COLOR: Record<RunOutcome, string> = {
  ok: "var(--ok)",
  failed: "var(--bad)",
  unfinished: "var(--fg3)",
};

const OUTCOME_TONE: Record<RunOutcome, SqTone> = { ok: "ok", failed: "bad", unfinished: "off" };

export function RunsSection({ config }: { config: LocalConfig | null }) {
  const current = currentFleetId(config);
  const currentLabel = currentFleetAlias(config);

  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [windowSize, setWindowSize] = useState<number>(WINDOWS[0]);
  const [filter, setFilter] = useState<RunsFilter>(() => defaultRunsFilter(current));
  // Frozen per read rather than per render: a relative window ("last hour")
  // measured against a clock that moves every render would drop rows out of the
  // table while the operator is reading them.
  const [now, setNow] = useState(() => Date.now());

  // The fleet is only known once `/api/meta` lands, which is usually after the
  // first render. Adopt it as the scope exactly once — later edits are the
  // operator's, and must not be reset by a meta refresh.
  const [scoped, setScoped] = useState(false);
  useEffect(() => {
    if (scoped || current === null) return;
    setScoped(true);
    setFilter((f) => ({ ...f, fleet: current }));
  }, [current, scoped]);

  const load = useCallback((limit: number) => {
    let alive = true;
    setError(null);
    listRuns(limit)
      .then((r) => {
        if (!alive) return;
        setRuns(r);
        setNow(Date.now());
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => load(windowSize), [load, windowSize]);

  const fleets = useMemo(
    () => fleetOptions(runs ?? [], current, currentLabel),
    [runs, current, currentLabel],
  );
  const shown = useMemo(
    () => (runs === null ? [] : filterRuns(runs, filter, now)),
    [runs, filter, now],
  );

  /** What the scoped fleet is called, for the line under the table. */
  const scopeLabel = fleets.find((f) => f.id === filter.fleet)?.label ?? null;
  const total = runs?.length ?? 0;
  const filtered = hasActiveRunsFilter(filter, current);
  const nextWindow = WINDOWS.find((w) => w > windowSize);

  const desc =
    "Every hermetic command this laptop ran — at the CLI or from this app. Nothing here is read from the fleet.";

  if (error) {
    return (
      <SettingsPage section="runs" scope="laptop" desc={desc}>
        <div className="wiz-error mono">{error}</div>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      section="runs"
      scope="laptop"
      desc={desc}
      primary={
        <button type="button" className="btn btn-secondary" onClick={() => load(windowSize)}>
          Refresh
        </button>
      }
    >
      <Block
        title="Run log"
        right={
          filtered ? (
            <TextAction onClick={() => setFilter(defaultRunsFilter(current))}>Clear filters</TextAction>
          ) : null
        }
      >
        <div className="runs-filters">
          <input
            type="search"
            className="runs-search"
            placeholder="Search command, agent, fleet…"
            aria-label="Search runs"
            value={filter.query}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
          />
          <div className="seg runs-seg" role="group" aria-label="Outcome">
            {RUN_OUTCOMES.map((o) => (
              <button
                key={o.id}
                type="button"
                aria-pressed={filter.outcome === o.id}
                onClick={() => setFilter((f) => ({ ...f, outcome: o.id }))}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="select-wrap">
            <select
              className="select-input"
              aria-label="Fleet"
              value={filter.fleet}
              onChange={(e) => setFilter((f) => ({ ...f, fleet: e.target.value }))}
            >
              {/* The current fleet is `fleets[0]`, so the default sits at the top. */}
              {fleets.map((fleet) => (
                <option key={fleet.id} value={fleet.id}>
                  {fleet.id === current ? `${fleet.label} (this fleet)` : fleet.label}
                </option>
              ))}
              <option value={ALL_FLEETS}>All fleets</option>
            </select>
          </div>
          <div className="select-wrap">
            <select
              className="select-input"
              aria-label="Time range"
              value={filter.range}
              onChange={(e) => setFilter((f) => ({ ...f, range: e.target.value as RunRange }))}
            >
              {RUN_RANGES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {runs === null ? (
          <div className="plan-skel">
            <InlineScan label="reading the local run log…" />
            <Skel w="80%" />
            <Skel w="64%" />
            <Skel w="72%" />
          </div>
        ) : (
          <>
            {/* The scope is a `fleet_id`; the line says what the switcher says. */}
            <div className="st-hint mono runs-scope">
              {describeRunsFilter(shown.length, total, filter, current, scopeLabel)}
            </div>

            {total === 0 ? (
              <div className="st-hint mono">— no runs recorded —</div>
            ) : shown.length === 0 ? (
              // Not "nothing there": the log has rows, the filters hide them. The
              // difference matters on a screen whose job is to prove what happened.
              <div className="st-hint mono">— no runs match these filters ({total} hidden) —</div>
            ) : (
              <table className="st-list">
                <thead>
                  <tr>
                    <th aria-label="Outcome" />
                    <th>Command</th>
                    <th>Fleet</th>
                    <th>Started</th>
                    <th>Exit</th>
                    <th className="st-acts">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const outcome = runOutcome(r);
                    const open = openLog === r.id;
                    return (
                      <Fragment key={r.id}>
                        <tr className={open ? "st-open" : undefined}>
                          <td className="st-c-sq">
                            <Sq
                              tone={OUTCOME_TONE[outcome]}
                              title={
                                outcome === "unfinished" ? "still running, or never finished" : outcome
                              }
                            />
                          </td>
                          <td className="mono st-cell-sm runs-cmd" title={runLabel(r)}>
                            {runLabel(r)}
                          </td>
                          {/* §4.6: the alias it carried, else the id it is keyed on,
                              else unknown — never the fleet that happens to be open. */}
                          <td className="mono st-cell-sm">{runFleetLabel(r)}</td>
                          <td className="mono st-cell-sm">
                            {fmtDate(r.started_at)} {fmtClock(r.started_at)}
                          </td>
                          <td className="mono st-cell-sm" style={{ color: OUTCOME_COLOR[outcome] }}>
                            {r.exit_code ?? "—"}
                          </td>
                          <td className="st-acts">
                            <TextAction onClick={() => setOpenLog(open ? null : r.id)}>
                              {open ? "Hide log" : "Full log"}
                            </TextAction>
                          </td>
                        </tr>
                        {open ? (
                          <tr className="st-log">
                            <td colSpan={6}>
                              <pre className="logpane runs-log">{r.log || "— empty —"}</pre>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}

            {/* Only offered when the window is actually full — otherwise the log
                is shorter than the window and there is nothing further back. */}
            {nextWindow && total === windowSize ? (
              <div className="st-hint">
                <TextAction onClick={() => setWindowSize(nextWindow)}>
                  Load {nextWindow} most recent
                </TextAction>
              </div>
            ) : null}
          </>
        )}
      </Block>
    </SettingsPage>
  );
}
