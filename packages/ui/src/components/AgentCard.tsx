import { useEffect, useRef, useState } from "react";
import type { AgentView, ProfileView, VolumeView } from "../api/index.ts";
import { startAgent } from "../api/index.ts";
import type { AgentTab } from "../nav/agent-nav.ts";
import { diagnose } from "../logic/card-diagnosis.ts";
import { currentStage, stages, stageLabel } from "../logic/bootstrap.ts";
import {
  dashboardUrl,
  fmtDuration,
  hostnameMismatch,
  isBehind,
  isBusy,
  isOff,
  loadColor,
  pct,
  sizeGlyph,
  statusColor,
  uptime,
  worstDisk,
} from "../logic/format.ts";
import { configOf, type SkewStatusView } from "../logic/skew-logic.ts";
import { profileById } from "../logic/provider-logic.ts";
import { openExternal } from "../lib/open-external.ts";
import { FleetChatButton } from "../chat/components/FleetChatButton.tsx";
import { ListeningBand } from "./ListenButton.tsx";
import { CopyId } from "./primitives.tsx";

interface Props {
  agent: AgentView;
  latest: string | null;
  tailnet: string;
  fleetId?: string | null;
  foundation?: SkewStatusView | null;
  profiles: readonly ProfileView[];
  volumes: readonly VolumeView[];
  now: number;
  listening: boolean;
  onSelect: (name: string, tab?: AgentTab, logSource?: "console") => void;
  onStarted?: (name: string, opId: string) => void;
}

function Tag({ children, tone }: { children: React.ReactNode; tone: "warn" | "muted" }) {
  return <span className={`card-tag ${tone}`}>{children}</span>;
}

function OpenMenu({
  agent,
  tailnet,
  fleetId,
  onSelect,
}: Pick<Props, "agent" | "tailnet" | "fleetId" | "onSelect">) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const reachable = !["unreachable", "error", "stopped", "destroyed"].includes(agent.display_status);
  const choose = (tab: AgentTab) => {
    setOpen(false);
    trigger.current?.focus();
    onSelect(agent.name, tab);
  };
  return (
    <span className="card-open-wrap" ref={box}>
      <button
        ref={trigger}
        type="button"
        className="btn btn-sm card-open-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        Open ▾
      </button>
      {open && (
        <span className="card-open-menu" role="menu" aria-label={`Open ${agent.name}`}>
          <button
            type="button"
            role="menuitem"
            disabled={!reachable}
            title={!reachable ? "Agent is unreachable" : undefined}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              openExternal(dashboardUrl(agent.name, tailnet, agent.tailscale_dns_name, fleetId));
            }}
          >
            Hermes dashboard ↗
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!agent.browsers?.length || !reachable}
            title={
              !agent.browsers?.length ? "No browser" : !reachable ? "Agent is unreachable" : undefined
            }
            onClick={(e) => {
              e.stopPropagation();
              choose("desktop");
            }}
          >
            Desktop{!agent.browsers?.length ? <small>no browser</small> : null}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              choose("terminal");
            }}
          >
            Terminal
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              choose("logs");
            }}
          >
            Logs
          </button>
        </span>
      )}
    </span>
  );
}

export function AgentCard({
  agent: a,
  latest,
  tailnet,
  fleetId,
  foundation,
  profiles,
  volumes,
  now,
  listening,
  onSelect,
  onStarted,
}: Props) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const diagnosis = diagnose(a, { latest, volumes, profiles });
  const off = isOff(a);
  const behind = isBehind(a, latest);
  const pinDiff = !!a.running_hermes_version && a.running_hermes_version !== a.hermes_version;
  const disk = worstDisk(a.metrics);
  const rootWins =
    a.metrics?.root_disk_pct != null && a.metrics.root_disk_pct >= (a.metrics.disk_pct ?? 0);
  const profile = profileById(profiles, a.profile_id ?? "");
  const model = a.hermes?.model ?? profile?.model ?? "—";
  const stageList = stages(a);
  const stageAt = currentStage(a);
  const seen = a.heartbeat_age_ms === null ? null : fmtDuration(a.heartbeat_age_ms);
  const qualifier =
    a.display_status === "unreachable"
      ? seen === null
        ? "never seen"
        : `silent ${seen}`
      : a.display_status === "creating" || a.display_status === "bootstrapping"
        ? `${String(stageList.filter((s) => s.status === "ok").length).padStart(2, "0")}/${String(stageList.length).padStart(2, "0")}${stageAt ? ` ${stageLabel(stageAt).toLowerCase()}` : ""} · ${fmtDuration(Math.max(0, now - Date.parse(a.created_at)))}`
        : a.display_status === "stopped"
          ? fmtDuration(Math.max(0, now - Date.parse(a.updated_at)))
          : ["ready", "degraded", "error"].includes(a.display_status)
            ? `up ${uptime(a, now)}`
            : "";
  const mismatch = hostnameMismatch(a, tailnet, fleetId);
  const tags = [
    configOf(foundation, a.name) === "drifted" ? (
      <Tag key="drift" tone="warn">
        Drift
      </Tag>
    ) : null,
    mismatch ? (
      <Tag key="dns" tone="muted">
        DNS {mismatch.real.split(".")[0]}
      </Tag>
    ) : null,
    a.pending && diagnosis?.suppress !== "pending" ? (
      <Tag key="pending" tone="warn">
        Pending
      </Tag>
    ) : null,
    a.update_available && diagnosis?.suppress !== "update" ? (
      <Tag key="update" tone="warn">
        Update
      </Tag>
    ) : null,
  ];
  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const accepted = await startAgent(a.name);
      onStarted?.(a.name, accepted.op_id);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: empty card space is a pointer shortcut; the name button is its keyboard control.
    <div
      className={`card agent-card${off ? " off" : ""}`}
      role="group"
      aria-label={`${a.name} · ${a.display_status}`}
      data-chat-agent={a.name}
      data-listening={listening}
      style={{ borderTopColor: statusColor(a.display_status) }}
      onClick={() => onSelect(a.name)}
    >
      <ListeningBand instance={a.name} compact />
      <div className="card-body">
        <div className="card-top">
          <div className="card-identity">
            <button
              type="button"
              className="card-name-button"
              aria-label={`Open ${a.name} details`}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(a.name);
              }}
            >
              <span className="card-name listening-name">{a.name}</span>
            </button>
            <span className="card-size" title={`${a.size} · ${a.instance_type}`}>
              {sizeGlyph(a.size)}
            </span>
          </div>
          <div className="card-actions">
            {a.display_status === "stopped" ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={starting}
                onClick={(e) => {
                  e.stopPropagation();
                  void start();
                }}
              >
                {starting ? "Starting…" : "Start"}
              </button>
            ) : null}
            {!off && !isBusy(a) ? (
              <>
                <FleetChatButton instance={a.name} hideWhenUnwatched />
                <OpenMenu agent={a} tailnet={tailnet} fleetId={fleetId} onSelect={onSelect} />
              </>
            ) : null}
          </div>
        </div>
        <div className="card-status-row">
          <span
            className={`card-status${isBusy(a) ? " busy" : ""}`}
            style={{ color: statusColor(a.display_status) }}
          >
            <i style={{ background: statusColor(a.display_status) }} />
            {a.display_status}
          </span>
          {qualifier ? (
            <span className={`card-qualifier${a.display_status === "unreachable" ? " bad" : ""}`}>
              · {qualifier}
            </span>
          ) : null}
          <span className="card-status-tags">{tags}</span>
        </div>
        <div className="card-model">
          {a.provider} · {model}
        </div>
        {diagnosis ? (
          <div className={`card-diagnosis ${diagnosis.kind} ${diagnosis.tone}`}>
            {diagnosis.kind === "stage" ? (
              diagnosis.stages?.length ? (
                <div className="card-stages" role="img" aria-label="Bootstrap stages">
                  {diagnosis.stages.map((s) => (
                    <i key={s.id} className={s.status} title={`${stageLabel(s.id)} · ${s.status}`} />
                  ))}
                </div>
              ) : (
                <span className="card-diagnosis-message">Awaiting first stage report</span>
              )
            ) : (
              <>
                <span className="card-diagnosis-message">
                  {diagnosis.kind !== "urgent" ? <i aria-hidden="true">●</i> : null}
                  {diagnosis.kind === "volume" && a.volume_id ? (
                    <CopyId id={a.volume_id} label={diagnosis.message} style={{ color: "inherit" }} />
                  ) : (
                    diagnosis.message
                  )}
                  {diagnosis.more > 0 ? (
                    <span className="card-more"> +{diagnosis.more} more</span>
                  ) : null}
                </span>
                {diagnosis.evidence ? (
                  <span className="card-diagnosis-evidence">{diagnosis.evidence}</span>
                ) : null}
                {diagnosis.link && diagnosis.tab ? (
                  <button
                    type="button"
                    className="card-diagnosis-link"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(a.name, diagnosis.tab, diagnosis.logSource);
                    }}
                  >
                    {diagnosis.link} →
                  </button>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        {startError ? (
          <div className="card-start-error" role="alert">
            Start failed: {startError}
          </div>
        ) : null}
        <div className={`card-metrics${a.display_status === "unreachable" ? " stale" : ""}`}>
          {(
            [
              ["CPU", off ? null : a.metrics?.cpu_pct],
              ["MEM", off ? null : a.metrics?.mem_pct],
              [rootWins ? "ROOT" : "DISK", off ? null : disk],
            ] as const
          ).map(([label, value]) => (
            <span className="card-metric" key={label}>
              <span className="card-metric-label">{label}</span>
              <b
                style={{ color: a.display_status === "unreachable" ? "var(--fg3)" : loadColor(value) }}
              >
                {pct(value)}
              </b>
            </span>
          ))}
          <span className="card-metric version">
            <span className="card-metric-label">
              {behind && diagnosis?.suppress !== "behind" ? (
                <Tag tone="warn">Behind</Tag>
              ) : pinDiff && diagnosis?.suppress !== "pin" ? (
                <Tag tone="muted">Pin≠run</Tag>
              ) : (
                "Hermes"
              )}
            </span>
            <b
              style={{ color: behind || pinDiff ? "var(--warn)" : off ? "var(--fg3)" : undefined }}
              title={
                pinDiff
                  ? `running ${a.running_hermes_version} · pinned ${a.hermes_version}`
                  : behind
                    ? `${a.hermes_version} · fleet latest ${latest}`
                    : undefined
              }
            >
              {a.running_hermes_version ?? a.hermes_version}
            </b>
          </span>
        </div>
        {a.display_status === "unreachable" ? (
          <div className="card-stale-note">
            {seen === null ? "numbers have never been reported" : `numbers last reported ${seen} ago`}
          </div>
        ) : null}
      </div>
    </div>
  );
}
