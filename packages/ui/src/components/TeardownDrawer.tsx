/**
 * The DANGER teardown flow: review the plan → typed confirmation → progress.
 * Refuses (stage 1 only lets you leave) while any agent exists, because core
 * refuses too (`AGENTS_EXIST`) — the UI just says so before the op ever starts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, planTeardownFoundation, teardownFoundation } from "../api/index.ts";
import type { AgentView, Meta, TeardownOptions, TeardownPlan } from "../api/index.ts";
import { fmtClockTz } from "../logic/format.ts";
import { useFleet } from "../state/state.tsx";
import {
  AGENTS_EXIST_RE,
  accountMatches,
  canSubmit,
  invalidateOnOptionsChange,
  wordMatches,
} from "../logic/teardown-logic.ts";
import { teardownPhases, useOp } from "../lib/useOp.ts";
import { Drawer, DrawerHead } from "./Drawer.tsx";
import { TypedConfirm } from "./TypedConfirm.tsx";
import { PlanSkeleton } from "./Loading.tsx";
import { OpProgress } from "./OpProgress.tsx";

type Stage = 1 | 2 | 3;

/** sessionStorage key for the in-flight op id, so reopening this drawer mid-Stage-3 reattaches. */
const OPID_KEY = "hermetic.teardown.opId";

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

function OptionRow({
  checked,
  onChange,
  label,
  sub,
  danger,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  sub?: string;
  danger?: string;
  disabled?: boolean;
}) {
  return (
    // The note lives outside the bordered row and is indented to the label's
    // text column, so a two-line option never runs into the row below it.
    <div className={disabled ? "td-option td-option-off" : "td-option"}>
      <label className="verify-row">
        <input
          type="checkbox"
          className="verify-check"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="verify-label">{label}</span>
      </label>
      {sub ? <div className="td-option-note mono">{sub}</div> : null}
      {danger ? <div className="td-option-note td-option-danger mono">{danger}</div> : null}
    </div>
  );
}

export function TeardownDrawer({
  meta,
  agents,
  onClose,
  onGoToFleet,
  onFinished,
}: {
  meta: Meta | null;
  agents: AgentView[];
  onClose: () => void;
  onGoToFleet: () => void;
  /**
   * The teardown finished. The receipt modal is raised by the app shell rather
   * than here (§4.6): with `reset_local` this whole view is about to be
   * replaced by the init wizard, and the record of what was removed must
   * outlive the drawer that started it.
   */
  onFinished: () => void;
}) {
  const fleet = useFleet();
  const storedOpId = readStoredOpId();
  const [stage, setStage] = useState<Stage>(storedOpId ? 3 : 1);
  const [options, setOptions] = useState<Required<TeardownOptions>>({
    purge: true,
    delete_snapshots: false,
    delete_volumes: false,
    reset_local: true,
  });
  const [plan, setPlan] = useState<TeardownPlan | null>(null);
  /**
   * §4.6: `purge` releases the fleet's NAT Elastic IP as well as its
   * parameters, and a release is irreversible — the address goes back to AWS's
   * pool and every upstream allow-list naming it stops working. Read off the
   * plan rather than from a second source, so the checkbox and the step list
   * the operator is reading cannot disagree; only a `nat` fleet has the step.
   */
  const natFleet = plan?.steps.some((step) => step.id === "addresses") === true;
  const [planLoading, setPlanLoading] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planFetchedAt, setPlanFetchedAt] = useState<string | null>(null);
  const [accountTyped, setAccountTyped] = useState("");
  const [wordTyped, setWordTyped] = useState("");
  const [opId, setOpId] = useState<string | null>(storedOpId);
  const [startError, setStartError] = useState<{ code: string; message: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const [metaWaiting, setMetaWaiting] = useState(false);
  const checklistRef = useRef<HTMLPreElement | null>(null);
  const prevOptionsRef = useRef(options);
  const prevAccountIdRef = useRef<string | null | undefined>(undefined);

  // The rail lists exactly the phases these flags will produce, so a finished
  // run never shows a step that was never going to run.
  const phases = useMemo(
    () => teardownPhases(options),
    [options.purge, options.delete_snapshots, options.delete_volumes, options.reset_local],
  );
  const op = useOp(opId, phases);

  function loadPlan() {
    let alive = true;
    setPlanLoading(true);
    setPlanError(null);
    planTeardownFoundation(options)
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
  }

  useEffect(() => {
    return loadPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.purge, options.delete_snapshots, options.delete_volumes, options.reset_local]);

  // Options change → the plan (and any previously-typed confirmation) is
  // stale: a different flag set can mean a more or less destructive plan, so
  // a match typed against the old one must not silently carry over.
  useEffect(() => {
    if (invalidateOnOptionsChange(prevOptionsRef.current, options)) {
      setAccountTyped("");
      setWordTyped("");
    }
    prevOptionsRef.current = options;
  }, [options]);

  // Stage dropping below 2 (Back to Review) also invalidates — same reason:
  // the operator may change options from Stage 1 before returning to Confirm.
  useEffect(() => {
    if (stage < 2) {
      setAccountTyped("");
      setWordTyped("");
    }
  }, [stage]);

  // The fetched plan's account id is server truth; if a refetch ever resolves
  // to a different account (a different plan/fleet), any typed confirmation
  // must be cleared rather than silently re-validated against the new id.
  useEffect(() => {
    const id = plan?.summary?.account_id ?? null;
    if (prevAccountIdRef.current !== undefined && prevAccountIdRef.current !== id) {
      setAccountTyped("");
      setWordTyped("");
    }
    prevAccountIdRef.current = id;
  }, [plan?.summary?.account_id]);

  // Keep sessionStorage in sync with the in-flight op so a reopen of this
  // drawer (Settings → Tear down…) reattaches instead of restarting Stage 1.
  useEffect(() => {
    writeStoredOpId(opId);
  }, [opId]);
  useEffect(() => {
    if (op.finished) writeStoredOpId(null);
  }, [op.finished]);

  const living = agents.filter((a) => a.display_status !== "destroyed");
  const agentsExist = living.length > 0;

  // Display falls back to `meta.config` for a field an older/failed plan
  // omits; the Stage 2 *match* check below never does — it is server truth
  // from the plan only.
  const account = plan?.summary?.account_id ?? meta?.config?.account_id ?? "—";
  const region = plan?.summary?.region ?? meta?.config?.region ?? "—";
  const destructiveCount = plan?.steps.filter((s) => s.destructive).length ?? 0;
  const stepCount = plan?.steps.length ?? 0;
  const manualSteps = (plan?.warnings ?? []).filter((w) => !AGENTS_EXIST_RE.test(w));

  function refreshPlan() {
    setAccountTyped("");
    setWordTyped("");
    loadPlan();
  }

  async function start() {
    setStarting(true);
    setStartError(null);
    try {
      // The route requires the typed twelve digits in the body (there is no
      // prompt on this side of the wire) — `accountTyped` is what Stage 2's
      // match check already gated the button on, so it is always well-formed
      // here.
      const accepted = await teardownFoundation(accountTyped.trim(), options);
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

  // Whether or not the local config was reset, a finished teardown has a
  // receipt, and that is what the operator is owed: the modal is raised once,
  // above whichever view the app has swapped to by then.
  const raised = useRef(false);
  useEffect(() => {
    if (!op.finished || raised.current) return;
    raised.current = true;
    onFinished();
  }, [op.finished, onFinished]);

  // Once the op finishes ok, poll `/api/meta` — `reset_local` flips
  // `initialized` to false, and the app shell (`App.tsx`) reacts to that by
  // swapping this whole view for the init wizard, which shows `last_teardown`.
  useEffect(() => {
    if (!op.finished || !op.ok) return;
    // Only `reset_local` can flip `initialized`; without it there is nothing to
    // wait for and the drawer would sit on a "catching up…" line for six
    // seconds after a teardown that deliberately kept the local config.
    if (!options.reset_local) return;
    let alive = true;
    setMetaWaiting(true);
    let tries = 0;
    const poll = async () => {
      const next = await fleet.refreshMeta();
      if (!alive) return;
      if (next && next.initialized === false) {
        setMetaWaiting(false);
        return;
      }
      tries += 1;
      if (tries > 12) {
        setMetaWaiting(false);
        return;
      }
      setTimeout(() => void poll(), 500);
    };
    void poll();
    return () => {
      alive = false;
    };
  }, [op.finished, op.ok, options.reset_local]);

  const checklist =
    manualSteps.length > 0 ? manualSteps.map((w) => `- ${w}`).join("\n") : "- nothing left by hand";

  function copyChecklist() {
    const selectManually = () => {
      const pane = checklistRef.current;
      if (pane) {
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(pane);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
      setCopyState("manual");
      setTimeout(() => setCopyState("idle"), 3000);
    };
    if (!navigator.clipboard) {
      selectManually();
      return;
    }
    navigator.clipboard.writeText(checklist).then(
      () => setCopyState("copied"),
      () => selectManually(),
    );
  }

  // Server truth only — never `meta.config.account_id`: the two typed boxes
  // compare against the fetched plan's summary, and `canSubmit` re-checks both
  // with the stricter pure rules (twelve digits, the literal word).
  const submitEnabled = canSubmit({
    stage,
    plan,
    planLoading,
    planError,
    agentsExist,
    accountTyped,
    wordTyped,
  });

  // Stage 3 while the op is still running: closing here would discard the
  // progress view mid-teardown, so the backdrop and Esc are ignored (a hint
  // explains why) until the op finishes.
  const closeBlocked = stage === 3 && op.running;

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
    // Capture phase: fires before the app shell's own bubble-phase Esc
    // handler, so the drawer never closes out from under a running op.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeBlocked]);

  return (
    <Drawer width={640} onClose={attemptClose} labelledBy="teardown-title">
      <DrawerHead
        titleId="teardown-title"
        kicker="Danger"
        title="Tear down the foundation"
        onClose={attemptClose}
      />

      <div className="drawer-body td-body">
        {stage === 1 ? (
          <div className="td-stage">
            <div className="kicker">Stage 1 · Review</div>

            {agentsExist ? (
              <div className="td-agents-callout">
                <b>{living.length} agent(s) still exist</b> — teardown will refuse until they are
                destroyed.
                <ul>
                  {living.map((a) => (
                    <li key={a.name} className="mono">
                      {a.name} · {a.display_status}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="td-summary mono">
              <span className="k">account</span>
              <span className="v">{account}</span>
              <span className="k">region</span>
              <span className="v">{region}</span>
              <span className="k">fleet</span>
              <span className="v">{plan?.summary?.fleet_id ?? meta?.config?.fleet_id ?? "—"}</span>
              <span className="k">stack id</span>
              <span className="v">{plan?.summary?.stack_id ?? meta?.config?.stack_id ?? "—"}</span>
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

            {manualSteps.length > 0 ? (
              <div className="td-section">
                <div className="kicker td-kicker-warn">What stays behind — do by hand</div>
                <ul className="td-warnings">
                  {manualSteps.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="td-options">
              <OptionRow
                checked={options.purge}
                onChange={(v) => setOptions((o) => ({ ...o, purge: v }))}
                label={
                  natFleet ? "Purge SSM parameters and release the NAT address" : "Purge SSM parameters"
                }
                disabled={agentsExist}
              />
              <OptionRow
                checked={options.delete_snapshots}
                onChange={(v) => setOptions((o) => ({ ...o, delete_snapshots: v }))}
                label="Delete DLM snapshots of data volumes"
                disabled={agentsExist}
              />
              <OptionRow
                checked={options.delete_volumes}
                onChange={(v) => setOptions((o) => ({ ...o, delete_volumes: v }))}
                label="Delete leftover data volumes"
                danger="agent memory and skills are lost"
                disabled={agentsExist}
              />
              <OptionRow
                checked={options.reset_local}
                onChange={(v) => setOptions((o) => ({ ...o, reset_local: v }))}
                label="Reset this laptop's local config"
                sub="returns this home to the init wizard"
                disabled={agentsExist}
              />
            </div>
          </div>
        ) : null}

        {stage === 2 ? (
          <div className="td-stage">
            <div className="kicker">Stage 2 · Confirm</div>

            {/* What is about to be destroyed, restated beside the two inputs the
                operator has to type — the plan itself is a stage back. */}
            <div className="td-target">
              <div className="td-summary mono">
                <span className="k">account</span>
                <span className="v">{account}</span>
                <span className="k">region</span>
                <span className="v">{region}</span>
                <span className="k">fleet</span>
                <span className="v">{plan?.summary?.fleet_id ?? meta?.config?.fleet_id ?? "—"}</span>
                <span className="k">plan</span>
                <span className="v">
                  {stepCount} steps · {destructiveCount} destructive
                </span>
              </div>
              <div className="mono td-plan-source">
                read from the server plan at {planFetchedAt ? fmtClockTz(planFetchedAt) : "—"} ·{" "}
                {/* biome-ignore lint/a11y/useValidAnchor: inline prose by design (docs/ui-brief.md); a real button here would need its own visual treatment. */}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    refreshPlan();
                  }}
                >
                  Refresh
                </a>
              </div>
            </div>

            {/*
              Both boxes are told the *same* predicate `canSubmit` gates on, not
              a look-alike: `accountMatches` also insists on twelve digits, so a
              plain equality check in the label could read "matches" over a
              button that stayed disabled.
            */}
            <TypedConfirm
              label="Account id"
              expected={plan?.summary?.account_id ?? ""}
              matches={(typed) => accountMatches(typed, plan?.summary?.account_id)}
              value={accountTyped}
              onChange={setAccountTyped}
              sanitize={(v) => v.replace(/[^0-9]/g, "")}
              inputMode="numeric"
              hint={`type the 12-digit account id · ${account}`}
              placeholder="type the account id"
              ariaLabel="Type the account id to confirm"
            />

            <TypedConfirm
              label={'Type "teardown" to confirm'}
              expected="teardown"
              matches={wordMatches}
              value={wordTyped}
              onChange={setWordTyped}
              hint="type the word teardown, lowercase"
              placeholder="teardown"
              ariaLabel="Type the word teardown to confirm"
            />

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
              <OpProgress title="teardown" sub={`${account} · ${region}`} op={op} />
            </div>

            {closeBlocked ? (
              <div className="mono td-plan-source">
                teardown in progress — this drawer stays open until it finishes
              </div>
            ) : null}

            {op.finished && op.ok ? (
              <div className="td-done">
                <h3 className="td-done-title">Foundation removed</h3>
                <div className="kicker">Manual checklist</div>
                <pre ref={checklistRef} className="logpane td-checklist">
                  {checklist}
                </pre>
                <button type="button" className="btn btn-secondary" onClick={copyChecklist}>
                  {copyState === "manual"
                    ? "Select & copy manually"
                    : copyState === "copied"
                      ? "Copied"
                      : "Copy checklist"}
                </button>
                {metaWaiting ? (
                  <div className="settings-hint mono">waiting for the local config to catch up…</div>
                ) : null}
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
                    setStage(2);
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
          {agentsExist ? (
            <>
              <span className="wiz-note mono">destroy every agent before tearing down</span>
              <span style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn btn-secondary" onClick={attemptClose}>
                  ← Back
                </button>
                <button type="button" className="btn btn-primary" onClick={onGoToFleet}>
                  Go to fleet
                </button>
              </span>
            </>
          ) : (
            <>
              <span className="wiz-note mono">
                {stepCount} steps · {destructiveCount} destructive
              </span>
              <button
                type="button"
                className="btn btn-danger"
                disabled={planLoading || !!planError}
                style={{ opacity: planLoading || planError ? 0.4 : 1 }}
                onClick={() => setStage(2)}
              >
                Continue →
              </button>
            </>
          )}
        </div>
      ) : null}

      {/* Stage 3 has no footer while the op runs — there is nothing to press and
          `closeBlocked` refuses to close anyway. Once it succeeds without
          `reset_local`, the app shell never swaps this view out, so the drawer
          owes the operator a way out. */}
      {stage === 3 && op.finished && op.ok ? (
        <div className="drawer-foot">
          <span className="wiz-note mono">foundation removed · {account}</span>
          <button type="button" className="btn btn-primary" onClick={attemptClose}>
            Close
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
            className="btn btn-teardown-cta"
            disabled={!submitEnabled || starting}
            style={{ opacity: submitEnabled ? 1 : 0.35 }}
            onClick={() => void start()}
          >
            {starting ? "Starting…" : "Tear down the foundation"}
          </button>
        </div>
      ) : null}
    </Drawer>
  );
}
