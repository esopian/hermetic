/**
 * This phone's push registration with the fleet: which boxes hold its Expo
 * token, kept in step with the listening choice (§9.4).
 *
 * The phone registers with every box it listens to (`listening: "all"`, every
 * bot on that box), on enabling push, on each foreground and from the
 * background task (a registration lapses 72 hours after its last renewal),
 * whenever the listened set changes, and when the previews choice changes; a
 * box dropped from the set is told to forget the phone. Sign out and turning
 * push off unregister everywhere. Each box answers on its own, and a failure on
 * one never stops the others.
 *
 * Every registration states `previews`: the Settings "Show message previews"
 * choice, off unless the operator turns it on, because a preview travels
 * through Apple's and Expo's push services.
 *
 * The `device_id` is stable: minted once and never rotated. Boxes key a
 * registration by the tailnet login that wrote it, so two phones never collide
 * on an id. A box that answers `forbidden` (403) refused this login at its
 * whois gate (a transient `tailscale whois` failure, or a tagged node); that is
 * reported for the box in Settings and retried on the next sync, nothing more.
 *
 * Pure: the token source and the registrar are handed in, so the provider's
 * tests run on doubles.
 */
import type { MobilePushDevice, MobilePushPlatform } from "@hermetic/core/schema";
import type { FetchLike } from "../gateway/hermeticd.ts";
import {
  type PushBox,
  type PushBoxResult,
  registerDevice,
  unregisterDevice,
} from "../gateway/push-registry.ts";
import type { FleetStore, KvStorage } from "./store.ts";

/** Where the token goes: hermeticd's `/push/devices`, or a double. */
export interface PushRegistrar {
  register(boxes: readonly PushBox[], device: MobilePushDevice): Promise<PushBoxResult[]>;
  unregister(boxes: readonly PushBox[], deviceId: string): Promise<PushBoxResult[]>;
}

export function hermeticdRegistrar(fetch: FetchLike): PushRegistrar {
  return {
    register: (boxes, device) => registerDevice(boxes, device, fetch),
    unregister: (boxes, deviceId) => unregisterDevice(boxes, deviceId, fetch),
  };
}

/** Why there is no token: no real device, permission refused, no EAS project, or Expo failed. */
export type PushTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "simulator" | "denied" | "no-project-id" | "failed"; message?: string };

/** What Settings shows. */
export type PushStatus =
  | { state: "off" }
  | { state: "unavailable"; reason: Exclude<PushTokenResult, { ok: true }>["reason"]; message?: string }
  | { state: "on"; boxes: PushBoxResult[] };

/** The listened boxes, with their hosts, less any a fresh `/fleet` view says is gone (`isGone`). */
export function listenedBoxes(fleet: FleetStore): PushBox[] {
  return fleet
    .listened()
    .filter((instance) => !fleet.isGone(instance))
    .map((instance) => ({ instance, host: fleet.hostOf(instance) }))
    .filter((b): b is PushBox => b.host !== null);
}

/** Every box the fleet names (sign out reaches all of them, listened or not). */
export function allBoxes(fleet: FleetStore): PushBox[] {
  return fleet.agents().map((a) => ({ instance: a.name, host: a.host }));
}

export const DEVICE_ID_KEY = "hermetic.device_id";
/** The operator's push switch (`"on"` / `"off"`), in the keychain. */
export const PUSH_KEY = "hermetic.push";
/** The previews choice (`"true"` / `"false"`); absent is off (opt-in). */
export const PREVIEWS_KEY = "hermetic.previews";
/** When the registration was last renewed with every listened box (ISO). */
export const PUSH_RENEWED_KEY = "hermetic.push.renewed_at";
/** The box keeps a registration 72 h past its last renewal (agentd `PUSH_DEVICE_TTL_MS`). */
export const PUSH_REGISTRATION_TTL_MS = 72 * 60 * 60_000;
/** The background task renews once a registration is this old: well inside the TTL. */
export const PUSH_RENEW_AFTER_MS = 12 * 60 * 60_000;

/** The stored previews choice: on only when the operator turned it on. */
export function previewsFrom(stored: string | null): boolean {
  return stored === "true";
}

/** A random v4 UUID. An identifier, not a secret: the box gates writes on the tailnet login. */
export function randomId(rand: () => number = Math.random): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * This phone's stable device id: minted once and kept. A failed read throws
 * (a locked phone's background wake), so it never mints a second id.
 */
export async function deviceId(kv: KvStorage, mint: () => string = randomId): Promise<string> {
  const existing = await kv.get(DEVICE_ID_KEY);
  if (existing && /^[A-Za-z0-9_-]{1,64}$/.test(existing)) return existing;
  const id = mint();
  await kv.set(DEVICE_ID_KEY, id).catch(() => {});
  return id;
}

/** A box refused this phone's tailnet login at its whois gate (hermeticd's 403). */
export function isForbidden(result: PushBoxResult): boolean {
  return !result.ok && result.status === "forbidden";
}

export interface PushSyncDeps {
  fleet: FleetStore;
  registrar: PushRegistrar;
  /** The phone's stable id (`deviceId`). */
  deviceId: () => Promise<string>;
  token: () => Promise<PushTokenResult>;
  platform: MobilePushPlatform;
  appVersion: string;
  /** The Settings "Show message previews" choice, read at each registration. */
  previews: () => boolean;
  /** Every listened box took the registration: remember when (`PUSH_RENEWED_KEY`). */
  onRenewed?: () => void | Promise<void>;
}

/**
 * Keeps the registration in step. `enable()` gets a token and registers;
 * `sync()` re-registers the listened boxes and unregisters the dropped ones
 * (called on a listening change and on foreground); `disable()` unregisters
 * everywhere it may have registered.
 */
export class PushSync {
  private token: string | null = null;
  private registered = new Map<string, PushBox>();
  private status: PushStatus = { state: "off" };

  constructor(private readonly deps: PushSyncDeps) {}

  getStatus(): PushStatus {
    return this.status;
  }

  enabled(): boolean {
    return this.token !== null;
  }

  async enable(): Promise<PushStatus> {
    const result = await this.deps.token().catch(
      (error: unknown): PushTokenResult => ({
        ok: false,
        reason: "failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    if (!result.ok) {
      this.token = null;
      this.status = {
        state: "unavailable",
        reason: result.reason,
        ...(result.message ? { message: result.message } : {}),
      };
      return this.status;
    }
    this.token = result.token;
    return this.sync();
  }

  /** Register with every listened box; unregister from the ones no longer listened. */
  async sync(): Promise<PushStatus> {
    const token = this.token;
    if (!token) return this.status;
    const boxes = listenedBoxes(this.deps.fleet);
    const keep = new Set(boxes.map((b) => b.instance));
    // A box the fleet no longer has is not asked to forget: nothing answers there.
    const dropped = [...this.registered.values()].filter(
      (b) => !keep.has(b.instance) && !this.deps.fleet.isGone(b.instance),
    );
    const id = await this.deps.deviceId();
    const device: MobilePushDevice = {
      device_id: id,
      token,
      platform: this.deps.platform,
      app_version: this.deps.appVersion,
      listening: "all",
      previews: this.deps.previews(),
    };
    const [results] = await Promise.all([
      boxes.length > 0 ? this.deps.registrar.register(boxes, device) : Promise.resolve([]),
      dropped.length > 0 ? this.deps.registrar.unregister(dropped, id) : Promise.resolve([]),
    ]);
    if (this.token !== token) return this.status;
    this.registered = new Map(boxes.map((b) => [b.instance, b]));
    this.status = { state: "on", boxes: results };
    if (results.length > 0 && results.every((r) => r.ok)) await this.deps.onRenewed?.();
    return this.status;
  }

  /** Whether the box behind `instance` holds this phone's registration right now. */
  covers(instance: string): boolean {
    return this.status.state === "on" && this.status.boxes.some((b) => b.instance === instance && b.ok);
  }

  /** Forget the token and unregister from every box it may be on (best effort). */
  async disable(extra: readonly PushBox[] = []): Promise<PushStatus> {
    const boxes = new Map(this.registered);
    for (const b of extra) boxes.set(b.instance, b);
    this.token = null;
    this.registered = new Map();
    this.status = { state: "off" };
    if (boxes.size > 0) {
      const id = await this.deps.deviceId();
      await this.deps.registrar.unregister([...boxes.values()], id).catch(() => []);
    }
    return this.status;
  }
}

export interface RenewDeps {
  fleet: FleetStore;
  registrar: PushRegistrar;
  /** The keychain: the push switch, the previews choice, the device id, the last renewal. */
  secure: KvStorage;
  token: () => Promise<PushTokenResult>;
  platform: MobilePushPlatform;
  appVersion: string;
  /** ISO-8601 now. */
  now: () => string;
}

/**
 * The background task's renewal: register again with every listened box when
 * push is on and the last full renewal is `PUSH_RENEW_AFTER_MS` old (or never
 * happened), so a phone left in the background keeps its registration inside
 * the box's 72 h. `null` when there was nothing to do.
 */
export async function renewIfDue(deps: RenewDeps): Promise<PushStatus | null> {
  const get = (key: string) => deps.secure.get(key).catch(() => null);
  if ((await get(PUSH_KEY)) !== "on") return null;
  const last = Date.parse((await get(PUSH_RENEWED_KEY)) ?? "");
  if (Number.isFinite(last) && Date.parse(deps.now()) - last < PUSH_RENEW_AFTER_MS) return null;
  const previews = previewsFrom(await get(PREVIEWS_KEY));
  const sync = new PushSync({
    fleet: deps.fleet,
    registrar: deps.registrar,
    deviceId: () => deviceId(deps.secure),
    token: deps.token,
    platform: deps.platform,
    appVersion: deps.appVersion,
    previews: () => previews,
    onRenewed: () => deps.secure.set(PUSH_RENEWED_KEY, deps.now()).catch(() => {}),
  });
  return sync.enable();
}
