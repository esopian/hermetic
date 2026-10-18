/**
 * Rows and wiring the phone-route tests share (`rpc-mobile.test.ts`, the root
 * `tests/mobile-box-seams.test.ts`): a valid `Agent` item, a `_fleet` item, and
 * an RPC handler with the phone routes wired over a `RecordingSink`.
 */
import type { Agent } from "@hermetic/core/schema";
import { FLEET_KEY } from "@hermetic/core/shared";
import { makeAws } from "../src/aws.ts";
import { pushDeviceStore } from "../src/push/devices.ts";
import { makeRpcHandler, type Whois } from "../src/rpc.ts";
import { fleetViewSource, makeMobileRoutes } from "../src/rpc-mobile.ts";
import { FakeHost } from "./fake-host.ts";
import {
  RecordingSink,
  TEST_AGENTS_TABLE,
  TEST_EVENTS_TABLE,
  TEST_FLEET_ID,
  TEST_NAME,
  makeFleetManifest,
} from "./fixtures.ts";

export const MEMBER: Whois = { login: "evan@example.com", node: "phone.tailnet.ts.net", tags: [] };
/** A second tailnet member, on `OTHER_MEMBER_IP` in every rig. */
export const OTHER_MEMBER: Whois = {
  login: "mallory@example.com",
  node: "other-phone.tailnet.ts.net",
  tags: [],
};
export const PHONE_IP = "100.64.0.7";
export const OTHER_MEMBER_IP = "100.64.0.99";
export const STRANGER_IP = "203.0.113.9";

/** An agents-table item that parses with core's `Agent`. */
export function agentRow(
  overrides: Partial<Agent> & Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "atlas",
    status: "ready",
    version: 3,
    lock: null,
    size: "medium",
    instance_type: "t4g.2xlarge",
    region: "us-east-1",
    instance_id: "i-0123456789abcdef0",
    volume_id: "vol-0123456789abcdef0",
    volume_gib: 100,
    hermes_version: "0.15.0",
    hermeticd_version: "0.4.1",
    config_hash: null,
    provider: "bedrock",
    secrets_mode: "none",
    tailscale_ip: "100.64.0.10",
    tailscale_dns_name: "fxtr0001-atlas.tail1234.ts.net",
    resources: { ssm_paths: [] },
    last_heartbeat: null,
    health: null,
    metrics: null,
    created_by: "arn:aws:iam::123456789012:user/e",
    created_at: "2026-09-01T12:00:00.000Z",
    updated_at: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

/** The `_fleet` item, with only the fields `GET /fleet` reads (plus the key). */
export function fleetRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: FLEET_KEY,
    fleet_id: TEST_FLEET_ID,
    fleet_name: "main",
    tailnet: "tail1234.ts.net",
    region: "us-east-1",
    foundation_version: 16,
    ...overrides,
  };
}

export interface MobileRig {
  readonly host: FakeHost;
  readonly ddb: RecordingSink;
  readonly audit: string[];
  /** `(method, path, init?, peer?)` → the handler's response. */
  call(method: string, path: string, body?: BodyInit | null, peer?: string): Promise<Response>;
}

/**
 * The listener with the phone routes wired as `daemon.ts` wires them. The
 * agents table answers `items` to a Scan and `fleet` to the `_fleet` get;
 * `scanError` makes every Scan throw it instead.
 */
export function mobileRig(
  options: {
    items?: Record<string, unknown>[];
    fleet?: Record<string, unknown> | null;
    scanError?: Error;
    peer?: Whois;
  } = {},
): MobileRig {
  const host = new FakeHost();
  const ddb = new RecordingSink();
  const items = options.items ?? [fleetRow(), agentRow()];
  ddb.byCommand.set("ScanCommand", () => options.scanError ?? { Items: items });
  ddb.byCommand.set("GetCommand", () => {
    const fleet = options.fleet === undefined ? fleetRow() : options.fleet;
    return fleet === null ? {} : { Item: fleet };
  });
  const aws = makeAws({
    ddb,
    ssm: new RecordingSink(),
    s3: new RecordingSink(),
    agentsTable: TEST_AGENTS_TABLE,
    eventsTable: TEST_EVENTS_TABLE,
    now: () => host.now(),
  });
  const manifest = makeFleetManifest();
  const audit: string[] = [];
  const log = (message: string): void => void audit.push(message);
  const handler = makeRpcHandler({
    host,
    name: TEST_NAME,
    hermeticdVersion: "0.1.0",
    configHash: async () => null,
    whois: async (ip) =>
      ip === OTHER_MEMBER_IP
        ? OTHER_MEMBER
        : ip.startsWith("100.64.")
          ? (options.peer ?? MEMBER)
          : null,
    log,
    mobile: makeMobileRoutes({
      fleetView: fleetViewSource({ aws, manifest: () => manifest, now: () => host.now(), log }),
      devices: pushDeviceStore(host, log),
      now: () => host.now().getTime(),
      log,
    }),
  });
  return {
    host,
    ddb,
    audit,
    call: (method, path, body, peer = PHONE_IP) =>
      handler(
        new Request(`http://100.64.0.1:7434${path}`, {
          method,
          ...(body === undefined || body === null ? {} : { body }),
        }),
        peer,
      ),
  };
}
