/**
 * §7.1's snapshot-policy change: edit → review the plan → watch the op, the
 * shape `NetworkDrawer` established for a change to the foundation stack.
 *
 * The edit stage sends only the fields that moved (`patchOf`); core merges
 * them over the stack's current policy and the plan carries the whole target.
 * A step the plan marks destructive — turning snapshots off, or lowering
 * retention so DLM deletes the oldest — has to be acknowledged before Apply.
 */
import { useEffect, useId, useState } from "react";
import {
  SNAPSHOT_INTERVAL_HOURS,
  SNAPSHOT_RETAIN_MAX,
  SNAPSHOT_RETAIN_MIN,
  describeSnapshotPolicy,
  snapshotWindowDays,
} from "@hermetic/core/shared";
import type { SnapshotIntervalHours } from "@hermetic/core/shared";
import { ApiError, applyPlan, planSnapshots } from "../../api/index.ts";
import type { SnapshotPolicy, SnapshotsPlan, SnapshotsReport } from "../../api/index.ts";
import {
  RETAIN_CHOICES,
  formIssue,
  formOf,
  intervalLabel,
  patchOf,
} from "../../logic/snapshots-logic.ts";
import type { SnapshotForm } from "../../logic/snapshots-logic.ts";
import { useOp } from "../../lib/useOp.ts";
import { Drawer, DrawerHead } from "../Drawer.tsx";
import { OpProgress } from "../OpProgress.tsx";

/** `apply` of a `snapshots` plan, in core's order. */
const PHASES = ["preflight", "stack", "done"];
const LABELS: Readonly<Record<string, string>> = {
  preflight: "Take the _fleet lock",
  stack: "Update the foundation stack's snapshot policy",
  done: "Done",
};

type Stage = 1 | 2 | 3;
type Failure = { code: string; message: string };

function failure(e: unknown): Failure {
  return e instanceof ApiError
    ? { code: e.code, message: e.message }
    : { code: "ERROR", message: e instanceof Error ? e.message : String(e) };
}

function windowText(p: { enabled: boolean; retain: number; interval_hours: number }): string {
  if (!p.enabled) return "no new snapshots";
  const days = snapshotWindowDays(p as SnapshotPolicy);
  return `≈${days < 10 ? days.toFixed(1) : Math.round(days)} days of history per volume`;
}

export function SnapshotsDrawer({
  report,
  policy,
  onClose,
  onApplied,
}: {
  report: SnapshotsReport;
  /** The stack's current policy; the block only opens this drawer when there is one. */
  policy: SnapshotPolicy;
  onClose: () => void;
  /** Re-read `snapshots.status`: a finished apply moved it. */
  onApplied: () => void;
}) {
  const ids = useId();
  const [stage, setStage] = useState<Stage>(1);
  const [form, setForm] = useState<SnapshotForm>(() => formOf(policy));
  const [plan, setPlan] = useState<SnapshotsPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<Failure | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [opId, setOpId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<Failure | null>(null);
  const op = useOp(opId, PHASES, LABELS);

  const issue = formIssue(form);
  const patch = patchOf(policy, form);
  const destructive = (plan?.steps ?? []).some((s) => s.destructive);
  const target = plan?.options.snapshots ?? null;

  const [refreshed, setRefreshed] = useState(false);
  useEffect(() => {
    if (!op.finished || refreshed) return;
    setRefreshed(true);
    onApplied();
  }, [op.finished, refreshed, onApplied]);

  async function review() {
    if (patch === null) return;
    setPlanning(true);
    setPlanError(null);
    try {
      setPlan(await planSnapshots(patch));
      setAcknowledged(false);
      setStage(2);
    } catch (e) {
      setPlanError(failure(e));
    } finally {
      setPlanning(false);
    }
  }

  async function apply() {
    if (plan === null) return;
    setStarting(true);
    setStartError(null);
    try {
      const accepted = await applyPlan(plan);
      setOpId(accepted.op_id);
      setStage(3);
    } catch (e) {
      setStartError(failure(e));
    } finally {
      setStarting(false);
    }
  }

  const closeBlocked = stage === 3 && op.running;
  function attemptClose() {
    if (!closeBlocked) onClose();
  }

  return (
    <Drawer width={640} onClose={attemptClose} labelledBy={`${ids}-title`}>
      <DrawerHead
        titleId={`${ids}-title`}
        kicker="Fleet foundation · data-volume snapshots"
        title="Change snapshot policy"
        sub={
          <div className="mono td-plan-source">
            now {describeSnapshotPolicy(policy)}
            {target !== null ? ` → ${describeSnapshotPolicy(target)}` : ""}
          </div>
        }
        onClose={attemptClose}
      />

      <div className={stage === 3 ? "drawer-body td-body op-body" : "drawer-body td-body"}>
        {stage === 1 ? (
          <div className="td-stage" data-testid="snapshots-edit">
            <div className="kicker">Stage 1 · Choose</div>
            <p className="sn-copy">
              Every agent&apos;s <span className="mono">/data</span> volume is snapshotted on this
              schedule by the fleet&apos;s lifecycle policy. Snapshots are how a lost or corrupted data
              volume comes back; they are also billed storage. The fleet holds{" "}
              <b>{report.existing.count}</b> snapshot{report.existing.count === 1 ? "" : "s"} now.
            </p>

            <div className="td-section">
              <div className="kicker" id={`${ids}-on`}>
                Snapshots
              </div>
              <div className="seg st-seg sn-seg" role="group" aria-labelledby={`${ids}-on`}>
                {[true, false].map((on) => (
                  <button
                    type="button"
                    key={String(on)}
                    aria-pressed={form.enabled === on}
                    onClick={() => setForm({ ...form, enabled: on })}
                  >
                    {on ? "on" : "off"}
                  </button>
                ))}
              </div>
            </div>

            <div className="td-section">
              <div className="kicker" id={`${ids}-every`}>
                Frequency
              </div>
              <div className="seg st-seg sn-seg" role="group" aria-labelledby={`${ids}-every`}>
                {[...SNAPSHOT_INTERVAL_HOURS].reverse().map((h) => (
                  <button
                    type="button"
                    key={h}
                    disabled={!form.enabled}
                    aria-pressed={form.interval_hours === h}
                    onClick={() => setForm({ ...form, interval_hours: h as SnapshotIntervalHours })}
                  >
                    {h === 24 ? "24 h" : `${h} h`}
                  </button>
                ))}
              </div>
            </div>

            <div className="td-section">
              <label className="kicker" htmlFor={`${ids}-retain`}>
                Keep per volume
              </label>
              <div className="sn-retain">
                <div className="seg st-seg sn-seg" role="group" aria-label="Common retention counts">
                  {RETAIN_CHOICES.map((n) => (
                    <button
                      type="button"
                      key={n}
                      disabled={!form.enabled}
                      aria-pressed={form.retain === String(n)}
                      onClick={() => setForm({ ...form, retain: String(n) })}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <input
                  id={`${ids}-retain`}
                  className="key-input st-num"
                  type="number"
                  min={SNAPSHOT_RETAIN_MIN}
                  max={SNAPSHOT_RETAIN_MAX}
                  inputMode="numeric"
                  autoComplete="off"
                  disabled={!form.enabled}
                  value={form.retain}
                  onChange={(e) => setForm({ ...form, retain: e.target.value })}
                />
              </div>
            </div>

            <div className="sn-preview mono" data-testid="snapshots-preview">
              {issue ??
                `${form.enabled ? `${intervalLabel(form.interval_hours)}, keep ${form.retain}` : "off"} · ${windowText({ ...form, retain: Number(form.retain) })}`}
            </div>
            {!form.enabled ? (
              <div className="st-callout warn">
                Off stops new snapshots and stops expiring old ones. The {report.existing.count} already
                taken stay, and keep being billed, until you delete them. Lowering retention with
                snapshots on sheds them gradually instead.
              </div>
            ) : null}
            {planError ? (
              <div className="wiz-error mono" role="alert">
                {planError.code}: {planError.message}
              </div>
            ) : null}
          </div>
        ) : null}

        {stage === 2 && plan !== null ? (
          <div className="td-stage" data-testid="snapshots-review">
            <div className="kicker">Stage 2 · Review</div>
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
            </div>
            {plan.warnings.length > 0 ? (
              <div className="td-section">
                <div className="kicker td-kicker-warn">Read before applying</div>
                <ul className="td-warnings">
                  {plan.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {destructive ? (
              <label className="verify-row">
                <input
                  type="checkbox"
                  className="verify-check"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                <span className="verify-label">
                  {target?.enabled === false
                    ? "I understand data volumes will have no new snapshots to restore from."
                    : "I understand DLM will delete each volume's oldest snapshots past the new count on its next scheduled run."}
                </span>
              </label>
            ) : null}
            {startError ? (
              <div className="wiz-error mono" role="alert">
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
                title="snapshot policy"
                sub={target === null ? "—" : describeSnapshotPolicy(target)}
                op={op}
              />
            </div>
            {op.finished && !op.ok ? (
              <div className="wiz-error mono">
                {op.error ? `${op.error.code}: ${op.error.message}` : "the op failed"}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {stage === 1 ? (
        <div className="drawer-foot">
          <span className="wiz-note mono">
            {issue ?? (patch === null ? "nothing changed yet" : "review the plan next")}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={patch === null || planning}
            onClick={() => void review()}
          >
            {planning ? "Planning…" : "Review plan"}
          </button>
        </div>
      ) : null}

      {stage === 2 ? (
        <div className="drawer-foot">
          <button type="button" className="btn btn-secondary" onClick={() => setStage(1)}>
            Back
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={starting || (destructive && !acknowledged)}
            title={destructive && !acknowledged ? "acknowledge the warning first" : undefined}
            onClick={() => void apply()}
          >
            {starting ? "Starting…" : "Apply"}
          </button>
        </div>
      ) : null}

      {stage === 3 ? (
        <div className="drawer-foot">
          <span className="wiz-note mono">{op.running ? "updating the stack…" : "finished"}</span>
          <button type="button" className="btn btn-secondary" disabled={closeBlocked} onClick={onClose}>
            Close
          </button>
        </div>
      ) : null}
    </Drawer>
  );
}
