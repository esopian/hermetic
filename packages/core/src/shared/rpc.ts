/**
 * The fixed points of the hermeticd RPC (§6.4): the port, the protocol
 * version and its header, the content type and the paths. The frame schemas
 * stay in `schema/rpc.ts`.
 *
 * Pure values only — no Zod, no `node:*`, nothing that opens a file or a
 * socket — because `shared/index.ts` re-exports from here into the browser and
 * the box. The Zod schemas that validate these shapes live in `schema/*`, which
 * imports this module, never the reverse (`packages/core/test/shared-browser-safe.test.ts`).
 */

/** hermeticd listens here, bound to the Tailscale interface only. */
export const HERMETICD_RPC_PORT = 7434;

/** Bumped when a frame shape changes incompatibly; sent as `x-hermetic-rpc`. */
export const RPC_PROTOCOL_VERSION = 1;
export const RPC_VERSION_HEADER = "x-hermetic-rpc";
export const RPC_CONTENT_TYPE = "application/x-ndjson";

export const RPC_PATHS = {
  logs: "/logs",
  health: "/healthz",
  /** `GET`: the fleet's live agents for a paired phone (`MobileFleetView`, §9.4). */
  fleet: "/fleet",
  /** `POST`: register or update one phone's push token (`MobilePushDevice`). */
  pushDevices: "/push/devices",
  /**
   * `POST`, no body: re-read this box's own secret slots now and rewrite the
   * managed block in every Hermes `.env` (`SecretsSyncResult`, §8.1). The
   * request carries no secret; it only says "re-read".
   */
  secretsSync: "/secrets/sync",
} as const;

/** `DELETE <prefix><device_id>` unregisters one phone. */
export const PUSH_DEVICE_ROUTE_PREFIX = `${RPC_PATHS.pushDevices}/`;

/** The path that unregisters one phone; `device_id` is URL-encoded. */
export function pushDevicePath(deviceId: string): string {
  return `${PUSH_DEVICE_ROUTE_PREFIX}${encodeURIComponent(deviceId)}`;
}
