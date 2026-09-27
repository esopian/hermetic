/**
 * The staged bootstrap, as a checklist (§4.2). One row per stage in the order
 * hermeticd ran them, with the same filled-square vocabulary the op step list
 * uses: ok green, running orange and pulsing, failed red, pending line2. A
 * finished boot collapses — the interesting case is the one that stopped.
 */
import { useEffect, useState } from "react";
import type { AgentLogLine, AgentView } from "../api/index.ts";
import { fetchConsole } from "../api/index.ts";
import {
  awaitingFirstReport,
  bootstrapCollapsedByDefault,
  bootstrapSummary,
  silentForMs,
  stageColor,
  stageLabel,
  stageMeta,
  stageTextColor,
  stages,
} from "../logic/bootstrap.ts";
import type { StageState } from "../logic/bootstrap.ts";
import { fmtDuration } from "../logic/format.ts";
import { ScanBar } from "./Loading.tsx";

function StageRow({ stage }: { stage: StageState }) {
  const meta = stageMeta(stage);
  return (
    <div className="stage-row" title={stage.id}>
      <i className={`stage-mark ${stage.status}`} style={{ background: stageColor(stage.status) }} />
      <div className="stage-body">
        <b>{stageLabel(stage.id)}</b>
        {stage.status === "failed" && stage.message ? (
          <span className="stage-msg">
            {stage.exit_code === null || stage.exit_code === undefined
              ? stage.message
              : `exit ${String(stage.exit_code)} · ${stage.message}`}
          </span>
        ) : null}
      </div>
      <span className="stage-meta">
        <span className="stage-status" style={{ color: stageTextColor(stage.status) }}>
          {stage.status}
        </span>
        {meta ? <span className="stage-timing">{meta}</span> : null}
      </span>
    </div>
  );
}

/**
 * What the drawer shows instead of nothing when the box has never reported.
 * Two facts and one button: how long it has been silent, why that means the
 * checklist is empty, and the one log source that does not need the box's
 * cooperation to answer (§6.3).
 */
function SilentBox({ agent }: { agent: AgentView }) {
  const [lines, setLines] = useState<AgentLogLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Ticks so "silent for 4m" does not sit at the value it had when the drawer
  // opened; this panel is only mounted for an agent nobody has heard from.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // A different agent gets a different console, not the last one's.
  useEffect(() => {
    setLines(null);
    setFailed(null);
  }, [agent.name]);

  const silent = silentForMs(agent, now);

  function read() {
    setLoading(true);
    setFailed(null);
    fetchConsole(agent.name)
      .then(setLines)
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }

  return (
    <div className="bootstrap">
      <div className="bootstrap-head" role="note">
        <span className="kicker">Bootstrap</span>
        <span className="bootstrap-sum" style={{ color: "var(--warn)" }}>
          no report from the box{silent === null ? "" : ` · silent for ${fmtDuration(silent)}`}
        </span>
      </div>
      <div className="stage-list">
        <div className="stage-empty">
          hermeticd reports every stage by writing its own row, so an empty checklist means the box has
          not managed a single write — not that it has nothing to say.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 0" }}>
          <button type="button" className="btn" disabled={loading} onClick={read}>
            {loading ? "Reading console…" : "Read serial console"}
          </button>
          <span style={{ color: "var(--fg3)", fontSize: 11 }}>
            straight from EC2 · needs nothing from the box
          </span>
        </div>
        {loading ? <ScanBar style={{ marginBottom: 8 }} /> : null}
        {failed ? (
          <div className="stage-empty" style={{ color: "var(--bad)" }}>
            {failed}
          </div>
        ) : null}
        {lines !== null ? (
          <div className="logpane">
            {lines.length === 0
              ? "— EC2 has nothing buffered for this instance yet —"
              : lines.map((l) => l.message).join("\n")}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function BootstrapChecklist({ agent }: { agent: AgentView }) {
  const list = stages(agent);
  const collapsedByDefault = bootstrapCollapsedByDefault(agent);
  const [open, setOpen] = useState(!collapsedByDefault);
  // A boot that starts failing (or starts at all) opens the list on its own;
  // an operator who then closes it keeps it closed until that default changes.
  useEffect(() => {
    setOpen(!collapsedByDefault);
  }, [collapsedByDefault]);

  if (awaitingFirstReport(agent)) return <SilentBox agent={agent} />;
  if (agent.bootstrap === null || agent.bootstrap === undefined) return null;

  return (
    <div className="bootstrap">
      <button
        type="button"
        className="bootstrap-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="kicker">Bootstrap</span>
        <span className="bootstrap-sum">
          {bootstrapSummary(agent)} · hermeticd {agent.bootstrap.hermeticd_version}
        </span>
        <span className="bootstrap-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="stage-list">
          {list.length === 0 ? (
            <div className="stage-empty">— no stages recorded —</div>
          ) : (
            list.map((s) => <StageRow key={s.id} stage={s} />)
          )}
        </div>
      ) : null}
    </div>
  );
}
