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
import type { useDesktopAttach } from "./useDesktopAttach.ts";

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
}) {
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
    <div className="dr-pane">
      <div className="dr-say">
        <div className="kicker">Config</div>
        <p>
          What {agent.name} is built from. The provider profile and model are the only settings changed
          here; everything else is a reading.
        </p>
      </div>

      {/*
        §8.3: where the model and the key come from is a *profile*, not a
        provider — and it is editable, which the rest of this section is not.
        A staged change and the rollout that applies it are a small state
        machine, which is why it is its own component.
      */}
      <section>
        <AgentProfilePanel agent={agent} profiles={profiles} busy={busy} onRunOp={onRunOp} />
      </section>

      <div className="dr-2col">
        <section>
          <div className="kicker">Hermes</div>
          {/*
            What hermetic holds, plus the one setting whose owner is not a
            question. Settings hermetic merely seeded live in the agent's own
            config and are the agent's to change, so reporting them from the
            row would be reporting a value that may no longer be true.

            `approvals` is the exception, and it earns it by being seed-only
            (`SEED_ONLY` in `schema/hermes.ts`): there is no managed spelling of
            it to be confused with, so the only thing a reader could mistake is
            *whose* value it is, and the line says so outright. The CLI prints
            it too (`cli/src/table.ts`).
          */}
          <div className="kv">
            <span className="k">provider</span>
            <span className="v">
              {agent.provider}
              {providerOption(agent.provider).env
                ? ` · ${providerOption(agent.provider).env}`
                : " · instance role"}
            </span>
            <span className="k">secrets</span>
            <span className="v">{agent.secrets_mode}</span>
            <span className="k">approvals</span>
            <span className="v">
              {approvalsMode(agent)} (seeded — the agent's to change; re-asserted when{" "}
              <code>agent set --approvals</code> moves it)
            </span>
          </div>
        </section>

        <section>
          <div className="kicker">Tailscale</div>
          <div className="kv">
            <span className="k">hostname</span>
            <span className="v">
              {hostname(agent.name, tailnet, agent.tailscale_dns_name, fleetId)}
            </span>
            <span className="k">tailnet ip</span>
            <span className="v">{agent.tailscale_ip ?? "—"}</span>
            {/*
              The one version in this drawer hermetic does not choose: the box
              updates its own tailscaled, so this is a reading rather than a
              pin, and an em dash is unknown — never an old release.
            */}
            <span className="k">version</span>
            <span className="v">{agent.tailscale_version ?? "—"}</span>
            <span className="k">tags</span>
            <span className="v">tag:hermetic</span>
            <span className="k">last seen</span>
            <span className="v">{heartbeatAge(agent)}</span>
            <span className="k">ssh</span>
            <span className="v">tailscale ssh · ACL-scoped</span>
            <span className="k">ingress</span>
            <span className="v">0 inbound rules</span>
          </div>
        </section>
      </div>

      <section>
        <div className="kicker">Instance</div>
        <div className="kv">
          <span className="k">size</span>
          <span className="v">
            {agent.size} · {agent.instance_type}
          </span>
          <span className="k">hermes</span>
          <span className="v" style={{ color: versionColor(agent, latest) }}>
            {agent.hermes_version}
            {behind && latest ? ` · behind ${latest}` : ""}
            {/*
              The pin is what a laptop wrote; this is what the box reports
              running. They differ between `upgrade --hermes` and the recreate
              that makes it true — a pending recreate, not drift, so it is
              stated in the quiet colour and never as a warning.
            */}
            {hermesRunning ? <span style={{ color: "var(--fg3)" }}> {hermesRunning}</span> : null}
          </span>
          <span className="k">hermeticd</span>
          <span className="v">
            {agent.hermeticd_version ?? "—"}
            {hdMark ? <span className="skew-mark"> {hdMark}</span> : null}
          </span>
          {/*
            The two §6.6 axes that are this agent's own, spelled beside the
            values they qualify rather than only inside the band: a mark is part
            of the value, and stays once the band is put away.
          */}
          <span className="k">foundation</span>
          <span className="v">
            {meta?.foundation ? `v${meta.foundation.fleet.foundation_version}` : "—"}
            {fMark ? <span className="skew-mark"> {fMark}</span> : null}
          </span>
          <span className="k">config</span>
          <span className="v">
            {cfgHash.value}
            {cfgHash.warn ? (
              <span className="skew-mark"> {cfgHash.note}</span>
            ) : (
              <span style={{ color: "var(--fg3)" }}> {cfgHash.note}</span>
            )}
          </span>
          <span className="k">data disk</span>
          <span className="v">{agent.volume_gib} GiB gp3</span>
          <span className="k">system disk</span>
          {/*
            The one place the size is a *decision* rather than a reading, so it
            is the one place that names the flag which changes it. A row created
            before the root disk was sizeable says so rather than printing
            today's default.
          */}
          <span className="v">
            {agent.root_gib ? `${agent.root_gib} GiB gp3` : "not recorded"}
            <span style={{ color: "var(--fg3)" }}>
              {" · "}
              <span className="mono">--root-gib</span>, applied by the next rebuild
            </span>
          </span>
          <span className="k">uptime</span>
          <span className="v">
            {uptime(agent, Date.now())} · heartbeat {heartbeatAge(agent)}
          </span>
          <span className="k">created</span>
          <span className="v">
            {fmtDate(agent.created_at)} · by {agent.created_by}
          </span>
          <span className="k">region</span>
          <span className="v">{agent.region}</span>
          <span className="k">instance id</span>
          <span className="v">
            {instanceConsoleUrl ? (
              <a href={instanceConsoleUrl} target="_blank" rel="noreferrer noopener">
                {agent.instance_id}
              </a>
            ) : (
              (agent.instance_id ?? "—")
            )}
          </span>
          <span className="k">volume id</span>
          <span className="v">{agent.volume_id ?? "—"}</span>
          <span className="k">cost</span>
          <span className="v">
            <span style={{ fontWeight: 700 }}>{cost.monthly}</span>
            <span className="dr-kv-sub">{cost.hourly}</span>
          </span>
        </div>
      </section>

      {/*
        §7.4: what Desktop's remote-gateway form asks for, fetched only when the
        operator asks — it reaches the box over the tailnet. The address is
        plain, it is on the row already; the token is masked behind a reveal,
        because a drawer can stay open on a shared screen for a long time and
        nothing here needs the value to be *read*, only copied.
      */}
      {live ? (
        <section>
          <div className="dr-h">
            <span className="kicker">Hermes Desktop gateway</span>
            <button
              type="button"
              className="btn btn-secondary btn-mini"
              disabled={attaching}
              title="The address and session token Hermes Desktop's remote-gateway form asks for (§7.4)"
              onClick={() => void doAttach()}
            >
              {attaching ? "Asking the box…" : "Connect Desktop"}
            </button>
          </div>
          {!attach && !attachError ? (
            <div className="hint">
              Pair Hermes Desktop with this agent: the box hands back a remote address and a session
              token for Desktop's remote-gateway form.
            </div>
          ) : null}
          {attachError ? (
            <div className="wiz-error mono" role="alert">
              Desktop details failed — {attachError}
            </div>
          ) : null}
          {attach ? (
            <div className="desktop-attach" aria-live="polite">
              <div className="desktop-field">
                <b>remote address</b>
                <CopyId id={attach.url} className="mono" />
              </div>
              <div className="desktop-field">
                <b>session token</b>
                <CopyId
                  id={attach.token}
                  label={tokenShown ? attach.token : "•".repeat(12)}
                  className="mono"
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-mini"
                  onClick={() => setTokenShown((shown) => !shown)}
                >
                  {tokenShown ? "Hide" : "Reveal"}
                </button>
              </div>
              <div className="desktop-note">
                Settings → Gateways in Hermes Desktop (or a profile’s “Connect to a remote host…”):
                paste the address into “Remote address” and the token into “Session token”. Desktop’s
                connection test passes without a token and the real connection does not, so both are
                required.
              </div>
              {attach.rotates ? (
                <div className="desktop-note">
                  The token dies with the box’s dashboard process — a reboot, a rebuild, an apply or a
                  Hermes update mints a new one. Ask again when Desktop says the host rejected the saved
                  token.
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
