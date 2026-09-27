/**
 * §6.6, the read half: what the fleet is on, what this build would apply, and —
 * because a foundation update is the stack *and* the hermeticd release — where
 * every agent's own version has got to. The header's button is the only way
 * into the update drawer that is not the CLI.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { networkStatus } from "../../api/index.ts";
import type { FoundationStatus, Meta, NetworkReport } from "../../api/index.ts";
import { otherFleetsNeedingUpdate } from "../../nav/fleet-switch.ts";
import { bedrockGrantLine, grantNeedsUpdate, hermesLine } from "../../logic/foundation-logic.ts";
import { networkFactRows, networkModeLine, renetworkAvailable } from "../../logic/network-logic.ts";
import { configLabel, fleetBand } from "../../logic/skew-logic.ts";
import { NetworkDrawer } from "../NetworkDrawer.tsx";
import { fmtDate } from "../../logic/format.ts";
import { useFleetIfAvailable } from "../../state/state.tsx";
import { Block, Callout, Facts, Row, SettingsPage, Sq, Tally, TextAction } from "./Section.tsx";
import type { SqTone } from "./Section.tsx";

const DESC = "The shared AWS stack under every agent: network, roles, buckets, the image.";

/**
 * §4.8: the directory records every fleet's `foundation_version`, so this page
 * can say that the *other* fleets are behind without opening any of them. One
 * line, and each name is a switch — the update itself only ever runs against
 * the fleet the portal is pointed at, so getting there is the first step of
 * doing anything about it.
 *
 * The switch confirms in place, the same rule the header switcher follows: no
 * `window.confirm`, and no fleet moves under an operator who only clicked a
 * name in a sentence.
 */
function OtherFleetsBehind() {
  const fleet = useFleetIfAvailable();
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No provider means no fleet list and no way to switch, so there is nothing
  // to offer. Returning here rather than rendering a button bound to an
  // optional call is the point: `await fleet?.switchTo(name)` on a null context
  // resolves `undefined`, which is indistinguishable from a switch that worked
  // — the confirm would close and the operator would be told nothing.
  if (fleet === null) return null;
  const names = otherFleetsNeedingUpdate(fleet.fleets ?? []);
  if (names.length === 0) return null;

  const go = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      await fleet.switchTo(name);
      setPending(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Block title="Other fleets">
      <Callout tone="warn">
        <div className="mono">
          {names.length} other fleet{names.length === 1 ? "" : "s"} need a foundation update:{" "}
          {names.map((n, i) => (
            <span key={n}>
              {i === 0 ? "" : ", "}
              <button
                type="button"
                className="fleet-sw-link"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setPending(n);
                }}
              >
                {n}
              </button>
            </span>
          ))}
        </div>
        {pending === null ? null : (
          <div className="fleet-sw-confirm">
            <div className="fleet-sw-confirm-line mono">Switch to {pending}?</div>
            {error === null ? null : <div className="fleet-sw-error mono">{error}</div>}
            <div className="fleet-sw-confirm-actions">
              <button
                type="button"
                className="fleet-sw-go"
                disabled={busy}
                onClick={() => void go(pending)}
              >
                {busy ? "Switching…" : "Switch target"}
              </button>
              <button
                type="button"
                className="fleet-sw-cancel"
                disabled={busy}
                onClick={() => {
                  setPending(null);
                  setError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </Callout>
    </Block>
  );
}

/**
 * The status block's one callout: the most urgent thing that is true, pointing
 * at the header's button rather than carrying one. A running update outranks
 * everything (nothing else can be done until it lets go of the lock); then
 * §6.6's skew, in core's own words; then an available version; then §8.3's
 * grant, which is a reason to update on its own.
 */
function statusCallout(foundation: FoundationStatus, grantStale: boolean): ReactNode {
  const inProgress = foundation.in_progress;
  if (inProgress) {
    return (
      <Callout tone="warn">
        <span className="mono">
          a foundation update is running now — locked by {inProgress.owner} until{" "}
          {fmtDate(inProgress.expires)}
        </span>
      </Callout>
    );
  }
  const band = fleetBand(foundation);
  if (band) {
    return (
      <Callout tone={band.tone === "bad" ? "bad" : band.tone === "warn" ? "warn" : "info"}>
        <b>{band.headline}.</b> {band.message}
        {band.fix ? (
          <>
            {" "}
            <span className="mono">{band.fix}</span>
          </>
        ) : null}
      </Callout>
    );
  }
  if (foundation.update_available) {
    return (
      <Callout tone="warn">
        <b>v{foundation.available.foundation_version} is available.</b> Update foundation… shows the
        plan before anything changes; running agents keep running.
      </Callout>
    );
  }
  if (grantStale) {
    return (
      <Callout tone="warn">
        The instance role&apos;s model grant is behind the profiles that name it. Update foundation…
        adds it; nothing is substituted in the meantime.
      </Callout>
    );
  }
  return null;
}

export function FoundationPanel({
  foundation,
  network,
  networkError,
  onOpenUpdate,
  onOpenNetwork,
  children,
}: {
  foundation: FoundationStatus | null | undefined;
  /**
   * `/api/network`, or `null` while the read is out. Never rendered as a mode:
   * the recorded mode comes off `_fleet` in `foundation`, and this report is
   * the reconciliation and the NAT appliance beside it.
   */
  network?: NetworkReport | null;
  networkError?: string | null;
  onOpenUpdate: () => void;
  onOpenNetwork?: () => void;
  /** Blocks the section adds below the panel's own (the other fleets). */
  children?: ReactNode;
}) {
  if (!foundation) {
    return (
      <SettingsPage section="foundation" scope="fleet" desc={DESC}>
        <div className="st-hint mono">
          not reported by this server build, or the _fleet item could not be read
        </div>
        {children}
      </SettingsPage>
    );
  }
  const inProgress = foundation.in_progress;
  const hermes = hermesLine(foundation.hermes);
  const mode = networkModeLine(foundation.fleet.network);
  const grant = bedrockGrantLine(foundation.stale_bedrock_grants);
  /**
   * §8.3: the grant is a second, independent reason to run an update. A fleet
   * on the current foundation whose role may not invoke a model it names is not
   * "up to date" in any sense an operator cares about, so it neither reads as
   * such nor leaves the button disabled.
   */
  const grantStale = grantNeedsUpdate(foundation.stale_bedrock_grants);
  const actionable = foundation.update_available || grantStale;
  const verdict = foundation.tool_outdated
    ? "this hermetic build is older than the fleet's foundation — upgrade hermetic"
    : foundation.update_available
      ? "an update is available"
      : grantStale
        ? "the foundation is current, but its Bedrock grant is not"
        : "up to date";
  const renetwork = renetworkAvailable({
    report: network ?? null,
    updateInProgress: inProgress !== null,
  });

  const agents = foundation.agents;
  const tone = (a: (typeof agents)[number]): SqTone =>
    // Three states, not two: `current === null` is "this box has reported no
    // version", which is neither good news nor a warning.
    a.current === null ? "off" : a.current ? "ok" : "warn";
  const current = agents.filter((a) => a.current === true).length;
  const behind = agents.filter((a) => a.current === false).length;
  const unknown = agents.filter((a) => a.current === null).length;

  return (
    <SettingsPage
      section="foundation"
      scope="fleet"
      desc={DESC}
      primary={
        <button
          type="button"
          className="btn btn-primary"
          disabled={!actionable || inProgress !== null}
          title={actionable ? undefined : verdict}
          onClick={onOpenUpdate}
        >
          Update foundation…
        </button>
      }
    >
      <Block title="Status">
        <Facts
          items={[
            { k: "Fleet version", v: `v${foundation.fleet.foundation_version}` },
            {
              k: "Available",
              v: `v${foundation.available.foundation_version}`,
              tone: foundation.update_available ? "warn" : undefined,
            },
            { k: "Ubuntu release", v: foundation.fleet.ubuntu_release },
            { k: "hermeticd", v: foundation.fleet.hermeticd_version },
          ]}
        />
        <div className="kv">
          <Row
            k="foundation version"
            v={`v${foundation.fleet.foundation_version} → v${foundation.available.foundation_version}`}
            mono
          />
          <Row
            k="template sha256"
            v={`${(foundation.fleet.template_sha256 ?? "—").slice(0, 12)} → ${foundation.available.template_sha256.slice(0, 12)}`}
            mono
          />
          <Row
            k="hermeticd"
            v={`${foundation.fleet.hermeticd_version} → ${foundation.available.hermeticd_version}`}
            mono
          />
          {/*
            The image the fleet was built on, off `_fleet`. One value, not an
            arrow: there is nothing this build "would apply" to compare it with.
          */}
          <Row k="ubuntu release" v={foundation.fleet.ubuntu_release} mono />
          <Row k="ami id" v={foundation.fleet.ami_id} mono />
          {/*
            §8.3's three answers, in the same place `hermetic foundation status`
            prints them: the models this fleet's instance role may not invoke,
            an empty comparison, or a grant nothing recorded. Written out rather
            than passed to `Row` because only this row is ever coloured.
          */}
          <span className="k">bedrock grant</span>
          <span className="v mono" style={grant.warn ? { color: "var(--warn)" } : undefined}>
            {grant.text}
          </span>
          <Row k="status" v={verdict} mono />
        </div>
        {statusCallout(foundation, grantStale)}
      </Block>

      {/*
        §5's re-network, beside the update rather than inside it: rolling a
        release forward and re-architecting the fleet's egress are different
        blast radii, and `foundation.update` is contractually forbidden from
        redeciding the network. So it is this block's own command, not a second
        primary in the header.
      */}
      <Block
        title="Network"
        right={
          <TextAction
            allowed={
              renetwork.allowed && onOpenNetwork !== undefined
                ? { ok: true }
                : { ok: false, reason: renetwork.reason }
            }
            onClick={() => onOpenNetwork?.()}
          >
            Change network mode…
          </TextAction>
        }
      >
        {/*
          §5: which side of a NAT this fleet's agents live on, off `_fleet`.
          Absence is its own answer — a fleet frozen before the field existed
          records nothing, and showing that as `public` would state a fact
          nobody checked — so `networkModeLine` spells the back-fill instead.
        */}
        <div className="kv">
          <Row k="network mode" v={mode.text} mono />
          {/*
            The compact reconciliation: the stack's answer when it differs, the
            NAT appliance a `nat` fleet's whole egress depends on, and how many
            agents a past mode change left behind. Small on purpose —
            `hermetic doctor` is where these become findings.
          */}
          {network && !networkError
            ? networkFactRows(network).map((f) => (
                <Fragment key={f.k}>
                  <span className="k">{f.k}</span>
                  <span className="v mono" style={f.bad ? { color: "var(--warn)" } : undefined}>
                    {f.v}
                  </span>
                </Fragment>
              ))
            : null}
        </div>
        {mode.unrecorded ? (
          <div className="st-hint mono">
            a foundation update reads the stack&apos;s own Network parameter and writes it back onto
            _fleet
          </div>
        ) : null}
        {networkError ? (
          <div className="st-hint mono">network status unavailable: {networkError}</div>
        ) : null}
      </Block>

      {/*
        §6.6's advisory: what upstream Hermes is on, next to what this build
        pins. Its own block rather than a row of the status above, because
        "Update foundation…" does not apply it — a Hermes bump is a per-agent
        `hermetic upgrade --hermes`, deliberately manual.
      */}
      <Block title="Hermes">
        <div className="kv">
          <Row k="pinned" v={hermes.pinned} mono />
          <Row k="upstream" v={hermes.detail} mono />
        </div>
        {hermes.alert ? (
          <Callout tone="warn">
            <span className="pill-warn" style={{ marginRight: 8 }}>
              hermes update available
            </span>
            <span className="mono">{hermes.hint}</span>
          </Callout>
        ) : null}
      </Block>

      <Block
        title={`hermeticd rollout · ${agents.length} agent${agents.length === 1 ? "" : "s"}`}
        right={
          agents.length === 0 ? null : (
            <>
              <Tally tone="ok">{current} current</Tally>
              {behind > 0 ? <Tally tone="warn">{behind} behind</Tally> : null}
              {unknown > 0 ? <Tally tone="off">{unknown} unreported</Tally> : null}
            </>
          )
        }
      >
        {agents.length === 0 ? (
          <div className="st-hint mono">— no agents —</div>
        ) : (
          <table className="st-list foundation-agents">
            <thead>
              <tr>
                <th aria-label="State" />
                <th>Agent</th>
                <th>hermeticd</th>
                <th>Hermes</th>
                <th>Config</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const config = configLabel(a.config);
                return (
                  <tr key={a.name}>
                    <td className="st-c-sq">
                      <Sq tone={tone(a)} />
                    </td>
                    <td>
                      <b className="mono">{a.name}</b>
                    </td>
                    <td className="mono st-cell-sm">
                      {a.hermeticd_version ?? "—"}{" "}
                      <span className={a.current ? "fa-tag" : "fa-tag behind"}>
                        {a.current ? "current" : "behind"}
                      </span>
                    </td>
                    <td className="mono st-cell-sm">{a.hermes_version ?? "—"}</td>
                    {/*
                      §6.6's config axis: whether this box applied the bundle the
                      fleet rendered for it. The one place the whole fleet's drift
                      is answerable at once, which is why the per-agent drawer does
                      not need a table of its own.
                    */}
                    <td>
                      <span className={config.warn ? "fa-tag behind" : "fa-tag"}>{config.label}</span>
                    </td>
                    <td className="st-cell-sm">{a.status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Block>
      {children}
    </SettingsPage>
  );
}

export function FoundationSection({
  meta,
  onOpenUpdate,
}: {
  meta: Meta | null;
  onOpenUpdate: () => void;
}) {
  const [network, setNetwork] = useState<NetworkReport | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);

  /**
   * The one read of `/api/network`, shared by the first paint and by the
   * refresh a finished re-network asks for. It describes the stack, the NAT
   * instance and every agent's subnet, so like `/api/policy` it is deliberately
   * not on the fleet's tick and does not happen until this section is open.
   */
  const load = useCallback(() => {
    setNetworkError(null);
    networkStatus()
      .then(setNetwork)
      .catch((e: unknown) => setNetworkError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <FoundationPanel
        foundation={meta?.foundation}
        network={network}
        networkError={networkError}
        onOpenUpdate={onOpenUpdate}
        onOpenNetwork={() => setDrawer(true)}
      >
        <OtherFleetsBehind />
      </FoundationPanel>
      {drawer && network ? (
        <NetworkDrawer report={network} onClose={() => setDrawer(false)} onApplied={load} />
      ) : null}
    </>
  );
}
