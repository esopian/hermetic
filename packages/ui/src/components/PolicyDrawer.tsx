/**
 * §4.7's tailnet policy, in the shape `FoundationUpdateDrawer` established:
 * review the plan → apply → watch the op.
 *
 * There is no ceremony here. Writing hermetic's blocks removes nothing — the
 * write is refused unless Tailscale validates the whole document first, it
 * carries the ETag the plan was made against so a policy edited in the admin
 * console in the meantime is a `CONFLICT` rather than an overwrite, and every
 * byte outside the `// hermetic:managed` markers is returned unchanged. What the
 * operator has to see is the diff, so the diff is the body of this drawer.
 */
import { useCallback, useEffect, useState } from "react";
import { ApiError, applyPlan, getPolicyPlan } from "../api/index.ts";
import type { PolicyPlan, PolicyReport } from "../api/index.ts";
import { useOp } from "../lib/useOp.ts";
import { Drawer, DrawerHead } from "./Drawer.tsx";
import { PlanSkeleton } from "./Loading.tsx";
import { OpProgress } from "./OpProgress.tsx";

/** `policy.apply`'s phases, in core's order (`core/policy.ts`). */
const PHASES = ["fetch", "render", "validate", "done"];

/**
 * `render` and `validate` are shared phase names that mean something else in
 * `agents.create`, so this op names its own (see `useOp`'s `labels`).
 * Module-level: it is a memo dependency.
 */
const LABELS: Readonly<Record<string, string>> = {
  fetch: "Read the tailnet policy",
  render: "Render hermetic's blocks into it",
  validate: "Tailscale validates the whole document",
  done: "Done",
};

/**
 * The plan's warnings carry the diff as one long entry so the CLI can print it
 * inline; this drawer renders the diff itself, so that entry is dropped rather
 * than shown twice. Matching on the lead-in is de-duplication only — if core
 * rewords it the diff appears twice, which is untidy, not wrong.
 */
const DIFF_WARNING = "the change, as a unified diff";

/** What the Apply button may do, and why not when it may not. */
export function applyGate(input: {
  scope: PolicyReport["scope"];
  plan: PolicyPlan | null;
  hasDiff: boolean;
}): { allowed: boolean; reason: string } {
  if (input.scope === "none") {
    return {
      allowed: false,
      reason:
        "this fleet's OAuth client has no Policy File scope — create one with Policy File → Read, Write, then `hermetic secrets push _fleet --tailscale-oauth`",
    };
  }
  if (input.scope === "read") {
    return {
      allowed: false,
      reason:
        "this fleet's OAuth client can read the policy but not write it — create one with Policy File → Read, Write, then `hermetic secrets push _fleet --tailscale-oauth`",
    };
  }
  if (input.plan === null) return { allowed: false, reason: "reading the plan…" };
  if (!input.hasDiff) {
    return {
      allowed: false,
      reason: "nothing to write: the policy already says what hermetic would say",
    };
  }
  return { allowed: true, reason: `${input.plan.steps.length} steps · 1 write` };
}

export function PolicyDrawer({
  report,
  onClose,
  onApplied,
}: {
  report: PolicyReport;
  onClose: () => void;
  /** Re-read `/api/policy`: a finished apply moved what the card is showing. */
  onApplied: () => void;
}) {
  const [plan, setPlan] = useState<PolicyPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<{ code: string; message: string } | null>(null);
  const op = useOp(opId, PHASES, LABELS);

  const loadPlan = useCallback(() => {
    let alive = true;
    setPlanError(null);
    getPolicyPlan()
      .then((p) => {
        if (alive) setPlan(p);
      })
      .catch((e: unknown) => {
        if (alive) setPlanError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => loadPlan(), [loadPlan]);

  // The write is what the card is a report of, so a finished op refreshes it
  // exactly once — including a failed one, which may have moved the ETag.
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

  const gate = applyGate({ scope: report.scope, plan, hasDiff: report.diff !== null });
  const warnings = (plan?.warnings ?? []).filter((w) => !w.startsWith(DIFF_WARNING));

  return (
    <Drawer width={720} onClose={onClose} labelledBy="policy-plan-title">
      <DrawerHead
        titleId="policy-plan-title"
        kicker="Tailnet policy"
        title="Write hermetic's blocks"
        sub={<div className="mono td-plan-source">tailnet · etag {report.etag ?? "—"}</div>}
        onClose={onClose}
      />

      <div className="drawer-body td-body">
        {opId === null ? (
          <div className="td-stage">
            <div className="kicker">Stage 1 · Review</div>

            <div className="td-section">
              <div className="kicker">Steps</div>
              {planError ? (
                <div className="wiz-error mono">{planError}</div>
              ) : plan === null ? (
                <PlanSkeleton label="reading the policy plan…" />
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

            <div className="td-section">
              <div className="kicker">Diff</div>
              {report.diff === null ? (
                <div className="settings-hint mono">
                  — nothing to write: the policy already says what hermetic would say —
                </div>
              ) : (
                <pre className="logpane policy-diff">{report.diff}</pre>
              )}
            </div>

            {warnings.length > 0 ? (
              <div className="td-section">
                <div className="kicker td-kicker-warn">Read before applying</div>
                <ul className="td-warnings">
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {startError ? (
              <div className="wiz-error mono">
                {startError.code}: {startError.message}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="td-stage">
            <div className="kicker">Stage 2 · Progress</div>
            <div className="wiz-progress">
              <OpProgress title="tailnet policy" sub={`etag ${report.etag ?? "—"}`} op={op} />
            </div>
            {op.finished && !op.ok ? (
              <div className="wiz-error mono">
                {op.error ? `${op.error.code}: ${op.error.message}` : "the op failed"}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {opId === null ? (
        <div className="drawer-foot">
          <span className="wiz-note mono">{gate.reason}</span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!gate.allowed || starting}
            style={{ opacity: !gate.allowed || starting ? 0.4 : 1 }}
            title={gate.allowed ? undefined : gate.reason}
            onClick={() => void apply()}
          >
            {starting ? "Applying…" : "Apply"}
          </button>
        </div>
      ) : op.finished ? (
        <div className="drawer-foot">
          <span className="wiz-note mono">
            {op.ok ? "hermetic's blocks are in the tailnet policy" : "the policy was not written"}
          </span>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      ) : null}
    </Drawer>
  );
}
