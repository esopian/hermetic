/**
 * Settings › Foundation › Snapshots (§7.1): the data-volume snapshot policy
 * the stack runs, how far back it reaches, and how many snapshots the fleet
 * holds — with the block's own command to change it, like the network block
 * beside it, because a policy change is a change to the foundation stack.
 *
 * Read on open and after an apply, never on the fleet's tick: it lists the
 * fleet's EBS snapshots, which is not a call to repeat every few seconds.
 */
import { useCallback, useEffect, useState } from "react";
import { describeSnapshotPolicy, snapshotWindowDays } from "@hermetic/core/shared";
import { snapshotsStatus } from "../../api/index.ts";
import type { SnapshotsReport } from "../../api/index.ts";
import { Block, Row, TextAction } from "./Section.tsx";
import { SnapshotsDrawer } from "./SnapshotsDrawer.tsx";

export function SnapshotsBlock({
  disabledReason,
  behind,
}: {
  disabledReason: string | null;
  /** The fleet's foundation is not this build's: `plan.snapshots` would refuse, so the button does first. */
  behind: boolean;
}) {
  const [report, setReport] = useState<SnapshotsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    setError(null);
    snapshotsStatus()
      .then(setReport)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => load(), [load]);

  const policy = report?.policy ?? null;
  const reason =
    disabledReason ??
    (report === null
      ? "reading the snapshot policy…"
      : policy === null
        ? "update the foundation first: this stack predates configurable snapshots"
        : behind
          ? "update the foundation first: a snapshot change runs this build's template"
          : null);

  return (
    <Block
      title="Snapshots"
      right={
        <TextAction
          allowed={reason === null ? { ok: true } : { ok: false, reason }}
          onClick={() => setOpen(true)}
        >
          Change snapshot policy…
        </TextAction>
      }
    >
      <div className="kv" data-testid="snapshots-block">
        <Row
          k="policy"
          v={
            report === null
              ? "…"
              : policy === null
                ? "daily, keep 7 (fixed on this foundation version)"
                : describeSnapshotPolicy(policy)
          }
          mono
        />
        {policy?.enabled ? (
          <Row k="history" v={`≈${snapshotWindowDays(policy).toFixed(1)} days per volume`} mono />
        ) : null}
        {report !== null ? (
          <Row
            k="held now"
            v={`${report.existing.count} snapshot${report.existing.count === 1 ? "" : "s"} of ${report.existing.volume_gib} GiB volumes`}
            mono
          />
        ) : null}
      </div>
      <div className="st-hint mono">
        EBS bills only the blocks each snapshot changed. Turning snapshots off keeps the ones already
        taken.
      </div>
      {error ? <div className="st-hint mono">snapshot status unavailable: {error}</div> : null}
      {open && report !== null && policy !== null ? (
        <SnapshotsDrawer
          report={report}
          policy={policy}
          onClose={() => setOpen(false)}
          onApplied={load}
        />
      ) : null}
    </Block>
  );
}
