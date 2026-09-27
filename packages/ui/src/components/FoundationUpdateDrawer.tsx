/**
 * §6.6's update, in the shape `TeardownDrawer` established: review the plan →
 * confirm → watch the op.
 *
 * The confirmation is one button, not the teardown ceremony. A foundation
 * update deletes nothing an operator would miss — the replacement guard refuses
 * (`FOUNDATION_UNSAFE`) rather than replacing a table or the bucket, and the
 * `_fleet` stamp is the last write, so a failure anywhere before it leaves the
 * fleet exactly where it was. Typing an account id here would train the reflex
 * that makes the teardown's own prompt meaningless.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, planFoundation, updateFoundation } from "../api/index.ts";
import type { FoundationPlan, Meta } from "../api/index.ts";
import { fmtClock } from "../logic/format.ts";
import { useFleet } from "../state/state.tsx";
import {
  closeBlocked as closeBlockedRule,
  continueGate,
  hermeticdLine,
  reattach,
} from "../logic/foundation-logic.ts";
import { foundationPhases, useOp } from "../lib/useOp.ts";
import { Drawer, DrawerHead } from "./Drawer.tsx";
import { PlanSkeleton } from "./Loading.tsx";
import { OpProgress } from "./OpProgress.tsx";

type Stage = 1 | 2 | 3;

/** sessionStorage key for the in-flight op id, so reopening reattaches. */
const OPID_KEY = "hermetic.foundation.opId";

/**
 * Module-level: `useOp` takes its seed list as a memo dependency, and
 * `foundationPhases()` hands back a fresh array every call — so building it in
 * the render body would rebuild the whole step rail on every render.
 */
const PHASES = foundationPhases();

/**
 * `preflight` means the Tailscale check in `init` and the guards-and-lock step
 * here, so this op names its own (see `useOp`'s `labels`). Module-level: it is
 * a memo dependency.
 */
const LABELS: Readonly<Record<string, string>> = {
  preflight: "Guard the account and take the _fleet lock",
  artifacts: "Push the release and rewrite the fleet manifest",
  done: "Done",
};

function readStoredOpId(): string | null {
  try {
    return sessionStorage.getItem(OPID_KEY);
  } catch {
    return null;
  }
}

function writeStoredOpId(opId: string | null): void {
  try {
    if (opId) sessionStorage.setItem(OPID_KEY, opId);
    else sessionStorage.removeItem(OPID_KEY);
  } catch {
    /* private mode: reattach just won't survive a reload */
  }
}

export function FoundationUpdateDrawer({ meta, onClose }: { meta: Meta | null; onClose: () => void }) {
  // The context value changes on every poll tick; these two functions do not.
  const { refreshMeta, refreshFleets } = useFleet();
  // Read once, on mount: sessionStorage is what makes a reopened drawer
  // reattach to a running op instead of restarting at stage 1.
  const attach = useRef(reattach(readStoredOpId())).current;
  const [stage, setStage] = useState<Stage>(attach.stage);
  const [plan, setPlan] = useState<FoundationPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planFetchedAt, setPlanFetchedAt] = useState<string | null>(null);
  const [opId, setOpId] = useState<string | null>(attach.opId);
  const [startError, setStartError] = useState<{ code: string; message: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const op = useOp(opId, PHASES, LABELS);

  const loadPlan = useCallback(() => {
    let alive = true;
    setPlanLoading(true);
    setPlanError(null);
    planFoundation()
      .then((p) => {
        if (!alive) return;
        setPlan(p);
        setPlanFetchedAt(new Date().toISOString());
      })
      .catch((e: unknown) => {
        if (alive) setPlanError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setPlanLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Stage 3 reattached from sessionStorage has an op to watch and nothing to
  // plan; fetching one there would create and delete a change set for a display
  // nobody is looking at.
  useEffect(() => {
    if (!attach.loadPlan) {
      setPlanLoading(false);
      return;
    }
    // §6.6's status is a `/api/meta` snapshot taken when the page loaded; a CLI
    // run since then, or another operator's update, would leave this drawer
    // gating on a stale reading. Refresh it alongside the plan, and gate stage 2
    // on the result (`continueGate`).
    void refreshMeta();
    return loadPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    writeStoredOpId(opId);
  }, [opId]);

  useEffect(() => {
    if (op.finished) writeStoredOpId(null);
  }, [op.finished]);

  // A finished update moved `_fleet.foundation_version`, which is what the pill
  // and the Settings section read off `/api/meta` — and what the fleet
  // switcher's `update available` badge reads off `fleets.list`, which nothing
  // else re-reads until the next switch.
  const refreshed = useRef(false);
  useEffect(() => {
    if (!op.finished || refreshed.current) return;
    refreshed.current = true;
    void refreshMeta();
    void refreshFleets();
  }, [op.finished, refreshMeta, refreshFleets]);

  async function start() {
    setStarting(true);
    setStartError(null);
    try {
      const accepted = await updateFoundation();
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

  const foundation = meta?.foundation ?? null;
  const from = foundation ? `v${foundation.fleet.foundation_version}` : "—";
  const to = foundation ? `v${foundation.available.foundation_version}` : "—";
  const hd = hermeticdLine(
    plan?.release,
    {
      from: foundation?.fleet.hermeticd_version ?? null,
      to: foundation?.available.hermeticd_version ?? null,
    },
    // The line is on screen before the plan arrives; say so, rather than let a
    // missing note read as "nothing to report".
    planLoading ? "loading" : planError !== null ? "error" : "ready",
  );
  const stepCount = plan?.steps.length ?? 0;
  const destructiveCount = plan?.steps.filter((s) => s.destructive).length ?? 0;

  // Closing mid-op would discard the progress view; the op id is in
  // sessionStorage either way, but the drawer stays put while it runs.
  const closeBlocked = closeBlockedRule({ stage, running: op.running });

  // Re-checked here, not only on Settings' button: this drawer is also reachable
  // straight from the EnvStrip pill, which has no gate of its own.
  const gate = continueGate({
    planLoading,
    planError,
    hasPlan: plan !== null,
    foundation: foundation ?? null,
  });

  function attemptClose() {
    if (closeBlocked) return;
    onClose();
  }

  useEffect(() => {
    if (!closeBlocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeBlocked]);

  return (
    <Drawer width={640} onClose={attemptClose} labelledBy="foundation-update-title">
      <DrawerHead
        titleId="foundation-update-title"
        kicker="Foundation"
        title="Update the foundation"
        onClose={attemptClose}
      />

      <div className="drawer-body td-body">
        {stage === 1 ? (
          <div className="td-stage">
            <div className="kicker">Stage 1 · Review</div>

            <div className="td-summary mono">
              <span className="k">foundation</span>
              <span className="v">
                {from} → {to}
              </span>
              <span className="k">hermeticd</span>
              {/*
                Read exactly where an operator expects: the left is the release
                the fleet manifest in S3 names, the right is what this build
                would push. The two *versions* are the same hand-maintained
                constant and so usually read alike; the short build fingerprint
                beside each is the half that moves when the binary does.
              */}
              <span className="v">
                {hd.from}
                {hd.fromBuild ? <span style={{ color: "var(--fg3)" }}> {hd.fromBuild}</span> : null}
                {" → "}
                {hd.to}
                {hd.toBuild ? <span style={{ color: "var(--fg3)" }}> {hd.toBuild}</span> : null}
                {hd.note ? (
                  <span
                    className={hd.warn ? "skew-mark" : undefined}
                    style={hd.warn ? undefined : { color: "var(--fg3)" }}
                  >
                    {" "}
                    {hd.note}
                  </span>
                ) : null}
              </span>
              <span className="k">account</span>
              <span className="v">{meta?.config?.account_id ?? "—"}</span>
              <span className="k">region</span>
              <span className="v">{meta?.config?.region ?? "—"}</span>
            </div>

            <div className="td-section">
              <div className="kicker">Steps</div>
              {planLoading ? (
                <PlanSkeleton />
              ) : planError ? (
                <div className="wiz-error mono">{planError}</div>
              ) : (
                <ol className="td-steps">
                  {plan?.steps.map((s) => (
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

            {plan && plan.warnings.length > 0 ? (
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
                <span className="k">foundation</span>
                <span className="v">
                  {from} → {to}
                </span>
                <span className="k">account</span>
                <span className="v">{meta?.config?.account_id ?? "—"}</span>
                <span className="k">plan</span>
                <span className="v">
                  {stepCount} steps · {destructiveCount} destructive
                </span>
              </div>
              <div className="mono td-plan-source">
                read from the server plan at {planFetchedAt ? fmtClock(planFetchedAt) : "—"} ·{" "}
                {/* biome-ignore lint/a11y/useValidAnchor: inline prose by design (docs/ui-brief.md); a real button here would need its own visual treatment. */}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    loadPlan();
                  }}
                >
                  Refresh
                </a>
              </div>
            </div>

            <p className="danger-copy">
              Every agent operation refuses with <b className="mono">LOCKED</b> while the update runs. A
              recovery archive of the current foundation is taken first, and the{" "}
              <b className="mono">_fleet</b> stamp is the last write — a failure before it leaves the
              fleet exactly where it is, and the update re-runnable.
            </p>

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
                title="foundation update"
                sub={`${from} → ${to} · ${meta?.config?.region ?? "—"}`}
                op={op}
              />
            </div>

            {closeBlocked ? (
              <div className="mono td-plan-source">
                foundation update in progress — this drawer stays open until it finishes
              </div>
            ) : null}

            {op.finished && !op.ok ? (
              <div className="td-done">
                <div className="wiz-error mono">
                  {op.error ? `${op.error.code}: ${op.error.message}` : "the op failed"}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setOpId(null);
                    refreshed.current = false;
                    setStage(1);
                    loadPlan();
                  }}
                >
                  Back
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {stage === 1 ? (
        <div className="drawer-foot">
          <span className="wiz-note mono">
            {gate.allowed ? `${stepCount} steps · ${destructiveCount} destructive` : gate.reason}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!gate.allowed}
            style={{ opacity: gate.allowed ? 1 : 0.4 }}
            onClick={() => setStage(2)}
          >
            Continue →
          </button>
        </div>
      ) : null}

      {stage === 2 ? (
        <div className="drawer-foot">
          <button type="button" className="btn btn-secondary" onClick={() => setStage(1)}>
            ← Back
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={starting || !gate.allowed}
            style={{ opacity: starting || !gate.allowed ? 0.4 : 1 }}
            onClick={() => void start()}
          >
            {starting ? "Starting…" : "Update the foundation"}
          </button>
        </div>
      ) : null}

      {stage === 3 && op.finished ? (
        <div className="drawer-foot">
          <span className="wiz-note mono">
            {op.ok ? `foundation is on ${to}` : "the update did not finish"}
          </span>
          <button type="button" className="btn btn-primary" onClick={attemptClose}>
            Close
          </button>
        </div>
      ) : null}
    </Drawer>
  );
}
