/**
 * The local Tailscale gate in front of every terminal session (issue #18, D8):
 * which binary to run, or the refusal the UI renders a panel for. Pure over
 * core's preflight and core's `ssh` argv, so each refusal is a test.
 */
import { HermeticError } from "@hermetic/core";
import type { TailscalePreflight } from "@hermetic/core";

/**
 * The host of the session's own name in core's argv, and the tailnet that
 * name lives in: `hermes@fxtr0001-atlas.acme.ts.net` → `acme.ts.net`.
 */
export function sshTarget(argv: readonly string[]): { host: string; tailnet: string | null } {
  const last = argv[argv.length - 1] ?? "";
  const host = last.slice(last.indexOf("@") + 1);
  const dot = host.indexOf(".");
  return { host, tailnet: dot === -1 ? null : host.slice(dot + 1) };
}

/**
 * The D8 gate: the binary to run, or the refusal the UI renders a panel for.
 *
 * The fleet's tailnet is read off the host core resolved: every name core
 * hands out is `<node>.<fleet tailnet>` (`agentHostname`), so the question
 * "is this Mac on the fleet's tailnet" is exactly "does the host end in this
 * Mac's tailnet" — and asking it of the host is asking it of the box the
 * session is about to reach, with no second read of `_fleet`.
 */
export function gateTerminal(pre: TailscalePreflight, argv: readonly string[]): string {
  const details = { backend_state: pre.backend_state };
  if (!pre.installed || pre.binary === null) {
    throw new HermeticError(
      "TAILSCALE_MISSING",
      "Tailscale is not installed on this Mac; the terminal connects through `tailscale ssh`",
      details,
    );
  }
  if (!pre.running) {
    throw new HermeticError(
      "TAILSCALE_STOPPED",
      `Tailscale is not running on this Mac (${pre.backend_state ?? "unknown state"})`,
      details,
    );
  }
  const { host, tailnet } = sshTarget(argv);
  if (pre.tailnet !== null && tailnet !== null && !host.endsWith(`.${pre.tailnet}`)) {
    throw new HermeticError(
      "TAILSCALE_WRONG_TAILNET",
      `this Mac is on ${pre.tailnet}, but the fleet is on ${tailnet}`,
      { ...details, local_tailnet: pre.tailnet, fleet_tailnet: tailnet },
    );
  }
  return pre.binary;
}
