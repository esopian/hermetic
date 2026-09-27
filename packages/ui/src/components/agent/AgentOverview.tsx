/**
 * The Overview section: one sentence on what the agent is doing (or what is
 * wrong), its health and the liveness probe, the four metric tiles, the
 * bootstrap checklist while there is one, a handful of key facts and the last
 * few events — a render of a row hermeticd already pushed.
 *
 * Nothing here changes the agent. Every action lives on Lifecycle, and the
 * sentence says so when there is something to do there; the full ids, the
 * Tailscale and Hermes panels and the whole history are under Config and Logs.
 * The probe and the history are fetched by the drawer, so moving between
 * sections does not lose them.
 */
import type { ReactNode } from "react";
import type { AgentEvent, AgentView, Meta, ProbeReport } from "../../api/index.ts";
import type { AgentTab } from "../../nav/agent-nav.ts";
import {
  agentCost,
  dashboardUrl,
  diskTitle,
  fmtClock,
  fmtDate,
  fullDiskDetail,
  heartbeatAge,
  isBehind,
  isOff,
  loadColor,
  offlineDetail,
  offlineUnit,
  rootFree,
  sizeSpec,
  tzLabel,
  uptime,
  usedGib,
  versionColor,
} from "../../logic/format.ts";
import {
  absoluteTime,
  layerRows,
  outcomeColor,
  pendingLayerRows,
  verdictColor,
} from "../../logic/liveness-logic.ts";
import { BootstrapChecklist } from "../BootstrapChecklist.tsx";
import { InlineScan } from "../Loading.tsx";
import { Bar } from "../primitives.tsx";
import { AgentSkewBand } from "../SkewBand.tsx";
import { HEALTH_KEYS, statusSentence } from "./agent-summary.ts";

/** How many events the Overview shows; the rest are under Logs → Activity. */
const RECENT_EVENTS = 3;

function Tile({
  label,
  value,
  unit,
  sub,
  color,
}: {
  label: string;
  value: number | null | undefined;
  unit: string;
  /** A node, not a string: the disk tile colours one number inside its own line. */
  sub: ReactNode;
  color: string;
}) {
  return (
    <div className="tile">
      <div className="kicker">{label}</div>
      <div className="tile-val">
        <b style={{ color }}>{value === null || value === undefined ? "—" : Math.round(value)}</b>
        <span>{unit}</span>
      </div>
      <Bar value={value} color={color} height={6} />
      <div className="tile-sub">{sub}</div>
    </div>
  );
}

/**
 * The System disk tile's four fields, resolved for every state a row can be in.
 *
 * A table rather than nested ternaries in the JSX because there are genuinely
 * five outcomes and four of them are some kind of absence — and absence is the
 * part that has to be exactly right here. Two independent fields can each be
 * missing (`root_disk_pct` from an older hermeticd, `root_gib` from a row
 * created before the disk was sizeable), and the tempting shortcuts are both
 * wrong: rendering the missing size as today's default would claim 20 GiB for a
 * box running 8, and rendering the missing reading as `0%` would report the
 * emptiest possible disk for one that has never been measured.
 */
function systemDiskTile(agent: AgentView): {
  value: number | null;
  unit: string;
  color: string;
  sub: string;
} {
  const pctUsed = agent.metrics?.root_disk_pct;
  const gib = agent.root_gib ?? null;
  const color = loadColor(pctUsed);

  // The root volume is created and destroyed with the instance, so a row with
  // no instance has no such disk to describe — and saying `—` without saying
  // why would read as "not reported" on a box that is simply gone.
  if (!agent.instance_id) {
    return {
      value: null,
      unit: "gone with the instance",
      color: "var(--fg3)",
      sub: "the data disk is what survived",
    };
  }
  if (typeof pctUsed !== "number") {
    return {
      value: null,
      unit: gib ? `% of ${gib} GiB` : "not reported",
      color: "var(--fg3)",
      sub: gib
        ? "no reading from this hermeticd — upgrade it to get one"
        : "no reading · size not recorded",
    };
  }
  const free = rootFree(agent.metrics, gib);
  return {
    value: pctUsed,
    unit: gib ? `% of ${gib} GiB` : "% full · size not recorded",
    color,
    sub: free
      ? `${free.text} free · thrown away on rebuild`
      : "created before hermetic sized it · thrown away on rebuild",
  };
}

/** One event as a single line. The log tail a failed stage carries is Logs' to show. */
export function eventLine(e: AgentEvent): string {
  const move = e.from_status || e.to_status ? ` ${e.from_status ?? "·"}→${e.to_status ?? "·"}` : "";
  return `[${fmtClock(e.timestamp)}] ${e.actor} ${e.action}${move}${e.detail ? ` ${e.detail}` : ""}`;
}

export interface HistoryState {
  events: AgentEvent[] | null;
  historyLoading: boolean;
  historyError: string | null;
  loadHistory: () => void;
}

export interface ProbeState {
  report: ProbeReport | null;
  probing: boolean;
  probeError: string | null;
  doProbe: () => Promise<void>;
}

export function AgentOverview({
  agent,
  meta,
  latest,
  tailnet,
  fleetId,
  probe,
  history,
  onSection,
}: {
  agent: AgentView;
  meta: Meta | null;
  latest: string | null;
  tailnet: string;
  fleetId: string | null;
  /** `useLivenessProbe`, owned by the drawer so the answer outlives this section. */
  probe: ProbeState;
  /** The history read, owned by the drawer: an op finishing refreshes it. */
  history: HistoryState;
  /** Move the drawer to another section — the Overview points, Lifecycle acts. */
  onSection: (section: AgentTab) => void;
}) {
  const { report, probing, probeError, doProbe } = probe;
  const { events, historyLoading, historyError, loadHistory } = history;
  const spec = sizeSpec(agent.size);
  const off = isOff(agent);
  const behind = isBehind(agent, latest);
  const cost = agentCost(agent);
  const rootTile = systemDiskTile(agent);
  const say = statusSentence(agent);
  const destroyed = agent.display_status === "destroyed";

  const probeRows = report ? layerRows(report) : probing ? pendingLayerRows() : [];

  const details: Record<(typeof HEALTH_KEYS)[number], string> = {
    hermes: agent.health?.hermes
      ? `hermes ${agent.hermes_version} · agent loop responding`
      : "hermes is not reporting healthy",
    tailscale: agent.health?.tailscale
      ? `peer online · ${agent.tailscale_ip ?? "no ip"}`
      : "tailnet peer is not reporting",
    // One check, two filesystems (§6.4): hermeticd fails it when either the
    // data volume or the root disk is over the line, so the detail names both
    // and the failing text points at whichever it was — "disk is full" without
    // saying which disk sends an operator to resize the wrong one. The passing
    // sentence is the fleet cell's tooltip, verbatim (`diskTitle`).
    disk: agent.health?.disk ? diskTitle(agent) : fullDiskDetail(agent),
    dashboard: agent.health?.dashboard
      ? `${dashboardUrl(agent.name, tailnet, agent.tailscale_dns_name, fleetId)} answers`
      : "dashboard is not answering over HTTPS — check the tailnet's HTTPS certificates",
  };

  /**
   * The tooltip on `4h 12m ago`. Zoned, because §4.4 has more than one operator
   * per fleet and a bare wall clock is a number two of them read differently.
   */
  const heartbeatAtRaw = absoluteTime(agent.last_heartbeat ?? null);
  const heartbeatAt = heartbeatAtRaw === null ? null : `${heartbeatAtRaw} ${tzLabel()}`;
  const toneColor =
    say.tone === "bad"
      ? "var(--bad)"
      : say.tone === "warn"
        ? "var(--warn)"
        : say.tone === "ok"
          ? "var(--ok)"
          : say.tone === "busy"
            ? "var(--acc)"
            : "var(--fg3)";

  return (
    <div className="dr-pane">
      <div className="dr-say" data-tone={say.tone}>
        <div className="kicker">Status</div>
        <p>
          <b style={{ color: toneColor }}>{say.lead}</b> {say.detail}
        </p>
        {/*
          The sentence names Lifecycle whenever the fix lives there; the link
          is that sentence's other half, so an operator reading an error does
          not have to find the nav to act on it.
        */}
        {(say.tone === "bad" || say.tone === "warn" || agent.display_status === "stopped") &&
        !destroyed ? (
          <button
            type="button"
            className="btn btn-sm btn-secondary dr-say-go"
            onClick={() => onSection("lifecycle")}
          >
            Go to Lifecycle →
          </button>
        ) : null}
      </div>

      {behind && latest ? (
        <div className="dr-callout warn">
          <span>
            <b>Hermes {agent.hermes_version}.</b> {latest} is available.
          </span>
          <button type="button" className="btn btn-sm" onClick={() => onSection("lifecycle")}>
            Review in Lifecycle →
          </button>
        </div>
      ) : null}

      {/*
        §6.6: the same band the fleet shows, narrowed to this agent. Above the
        numbers, because every one of them is read differently once you know
        this box was built by a different hermetic.
      */}
      <AgentSkewBand status={meta?.foundation} name={agent.name} />

      <section>
        <div className="dr-h">
          <span className="kicker">Health</span>
          <button
            type="button"
            className="btn btn-secondary btn-mini"
            disabled={probing}
            title="Ask the instance, hermeticd and the dashboard directly; writes nothing"
            onClick={() => void doProbe()}
          >
            {probing ? "Probing…" : "Probe now"}
          </button>
        </div>
        <div className="dr-checks">
          {HEALTH_KEYS.map((key) => {
            // A row written by an older hermeticd has no `dashboard` key at
            // all. That is "not reported", not "failing" — the same beat a row
            // has before its first heartbeat, so it borrows that colour and
            // that pulse rather than going red on a check the box was never
            // asked to run.
            const unreported = !!agent.health && agent.health[key] === undefined;
            const waiting = !off && (!agent.health || unreported);
            const color = off
              ? "var(--fg3)"
              : waiting
                ? "var(--line2)"
                : agent.health?.[key]
                  ? "var(--ok)"
                  : agent.display_status === "degraded"
                    ? "var(--warn)"
                    : "var(--bad)";
            return (
              <div className="dr-check" key={key}>
                <i
                  style={{
                    background: color,
                    animation: waiting ? "hpulse 1.2s infinite" : "none",
                  }}
                />
                <b>{key}</b>
                <small>
                  {off
                    ? offlineDetail(agent.display_status)
                    : !agent.health
                      ? "pending…"
                      : unreported
                        ? "not reported by this hermeticd yet"
                        : details[key]}
                </small>
              </div>
            );
          })}
        </div>

        {/*
          Liveness sits under the checks because it answers the question they
          raise: the checks are what hermeticd *said* at its last heartbeat,
          and a silent agent's checks are therefore stale by exactly as long as
          it has been silent. The probe is the other direction — asking each
          layer now, from here.
        */}
        <div className="probe-head">
          <span className="kicker">Liveness</span>
          <span title={heartbeatAt ?? undefined}>last heartbeat: {heartbeatAge(agent)}</span>
        </div>
        {probeRows.map((r) => (
          <div className="check" key={r.key}>
            <i
              style={{
                background: outcomeColor(r.outcome),
                animation: probing ? "hpulse 1.2s infinite" : "none",
              }}
            />
            <b>{r.label}</b>
            <span className="probe-detail">
              {r.detail}
              {r.latency ? <span className="probe-latency">{r.latency}</span> : null}
            </span>
          </div>
        ))}
        {probeError ? (
          <div className="probe-verdict">
            <div className="probe-summary">
              <i style={{ background: "var(--bad)" }} />
              <b style={{ color: "var(--bad)" }}>probe failed — {probeError}</b>
            </div>
          </div>
        ) : null}
        {report ? (
          // The verdict is the answer to a question the operator asked and
          // then looked away from for five seconds, so it announces itself.
          <div className="probe-verdict" aria-live="polite">
            <div className="probe-summary">
              <i style={{ background: verdictColor(report.verdict.level) }} />
              <b>{report.verdict.summary}</b>
            </div>
            {report.verdict.hints.map((h) => (
              <div className="probe-hint" key={h}>
                → {h}
              </div>
            ))}
            <div className="probe-at">
              probed {absoluteTime(report.at)} {tzLabel()}
            </div>
          </div>
        ) : null}
      </section>

      <div className="tiles dr-tiles">
        <Tile
          label="CPU"
          value={off ? null : agent.metrics?.cpu_pct}
          unit={off ? offlineUnit(agent.display_status) : `% of ${spec.vcpu} vCPU`}
          color={off ? "var(--fg3)" : loadColor(agent.metrics?.cpu_pct)}
          sub={off ? "no samples" : "last heartbeat sample"}
        />
        <Tile
          label="Memory"
          value={off ? null : agent.metrics?.mem_pct}
          unit={off ? offlineUnit(agent.display_status) : `% of ${spec.memGib} GiB`}
          color={off ? "var(--fg3)" : loadColor(agent.metrics?.mem_pct)}
          sub={
            off
              ? "no samples"
              : `${(((agent.metrics?.mem_pct ?? 0) / 100) * spec.memGib).toFixed(1)} GiB resident`
          }
        />
        {/*
          Two disks, two tiles: the filesystem that actually stops a box from
          working is the one a scan would otherwise never land on. The
          sub-lines carry what each disk *is* — one survives a rebuild, one is
          thrown away by it — because that, not the percentage, is what tells
          you which one you are allowed to fill.
        */}
        <Tile
          label="Data disk"
          value={agent.metrics?.disk_pct}
          unit={`% of ${agent.volume_gib} GiB`}
          color={loadColor(agent.metrics?.disk_pct)}
          sub={`${usedGib(agent.metrics?.disk_pct, agent.volume_gib)} used · kept when rebuilt`}
        />
        <Tile
          label="System disk"
          value={rootTile.value}
          unit={rootTile.unit}
          color={rootTile.color}
          sub={rootTile.sub}
        />
      </div>

      <BootstrapChecklist agent={agent} />

      <section>
        <div className="dr-h">
          <span className="kicker">Key facts</span>
        </div>
        <div className="dr-kv2">
          <div className="kv">
            <span className="k">size</span>
            <span className="v">
              {agent.size} · {agent.instance_type}
            </span>
            <span className="k">cost</span>
            <span className="v">
              {cost.monthly}
              <span className="dr-kv-sub">{cost.hourly}</span>
            </span>
            <span className="k">uptime</span>
            <span className="v">{uptime(agent, Date.now())}</span>
            <span className="k">created</span>
            <span className="v">{fmtDate(agent.created_at)}</span>
          </div>
          <div className="kv">
            <span className="k">hermes</span>
            <span className="v" style={{ color: versionColor(agent, latest) }}>
              {agent.hermes_version}
            </span>
            <span className="k">hermeticd</span>
            <span className="v">{agent.hermeticd_version ?? "—"}</span>
            <span className="k">data vol</span>
            <span className="v">
              {agent.volume_gib} GiB · {agent.volume_id ?? "deleted"}
            </span>
            <span className="k">instance</span>
            <span className="v">{agent.instance_id ?? "—"}</span>
          </div>
        </div>
        <div className="hint">
          Full ids, versions and the Tailscale node are under Config; logs and the full history under
          Logs.
        </div>
      </section>

      <section>
        <div className="dr-h">
          <span className="kicker">Recent activity</span>
          <button
            type="button"
            className="btn btn-mini btn-secondary"
            onClick={() => onSection("logs")}
          >
            All activity →
          </button>
        </div>
        {historyLoading ? <InlineScan label="Reading recent activity" /> : null}
        {historyError ? (
          <div className="wiz-error mono" role="alert">
            Could not read activity: {historyError}
            {events !== null ? " · showing the last good read" : ""}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={historyLoading}
              onClick={loadHistory}
            >
              Retry activity
            </button>
          </div>
        ) : null}
        {events !== null ? (
          events.length === 0 ? (
            <div className="dr-act dim">— no recorded events —</div>
          ) : (
            events.slice(0, RECENT_EVENTS).map((e, i) => (
              <div className="dr-act mono" key={`${e.timestamp}-${i}`}>
                {eventLine(e)}
              </div>
            ))
          )
        ) : null}
      </section>
    </div>
  );
}
