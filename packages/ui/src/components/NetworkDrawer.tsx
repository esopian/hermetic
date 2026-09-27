/**
 * §5's re-network, in the shape `FoundationUpdateDrawer` established: review
 * the plan → confirm → watch the op.
 *
 * The confirmation is a checkbox rather than the teardown ceremony, because
 * this destroys no data — but it is the most destructive operation short of
 * one. It replaces the fleet's routing, every agent already running keeps the
 * subnets it was launched into, and the only way to move one is to recreate it.
 * That sentence is what the checkbox is acknowledging, and it is why there is a
 * second stage at all.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { ApiError, applyPlan, planNetwork } from "../api/index.ts";
import type { NetworkPlan, NetworkReport } from "../api/index.ts";
import {
  applyGate,
  driftedAgents,
  networkFactRows,
  renetworkTarget,
  type NetworkModeName,
} from "../logic/network-logic.ts";
import { networkPhases, useOp } from "../lib/useOp.ts";
import { Drawer, DrawerHead } from "./Drawer.tsx";
import { PlanSkeleton } from "./Loading.tsx";
import { OpProgress } from "./OpProgress.tsx";

/** `apply` of a `network` plan, in core's order. */
const PHASES = networkPhases();

/**
 * Four of these names are shared with other ops and mean something else in
 * them, so this op names its own (see `useOp`'s `labels`). Module-level: it is
 * a memo dependency.
 */
const LABELS: Readonly<Record<string, string>> = {
  preflight: "Take the _fleet lock and resolve the NAT image",
  archive: "Archive the fleet before anything changes",
  stack: "Update the foundation stack's routing",
  stamp: "Record the new mode and republish the manifest",
  drift: "Report the agents left on the old subnets",
  done: "Done",
};

type Stage = 1 | 2 | 3;

function ModeMove({ from, to }: { from: NetworkModeName | null; to: NetworkModeName }) {
  return (
    <span>
      {from ?? "unknown"} → {to}
    </span>
  );
}

export function NetworkDrawer({
  report,
  onClose,
  onApplied,
}: {
  report: NetworkReport;
  onClose: () => void;
  /** Re-read `/api/network` and `/api/meta`: a finished apply moved both. */
  onApplied: () => void;
}) {
  const target = renetworkTarget(report.stack_mode);
  const [stage, setStage] = useState<Stage>(1);
  const [plan, setPlan] = useState<NetworkPlan | null>(null);
  const [planError, setPlanError] = useState<{ code: string; message: string } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [opId, setOpId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<{ code: string; message: string } | null>(null);
  const op = useOp(opId, PHASES, LABELS);

  const loadPlan = useCallback(() => {
    if (target === null) return;
    let alive = true;
    setPlanError(null);
    planNetwork(target)
      .then((p) => {
        if (alive) setPlan(p);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setPlan(null);
        setPlanError(
          e instanceof ApiError
            ? { code: e.code, message: e.message }
            : { code: "ERROR", message: e instanceof Error ? e.message : String(e) },
        );
      });
    return () => {
      alive = false;
    };
  }, [target]);

  useEffect(() => loadPlan(), [loadPlan]);

  // A finished op moved the mode, the manifest and every agent's placement, so
  // the section behind this drawer is re-read exactly once — including after a
  // failure, which may have got as far as the stack.
  const [refreshed, setRefreshed] = useState(false);
  useEffect(() => {
    if (!op.finished || refreshed) return;
    setRefreshed(true);
    onApplied();
  }, [op.finished, refreshed, onApplied]);

  async function apply() {
    if (plan === null) return;
    setStarting(true);
    setStartError(null);
    try {
      const accepted = await applyPlan(plan);
      setOpId(accepted.op_id);
      setStage(3);
    } catch (e) {
      setStartError(
        e instanceof ApiError
          ? { code: e.code, message: e.message }
          : { code: "ERROR", message: e instanceof Error ? e.message : String(e) },
      );
    } finally {
      setStarting(false);
    }
  }

  const gate = applyGate({ plan, acknowledged, starting });

  // Closing mid-op would discard the progress view, and a re-network is the one
  // op whose failure an operator most needs to have watched.
  const closeBlocked = stage === 3 && op.running;

  function attemptClose() {
    if (closeBlocked) return;
    onClose();
  }
  const stranded = driftedAgents(report);
  const facts = networkFactRows(report);
  const destructive = (plan?.steps ?? []).filter((s) => s.destructive).length;

  return (
    <Drawer width={720} onClose={attemptClose} labelledBy="network-plan-title">
      <DrawerHead
        titleId="network-plan-title"
        kicker="Fleet network"
        title="Change network mode"
        sub={
          <div className="mono td-plan-source">
            {target === null ? (
              "the stack records no network mode"
            ) : (
              <ModeMove from={report.stack_mode} to={target} />
            )}
          </div>
        }
        onClose={attemptClose}
      />

      <div className="drawer-body td-body">
        {stage === 1 ? (
          <div className="td-stage">
            <div className="kicker">Stage 1 · Review</div>

            <div className="td-section">
              <div className="kicker">This fleet now</div>
              <div className="kv">
                {facts.map((f) => (
                  <Fragment key={f.k}>
                    <span className="k">{f.k}</span>
                    <span className="v mono" style={f.bad ? { color: "var(--warn)" } : undefined}>
                      {f.v}
                    </span>
                  </Fragment>
                ))}
              </div>
            </div>

            <div className="td-section">
              <div className="kicker">Steps</div>
              {planError ? (
                <div className="wiz-error mono">
                  {planError.code}: {planError.message}
                </div>
              ) : plan === null ? (
                <PlanSkeleton label="reading the network plan…" />
              ) : (
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
              )}
            </div>

            {plan !== null && plan.warnings.length > 0 ? (
              <div className="td-section">
                <div className="kicker td-kicker-warn">Read before applying</div>
                <ul className="td-warnings">
                  {plan.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {stage === 2 ? (
          <div className="td-stage">
            <div className="kicker">Stage 2 · Confirm</div>
            <div className="td-target">
              <div className="td-summary mono">
                <span className="k">network</span>
                <span className="v">
                  {target === null ? "—" : <ModeMove from={report.stack_mode} to={target} />}
                </span>
                <span className="k">agents</span>
                <span className="v">{report.agents.length}</span>
                <span className="k">plan</span>
                <span className="v">
                  {plan?.steps.length ?? 0} steps · {destructive} destructive
                </span>
              </div>
            </div>

            <p className="danger-copy">
              EC2 cannot move a running instance between subnets. Every agent this fleet already has
              keeps the subnets it was launched into and stays on the old egress path — hermetic will
              not recreate them for you. Each one has to be recreated by hand with{" "}
              <b className="mono">hermetic agent recreate &lt;name&gt;</b> before it is really in{" "}
              <b className="mono">{target ?? "the new mode"}</b> mode.
            </p>
            <p className="danger-copy">
              Moving <b className="mono">nat</b> → <b className="mono">public</b> is refused outright
              while any agent still has an instance in the private subnets: CloudFormation cannot delete
              a subnet that is in use, and a change set that rolls back part-way leaves the fleet
              without egress. Destroy those agents first, then re-network.
            </p>
            <p className="danger-copy">
              Every agent operation refuses with <b className="mono">LOCKED</b> while this runs, and a
              recovery archive of the fleet is taken before anything changes.
            </p>

            <label className="verify-row">
              <input
                type="checkbox"
                className="verify-check"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span className="verify-label">
                I understand that existing agents stay on the old subnets until I recreate each of them
                {stranded.length > 0 ? ` (${stranded.join(", ")} already need it)` : ""}.
              </span>
            </label>

            {startError ? (
              <div className="wiz-error mono">
                {startError.code}: {startError.message}
              </div>
            ) : null}
          </div>
        ) : null}

        {stage === 3 ? (
          <div className="td-stage">
            <div className="kicker">Stage 3 · Progress</div>
            <div className="wiz-progress">
              <OpProgress
                title="network mode"
                sub={target === null ? "—" : `${report.stack_mode ?? "unknown"} → ${target}`}
                op={op}
              />
            </div>
            {closeBlocked ? (
              <div className="mono td-plan-source">
                re-network in progress — this drawer stays open until it finishes
              </div>
            ) : null}

            {op.finished && !op.ok ? (
              <div className="wiz-error mono">
                {op.error ? `${op.error.code}: ${op.error.message}` : "the op failed"}
              </div>
            ) : null}
            {op.finished && op.ok && stranded.length > 0 ? (
              <div className="doctor-note warn mono">
                still on the old subnets: {stranded.join(", ")} — run `hermetic agent recreate
                &lt;name&gt;` for each
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {stage === 1 ? (
        <div className="drawer-foot">
          <span className="wiz-note mono">
            {planError ? planError.code : plan === null ? "reading the plan…" : "review, then confirm"}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={plan === null}
            style={{ opacity: plan === null ? 0.4 : 1 }}
            onClick={() => setStage(2)}
          >
            Continue
          </button>
        </div>
      ) : null}

      {stage === 2 ? (
        <div className="drawer-foot">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setAcknowledged(false);
              setStage(1);
            }}
          >
            Back
          </button>
          <span className="wiz-note mono">{gate.reason}</span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!gate.allowed}
            style={{ opacity: gate.allowed ? 1 : 0.4 }}
            title={gate.allowed ? undefined : gate.reason}
            onClick={() => void apply()}
          >
            {starting ? "Applying…" : "Apply"}
          </button>
        </div>
      ) : null}

      {stage === 3 && op.finished ? (
        <div className="drawer-foot">
          <span className="wiz-note mono">
            {op.ok ? `this fleet is now in ${target} mode` : "the network mode was not changed"}
          </span>
          <button type="button" className="btn btn-primary" onClick={attemptClose}>
            Close
          </button>
        </div>
      ) : null}
    </Drawer>
  );
}
