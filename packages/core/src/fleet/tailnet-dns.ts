/**
 * Does this machine resolve the fleet's MagicDNS names? (§4.7, §9 `doctor`)
 *
 * `tailscale status --json` (`preflight.ts`) says the daemon is running and
 * signed in. It does not say whether this machine *uses* Tailscale's DNS: with
 * "Use Tailscale DNS" off (`--accept-dns=false`), or another VPN or DNS filter
 * taking over the resolver, the daemon reads `Running` and every agent looks
 * dead from here, because no `*.ts.net` name resolves.
 *
 * So one agent's name is asked two ways, in parallel, each bounded:
 *
 * - through Tailscale's own resolver at `100.100.100.100`, which answers from
 *   inside the local client whenever it is up;
 * - through this machine's system resolver (`getaddrinfo`, the path every
 *   HTTPS call to a box takes).
 *
 * Tailscale answers and the system does not: that is the misconfiguration,
 * and the one reading `doctor` turns into a finding. Neither answers, or both
 * do, says nothing new here: the preflight and the fleet reads already cover
 * those.
 *
 * Its own module with an injected seam (`HermeticDeps.localTailnetDns`): tests
 * and the fixture never send a DNS query.
 */
import { lookup as systemLookup, Resolver } from "node:dns/promises";

/** Tailscale's service address: its MagicDNS resolver answers here. */
export const TAILSCALE_RESOLVER = "100.100.100.100";
export const TAILNET_DNS_TIMEOUT_MS = 2_000;

export interface TailnetDnsReading {
  /** The name asked: one agent's MagicDNS name. */
  name: string;
  /** Tailscale's resolver (`100.100.100.100`) returned an address for it. */
  via_tailscale: boolean;
  /** This machine's system resolver did. */
  via_system: boolean;
}

export type TailnetDnsProbe = (name: string) => Promise<TailnetDnsReading>;

/** Resolve within `ms`, or `false`; never throws. */
async function within(ms: number, work: () => Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The real probe: both resolvers, in parallel, `timeoutMs` each. */
export async function probeTailnetDns(
  name: string,
  timeoutMs = TAILNET_DNS_TIMEOUT_MS,
): Promise<TailnetDnsReading> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([TAILSCALE_RESOLVER]);
  const [via_tailscale, via_system] = await Promise.all([
    within(timeoutMs, () => resolver.resolve4(name)),
    within(timeoutMs, () => systemLookup(name)),
  ]);
  return { name, via_tailscale, via_system };
}

/**
 * The one reading worth a finding, as the line a head prints; `null` for
 * every other. Never a secret: the name is a device name already in the
 * operator's tailnet.
 */
export function tailnetDnsProblem(reading: TailnetDnsReading): string | null {
  if (!reading.via_tailscale || reading.via_system) return null;
  return `tailscale is running, but this machine is not using its DNS: ${reading.name} resolves through Tailscale's resolver (${TAILSCALE_RESOLVER}) and not through the system's, so every agent looks unreachable from here — turn on "Use Tailscale DNS" (\`tailscale set --accept-dns=true\`, or the app's DNS setting) and check that another VPN or DNS filter is not overriding it`;
}
