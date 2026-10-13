/**
 * hermeticd's three phone routes (§9.4), behind the same whois gate as every
 * other route on 7434 (`rpc.ts` admits the caller before it gets here):
 *
 *   GET    /fleet                     the fleet's live agents, `MobileFleetView`
 *   POST   /push/devices              register or update one phone (`MobilePushDevice`)
 *   DELETE /push/devices/<device_id>  unregister one phone
 *
 * `GET /fleet` is a read: a consistent Scan of the agents table and the
 * `_fleet` row, cached for `FLEET_VIEW_CACHE_MS` so a phone refreshing its list
 * costs the table one read per ten seconds however many phones ask. A fleet
 * whose foundation predates v16 has no `dynamodb:Scan` on the agent role; the
 * Scan answers `AccessDenied` and the route answers 503
 * `FLEET_LIST_UNAVAILABLE`, which the phone reads as "keep the pairing
 * snapshot".
 *
 * The push routes are the listener's one write, and it is bounded on every
 * axis: the body (`PUSH_BODY_MAX_BYTES`, 413), its shape (`MobilePushDevice`,
 * 400), how often one peer may write (`PUSH_WRITES_PER_MINUTE`, 429), and how
 * many phones the file may hold (`PUSH_DEVICES_MAX`, `push/devices.ts`).
 * A registration belongs to the login that made it (`peer.owner`, from the
 * gate's whois): another login replacing or deleting that `device_id` is 403
 * `FORBIDDEN`, and the refusal's audit line names the device id and the two
 * logins, nothing else. The token is never logged — a registration's line
 * names the device id and the platform only.
 */
import type {
  Agent,
  ErrorCode,
  FleetManifest,
  MobileFleetAgent as MobileFleetAgentType,
} from "@hermetic/core/schema";
import {
  Agent as AgentSchema,
  MobileFleetAgent,
  MobileFleetView,
  MobilePushDevice,
  encodeRpcFrame,
} from "@hermetic/core/schema";
import {
  FLEET_KEY,
  PUSH_DEVICE_ROUTE_PREFIX,
  RPC_CONTENT_TYPE,
  RPC_PATHS,
  RPC_PROTOCOL_VERSION,
  RPC_VERSION_HEADER,
} from "@hermetic/core/shared";
import type { Aws } from "./aws.ts";
import type { PushDeviceStore } from "./push/devices.ts";

/** How long one Scan answers `GET /fleet`, success or failure. */
export const FLEET_VIEW_CACHE_MS = 10_000;
/** The largest registration body read; a `MobilePushDevice` is well under 4 KB. */
export const PUSH_BODY_MAX_BYTES = 8 * 1024;
/** Push-route writes one peer may make per minute before 429. */
export const PUSH_WRITES_PER_MINUTE = 10;
const MINUTE_MS = 60_000;
/** Peers the write limiter remembers at once; the quietest is forgotten first. */
const LIMITER_PEERS = 256;

/** `GET /fleet` could not be answered; the route's 503. */
export class FleetListUnavailable extends Error {
  override readonly name = "FleetListUnavailable";
}

/** A refusal in the listener's own shape: one `{type:"error"}` RPC frame. */
export function rpcRefusal(status: number, message: string, code: ErrorCode = "INTERNAL"): Response {
  return new Response(encodeRpcFrame({ type: "error", code, message }), {
    status,
    headers: {
      "content-type": RPC_CONTENT_TYPE,
      "cache-control": "no-store",
      [RPC_VERSION_HEADER]: String(RPC_PROTOCOL_VERSION),
    },
  });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", [RPC_VERSION_HEADER]: String(RPC_PROTOCOL_VERSION) },
  });
}

/* ── GET /fleet ─────────────────────────────────────────────────────────── */

/** The account id out of an ARN (`arn:aws:<svc>:<region>:<account>:…`), or null. */
export function accountOfArn(arn: string | undefined): string | null {
  const account = arn?.split(":")[4];
  return account !== undefined && /^\d{12}$/.test(account) ? account : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** One parsed agent row as the phone sees it; `null` when it does not fit the wire. */
function fleetAgent(row: Agent): MobileFleetAgentType | null {
  const candidate = {
    name: row.name,
    status: row.status,
    tailscale_dns_name: row.tailscale_dns_name ?? null,
    tailscale_ip: row.tailscale_ip ?? null,
    version: row.running_hermes_version ?? row.hermes_version ?? null,
    ...(row.health ? { health: row.health } : {}),
  };
  const parsed = MobileFleetAgent.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * `MobileFleetView` from a Scan, the `_fleet` row and the fleet manifest.
 *
 * Pure. Rows are parsed with core's `Agent` schema, as core's own Scan does;
 * `_`-prefixed rows (`_fleet` and any future reserved row) and `destroyed`
 * agents are dropped, and a row that does not parse is skipped rather than
 * failing the list — one malformed row must not hide every healthy agent from
 * the phone. The account id is not on any row, so it is read off the role ARN
 * the manifest records (the stack ARN as a fallback).
 *
 * The `_fleet` row must name the manifest's own `fleet_id`. The Scan is
 * fleet-scoped by IAM (`FleetList` names this stack's agents table and no
 * other), so a disagreement means the manifest points this box at a table that
 * is not its fleet's; the view is refused rather than served under either
 * identity.
 */
export function buildFleetView(
  items: readonly Record<string, unknown>[],
  fleetRow: Record<string, unknown> | null,
  manifest: FleetManifest,
  readAt: Date,
): { view: MobileFleetView; skipped: number } {
  if (fleetRow === null) throw new FleetListUnavailable(`the agents table has no ${FLEET_KEY} row`);
  const rowFleetId = str(fleetRow["fleet_id"]);
  if (rowFleetId !== manifest.fleet_id) {
    throw new FleetListUnavailable(
      `the agents table's ${FLEET_KEY} row names fleet ${rowFleetId ?? "(none)"}, not this box's fleet ${manifest.fleet_id}`,
    );
  }
  const agents: MobileFleetAgentType[] = [];
  let skipped = 0;
  for (const item of items) {
    const name = item["name"];
    if (typeof name !== "string" || name.startsWith("_")) continue;
    const parsed = AgentSchema.safeParse(item);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    if (parsed.data.status === "destroyed") continue;
    const agent = fleetAgent(parsed.data);
    if (agent === null) skipped += 1;
    else agents.push(agent);
  }
  agents.sort((a, b) => a.name.localeCompare(b.name, "en"));
  const foundation = fleetRow["foundation_version"];
  const candidate = {
    fleet: {
      fleet_id: manifest.fleet_id,
      alias: str(fleetRow["fleet_name"]) ?? manifest.name ?? null,
      tailnet: str(fleetRow["tailnet"]) ?? "",
      region: str(fleetRow["region"]) ?? manifest.region,
      account_id:
        accountOfArn(manifest.resources.role_arn) ?? accountOfArn(manifest.resources.stack_id) ?? "",
      foundation_version:
        typeof foundation === "number" ? foundation : (manifest.foundation?.version ?? 0),
    },
    agents,
    read_at: readAt.toISOString(),
  };
  const parsed = MobileFleetView.safeParse(candidate);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join(".") ?? "?";
    throw new FleetListUnavailable(`the fleet's identity is incomplete (${where})`);
  }
  return { view: parsed.data, skipped };
}

function isAccessDenied(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return typeof name === "string" && /AccessDenied/.test(name);
}

export interface FleetViewSourceDeps {
  readonly aws: Pick<Aws, "scanAgents" | "getFleetRow">;
  /** The fleet manifest the box booted with: region, account and fallbacks. */
  readonly manifest: () => FleetManifest;
  readonly now: () => Date;
  readonly log?: (message: string) => void;
  readonly cacheMs?: number;
}

/**
 * `GET /fleet`'s read, with the cache. Concurrent callers share one Scan, and
 * an answer — a view or a `FleetListUnavailable` — stands for `cacheMs`, so an
 * `AccessDenied` fleet is not re-Scanned per phone per poll either.
 */
export function fleetViewSource(deps: FleetViewSourceDeps): () => Promise<MobileFleetView> {
  const cacheMs = deps.cacheMs ?? FLEET_VIEW_CACHE_MS;
  const say = deps.log ?? (() => {});
  let cached: { at: number; answer: Promise<MobileFleetView> } | null = null;

  async function read(): Promise<MobileFleetView> {
    let items: Record<string, unknown>[];
    let fleetRow: Record<string, unknown> | null;
    try {
      [items, fleetRow] = await Promise.all([deps.aws.scanAgents(), deps.aws.getFleetRow()]);
    } catch (e) {
      if (isAccessDenied(e)) {
        throw new FleetListUnavailable(
          "this box's role may not Scan the agents table; the fleet's foundation predates version 16 (`hermetic foundation update`)",
        );
      }
      throw new FleetListUnavailable(
        `could not read the agents table: ${(e as { name?: string } | null)?.name ?? "error"}`,
      );
    }
    const { view, skipped } = buildFleetView(items, fleetRow, deps.manifest(), deps.now());
    if (skipped > 0) say(`fleet view: skipped ${skipped} agent row(s) that did not parse`);
    return view;
  }

  return () => {
    const now = deps.now().getTime();
    if (cached !== null && now - cached.at < cacheMs) return cached.answer;
    const answer = read();
    // Held even when it rejects; the rejection is observed by every caller.
    answer.catch(() => undefined);
    cached = { at: now, answer };
    return answer;
  };
}

/* ── POST/DELETE /push/devices ──────────────────────────────────────────── */

/** Read at most `max` bytes of a body; `null` when it is larger. */
async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder().decode(all);
}

export interface MobileRoutesDeps {
  /** `GET /fleet`'s source (`fleetViewSource`); absent answers 404. */
  readonly fleetView?: () => Promise<MobileFleetView>;
  /** The push registry (`push/devices.ts`); absent answers 404. */
  readonly devices?: PushDeviceStore;
  /** Milliseconds, for the write limiter. */
  readonly now: () => number;
  readonly log?: (message: string) => void;
}

/** The admitted caller, as the whois gate (`rpc.ts`) hands it to the phone routes. */
export interface MobilePeer {
  /** The peer's tailnet address; keys the write limiter. */
  readonly ip: string;
  /** Who it is (`peerOwner`): the login a registration it makes is bound to. */
  readonly owner: string;
}

/** `(request, url, peer)` → a response, or `null` when the path is not a phone route. */
export type MobileRoutes = (request: Request, url: URL, peer: MobilePeer) => Promise<Response | null>;

export function makeMobileRoutes(deps: MobileRoutesDeps): MobileRoutes {
  const say = deps.log ?? (() => {});
  /** peer → the times of its recent writes, oldest first. */
  const writes = new Map<string, number[]>();

  /** Counts this write; true when the peer is over its budget. */
  function overBudget(peerIp: string): boolean {
    const now = deps.now();
    const recent = (writes.get(peerIp) ?? []).filter((t) => now - t < MINUTE_MS);
    recent.push(now);
    writes.delete(peerIp);
    writes.set(peerIp, recent);
    if (writes.size > LIMITER_PEERS) {
      const oldest = writes.keys().next().value;
      if (oldest !== undefined) writes.delete(oldest);
    }
    return recent.length > PUSH_WRITES_PER_MINUTE;
  }

  function forbidden(deviceId: string, peer: MobilePeer, owner: string, verb: string): Response {
    say(`push device ${deviceId}: ${verb} by ${peer.owner} refused; registered to ${owner}`);
    return rpcRefusal(
      403,
      `push device ${deviceId} is registered to another tailnet login`,
      "FORBIDDEN",
    );
  }

  return async (request, url, peer) => {
    const peerIp = peer.ip;
    const path = url.pathname;

    if (path === RPC_PATHS.fleet && deps.fleetView) {
      if (request.method !== "GET")
        return rpcRefusal(405, `${request.method} ${path} is not allowed`, "UNSUPPORTED");
      try {
        return json(await deps.fleetView());
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof FleetListUnavailable)
          return rpcRefusal(503, message, "FLEET_LIST_UNAVAILABLE");
        return rpcRefusal(500, message, "INTERNAL");
      }
    }

    const devices = deps.devices;
    if (devices === undefined) return null;

    if (path === RPC_PATHS.pushDevices) {
      if (request.method !== "POST")
        return rpcRefusal(405, `${request.method} ${path} is not allowed`, "UNSUPPORTED");
      if (overBudget(peerIp)) {
        return rpcRefusal(
          429,
          `more than ${PUSH_WRITES_PER_MINUTE} push registrations in a minute`,
          "RATE_LIMITED",
        );
      }
      const text = await readCapped(request, PUSH_BODY_MAX_BYTES);
      if (text === null) {
        return rpcRefusal(
          413,
          `a push registration is at most ${PUSH_BODY_MAX_BYTES} bytes`,
          "PAYLOAD_TOO_LARGE",
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return rpcRefusal(400, "the body is not JSON", "VALIDATION");
      }
      const parsed = MobilePushDevice.safeParse(body);
      if (!parsed.success) {
        // Field paths only: the values may include the token.
        const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))];
        return rpcRefusal(400, `not a MobilePushDevice: ${fields.join(", ")}`, "VALIDATION");
      }
      const stored = await devices.upsert(parsed.data, peer.owner);
      if (!stored.ok) return forbidden(parsed.data.device_id, peer, stored.owner, "update");
      const { evicted } = stored;
      say(
        `push device registered: ${parsed.data.device_id} (${parsed.data.platform})` +
          (evicted ? `; evicted ${evicted} to stay under the cap` : ""),
      );
      return json({ ok: true, device_id: parsed.data.device_id });
    }

    if (path.startsWith(PUSH_DEVICE_ROUTE_PREFIX)) {
      if (request.method !== "DELETE")
        return rpcRefusal(405, `${request.method} ${path} is not allowed`, "UNSUPPORTED");
      if (overBudget(peerIp)) {
        return rpcRefusal(
          429,
          `more than ${PUSH_WRITES_PER_MINUTE} push registrations in a minute`,
          "RATE_LIMITED",
        );
      }
      let id: string;
      try {
        id = decodeURIComponent(path.slice(PUSH_DEVICE_ROUTE_PREFIX.length));
      } catch {
        return rpcRefusal(400, "the device id is not valid", "VALIDATION");
      }
      if (!MobilePushDevice.shape.device_id.safeParse(id).success) {
        return rpcRefusal(400, "the device id is not valid", "VALIDATION");
      }
      const result = await devices.unregister(id, peer.owner);
      if (!result.ok) return forbidden(id, peer, result.owner, "delete");
      const { removed } = result;
      if (removed) say(`push device unregistered: ${id}`);
      // Idempotent: a phone signing out twice is not an error.
      return json({ ok: true, device_id: id, removed });
    }

    return null;
  };
}
