/**
 * The agent drawer's memory-provider switch (§6.2): choose, read what the
 * switch does, confirm.
 *
 * Unlike a profile change, `agents.set` writes the new provider straight onto
 * the row — there is no staged `pending` for memory — so the switch is one
 * confirmed action: save, then (for a running agent) the same one-agent
 * rollout the profile panel drives, `plan.rollout` then `apply`, which has the
 * box re-apply its configuration and restart Hermes. A stopped agent is saved
 * only and switches at its next rollout or recreate.
 *
 * The confirmation is the point of the second step. Switching never deletes
 * anything (the old provider's data stays on the data volume and is found again
 * on a switch back), but nothing migrates either: the new provider starts from
 * whatever it already has on this volume. Those two facts are what an operator
 * needs before pressing the button, so the step states them every time.
 */
import { useId, useState } from "react";
import { applyPlan, planRollout, setAgentProfile } from "../api/index.ts";
import type { AgentView } from "../api/index.ts";
import {
  type MemoryChoice,
  currentMemoryChoice,
  memoryAgentCard,
  memoryChoiceIsService,
  memoryChoiceLabel,
  memoryOptions,
  memorySwitchesLive,
} from "../logic/memory-logic.ts";
import { saveErrorMessage } from "../logic/set-errors.ts";
import { MemoryProviderCard } from "./MemoryProviderCard.tsx";

export function MemoryProviderEdit({
  agent,
  busy,
  onRunOp,
  onClose,
}: {
  agent: AgentView;
  busy: boolean;
  onRunOp: (label: string, fn: () => Promise<{ op_id: string }>) => Promise<void>;
  /**
   * The editor is done: cancelled (`null`), or saved, with the note the panel
   * shows afterwards for an agent that is not running.
   */
  onClose: (note: string | null) => void;
}) {
  const current = currentMemoryChoice(agent);
  const options = memoryOptions(agent);
  /** Core's converge rule: anything not ready/degraded/error is saved only. */
  const offline = !memorySwitchesLive(agent);
  const status = agent.status ?? agent.display_status;
  const waits = `this agent is ${status === "stopped" ? "not running" : status}, so nothing switches yet — it switches at the next rollout or recreate`;
  const [choice, setChoice] = useState<MemoryChoice>(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const fitId = useId();

  const option = options.find((o) => o.value === choice);
  const changed = choice !== current;
  const blocked = option?.reason ?? null;
  const fromLabel = memoryChoiceLabel(current);
  const toLabel = memoryChoiceLabel(choice);
  const fromProvider = current === "none" ? null : fromLabel;
  const card = memoryAgentCard(choice, agent);

  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      await setAgentProfile({
        name: agent.name,
        // As the profile panel sends it: only when the view carries a version.
        ...(typeof agent.version === "number" ? { expected_version: agent.version } : {}),
        memory_provider: choice,
      });
    } catch (e) {
      setError(saveErrorMessage(e));
      setSaving(false);
      return;
    }
    if (offline) {
      setSaving(false);
      onClose(`Memory saved as ${toLabel} · ${waits}`);
      return;
    }
    try {
      const plan = await planRollout([agent.name]);
      setSaving(false);
      onClose(null);
      await onRunOp("rollout", () => applyPlan(plan));
    } catch (e) {
      // The row already holds the new provider; only the rollout is missing.
      setError(
        `Memory saved as ${toLabel}, but the rollout could not be planned — roll ${agent.name} out to switch it (${e instanceof Error ? e.message : String(e)})`,
      );
      setSaving(false);
    }
  }

  return (
    <div className="profile-panel-edit memory-edit">
      <div className="select-field">
        <label className="kicker" htmlFor={selectId} style={{ display: "block", marginBottom: 8 }}>
          Memory provider
        </label>
        <div className="select-wrap">
          <select
            id={selectId}
            className="select-input"
            aria-describedby={fitId}
            // The editor opens on a click of its own Change button; the chooser is the next thing.
            autoFocus
            value={choice}
            disabled={saving}
            onChange={(e) => {
              setChoice(e.target.value as MemoryChoice);
              setError(null);
            }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled} title={o.reason ?? undefined}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {/*
          The card under the select: what the choice costs the box, with the
          embeddings chip for this agent's vendor, and the fit on its size —
          the same refusals the disabled options carry (`memoryAgentCard`).
          No size switch: changing the size is a recreate, not this flow.
        */}
        <MemoryProviderCard
          choice={choice}
          vendor={card.vendor}
          fit={card.fit}
          variant="attached"
          fitId={fitId}
        />
      </div>

      {changed && blocked === null ? (
        <div className="memory-confirm" role="group" aria-label="Confirm memory switch">
          <div className="memory-confirm-head">
            Switch memory: <b>{fromLabel}</b> → <b>{toLabel}</b>
          </div>
          <ul className="memory-confirm-notes">
            <li>
              Nothing is deleted:{" "}
              {fromProvider === null
                ? "a provider's data stays on the data volume when you switch away from it"
                : `${fromProvider}'s data stays on the data volume`}
              , and it is there again if you switch back
              {fromProvider === "openviking" || choice === "openviking"
                ? " (OpenViking's only while the agent's vendor embeds the same way)."
                : "."}
            </li>
            <li>
              Memories do not migrate between providers:{" "}
              {choice === "none"
                ? "Hermes keeps only its built-in MEMORY.md / USER.md."
                : `${toLabel} starts from what it already has on this volume, which is nothing if it never ran here.`}
            </li>
            {offline ? (
              <li>{`${waits.charAt(0).toUpperCase()}${waits.slice(1)}.`}</li>
            ) : (
              <li>
                Applies live: the box re-applies its configuration and restarts Hermes briefly
                {agent.pending ? ", and the staged profile change rolls out with it" : ""}.
                {memoryChoiceIsService(choice)
                  ? " A first install of a provider's server can take several minutes; Hermes restarts once it is up."
                  : ""}
              </li>
            )}
          </ul>
        </div>
      ) : null}

      {error !== null ? (
        <div className="mono" role="alert" style={{ color: "var(--bad)", fontSize: 12 }}>
          {error}
        </div>
      ) : null}

      <div className="profile-panel-acts">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || saving || !changed || blocked !== null}
          onClick={() => void confirm()}
        >
          {saving ? "Switching…" : "Switch memory"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={saving}
          onClick={() => onClose(null)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
