import { useListeningIfAvailable } from "../state/listening-state.tsx";
import { FleetChatButton } from "../chat/components/FleetChatButton.tsx";
import { ListeningBand, ListeningConnection } from "./ListenButton.tsx";
/** Cards on a 2px grid, top-bordered in the status colour. */
import type { AgentView, VolumeView } from "../api/index.ts";
import { currentStageLabel } from "../logic/bootstrap.ts";
import {
  dashboardUrl,
  healthTitle,
  hostname,
  isOff,
  pct,
  sizeGlyph,
  statusColor,
  uptime,
  versionColor,
} from "../logic/format.ts";
import { lastSeenLabel } from "../logic/liveness-logic.ts";
import { openExternal } from "../lib/open-external.ts";
import { CopyId, HealthSquares, StatusDot } from "./primitives.tsx";
import { MoreVolumesCard, VolumeTombstone } from "./LooseVolumes.tsx";
import { boardVolumes, volumeLine, volumeOf } from "../logic/volume-logic.ts";

/** Browser window: the agent's own Hermes dashboard, one hop away. */
function DashboardIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="4" width="18" height="16" />
      <path d="M3 9h18" />
    </svg>
  );
}

/**
 * The card's one quick action: open this agent's Hermes dashboard on the
 * tailnet. The card itself opens the drawer, so the button has to stop the
 * click from reaching it.
 */
function OpenDashboard({
  name,
  tailnet,
  fleetId,
  dnsName,
}: {
  name: string;
  tailnet: string;
  fleetId?: string | null;
  // The name the node actually holds; after a recreate the canonical one still
  // resolves to the terminated box, so the button would open nothing.
  dnsName?: string | null;
}) {
  return (
    <button
      type="button"
      className="card-open"
      title={`Open ${name}'s Hermes dashboard`}
      aria-label={`Open ${name}'s Hermes dashboard`}
      onClick={(e) => {
        e.stopPropagation();
        openExternal(dashboardUrl(name, tailnet, dnsName, fleetId));
      }}
    >
      <DashboardIcon />
    </button>
  );
}

export function FleetBoard({
  agents,
  latest,
  tailnet,
  fleetId,
  volumes,
  onSelect,
  onCreateOnVolume,
  onSeeVolumes,
}: {
  agents: AgentView[];
  latest: string | null;
  tailnet: string;
  fleetId?: string | null;
  /** The inventory, so a card can say what its volume is actually doing. */
  volumes: VolumeView[];
  onSelect: (name: string) => void;
  onCreateOnVolume: (v: VolumeView) => void;
  onSeeVolumes: () => void;
}) {
  const listening = useListeningIfAvailable();
  const now = Date.now();
  const board = boardVolumes(volumes, agents);
  return (
    <div className="board">
      {agents.map((a) => {
        const off = isOff(a);
        const stage = currentStageLabel(a);
        // How stale the silence is. `unreachable` alone does not distinguish a
        // box that missed two heartbeats from one that has been gone a day.
        const seen = lastSeenLabel(a);
        return (
          <div
            key={a.name}
            data-chat-agent={a.name}
            data-listening={listening?.instances.includes(a.name)}
            className={off ? "card off" : "card"}
            style={{ borderTopColor: statusColor(a.display_status) }}
            tabIndex={0}
            role="button"
            aria-label={`${a.name} · ${a.display_status}`}
            onClick={() => onSelect(a.name)}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                onSelect(a.name);
              }
            }}
          >
            <ListeningBand instance={a.name} />
            <div className="card-top">
              <div style={{ minWidth: 0 }}>
                <div className="card-name">
                  <span className="listening-name">{a.name}</span>
                </div>
                <div className="card-host">
                  {hostname(a.name, tailnet, a.tailscale_dns_name, fleetId)}
                </div>
                <div className="card-sub">
                  {a.tailscale_ip ?? "—"} · cpu {pct(off ? null : a.metrics?.cpu_pct)} · mem{" "}
                  {pct(off ? null : a.metrics?.mem_pct)}
                </div>
              </div>
              <span className="card-actions">
                <FleetChatButton instance={a.name} />
                {off ? null : (
                  <OpenDashboard
                    name={a.name}
                    tailnet={tailnet}
                    fleetId={fleetId}
                    dnsName={a.tailscale_dns_name}
                  />
                )}
                <b className="sizebox">{sizeGlyph(a.size)}</b>
              </span>
            </div>
            <div className="cell-status" style={{ color: statusColor(a.display_status) }}>
              <StatusDot status={a.display_status} />
              {a.display_status}
              {stage ? <span className="status-sub">{stage}</span> : null}
              <span
                className="mono"
                style={{ color: "var(--fg3)", fontWeight: 500, textTransform: "none" }}
              >
                · {uptime(a, now)}
                {seen ? ` · ${seen}` : ""}
              </span>
            </div>
            <div className="card-foot">
              <div style={{ minWidth: 0 }}>
                {(() => {
                  // The volume line replaces the health squares only when there
                  // is something to say about it — the squares are the health of
                  // a *running* agent, and this is the health of its memory.
                  const line = volumeLine(a, volumeOf(a, volumes));
                  if (!line) {
                    return (
                      <>
                        <div className="kicker">Health · {healthTitle(a)}</div>
                        {/*
                          The shared primitive, not a fourth inline copy of the
                          three squares: the board's used to be colour-only,
                          because the `title` the primitive carries was the one
                          thing the copy dropped. `.card-foot .squares` sizes
                          them, so no inline sizing.
                        */}
                        <HealthSquares agent={a} className="squares" styled={false} />
                      </>
                    );
                  }
                  return (
                    <>
                      <div
                        className="kicker"
                        style={{ color: line.state === "detached" ? "var(--warn)" : undefined }}
                      >
                        Data volume{line.state === "detached" ? " · safe" : ""}
                      </div>
                      <div className="mono card-vol" style={{ color: line.color }}>
                        <i style={{ background: line.color }} />
                        <CopyId
                          id={line.id}
                          label={`${line.label}${line.state ? ` · ${line.state}` : ""}`}
                          note={line.note}
                          style={{ color: "inherit" }}
                        />
                      </div>
                    </>
                  );
                })()}
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="kicker">Version</div>
                <div className="card-ver" style={{ color: versionColor(a, latest) }}>
                  {a.hermes_version}
                </div>
              </div>
            </div>
            <ListeningConnection instance={a.name} />
          </div>
        );
      })}

      {board.shown.map((v) => (
        <VolumeTombstone key={v.volume_id} v={v} onCreate={onCreateOnVolume} />
      ))}

      <MoreVolumesCard board={board} onSeeVolumes={onSeeVolumes} />
    </div>
  );
}
