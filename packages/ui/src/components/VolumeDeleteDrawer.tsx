/**
 * Delete a volume (§9): one stage, one typed volume id.
 *
 * Not a plan — the whole plan is one line, so a review stage would show nothing
 * the facts below already do. The typed id is what stops a mis-click, and it is
 * the same ceremony `agent destroy --yes` has. Deliberately *not* reachable from
 * the tombstone card on the fleet board, where it would sit beside "Create
 * agent".
 */
import { useState } from "react";
import { deleteVolume } from "../api/index.ts";
import type { VolumeView } from "../api/index.ts";
import { fmtDuration } from "../logic/format.ts";
import { freeFor } from "../logic/volume-logic.ts";
import { Drawer, DrawerHead } from "./Drawer.tsx";
import { TypedConfirm, confirmMatches } from "./TypedConfirm.tsx";

export function VolumeDeleteDrawer({
  volume,
  onClose,
  onDeleted,
}: {
  volume: VolumeView;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const matches = confirmMatches(typed, volume.volume_id);

  async function submit() {
    if (!matches || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await deleteVolume(volume.volume_id);
      onDeleted();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Drawer width={620} onClose={onClose} labelledBy="volume-delete-title">
      <DrawerHead
        titleId="volume-delete-title"
        kicker="Delete a volume"
        title={`Delete ${volume.agent ?? "this"}’s volume`}
        onClose={onClose}
      />
      <div className="form">
        <div className="callout bad">
          This is the only copy of <b>{volume.agent ?? "this volume"}</b>’s memory outside its
          snapshots. Deleting it is not reversible and no agent can be built from it afterwards.
        </div>

        <dl className="kv">
          <dt>volume</dt>
          <dd>{volume.volume_id}</dd>
          <dt>size</dt>
          <dd>
            {volume.size_gib} GiB · gp3 · {volume.availability_zone ?? "—"}
          </dd>
          <dt>state</dt>
          <dd>
            {volume.state} · free for {freeFor(volume, fmtDuration)}
          </dd>
          <dt>snapshots</dt>
          <dd>
            {volume.snapshots === 0 ? "none" : `${volume.snapshots}`} ·{" "}
            <b style={{ color: "var(--fg)" }}>kept</b>
          </dd>
          <dt>saves</dt>
          <dd style={{ color: "var(--ok)" }}>${volume.monthly_cost_usd.toFixed(2)} /mo</dd>
        </dl>

        <TypedConfirm
          label="Type the volume id to confirm"
          expected={volume.volume_id}
          value={typed}
          onChange={setTyped}
          onSubmit={() => void submit()}
          hint="the full id, exactly as above"
          placeholder={volume.volume_id}
          ariaLabel="Type the volume id to confirm"
          autoFocus
        />

        {failure ? (
          <div className="mono" style={{ color: "var(--bad)", fontSize: 12 }}>
            {failure}
          </div>
        ) : null}
      </div>

      <div className="drawer-foot">
        <span className="mono" style={{ fontSize: 11, color: "var(--fg3)" }}>
          $ hermetic volume delete {volume.volume_id} --yes
        </span>
        <button
          type="button"
          className="btn btn-danger"
          disabled={!matches || submitting}
          style={{ opacity: matches && !submitting ? 1 : 0.35 }}
          onClick={() => void submit()}
        >
          {submitting ? "Deleting…" : "Delete volume"}
        </button>
      </div>
    </Drawer>
  );
}
