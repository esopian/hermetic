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
 */
import { useState } from "react";
import { ApiError, applyPlan, planRollout, setAgentProfile } from "../api/index.ts";
import type { AgentView, RolloutPlan } from "../api/index.ts";
import { isOff } from "../logic/format.ts";
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

/**
 * A failed save, in the operator's words.
 *
 * `CONFLICT` gets its own sentence because it is the one failure that is not
 * about this laptop: the row moved between the render this form was composed
 * against and the write, so retrying the same body would only lose the same
 * race again. Reloading is the fix, and saying so is the difference between an
 * error and an instruction.
 */
function saveErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.code === "CONFLICT") {
    return `CONFLICT · this agent was changed by another operator — reload before saving again (${e.message})`;
  }
  return e instanceof Error ? e.message : String(e);
}

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

  return (
    <>
      <div className="kicker" style={{ marginTop: 22 }}>
        Provider profile
      </div>
      <div className="kv">
        <span className="k">profile</span>
        <span className="v">
          {bound === null ? (
            <span style={{ color: "var(--fg3)" }}>
              {agent.provider} · the fleet&apos;s designated profile for this provider
            </span>
          ) : (
            <>
              {bound.name}
              <span style={{ color: "var(--fg3)" }}>
                {" "}
                · r{agent.profile_revision ?? bound.revision} · {providerSpec(bound).label}
              </span>
              {updateAvailable ? (
                <span className="tag ghost profile-update"> update available</span>
              ) : null}
            </>
          )}
        </span>
        <span className="k">model</span>
        <span className="v">{agent.hermes?.model ?? bound?.model ?? "—"}</span>
        <span className="k">credential</span>
        <span className={credential.mono ? "v mono" : "v"}>{credential.text}</span>
      </div>

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

      {!editing ? (
        <div className="profile-panel-acts">
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
        </div>
      ) : (
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
      )}

      {error !== null && !editing ? (
        <div className="mono" style={{ color: "var(--bad)", fontSize: 12 }}>
          {error}
        </div>
      ) : null}
    </>
  );
}
