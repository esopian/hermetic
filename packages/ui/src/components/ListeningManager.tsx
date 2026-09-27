import { useId, useState } from "react";
import type { AgentView } from "../api/index.ts";
import { useListeningIfAvailable } from "../state/listening-state.tsx";
import { useFleetIfAvailable } from "../state/state.tsx";
import { Drawer, DrawerHead } from "./Drawer.tsx";
import { ListeningSignal } from "./ListenButton.tsx";
import { StatusDot } from "./primitives.tsx";

/** Draft only the user's changes, so a refresh never overwrites untouched preferences. */
export function ListeningManager({ agents, onClose }: { agents: AgentView[]; onClose: () => void }) {
  const listening = useListeningIfAvailable();
  const titleId = useId();
  const [edits, setEdits] = useState(new Map<string, boolean>());
  const [saving, setSaving] = useState(false);
  if (!listening) return null;
  const eligible = agents.filter((agent) => agent.status !== "destroyed");
  const checked = (name: string) => edits.get(name) ?? listening.instances.includes(name);
  const count = eligible.filter((agent) => checked(agent.name)).length;
  const busy = saving || listening.loading || listening.pending.length > 0;
  const close = () => {
    if (!saving) onClose();
  };
  const apply = async () => {
    setSaving(true);
    try {
      for (const agent of eligible) {
        const desired = edits.get(agent.name);
        if (desired === undefined || desired === listening.instances.includes(agent.name)) continue;
        const saved = await listening.setListening(agent.name, desired);
        // Keep the drawer and its draft open on failure, with the provider's error.
        if (!saved) return;
        setEdits((previous) => {
          const next = new Map(previous);
          next.delete(agent.name);
          return next;
        });
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer width={520} onClose={close} labelledBy={titleId}>
      <DrawerHead
        titleId={titleId}
        kicker="Fleet · local preference"
        title="Listening"
        sub={
          <div className="mono listening-drawer-sub">
            Select the instances whose bots and alerts you want to follow.
          </div>
        }
        onClose={close}
      />
      <div className="drawer-body">
        {listening.error && (
          <div className="listening-manager-error" role="alert">
            {listening.error}
          </div>
        )}
        <div className="listening-manager-tools">
          <span className="mono">{count} selected</span>
          <button
            className="linkish"
            type="button"
            disabled={busy || eligible.length === 0}
            onClick={() =>
              setEdits(new Map(eligible.map((agent) => [agent.name, count !== eligible.length])))
            }
          >
            {count === eligible.length && count > 0 ? "Clear all" : "Select all"}
          </button>
        </div>
        {eligible.length === 0 && (
          <p className="listening-manager-empty">No instances available to listen to.</p>
        )}
        {eligible.map((agent) => (
          <label className="listening-manager-row" key={agent.name}>
            <input
              type="checkbox"
              checked={checked(agent.name)}
              disabled={busy}
              aria-label={`Listen to ${agent.name}`}
              onChange={(event) => {
                const value = event.target.checked;
                setEdits((previous) => new Map(previous).set(agent.name, value));
              }}
            />
            <strong>{agent.name}</strong>
            <span className="cell-status" style={{ color: "var(--fg2)" }}>
              <StatusDot status={agent.display_status} />
              {agent.display_status}
            </span>
          </label>
        ))}
      </div>
      <div className="drawer-foot listening-manager-actions">
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void apply()}>
          {saving ? "Saving…" : `Apply · ${count} instances`}
        </button>
      </div>
    </Drawer>
  );
}

export function ListeningToolbar() {
  const listening = useListeningIfAvailable();
  const fleet = useFleetIfAvailable();
  const [managing, setManaging] = useState(false);
  if (!listening || !fleet) return null;
  const agents = fleet.agents.filter((agent) => agent.status !== "destroyed");
  const count = agents.filter((agent) => listening.instances.includes(agent.name)).length;
  return (
    <>
      <div className="listening-toolbar-row">
        <span className="mono listening-toolbar-count">
          <ListeningSignal on={count > 0} />
          {listening.loading ? "Loading listening…" : `${count} listening`}
          <span className="listening-toolbar-help"> · chat & alerts</span>
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={listening.loading}
          onClick={() => setManaging(true)}
        >
          Manage listening
        </button>
      </div>
      {managing && <ListeningManager agents={agents} onClose={() => setManaging(false)} />}
    </>
  );
}
