/**
 * The step-2 connection check (§ product change: moved off step 1). Runs
 * `POST /api/init/identity` for the chosen profile/region and renders one of
 * three states in a single fixed-chrome panel so the layout never jumps:
 * processing (pulsing square + indeterminate sweep + a skeleton of the
 * identity card), confirmed (the real identity card + foundation line), or
 * error (log-style error box + retry/back).
 */
import type { InitFoundation, InitIdentity } from "../api/index.ts";
import { ScanBar, ScanSquare, Skel } from "./Loading.tsx";

export type CheckStatus = "processing" | "confirmed" | "error";

export function ConnectionCheck({
  status,
  profile,
  region,
  identity,
  foundation,
  error,
  attaching,
  credLine,
  onRetry,
  onBack,
}: {
  status: CheckStatus;
  profile: string;
  region: string;
  identity: InitIdentity | null;
  foundation: InitFoundation | null;
  error: { code: string; message: string } | null;
  attaching: boolean;
  credLine: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <div className="check-panel">
      <div className="check-head">
        {status === "processing" ? (
          <ScanSquare />
        ) : (
          <i
            className="check-square"
            style={{ background: status === "confirmed" ? "var(--ok)" : "var(--bad)" }}
          />
        )}
        <div className="check-title">
          {status === "processing"
            ? "Connecting"
            : status === "confirmed"
              ? "Connected"
              : "Could not connect"}
        </div>
      </div>

      {status === "processing" ? (
        <>
          <div className="check-subline mono">
            sts get-caller-identity · profile {profile} · {region || "—"}
          </div>
          <ScanBar />
          <div className="check-skel">
            <Skel w="45%" h={30} />
            <Skel w="70%" />
            <Skel w="55%" />
          </div>
          <div className="check-hint mono">An SSO profile may open a browser login.</div>
        </>
      ) : null}

      {status === "confirmed" && identity ? (
        <div className="check-fade">
          <div className="ident-card">
            <div className="kicker">Account</div>
            <div className="ident-id mono">{identity.account_id}</div>
            <div className="kv" style={{ marginTop: 14 }}>
              <span className="k">alias</span>
              <span className="v">{identity.alias ?? "—"}</span>
              <span className="k">caller</span>
              <span className="v">{identity.arn}</span>
              <span className="k">org id</span>
              <span className="v">{identity.org_id ?? "—"}</span>
              <span className="k">profile</span>
              <span className="v">{credLine}</span>
              <span className="k">region</span>
              <span className="v">{region || "—"}</span>
            </div>
          </div>
          <div
            className={attaching ? "found-line attach" : "found-line create"}
            style={{ marginTop: 16 }}
          >
            {attaching
              ? `Foundation \`hermetic\` found · fleet ${foundation?.fleet_id ?? "—"} · ${foundation?.region ?? region} → will ATTACH`
              : `No foundation in ${region || "this region"} → will CREATE one (CloudFormation stack \`hermetic\`)`}
          </div>
        </div>
      ) : null}

      {status === "error" && error ? (
        <>
          <div className="check-error-box mono">
            {error.code} · {error.message}
          </div>
          <div className="check-actions">
            <button type="button" className="btn btn-primary wiz-cta" onClick={onRetry}>
              Retry
            </button>
            <button type="button" className="btn btn-secondary wiz-cta" onClick={onBack}>
              Back
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
