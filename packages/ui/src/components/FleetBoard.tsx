import { useListeningIfAvailable } from "../state/listening-state.tsx";
import type { AgentView, ProfileView, VolumeView } from "../api/index.ts";
import type { AgentTab } from "../nav/agent-nav.ts";
import type { SkewStatusView } from "../logic/skew-logic.ts";
import { boardVolumes } from "../logic/volume-logic.ts";
import { AgentCard } from "./AgentCard.tsx";
import { MoreVolumesCard, VolumeTombstone } from "./LooseVolumes.tsx";

/** Cards on a 2px grid, top-bordered in the status colour. */
export function FleetBoard({
  agents,
  latest,
  foundation,
  profiles = [],
  tailnet,
  fleetId,
  volumes,
  onSelect,
  onStarted,
  onCreateOnVolume,
  onSeeVolumes,
}: {
  agents: AgentView[];
  latest: string | null;
  foundation?: SkewStatusView | null;
  profiles?: readonly ProfileView[];
  tailnet: string;
  fleetId?: string | null;
  volumes: VolumeView[];
  onSelect: (name: string, tab?: AgentTab, logSource?: "console") => void;
  onStarted?: (name: string, opId: string) => void;
  onCreateOnVolume: (v: VolumeView) => void;
  onSeeVolumes: () => void;
}) {
  const listening = useListeningIfAvailable();
  const now = Date.now();
  const board = boardVolumes(volumes, agents);
  return (
    <div className="board">
      {agents.map((agent) => (
        <AgentCard
          key={agent.name}
          agent={agent}
          latest={latest}
          foundation={foundation}
          profiles={profiles}
          tailnet={tailnet}
          fleetId={fleetId}
          volumes={volumes}
          now={now}
          listening={!!listening?.instances.includes(agent.name)}
          onSelect={onSelect}
          onStarted={onStarted}
        />
      ))}
      {board.shown.map((v) => (
        <VolumeTombstone key={v.volume_id} v={v} onCreate={onCreateOnVolume} />
      ))}
      <MoreVolumesCard board={board} onSeeVolumes={onSeeVolumes} />
    </div>
  );
}
