/**
 * The teardown entry point. The `--bad` fill is reserved for this block — it is
 * the one place in the UI where a red field means "the whole account changes if
 * you press this" (`docs/ui-brief.md`).
 */
import type { LocalConfig } from "../../api/index.ts";
import { SettingsPage } from "./Section.tsx";

export function DangerSection({
  config,
  onOpenTeardown,
}: {
  config: LocalConfig | null;
  onOpenTeardown: () => void;
}) {
  const account = config?.account_id ?? "—";
  const region = config?.region ?? "—";
  // §5: the stack is named for the fleet, so the copy must not say `hermetic` —
  // that is a different fleet's stack, or nobody's.
  const stackName = config?.fleet_id ? `hermetic-${config.fleet_id}` : "the foundation stack";

  return (
    <SettingsPage
      section="danger"
      scope="fleet"
      desc="The one page here that cannot be undone. Everything else in Settings can be set back."
    >
      <div className="danger-block">
        <div className="kicker">Danger</div>
        <h3 className="danger-title">TEAR DOWN THE FOUNDATION</h3>
        <p className="danger-copy">
          Deletes the CloudFormation stack <b className="mono">{stackName}</b> in{" "}
          <b className="mono">{account}</b> / <b className="mono">{region}</b>: VPC, subnets, security
          group, IAM role, S3 bucket, DynamoDB tables and the fleet&apos;s event history. This cannot be
          undone.
        </p>
        {/*
          "Refused while any agent exists" could read as "refused while any
          record exists", which is not what core checks: a destroy deletes the
          row and leaves a tombstone (§6.7), and a fleet of nothing but
          tombstones tears down fine. The distinction matters because the
          alternative reading suggests deleting history to unblock a teardown.
        */}
        <p className="danger-copy">
          Refused while any agent is still <b>live</b> (<span className="mono">AGENTS_EXIST</span>).
          Destroyed agents do not block it: their names are released, and their tombstones and history
          go with the fleet&apos;s tables. Their data volumes are kept unless{" "}
          <span className="mono">--delete-volumes</span> is ticked in the drawer.
        </p>
        <button type="button" className="btn btn-teardown" onClick={onOpenTeardown}>
          Tear down…
        </button>
      </div>
    </SettingsPage>
  );
}
