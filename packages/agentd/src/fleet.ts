/**
 * The *fleet manifest* on the box: `manifest.json` at the root of the fleet
 * bucket, cached at `/var/lib/hermeticd/fleet.json` (§4.2 step 2).
 *
 * It is the single source of everything that used to be scattered: which
 * hermeticd release to run, which files that release contains and their
 * digests, and which DynamoDB tables, bucket and SSM prefix this fleet uses.
 * User-data now carries only what a box needs *before* it can talk to AWS at
 * all — its name, its bucket, and a presigned URL for the binary.
 *
 * `bootstrap` and `update` are the only subcommands that fetch it; everything
 * else builds its context from this cache, so a `hermeticd apply` on a box
 * whose network is having a bad day does not depend on S3.
 *
 * Not to be confused with the *agent manifest* (`AgentConfig`, `manifest.ts`).
 */
import { FleetManifest } from "@hermetic/core/schema";
import type { FleetManifest as FleetManifestType } from "@hermetic/core/schema";
import { AgentdError } from "./errors.ts";
import type { Host } from "./host.ts";

/** hermeticd's own state directory: markers, the fleet cache, nothing secret. */
export const STATE_DIR = "/var/lib/hermeticd";
export const FLEET_CACHE_PATH = `${STATE_DIR}/fleet.json`;

/** Parse and validate. A manifest that does not validate is not usable at all. */
export function parseFleetManifest(text: string): FleetManifestType {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AgentdError("INTERNAL", "the fleet manifest is not valid JSON");
  }
  const parsed = FleetManifest.safeParse(json);
  if (!parsed.success) {
    throw new AgentdError("INTERNAL", "the fleet manifest does not validate against FleetManifest", {
      issues: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  return parsed.data;
}

/** `null` when the box has never fetched one — a first boot, or a wiped root. */
export async function readCachedFleetManifest(host: Host): Promise<FleetManifestType | null> {
  const text = await host.readFile(FLEET_CACHE_PATH);
  return text === null ? null : parseFleetManifest(text);
}

/**
 * The cache as `bootstrap`, `update` and `serve` read it: a file that will not
 * parse is treated as one that is not there.
 *
 * A truncated write (a box that lost power mid-update) would otherwise be
 * permanently fatal — `serve` could not start, and `update`, the very thing
 * that would rewrite the file, could not run either. The warning is redacted
 * because a parse error quotes the document.
 */
export async function readUsableFleetManifest(
  host: Host,
  warn: (message: string) => void = () => {},
): Promise<FleetManifestType | null> {
  try {
    return await readCachedFleetManifest(host);
  } catch (e) {
    warn(
      `ignoring the fleet manifest cache at ${FLEET_CACHE_PATH}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
}

/** 0644: it names resources, never a value. Anything on the box may read it. */
export async function cacheFleetManifest(host: Host, fleet: FleetManifestType): Promise<void> {
  await host.mkdir(STATE_DIR, "0755");
  await host.writeFile(FLEET_CACHE_PATH, JSON.stringify(fleet, null, 2) + "\n", "0644");
}

/**
 * This agent's own SSM prefix. The manifest carries the *fleet* prefix
 * (`/hermes/<fleet_id>/` since foundation v3, plain `/hermes/` before it); an
 * agent's slots hang off `${param_prefix}<name>/`. It is read from the manifest
 * rather than rebuilt here, so a box on a fleet that has not taken v3 yet keeps
 * reading the paths its parameters are actually at.
 */
export function agentParamPrefix(fleet: FleetManifestType, name: string): string {
  const prefix = fleet.resources.param_prefix;
  return `${prefix.endsWith("/") ? prefix : prefix + "/"}${name}/`;
}

/** The SSM path for one of this agent's slots, e.g. `/hermes/fxtr0001/research-1/ts-key`. */
export function paramPath(agentPrefix: string, slot: string): string {
  return (agentPrefix.endsWith("/") ? agentPrefix : agentPrefix + "/") + slot;
}
