/**
 * What every phase module of `apply` shares: the result and options shapes,
 * the content hash that decides whether a file is rewritten, the unit directory
 * two phases read and write, and the retry wrapper the network-facing steps use.
 * Split out of `apply.ts` so the phase modules depend on this and not on one
 * another.
 */
import { createHash } from "node:crypto";
import type { Host } from "../host.ts";
import type { Emit } from "../events.ts";
import type { ObjectFetch } from "../hermes-source.ts";

export const UNIT_DIR = "/etc/systemd/system";

export interface ApplyResult {
  /** Absolute paths whose content or mode this apply changed. */
  changed: string[];
  /**
   * Paths whose *content* was rewritten. Only these can trigger a restart: a
   * mode correction changes no behaviour, and bouncing Hermes over a `chmod`
   * would be a needless interruption (§6.4).
   */
  contentChanged: string[];
  /** Paths where only the permission bits were corrected. */
  modeCorrected: string[];
  /**
   * Paths whose `owner:group` was corrected. Like a mode fix, this changes no
   * behaviour of the file's content, so it never restarts a unit.
   */
  ownershipCorrected: string[];
  /** Units restarted — only those whose own unit file changed. */
  restarted: string[];
  /** Packages actually handed to `apt-get install`. */
  installed: string[];
  /** Units newly enabled. */
  enabled: string[];
  /** Manifest post-steps run. */
  commands: string[];
}

export interface ApplyOptions {
  readonly host: Host;
  readonly emit?: Emit;
  /** Plan only: probe reality, report what would change, mutate nothing. */
  readonly dryRun?: boolean;
  /**
   * Resolved bws access token. Present only when `secrets_mode: bitwarden`;
   * `undefined` means the box has no Bitwarden integration at all (§8.1).
   */
  readonly bwsToken?: string;
  /** The agent's Bitwarden project id; defaults to the agent name. */
  readonly bwsProject?: string;
  /**
   * The model provider's API key, read by the caller from the slot the manifest
   * names (`provider_key_ref`, §8.3) under this agent's own SSM prefix —
   * `provider-key` on a manifest rendered before provider profiles,
   * `provider-key-<profile_id>-r<revision>` on one rendered from a profile.
   * Present only
   * when the manifest's provider is key-authenticated; `undefined` means the
   * instance role is the agent's only identity (§8.1).
   */
  readonly providerKey?: string;
  /**
   * Reads one object out of the fleet bucket — the Hermes source bundle, and
   * the mirrored Chrome build a browser agent runs.
   *
   * Optional because the default is the real thing: an S3 `GetObject` against
   * the region and tables the cached fleet manifest names. A caller that omits
   * it gets the mirror, so an unthreaded dependency cannot quietly put every
   * box back on github.com. Tests inject a double; nothing reaches for it at
   * all unless the fleet manifest carries a bundle for the pinned ref.
   */
  readonly getObject?: ObjectFetch;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Run `body`, and on failure run it again, up to `attempts` times.
 *
 * The last failure is the one that propagates — a caller that gave up should
 * report why it gave up, not why it first tried again. Nothing is swallowed:
 * an operation that never succeeds still throws exactly what it would have
 * thrown without this wrapper.
 */
export async function retry<T>(
  host: Host,
  attempts: number,
  waitMs: number,
  body: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await body();
    } catch (e) {
      if (attempt >= attempts) throw e;
      await host.sleep(waitMs);
    }
  }
}
