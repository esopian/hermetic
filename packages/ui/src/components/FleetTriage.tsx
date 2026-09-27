import { FleetChatButton } from "../chat/components/FleetChatButton.tsx";
import { ListenButton } from "./ListenButton.tsx";
/** The grouped layout: what needs a human, what is moving, what is fine. */
import type { AgentView, VolumeView } from "../api/index.ts";
import { hostname, pct, sizeGlyph, uptime, versionColor } from "../logic/format.ts";
import type { TriageGroup } from "../state/state.tsx";
import { boardVolumes } from "../logic/volume-logic.ts";
import { LooseVolumesGroup } from "./LooseVolumes.tsx";
import { HealthSquares } from "./primitives.tsx";

function Row({
  agent,
  latest,
  tailnet,
  fleetId,
  selected,
  onSelect,
  now,
}: {
  agent: AgentView;
  latest: string | null;
  tailnet: string;
  fleetId?: string | null;
  selected: string | null;
  onSelect: (name: string) => void;
  now: number;
}) {
  return (
    <div
      data-chat-agent={agent.name}
      className={selected === agent.name ? "grow selected" : "grow"}
      tabIndex={0}
      role="button"
      aria-label={`${agent.name} · ${agent.display_status}`}
      onClick={() => onSelect(agent.name)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect(agent.name);
        }
      }}
    >
      <span className="nm">
        <b>{agent.name}</b>
        <ListenButton instance={agent.name} />
        <FleetChatButton instance={agent.name} />
        <HealthSquares agent={agent} className="sq" styled={false} />
      </span>
      <span className="m" style={{ color: versionColor(agent, latest) }}>
        {agent.hermes_version}
      </span>
      <span className="cell-size">
        <b className="sizebox" style={{ fontSize: 12, lineHeight: "18px", padding: "0 5px" }}>
          {sizeGlyph(agent.size)}
        </b>
        <span className="it">{agent.instance_type}</span>
      </span>
      <span className="m">
        {pct(agent.metrics?.cpu_pct)} / {pct(agent.metrics?.mem_pct)}
      </span>
      <span className="m">{hostname(agent.name, tailnet, agent.tailscale_dns_name, fleetId)}</span>
      <span className="r">{uptime(agent, now)}</span>
    </div>
  );
}

export function FleetTriage({
  groups,
  latest,
  tailnet,
  fleetId,
  selected,
  volumes,
  showDestroyed,
  agents,
  onSelect,
  onCreateOnVolume,
  onSeeVolumes,
}: {
  groups: TriageGroup[];
  latest: string | null;
  tailnet: string;
  fleetId?: string | null;
  selected: string | null;
  /** The inventory, so this layout stops being the one that hides the tombstones. */
  volumes: VolumeView[];
  showDestroyed: boolean;
  /** Every visible agent, so a volume whose row is already on screen is not drawn twice. */
  agents: AgentView[];
  onSelect: (name: string) => void;
  onCreateOnVolume: (v: VolumeView) => void;
  onSeeVolumes: () => void;
}) {
  const now = Date.now();
  const board = boardVolumes(volumes, agents, showDestroyed);
  return (
    <div className="body-scroll">
      {groups.map((g) => (
        <div className="group" key={g.key}>
          <div className="group-side">
            <div className="group-label" style={{ color: g.color }}>
              <i style={{ background: g.color }} />
              {g.label}
            </div>
            <div className="group-count">{g.items.length}</div>
            <div className="group-hint">{g.hint}</div>
          </div>
          <div>
            {g.items.map((a) => (
              <Row
                key={a.name}
                agent={a}
                latest={latest}
                tailnet={tailnet}
                fleetId={fleetId}
                selected={selected}
                onSelect={onSelect}
                now={now}
              />
            ))}
            {g.items.length === 0 ? <div className="group-empty">— none —</div> : null}
          </div>
        </div>
      ))}
      {/*
        Last, under the agent groups, for the same reason the board puts the
        tombstones after the cards: a volume with no agent is a loose end, not a
        member of the fleet — but it bills like one, and this was the only
        layout that never said so.
      */}
      <LooseVolumesGroup board={board} onCreate={onCreateOnVolume} onSeeVolumes={onSeeVolumes} />
    </div>
  );
}
