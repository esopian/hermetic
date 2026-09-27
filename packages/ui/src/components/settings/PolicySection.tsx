/**
 * §4.7's read half: what the tailnet policy says about hermetic today, and the
 * one door to the write — a plan and an `apply`, like every other destructive
 * change, so the page's only action opens a drawer that shows the diff first.
 *
 * Next to the OAuth client on the Account section by subject, if not by page:
 * the client is what hermetic writes the policy with, and a client without the
 * Policy File scope is the whole reason this page can only report.
 */
import { useCallback, useEffect, useState } from "react";
import { getPolicy } from "../../api/index.ts";
import type { PolicyReport } from "../../api/index.ts";
import { PlanSkeleton } from "../Loading.tsx";
import { PolicyDrawer } from "../PolicyDrawer.tsx";
import { Block, Callout, Facts, Row, SettingsPage, Sq } from "./Section.tsx";
import type { SqTone } from "./Section.tsx";

/** What the fleet's OAuth client may do with the policy file, in one line. */
export function scopeLine(scope: PolicyReport["scope"]): string {
  switch (scope) {
    case "write":
      return "read and write — hermetic can keep its blocks current";
    case "read":
      return "read only — hermetic can see the policy but not write it";
    case "none":
      return "none — this client was created without the Policy File scope";
  }
}

/**
 * The file's verdict. `unavailable` is deliberately not quiet: an unread policy
 * and a clean one look identical from here, and only one of them is fine — the
 * same rule `doctor`'s device list follows.
 */
export function managedLine(managed: PolicyReport["managed"]): { text: string; color: string } {
  switch (managed) {
    case "current":
      return { text: "current — the policy says what hermetic would say", color: "var(--ok)" };
    case "absent":
      return { text: "absent — hermetic's blocks are not in the policy", color: "var(--warn)" };
    case "drifted":
      return {
        text: "drifted — the policy differs from what hermetic would write",
        color: "var(--warn)",
      };
    case "unavailable":
      return {
        text: "unavailable — the policy could not be read, so nobody has looked",
        color: "var(--warn)",
      };
  }
}

const BLOCK_TONE: Record<PolicyReport["blocks"][number]["state"], SqTone> = {
  current: "ok",
  absent: "warn",
  drifted: "warn",
  skipped: "off",
};

const DESC = "The tailnet ACL blocks hermetic manages, and whether the policy file still says them.";

/**
 * The whole page for one report, split out of the view and exported so each
 * state can be rendered in a test from a canned report, rather than by mocking
 * three fetches.
 */
export function PolicyPanel({
  report,
  error,
  onPreview,
}: {
  /** `null` while the first read is still out — never rendered as "clean". */
  report: PolicyReport | null;
  error: string | null;
  onPreview: () => void;
}) {
  if (error || report === null) {
    return (
      <SettingsPage section="policy" scope="fleet" desc={DESC}>
        {error ? (
          <div className="wiz-error mono">{error}</div>
        ) : (
          <PlanSkeleton label="reading the tailnet policy…" />
        )}
      </SettingsPage>
    );
  }

  const managed = managedLine(report.managed);
  const changeable = report.managed === "drifted" || report.managed === "absent";
  const scopeTone = report.scope === "write" ? "ok" : "warn";
  return (
    <SettingsPage
      section="policy"
      scope="fleet"
      desc={DESC}
      primary={
        <button
          type="button"
          className="btn btn-primary"
          disabled={!changeable}
          title={changeable ? undefined : managed.text}
          onClick={onPreview}
        >
          Preview change…
        </button>
      }
    >
      <Block title="Status">
        <Facts
          items={[
            { k: "Client scope", v: report.scope, tone: scopeTone },
            {
              k: "Hermetic's blocks",
              v: report.managed,
              tone: report.managed === "current" ? "ok" : "warn",
            },
            { k: "Blocks", v: String(report.blocks.length) },
          ]}
        />
        <div className="kv">
          <Row k="client scope" v={scopeLine(report.scope)} mono />
          <Row k="hermetic's blocks" v={managed.text} mono />
          <Row k="etag" v={report.etag ?? "—"} mono />
        </div>
        {/* One callout, and it points at what to do. An unread policy is named
            as unread before anything else, because it is the one state that
            looks like good news from here. */}
        {report.managed === "unavailable" ? (
          <Callout tone="warn">
            The fleet&apos;s OAuth client lacks <span className="mono">policy_file:read</span>, so
            hermetic cannot tell what the policy file says — this is not a clean bill. Create a client
            with Policy File → Read, Write and rotate it:{" "}
            <span className="mono">hermetic secrets push _fleet --tailscale-oauth</span>.
          </Callout>
        ) : report.scope !== "write" ? (
          <Callout tone="info">
            To let hermetic write these blocks, create an OAuth client with Policy File → Read, Write
            and rotate it: <span className="mono">hermetic secrets push _fleet --tailscale-oauth</span>.
            Tailscale cannot add a scope to an existing client.
          </Callout>
        ) : changeable ? (
          <Callout tone="warn">
            The policy no longer says what hermetic would write. Preview the change to see the diff
            before anything is applied.
          </Callout>
        ) : null}
      </Block>

      <Block title="Managed blocks">
        <table className="st-list">
          <thead>
            <tr>
              <th aria-label="State" />
              <th>Block</th>
              <th>State</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {report.blocks.map((b) => (
              <tr key={b.key}>
                <td className="st-c-sq">
                  <Sq tone={BLOCK_TONE[b.state]} />
                </td>
                <td>
                  <b className="mono">&quot;{b.key}&quot;</b>
                </td>
                <td className="mono st-cell-sm">{b.state}</td>
                <td className="st-cell-sm">{b.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Block>
    </SettingsPage>
  );
}

export function PolicySection() {
  const [report, setReport] = useState<PolicyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);

  /**
   * The one read of `/api/policy`, shared by the first paint and by the refresh
   * a finished apply asks for. It reaches api.tailscale.com through the server,
   * so it is deliberately not on the fleet's tick — and since Settings is a
   * section at a time, it does not even happen until this section is opened.
   */
  const load = useCallback(() => {
    setError(null);
    getPolicy()
      .then(setReport)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <PolicyPanel report={report} error={error} onPreview={() => setDrawer(true)} />
      {drawer && report ? (
        <PolicyDrawer report={report} onClose={() => setDrawer(false)} onApplied={load} />
      ) : null}
    </>
  );
}
