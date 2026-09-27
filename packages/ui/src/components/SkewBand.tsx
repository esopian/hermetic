/**
 * The §6.6 version-skew band: one component, two scopes.
 *
 * Above the fleet it is about the fleet; inside an agent's drawer it is about
 * that agent. Both render the same generic sentence and offer the same one fix,
 * because the fix for a skewed fleet is the same command whichever screen the
 * operator noticed it on — and a per-agent button that did something *else*
 * would imply hermetic can re-apply a config to a running box on demand, which
 * it cannot (`foundation.update`'s rollout is the delivery path that exists).
 *
 * What it deliberately does not do is list what is affected. That list would
 * have to be rewritten at every `FOUNDATION_VERSION` bump and would read as a
 * promise about everything absent from it; the numbers, the per-agent list in
 * Settings and `hermetic doctor` are where detail belongs.
 */
import { useState } from "react";
import type { Band, SkewStatusView } from "../logic/skew-logic.ts";
import { agentBand, dismissKey, fleetBand } from "../logic/skew-logic.ts";

function BandBody({
  band,
  fleetId,
  onFix,
  onDetails,
}: {
  band: Band;
  /** The `fleet_id`, so two aliasless fleets do not share one dismissal (§4.6). */
  fleetId?: string | null;
  onFix?: () => void;
  onDetails?: () => void;
}) {
  const [dismissed, setDismissed] = useState(() => {
    if (!band.dismissible) return false;
    try {
      return sessionStorage.getItem(dismissKey(fleetId, "degraded")) === "1";
    } catch {
      return false;
    }
  });

  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(dismissKey(fleetId, "degraded"), "1");
    } catch {
      /* A browser refusing storage is not a reason to keep the band up. */
    }
  };

  /**
   * Dismissed is not gone. The strip keeps the fact on screen in one line and
   * cannot itself be dismissed — an operator who put the band away asked for
   * less noise, not to stop being told which fleet they are acting on.
   */
  if (dismissed) {
    return (
      <div className="skew-strip mono">
        <i className={`sq skew-dot ${band.tone}`} />
        <span>{band.headline}</span>
        <button type="button" className="skew-strip-link" onClick={() => setDismissed(false)}>
          show detail
        </button>
      </div>
    );
  }

  return (
    <div className={`skew-band ${band.tone}`} role="status">
      <i className={`sq skew-dot ${band.tone}`} />
      <div className="skew-text">
        <b>{band.headline}</b>
        <p>{band.message}.</p>
      </div>
      <div className="skew-acts">
        {band.dismissible ? (
          <button
            type="button"
            className="skew-x"
            title="Dismiss for this session"
            aria-label="Dismiss for this session"
            onClick={dismiss}
          >
            ✕
          </button>
        ) : null}
        {band.fix && onFix ? (
          <button type="button" className="btn btn-primary skew-btn" onClick={onFix}>
            Update foundation…
          </button>
        ) : null}
        {onDetails ? (
          <button type="button" className="btn skew-btn" onClick={onDetails}>
            Details
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The fleet-wide band. Renders nothing at all when the fleet is not skewed. */
export function SkewBand({
  status,
  fleetId,
  onFix,
  onDetails,
}: {
  status: SkewStatusView | null | undefined;
  /** The `fleet_id`, so two aliasless fleets do not share one dismissal (§4.6). */
  fleetId?: string | null;
  onFix?: () => void;
  onDetails?: () => void;
}) {
  const band = fleetBand(status);
  if (!band) return null;
  return (
    <div className="skew-wrap">
      <BandBody
        band={band}
        fleetId={fleetId}
        {...(onFix ? { onFix } : {})}
        {...(onDetails ? { onDetails } : {})}
      />
    </div>
  );
}

/** The same band, narrowed to one agent, for the drawer. Never dismissible. */
export function AgentSkewBand({
  status,
  name,
  onFix,
}: {
  status: SkewStatusView | null | undefined;
  name: string;
  onFix?: () => void;
}) {
  const band = agentBand(status, name);
  if (!band) return null;
  return <BandBody band={band} {...(onFix ? { onFix } : {})} />;
}
