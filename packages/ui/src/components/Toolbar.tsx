/**
 * The fleet page's toolbar: the lens switch, its legend, the filter, the layout
 * switch, and `+ New agent`.
 *
 * The headline is the switch (`N AGENTS | N VOLUMES`). Volumes used to be a
 * view of its own; it is now the fleet's second lens (`#fleet/volumes`), so the
 * number in the headline changes meaning with the lens, and each half carries
 * its own bold label for that reason. The volumes half also carries the alert
 * the old Volumes tab's badge did (`2 free · $16/mo`), in the accent colour.
 *
 * `+ New agent` is the last control, after a divider, so the view controls
 * (filter, layout) stay together and the one primary action on the page sits
 * beside the rows it adds to. It is drawn on both lenses: a loose volume is
 * usually why someone is on the volumes lens, and creating is what fixes it.
 */
import type { RefObject } from "react";
import type { VolumeSummary, VolumeView } from "../api/index.ts";
import type { FleetLens } from "../nav/fleet-nav.ts";
import type { VolumeScan } from "../logic/loading.ts";
import { VOLUME_BADGE_PENDING } from "../logic/loading.ts";
import { VOLUME_LANES } from "../logic/volume-logic.ts";
import type { Layout } from "../state/state.tsx";
import type { Counts, Sort } from "../state/state.tsx";
import { sortLabel } from "../state/state.tsx";
import { ListeningToolbar } from "./ListeningManager.tsx";
import { Skel } from "./Loading.tsx";

const LAYOUTS: Layout[] = ["board", "table", "triage"];

function laneColor(group: VolumeView["group"]): string {
  return VOLUME_LANES.find((l) => l.group === group)?.color ?? "var(--fg3)";
}

export function Toolbar({
  region,
  lens,
  onLens,
  counts,
  volumes,
  volumeSummary,
  volumesRead = true,
  volumeScan,
  onRefreshVolumes,
  showVolumes,
  onShowVolumes,
  query,
  onQuery,
  layout,
  onLayout,
  showDestroyed,
  onShowDestroyed,
  sort = null,
  onClearSort,
  scanning = false,
  filterRef,
  onNewAgent,
}: {
  region: string;
  /** Which half of the fleet page is up; the switch in the headline moves it. */
  lens: FleetLens;
  onLens: (lens: FleetLens) => void;
  counts: Counts;
  /** The whole inventory, for the volumes legend's `no agent · GiB`. */
  volumes: readonly VolumeView[];
  /** `null` until the inventory has been read once. */
  volumeSummary: VolumeSummary | null;
  /** False until the inventory has been read once; `0` would be a lie until then. */
  volumesRead?: boolean;
  /** Where the inventory's own read is (`loading.ts`). */
  volumeScan: VolumeScan;
  onRefreshVolumes: () => void;
  /** Whether the agents lens draws volumes with no agent among its cards (§9). */
  showVolumes: boolean;
  onShowVolumes: (v: boolean) => void;
  /** One filter for both lenses, so switching lens keeps what was typed. */
  query: string;
  onQuery: (v: string) => void;
  layout: Layout;
  onLayout: (l: Layout) => void;
  showDestroyed: boolean;
  onShowDestroyed: (v: boolean) => void;
  /**
   * The column order in force, chosen on the table's headers but applied to all
   * three layouts — so it has to be visible (and undoable) from the two that
   * have no headers to click.
   */
  sort?: Sort | null;
  onClearSort?: () => void;
  /** The fleet has not been read yet: every count below would be a zero it invented. */
  scanning?: boolean;
  filterRef: RefObject<HTMLInputElement | null>;
  /** The create drawer — the same nav action `n` runs. */
  onNewAgent: () => void;
}) {
  const loose = volumeSummary?.no_agent ?? 0;
  const looseMonthly = volumeSummary?.unattached_monthly_cost_usd ?? 0;
  return (
    <div className="toolbar">
      <div>
        <div className="kicker">Fleet · {region}</div>
        <div className="lens-switch" role="group" aria-label="Fleet lens">
          <button type="button" aria-pressed={lens === "agents"} onClick={() => onLens("agents")}>
            {scanning ? <Skel w="48px" h={26} /> : <b>{counts.total}</b>} agents
          </button>
          <button type="button" aria-pressed={lens === "volumes"} onClick={() => onLens("volumes")}>
            {volumeSummary ? (
              <b>{volumeSummary.total}</b>
            ) : (
              <b className="lens-pending">{volumesRead ? "—" : "···"}</b>
            )}{" "}
            volumes{" "}
            {loose > 0 ? (
              <em>
                {loose} free · ${looseMonthly.toFixed(0)}/mo
              </em>
            ) : !volumesRead && volumeSummary === null ? (
              <em className="lens-pending">{VOLUME_BADGE_PENDING}</em>
            ) : null}
          </button>
        </div>
        {lens === "agents" ? (
          <AgentLegend
            counts={counts}
            scanning={scanning}
            loose={loose}
            looseMonthly={looseMonthly}
            showVolumes={showVolumes}
            onShowVolumes={onShowVolumes}
            showDestroyed={showDestroyed}
            onShowDestroyed={onShowDestroyed}
          />
        ) : (
          <VolumeLegend volumes={volumes} summary={volumeSummary} scan={volumeScan} />
        )}
      </div>
      <div className="toolbar-right">
        {lens === "agents" && sort && onClearSort ? (
          <button
            type="button"
            className="sort-chip"
            onClick={onClearSort}
            title="Back to the order the engine returned"
          >
            sorted by {sortLabel(sort)}
            <span className="sort-chip-x" aria-hidden="true">
              ×
            </span>
            <span className="sr-only">— clear the sort</span>
          </button>
        ) : null}
        <input
          ref={filterRef}
          className="filter"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={
            lens === "agents"
              ? "filter by name, hostname, version, size…"
              : "filter by volume id, agent, size, az…"
          }
          aria-label={lens === "agents" ? "Filter agents" : "Filter volumes"}
        />
        {lens === "agents" ? (
          <div className="switch" role="group" aria-label="Layout">
            {LAYOUTS.map((l) => (
              <button type="button" key={l} onClick={() => onLayout(l)} aria-pressed={layout === l}>
                {l}
              </button>
            ))}
          </div>
        ) : (
          <>
            {/* One layout today; drawn anyway so the control sits where the agents' one does. */}
            <div className="switch" role="group" aria-label="Layout">
              <button type="button" aria-pressed={true}>
                lanes
              </button>
            </div>
            <button type="button" className="btn" onClick={onRefreshVolumes} disabled={volumeScan.busy}>
              {volumeScan.busy ? "reading…" : "refresh"}
            </button>
          </>
        )}
        <span className="toolbar-divider" aria-hidden="true" />
        <button type="button" className="btn btn-primary toolbar-new" onClick={onNewAgent}>
          <span className="toolbar-new-plus" aria-hidden="true">
            +
          </span>{" "}
          New agent
          <span className="toolbar-new-key mono" aria-hidden="true">
            N
          </span>
        </button>
      </div>
      {lens === "agents" ? <ListeningToolbar /> : null}
    </div>
  );
}

function AgentLegend({
  counts,
  scanning,
  loose,
  looseMonthly,
  showVolumes,
  onShowVolumes,
  showDestroyed,
  onShowDestroyed,
}: {
  counts: Counts;
  scanning: boolean;
  loose: number;
  looseMonthly: number;
  showVolumes: boolean;
  onShowVolumes: (v: boolean) => void;
  showDestroyed: boolean;
  onShowDestroyed: (v: boolean) => void;
}) {
  if (scanning) {
    return (
      <div className="toolbar-counts">
        <span className="legend mono" style={{ color: "var(--fg3)" }}>
          scanning for instances…
        </span>
      </div>
    );
  }
  return (
    <div className="toolbar-counts">
      <span className="legend">
        <i style={{ background: "var(--ok)" }} />
        {counts.ready} ready
      </span>
      <span className="legend">
        <i style={{ background: "var(--warn)" }} />
        {counts.degraded} degraded
      </span>
      <span className="legend">
        <i style={{ background: "var(--acc)" }} />
        {counts.busy} in progress
      </span>
      <span className="legend" style={{ color: "var(--fg2)" }}>
        <i style={{ background: "var(--fg3)" }} />
        {counts.stopped} stopped
      </span>
      {counts.unreachable > 0 ? (
        <span className="legend" style={{ color: "var(--bad)" }}>
          <i style={{ background: "var(--bad)" }} />
          {counts.unreachable} unreachable
        </span>
      ) : null}
      {loose > 0 ? (
        <button
          type="button"
          className="legend legend-link"
          style={{ color: "var(--acc)" }}
          onClick={() => onShowVolumes(!showVolumes)}
          aria-pressed={showVolumes}
          title={showVolumes ? "hide volumes with no agent" : "show volumes with no agent"}
        >
          <i style={{ background: "var(--acc)" }} />
          {loose} volume{loose === 1 ? "" : "s"} with no agent · ≈ ${looseMonthly.toFixed(0)}/mo
          <EyeIcon open={showVolumes} />
        </button>
      ) : null}
      {counts.destroyed > 0 ? (
        <button
          type="button"
          className="legend legend-link"
          style={{ color: "var(--fg2)" }}
          onClick={() => onShowDestroyed(!showDestroyed)}
          aria-pressed={showDestroyed}
          title={showDestroyed ? "hide destroyed agents" : "show destroyed agents"}
        >
          <i style={{ background: "var(--fg3)" }} />
          {counts.destroyed} destroyed
          <EyeIcon open={showDestroyed} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The volumes lens's legend: one entry per group core sorts the inventory into,
 * in the lanes' colours and order, drawn only when the group has anything in it
 * — except `attached`, which is the "all is well" line and always says so.
 */
function VolumeLegend({
  volumes,
  summary,
  scan,
}: {
  volumes: readonly VolumeView[];
  summary: VolumeSummary | null;
  scan: VolumeScan;
}) {
  if (summary === null) {
    return (
      <div className="toolbar-counts">
        <span className="legend mono" style={{ color: "var(--fg3)" }}>
          {scan.note || "reading…"}
        </span>
      </div>
    );
  }
  const looseGib = volumes
    .filter((v) => v.group === "no_agent")
    .reduce((sum, v) => sum + v.size_gib, 0);
  return (
    <div className="toolbar-counts">
      {summary.no_agent > 0 ? (
        <span className="legend" style={{ color: laneColor("no_agent") }}>
          <i style={{ background: laneColor("no_agent") }} />
          {summary.no_agent} no agent · {looseGib} GiB
        </span>
      ) : null}
      {summary.ambiguous > 0 ? (
        <span className="legend" style={{ color: laneColor("ambiguous") }}>
          <i style={{ background: laneColor("ambiguous") }} />
          {summary.ambiguous} ambiguous
        </span>
      ) : null}
      {summary.detached > 0 ? (
        <span className="legend">
          <i style={{ background: laneColor("detached") }} />
          {summary.detached} detached · agent exists
        </span>
      ) : null}
      <span className="legend" style={{ color: "var(--fg2)" }}>
        <i style={{ background: "var(--ok)" }} />
        {summary.attached} attached
      </span>
      {summary.unmanaged > 0 ? (
        <span className="legend" style={{ color: "var(--fg3)" }}>
          <i style={{ background: "var(--fg3)" }} />
          {summary.unmanaged} not this fleet
        </span>
      ) : null}
    </div>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      className="eye-icon"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {open ? (
        <>
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : (
        <>
          <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a20.3 20.3 0 0 1 5.06-5.94M9.9 4.24A10.5 10.5 0 0 1 12 4c7 0 11 8 11 8a20.3 20.3 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24" />
          <path d="M1 1l22 22" />
        </>
      )}
    </svg>
  );
}
