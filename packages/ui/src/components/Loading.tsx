/**
 * The one loading vocabulary, so every screen that is waiting on the network
 * says it the same way: a pulsing square, an indeterminate sweep, and blocks
 * where the real content will be. Blocks rather than a spinner because this UI
 * is on a 2px grid and a skeleton that keeps the layout's shape is the only
 * loading state that does not make the page jump when the answer lands.
 *
 * The init wizard's connection check invented this vocabulary
 * (`ConnectionCheck.tsx`); this is it factored out and pointed at the fleet,
 * the volume inventory and the plan drawers.
 */
import type { CSSProperties, ReactNode } from "react";
import { fleetPhaseNote, skeletonCount } from "../logic/loading.ts";
import type { FleetPhase } from "../logic/loading.ts";

/** The pulsing square that means "this is still happening". */
export function ScanSquare({ color = "var(--acc)", size = 14 }: { color?: string; size?: number }) {
  return <i className="scan-square" style={{ background: color, width: size, height: size }} />;
}

/** Indeterminate progress: there is no percentage to report, only motion. */
export function ScanBar({ style }: { style?: CSSProperties }) {
  return (
    <div className="sweep" style={style} role="progressbar" aria-label="Loading">
      <i />
    </div>
  );
}

/** One placeholder block, sized as a fraction of its row. */
export function Skel({ w = "100%", h = 13, style }: { w?: string; h?: number; style?: CSSProperties }) {
  return <i className="skel" style={{ width: w, height: h, ...style }} />;
}

/**
 * The banner above a skeleton: what is being read, and from where. The detail
 * line names the call rather than saying "loading", because on a slow account
 * the name of the call is the only actionable thing on screen.
 */
export function ScanHead({
  title,
  detail,
  color = "var(--acc)",
  children,
}: {
  title: string;
  detail?: string;
  color?: string;
  children?: ReactNode;
}) {
  return (
    <div className="scan-head" role="status" aria-live="polite">
      <div className="scan-head-top">
        <ScanSquare color={color} />
        <span className="scan-title">{title}</span>
        {detail ? <span className="scan-detail mono">{detail}</span> : null}
        {children}
      </div>
      <ScanBar />
    </div>
  );
}

/** A one-line "still reading" marker for a panel that already has its chrome. */
export function InlineScan({ label }: { label: string }) {
  return (
    <div className="inline-scan" role="status" aria-live="polite">
      <span className="mono">{label}</span>
      <ScanBar />
    </div>
  );
}

/** What a plan drawer shows while `plan.*` is still being computed. */
export function PlanSkeleton({ label = "reading the plan…" }: { label?: string }) {
  return (
    <div className="plan-skel">
      <InlineScan label={label} />
      <Skel w="72%" />
      <Skel w="88%" />
      <Skel w="55%" />
    </div>
  );
}

/* ── the fleet's first paint ─────────────────────────────────────────────── */

function SkelCard() {
  return (
    <div className="card skel-card" aria-hidden="true">
      <div className="card-top">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Skel w="55%" h={22} />
          <Skel w="72%" h={12} style={{ marginTop: 8 }} />
          <Skel w="46%" h={11} style={{ marginTop: 6 }} />
        </div>
        <Skel w="26px" h={24} style={{ flex: "none" }} />
      </div>
      <Skel w="40%" h={12} />
      <div className="card-foot">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Skel w="38%" h={9} />
          <Skel w="60%" h={12} style={{ marginTop: 8 }} />
        </div>
        <Skel w="52px" h={14} style={{ flex: "none" }} />
      </div>
    </div>
  );
}

function SkelRow() {
  return (
    <div className="trow tbody-row skel-row" aria-hidden="true">
      <Skel w="70%" />
      <Skel w="80%" />
      <Skel w="60%" />
      <Skel w="70%" />
      <Skel w="85%" />
      <Skel w="60%" />
      <Skel w="60%" />
      <Skel w="75%" />
      <Skel w="55%" />
      <Skel w="70%" />
    </div>
  );
}

/**
 * The fleet before its first scan. Deliberately not `EmptyState`: "no agents
 * here" is a claim about the account, and until a scan comes back nobody has
 * looked. The failed branch is the same panel with the error in it and a retry,
 * because a fleet that cannot be read is the one case where the operator has
 * something to do.
 */
export function FleetSkeleton({
  phase,
  layout,
  scanError,
  remembered,
  onRetry,
}: {
  phase: Exclude<FleetPhase, "ready">;
  layout: "board" | "table" | "triage";
  scanError: string | null;
  /** The agent count from the last good scan, so a resync redraws its shape. */
  remembered: number | null;
  onRetry: () => void;
}) {
  const note = fleetPhaseNote(phase, scanError);
  const failed = phase === "failed";
  const n = skeletonCount(remembered);

  if (failed) {
    return (
      <div className="empty">
        <i style={{ background: "var(--bad)", width: 22, height: 22, display: "block" }} />
        <b>Could not read the fleet</b>
        <span className="mono">{note.detail}</span>
        <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  const body =
    layout === "board" ? (
      <div className="board">
        {Array.from({ length: n }, (_, i) => (
          <SkelCard key={i} />
        ))}
      </div>
    ) : (
      <div className="body-scroll">
        <div className="table">
          {Array.from({ length: n }, (_, i) => (
            <SkelRow key={i} />
          ))}
        </div>
      </div>
    );

  return (
    <div className="fleet-skel">
      <ScanHead
        title={note.title}
        detail={note.detail}
        color={phase === "reconnecting" ? "var(--warn)" : "var(--acc)"}
      />
      {body}
    </div>
  );
}

/* ── the volume inventory's first paint ──────────────────────────────────── */

/**
 * Two lanes' worth of shape: the inventory always renders as label + claims.
 * The view's own toolbar stays above this, so the filter does not appear and
 * disappear as the read lands.
 */
export function VolumesSkeleton() {
  return (
    <>
      <ScanHead title="Reading volumes" detail="ec2:DescribeVolumes · ec2:DescribeSnapshots" />
      {[0, 1].map((lane) => (
        <div key={lane} className="lane" aria-hidden="true">
          <div className="lane-label">
            <Skel w="60%" h={10} />
            <Skel w="34px" h={40} style={{ marginTop: 8 }} />
            <Skel w="88%" h={11} style={{ marginTop: 10 }} />
          </div>
          <div className="claims">
            {Array.from({ length: lane === 0 ? 2 : 1 }, (_, i) => (
              <div key={i} className="claim skel-card">
                <Skel w="58%" h={13} />
                <Skel w="40%" h={16} style={{ marginTop: 10 }} />
                <Skel w="86%" h={11} style={{ marginTop: 14 }} />
                <Skel w="70%" h={11} style={{ marginTop: 6 }} />
                <Skel w="100%" h={28} style={{ marginTop: 16 }} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
