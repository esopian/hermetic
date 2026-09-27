/**
 * The Lifecycle section: every verb that changes the agent, one card each, and
 * each card says what the verb does, what it keeps, what it loses and how long
 * the agent is down. An action that cannot run here stays on the page, dead,
 * with the reason in place of its consequences — a missing button is a
 * question, a disabled one is an answer. Destroy sits alone below the rest, in
 * a danger zone, and still goes through `plan.destroy` and the typed name
 * (§3.2 rule 3, §6.7).
 *
 * The drawer owns the state: the op rail, the shared `busy`, the destroy flow.
 * This component draws the cards and hands clicks back up.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import {
  recreate as recreateAgent,
  startAgent,
  stopAgent,
  upgrade as upgradeAgent,
} from "../../api/index.ts";
import type { AgentView } from "../../api/index.ts";
import type { RerunState } from "../../logic/bootstrap.ts";
import { agentCost, destroyedSummary, drawerActions, isBehind } from "../../logic/format.ts";
import type { DrawerActions, RebootState } from "../../logic/format.ts";
import { DestroyConfirm } from "./DestroyConfirm.tsx";
import type { useDestroyFlow } from "./useDestroyFlow.ts";

/** Start an op and hand it to the rail; the drawer's `run`. */
export type RunOp = (label: string, fn: () => Promise<{ op_id: string }>) => Promise<void>;

function Card({
  title,
  pill,
  pillTone,
  recommended = false,
  about,
  keeps,
  loses,
  down,
  unavailable,
  wide = false,
  children,
}: {
  title: string;
  pill?: string;
  pillTone?: "warn";
  recommended?: boolean;
  about: string;
  keeps: string;
  loses: string;
  down: string;
  /** Why this action cannot run now; replaces the keeps/loses table. */
  unavailable?: string | null;
  wide?: boolean;
  children: ReactNode;
}) {
  const off = !!unavailable;
  return (
    <section
      className={`dr-lc${recommended ? " rec" : ""}${off ? " off" : ""}${wide ? " wide" : ""}`}
      aria-label={title}
    >
      <div className="between">
        <b className="dr-lc-title">{title}</b>
        {recommended ? (
          <span className="dr-tag">Recommended</span>
        ) : pill ? (
          <span className={`dr-pill${pillTone ? ` ${pillTone}` : ""}`}>{off ? "n/a" : pill}</span>
        ) : null}
      </div>
      <p>{about}</p>
      {off ? (
        <div className="hint">Not available: {unavailable}.</div>
      ) : (
        <div className="dr-kl">
          <span>keeps</span>
          {keeps}
          <span>loses</span>
          {loses}
          <span>down</span>
          {down}
        </div>
      )}
      {children}
    </section>
  );
}

export function AgentLifecycle({
  agent,
  latest,
  busy,
  rerun,
  reboot,
  onRun,
  onRerun,
  onReboot,
  confirmOpen,
  setConfirmOpen,
  destroy,
}: {
  agent: AgentView;
  latest: string | null;
  busy: boolean;
  rerun: RerunState;
  reboot: RebootState;
  onRun: RunOp;
  onRerun: () => void;
  onReboot: () => void;
  confirmOpen: boolean;
  setConfirmOpen: (open: boolean) => void;
  destroy: ReturnType<typeof useDestroyFlow>;
}) {
  const name = agent.name;
  // `destroyed` is terminal in core (§4.3): every lifecycle call on this row
  // would come back INVALID_TRANSITION, so the page explains the record and
  // offers no buttons at all rather than buttons that only fail.
  const actions: DrawerActions = drawerActions(agent.display_status);
  const [rebuildAsk, setRebuildAsk] = useState(false);

  if (agent.display_status === "destroyed") {
    return (
      <div className="dr-pane">
        <div className="dr-say">
          <div className="kicker">Lifecycle</div>
          <p>
            <b>{name} is destroyed.</b> Destroyed is terminal: nothing can start, rebuild or remove it
            again. The record is kept so its history stays readable under Logs.
          </p>
        </div>
        <div className="dr-gone mono">{destroyedSummary(agent.volume_id)}</div>
        {agent.volume_id ? (
          <div className="hint">
            The data volume survived. A new agent created from it (Volumes, or + New agent) gets this
            agent's memory back.
          </div>
        ) : null}
      </div>
    );
  }

  const behind = isBehind(agent, latest);
  const ip = agent.tailscale_ip;
  const storageOnly = agentCost({ ...agent, display_status: "stopped" }).monthly;
  const status = agent.display_status;

  return (
    <div className="dr-pane">
      <div className="dr-say">
        <div className="kicker">Lifecycle</div>
        <p>
          What each action does to {name}. Nothing runs until you press its button, and the disruptive
          ones ask again.
        </p>
      </div>

      <div className="dr-lcg">
        {/*
          `agents.upgrade` records the version on the row; the box installs it
          on its next rebuild (or rerun), not now. The card says that rather
          than the "restarts the gateway" a reader might assume, because an
          operator who pressed Upgrade and saw nothing restart would otherwise
          think it failed.
        */}
        <Card
          title="Upgrade Hermes"
          recommended={behind && !!latest}
          pill="no downtime now"
          about={
            behind && latest
              ? `${agent.hermes_version} → ${latest}. Pins the new version on this agent; the box installs it on its next rebuild.`
              : `On ${agent.hermes_version}, the newest release this fleet knows.`
          }
          keeps="everything"
          loses="nothing"
          down="none now · the rebuild that applies it"
          unavailable={
            behind && latest
              ? null
              : latest
                ? "already on the newest release"
                : "no newer release is known"
          }
        >
          <button
            type="button"
            className={`btn btn-sm${behind && latest ? " btn-primary" : " btn-secondary"}`}
            disabled={!behind || busy || !latest}
            title="Record the new Hermes version on this agent; the box picks it up on its next recreate or rerun, not immediately"
            onClick={() =>
              latest && void onRun(`upgrade → ${latest}`, () => upgradeAgent(name, latest))
            }
          >
            {behind && latest ? `Upgrade → ${latest}` : `On ${agent.hermes_version}`}
          </button>
        </Card>

        <Card
          title="Reboot"
          pill="~1 min"
          recommended={status === "unreachable"}
          about="Restarts the operating system. Use it when Hermes or the desktop is stuck, or the heartbeat stopped."
          keeps="the instance, its disks, config and tailnet address"
          loses="in-flight turns"
          down="~1 min"
          unavailable={actions.reboot ? null : `reboot needs a running instance; this one is ${status}`}
        >
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={busy || !actions.reboot || reboot.pending}
            style={{ animation: reboot.pending ? "hpulse 1.2s infinite" : "none" }}
            title={reboot.reason}
            aria-label={reboot.label}
            onClick={onReboot}
          >
            {reboot.label}
          </button>
        </Card>

        {actions.power === "start" ? (
          <Card
            title="Start"
            pill="~2 min"
            about="Boots the stopped instance on the same disks."
            keeps="everything"
            loses="nothing"
            down="until it reports ready, ~2 min"
          >
            <button
              type="button"
              className="btn btn-sm btn-secondary dr-btn-ok"
              disabled={busy}
              onClick={() => void onRun("start", () => startAgent(name))}
            >
              Start
            </button>
          </Card>
        ) : (
          <Card
            title="Stop"
            pill="until started"
            about={`Shuts the instance down. You pay for storage only, ${storageOnly}.`}
            keeps="disks, config, tailnet name"
            loses="availability"
            down="until Start"
          >
            <button
              type="button"
              className="btn btn-sm btn-secondary dr-btn-warn"
              disabled={busy}
              onClick={() => void onRun("stop", () => stopAgent(name))}
            >
              Stop
            </button>
          </Card>
        )}

        {/*
          `rerun` is not an op: the route writes a command on the row, and the
          button is a pending state — not a second click — until hermeticd
          acks it (`rerunState`).
        */}
        <Card
          title="Rerun failed stages"
          pill="until it finishes"
          recommended={rerun.kind === "enabled"}
          about="Resumes a bootstrap that failed partway, from the first stage that is not ok."
          keeps="the instance, data volume and config"
          loses="nothing"
          down="until the stages finish"
          unavailable={rerun.kind === "disabled" ? rerun.reason : null}
        >
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={rerun.kind !== "enabled" || busy}
            style={{
              // The queued state is the same "waiting on the box" beat a
              // running stage square has, so it borrows the same pulse.
              animation: rerun.kind === "pending" ? "hpulse 1.2s infinite" : "none",
            }}
            title={rerun.reason}
            aria-label={rerun.label}
            onClick={onRerun}
          >
            {rerun.label}
          </button>
        </Card>

        <Card
          title="Rebuild instance"
          pill="~8 min"
          pillTone="warn"
          wide
          about="Terminates this instance and boots a new one on the same data volume (recreate). Use it when the system disk is broken, or to apply a Hermes upgrade."
          keeps="data volume (/data), config, name"
          loses={`system disk, instance id, tailnet IP${ip ? ` (${ip} changes)` : ""}`}
          down="~8 min"
          unavailable={actions.rebuild ? null : `rebuild needs a settled agent; this one is ${status}`}
        >
          {rebuildAsk ? (
            <div className="dr-ask" role="group" aria-label="Confirm rebuild">
              <span>Terminate this instance and boot a new one from the same data volume?</span>
              <button
                type="button"
                className="btn btn-sm btn-secondary dr-btn-warn"
                onClick={() => {
                  setRebuildAsk(false);
                  void onRun("recreate", () => recreateAgent(name));
                }}
              >
                Recreate
              </button>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => setRebuildAsk(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-secondary dr-btn-warn"
              disabled={busy || !actions.rebuild}
              title="Terminate this instance and boot a new one from the same data volume"
              onClick={() => setRebuildAsk(true)}
            >
              Rebuild…
            </button>
          )}
        </Card>
      </div>

      {actions.destroy ? (
        <section className="dr-danger" aria-label="Danger zone">
          <div className="kicker" style={{ color: "var(--bad)" }}>
            Danger zone
          </div>
          <div className="between" style={{ alignItems: "flex-start" }}>
            <div>
              <b className="dr-danger-title">Destroy {name}</b>
              <p>
                Terminates the instance and removes it from the tailnet. This cannot be undone. The data
                volume is kept unless you choose to delete it, and the agent's record stays.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-danger"
              aria-expanded={confirmOpen}
              onClick={() => setConfirmOpen(!confirmOpen)}
              title="Terminate this instance and keep the row as a record; the data volume is kept unless you ask otherwise"
            >
              Destroy {name}…
            </button>
          </div>
          {confirmOpen ? (
            <DestroyConfirm
              agent={agent}
              plan={destroy.plan}
              planError={destroy.planError}
              armed={destroy.armed}
              deleteVolume={destroy.deleteVolume}
              setDeleteVolume={destroy.setDeleteVolume}
              typed={destroy.typed}
              setTyped={destroy.setTyped}
              retryPlan={destroy.retryPlan}
              setConfirmOpen={setConfirmOpen}
              runDestroy={destroy.runDestroy}
            />
          ) : (
            <div className="hint">
              Next step: review the plan, choose what happens to the data volume, and type the name.
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
