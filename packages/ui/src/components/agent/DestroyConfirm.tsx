/**
 * The destroy confirmation panel (§6.7): the plan as read, the volume choice,
 * the typed name, and a button that applies exactly the plan on screen. Split
 * out of `AgentDrawer.tsx`; the state is `useDestroyFlow`'s.
 */
import type { AgentView, Plan } from "../../api/index.ts";
import { PlanSkeleton } from "../Loading.tsx";
import { TypedConfirm, confirmMatches } from "../TypedConfirm.tsx";

export function DestroyConfirm({
  agent,
  plan,
  planError,
  armed,
  deleteVolume,
  setDeleteVolume,
  typed,
  setTyped,
  retryPlan,
  setConfirmOpen,
  runDestroy,
}: {
  agent: AgentView;
  plan: Plan | null;
  planError: string | null;
  /** The plan the button applies, or `null` while nothing may be applied. */
  armed: Plan | null;
  deleteVolume: boolean;
  setDeleteVolume: (on: boolean) => void;
  typed: string;
  setTyped: (typed: string) => void;
  retryPlan: () => void;
  setConfirmOpen: (open: boolean) => void;
  runDestroy: (reviewed: Plan | null) => Promise<void>;
}) {
  return (
    <div className="confirm">
      <div className="kicker" style={{ color: "var(--bad)" }}>
        Destroy {agent.name}
      </div>
      <div className="steps-list">
        {plan ? (
          plan.steps.map((s) => (
            <span key={s.id} className={s.destructive ? "destructive" : undefined}>
              {s.destructive ? "✖" : "·"} {s.id} — {s.description}
            </span>
          ))
        ) : planError ? null : (
          <PlanSkeleton label="reading the destroy plan…" />
        )}
        {plan?.warnings.map((w) => (
          <span key={w} className="destructive">
            ⚠ {w}
          </span>
        ))}
      </div>
      {/* A plan that could not be read is the one case with something to do:
        nothing may be destroyed without one, so the panel says so and
        offers the read again rather than sitting on a skeleton. */}
      {planError ? (
        <div className="wiz-error mono" role="alert">
          Could not read the destroy plan: {planError} · nothing can be destroyed until it reads
          <button type="button" className="btn btn-secondary" onClick={retryPlan}>
            Retry plan
          </button>
        </div>
      ) : null}
      {/*
        Two named choices rather than one checkbox, so the default — keep —
        is something the operator reads and not only the absence of a tick.
        Changing it re-reads the plan (`useDestroyFlow`), and the button stays
        dead until the new one lands.
      */}
      <div className="dr-vol" role="radiogroup" aria-label="Data volume">
        <label className={deleteVolume ? undefined : "on"}>
          <input
            type="radio"
            name={`destroy-volume-${agent.name}`}
            checked={!deleteVolume}
            onChange={() => setDeleteVolume(false)}
          />
          <span>
            <b>Keep data volume</b> <span className="dim">(default)</span>
            <small>{agent.volume_id ?? "the volume"} stays · attach it to a new agent later</small>
          </span>
        </label>
        <label className={deleteVolume ? "on" : undefined}>
          <input
            type="radio"
            name={`destroy-volume-${agent.name}`}
            checked={deleteVolume}
            onChange={() => setDeleteVolume(true)}
          />
          <span>
            <b>Delete data volume</b>
            <small>{agent.volume_gib} GiB of chats, files and memory · irreversible</small>
          </span>
        </label>
      </div>
      <TypedConfirm
        label={`Type ${agent.name} to confirm`}
        expected={agent.name}
        value={typed}
        onChange={setTyped}
        hint={`the agent's name, exactly · ${agent.name}`}
        placeholder={agent.name}
        ariaLabel="Type the agent name to confirm"
      />
      <div className="confirm-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setConfirmOpen(false);
            setTyped("");
          }}
        >
          Cancel
        </button>
        {/* `armed` is the plan itself, so what gets applied is by
          construction what is on screen — there is no path from the
          form's own fields to `apply` (§3.2 rule 3, §6.7). */}
        <button
          type="button"
          className="btn btn-danger"
          disabled={armed === null}
          style={{ opacity: armed === null ? 0.4 : 1 }}
          title={
            armed === null && confirmMatches(typed, agent.name)
              ? "waiting for the destroy plan for these exact options"
              : undefined
          }
          onClick={() => {
            setConfirmOpen(false);
            setTyped("");
            void runDestroy(armed);
          }}
        >
          Destroy
        </button>
      </div>
    </div>
  );
}
