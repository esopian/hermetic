/**
 * The §4.7 init wizard: what the CLI's `hermetic init` asks, asked in the
 * browser. It is the whole page while `/api/meta.initialized` is false — there
 * is no fleet to show and no target to act on until this finishes.
 *
 * The Tailscale OAuth secret lives in component state and nowhere else: it is
 * never persisted, never logged, and cleared on unmount and on any error.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  credentialTypeOf,
  initAcl,
  initIdentity,
  initProfiles,
  initTailscale,
  initVerifyOauth,
  isInitialized,
  sourceLabel,
  startInit,
} from "../api/index.ts";
import { fmtDateTime } from "../logic/format.ts";
import { hasOpenOverlay } from "../lib/focus.ts";
import type {
  AclSnippet,
  InitFoundation,
  InitIdentity,
  InitInputBody,
  InitOauthCheck,
  InitProfile,
  InitTailscale,
  Meta,
} from "../api/index.ts";
import { SAFE_TO_CLOSE, serverReportedEnd } from "../logic/op-hints.ts";
import { useFleet } from "../state/state.tsx";
import { INIT_ATTACH_PHASES, initCreatePhases, useOp } from "../lib/useOp.ts";
import { ConnectionCheck } from "./ConnectionCheck.tsx";
import {
  CertificatesStep,
  ClientSecretStep,
  NetworkStep,
  OauthClientStep,
  PolicyStep,
  TailnetStep,
  oauthVerdict,
} from "./InitSteps.tsx";
import { OpProgress } from "./OpProgress.tsx";

/**
 * Step 3's five sub-sections live in `InitSteps.tsx`; these re-exports keep the
 * wizard the one door to them, which is where every caller and every test
 * already looks.
 */
export {
  CertificatesStep,
  OAUTH_TONE,
  POLICY_NONE_NOTE,
  POLICY_READ_NOTE,
  oauthVerdict,
} from "./InitSteps.tsx";
export type { OauthTone } from "./InitSteps.tsx";

type StepId = 1 | 2 | 3 | 4;

const STEP_LABELS: Array<{ id: StepId; label: string }> = [
  { id: 1, label: "Profile" },
  { id: 2, label: "Verify account" },
  { id: 3, label: "Foundation" },
  { id: 4, label: "Initialize" },
];

/**
 * What the wizard posts to `POST /api/init`, as a function of what the operator
 * chose — pure, so the two decisions that are easy to invert (the create-only
 * fields, and `skip_policy` being the *negation* of a checkbox that reads
 * positively) are testable without mounting the wizard.
 *
 * `skip_policy` is sent only when it is true: absent means core's default,
 * which is to manage the policy, and an explicit `false` would be the same
 * request said louder.
 */
export function initRequestBody(input: {
  profile: string;
  region: string;
  accountId: string;
  attaching: boolean;
  tailnet: string;
  network: "public" | "nat";
  secret: string;
  /** The checkbox, as it reads on screen: on = hermetic may write the policy. */
  managePolicy: boolean;
}): InitInputBody {
  return {
    profile: input.profile,
    region: input.region.trim(),
    // The wire shape is unchanged: core still requires the 12 digits and
    // re-verifies them against STS itself. The UI replaced its typed digit box
    // with the step-2 "I verified this account" toggle, so the account id read
    // back from the same STS call core will redo stands in for what the CLI's
    // operator types by hand.
    account_id_typed: input.accountId,
    mode: input.attaching ? "attach" : "create",
    ...(input.attaching ? {} : { tailnet: input.tailnet, network: input.network }),
    ...(input.attaching || input.secret === "" ? {} : { tailscale_oauth_secret: input.secret }),
    ...(input.attaching || input.managePolicy ? {} : { skip_policy: true }),
  };
}

function Rail({ step, skipFoundation }: { step: StepId; skipFoundation: boolean }) {
  return (
    <div className="wiz-rail">
      <div className="kicker">Bind this home</div>
      <div className="steps" style={{ margin: "14px 0 0" }}>
        {STEP_LABELS.map((s) => {
          const skipped = s.id === 3 && skipFoundation;
          const state = skipped
            ? "pending"
            : s.id < step
              ? "done"
              : s.id === step
                ? "current"
                : "pending";
          return (
            <div className="step" key={s.id} style={{ opacity: state === "pending" ? 0.5 : 1 }}>
              <i
                style={{
                  background:
                    state === "done"
                      ? "var(--ok)"
                      : state === "current"
                        ? "var(--acc)"
                        : "var(--line2)",
                  animation: state === "current" ? "hpulse 1.2s infinite" : "none",
                }}
              />
              <b>{s.label}</b>
              <span>{skipped ? "n/a" : `0${s.id}`}</span>
            </div>
          );
        })}
      </div>
      <div className="wiz-rail-foot mono">one home · one account · frozen once</div>
    </div>
  );
}

function CredTag({ type }: { type: string }) {
  return <span className="cred-tag">{type}</span>;
}

const DISMISSED_TEARDOWN_KEY = "hermetic.dismissedLastTeardown";

/**
 * sessionStorage key for the in-flight init op, the way `TeardownDrawer` keeps
 * one. `init` is the longest unattended wait in the product and the only flow
 * that did not survive a reload: the tab came back on step 1, three steps of
 * re-answering later `POST /api/init` answered 409, and the op that was still
 * building the foundation was reported as "Init failed".
 */
const INIT_OPID_KEY = "hermetic.init.opId";

/**
 * What a reloaded tab needs to draw step 4 honestly. The op id alone is not
 * enough: `attaching` is derived from a `foundation` probe that a reloaded tab
 * has not run, so an attach would have been seeded with the *create* phase list
 * and shown a rail of steps it was never going to take, under a header reading
 * "— · create · — · —".
 *
 * Only display strings and the branch. No secret has ever been near this key —
 * the OAuth secret lives in component state and nowhere else.
 */
export interface ResumedInit {
  opId: string;
  attaching: boolean;
  profile: string | null;
  region: string;
  tailnet: string;
  accountId: string | null;
  /** Whether the run seeded §4.7's `policy` phase; see `initCreatePhases`. */
  policyPhase: boolean;
}

export function readStoredInit(): ResumedInit | null {
  try {
    const raw = sessionStorage.getItem(INIT_OPID_KEY);
    if (!raw) return null;
    // An older build wrote the bare id. Read it rather than throwing the
    // breadcrumb away — a running foundation create is exactly what this is for.
    if (!raw.startsWith("{")) {
      return {
        opId: raw,
        attaching: false,
        profile: null,
        region: "",
        tailnet: "",
        accountId: null,
        policyPhase: false,
      };
    }
    const parsed = JSON.parse(raw) as Partial<ResumedInit>;
    return typeof parsed.opId === "string" && parsed.opId !== ""
      ? {
          opId: parsed.opId,
          attaching: parsed.attaching === true,
          profile: typeof parsed.profile === "string" ? parsed.profile : null,
          region: typeof parsed.region === "string" ? parsed.region : "",
          tailnet: typeof parsed.tailnet === "string" ? parsed.tailnet : "",
          accountId: typeof parsed.accountId === "string" ? parsed.accountId : null,
          policyPhase: parsed.policyPhase === true,
        }
      : null;
  } catch {
    return null;
  }
}

function writeStoredInit(record: ResumedInit | null): void {
  try {
    if (record) sessionStorage.setItem(INIT_OPID_KEY, JSON.stringify(record));
    else sessionStorage.removeItem(INIT_OPID_KEY);
  } catch {
    /* private mode: reattach just will not survive a reload */
  }
}

export function InitWizard({
  meta,
  onOpenFleet,
  onOpenReceipt,
}: {
  meta: Meta | null;
  onOpenFleet: () => void;
  /** Reopen the receipt of the teardown that returned this home here (§4.6). */
  onOpenReceipt?: () => void;
}) {
  const fleet = useFleet();
  // An init op the engine is still running outlives this tab. Read before
  // anything else so the first paint of a reloaded page is the progress view
  // rather than step 1 — see `INIT_OPID_KEY`.
  const resumed = useRef(readStoredInit()).current;
  const [step, setStep] = useState<StepId>(resumed ? 4 : 1);
  const [profiles, setProfiles] = useState<InitProfile[]>([]);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [region, setRegion] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [identity, setIdentity] = useState<InitIdentity | null>(null);
  const [foundation, setFoundation] = useState<InitFoundation | null>(null);
  // Step 2's connection check (§ product change: moved off step 1): idle
  // until step 2 is entered, then processing/confirmed/error for the
  // profile+region combo currently on screen. Any profile or region edit
  // (both only possible on step 1) invalidates a prior "confirmed" result
  // back to idle, so it re-runs the next time step 2 is entered.
  const [checkStatus, setCheckStatus] = useState<"idle" | "processing" | "confirmed" | "error">("idle");
  const [checkError, setCheckError] = useState<{ code: string; message: string } | null>(null);
  const checkIdRef = useRef(0);
  // Step 2's explicit verify toggle, standing in for the CLI's typed
  // 12-digit confirmation (see `run` below).
  const [verified, setVerified] = useState(false);
  /**
   * §4.7 preflight. The tailnet is *detected*, never typed: the tailnet this
   * machine is on is the tailnet the fleet belongs to, and the operator's job
   * is to confirm it rather than to spell it. Step 3 probes on entry; `init`
   * refuses the create branch on the same reading, so a red panel here is the
   * same answer the engine would give, shown before anything is created.
   */
  const [ts, setTs] = useState<InitTailscale | null>(null);
  const [tsStatus, setTsStatus] = useState<"idle" | "processing" | "done" | "error">("idle");
  const [tsError, setTsError] = useState<string | null>(null);
  const [tailnetConfirmed, setTailnetConfirmed] = useState(false);
  const [secret, setSecret] = useState("");
  // The OAuth client is proved by using it: mint a `tag:hermetic` key, revoke
  // it, then list the tailnet's devices. A pasted secret must go green before
  // Initialize opens; no secret at all stays allowed (core warns, and the
  // operator pushes one later). Only the mint gates green — a client without
  // `devices:core` is the state every pre-existing fleet is in, so it verifies
  // yellow, with the note core wrote, rather than red.
  const [oauth, setOauth] = useState<InitOauthCheck | null>(null);
  const [oauthStatus, setOauthStatus] = useState<"idle" | "processing" | "done" | "error">("idle");
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [network, setNetwork] = useState<"public" | "nat">("public");
  const [acl, setAcl] = useState<AclSnippet | null>(null);
  const [showWholePolicy, setShowWholePolicy] = useState(false);
  /**
   * §4.7: let `init` keep hermetic's `ssh`/`acls` blocks current through the
   * API. On by default — the recommended client carries Policy File write, and
   * a managed block is the difference between a policy that stays right and one
   * that has to be re-pasted on every upgrade. Off is `--skip-policy`, for a
   * policy file deployed from git.
   */
  const [managePolicy, setManagePolicy] = useState(true);
  const [opId, setOpId] = useState<string | null>(resumed?.opId ?? null);
  /**
   * The resumed run closed its stream without the server ever saying how it
   * went — a stale id from a portal that has since restarted, or an op the
   * registry has already forgotten. Not a failure: nothing is known about it,
   * and inventing "Init failed" over a foundation that may well exist is the
   * one answer that could talk an operator into building a second one.
   */
  const [resumeLost, setResumeLost] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [ready, setReady] = useState(false);
  // Set when `startInit` rejects synchronously (e.g. 409 CONFLICT: another
  // init already in flight, or `mode` doesn't match the foundation) — no op
  // ever started, so there is nothing for `useOp` to track.
  const [initError, setInitError] = useState<{ code: string; message: string } | null>(null);
  const [dismissedTeardownAt, setDismissedTeardownAt] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(DISMISSED_TEARDOWN_KEY);
    } catch {
      return null;
    }
  });
  const showTeardownNotice =
    meta?.last_teardown != null && meta.last_teardown.at !== dismissedTeardownAt;

  /**
   * A resumed tab has run no `foundation` probe, so `foundation` is null and
   * this would read `create` for an attach — seeding the rail with a phase list
   * the op was never going to run. The stored branch is what that op actually
   * asked for, so it wins until a probe of this tab's own says otherwise.
   */
  const attaching = foundation === null && resumed ? resumed.attaching : foundation?.found === true;
  // One reading of the OAuth check, shared by the verdict line and the note.
  const oauthSays = oauthVerdict(oauthStatus, secret, oauth, oauthError);
  const tailnet = ts?.tailnet ?? resumed?.tailnet ?? "";
  /** Step 4's header, from this session's state or from the resumed record. */
  const shownProfile = profile ?? resumed?.profile ?? null;
  const shownRegion = region || (resumed?.region ?? "");
  const shownAccountId = identity?.account_id ?? resumed?.accountId ?? null;
  // Set by `run()` from the request it actually sent, so the rail seeds the
  // §4.7 policy step only on a run that will have one.
  const [policyPhase, setPolicyPhase] = useState(resumed?.policyPhase === true);
  const createPhases = useMemo(() => initCreatePhases(policyPhase), [policyPhase]);
  const op = useOp(opId, attaching ? INIT_ATTACH_PHASES : createPhases);
  const secretRef = useRef("");
  secretRef.current = secret;
  const polling = useRef(false);
  // `fleet` is a new object on every poll tick; only the stable callbacks may
  // be effect dependencies, or the wait below cancels itself.
  const { refreshMeta } = fleet;

  // The secret exists only while this component does.
  useEffect(() => () => setSecret(""), []);

  useEffect(() => {
    let alive = true;
    initProfiles()
      .then((list) => {
        if (!alive) return;
        setProfiles(list);
        const first = list[0];
        if (first) {
          setProfile(first.name);
          setRegion(first.region ?? "");
        }
      })
      .catch((e: unknown) => {
        if (alive) setProfilesError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  /** Step 3's preflight, re-runnable from the panel's Retry. */
  const probeTailscale = useCallback(() => {
    setTsStatus("processing");
    setTsError(null);
    initTailscale()
      .then((answer) => {
        setTs(answer);
        setTsStatus("done");
        // A machine that moved tailnets between probes must be re-confirmed.
        setTailnetConfirmed(false);
      })
      .catch((e: unknown) => {
        setTs(null);
        setTsStatus("error");
        setTsError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    if (step !== 3 || attaching || tsStatus !== "idle") return;
    probeTailscale();
  }, [step, attaching, tsStatus, probeTailscale]);

  /**
   * Verifying mints a real key, so it runs once per value — on paste of a
   * well-formed secret, on blur, or on the button — never per keystroke.
   */
  const verifyOauth = useCallback((value: string = secretRef.current) => {
    if (value === "") return;
    setOauthStatus("processing");
    setOauthError(null);
    initVerifyOauth(value)
      .then((answer) => {
        setOauth(answer);
        setOauthStatus("done");
      })
      .catch((e: unknown) => {
        setOauth(null);
        setOauthStatus("error");
        setOauthError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    if (step !== 3 || attaching || acl !== null) return;
    let alive = true;
    initAcl()
      .then((s) => {
        if (alive) setAcl(s);
      })
      .catch(() => {
        if (alive) setAcl({ snippet: "# the server could not render the ACL snippet", parts: [] });
      });
    return () => {
      alive = false;
    };
  }, [step, attaching, acl]);

  /** Runs the STS connection check for one profile+region; stale responses (a
   * later edit or retry fired another check first) are dropped via
   * `checkIdRef`. */
  const runCheck = useCallback((p: string, r: string) => {
    const id = ++checkIdRef.current;
    setCheckStatus("processing");
    setCheckError(null);
    initIdentity(p, r.trim() === "" ? undefined : r.trim())
      .then((answer) => {
        if (id !== checkIdRef.current) return;
        setIdentity(answer.identity);
        setFoundation(answer.foundation);
        setCheckStatus("confirmed");
      })
      .catch((e: unknown) => {
        if (id !== checkIdRef.current) return;
        setIdentity(null);
        setFoundation(null);
        setCheckStatus("error");
        setCheckError(
          e instanceof ApiError
            ? { code: e.code, message: e.message }
            : { code: "ERROR", message: e instanceof Error ? e.message : String(e) },
        );
      });
  }, []);

  // Picking a profile or editing the region override never calls out to the
  // network by itself (§ step 1 is now offline) — it just invalidates any
  // check already made for the previous combo, so step 2 re-checks on entry.
  const pick = useCallback((p: InitProfile) => {
    setProfile(p.name);
    setRegion(p.region ?? "");
    setFailure(null);
    setVerified(false);
    setIdentity(null);
    setFoundation(null);
    setCheckStatus("idle");
  }, []);

  const onRegionChange = useCallback((value: string) => {
    setRegion(value);
    setVerified(false);
    setIdentity(null);
    setFoundation(null);
    setCheckStatus("idle");
    checkIdRef.current += 1;
  }, []);

  // Step 2's check runs the moment the step is entered (and only then — a
  // cached confirmed/error result for the same profile+region is left alone
  // if the operator goes back to step 1 and returns without changing
  // anything).
  useEffect(() => {
    if (step === 2 && checkStatus === "idle" && profile) runCheck(profile, region);
  }, [step, checkStatus, profile, region, runCheck]);

  /**
   * Write the reattach breadcrumb for an op that is now running. Display bits
   * only; the OAuth secret is never in here.
   */
  function remember(id: string, policy: boolean): void {
    writeStoredInit({
      opId: id,
      attaching,
      profile,
      region,
      tailnet,
      accountId: identity?.account_id ?? null,
      policyPhase: policy,
    });
  }

  async function run() {
    if (!profile || !identity) return;
    setFailure(null);
    setInitError(null);
    // Declared out here so the 409 path below can remember the *same* value the
    // request was built with — `policyPhase` is state, and the `setPolicyPhase`
    // a few lines down has not landed by the time the catch runs.
    let policy = policyPhase;
    try {
      const body = initRequestBody({
        profile,
        region,
        accountId: identity.account_id,
        attaching,
        tailnet,
        network,
        secret: secretRef.current,
        managePolicy,
      });
      // Seeded before the op starts: core emits `policy` only on a run that
      // will touch the file or say why it did not, and a seed phase is never
      // folded back out (`useOp`).
      policy = body.skip_policy === true || body.tailscale_oauth_secret !== undefined;
      setPolicyPhase(policy);
      const accepted = await startInit(body);
      setOpId(accepted.op_id);
      remember(accepted.op_id, policy);
      setStep(4);
    } catch (e) {
      setSecret("");
      if (e instanceof ApiError) {
        // A 409 that names the op already running is not a failure: it is this
        // init, started by the tab that was reloaded (or by a second window).
        // Follow it — the foundation it is building is the one this operator
        // asked for, and "Init failed" over a running CreateStack is a lie
        // that invites a second one.
        if (e.opId) {
          setOpId(e.opId);
          remember(e.opId, policy);
          setInitError(null);
          setResumeLost(false);
          setStep(4);
          return;
        }
        // Everything else (a `mode` that mismatched the foundation, a refused
        // account) really did start nothing, so it is shown in the step-4
        // error slot rather than left on this step.
        setInitError({ code: e.code, message: e.message });
        setStep(4);
      } else {
        setFailure(e instanceof Error ? e.message : String(e));
      }
    }
  }

  /**
   * Drop the reattach breadcrumb only when the *server* said how the op went.
   *
   * `followOp` reports a dead socket through the same callback as a verdict
   * (`ok: false, error: null`), and a portal restart mid-`init` is exactly when
   * the socket dies — so clearing on `finished` alone erased the breadcrumb for
   * the running foundation create it exists to protect, a second or two before
   * the operator reloaded. `serverReportedEnd` is the distinction.
   */
  const settled = serverReportedEnd(op);
  useEffect(() => {
    if (settled) writeStoredInit(null);
  }, [settled]);

  /**
   * A *resumed* op whose stream closed with no verdict is a stale id: the
   * registry has forgotten it, or the portal it belonged to is gone. Nothing is
   * known about how it went, so the wizard says exactly that and starts over
   * rather than reporting a failure it did not observe.
   */
  useEffect(() => {
    if (!resumed || opId !== resumed.opId) return;
    if (!op.finished || settled) return;
    writeStoredInit(null);
    setResumeLost(true);
    setOpId(null);
    setStep(1);
  }, [resumed, opId, op.finished, settled]);

  /** `init` writes the local config last, so the flag lands slightly after `done`. */
  useEffect(() => {
    if (!op.finished || !op.ok || polling.current) return;
    polling.current = true;
    setWaiting(true);
    setSecret("");
    let alive = true;
    let tries = 0;
    // The retry itself is a `setTimeout`, not another `await`, so a component
    // that unmounts between polls (the wizard closes, the test moves on) must
    // cancel the pending one explicitly — the `alive` flag alone stops this
    // closure from touching state, but does nothing about a timer already
    // sitting on the event loop, which would otherwise fire a stray
    // `refreshMeta()` (and its network call) after nobody is listening.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (!alive) return;
      const next = await refreshMeta();
      if (!alive) return;
      if (next && isInitialized(next)) {
        setReady(true);
        setWaiting(false);
        return;
      }
      tries += 1;
      if (tries > 10) {
        setWaiting(false);
        setFailure("the engine finished but this home still reports no fleet; reload to retry");
        return;
      }
      timer = setTimeout(() => void poll(), 500);
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [op.finished, op.ok, refreshMeta]);

  const chosen = useMemo(() => profiles.find((p) => p.name === profile) ?? null, [profiles, profile]);

  /**
   * The create branch opens only once the preflight is green and confirmed.
   * There is no override here on purpose: `--skip-tailscale-check` is a CLI
   * flag for headless runs, and a button in a browser would be reached by
   * habit exactly when it should not be.
   *
   * A blank secret is still allowed — core warns and the operator pushes one
   * before the first agent — but a pasted one must be proved.
   */
  const initBlockedReason: string | null =
    tailnet === ""
      ? "this machine is not on a tailnet"
      : !tailnetConfirmed
        ? "confirm the tailnet first"
        : secret !== "" && !(oauthStatus === "done" && oauth?.ok)
          ? "verify the OAuth client secret first"
          : null;
  const canInitialize = initBlockedReason === null;

  function back(to: StepId) {
    setSecret("");
    setOauth(null);
    setOauthStatus("idle");
    setOauthError(null);
    setOpId(null);
    writeStoredInit(null);
    setResumeLost(false);
    setFailure(null);
    setInitError(null);
    setVerified(false);
    setStep(to);
  }

  // Init succeeded but the server couldn't attach the dashboard to the new
  // config afterward — there is no wizard step that can recover from that,
  // so it replaces the whole wizard rather than pretending step 1 still helps.
  if (meta?.adopt_error) {
    return (
      <div className="wizard">
        <div className="wiz-fatal">
          <div className="kicker">Init failed to attach</div>
          <h2>Initialized, but the dashboard could not attach</h2>
          <p>
            {meta.adopt_error}. Restart <b className="mono">hermetic-portal</b>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard">
      <div className="wiz-col">
        <Rail step={step} skipFoundation={attaching} />

        <div className="wiz-panel">
          {step === 1 ? (
            <>
              {showTeardownNotice && meta?.last_teardown ? (
                <div className="wiz-banner info mono teardown-notice">
                  <span>
                    Foundation {meta.last_teardown.fleet_id} in {meta.last_teardown.account_id}/
                    {meta.last_teardown.region} was torn down at {fmtDateTime(meta.last_teardown.at)}.
                    {meta.last_teardown.manual_steps.length > 0
                      ? ` Manual steps remaining: ${meta.last_teardown.manual_steps.join("; ")}.`
                      : ""}
                  </span>
                  {onOpenReceipt ? (
                    <button
                      type="button"
                      className="btn btn-secondary teardown-notice-dismiss"
                      onClick={onOpenReceipt}
                    >
                      What was removed
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-secondary teardown-notice-dismiss"
                    onClick={() => {
                      const at = meta.last_teardown?.at ?? null;
                      try {
                        if (at) sessionStorage.setItem(DISMISSED_TEARDOWN_KEY, at);
                      } catch {
                        /* private mode: the notice just does not stay dismissed across reload */
                      }
                      setDismissedTeardownAt(at);
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              ) : null}
              {/*
                A stored op id whose stream closed without a verdict. The
                foundation may well exist — nothing here observed it fail — so
                this says what is and is not known and sends the operator to
                step 2, where the account probe answers it for real.
              */}
              {resumeLost ? (
                <div className="wiz-banner info mono">
                  An init was running when this page last had it, and the engine no longer reports it —
                  the portal may have restarted. Nothing here says it failed. Continue to{" "}
                  <b>Verify account</b>: if the foundation was created, this becomes an <b>attach</b>.
                </div>
              ) : null}
              {meta?.env_overrides && meta.env_overrides.length > 0 ? (
                <div className="wiz-banner warn mono">
                  Environment credentials are set ({meta.env_overrides.join(", ")}) and will be{" "}
                  <b>IGNORED</b> — hermetic uses only the frozen profile.
                </div>
              ) : null}
              {meta?.corrupted_to ? (
                <div className="wiz-banner info mono">
                  Previous local state was unreadable and moved to {meta.corrupted_to}; only the run log
                  was lost.
                </div>
              ) : null}
              <div className="kicker">Step 01</div>
              <h2 className="wiz-title">Choose a profile</h2>
              <p className="wiz-copy">
                No identity is resolved until you pick — SSO profiles won&apos;t prompt yet.
              </p>
              {profilesError ? (
                <div className="wiz-error mono">{profilesError}</div>
              ) : (
                <div className="prof-table">
                  {profiles.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      className="prof-row"
                      aria-pressed={p.name === profile}
                      onClick={() => pick(p)}
                    >
                      <span className="nm">{p.name}</span>
                      <span className="mono src">{sourceLabel(p)}</span>
                      <span className="mono rg">{p.region ?? "—"}</span>
                      <CredTag type={credentialTypeOf(p)} />
                    </button>
                  ))}
                  {profiles.length === 0 ? (
                    <div className="group-empty">— no profiles in ~/.aws/config —</div>
                  ) : null}
                </div>
              )}

              <label className="wiz-field">
                <div className="kicker">Region override</div>
                <input
                  className="wiz-input mono"
                  value={region}
                  placeholder="us-west-2"
                  onChange={(e) => onRegionChange(e.target.value)}
                />
              </label>

              {failure ? <div className="wiz-error mono">{failure}</div> : null}

              <div className="wiz-foot">
                <span className="wiz-note">Reads ~/.aws/config only; nothing is written yet.</span>
                <button
                  type="button"
                  className="btn btn-primary wiz-cta"
                  disabled={!profile}
                  style={{ opacity: profile ? 1 : 0.35 }}
                  onClick={() => {
                    if (checkStatus === "idle" && profile) runCheck(profile, region);
                    setStep(2);
                  }}
                >
                  Continue →
                </button>
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <div className="kicker">Step 02</div>
              <h2 className="wiz-title">Verify the account</h2>

              <ConnectionCheck
                status={
                  checkStatus === "confirmed"
                    ? "confirmed"
                    : checkStatus === "error"
                      ? "error"
                      : "processing"
                }
                profile={profile ?? "—"}
                region={region}
                identity={identity}
                foundation={foundation}
                error={checkError}
                attaching={attaching}
                credLine={`${profile} · ${chosen ? credentialTypeOf(chosen) : "unknown"}`}
                onRetry={() => profile && runCheck(profile, region)}
                onBack={() => back(1)}
              />

              {checkStatus === "confirmed" && identity ? (
                <>
                  <label className="verify-row check-fade">
                    <input
                      type="checkbox"
                      className="verify-check"
                      checked={verified}
                      autoFocus={!hasOpenOverlay()}
                      onChange={(e) => setVerified(e.target.checked)}
                    />
                    <span className="verify-label">
                      I verified this is the account I intend to operate:{" "}
                      <span className="mono">{identity.account_id}</span>
                    </span>
                  </label>
                  <div className="verify-sub mono check-fade">
                    hermetic freezes this home to this account. Every create, upgrade and teardown will
                    run here.
                  </div>
                </>
              ) : null}

              {failure ? <div className="wiz-error mono">{failure}</div> : null}

              {checkStatus === "confirmed" ? (
                <div className="wiz-foot">
                  <button type="button" className="btn btn-secondary wiz-cta" onClick={() => back(1)}>
                    Back
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary wiz-cta"
                    disabled={!verified}
                    style={{ opacity: verified ? 1 : 0.35 }}
                    onClick={() => (attaching ? void run() : setStep(3))}
                  >
                    {attaching ? "Attach →" : "Continue →"}
                  </button>
                </div>
              ) : null}
            </>
          ) : null}

          {step === 3 ? (
            <>
              <div className="kicker">Step 03</div>
              <h2 className="wiz-title">Create the foundation</h2>
              {/*
                Five errands, five sections (`InitSteps.tsx`). Four of them
                happen in the Tailscale admin console, so the operator leaves
                this tab and comes back: each section says what it is for and
                carries a tick hermetic can prove, rather than a wall of copy
                with one Initialize button at the bottom of it.
              */}
              <TailnetStep
                ts={ts}
                status={tsStatus}
                error={tsError}
                confirmed={tailnetConfirmed}
                onConfirm={setTailnetConfirmed}
                onProbe={probeTailscale}
              />

              {/*
                The mint proves one thing and one thing only: the `tagOwners`
                line landed, because Tailscale will not offer a tag on the OAuth
                client form until the policy owns it. It says nothing about the
                `ssh` and `acls` blocks — hermetic writes those itself during
                init, and whether it may is `policy_scope`, not the mint. So the
                tick reads "tag owned", never "done".
              */}
              <PolicyStep
                acl={acl}
                showWholePolicy={showWholePolicy}
                onShowWholePolicy={setShowWholePolicy}
                managePolicy={managePolicy}
                onManagePolicy={setManagePolicy}
                tagOwned={oauthStatus === "done" && oauth?.ok === true}
                scope={oauth?.policy_scope ?? null}
              />

              {/*
                Done when the client has *proved* itself, not when a box has
                text in it: an unverified paste is exactly the state this tick
                exists to distinguish.
              */}
              <OauthClientStep done={oauthStatus === "done" && oauth?.ok === true} />

              <CertificatesStep ts={ts} onRecheck={probeTailscale} />

              <ClientSecretStep
                secret={secret}
                status={oauthStatus}
                says={oauthSays}
                done={secret !== "" && oauthStatus === "done" && oauth?.ok === true}
                onSecret={(value, verify) => {
                  setSecret(value);
                  // Any edit invalidates the verdict for the old value.
                  setOauth(null);
                  setOauthError(null);
                  setOauthStatus(verify ? "processing" : "idle");
                  if (verify) verifyOauth(value);
                }}
                onVerify={() => verifyOauth()}
              />

              <NetworkStep network={network} onNetwork={setNetwork} />

              <div className="infobox" style={{ marginTop: 4 }}>
                <span className="k">region</span>
                <span>{region || "—"} · frozen with this home</span>
                <span className="k">account</span>
                <span>{identity?.account_id ?? "—"}</span>
              </div>

              {failure ? <div className="wiz-error mono">{failure}</div> : null}

              <div className="wiz-foot">
                <button type="button" className="btn btn-secondary wiz-cta" onClick={() => back(2)}>
                  Back
                </button>
                <button
                  type="button"
                  className="btn btn-primary wiz-cta"
                  disabled={!canInitialize}
                  style={{ opacity: canInitialize ? 1 : 0.35 }}
                  title={initBlockedReason ?? undefined}
                  onClick={() => void run()}
                >
                  Initialize →
                </button>
              </div>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <div className="kicker">Step 04</div>
              <h2 className="wiz-title">
                {initError
                  ? "Init failed"
                  : op.finished
                    ? op.ok
                      ? "Home bound"
                      : "Init failed"
                    : "Initializing…"}
              </h2>
              {initError ? (
                <div className="wiz-foot">
                  <span className="wiz-error mono">{`${initError.code}: ${initError.message}`}</span>
                  <button
                    type="button"
                    className="btn btn-secondary wiz-cta"
                    onClick={() => back(attaching ? 2 : 3)}
                  >
                    Back
                  </button>
                </div>
              ) : (
                <>
                  <div className="wiz-progress">
                    <OpProgress
                      title={shownAccountId ?? "—"}
                      sub={`${attaching ? "attach" : "create"} · ${shownProfile ?? "—"} · ${shownRegion || "—"}${attaching ? "" : ` · ${tailnet}`}`}
                      op={op}
                    />
                  </div>
                  {/*
                    The same reassurance the create drawer gives, for the longer
                    wait: a foundation create is minutes of CloudFormation, and
                    an operator who does not know the op survives the tab will
                    sit and watch it rather than getting on with something else.
                  */}
                  {op.finished ? null : (
                    <div className="wiz-note" style={{ marginTop: 12 }}>
                      {SAFE_TO_CLOSE}; reopening this page reattaches to it.
                    </div>
                  )}
                  {op.finished && op.ok ? (
                    <div className="wiz-foot">
                      <span className="wiz-done">
                        Bound to {identity?.alias ?? shownProfile} · {shownAccountId} · {shownRegion}
                        {waiting ? " · waiting for the local config…" : ""}
                      </span>
                      <button
                        type="button"
                        className="btn btn-primary wiz-cta"
                        disabled={!ready}
                        style={{ opacity: ready ? 1 : 0.35 }}
                        onClick={onOpenFleet}
                      >
                        Open fleet →
                      </button>
                    </div>
                  ) : null}
                  {op.finished && !op.ok ? (
                    <div className="wiz-foot">
                      <span className="wiz-error mono">
                        {op.error ? `${op.error.code}: ${op.error.message}` : "the op failed"}
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary wiz-cta"
                        onClick={() => back(attaching ? 2 : 3)}
                      >
                        Back
                      </button>
                    </div>
                  ) : null}
                </>
              )}
              {failure ? <div className="wiz-error mono">{failure}</div> : null}
            </>
          ) : null}
        </div>
      </div>
      <div className="wiz-tail mono">
        {meta?.home ? `home: ${meta.home}` : ""} · engine: local · same core as `hermetic` CLI
      </div>
    </div>
  );
}
