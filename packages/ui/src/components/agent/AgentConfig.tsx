/**
 * The Config section: what the agent *is*, as opposed to how it is doing. The
 * Hermes provider profile and model (the one editable panel here,
 * `AgentProfilePanel`), the Hermes settings hermetic holds, the Tailscale node,
 * every id and version of the instance, and the Hermes Desktop gateway
 * credentials an operator asks for when pairing Desktop with this box (§7.4).
 */
import type { AgentView, Meta } from "../../api/index.ts";
import type { ProfilesState } from "../../state/state.tsx";
import {
  agentCost,
  ec2InstanceConsoleUrl,
  fmtDate,
  heartbeatAge,
  hostname,
  isBehind,
  providerOption,
  uptime,
  versionColor,
} from "../../logic/format.ts";
import {
  configHashView,
  configOf,
  foundationMark,
  hermesRunningNote,
  hermeticdMark,
} from "../../logic/skew-logic.ts";
import { AgentProfilePanel } from "../AgentProfilePanel.tsx";
import { CopyId } from "../primitives.tsx";
import type { RunOp } from "./AgentLifecycle.tsx";
import { Breakable, CfgGroup, CfgRow, CfgRows, Dim } from "./config-parts.tsx";
import type { useDesktopAttach } from "./useDesktopAttach.ts";
import { useSshCommand } from "./useSshCommand.ts";

/**
 * `HERMES_DEFAULTS.approvals_mode` (`packages/core/src/schema/hermes.ts`),
 * restated rather than imported because the UI may not import core (§3.1).
 *
 * A second copy of a default is exactly the kind of thing that drifts once and
 * is never noticed, so it is guarded rather than trusted:
 * `packages/ui/test/agent-drawer.test.ts` sits outside the import-boundary
 * test's scope — that test parses each package's own `src` tree and nothing
 * else — and imports the real constant to assert the two still say the same
 * word.
 */
export const APPROVALS_DEFAULT = "off";

/**
 * §6.4's approvals mode for this agent, resolved the way `splitHermesSettings`
 * resolves it: the setting stated on the row, else the fleet's answer frozen
 * onto the row at create time, else this build's default.
 *
 * The last step is not belt-and-braces. `resolveCreateDefaults` writes only
 * what `settings.agent_defaults` actually stated into `seed`, so a fleet that
 * never named a mode leaves `seed.approvals_mode` genuinely absent on every
 * agent it ever created — which is most of them.
 */
function approvalsMode(agent: AgentView): string {
  return agent.hermes?.approvals_mode ?? agent.seed?.approvals_mode ?? APPROVALS_DEFAULT;
}

export function AgentConfig({
  agent,
  meta,
  latest,
  tailnet,
  fleetId,
  profiles,
  busy,
  onRunOp,
  desktop,
  onOpenTerminal,
}: {
  agent: AgentView;
  meta: Meta | null;
  latest: string | null;
  tailnet: string;
  fleetId: string | null;
  /** §8.3's profiles, read once by `App` — the binding panel names them. */
  profiles: ProfilesState;
  busy: boolean;
  onRunOp: RunOp;
  /** `useDesktopAttach`, owned by the drawer so a revealed token dies with the agent switch. */
  desktop: ReturnType<typeof useDesktopAttach>;
  /** The Terminal section, for the `ssh` row's `Open terminal →`. */
  onOpenTerminal?: () => void;
}) {
  const host = hostname(agent.name, tailnet, agent.tailscale_dns_name, fleetId);
  const ssh = useSshCommand(agent.name, host);
  /** §6.6: the marks that qualify this agent's own versions (`skew-logic.ts`). */
  const fMark = foundationMark(meta?.foundation);
  const hdMark = hermeticdMark(meta?.foundation, agent.name);
  const cfgVerdict = configOf(meta?.foundation, agent.name);
  /**
   * Which hash this panel shows and what it says about it. A box that has
   * reported nothing gets no hash rather than the fleet's rendered one dressed
   * up as a report (`configHashView`).
   */
  const cfgHash = configHashView(agent, cfgVerdict);
  /** What the box says it is running, when that is not what the row pins. */
  const hermesRunning = hermesRunningNote(agent);
  const behind = isBehind(agent, latest);
  const cost = agentCost(agent);
  const instanceConsoleUrl = ec2InstanceConsoleUrl(agent.instance_id, agent.region);
  const live = agent.display_status !== "destroyed";
  const { attach, attaching, attachError, tokenShown, setTokenShown, doAttach } = desktop;

  return (
    <div className="dr-pane dr-cfg">
      <div className="dr-say">
        <div className="kicker">Config</div>
        <p>Only the provider profile and model change here; the rest is read-only.</p>
      </div>

      {/*
        Two columns only when the drawer is wide enough that no value wraps
        (the maximized drawer); at 840px every group is one column, so the
        label column is the same width all the way down.
      */}
      <div className="cfg-cols">
        <div className="cfg-col">
          {/*
            §8.3: where the model and the key come from is a *profile*, not a
            provider — and it is editable, which the rest of this section is
            not. A staged change and the rollout that applies it are a small
            state machine, which is why it is its own component.
          */}
          <AgentProfilePanel agent={agent} profiles={profiles} busy={busy} onRunOp={onRunOp} />

          <CfgGroup title="Hermes">
            {/*
              What hermetic holds, plus the one setting whose owner is not a
              question. Settings hermetic merely seeded live in the agent's own
              config and are the agent's to change, so reporting them from the
              row would be reporting a value that may no longer be true.

              `approvals` is the exception, and it earns it by being seed-only
              (`SEED_ONLY` in `schema/hermes.ts`): there is no managed spelling
              of it to be confused with, so the only thing a reader could
              mistake is *whose* value it is, and the line says so outright.
              The CLI prints it too (`cli/src/table.ts`).
            */}
            <CfgRows>
              <CfgRow k="provider">
                {agent.provider}
                <Dim> · {providerOption(agent.provider).env || "instance role"}</Dim>
              </CfgRow>
              <CfgRow k="secrets">{agent.secrets_mode}</CfgRow>
              <CfgRow
                k="approvals"
                sub={
                  <>
                    re-asserted when <code>agent set --approvals</code> moves it
                  </>
                }
              >
                {approvalsMode(agent)}
                <Dim> · seeded — the agent&apos;s to change</Dim>
              </CfgRow>
            </CfgRows>
          </CfgGroup>

          <CfgGroup
            title="Tailscale"
            actions={
              onOpenTerminal ? (
                <button type="button" className="btn btn-secondary btn-mini" onClick={onOpenTerminal}>
                  Open terminal →
                </button>
              ) : null
            }
          >
            <CfgRows>
              <CfgRow k="hostname">
                <span className="cfg-trunc" title={host}>
                  {host}
                </span>
              </CfgRow>
              <CfgRow k="tailnet ip">{agent.tailscale_ip ?? "—"}</CfgRow>
              {/*
                The one version in this drawer hermetic does not choose: the box
                updates its own tailscaled, so this is a reading rather than a
                pin, and an em dash is unknown — never an old release.
              */}
              <CfgRow k="version">{agent.tailscale_version ?? "—"}</CfgRow>
              <CfgRow k="tags">tag:hermetic</CfgRow>
              {/*
                The real command (core's `ssh` argv), not a description of it:
                this is the row an operator copies from when the in-app
                terminal is not what they want.
              */}
              <CfgRow
                k="ssh"
                sub="ACL-scoped · no keypair"
                actions={
                  <button type="button" className="btn btn-secondary btn-mini" onClick={ssh.copy}>
                    {ssh.copied ? "Copied" : "Copy"}
                  </button>
                }
              >
                <span className="dr-ssh-cmd">{ssh.command}</span>
              </CfgRow>
              <CfgRow k="ingress">0 inbound rules</CfgRow>
            </CfgRows>
          </CfgGroup>
        </div>

        <div className="cfg-col">
          <CfgGroup title="Instance">
            <CfgRows>
              <CfgRow k="size">
                {agent.size} · {agent.instance_type}
              </CfgRow>
              <CfgRow k="hermes">
                <span style={{ color: versionColor(agent, latest) }}>
                  {agent.hermes_version}
                  {behind && latest ? ` · behind ${latest}` : ""}
                </span>
                {/*
                  The pin is what a laptop wrote; this is what the box reports
                  running. They differ between `upgrade --hermes` and the
                  recreate that makes it true — a pending recreate, not drift,
                  so it is stated in the quiet colour and never as a warning.
                */}
                {hermesRunning ? <Dim> {hermesRunning}</Dim> : null}
              </CfgRow>
              {/*
                The two §6.6 axes that are this agent's own, spelled beside the
                values they qualify rather than only inside the band: a mark is
                part of the value, and stays once the band is put away.
              */}
              <CfgRow k="hermeticd">
                {agent.hermeticd_version ?? "—"}
                {hdMark ? <span className="skew-mark"> {hdMark}</span> : null}
              </CfgRow>
              <CfgRow k="foundation">
                {meta?.foundation ? `v${meta.foundation.fleet.foundation_version}` : "—"}
                {fMark ? <span className="skew-mark"> {fMark}</span> : null}
              </CfgRow>
              <CfgRow k="config">
                {cfgHash.value}
                {cfgHash.warn ? (
                  <span className="skew-mark"> {cfgHash.note}</span>
                ) : (
                  <Dim> {cfgHash.note}</Dim>
                )}
              </CfgRow>
              <CfgRow k="data disk">{agent.volume_gib} GiB gp3</CfgRow>
              {/*
                The one place the size is a *decision* rather than a reading, so
                it is the one place that names the flag which changes it. A row
                created before the root disk was sizeable says so rather than
                printing today's default.
              */}
              <CfgRow k="system disk">
                {agent.root_gib ? `${agent.root_gib} GiB gp3` : "not recorded"}
                <Dim> · --root-gib, applied by the next rebuild</Dim>
              </CfgRow>
              <CfgRow k="uptime">
                {uptime(agent, Date.now())}
                <Dim> · heartbeat {heartbeatAge(agent)}</Dim>
              </CfgRow>
              <CfgRow
                k="created"
                sub={agent.created_by ? <Breakable text={`by ${agent.created_by}`} /> : null}
              >
                {fmtDate(agent.created_at)}
              </CfgRow>
              <CfgRow k="region">{agent.region}</CfgRow>
              <CfgRow k="instance id">
                {/*
                  A link to the EC2 console, drawn in the value's own colour:
                  the accent is brand and activity, and an id is neither.
                */}
                {instanceConsoleUrl ? (
                  <a
                    className="cfg-link"
                    href={instanceConsoleUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    title="Open in the EC2 console"
                  >
                    {agent.instance_id} ↗
                  </a>
                ) : (
                  (agent.instance_id ?? "—")
                )}
              </CfgRow>
              <CfgRow k="volume id">{agent.volume_id ?? "—"}</CfgRow>
              <CfgRow k="cost">
                <b>{cost.monthly}</b>
                <Dim> · {cost.hourly}</Dim>
              </CfgRow>
            </CfgRows>
          </CfgGroup>

          {/*
            §7.4: what Desktop's remote-gateway form asks for, fetched only when
            the operator asks — it reaches the box over the tailnet. The address
            is plain, it is on the row already; the token is masked behind a
            reveal, because a drawer can stay open on a shared screen for a long
            time and nothing here needs the value to be *read*, only copied.
          */}
          {live ? (
            <CfgGroup
              title="Hermes Desktop gateway"
              actions={
                <button
                  type="button"
                  className="btn btn-secondary btn-mini"
                  disabled={attaching}
                  title="The address and session token Hermes Desktop's remote-gateway form asks for (§7.4)"
                  onClick={() => void doAttach()}
                >
                  {attaching ? "Asking the box…" : "Connect Desktop"}
                </button>
              }
            >
              {!attach && !attachError ? (
                <div className="hint">
                  Asks the box for the address and token Desktop&apos;s remote-gateway form needs.
                </div>
              ) : null}
              {attachError ? (
                <div className="wiz-error mono" role="alert">
                  Desktop details failed — {attachError}
                </div>
              ) : null}
              {attach ? (
                <div className="desktop-attach" aria-live="polite">
                  <CfgRows>
                    <CfgRow k="remote address">
                      <CopyId id={attach.url} className="mono" />
                    </CfgRow>
                    <CfgRow
                      k="session token"
                      actions={
                        <button
                          type="button"
                          className="btn btn-secondary btn-mini"
                          onClick={() => setTokenShown((shown) => !shown)}
                        >
                          {tokenShown ? "Hide" : "Reveal"}
                        </button>
                      }
                    >
                      <CopyId
                        id={attach.token}
                        label={tokenShown ? attach.token : "•".repeat(12)}
                        className="mono"
                      />
                    </CfgRow>
                  </CfgRows>
                  <div className="desktop-note">
                    Settings → Gateways in Hermes Desktop (or a profile’s “Connect to a remote host…”):
                    paste the address into “Remote address” and the token into “Session token”.
                    Desktop’s connection test passes without a token and the real connection does not,
                    so both are required.
                  </div>
                  {attach.rotates ? (
                    <div className="desktop-note">
                      The token dies with the box’s dashboard process — a reboot, a rebuild, an apply or
                      a Hermes update mints a new one. Ask again when Desktop says the host rejected the
                      saved token.
                    </div>
                  ) : null}
                </div>
              ) : null}
            </CfgGroup>
          ) : null}
        </div>
      </div>
    </div>
  );
}
