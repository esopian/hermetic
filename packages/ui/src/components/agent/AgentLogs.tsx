/**
 * The Logs section: one source at a time, read once, in a mono pane.
 *
 * The sources are the public `logs` method's own (`LogsInput`): a journal unit
 * on the box, one of Hermes's log files on the data volume, or the serial
 * console off EC2 — plus the agent's recorded history (`agents.history`),
 * which is local and is where a failed stage's log tail lands. That one is the
 * default: it answers for every agent, including one whose box never came up,
 * and opening a section should not reach across the tailnet on its own.
 *
 * Never a follow. A read ends by itself and `Refresh` asks again; a stream left
 * open behind a drawer nobody is looking at would be a tail on the box for as
 * long as the drawer stayed mounted.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { HERMES_DASHBOARD_UNIT, HERMES_GATEWAY_UNIT } from "@hermetic/core/shared";
import { fetchLogs } from "../../api/index.ts";
import type { AgentLogLine, AgentLogQuery, AgentView } from "../../api/index.ts";
import { fmtClock, isOff } from "../../logic/format.ts";
import { InlineScan } from "../Loading.tsx";
import type { HistoryState } from "./AgentOverview.tsx";
import { eventsText } from "./AgentOverview.tsx";

/** Where a read comes from. `activity` is the history; `console` needs only EC2; the rest need the box. */
export interface LogSourceOption {
  id: string;
  label: string;
  /** One line under the picker saying what this source is for. */
  about: string;
  /** Absent for `activity`, which is not a `logs` read at all. */
  query?: AgentLogQuery;
  needs: "nothing" | "box" | "instance";
}

export const LOG_SOURCES: readonly LogSourceOption[] = [
  {
    id: "activity",
    label: "Activity",
    about:
      "What hermetic recorded about this agent: every op, status change and failed stage, with that stage's log tail.",
    needs: "nothing",
  },
  {
    id: "dashboard",
    label: "Hermes dashboard (journal)",
    about: `journald for ${HERMES_DASHBOARD_UNIT}, the box's default unit — the process behind the agent's dashboard and chat.`,
    query: {},
    needs: "box",
  },
  {
    id: "gateway-unit",
    label: "Hermes gateway (journal)",
    about: `journald for ${HERMES_GATEWAY_UNIT}, where the messaging channels and cron jobs run.`,
    query: { unit: HERMES_GATEWAY_UNIT },
    needs: "box",
  },
  {
    id: "hermeticd",
    label: "hermeticd (journal)",
    about:
      "journald for hermeticd.service, the node agent that runs the bootstrap stages and sends heartbeats.",
    query: { unit: "hermeticd.service" },
    needs: "box",
  },
  {
    id: "errors",
    label: "errors.log",
    about:
      "Hermes's own error log on the data volume — where a failed turn says why, which the journal does not.",
    query: { file: "errors" },
    needs: "box",
  },
  {
    id: "agent",
    label: "agent.log",
    about: "Hermes's agent log on the data volume.",
    query: { file: "agent" },
    needs: "box",
  },
  {
    id: "gateway",
    label: "gateway.log",
    about: "Hermes's gateway log on the data volume.",
    query: { file: "gateway" },
    needs: "box",
  },
  {
    id: "console",
    label: "Serial console",
    about:
      "The instance's serial console, read straight from EC2 — the one source that answers when the box never joined the tailnet.",
    query: { source: "console" },
    needs: "instance",
  },
];

/** Why a source cannot be read for this agent, or null when it can. */
export function sourceUnavailable(source: LogSourceOption, agent: AgentView): string | null {
  if (source.needs === "instance" && !agent.instance_id)
    return "no instance: there is no serial console to read";
  if (source.needs === "box" && isOff(agent))
    return `the box is ${agent.display_status}; nothing is running to serve its logs`;
  return null;
}

type Read =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; lines: AgentLogLine[] }
  | { state: "error"; message: string };

export function AgentLogs({ agent, history }: { agent: AgentView; history: HistoryState }) {
  const name = agent.name;
  const [sourceId, setSourceId] = useState("activity");
  const [read, setRead] = useState<Read>({ state: "idle" });
  /** Only the newest read may land: a slow journal must not overwrite the console asked for after it. */
  const ticket = useRef(0);
  const source = LOG_SOURCES.find((s) => s.id === sourceId) ?? LOG_SOURCES[0]!;
  const blocked = sourceUnavailable(source, agent);

  const load = useCallback(() => {
    const mine = ++ticket.current;
    if (!source.query || blocked) {
      setRead({ state: "idle" });
      return;
    }
    setRead({ state: "loading" });
    fetchLogs(name, source.query, `could not read ${source.label} from ${name}`)
      .then((lines) => {
        if (mine === ticket.current) setRead({ state: "ok", lines });
      })
      .catch((e: unknown) => {
        if (mine === ticket.current)
          setRead({ state: "error", message: e instanceof Error ? e.message : String(e) });
      });
    // `blocked` is a string derived from the row, so it is stable across the
    // fleet stream's re-emits of an unchanged agent.
  }, [name, source, blocked]);

  useEffect(() => {
    load();
    return () => {
      ticket.current++;
    };
  }, [load]);

  const refresh = () => {
    if (source.id === "activity") history.loadHistory();
    else load();
  };
  const loading = source.id === "activity" ? history.historyLoading : read.state === "loading";

  let body: string | null = null;
  if (source.id === "activity") {
    const events = history.events;
    body = events === null ? null : eventsText(events);
  } else if (read.state === "ok") {
    body =
      read.lines.length === 0
        ? "— nothing logged —"
        : read.lines
            .map((l) => `[${fmtClock(l.at)}] ${l.unit === "console" ? "" : `${l.unit} `}${l.message}`)
            .join("\n");
  }

  return (
    <div className="dr-pane dr-logs">
      <div className="dr-say">
        <div className="kicker">Logs</div>
        <p>One source at a time, read once. Refresh reads it again.</p>
      </div>
      <div className="dr-logbar">
        <label className="dr-logsel">
          <span className="kicker">Source</span>
          <select
            aria-label="Log source"
            value={source.id}
            onChange={(e) => setSourceId(e.target.value)}
          >
            {LOG_SOURCES.map((s) => (
              <option key={s.id} value={s.id} disabled={sourceUnavailable(s, agent) !== null}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={loading || blocked !== null}
          onClick={refresh}
        >
          {loading ? "Reading…" : "Refresh"}
        </button>
      </div>
      <div className="hint">{source.about}</div>
      {blocked ? <div className="hint">Not available: {blocked}.</div> : null}
      {loading ? <InlineScan label={`Reading ${source.label}`} /> : null}
      {source.id === "activity" && history.historyError ? (
        <div className="wiz-error mono" role="alert">
          Could not read activity: {history.historyError}
          {history.events !== null ? " · showing the last good read" : ""}
        </div>
      ) : null}
      {read.state === "error" && source.id !== "activity" ? (
        <div className="wiz-error mono" role="alert">
          {read.message}
        </div>
      ) : null}
      {body !== null ? (
        <div className="logpane dr-logpane" role="log" aria-label={`${source.label} log`}>
          {body}
        </div>
      ) : null}
    </div>
  );
}
