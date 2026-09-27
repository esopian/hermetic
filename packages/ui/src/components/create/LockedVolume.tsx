/**
 * §9's reclaim path: the data volume this agent is built on, as a locked row
 * above the preset strip. No preset and no Customize field changes it — the
 * request sends the volume's id, never a size.
 */
import type { VolumeView } from "../../api/index.ts";

export function LockedVolume({ volume, name }: { volume: VolumeView; name: string }) {
  const renaming = volume.agent !== name;
  return (
    <div>
      <div className="kicker" style={{ marginBottom: 8 }}>
        Data volume · locked
      </div>
      <div className="locked-volume">
        <div style={{ minWidth: 0 }}>
          <div className="mono lv-id">{volume.volume_id}</div>
          <div className="name-hint" style={{ color: "var(--fg3)" }}>
            {volume.size_gib} GiB · gp3 · {volume.availability_zone ?? "—"} · {volume.snapshots}{" "}
            snapshot
            {volume.snapshots === 1 ? "" : "s"}
          </div>
        </div>
        <span className="tag ghost">no CreateVolume</span>
      </div>
      <div className="cr-hint">
        Mounted, never formatted — what is on it comes back on first boot. Launches in{" "}
        {volume.availability_zone ?? "the volume’s zone"} to match.
      </div>
      {renaming ? (
        <div className="cr-hint" style={{ color: "var(--warn)" }}>
          Its <span className="mono">agent</span> tag moves from <b>{volume.agent ?? "(none)"}</b> to{" "}
          <b>{name || "the new name"}</b> as part of the create, so hermetic can find it again. Recorded
          as an event; not confirmed a second time.
        </div>
      ) : null}
    </div>
  );
}
