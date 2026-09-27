/**
 * Volumes with no agent, as the fleet views draw them.
 *
 * A loose volume is a dead agent's memory that is still billing, and it is the
 * one thing the fleet could not tell you at all before §9. The board and the
 * table each grew their own rendering of it; triage — the layout whose whole
 * job is "what needs a human" — had none, so the one screen an operator opens
 * to triage a fleet was the one that hid the tombstones.
 *
 * `boardVolumes` (pure, in `volume-logic.ts`) still decides *which* volumes
 * reach a fleet view and how many; this is only how they are drawn.
 */
import type { VolumeView } from "../api/index.ts";
import { fmtDuration } from "../logic/format.ts";
import type { BoardVolumes } from "../logic/volume-logic.ts";
import { CopyId, StatusDot } from "./primitives.tsx";

/**
 * A volume whose agent is gone: drawn where that agent used to be. One action —
 * the create drawer, with this volume locked. Delete is deliberately absent: on
 * a card whose other button is "Create agent", it is one mis-click from
 * destroying the thing you came to reclaim, so it lives on the volumes lens
 * where the id has to be typed.
 */
export function VolumeTombstone({ v, onCreate }: { v: VolumeView; onCreate: (v: VolumeView) => void }) {
  return (
    <div
      className="card vol"
      role="group"
      aria-label={`${v.agent ?? "untagged"} · volume with no agent`}
    >
      <div className="card-top">
        <div style={{ minWidth: 0 }}>
          <div className="card-name dim">{v.agent ?? "untagged"}</div>
          <div className="card-host">
            <CopyId id={v.volume_id} note={`${v.size_gib} GiB`} />
          </div>
          <div className="card-sub">
            no instance · volume kept, free for {fmtDuration(v.free_for_ms ?? 0)}
          </div>
        </div>
        <span className="tag ghost">volume</span>
      </div>
      <div className="cell-status" style={{ color: "var(--acc)" }}>
        <StatusDot status="creating" />
        memory kept
        <span className="mono" style={{ color: "var(--fg3)", fontWeight: 500, textTransform: "none" }}>
          · {v.size_gib} GiB · ${v.monthly_cost_usd.toFixed(0)}/mo
        </span>
      </div>
      <div className="card-foot">
        <div>
          <div className="kicker">Snapshots</div>
          <div className="mono card-vol">{v.snapshots === 0 ? "none" : `${v.snapshots} kept`}</div>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => onCreate(v)}>
          Create agent →
        </button>
      </div>
    </div>
  );
}

/**
 * The `+ N more` card: what the tombstone cap held back, plus the loose volumes
 * the fleet deliberately never shows (ambiguous pairs and strays), which are
 * only ever reachable from the fleet's volumes lens.
 */
export function MoreVolumesCard({
  board,
  onSeeVolumes,
}: {
  board: BoardVolumes;
  onSeeVolumes: () => void;
}) {
  if (board.overflow.count === 0 && board.hiddenElsewhere === 0) return null;
  return (
    <div className="card more-card">
      <div className="kicker">
        {board.overflow.count > 0
          ? `${board.overflow.count} more volume${board.overflow.count === 1 ? "" : "s"} with no agent`
          : "More in Volumes"}
      </div>
      <div className="mono more-card-sub">
        {board.overflow.count > 0 ? (
          <>
            {board.overflow.gib} GiB · ≈ ${board.overflow.monthly.toFixed(0)}/mo
            <br />
          </>
        ) : null}
        {board.hiddenElsewhere > 0 ? (
          <span className="dim">
            {board.hiddenElsewhere} not shown here (ambiguous or not this fleet)
          </span>
        ) : null}
      </div>
      <button type="button" className="btn btn-sm" onClick={onSeeVolumes}>
        All volumes →
      </button>
    </div>
  );
}

/**
 * The whole lane, for a layout that draws groups rather than a grid: the
 * headline an operator triages on (how much idle memory, costing what) and the
 * tombstones themselves. Renders nothing when there is nothing loose — a lane
 * that says "0 volumes with no agent" is noise on the screen whose point is
 * what needs attention.
 */
export function LooseVolumesGroup({
  board,
  onCreate,
  onSeeVolumes,
}: {
  board: BoardVolumes;
  onCreate: (v: VolumeView) => void;
  onSeeVolumes: () => void;
}) {
  const shown = board.shown;
  const count = shown.length + board.overflow.count;
  if (count === 0 && board.hiddenElsewhere === 0) return null;
  const gib = shown.reduce((n, v) => n + v.size_gib, 0) + board.overflow.gib;
  const monthly = shown.reduce((n, v) => n + v.monthly_cost_usd, 0) + board.overflow.monthly;
  return (
    <div className="group">
      <div className="group-side">
        <div className="group-label" style={{ color: "var(--acc)" }}>
          <i style={{ background: "var(--acc)" }} />
          volumes · no agent
        </div>
        <div className="group-count">{count}</div>
        <div className="group-hint">
          {count > 0
            ? `${gib} GiB · ≈ $${monthly.toFixed(2)}/mo · nothing is reading them. Put a new agent on one, or delete it in Volumes.`
            : "Nothing loose on this board; the volumes lens has the rest."}
        </div>
      </div>
      <div className="loose-cards">
        {shown.map((v) => (
          <VolumeTombstone key={v.volume_id} v={v} onCreate={onCreate} />
        ))}
        <MoreVolumesCard board={board} onSeeVolumes={onSeeVolumes} />
      </div>
    </div>
  );
}
