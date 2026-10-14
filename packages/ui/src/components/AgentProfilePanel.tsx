/**
 * §8.3's half of the agent drawer: which provider profile this agent is bound
 * to, which model it runs, and the two-step way both are changed.
 *
 * The two steps are the whole design. `agents.set` writes `pending` on the row
 * and touches nothing on the box — the running configuration keeps reading the
 * credential it was built with — so the drawer says **Saved — pending apply**
 * rather than claiming the agent moved. *Applying* is the rollout that already
 * exists: `plan.rollout` for this one agent, reviewed, then `apply`, which
 * copies the credential into the new revision slot, re-renders the manifest and
 * lets hermeticd restart Hermes. When the row's `pending` clears, so does this.
 *
 * An offline agent is not a failure case: the staged change simply waits, and
 * the banner says so instead of offering an apply that would have nothing to
 * talk to.
 *
 * The memory row has its own editor (`MemoryProviderEdit.tsx`): a memory
 * switch is written straight onto the row, not staged, so it is confirmed and
 * rolled out in one step rather than through the pending banner.
 */
import { useRef, useState } from "react";
import { applyPlan, planRollout, setAgentProfile } from "../api/index.ts";
import type { AgentView, RolloutPlan } from "../api/index.ts";
import { isOff } from "../logic/format.ts";
import { memoryLabel } from "../logic/memory-logic.ts";
import { saveErrorMessage } from "../logic/set-errors.ts";
import {
  credentialLine,
  pendingSummary,
  profileById,
  profileUpdateAvailable,
  providerSpec,
  readyProfiles,
} from "../logic/provider-logic.ts";
import type { ProfilesState } from "../state/state.tsx";
import { ModelPicker, useModelCatalog } from "./ModelPicker.tsx";
import { PlanSkeleton } from "./Loading.tsx";
import { CfgGroup, CfgRow, CfgRows, Dim } from "./agent/config-parts.tsx";
import { MemoryProviderEdit } from "./MemoryProviderEdit.tsx";

export function AgentProfilePanel({
  agent,
  profiles,
  busy,
  onRunOp,
}: {
  agent: AgentView;
  profiles: ProfilesState;
  busy: boolean;
  /** The drawer's own op runner: starts the op, attaches the rail, records it. */
  onRunOp: (label: string, fn: () => Promise<{ op_id: string }>) => Promise<void>;
}) {
  const list = profiles.list ?? [];
  const bound = profileById(list, agent.profile_id);
  const ready = readyProfiles(list);
  const pending = agent.pending ?? null;
  const updateAvailable = profileUpdateAvailable(agent, list);
  const offline = isOff(agent);
  /**
   * §8.3: the slot the *running* configuration reads, or the fact that there is
   * no slot at all. A role-authenticated agent has `credential_ref === null`,
   * and printing the legacy `provider-key` for it named a slot nothing writes.
   */
  const credential = credentialLine(agent, list, agent.profile_id);

  const [editing, setEditing] = useState(false);
  /** `""` until the operator picks; seeded from the binding when the form opens. */
  const [choice, setChoice] = useState("");
  /** An explicit model override. Empty means "whatever the chosen profile resolves to". */
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<RolloutPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [memoryEditing, setMemoryEditing] = useState(false);
  /** What a memory switch on a stopped agent left to say: saved, not yet switched. */
  const [memoryNote, setMemoryNote] = useState<string | null>(null);
  const memoryButton = useRef<HTMLButtonElement>(null);

  function closeMemory(note: string | null) {
    setMemoryEditing(false);
    if (note !== null) setMemoryNote(note);
    // Back to the control that opened the editor, which renders again now.
    queueMicrotask(() => memoryButton.current?.focus());
  }

  const chosen = profileById(list, choice === "" ? (agent.profile_id ?? null) : choice);
  const catalog = useModelCatalog(
    chosen === null ? null : { profile: chosen.id },
    editing && chosen !== null,
  );
  /**
   * Switching profiles resets the model to the new profile's own default —
   * unless the operator has typed one since, which is what `model` being
   * non-empty means. The reset happens in `chooseProfile`, not here, so an
   * override survives everything except an explicit profile change.
   */
  const effectiveModel = model.trim() === "" ? (chosen?.model ?? "") : model.trim();

  function openEdit() {
    setChoice(agent.profile_id ?? "");
    setModel("");
    setError(null);
    setEditing(true);
  }

  function chooseProfile(id: string) {
    setChoice(id);
    setModel("");
  }

  async function save(refresh: boolean) {
    setSaving(true);
    setError(null);
    try {
      await setAgentProfile({
        name: agent.name,
        /**
         * The row this form was composed against, so a write that raced another
         * operator is refused rather than applied on top of theirs. Sent only
         * when the view actually carries a version: a server build that does not
         * report it would otherwise turn every save into a `CONFLICT` against
         * `undefined`.
         */
        ...(typeof agent.version === "number" ? { expected_version: agent.version } : {}),
        ...(refresh
          ? { refresh_profile: true }
          : {
              ...(choice === "" ? {} : { provider_profile: choice }),
              ...(model.trim() === "" || model.trim() === chosen?.model ? {} : { model: model.trim() }),
            }),
      });
      setEditing(false);
      profiles.refresh();
    } catch (e) {
      setError(saveErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function readPlan() {
    setPlanning(true);
    setError(null);
    try {
      setPlan(await planRollout([agent.name]));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  }

  /*
    The group's actions sit at the right of its rule, as every Config group's
    do (`config-parts.tsx`); while the editor is open they give way to its own
    Save / Cancel.
  */
  const actions = editing ? null : (
    <>
      <button
        type="button"
        className="btn btn-secondary btn-mini"
        disabled={busy || saving}
        onClick={openEdit}
      >
        Change profile or model
      </button>
      {bound !== null && updateAvailable ? (
        <button
          type="button"
          className="btn btn-secondary btn-mini"
          disabled={busy || saving}
          title="Re-pin the same profile at its latest revision, keeping any model override this agent has"
          onClick={() => void save(true)}
        >
          Refresh profile
        </button>
      ) : null}
    </>
  );

  return (
    <CfgGroup title="Provider profile" actions={actions}>
      <CfgRows>
        <CfgRow k="profile">
          {bound === null ? (
            <Dim>{agent.provider} · the fleet&apos;s designated profile for this provider</Dim>
          ) : (
            <>
              {bound.name}
              <Dim>
                {" "}
                · r{agent.profile_revision ?? bound.revision} · {providerSpec(bound).label}
              </Dim>
              {updateAvailable ? (
                <span className="tag ghost profile-update"> update available</span>
              ) : null}
            </>
          )}
        </CfgRow>
        <CfgRow k="model">{agent.hermes?.model ?? bound?.model ?? "—"}</CfgRow>
        <CfgRow k="credential" className={credential.mono ? undefined : "cfg-prose"}>
          {credential.text}
        </CfgRow>
        {/* Rendered into the managed config; changed here, rolled out like any other set. */}
        <CfgRow
          k="memory"
          actions={
            memoryEditing ? null : (
              <button
                ref={memoryButton}
                type="button"
                className="btn btn-secondary btn-mini"
                aria-label="Change memory provider"
                disabled={busy || saving}
                onClick={() => {
                  setMemoryNote(null);
                  setMemoryEditing(true);
                }}
              >
                Change
              </button>
            )
          }
        >
          {agent.memory === null || agent.memory === undefined ? (
            <Dim>Built-in only</Dim>
          ) : (
            <>
              {memoryLabel(agent.memory.provider)}
              <Dim> ({agent.memory.provider})</Dim>
            </>
          )}
        </CfgRow>
      </CfgRows>

      {memoryEditing ? (
        <MemoryProviderEdit agent={agent} busy={busy} onRunOp={onRunOp} onClose={closeMemory} />
      ) : null}

      {memoryNote !== null && !memoryEditing ? (
        <div className="name-hint memory-note" role="status">
          {memoryNote}
        </div>
      ) : null}

      {updateAvailable && pending === null ? (
        <div className="name-hint" style={{ color: "var(--warn)" }}>
          This profile has changed since this agent was pinned to it. Nothing moves until the change is
          staged and applied.
        </div>
      ) : null}

      {pending !== null ? (
        <div className="opbar profile-pending" role="status">
          <span className="ph">
            Saved — pending apply · <b>{pendingSummary(pending, list)}</b>
            {offline ? (
              /*
                Not "on its next start", which is what this used to say and was
                simply untrue: starting the instance boots it back into the
                configuration it already has. `pending` is consumed by an apply
                (the rollout) or by a recreate, and by nothing else — so those
                are the two things named, in the order an operator would reach
                for them.
              */
              <span style={{ color: "var(--fg3)" }}>
                {" "}
                · this agent is not running, so nothing applies yet — start it and apply the rollout, or
                recreate it
              </span>
            ) : null}
          </span>
          <span />
          <span style={{ display: "flex", gap: 8 }}>
            {offline ? null : plan === null ? (
              <button
                type="button"
                className="btn btn-primary"
                style={{ height: 32 }}
                disabled={busy || planning}
                onClick={() => void readPlan()}
              >
                {planning ? "Planning…" : "Apply changes"}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                style={{ height: 32 }}
                disabled={busy}
                onClick={() => {
                  const p = plan;
                  setPlan(null);
                  void onRunOp("rollout", () => applyPlan(p));
                }}
              >
                Confirm rollout
              </button>
            )}
          </span>
        </div>
      ) : null}

      {planning && plan === null ? <PlanSkeleton label="reading the rollout plan…" /> : null}

      {plan !== null ? (
        <div className="td-section">
          <div className="kicker">Steps</div>
          <ol className="td-steps">
            {plan.steps.map((s) => (
              <li key={s.id} className={s.destructive ? "destructive" : undefined}>
                <span className="td-step-body">
                  <i className={s.destructive ? "sq bad" : "sq sq-hole"} />
                  <b>{s.id}</b> — {s.description}
                </span>
              </li>
            ))}
          </ol>
          <button type="button" className="btn btn-secondary btn-mini" onClick={() => setPlan(null)}>
            Cancel
          </button>
        </div>
      ) : null}

      {editing ? (
        <div className="profile-panel-edit">
          <label className="select-field">
            <div className="kicker" style={{ marginBottom: 8 }}>
              Profile
            </div>
            <div className="select-wrap">
              <select
                className="select-input"
                value={choice}
                onChange={(e) => chooseProfile(e.target.value)}
              >
                {choice === "" ? <option value="">— choose a profile —</option> : null}
                {ready.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {providerSpec(p).label} · {p.model}
                  </option>
                ))}
              </select>
            </div>
            <div className="name-hint" style={{ color: "var(--fg3)" }}>
              switching profiles resets the model to the new profile&apos;s own, unless you change it
              below before saving
            </div>
          </label>

          {chosen === null ? null : (
            <ModelPicker
              value={effectiveModel}
              onChange={setModel}
              catalog={catalog}
              placeholder="search this profile's catalog"
              idleHint="Refresh asks the provider for its catalog"
            />
          )}

          {error !== null ? (
            <div className="mono" style={{ color: "var(--bad)", fontSize: 12 }}>
              {error}
            </div>
          ) : null}

          <div className="profile-panel-acts">
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || choice === ""}
              onClick={() => void save(false)}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error !== null && !editing ? (
        <div className="mono" style={{ color: "var(--bad)", fontSize: 12 }}>
          {error}
        </div>
      ) : null}
    </CfgGroup>
  );
}
