/**
 * The fleet's volumes lens (§9), lane-shaped rather than table-shaped.
 *
 * This was a top-level Volumes view; it is now the body the fleet page draws
 * under its own toolbar when the headline switch is on `N VOLUMES`
 * (`#fleet/volumes`). The toolbar — lens switch, legend, the one filter, the
 * refresh — is `Toolbar.tsx`'s; this component is only what sits beneath it.
 *
 * The question it answers is "which memory has nobody reading it, and what is
 * that costing" — a list of every EBS volume in the account would be the cheap
 * half of that. Lanes come in the order core groups them: what nothing is
 * reading first.
 */
import { useMemo } from "react";
import type { VolumeSummary, VolumeView } from "../api/index.ts";
import { ebsVolumeConsoleUrl, fmtDuration } from "../logic/format.ts";
import { VOLUME_LANES, filterVolumes, freeFor } from "../logic/volume-logic.ts";
import type { VolumeScan } from "../logic/loading.ts";
import { CopyId, Kicker } from "./primitives.tsx";
import { ScanBar, VolumesSkeleton } from "./Loading.tsx";

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** A card in the two lanes an operator can act on, or read about. */
function ClaimCard({
  v,
  color,
  region,
  onCreate,
  onDelete,
  onGoToAgent,
}: {
  v: VolumeView;
  color: string;
  /** The frozen home's region; the console is regional, so without it there is no link. */
  region: string | null;
  onCreate: (v: VolumeView) => void;
  onDelete: (v: VolumeView) => void;
  onGoToAgent: (name: string) => void;
}) {
  const actionable = v.group === "no_agent";
  const consoleUrl = ebsVolumeConsoleUrl(v.volume_id, region);
  return (
    <div className="claim" style={{ borderTopColor: color }}>
      <div>
        <div className="claim-id mono">
          <CopyId id={v.volume_id} note={`${v.size_gib} GiB`} />
        </div>
        <div className="claim-agent">
          <b>{v.agent ?? "untagged"}</b>
          {v.group === "no_agent" ? <span className="tag ghost">agent gone</span> : null}
          {v.group === "detached" ? <span className="tag warn">agent still exists</span> : null}
          {v.group === "ambiguous" ? <span className="tag bad">ambiguous</span> : null}
          {v.group === "unmanaged" ? <span className="tag ghost">not this fleet</span> : null}
        </div>
      </div>
      <dl className="kv">
        <dt>free for</dt>
        <dd style={{ color: v.attached ? undefined : color }}>{freeFor(v, fmtDuration)}</dd>
        <dt>size</dt>
        <dd>
          {v.size_gib} GiB · gp3 · {v.availability_zone ?? "—"}
        </dd>
        <dt>snapshots</dt>
        <dd>
          {v.snapshots === 0
            ? "none"
            : `${v.snapshots} · newest ${v.newest_snapshot_at?.slice(0, 10) ?? "—"}`}
        </dd>
        <dt>cost</dt>
        <dd style={{ color: "var(--warn)" }}>≈ {usd(v.monthly_cost_usd)} /mo</dd>
      </dl>
      <div className="claim-foot">
        {actionable ? (
          <>
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={() => onCreate(v)}
            >
              Create agent →
            </button>
            <button type="button" className="btn btn-danger" onClick={() => onDelete(v)}>
              Delete…
            </button>
          </>
        ) : v.group === "detached" && v.agent ? (
          <button
            type="button"
            className="btn"
            style={{ flex: 1 }}
            onClick={() => onGoToAgent(v.agent as string)}
          >
            Go to {v.agent} →
          </button>
        ) : v.group === "ambiguous" ? (
          <div className="claim-note mono">
            Also tagged <b>agent={v.agent}</b>: {v.ambiguous_with.join(", ")}. Tag the real one{" "}
            <span className="nowrap">hermetic:role=data</span> and it leaves this lane on the next read.
            {/*
              Tagging is the one thing hermetic will not do here — it refuses to
              guess which volume holds the memory (§9) — so the least it owes is
              the page where the operator can. Same helper the drawer's instance
              id uses; null (no region yet) drops the link, never the note.
            */}
            {consoleUrl ? (
              <>
                {" "}
                <a href={consoleUrl} target="_blank" rel="noreferrer noopener">
                  Open {v.volume_id} in the EC2 console ↗
                </a>
              </>
            ) : null}
          </div>
        ) : (
          <div className="claim-note mono">
            Read-only. hermetic did not create this volume and will not guess what it holds.
          </div>
        )}
      </div>
    </div>
  );
}

/** The dense list the two "nothing to do here" lanes use. */
function VolumeRows({ rows }: { rows: VolumeView[] }) {
  return (
    <div className="vrows">
      {rows.map((v) => (
        <div key={v.volume_id} className="vrow">
          <span className="mono vrow-id">
            <CopyId id={v.volume_id} note={`${v.size_gib} GiB`} />
          </span>
          <span className="vrow-state" style={{ color: v.attached ? "var(--ok)" : "var(--fg3)" }}>
            <i style={{ background: v.attached ? "var(--ok)" : "var(--fg3)" }} />
            {v.state}
          </span>
          <span className="vrow-agent">
            <b>{v.agent ?? "—"}</b>
            <span className="mono dim">
              {v.attached_to ? ` · ${v.attached_to} · /dev/sdf` : ` · ${v.availability_zone ?? "—"}`}
            </span>
          </span>
          <span className="mono">{v.size_gib} GiB</span>
          <span className="mono right">{usd(v.monthly_cost_usd)}</span>
        </div>
      ))}
    </div>
  );
}

export function VolumesView({
  volumes,
  summary,
  error,
  region = null,
  scan,
  query,
  onClearQuery,
  onCreate,
  onDelete,
  onGoToAgent,
}: {
  volumes: VolumeView[];
  summary: VolumeSummary | null;
  error: string | null;
  /** The frozen home's region, for the AWS console deep-links. */
  region?: string | null;
  /** Where the inventory's own read is (`loading.ts`); never a bare boolean. */
  scan: VolumeScan;
  /** The fleet toolbar's filter, shared with the agents lens. */
  query: string;
  onClearQuery: () => void;
  onCreate: (v: VolumeView) => void;
  onDelete: (v: VolumeView) => void;
  onGoToAgent: (name: string) => void;
}) {
  const q = query.trim();
  const shown = useMemo(() => filterVolumes(volumes, query), [volumes, query]);

  return (
    <>
      {/* A re-read over data that is already on screen: motion, not a blanked page. */}
      {scan.busy ? <ScanBar style={{ margin: "0 24px" }} /> : null}

      {error ? (
        <div className="volumes-error mono">
          could not read the volume inventory: {error}
          {volumes.length > 0 ? " — showing the last good read" : ""}
        </div>
      ) : null}

      <div className="volumes-body">
        {/* The fleet toolbar and its filter stay put; only the body is unknown yet. */}
        {scan.skeleton ? <VolumesSkeleton /> : null}

        {!scan.skeleton && volumes.length > 0 && shown.length === 0 && q ? (
          <div className="empty" role="status">
            <b>No matching volumes</b>
            <div className="mono hint">No volume matches “{query}”.</div>
            <button type="button" className="btn btn-secondary" onClick={onClearQuery}>
              Clear filter
            </button>
          </div>
        ) : null}

        {scan.empty && !error ? (
          <div className="empty">
            <i style={{ background: "var(--ok)", width: 22, height: 22, display: "block" }} />
            <b>Nothing loose</b>
            <div className="mono hint">
              Every data volume is attached to a running agent. Destroyed agents keep their volumes by
              default — when one does, it shows up here and on the agents board.
            </div>
          </div>
        ) : null}

        {VOLUME_LANES.map((lane) => {
          const rows = shown.filter((v) => v.group === lane.group);
          if (rows.length === 0) return null;
          const dense = lane.group === "attached" || lane.group === "unmanaged";
          return (
            <div key={lane.group} className="lane">
              <div className="lane-label">
                <Kicker style={{ color: lane.color }}>{lane.title}</Kicker>
                <div className="lane-n">{rows.length}</div>
                <div className="lane-hint">{lane.hint}</div>
              </div>
              {dense ? (
                <VolumeRows rows={rows} />
              ) : (
                <div className="claims">
                  {rows.map((v) => (
                    <ClaimCard
                      key={v.volume_id}
                      v={v}
                      color={lane.color}
                      region={region}
                      onCreate={onCreate}
                      onDelete={onDelete}
                      onGoToAgent={onGoToAgent}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {summary && summary.snapshots > 0 ? (
          <div className="lane">
            <div className="lane-label">
              <Kicker style={{ color: "var(--fg3)" }}>Snapshots</Kicker>
              <div className="lane-n">{summary.snapshots}</div>
              <div className="lane-hint">
                Data Lifecycle Manager, daily, keep 7 per volume. Configured in the foundation stack;
                never deleted by destroy or teardown unless asked.
              </div>
            </div>
            <div className="vrows">
              <div className="vrow">
                <span className="mono dim" style={{ gridColumn: "1 / -1" }}>
                  {summary.snapshots} snapshot{summary.snapshots === 1 ? "" : "s"} across{" "}
                  {summary.total} volume{summary.total === 1 ? "" : "s"} — deleting a volume keeps its
                  snapshots
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
