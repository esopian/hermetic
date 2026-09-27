/**
 * §7.4's one read: what Hermes Desktop's "Remote Gateway" form needs to attach
 * to an agent's box — the Serve URL, and the box's current dashboard session
 * token.
 *
 * Its own module with an explicit deps object (AGENTS.md rule 5), like
 * `chat.ts` and `agent-logs.ts`: it needs the fleet guard for the tailnet, the
 * row reader for the node's real name, the name rule, and the adapter. Nothing
 * from the lifecycle closure.
 *
 * **Why a command exists at all.** Desktop cannot discover the token for
 * itself. Upstream's Electron shell scrapes `window.__HERMES_SESSION_TOKEN__`
 * from `GET /` only for a backend it spawned locally
 * (`apps/desktop/electron/dashboard-token.ts`); a *remote* gateway is expected
 * to come with a token the operator pastes into the form, and with none saved
 * the connection test still passes — it skips the WebSocket leg it has no
 * credential for — while the real attach fails. So the failure this command
 * prevents is the one that looks like success.
 *
 * **Why the token is printed rather than hidden.** §8.3's rule is that a secret
 * is never *logged, echoed or written to disk* on the laptop; answering a
 * question an operator asked out loud is neither. This one is also the weakest
 * credential hermetic handles: it belongs to a single `hermes dashboard`
 * process, it dies when that process restarts, and it admits nobody who is not
 * already inside the tailnet ACL that guards the box (§6.4). It is deliberately
 * not recorded anywhere — `runs` stores the request, which is a name, and the
 * portal logs the op and not its result.
 */
import { agentDashboardUrl, cloudName } from "../schema/index.ts";
import { validateName } from "../shared/naming.ts";
import type { Agent, FleetItem, LocalConfig } from "../schema/index.ts";
import type { StackInfo } from "../backend/types.ts";
import type { HermesChatClient } from "../chat/hermes/hermes-chat.ts";

export interface DesktopOptions {
  signal?: AbortSignal | undefined;
}

export interface DesktopDeps {
  /** §4.2's account/fleet guard; the tailnet comes from the fleet it returns. */
  guardFleet: () => Promise<{ config: LocalConfig; fleet: FleetItem; stack: StackInfo }>;
  /** The row, or `NOT_FOUND`. */
  getAgent: (name: string) => Promise<Agent>;
  /**
   * The adapter — the only module that knows what a Hermes dashboard answers
   * with, and therefore the only one that knows where the token is written.
   */
  hermes: HermesChatClient;
}

/** What Desktop's two fields want, plus the name of the box they point at. */
export interface DesktopAttach {
  instance: string;
  /**
   * Desktop's "Remote address". The node's *real* MagicDNS name when it has one
   * (§6.4: a box readmitted as `<name>-2` answers on nothing else), which is
   * why this comes from the row rather than from the canonical spelling.
   *
   * There is no port and no path in it on purpose. The dashboard binds
   * `127.0.0.1:9119` and the nginx in front of it `127.0.0.1:9120`; Serve on 443
   * is the only address that reaches either (§7.2, §7.4).
   */
  url: string;
  /**
   * Desktop's "Session token" — `X-Hermes-Session-Token` on its REST calls and
   * `?token=` on its WebSocket.
   *
   * Scraped now, not remembered: upstream mints it with
   * `secrets.token_urlsafe(32)` at dashboard start unless
   * `HERMES_DASHBOARD_SESSION_TOKEN` is set, which hermetic does not set, so the
   * value changes on every reboot, `hermeticd apply`, `hermes update` and agent
   * recreate. `rotates` says so on the wire, so a head does not have to know it
   * to warn about it.
   */
  token: string;
  /** Always true today; a field rather than prose so the UI can render it. */
  rotates: boolean;
}

export function createDesktop(deps: DesktopDeps) {
  const { guardFleet, getAgent, hermes } = deps;

  /**
   * Where the box is, resolved the way `chat.ts` and `probe.ts` resolve it:
   * `agentDashboardUrl` prefers the row's `tailscale_dns_name` over the
   * canonical `<fleet id>-<agent>.<tailnet>` spelling, because after a recreate
   * whose device cleanup could not run the canonical name still points at the
   * corpse — and a token scraped from a corpse is a token for a box nobody is
   * watching.
   */
  async function attach(input: { name: string }, opts: DesktopOptions = {}): Promise<DesktopAttach> {
    validateName(input.name);
    const { fleet } = await guardFleet();
    const agent = await getAgent(input.name);
    const url = agentDashboardUrl(agent, fleet.tailnet, cloudName(fleet.fleet_id, agent.name));
    const token = await hermes.token(
      { instance: agent.name, baseUrl: url, fleet_id: fleet.fleet_id },
      { signal: opts.signal },
    );
    return { instance: agent.name, url, token, rotates: true };
  }

  return { attach };
}
