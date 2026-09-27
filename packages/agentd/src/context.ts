/**
 * The box's shared context (§4.2 step 2) and the redacting writers every
 * subcommand and the daemon log through. Split from the subcommands so that
 * `daemon.ts` (which needs both) and `cli.ts` (which needs both and `serve`)
 * do not import each other.
 */
import { AgentdError } from "./errors.ts";
import type { Host } from "./host.ts";
import { fetchFleetManifest, realAws, realS3, type Aws, type CommandSink } from "./aws.ts";
import {
  USER_DATA_JSON_PATH,
  httpImds,
  loadUserData,
  parseUserData,
  type Imds,
  type UserData,
} from "./userdata.ts";
import type { FleetManifest, OpEvent } from "@hermetic/core/schema";
import {
  FLEET_CACHE_PATH,
  agentParamPrefix,
  cacheFleetManifest,
  readUsableFleetManifest,
} from "./fleet.ts";
import { redactValue } from "./redact.ts";

/**
 * Progress goes to stderr as one line per OpEvent; stdout stays
 * machine-readable. Both of these redact, and so does `fatalMessage`: stderr on
 * this box is journald, which is durable, world-readable to the `systemd-journal`
 * group, and shipped verbatim by `GET /logs` (§8.3). An `AgentdError` built from
 * a failed command's stderr is exactly where a credential would ride in.
 */
export function stderrEmit(event: OpEvent): void {
  const pct = String(Math.round(event.progress * 100)).padStart(3);
  process.stderr.write(`[${pct}%] ${event.phase}: ${redactValue(event.message)}\n`);
}

export function log(message: string): void {
  process.stderr.write(`hermeticd: ${redactValue(message)}\n`);
}

/** The one line an unhandled failure prints before the process exits. */
export function fatalMessage(e: unknown): string {
  return `hermeticd: ${redactValue(e instanceof Error ? e.message : String(e))}\n`;
}

/**
 * The box's shared context (§4.2 step 2). User-data says who this agent is and
 * which bucket to look in; the cached fleet manifest says everything else —
 * the tables, the SSM prefix, the region, the release. Only `bootstrap` and
 * `update` fetch the manifest; every other subcommand reads the cache, so an
 * `apply` does not depend on S3 being reachable.
 *
 * `serve` prefers the JSON cloud-init already wrote, so a restart does not
 * depend on IMDS being up; the IMDS path is the fallback, and it accepts the
 * cloud-init script IMDS actually returns as well as the bare JSON blob.
 */
export interface Context {
  readonly host: Host;
  readonly aws: Aws;
  readonly userData: UserData;
  readonly fleet: FleetManifest;
  readonly bucket: string;
  readonly region: string;
  /** This agent's own SSM prefix, `/hermes/<fleet_id>/<name>/` since foundation v3. */
  readonly paramPrefix: string;
}

/**
 * The seams a test needs to run a whole subcommand without a network: where the
 * fleet manifest is fetched from, what IMDS says, and how the AWS client is
 * built once the tables are known. Production passes none of them.
 */
export interface RunDeps {
  readonly s3?: CommandSink;
  readonly imds?: Imds;
  readonly aws?: (region: string, fleet: FleetManifest) => Aws;
}

async function userDataFor(host: Host, deps: RunDeps): Promise<UserData> {
  const cached = await host.readFile(USER_DATA_JSON_PATH);
  return cached ? parseUserData(cached) : await loadUserData(deps.imds ?? httpImds());
}

function contextFrom(
  host: Host,
  userData: UserData,
  fleet: FleetManifest,
  region: string,
  deps: RunDeps,
): Context {
  return {
    host,
    aws:
      deps.aws?.(region, fleet) ??
      realAws(region, () => host.now(), {
        agents: fleet.resources.agents_table,
        events: fleet.resources.events_table,
      }),
    userData,
    fleet,
    bucket: userData.bucket,
    region,
    paramPrefix: agentParamPrefix(fleet, userData.name),
  };
}

/**
 * The context for everything that runs *after* a successful boot: `stage …`,
 * `apply`, `heartbeat`, `secrets`.
 *
 * The cache is required and deliberately not fetched. A subcommand that
 * silently reached S3 for it would make `apply` depend on the network, and
 * would hide the real problem — that this box has never completed a boot.
 */
export async function context(host: Host, deps: RunDeps = {}): Promise<Context> {
  const userData = await userDataFor(host, deps);
  const fleet = await readUsableFleetManifest(host, log);
  if (!fleet) {
    throw new AgentdError(
      "INTERNAL",
      `no fleet manifest cache at ${FLEET_CACHE_PATH}; run \`hermeticd bootstrap\` first`,
      { path: FLEET_CACHE_PATH },
    );
  }
  // The manifest is authoritative for the fleet's region, so IMDS is not asked
  // for something the box already has written down.
  return contextFrom(host, userData, fleet, process.env["AWS_REGION"] ?? fleet.region, deps);
}

/**
 * The context for the three subcommands that must work on a box with no cache:
 * `bootstrap` (a first boot — cloud-init writes user-data and nothing else),
 * `update` (the thing that repairs a cache), and `serve` (which must start even
 * when the cache is missing or was truncated by a power cut mid-write).
 *
 * It fetches `manifest.json` from the bucket user-data names — the one AWS call
 * that needs no table names, because it is the file that names them — and falls
 * back to the cache only when that fetch fails.
 */
export async function bootContext(host: Host, deps: RunDeps = {}): Promise<Context> {
  const userData = await userDataFor(host, deps);
  const cachedFleet = await readUsableFleetManifest(host, log);
  const region =
    process.env["AWS_REGION"] ?? cachedFleet?.region ?? (await (deps.imds ?? httpImds()).region());

  let fleet: FleetManifest;
  try {
    fleet = await fetchFleetManifest(deps.s3 ?? realS3(region), userData.bucket);
    await cacheFleetManifest(host, fleet);
  } catch (e) {
    if (!cachedFleet) {
      throw new AgentdError(
        "INTERNAL",
        `could not read s3://${userData.bucket}/manifest.json and there is no cache at ${FLEET_CACHE_PATH}: ${redactValue(
          e instanceof Error ? e.message : String(e),
        )}`,
        { bucket: userData.bucket },
      );
    }
    // The cached copy is what lets a boot proceed when S3 is briefly unhappy;
    // it is the same document, just possibly one release behind.
    log(
      `could not refresh the fleet manifest (${redactValue(
        e instanceof Error ? e.message : String(e),
      )}); using the cached copy`,
    );
    fleet = cachedFleet;
  }

  return contextFrom(host, userData, fleet, region, deps);
}
