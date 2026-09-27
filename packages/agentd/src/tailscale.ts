/**
 * What hermeticd still asks the `tailscale` binary directly: its own tailnet
 * address, and its own node's view of itself.
 *
 * Joining the tailnet is `stages/01-tailscale.sh`'s job now (§4.3) — it owns the
 * apt source, the auth key file and `tailscale up`. But the address is read at
 * three later moments that have nothing to do with bootstrap: the heartbeat
 * reports it, the RPC listener binds to it, and the stage runner records it as
 * a fact. So it lives here rather than inside the boot path.
 */
import type { Host } from "./host.ts";

/** The tailnet address — the one that matters; the public IPv4 changes freely (§7.1). */
export async function tailscaleIpv4(host: Host): Promise<string | null> {
  const res = await host.exec(["tailscale", "ip", "-4"]);
  if (res.code !== 0) return null;
  const ip = res.stdout.trim().split("\n")[0]?.trim();
  return ip && ip.length > 0 ? ip : null;
}

/** The facts about this node the heartbeat needs out of `tailscale status`. */
export interface TailscaleSelf {
  readonly online: boolean;
  /**
   * The node's MagicDNS name with the trailing dot stripped — `tailscale` reports
   * it as a fully qualified `atlas.example.ts.net.`, which is not a hostname you
   * can paste into a URL. `null` when the daemon has no name for us yet, which is
   * every moment before the node is registered on the tailnet.
   */
  readonly dnsName: string | null;
  /**
   * The version of the `tailscaled` this box is actually running, as the daemon
   * itself reports it — `1.86.2-t01ab2cd34`, the release followed by the build's
   * commit.
   *
   * Reported verbatim rather than trimmed to the release: it is a fact about the
   * box and nothing here is in a position to decide which half of it matters.
   *
   * It moves without hermetic doing anything, which is the reason it is worth
   * reporting at all: `stages/01-tailscale.sh` turns on Tailscale's own updater,
   * so a box takes new releases from the stable channel between one heartbeat
   * and the next, and this is the only record of which one it is on. `null` when
   * the daemon did not answer or named no version.
   */
  readonly version: string | null;
}

/**
 * One `tailscale status --json` per caller, parsed once. The heartbeat used to
 * shell out here purely for `Self.Online`; the dashboard check needs the node's
 * own name out of the same document, the row records the daemon's version out of
 * it too, and running the binary three times a tick to read three fields of one
 * JSON object would be able to disagree with itself.
 *
 * The version is the document's *top-level* `Version` — the daemon answering
 * this call — not `Self.ClientVersion`, which is the coordination server's
 * opinion about whether a newer release exists and is absent on a node that has
 * not asked.
 */
export async function tailscaleSelf(host: Host): Promise<TailscaleSelf> {
  const res = await host.exec(["tailscale", "status", "--json"]);
  if (res.code !== 0) return { online: false, dnsName: null, version: null };
  try {
    const status = JSON.parse(res.stdout) as {
      Version?: unknown;
      Self?: { Online?: boolean; DNSName?: string };
    };
    const dnsName = (status.Self?.DNSName ?? "").replace(/\.$/, "").trim();
    // The version is untrusted JSON, whatever its declared type: a non-string
    // `Version` must read as unknown rather than throw, because the `catch`
    // below would then discard a perfectly good `Online` and MagicDNS name.
    const raw = status.Version;
    const version = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
    return {
      online: status.Self?.Online === true,
      dnsName: dnsName.length > 0 ? dnsName : null,
      version,
    };
  } catch {
    return { online: false, dnsName: null, version: null };
  }
}
