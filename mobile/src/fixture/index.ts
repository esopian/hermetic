/**
 * Fixture mode (§9.4): the phone against a canned fleet, with no tailnet, no
 * box and no Expo push service. It is what the simulator screenshots run on.
 *
 * `fixtureKit(flag)` answers `null` unless `flag` is `"1"`, and the app passes
 * it `process.env.EXPO_PUBLIC_HERMETIC_FIXTURE` (inlined at build time), so a
 * production build never constructs any of this. When it is on, the kit hands
 * the provider:
 *
 * - `chat` — core's fixture chat stack (`createFixtureChatStack`, in place of
 *   the live Hermes adapter): the same `fixtureChatClient` the desktop runs,
 *   wrapped the same way, with the same scripted-activity store handed to both
 *   halves. A bare `fixtureChatClient` with no activity leaves `observe` inert
 *   (the conversation sits on "Reconnecting…") and records a sent prompt under
 *   its own id beside the phone's placeholder (the prompt shows twice);
 * - `fetch` — a stand-in for the network that answers hermeticd's `GET /fleet`
 *   with a canned `MobileFleetView` for `fxtr0001` (alias `main`, the desktop
 *   fixture's eleven agents), keeps `POST`/`DELETE /push/devices` in an
 *   in-memory registry, and answers the Tailscale probe (`/api/health`) the way
 *   the switchable `tailscale` status says;
 * - `link` — a pairing link for that fleet, for the Pair screen's "Use fixture
 *   fleet" button;
 * - `storagePrefix` — fixture pairings and caches are kept under their own
 *   keys and files, never over a real pairing.
 *
 * Everything past the kit is the real code: the fleet store, the gateway
 * transport, the inbox and the probe all run unchanged over these doubles.
 *
 * This directory is the only place in `mobile/` that may import
 * `@hermetic/core/chat-client-fixture` (`tests/boundaries.test.ts`).
 */
import type { HermesChatClient } from "@hermetic/core/chat-client";
import { createFixtureChatStack } from "@hermetic/core/chat-client-fixture";
import type { MobileFleetAgent, MobileFleetView, MobilePushDevice } from "@hermetic/core/schema";
import { cloudName, encodeMobileLink, RPC_PATHS } from "@hermetic/core/shared";
import type { FetchLike } from "../gateway/hermeticd.ts";
import type { TailscaleStatus } from "../gateway/tailscale.ts";

export const FIXTURE_FLEET_ID = "fxtr0001";
export const FIXTURE_ALIAS = "main";
/** `FIXTURE_TAILNET` in `packages/core/src/backend/fixture/memory-fixture.ts`. */
export const FIXTURE_TAILNET = "hermetic.ts.net";
const FIXTURE_ACCOUNT = "123456789012";
const FIXTURE_REGION = "us-west-2";

export const FIXTURE_PUSH_TOKEN = "ExponentPushToken[FIXTURE-phone-token]";

const HEALTHY = { hermes: true, tailscale: true, disk: true } as const;

/**
 * The `main` fixture fleet's eleven agents, as `GET /fleet` would report them
 * (`SEEDS` in `packages/core/src/backend/fixture/fixture-agents.ts`: name,
 * status, address, Hermes version, health). `corvid` came up under a suffixed
 * MagicDNS name, so its host differs from the derived one.
 */
const SEEDS: readonly {
  name: string;
  status: MobileFleetAgent["status"];
  ip: string;
  version: string;
  health: NonNullable<MobileFleetAgent["health"]>;
  dns_host?: string;
}[] = [
  { name: "atlas", status: "ready", ip: "100.64.12.4", version: "0.21.0", health: HEALTHY },
  {
    name: "corvid",
    status: "ready",
    ip: "100.64.12.9",
    version: "0.21.0",
    health: HEALTHY,
    dns_host: "corvid-2",
  },
  {
    name: "ember",
    status: "degraded",
    ip: "100.64.12.17",
    version: "0.14.2",
    health: { hermes: false, tailscale: true, disk: true },
  },
  { name: "fathom", status: "ready", ip: "100.64.12.21", version: "0.14.2", health: HEALTHY },
  { name: "granite", status: "ready", ip: "100.64.12.23", version: "0.21.0", health: HEALTHY },
  {
    name: "heron",
    status: "error",
    ip: "100.64.12.30",
    version: "0.14.2",
    health: { hermes: false, tailscale: true, disk: true },
  },
  { name: "ibis", status: "ready", ip: "100.64.12.31", version: "0.21.0", health: HEALTHY },
  {
    name: "juniper",
    status: "stopped",
    ip: "100.64.12.38",
    version: "0.13.8",
    health: { hermes: false, tailscale: false, disk: true },
  },
  { name: "kestrel", status: "ready", ip: "100.64.12.40", version: "0.21.0", health: HEALTHY },
  {
    name: "lumen",
    status: "ready",
    ip: "100.64.12.44",
    version: "0.21.0",
    health: { hermes: true, tailscale: true, disk: false },
  },
  {
    name: "marrow",
    status: "stopped",
    ip: "100.64.12.47",
    version: "0.14.0",
    health: { hermes: false, tailscale: false, disk: true },
  },
];

const hostOf = (seed: { name: string; dns_host?: string }) =>
  `${cloudName(FIXTURE_FLEET_ID, seed.dns_host ?? seed.name)}.${FIXTURE_TAILNET}`;

/** The canned `GET /fleet` answer. */
export function fixtureFleetView(readAt: string): MobileFleetView {
  return {
    fleet: {
      fleet_id: FIXTURE_FLEET_ID,
      alias: FIXTURE_ALIAS,
      tailnet: FIXTURE_TAILNET,
      region: FIXTURE_REGION,
      account_id: FIXTURE_ACCOUNT,
      foundation_version: 16,
    },
    agents: SEEDS.map((seed) => ({
      name: seed.name,
      status: seed.status,
      tailscale_dns_name: hostOf(seed),
      tailscale_ip: seed.ip,
      version: seed.version,
      health: seed.health,
    })),
    read_at: readAt,
  };
}

/** What `hermetic mobile pair` would print for the fixture fleet. */
export function fixturePairingLink(): string {
  return encodeMobileLink({
    fleet_id: FIXTURE_FLEET_ID,
    alias: FIXTURE_ALIAS,
    account_id: FIXTURE_ACCOUNT,
    region: FIXTURE_REGION,
    tailnet: FIXTURE_TAILNET,
    agents: SEEDS.map((seed) =>
      seed.dns_host ? { name: seed.name, host: hostOf(seed) } : { name: seed.name },
    ),
  });
}

/* ── the memory push registry ───────────────────────────────────────────── */

export interface MemoryPushRegistry {
  /** Registrations by box host, then device id. */
  readonly boxes: Map<string, Map<string, MobilePushDevice>>;
  devicesOn(host: string): MobilePushDevice[];
}

export function memoryPushRegistry(): MemoryPushRegistry {
  const boxes = new Map<string, Map<string, MobilePushDevice>>();
  return { boxes, devicesOn: (host) => [...(boxes.get(host)?.values() ?? [])] };
}

/* ── the switchable Tailscale status ────────────────────────────────────── */

export type FixtureTailscale = Exclude<TailscaleStatus, "unknown">;

export interface FixtureTailscaleSwitch {
  get(): FixtureTailscale;
  set(status: FixtureTailscale): void;
}

function tailscaleSwitch(initial: FixtureTailscale = "ok"): FixtureTailscaleSwitch {
  let status = initial;
  return {
    get: () => status,
    set: (next) => {
      status = next;
    },
  };
}

/* ── the stand-in network ───────────────────────────────────────────────── */

const respond = (body: unknown, status = 200): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Fetch for fixture mode: hermeticd's routes and the Tailscale probe, from
 * memory. Anything else is refused the way a dead network refuses.
 */
export function fixtureFetch(input: {
  registry: MemoryPushRegistry;
  tailscale: FixtureTailscaleSwitch;
  now: () => string;
}): FetchLike {
  const known = new Set(SEEDS.map(hostOf));
  return async (request, init) => {
    const url = new URL(String(request instanceof Request ? request.url : request));
    const method = (init?.method ?? "GET").toUpperCase();
    const status = input.tailscale.get();
    if (status === "off")
      throw new TypeError("A server with the specified hostname could not be found.");
    if (status === "unreachable") throw new TypeError("The request timed out.");
    if (!known.has(url.hostname))
      throw new TypeError("A server with the specified hostname could not be found.");
    if (url.pathname === "/api/health") return respond({ status: "ok" });
    if (url.pathname === RPC_PATHS.fleet && method === "GET")
      return respond(fixtureFleetView(input.now()));
    if (url.pathname === RPC_PATHS.pushDevices && method === "POST") {
      const device = JSON.parse(String(init?.body ?? "{}")) as MobilePushDevice;
      const box = input.registry.boxes.get(url.hostname) ?? new Map<string, MobilePushDevice>();
      box.set(device.device_id, device);
      input.registry.boxes.set(url.hostname, box);
      return respond({ ok: true });
    }
    if (url.pathname.startsWith(`${RPC_PATHS.pushDevices}/`) && method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice(RPC_PATHS.pushDevices.length + 1));
      input.registry.boxes.get(url.hostname)?.delete(id);
      return respond({ ok: true });
    }
    return respond({ type: "error", code: "NOT_FOUND", message: `no route ${url.pathname}` }, 404);
  };
}

/* ── the kit ────────────────────────────────────────────────────────────── */

export interface FixtureKit {
  chat: HermesChatClient;
  fetch: FetchLike;
  link: string;
  /** A sentinel Expo token: the simulator has none, and the memory registry needs one. */
  pushToken: string;
  registry: MemoryPushRegistry;
  tailscale: FixtureTailscaleSwitch;
  /** Keys and file names are prefixed with this, so a fixture pairing never overwrites a real one. */
  storagePrefix: string;
}

/**
 * The fixture kit, or `null` when `flag` is not `"1"`. Called with
 * `process.env.EXPO_PUBLIC_HERMETIC_FIXTURE`; nothing is constructed otherwise.
 */
export function fixtureKit(
  flag: string | undefined,
  now: () => string = () => new Date().toISOString(),
): FixtureKit | null {
  if (flag !== "1") return null;
  const registry = memoryPushRegistry();
  const tailscale = tailscaleSwitch();
  // What desktop fixture mode builds (`createHermetic`), with a little pacing so
  // a streamed reply looks streamed in the simulator.
  const chat = createFixtureChatStack(true, { delayMs: 40 }).hermes;
  if (!chat) throw new Error("the fixture chat stack built no client");
  return {
    chat,
    fetch: fixtureFetch({ registry, tailscale, now }),
    link: fixturePairingLink(),
    pushToken: FIXTURE_PUSH_TOKEN,
    registry,
    tailscale,
    storagePrefix: "fixture.",
  };
}
